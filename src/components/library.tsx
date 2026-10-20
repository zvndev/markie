import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from "react";
import { stableOrder } from "@/lib/stable-order";
import { getElectronAPI, isTooLarge, type LibraryItem } from "@/lib/electron";
import { tooLargeMessage } from "@/lib/doc-tiers";
import { ProjectsPanelContainer } from "@/components/projects-panel";
import { BrowseView } from "@/components/browse-view";
import { SkillsView } from "@/components/skills-view";
import { CloudView } from "@/components/cloud-view";
import { PanelResizer } from "@/components/panel-resizer";
import {
  LEFT_PANEL_WIDTH_KEY,
  clampPanelWidth,
  readPanelWidth,
} from "@/lib/panel-width";
// The panel never renders for "edit" (the formatting rail has no panel), so
// it takes the narrower type rather than inventing a title for one.
import type { PanelView } from "@/lib/left-rail";
import { readLibraryStartupSnapshot } from "@/lib/library-startup";
import { LIB_TAB_KEY, initialLibTab, type LibTab } from "@/lib/library-state";
import {
  cloudCopyOnly,
  libraryItemNeedsAttention,
  sortLibraryItems,
  summarizeLibrary,
  type LibraryOverview,
} from "@/lib/library-overview";
import type { WorkspaceBootstrapResult } from "@/lib/workspace-default";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { PanelNotice, type Notice, type NoticeKind } from "@/components/panel-notice";
import { sameDocumentPath } from "@/lib/path-utils";
import { classifyDocumentFormat } from "@/lib/document-formats";
import type { LibraryRecord } from "@/lib/document-library";
import type { EditableDocumentFormat } from "@/lib/document-session";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, libraryDocumentFormat, matchesLibraryDocument, queryLibraryDocuments, type LibraryDocumentMetadata, type LibraryDocumentQuery } from "@/lib/library-document-query";
import { LibraryDocumentFilters } from "@/components/library-document-filters";
import { NewDocumentModal } from "@/components/new-document-modal";
import { DEFAULT_APPS_CHANGED } from "@/components/default-apps-section";
import { CloudAreaPicker, CloudAreaProvider, CloudAreaScopePicker } from "./cloud-area-picker";
import { accountScopeKey, confirmedAccountScope, subscribeAccountScope } from "@/lib/account-identities";

interface LibraryProps {
  retainedDocument?: { name: string; path: string | null; dirty: boolean; selected: boolean; onSelect: () => void };
  // which view the left rail selected (library | browse | cloud | skills)
  view: PanelView;
  presentation?: "panel" | "workspace";
  onClose: () => void;
  onOpenPath: (path: string) => void;
  onOpenFile: () => void;
  onAddPaths: (paths: string[]) => void;
  onSignIn: () => void;
  // open the share dialog to manage people on a doc I own
  onManageShare: (docId: string, name: string) => void;
  // a library action may have changed this device's sync state (sync on/off,
  // pull) — lets the page recompute share/collab eligibility for the open doc
  onSyncChanged?: () => void;
  activePath: string | null;
  // The account the auth store has confirmed, or null while nobody is. The
  // Cloud page keys its per-account state on it; signedIn here only says
  // main holds a token, which does not change when the account does.
  accountId: string | null;
  // bump to force a refresh (file opened/saved/sync changed)
  refreshKey: number;
  // Ordinary recovery records only; protected document metadata stays in the vault.
  documentRecords?: readonly LibraryRecord[];
  activeDocumentId?: string;
  onOpenDocument?: (record: LibraryRecord) => void;
  onCreateDocument?: (format: EditableDocumentFormat) => void;
  onOpenVault?: () => void;
  // Settings > Files, where every fully supported type can be made Markie's.
  onOpenDefaultApps?: () => void;
  renderCloudDocuments?: (query: LibraryDocumentQuery, presentation: "panel" | "workspace") => ReactNode;
}

type CloudTab = "snapshots" | "sync";
const CLOUD_TAB_KEY = "markie.cloud.workspace-tab.v1";

const NO_DOCUMENT_RECORDS: readonly LibraryRecord[] = [];

// Long enough to read a short sentence, short enough that the panel is not
// still explaining a copy you made a minute ago.
const NOTICE_DISMISS_MS = 4000;
const DEFAULT_APPS_HINT_KEY = "markie.defaultApps.hintDismissed.v1";

// Node hands back "ENOENT: no such file or directory, open '/x/y.md'". The
// errno is the only part most people can act on, and it is the part they
// cannot read. Say the same thing in a sentence and keep the path.
const ERRNO_SENTENCES: Array<[RegExp, string]> = [
  [/^ENOENT\b[^,]*,?\s*/i, "That file isn't there anymore."],
  [/^EACCES\b[^,]*,?\s*/i, "Markie isn't allowed to touch that file."],
  [/^EPERM\b[^,]*,?\s*/i, "The system refused that change."],
];

export function plainErrorText(raw: string): string {
  const text = String(raw ?? "").trim();
  for (const [pattern, sentence] of ERRNO_SENTENCES) {
    if (!pattern.test(text)) continue;
    const rest = text.replace(pattern, "").trim();
    return rest ? `${sentence} (${rest})` : sentence;
  }
  return text;
}

// The "Library" view has one Recent/Projects toggle; the other views come from
// the left rail and have no tabs at all.

const VIEW_TITLE: Record<PanelView, string> = {
  library: "Library",
  browse: "Browse",
  cloud: "Cloud",
  skills: "Skills",
};

// Local files are identified by path; cloud-only rows have no path yet.
const itemKey = (i: LibraryItem) => i.path ?? i.cloudId ?? i.name;

// Markdown and the plain-text family are what the classic reader and the
// legacy cloud sync understand. Everything else in Recent (DOCX, RTF, JSON...)
// opens in the document workspace and must not be offered a UTF-8 copy or a
// Markdown sync it would mangle.
const CLASSIC_FILE = /\.(?:md|markdown|mdx|txt|text|log|csv)$/i;

function nativeMetadata(item: LibraryItem): LibraryDocumentMetadata {
  return { key: `native:${itemKey(item)}`, name: item.name, path: item.path, format: libraryDocumentFormat(item.name), updatedAt: item.lastOpenedAt };
}

function recoveryMetadata(record: LibraryRecord): LibraryDocumentMetadata {
  return { key: `recovery:${record.id}`, name: record.name, format: record.format, updatedAt: record.updatedAt, extractedText: record.extractedText, tags: record.tags, collection: record.collection };
}

const BADGE: Record<LibraryItem["state"], [string, string]> = {
  "local-only": ["Local", "text-muted border-border"],
  synced: [
    "Synced",
    "text-[var(--status-green)] border-[color:var(--status-green)]",
  ],
  unpushed: [
    "Not backed up",
    "text-[var(--status-yellow)] border-[color:var(--status-yellow)]",
  ],
  paused: [
    "Paused",
    "text-[var(--status-yellow)] border-[color:var(--status-yellow)]",
  ],
  conflict: [
    "Conflict",
    "text-[var(--status-red)] border-[color:var(--status-red)]",
  ],
  behind: [
    "Update",
    "text-[var(--status-blue)] border-[color:var(--status-blue)]",
  ],
  "cloud-only": [
    "Cloud",
    "text-[var(--status-blue)] border-[color:var(--status-blue)]",
  ],
};

export function Library({
  retainedDocument,
  view,
  presentation = "panel",
  onClose,
  onOpenPath,
  onOpenFile,
  onAddPaths,
  onSignIn,
  onManageShare,
  onSyncChanged,
  activePath,
  accountId,
  refreshKey,
  documentRecords = NO_DOCUMENT_RECORDS,
  activeDocumentId,
  onOpenDocument,
  onCreateDocument,
  onOpenVault,
  onOpenDefaultApps,
  renderCloudDocuments,
}: LibraryProps) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const scopeKey = useSyncExternalStore(subscribeAccountScope, accountScopeKey, () => "");
  const [uploadArea, setUploadArea] = useState("");
  useEffect(() => { setUploadArea(""); }, [scopeKey]);
  // only "loading" when there's actually a main-process library to query
  const [loading, setLoading] = useState(
    () => !!getElectronAPI()?.libraryState
  );
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  const [showNewDocument, setShowNewDocument] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Kept apart from the notice line above: a listing the server would not hand
  // over is about the cloud, so it belongs on the Cloud page rather than under
  // whichever panel happened to be open when the request failed.
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [query, setQuery] = useState<LibraryDocumentQuery>(() => ({ ...DEFAULT_LIBRARY_DOCUMENT_QUERY }));
  const [cloudTab, setCloudTab] = useState<CloudTab>(() => {
    if (!renderCloudDocuments) return "sync";
    try { return localStorage.getItem(CLOUD_TAB_KEY) === "sync" ? "sync" : "snapshots"; } catch { return "snapshots"; }
  });
  const pickCloudTab = useCallback((tab: CloudTab) => {
    setCloudTab(tab);
    try { localStorage.setItem(CLOUD_TAB_KEY, tab); } catch { /* session-only preference */ }
  }, []);
  // Freeze the row order for as long as the panel stays open, so opening a file
  // does not send it to the top and shuffle everything you were reading.
  const [frozenOrder, setFrozenOrder] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceBootstrapResult | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const [libTab, setLibTab] = useState<LibTab>(() =>
    initialLibTab((k) => localStorage.getItem(k))
  );
  // The panel is unmounted while collapsed and remounted per view, so the width
  // is read back from storage on every mount rather than lifted into the page.
  // The width the user chose, clamped only to the panel's own bounds. Infinity
  // as the viewport means "no viewport limit yet" — the viewport clamp is
  // applied separately below, so shrinking the window never rewrites the
  // preference.
  const [userWidth, setUserWidth] = useState(() => {
    try {
      return readPanelWidth(localStorage.getItem(LEFT_PANEL_WIDTH_KEY), Infinity);
    } catch {
      return readPanelWidth(null, Infinity);
    }
  });
  const [viewport, setViewport] = useState(() => {
    try {
      return window.innerWidth;
    } catch {
      return 1280;
    }
  });
  const commitWidth = useCallback((next: number) => {
    setUserWidth(next);
    try {
      localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(next));
    } catch {
      // storage unavailable
    }
  }, []);

  // Shrinking the window must not leave the panel eating the document. Clamp
  // the *effective* width against the viewport and leave the stored one alone:
  // re-clamping the preference meant a window you shrank and grew back came
  // back with a narrower panel, permanently.
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const width = useMemo(
    () => clampPanelWidth(userWidth, viewport),
    [userWidth, viewport]
  );

  const showNotice = useCallback((text: string, kind: NoticeKind) => {
    setNotice({ text: plainErrorText(text), kind });
  }, []);
  const noticeError = useCallback(
    (text: string) => showNotice(text, "error"),
    [showNotice]
  );
  // An acknowledgement has been read the moment it appears; leaving it pinned
  // to the bottom of the panel turns it into furniture. Errors stay.
  useEffect(() => {
    if (!notice || notice.kind !== "info") return;
    const t = setTimeout(() => setNotice(null), NOTICE_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const pickTab = (t: LibTab) => {
    setMenuFor(null);
    setLibTab(t);
    try {
      localStorage.setItem(LIB_TAB_KEY, t);
    } catch {
      // storage unavailable
    }
  };

  useDismissibleLayer(menuFor !== null, menuRootRef, () => setMenuFor(null));

  const [defaultMsg, setDefaultMsg] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);
  // null = unknown/checking; show the prompt only when we know it's NOT default.
  // No status API (web/dev) → never show, decided up front to avoid set-in-effect.
  const [needsDefault, setNeedsDefault] = useState<boolean | null>(() =>
    getElectronAPI()?.defaultMarkdownStatus ? null : false
  );

  // Ask the system whether Markie already owns .md, so we don't nag every open.
  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.defaultMarkdownStatus) return;
    let alive = true;
    api.defaultMarkdownStatus().then((s) => {
      if (alive) setNeedsDefault(s.supported && !s.isDefault);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Formats other than Markdown that Finder still sends to another app. Asked
  // again whenever Settings > Files changes an association.
  const [othersElsewhere, setOthersElsewhere] = useState<string[]>([]);
  const [othersHintDismissed, setOthersHintDismissed] = useState(() => {
    try { return localStorage.getItem(DEFAULT_APPS_HINT_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.defaultAppsStatus || !onOpenDefaultApps) return;
    let alive = true;
    const load = () => api.defaultAppsStatus!().then((status) => {
      if (alive) setOthersElsewhere(status.supported ? status.formats.filter((format) => format.id !== "markdown" && !format.isDefault).map((format) => format.label) : []);
    }).catch(() => {});
    void load();
    window.addEventListener(DEFAULT_APPS_CHANGED, load);
    return () => { alive = false; window.removeEventListener(DEFAULT_APPS_CHANGED, load); };
  }, [onOpenDefaultApps]);
  const dismissOthersHint = () => {
    setOthersHintDismissed(true);
    try { localStorage.setItem(DEFAULT_APPS_HINT_KEY, "1"); } catch { /* preference only */ }
  };

  const makeDefault = async () => {
    const api = getElectronAPI();
    if (!api?.setDefaultMarkdownApp) return;
    setSettingDefault(true);
    setDefaultMsg(null);
    const res = await api.setDefaultMarkdownApp();
    setSettingDefault(false);
    if (res.ok) {
      setDefaultMsg("Markie now opens .md files.");
      setNeedsDefault(false); // hide the prompt — it's set now
    } else {
      setDefaultMsg(res.error ?? "Couldn't set default.");
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    const api = getElectronAPI();
    if (!api?.pathForFile) {
      noticeError("Drag-and-drop needs the desktop app.");
      return;
    }
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => api.pathForFile(f))
      .filter((p): p is string => !!p && classifyDocumentFormat(p).kind !== "unsupported");
    if (paths.length === 0) {
      showNotice("Drop a supported Word, Markdown, text or document file here.", "info");
      return;
    }
    onAddPaths(paths);
  };

  const refresh = useCallback(() => {
    const api = getElectronAPI();
    if (!api?.libraryState) return Promise.resolve();
    return readLibraryStartupSnapshot(api).then((s) => {
      setItems(s.items);
      // First rows to arrive define the order the panel keeps while open.
      setFrozenOrder((prev) => (prev.length ? prev : sortLibraryItems(s.items).map(itemKey)));
      setSignedIn(s.signedIn);
      setWorkspace(s.workspace);
      setLoading(false);
      setCloudError(s.cloudError ?? null);
      if (s.error) noticeError(s.error);
    });
  }, [noticeError]);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.libraryState) return;
    let alive = true;
    readLibraryStartupSnapshot(api).then((s) => {
      if (!alive) return;
      setItems(s.items);
      // First rows to arrive define the order the panel keeps while open.
      setFrozenOrder((prev) => (prev.length ? prev : sortLibraryItems(s.items).map(itemKey)));
      setSignedIn(s.signedIn);
      setWorkspace(s.workspace);
      setLoading(false);
      setCloudError(s.cloudError ?? null);
      if (s.error) noticeError(s.error);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey, noticeError]);

  // Every library action funnels through here. The main process answers with
  // `{ error }` rather than throwing, and that used to be dropped on the floor:
  // clicking a shared doc whose access had been revoked simply did nothing.
  // Surface both shapes through the panel's notice line, and always let go of
  // the menu — a failed action must never leave it stuck open.
  const act = async (fn: () => Promise<unknown>) => {
    try {
      const result = await fn();
      const failure =
        result && typeof result === "object" && "error" in result
          ? (result as { error?: unknown }).error
          : null;
      if (failure) noticeError(String(failure));
    } catch (err) {
      noticeError(
        err instanceof Error && err.message
          ? err.message
          : "That didn't work. Please try again."
      );
    } finally {
      setMenuFor(null);
      refresh();
      onSyncChanged?.();
    }
  };

  const flash = (msg: string, kind: NoticeKind = "info") => {
    showNotice(msg, kind);
    setMenuFor(null);
  };
  const flashError = (msg: string) => flash(msg, "error");

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      flash("Path copied — paste it anywhere.");
    } catch {
      flashError("Couldn't copy the path.");
    }
  };

  const copyContents = async (item: LibraryItem) => {
    const api = getElectronAPI();
    if (!item.path || !api?.openFilePath) return flashError("Nothing to copy.");
    const file = await api.openFilePath(item.path);
    if (!file) return flashError(`Couldn't read ${item.name}.`);
    if (isTooLarge(file)) return flashError(tooLargeMessage(file.size));
    try {
      await navigator.clipboard.writeText(file.content);
      flash("Contents copied to clipboard.");
    } catch {
      flashError("Couldn't copy the contents.");
    }
  };

  const syncOn = (item: LibraryItem) =>
    act(async () => {
      const api = getElectronAPI()!;
      const file = await api.openFilePath(item.path!);
      if (!file) return noticeError(`Can't read ${item.name}`);
      if (isTooLarge(file)) return noticeError(tooLargeMessage(file.size));
      if (uploadArea && item.cloudId) return noticeError("Existing cloud files keep their area. Move the cloud document separately before changing its destination.");
      const res = await api.docSyncOn({
        path: item.path!,
        name: item.name,
        content: file.content,
        ...(uploadArea ? { areaId: uploadArea } : {}),
      });
      if (res.error) noticeError(res.error);
    });

  const orderedItems = useMemo(
    () => stableOrder(items, itemKey, frozenOrder),
    [items, frozenOrder]
  );

  const visibleItems = useMemo(
    () => queryLibraryDocuments(orderedItems, query, nativeMetadata),
    [orderedItems, query]
  );

  const localFiles = visibleItems.filter((item) => item.path);
  const retainedAvailable = !!retainedDocument && (!retainedDocument.path || !items.some((item) => sameDocumentPath(item.path, retainedDocument.path, getElectronAPI()?.platform)));
  const retainedFormat = retainedDocument ? libraryDocumentFormat(retainedDocument.name) : "markdown";
  const retainedVisible = retainedAvailable && matchesLibraryDocument({ key: "retained:markdown", name: retainedDocument!.name, path: retainedDocument!.path, format: retainedFormat }, query);
  const overview = summarizeLibrary(items);
  const visibleDocuments = useMemo(() => queryLibraryDocuments(documentRecords, query, recoveryMetadata), [documentRecords, query]);
  const queryActive = !!query.search.trim() || query.format !== "all" || query.sort !== "default";
  const totalDocuments = items.filter((item) => item.path).length + documentRecords.length + Number(retainedAvailable);
  const visibleCount = localFiles.length + visibleDocuments.length + Number(retainedVisible);

  const fileRow = (item: LibraryItem) => {
    const [label, badgeClass]: [string, string] = item.shared
      ? [
          "Shared",
          "text-[var(--status-purple)] border-[color:var(--status-purple)]",
        ]
      : BADGE[item.state];
    const api = getElectronAPI()!;
    const isActive = activePath && item.path === activePath;
    const itemKey = item.path ?? item.cloudId;
    const classic = CLASSIC_FILE.test(item.name);
    const format = libraryDocumentFormat(item.name);
    const open = () => {
      setMenuFor(null);
      if (item.path && item.exists) {
        onOpenPath(item.path);
      } else if (item.shared && item.cloudId && api.docOpenShared) {
        // shared with me → just save to Downloads and open it, no save dialog
        act(() => api.docOpenShared!({ cloudId: item.cloudId!, suggestedName: item.name }));
      } else if (cloudCopyOnly(item)) {
        // The cloud has it and this device does not, whether the file was
        // never here or was deleted: either way the click gets the copy back.
        act(() => api.docPull({ cloudId: item.cloudId!, suggestedName: item.name }));
      }
    };
    return (
      <div
        key={`native:${itemKey}`}
        ref={menuFor === itemKey ? menuRootRef : undefined}
        className={`group rounded-md px-2 py-1.5 cursor-pointer ${
          isActive ? "bg-accent" : "hover:bg-accent/40"
        }`}
        onClick={open}
      >
        <div className="flex items-center gap-1.5">
          <FileIcon />
          <span className="text-[12.5px] text-foreground truncate flex-1" title={item.path ?? item.name}>
            {item.name}
          </span>
          {format !== "markdown" && (
            <span className="font-mono text-[9px] uppercase tracking-wide text-muted/80 shrink-0">{format === "other" ? "file" : format}</span>
          )}
          <span className={`text-[9px] px-1 py-px rounded border shrink-0 ${badgeClass}`}>
            {label}
          </span>
          {(item.path || item.cloudId) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuFor(menuFor === itemKey ? null : itemKey);
              }}
              className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-muted hover:text-foreground hover:bg-accent/40 shrink-0 transition"
              aria-label="Actions"
            >
              ⋯
            </button>
          )}
        </div>
        {item.path && !item.exists && (
          <div className="text-[10px] text-[var(--status-red)] pl-5">Missing on disk</div>
        )}
        {item.shared && (item.sharedBy || item.role) && (
          <div className="text-[10px] text-muted pl-5 truncate">
            {item.sharedBy ? `Shared by ${item.sharedBy}` : "Shared with you"}
            {item.role ? ` · ${item.role === "editor" ? "Editor" : "Viewer"}` : ""}
          </div>
        )}

        {menuFor === itemKey && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pl-5 pt-1.5 text-[11px]" onClick={(e) => e.stopPropagation()}>
            {item.path && (
              <button className="text-muted hover:text-foreground" onClick={() => copyPath(item.path!)}>Copy path</button>
            )}
            {item.path && item.exists && classic && (
              <button className="text-muted hover:text-foreground" onClick={() => copyContents(item)}>Copy contents</button>
            )}
            {/* "Unpushed" means the snapshot never reached the cloud. It had a
                badge and no way out: the update strip only appears when the
                server is ahead, which this usually is not, so the only recovery
                was to open the file and save it again with nothing saying so. */}
            {signedIn && item.state === "unpushed" && item.exists && item.path && (
              <button
                className="text-[var(--status-blue)] hover:underline"
                onClick={() => act(() => api.docRetryPush!({ path: item.path! }))}
              >
                Retry backup
              </button>
            )}
            {signedIn && item.state === "local-only" && item.exists && classic && (
              <button className="text-muted hover:text-foreground" onClick={() => syncOn(item)}>Sync to cloud</button>
            )}
            {signedIn && item.state === "paused" && item.exists && classic && (
              <button className="text-muted hover:text-foreground" onClick={() => syncOn(item)}>Resume sync</button>
            )}
            {signedIn && item.state === "synced" && (
              <button className="text-muted hover:text-foreground" onClick={() => setConfirmOff(item.path)}>Stop syncing</button>
            )}
            {signedIn && item.state === "behind" && (
              <button className="text-[var(--status-blue)] hover:underline" onClick={() => act(() => api.docResolve({ path: item.path!, strategy: "cloud" }))}>Pull latest</button>
            )}
            {/* "Take cloud" sat here as an unlabelled button that silently
                destroyed every local line the server never received. Opening
                the document puts the choice where the counts are, so nobody
                picks it without being told what it costs. */}
            {signedIn && item.state === "conflict" && item.path && (
              <button
                className="text-[var(--status-blue)] hover:underline"
                onClick={() => onOpenPath(item.path!)}
              >
                Review changes…
              </button>
            )}
            {cloudCopyOnly(item) && signedIn && (
              <button className="text-[var(--status-blue)] hover:underline" onClick={() => act(() => api.docPull({ cloudId: item.cloudId!, suggestedName: item.name }))}>Download…</button>
            )}
          </div>
        )}
      </div>
    );
  };

  const recoveryRow = (record: LibraryRecord) => <button
    key={`recovery:${record.id}`} type="button" onClick={() => onOpenDocument?.(record)} disabled={!onOpenDocument}
    aria-current={record.id === activeDocumentId ? "true" : undefined}
    className={`group w-full text-left rounded-md px-2 py-1.5 disabled:opacity-50 ${record.id === activeDocumentId ? "bg-accent" : "hover:bg-accent/40"}`}
  >
    <span className="flex items-center gap-1.5"><FileIcon /><span className="text-[12.5px] text-foreground truncate flex-1" title={record.name}>{record.name}</span>{" "}
      <span className="text-[9px] px-1 py-px rounded border shrink-0 text-muted border-border" title="A local recovery copy, not a synced file">Recovered</span></span>
    {" "}<span className="block pl-5 text-[10px] text-muted">{record.format.toUpperCase()} · Local recovery</span>
  </button>;
  const retainedRow = retainedVisible && retainedDocument ? <button key="retained:markdown" type="button" onClick={retainedDocument.onSelect}
    aria-current={retainedDocument.selected ? "true" : undefined}
    className={`group w-full text-left rounded-md px-2 py-1.5 ${retainedDocument.selected ? "bg-accent" : "hover:bg-accent/40"}`}>
    <span className="flex items-center gap-1.5"><FileIcon /><span className="text-[12.5px] text-foreground truncate flex-1">{retainedDocument.name}</span>{" "}<span className="text-[9px] px-1 py-px rounded border shrink-0 text-muted border-border">{retainedDocument.dirty ? "Unsaved" : "Open"}</span></span>
  </button> : null;
  // Explicit sorts cross source boundaries, but never convert a recovery or
  // retained document into a native file or change the callback it opens.
  const sortedRows = query.sort === "default" ? [] : queryLibraryDocuments([
    ...localFiles.map((item) => ({ metadata: nativeMetadata(item), node: fileRow(item) })),
    ...visibleDocuments.map((record) => ({ metadata: recoveryMetadata(record), node: recoveryRow(record) })),
    ...(retainedVisible && retainedDocument ? [{ metadata: { key: "retained:markdown", name: retainedDocument.name, path: retainedDocument.path, format: retainedFormat }, node: retainedRow }] : []),
  ], query, ({ metadata }) => metadata);
  const cloudWorkspace = presentation === "workspace" && view === "cloud";
  const effectiveCloudTab: CloudTab = renderCloudDocuments ? cloudTab : "sync";

  return (
    <div
      data-markie-cloud-workspace={cloudWorkspace ? "true" : undefined}
      className={cloudWorkspace
        ? "markie-cloud-workspace relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
        : `markie-side-panel relative shrink-0 h-full flex flex-col border-r bg-surface ${dropping ? "border-foreground/40" : "border-border"}`}
      style={cloudWorkspace ? undefined : { width }}
      onDragOver={(e) => {
        if (cloudWorkspace || !getElectronAPI()?.pathForFile) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        if (e.relatedTarget === null) setDropping(false);
      }}
      onDrop={cloudWorkspace ? undefined : onDrop}
    >
      {!cloudWorkspace && dropping && (
        <div className="absolute inset-0 z-10 m-1.5 rounded-lg border-2 border-dashed border-foreground/40 bg-surface/80 flex items-center justify-center pointer-events-none">
          <span className="text-[12px] text-foreground/80">Drop to add to your library</span>
        </div>
      )}
      {!cloudWorkspace && <PanelResizer width={width} onWidth={setUserWidth} onCommit={commitWidth} />}
      {cloudWorkspace ? (
        <div className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border/70 px-5 py-3 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border border-border/80 bg-surface-2/80 text-[var(--status-blue)] shadow-[inset_0_1px_rgba(255,255,255,0.07),0_6px_16px_rgba(0,0,0,0.12)]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 19a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 19z" /></svg>
            </span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold leading-tight tracking-tight text-foreground">Cloud</h2>
              {signedIn ? <p className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-none text-muted"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--status-green)]" />Connected</p> : <button type="button" onClick={onSignIn} className="mt-0.5 flex items-center gap-1.5 rounded text-left text-[11px] leading-none text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--status-yellow)]" />Sign in</button>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={onOpenFile} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] text-muted transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]" aria-label="Open a file from disk"><span aria-hidden="true" className="text-sm leading-none">+</span><span className="hidden sm:inline">Open file</span></button>
            <button type="button" onClick={onClose} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/80 bg-surface-2/70 px-2.5 text-[11.5px] text-foreground shadow-[inset_0_1px_rgba(255,255,255,0.05)] transition hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]" aria-label="Back to document"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>Document</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3 h-10 shrink-0 border-b border-border">
          <span className="text-[11px] uppercase tracking-wide text-muted font-medium">{VIEW_TITLE[view]}</span>
          <div className="flex items-center gap-1">
            <button onClick={onOpenFile} title="Open a file from disk (⌘O)" aria-label="Open a file from disk" className="text-muted hover:text-foreground w-6 h-6 flex items-center justify-center rounded hover:bg-accent/40">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button onClick={onClose} title={`Collapse the ${VIEW_TITLE[view]} panel (⌘L)`} aria-label={`Collapse the ${VIEW_TITLE[view]} panel`} className="text-muted hover:text-foreground w-6 h-6 flex items-center justify-center rounded hover:bg-accent/40">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* One row of tabs, and only in the Library view. There is no second row
          under it any more: Projects moved to its own rail destination, and a
          panel that spends two of its first three rows on navigation was the
          thing the nesting cost. */}
      {view === "library" && (
        <>
          <div className="shrink-0 border-b border-border/60 px-2 py-2">
            <div
              className="markie-segmented-control flex w-full"
              role="group"
              aria-label="Library sections"
            >
              {(
                [
                  ["recent", "Recent"],
                  ["projects", "Projects"],
                ] as Array<[LibTab, string]>
              ).map(([t, label]) => (
                <button
                  key={t}
                  data-library-tab={t}
                  aria-pressed={libTab === t}
                  onClick={() => pickTab(t)}
                  className="markie-segmented-option flex-1"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {libTab === "recent" && (onCreateDocument || onOpenVault) && (
            <div className="px-2 py-1.5 border-b border-border/60" role="group" aria-label="Document actions">
              {onCreateDocument ? <div role="group" aria-label="Create document">
                <button type="button" onClick={() => setShowNewDocument(true)} className="w-full rounded-md border border-border/70 px-2 py-1.5 text-left text-[11.5px] text-foreground hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]">New document…</button>
              </div> : null}
              {onOpenVault ? <div className={onCreateDocument ? "mt-2 border-t border-border/60 pt-1" : ""}><button type="button" onClick={onOpenVault} className="w-full text-left text-[11px] text-muted hover:text-foreground hover:bg-accent/40 rounded-md px-1 py-1 focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]">Locked vault</button></div> : null}
            </div>
          )}
          {!loading && libTab === "recent" && totalDocuments > 0 && <LibraryDocumentFilters query={query} onChange={setQuery} searchTextAvailable={documentRecords.length > 0} />}
          {!loading && libTab === "recent" && signedIn ? <div className="px-2 py-1"><CloudAreaPicker label="Upload destination" defaultLabel="Default cloud" value={uploadArea} onChange={setUploadArea} fullWidth /></div> : null}
          {!loading && libTab === "recent" && <LibraryOverviewBand overview={overview} recoveredCount={documentRecords.length} />}
          {!loading && libTab === "recent" && queryActive && <p role="status" className="px-2.5 py-1 text-[10.5px] text-muted tabular-nums">{visibleCount} of {totalDocuments} documents</p>}
        </>
      )}

      {cloudWorkspace ? (
        <CloudAreaProvider presentation="workspace" showPicker={false}>
          <div className="shrink-0 border-b border-border/60 px-5 py-4 sm:px-7">
            <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {renderCloudDocuments ? (
                  <div className="markie-segmented-control" role="tablist" aria-label="Cloud sections">
                    {([["snapshots", "Snapshots"], ["sync", "Sync & sharing"]] as Array<[CloudTab, string]>).map(([tab, label]) => (
                      <button key={tab} type="button" role="tab" aria-selected={effectiveCloudTab === tab} onClick={() => pickCloudTab(tab)} className="markie-segmented-option">{label}</button>
                    ))}
                  </div>
                ) : <span />}
                {signedIn ? <div className="w-full min-w-[220px] sm:w-[300px]"><CloudAreaScopePicker /></div> : null}
              </div>
              <LibraryDocumentFilters query={query} onChange={setQuery} layout="workspace" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
            <div role="tabpanel" aria-label={effectiveCloudTab === "snapshots" ? "Snapshots" : "Sync and sharing"} className="mx-auto w-full max-w-[1180px]">
              {effectiveCloudTab === "snapshots" ? renderCloudDocuments?.(query, "workspace") : null}
              {effectiveCloudTab === "sync" ? (
                <CloudView
                  items={visibleItems}
                  query={query}
                  presentation="workspace"
                  alongsideSnapshots={!!renderCloudDocuments}
                  loading={loading}
                  renderRow={fileRow}
                  signedIn={signedIn}
                  accountId={accountId}
                  accountSessionKey={confirmedAccountScope()?.userId === accountId ? scopeKey : ""}
                  onManage={onManageShare}
                  onOpenPath={onOpenPath}
                  cloudError={cloudError}
                  refreshKey={refreshKey}
                />
              ) : null}
            </div>
          </div>
        </CloudAreaProvider>
      ) : null}

      {view === "cloud" && !cloudWorkspace ? <LibraryDocumentFilters query={query} onChange={setQuery} /> : null}

      {!cloudWorkspace && <div className="flex-1 overflow-y-auto px-1.5 py-2">
        {view === "browse" ? (
          <BrowseView onOpenPath={onOpenPath} activePath={activePath} />
        ) : view === "skills" ? (
          <SkillsView onOpenPath={onOpenPath} activePath={activePath} />
        ) : view === "cloud" ? (
          <CloudAreaProvider>
          {renderCloudDocuments?.(query, "panel")}
          <CloudView
            items={visibleItems}
            query={query}
            alongsideSnapshots={!!renderCloudDocuments}
            loading={loading}
            renderRow={fileRow}
            signedIn={signedIn}
            accountId={accountId}
            accountSessionKey={confirmedAccountScope()?.userId === accountId ? scopeKey : ""}
            onManage={onManageShare}
            onOpenPath={onOpenPath}
            cloudError={cloudError}
            refreshKey={refreshKey}
          />
          </CloudAreaProvider>
        ) : loading ? (
          <LibrarySkeleton />
        ) : libTab === "projects" ? (
          <ProjectsPanelContainer
            refreshKey={refreshKey}
            activePath={activePath}
            onOpenPath={onOpenPath}
          />
        ) : localFiles.length === 0 && visibleDocuments.length === 0 && !retainedVisible ? (
          queryActive && totalDocuments > 0 ? <p className="px-2 py-2 text-[12px] text-muted">No documents match this filter.</p> :
          <RecentEmptyState
            onOpenFile={onOpenFile}
            onShowProjects={() => pickTab("projects")}
            workspace={workspace}
          />
        ) : (
          <>
            {query.sort !== "default" ? sortedRows.map(({ node }) => node) : <>
            {retainedRow}
            {localFiles.length > 0 ? <>
              <LibrarySectionHeader label="On this device" items={localFiles} />
              {localFiles.map(fileRow)}
            </> : null}
            {visibleDocuments.length > 0 ? <>
              <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted font-medium">Recovered documents</div>
              {visibleDocuments.map(recoveryRow)}
            </> : null}
            </>}
          </>
        )}
      </div>}

      {!cloudWorkspace && !signedIn && (
        <button
          onClick={onSignIn}
          className="m-2 text-[11px] text-muted hover:text-foreground border border-border rounded-md py-1.5 px-2 text-left leading-snug"
        >
          <span className="text-foreground/90">Sign in</span> to sync these files
          across your devices and share them.
        </button>
      )}
      <PanelNotice notice={notice} />

      {!cloudWorkspace && needsDefault && (
        <div className="border-t border-border px-2 py-2">
          <button
            onClick={makeDefault}
            disabled={settingDefault}
            className="w-full text-[11px] text-muted hover:text-foreground rounded-md py-1.5 px-2 text-left hover:bg-accent/40 disabled:opacity-50"
          >
            {settingDefault
              ? "Setting…"
              : "Open .md files in Markie by default"}
          </button>
          {defaultMsg && (
            <div className="text-[10.5px] text-muted px-2 pt-1 leading-snug">{defaultMsg}</div>
          )}
          {onOpenDefaultApps && (
            <button
              onClick={onOpenDefaultApps}
              className="w-full text-[10.5px] text-muted/80 hover:text-foreground rounded-md px-2 pt-0.5 text-left"
            >
              Text, CSV, JSON and more…
            </button>
          )}
        </div>
      )}

      {!cloudWorkspace && needsDefault === false && onOpenDefaultApps && othersElsewhere.length > 0 && !othersHintDismissed && (
        <div className="group flex items-center border-t border-border px-2 py-1.5">
          <button
            onClick={onOpenDefaultApps}
            title={`Still opening elsewhere: ${othersElsewhere.join(", ")}`}
            className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-accent/40 hover:text-foreground"
          >
            Open text, CSV, JSON and more in Markie…
          </button>
          <button
            onClick={dismissOthersHint}
            aria-label="Hide default apps suggestion"
            className="shrink-0 rounded px-1.5 text-[13px] leading-none text-muted/70 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {confirmOff && (
        <div className="markie-scrim-strong fixed inset-0 z-[110] flex items-center justify-center">
          <div className="w-[380px] rounded-xl border border-border shadow-2xl p-4" style={{ background: "var(--surface-2)" }}>
            <div className="text-[13px] text-foreground mb-1">Stop syncing this document?</div>
            <div className="text-[12px] text-muted mb-4">
              A copy currently exists in your cloud. You can keep it there
              (syncing just pauses) or delete it.
            </div>
            <div className="flex flex-col gap-2">
              <button className="w-full text-[12px] py-2 rounded-md bg-accent text-foreground" onClick={() => act(async () => { await getElectronAPI()!.docSyncOff({ path: confirmOff, deleteRemote: false }); setConfirmOff(null); })}>
                Keep cloud copy, pause syncing
              </button>
              <button className="w-full text-[12px] py-2 rounded-md border border-[color:var(--status-red)] text-[var(--status-red)] hover:bg-accent/40" onClick={() => act(async () => { await getElectronAPI()!.docSyncOff({ path: confirmOff, deleteRemote: true }); setConfirmOff(null); })}>
                Delete the cloud copy
              </button>
              <button className="w-full text-[12px] py-1.5 text-muted hover:text-foreground" onClick={() => setConfirmOff(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {showNewDocument && onCreateDocument && (
        <NewDocumentModal
          onClose={() => setShowNewDocument(false)}
          onCreate={(format) => { setShowNewDocument(false); onCreateDocument(format); }}
        />
      )}
    </div>
  );
}

const SKELETON_WIDTHS = ["72%", "54%", "80%", "46%"];

function LibrarySkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading library</span>
      <div className="animate-pulse" aria-hidden="true">
        {SKELETON_WIDTHS.map((width, i) => (
          <div key={i} className="rounded-md px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <div className="h-[13px] w-[13px] rounded bg-accent shrink-0" />
              <div className="h-2.5 flex-1 rounded bg-accent" style={{ maxWidth: width }} />
              <div className="h-3 w-8 rounded bg-accent shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LibrarySectionHeader({
  label,
  items,
}: {
  label: string;
  items: LibraryItem[];
}) {
  const attention = items.filter(libraryItemNeedsAttention).length;

  return (
    <div className="flex items-center justify-between gap-2 px-2 pt-3 pb-1">
      <span className="text-[9px] uppercase tracking-wide text-muted">{label}</span>
      <span
        className={`rounded border px-1 py-px text-[9px] tabular-nums ${
          attention > 0
            ? "border-[color:var(--status-yellow)] text-[var(--status-yellow)]"
            : "border-border/70 text-muted"
        }`}
      >
        {attention > 0 ? `${attention} alert${attention === 1 ? "" : "s"}` : items.length}
      </span>
    </div>
  );
}

// File counts and recovery copies stay distinct; a local recovery record does
// not prove that an external file was saved or synced.
function LibraryOverviewBand({ overview, recoveredCount = 0 }: { overview: LibraryOverview; recoveredCount?: number }) {
  return (
    <div className="shrink-0 border-b border-border/60 px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted tabular-nums">
          {recoveredCount ? `${overview.onDevice} files · ${recoveredCount} recovered` : `${overview.onDevice} on this device`}
        </span>
        <span
          className={`text-[10.5px] ${
            overview.needsAttention > 0 ? "text-[var(--status-yellow)]" : "text-muted"
          }`}
        >
          {overview.needsAttention > 0 ? `${overview.needsAttention} need attention` : "All clear"}
        </span>
      </div>
    </div>
  );
}

function RecentEmptyState({
  onOpenFile,
  onShowProjects,
  workspace,
}: {
  onOpenFile: () => void;
  onShowProjects: () => void;
  workspace: WorkspaceBootstrapResult | null;
}) {
  const readyPath =
    workspace && !workspace.error && workspace.roots.length > 0
      ? workspace.defaultPath || workspace.roots[0]
      : null;
  const compactPath = readyPath ? compactWorkspacePath(readyPath) : null;

  return (
    <div className="px-2 py-3">
      <div className="rounded-md border border-border/70 bg-background/45 px-2.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[12px] font-medium text-foreground">
              {compactPath ? "Workspace ready" : "No recent files"}
            </div>
            {compactPath && (
              <div className="mt-0.5 text-[10.5px] text-muted truncate" title={readyPath ?? undefined}>
                {compactPath}
              </div>
            )}
          </div>
          {workspace?.created && (
            <span className="rounded border border-[color:var(--status-green)] px-1 py-px text-[9px] uppercase tracking-wide text-[var(--status-green)]">
              New
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={onOpenFile}
            className="rounded-md bg-accent px-2 py-1 text-[11px] text-foreground hover:opacity-90"
          >
            Open file
          </button>
          <button
            onClick={onShowProjects}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-accent/40 hover:text-foreground"
          >
            Projects
          </button>
        </div>
      </div>
    </div>
  );
}

function compactWorkspacePath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const documentsMarkie = normalized.match(/(?:^|\/)(Documents\/Markie)$/);
  if (documentsMarkie) return `~/${documentsMarkie[1]}`;
  return path;
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
