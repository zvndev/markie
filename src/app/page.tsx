"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Toolbar } from "@/components/toolbar";
import { Editor } from "@/components/editor";
import { RichView } from "@/components/rich-view";
import { FormatRail } from "@/components/format-rail";
import { StatsPanel } from "@/components/stats-panel";
import type { Editor as TipTapEditor } from "@tiptap/react";
import { formatMarkdownTables } from "@/lib/format-tables";
import { csvToMarkdownTable, markdownTableToCSV } from "@/lib/csv";
import { CommandPalette } from "@/components/command-palette";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { Settings } from "@/components/settings";
import { Library } from "@/components/library";
import { ActivityBar, type LeftView } from "@/components/activity-bar";
import { ShareDialog } from "@/components/share-dialog";
import { ShareGate } from "@/components/share-gate";
import {
  ShareBanner,
  LiveSourceBanner,
  UpdateStrip,
} from "@/components/share-banner";
import { ConflictDialog } from "@/components/conflict-dialog";
import { AgentsDialog } from "@/components/agents-dialog";
import { UpdateToast } from "@/components/update-toast";
import { FindBar } from "@/components/find-bar";
import { richFindTarget } from "@/lib/rich-find";
import { sourceFindTarget } from "@/lib/source-find";
import type { EditorView as SourceView } from "@codemirror/view";
import { TerminalPanel } from "@/components/terminal-panel";
import { TERMINAL_ENABLED } from "@/lib/features";
import {
  applyColorMode,
  colorModeForThemeId,
  getColorMode,
  watchSystemColorMode,
} from "@/lib/color-mode";
import {
  adoptAuthToken,
  authClient,
  collabWsBase,
  getAuthToken,
  pushSyncConfig,
  sharesClient,
} from "@/lib/auth-client";
import { consumeAuthState } from "@/lib/auth-state";
import { colorForName, type CollabConfig, type PeerUser } from "@/lib/collab";
import {
  canEditDocument,
  isReadOnlyShare,
  roleFor,
  shareBannerFor,
  type ShareRoleState,
} from "@/lib/share-role";
import {
  pullCloudThemes,
  pushCloudThemes,
  getDocTheme,
} from "@/lib/theme-sync";
import type { ThemeTokens } from "@/lib/theme";
import type { AppCommand } from "@/lib/commands";
import {
  applyTheme,
  findTheme,
  loadThemeStore,
  saveThemeStore,
  BUILT_IN_THEMES,
} from "@/lib/theme";
import { buildPDFHTML, type PDFTheme } from "@/lib/pdf-styles";
import {
  getElectronAPI,
  type DocUpdate,
  type FilePayload,
  type SaveResult,
} from "@/lib/electron";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { pathDirname } from "@/lib/path-utils";

const SAMPLE = `# Northstar Sprint Brief

A calm launch room needs one source of truth: \`decisions\`, owners, evidence, and [source links](https://markie.zvndev.com). This brief keeps the work legible without turning it into a status meeting.

## Signal

- **Customer promise** - local files stay fast, private, and portable.
- **Launch proof** - every platform claim needs a build, a smoke test, and a screenshot.
- **Quality bar** - permissions, sync state, and visual themes must agree with the server truth.

## Release Gate

\`\`\`typescript
type Gate = "blocked" | "ready";

const releaseGate = ({ mac, windows, sharing }: Record<string, boolean>): Gate =>
  mac && windows && sharing ? "ready" : "blocked";
\`\`\`

## Evidence

| Track | Evidence | State |
| --- | --- | --- |
| Research | Interview notes and source links | Stable |
| Prototype | Screen captures and edge cases | In review |
| Security | Access rules and audit notes | Ready |
| Rollout | Owner, date, and follow-up plan | Draft |

## Open Work

- [x] Name the customer promise
- [x] Record the decision log
- [x] Attach verification evidence
- [ ] Trim loose language
- [ ] Send the final brief

> A good tool disappears when the work gets serious.

---

$E = mc^2$
`;

type ViewMode = "edit" | "preview" | "split";

const isCSVName = (name: string | null) => !!name && /\.csv$/i.test(name);

// CSV files stay true CSV on disk; in the app they live as a markdown table
const fromDisk = (name: string | null, raw: string) =>
  isCSVName(name) ? csvToMarkdownTable(raw) : raw;
const toDisk = (name: string | null, md: string) =>
  isCSVName(name) ? markdownTableToCSV(md) : md;

export default function Home() {
  const [content, setContent] = useState("");
  const [booted, setBooted] = useState(false);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  // which side-panel view the left rail has selected
  const [leftView, setLeftView] = useState<LeftView>("library");
  const leftViewRef = useRef<LeftView>("library");
  const [showTerminal, setShowTerminal] = useState(false);
  const [richEditor, setRichEditor] = useState<TipTapEditor | null>(null);
  const [sourceView, setSourceView] = useState<SourceView | null>(null);
  const [showFind, setShowFind] = useState(false);
  const [findWithReplace, setFindWithReplace] = useState(false);
  // In Split both panes are on screen, so find follows the one you last
  // touched. In the single-pane modes there is nothing to choose between.
  const [lastPane, setLastPane] = useState<"rich" | "source">("rich");
  // bumps when auth changes out-of-band (deep-link sign-in) so account UI refreshes
  const [authNonce, setAuthNonce] = useState(0);
  // bumps to refresh the Library panel (file opened/saved, sync changed)
  const [libRefreshKey, setLibRefreshKey] = useState(0);
  const [showShare, setShowShare] = useState(false);
  const [canShare, setCanShare] = useState(false);
  // Manage sharing on an arbitrary owned doc (from the Shared → "by me" tab),
  // independent of whichever doc is currently open.
  const [manageShare, setManageShare] = useState<{ docId: string; name: string } | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  const [collabCfg, setCollabCfg] = useState<CollabConfig | null>(null);
  // What the server says this user may do with the open document, plus who
  // shared it. "local" until a cloud copy is found, "checking" until the server
  // answers. Everything that can write to the document reads this.
  const [roleState, setRoleState] = useState<ShareRoleState>("local");
  const [sharedBy, setSharedBy] = useState<string | null>(null);
  // A copy that could not be written. Shown on the banner; there is no toast.
  const [forkError, setForkError] = useState<string | null>(null);
  // The server has a newer snapshot of the open document. Null when it does not.
  const [updateWaiting, setUpdateWaiting] = useState<DocUpdate | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [showConflict, setShowConflict] = useState(false);
  const [peers, setPeers] = useState<PeerUser[]>([]);
  const [liveStatus, setLiveStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");
  // Owner-pinned theme on the open shared doc (non-owners only)
  const [enforcedTheme, setEnforcedTheme] = useState<ThemeTokens | null>(null);

  const isDirty = content !== savedContent;

  useEffect(() => {
    leftViewRef.current = leftView;
  }, [leftView]);

  // Latest open-doc path + content, read by palette command closures without
  // rebuilding the command list on every keystroke.
  const docRef = useRef({ filePath, content });
  useEffect(() => {
    docRef.current = { filePath, content };
  }, [filePath, content]);

  // Only the newest resolution may write state. Role now decides whether the
  // document can be edited, so a slow answer for the previous file landing on
  // this one would be worse than stale: it could unlock a doc it never read.
  const collabRunRef = useRef(0);

  // Resolve the open doc's share role, and with it whether the doc goes live: a
  // doc is live when it's cloud-synced, we're signed in, and at least one other
  // person has been invited. Re-checked on file open, sign-in changes, sync
  // changes, and share-list changes.
  const refreshCollab = useCallback(() => {
    const api = getElectronAPI();
    const run = ++collabRunRef.current;
    const superseded = () => run !== collabRunRef.current;
    const entryPromise =
      api?.registryGet && filePath
        ? api.registryGet(filePath)
        : Promise.resolve(null);
    entryPromise
      .then(async (entry) => {
        const cid = entry?.cloud_doc_id ?? null;
        const token = getAuthToken();
        if (superseded()) return;
        setCanShare(!!cid && !!token);
        if (!cid || !token) {
          // No cloud copy: a plain local file, with nothing to enforce.
          setRoleState("local");
          setSharedBy(null);
          setCollabCfg(null);
          setEnforcedTheme(null);
          return;
        }
        // There is a cloud copy, so the server owns the answer to "may I edit
        // this". The document stays read-only until it answers: assuming yes is
        // how a viewer got to type into a doc their edits could never reach.
        setRoleState("checking");
        const me = await authClient.me();
        const [access, members] = me
          ? await Promise.all([sharesClient.access(cid), sharesClient.list(cid)])
          : [null, null];
        if (superseded()) return;
        // Owners are deliberately absent from the member list, so ownership
        // comes from the access summary the server computes for us.
        const ownerId = access?.role === "owner" ? me?.id ?? null : null;
        const role = roleFor(members, me?.id ?? null, ownerId);
        setRoleState(role);
        // Remember it: Markie is local-first, so the next launch may have no
        // network, and a role we already proved should survive that.
        if (filePath) void api?.registrySetRole?.({ path: filePath, role });
        // Same answer, same doc: the sync engine can now refuse a push the
        // server would only reject.
        api?.syncDocRole?.({ cloudId: cid, role });
        // Members read with the owner's pinned theme when one is set;
        // the owner always keeps their own live theme
        if (members?.some((m) => m.user_id === me?.id)) {
          getDocTheme(cid).then((theme) => {
            if (!superseded()) setEnforcedTheme(theme);
          });
        } else {
          setEnforcedTheme(null);
        }
        // Only a viewer sees the banner, so only a viewer needs the name on it.
        if (isReadOnlyShare(role)) {
          api
            ?.libraryState?.()
            .then((state) => {
              if (superseded()) return;
              setSharedBy(
                state.items.find((i) => i.cloudId === cid)?.sharedBy ?? null
              );
            })
            // A missing name costs the banner one clause; it must not cost the
            // banner itself.
            .catch(() => {});
        } else {
          setSharedBy(null);
        }
        if (!me || !members || members.length === 0) {
          setCollabCfg(null);
          return;
        }
        const readonly = isReadOnlyShare(role);
        const display = me.name || me.email;
        setCollabCfg((prev) =>
          prev &&
          prev.docId === cid &&
          prev.readonly === readonly &&
          prev.token === token
            ? prev
            : {
                docId: cid,
                wsBase: collabWsBase(),
                token,
                user: { name: display, color: colorForName(display) },
                readonly,
              }
        );
      })
      .catch(async () => {
        if (superseded()) return;
        // We could not reach the server. Carrying the *previous document's*
        // answer over would hand someone else's edit rights to this file, so
        // that is never an option. But a role this document already proved is
        // still the best evidence we have, and being offline is an ordinary
        // state for a local-first app: without this, a dropped connection locks
        // every synced document the user owns behind a view-only banner.
        const remembered = filePath
          ? await getElectronAPI()?.registryGet?.(filePath).catch(() => null)
          : null;
        if (superseded()) return;
        const known = remembered?.share_role;
        const trusted =
          known === "owner" || known === "editor" || known === "viewer"
            ? known
            : null;
        setRoleState(trusted ?? "unreachable");
        // The sync engine needs the same answer, or a remembered viewer would
        // keep queueing pushes offline that the server only rejects later.
        if (trusted && remembered?.cloud_doc_id) {
          getElectronAPI()?.syncDocRole?.({
            cloudId: remembered.cloud_doc_id,
            role: trusted,
          });
        }
        setSharedBy(null);
        setCollabCfg(null);
        setEnforcedTheme(null);
      });
  }, [filePath]);

  useEffect(() => {
    refreshCollab();
  }, [refreshCollab]);

  // Latest refreshCollab, readable from the once-registered deep-link listener
  const refreshCollabRef = useRef(refreshCollab);
  useEffect(() => {
    refreshCollabRef.current = refreshCollab;
  }, [refreshCollab]);

  // ── Sync down ────────────────────────────────────────────────────────────
  // Markie already knew when the server was ahead: libraryState computes
  // "behind". It just never told anyone unless they happened to open the
  // Library. This asks on its own and puts the answer above the document.
  //
  // A live collab session is excluded on purpose: there the Yjs room is the
  // transport, updates arrive continuously, and the snapshot version moving is
  // not news anyone needs a strip about.
  const checkUpdates = useCallback(() => {
    const api = getElectronAPI();
    if (!api?.docCheckUpdates || !filePath || collabCfg) {
      setUpdateWaiting(null);
      return;
    }
    api
      .docCheckUpdates()
      .then(({ updates }) => {
        setUpdateWaiting(updates.find((u) => u.path === filePath) ?? null);
      })
      // A background check that fails means no strip appears, which is exactly
      // the state before the check ran. It must never interrupt writing.
      .catch(() => {});
  }, [filePath, collabCfg]);

  useEffect(() => {
    setUpdateWaiting(null);
    setUpdateError(null);
    checkUpdates();
  }, [checkUpdates]);

  // On focus and on a timer, but only while the window is focused: the answer
  // is only ever acted on by someone looking at the screen, so a backgrounded
  // Markie should make no requests at all.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(checkUpdates, 60_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onFocus = () => {
      checkUpdates();
      start();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", stop);
    if (document.hasFocus()) start();
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", stop);
      stop();
    };
  }, [checkUpdates]);

  // The clean case: nothing local is at risk, so this finishes in one click.
  const handlePullUpdate = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.docResolve || !filePath) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const res = await api.docResolve({ path: filePath, strategy: "cloud" });
      if (res.error) {
        setUpdateError(res.error);
        return;
      }
      if (typeof res.content === "string") {
        // What came back is what is now on disk, and a CSV on disk is CSV.
        const pulled = fromDisk(fileName, res.content);
        setContent(pulled);
        setSavedContent(pulled);
      }
      setUpdateWaiting(null);
      setLibRefreshKey((k) => k + 1);
    } catch {
      setUpdateError("Couldn't reach the server.");
    } finally {
      setUpdateBusy(false);
    }
  }, [filePath, fileName]);

  // Whatever the dialog did, the file on disk now holds this content.
  const handleConflictResolved = useCallback(
    (next: string) => {
      const pulled = fromDisk(fileName, next);
      setContent(pulled);
      setSavedContent(pulled);
      setUpdateWaiting(null);
      setUpdateError(null);
    },
    [fileName]
  );

  // A document that is being swapped out must not leave its access behind for
  // the next one to inherit; refreshCollab re-resolves it against the server.
  // Docs with no cloud copy stay "local" so opening a plain file never flashes
  // an access banner at someone nobody has shared anything with.
  const resetDocAccess = useCallback(() => {
    setRoleState((prev) => (prev === "local" ? "local" : "checking"));
    setSharedBy(null);
  }, []);

  // Just open. ShareGate resolves the prerequisites and offers the action that
  // clears each one, so a click can no longer resolve into a different surface
  // (Settings, the Library) or into nothing at all.
  const handleShareClick = useCallback(() => {
    setShowShare(true);
  }, []);

  // Open the share dialog to manage people on a doc I own (Shared → "by me").
  const handleManageShare = useCallback((docId: string, name: string) => {
    setManageShare({ docId, name });
  }, []);

  // Left rail: select a side-panel view. Clicking the active view closes it.
  const selectView = useCallback((v: LeftView) => {
    setShowLibrary((open) => !(open && leftViewRef.current === v));
    setLeftView(v);
  }, []);

  // Close transient overlays (modals, palette) when a new document lands.
  // The docked side panel is persistent navigation chrome, not an overlay:
  // it stays open so browsing file-to-file doesn't slam it shut.
  const dismissDocumentUI = useCallback(() => {
    setShowStats(false);
    setShowPalette(false);
    setShowHelp(false);
    setShowTheme(false);
    setShowSettings(false);
    setShowShare(false);
    setManageShare(null);
    setShowAgents(false);
    setForkError(null);
  }, []);

  // Start a fresh, unsaved markdown doc.
  const handleNewFile = useCallback(() => {
    dismissDocumentUI();
    resetDocAccess();
    setContent("");
    setSavedContent("");
    setFileName(null);
    setFilePath(null);
    setCanShare(false);
  }, [dismissDocumentUI, resetDocAccess]);

  const handlePeersChange = useCallback((p: PeerUser[]) => setPeers(p), []);
  const handleCollabStatus = useCallback(
    (s: "connecting" | "connected" | "disconnected") => setLiveStatus(s),
    []
  );

  const loadFile = useCallback(
    (data: { name: string; content: string; path: string | null }) => {
      dismissDocumentUI();
      resetDocAccess();
      const md = fromDisk(data.name, data.content);
      setContent(md);
      setFileName(data.name);
      setFilePath(data.path);
      setSavedContent(md);
      if (data.path) {
        getElectronAPI()?.registryTrack?.({
          path: data.path,
          name: data.name,
          content: data.content,
        });
      }
      setLibRefreshKey((k) => k + 1);
    },
    [dismissDocumentUI, resetDocAccess]
  );

  const openPath = useCallback(
    (p: string) => {
      getElectronAPI()
        ?.openFilePath(p)
        .then((file) => {
          if (file) loadFile(file);
        });
    },
    [loadFile]
  );

  // Files dropped onto the Library: register each on this device, open the last.
  const addPaths = useCallback(
    (paths: string[]) => {
      const api = getElectronAPI();
      if (!api || paths.length === 0) return;
      Promise.all(paths.map((p) => api.openFilePath(p))).then((files) => {
        const valid = files.filter(
          (f): f is FilePayload => f !== null
        );
        valid.forEach((f, i) => {
          if (i === valid.length - 1) {
            loadFile(f); // open + track the last one
          } else {
            api.registryTrack?.({ path: f.path, name: f.name, content: f.content });
          }
        });
        setLibRefreshKey((k) => k + 1);
      });
    },
    [loadFile]
  );

  const handleOpenFile = useCallback(() => {
    const api = getElectronAPI();
    if (api) {
      // Start the picker beside the document already open.
      api.openFile({ near: docRef.current.filePath }).then((result) => {
        if (result) loadFile(result);
      });
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.mdx,.txt,.csv";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      loadFile({ name: file.name, content: text, path: null });
    };
    input.click();
  }, [loadFile]);

  const getPreviewHTML = useCallback(
    (): string => renderMarkdownHTML(content),
    [content]
  );

  const handleExportPDF = useCallback((theme: PDFTheme) => {
    const html = getPreviewHTML();
    const fullHTML = buildPDFHTML(html, theme);

    // In Electron, send HTML to main process for printToPDF
    const api = getElectronAPI();
    if (api) {
      api.exportPDF(fullHTML);
      return;
    }

    // Web fallback: open in new window and print
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(fullHTML);
    printWindow.document.close();
    printWindow.onload = () => {
      printWindow.print();
    };
  }, [getPreviewHTML]);

  const handleSaveAs = useCallback(async (defaultName?: string): Promise<SaveResult | null> => {
    const api = getElectronAPI();
    if (!api) return null;
    const name = defaultName ?? fileName ?? "untitled.md";
    const diskContent = toDisk(name, content);
    const res = await api.saveFileAs({ defaultName: name, content: diskContent });
    if (res.success && res.path && res.name) {
      // A different file is open now, so whatever access the last one carried
      // stops applying here.
      resetDocAccess();
      setFilePath(res.path);
      setFileName(res.name);
      setSavedContent(content);
      // A file Markie wrote and now has open belongs in the registry like any
      // file it opens. A fresh row is local-only with no cloud doc, which is
      // exactly what a copy has to stay.
      await api.registryTrack?.({
        path: res.path,
        name: res.name,
        content: diskContent,
      });
      setLibRefreshKey((k) => k + 1);
    }
    return res;
  }, [fileName, content, resetDocAccess]);

  // Resolves to an error message when the save landed on disk but not in the
  // cloud, and to null otherwise.
  const handleSave = useCallback(async (): Promise<string | null> => {
    const api = getElectronAPI();
    if (!api) return null;
    if (!filePath) {
      await handleSaveAs();
      return null;
    }
    const diskContent = toDisk(fileName, content);
    const res = await api.saveFile({ filePath, content: diskContent });
    // The file changed underneath us and the user chose to take the disk copy
    // rather than overwrite it. Load it in place of what they had.
    if (res.code === "reloaded" && typeof res.content === "string") {
      const reloaded = fromDisk(fileName, res.content);
      setContent(reloaded);
      setSavedContent(reloaded);
      return null;
    }
    if (res.success) {
      setSavedContent(content);
      // Push the snapshot if this file is cloud-synced — except during a live
      // session, where peers saving would race the version counter into fake
      // conflicts; the Yjs update log is the source of truth while live.
      if (!collabCfg) {
        const push = await api.docPush?.({
          path: filePath,
          name: fileName ?? "untitled.md",
          content: diskContent,
        });
        // The file is on disk but not in the cloud. The Library now shows the
        // row as "Not backed up"; the caller gets the reason so it can say so.
        // TODO(toast): surface this failure as a toast once the toast system lands.
        if (push?.error) return push.error;
      }
    }
    return null;
  }, [filePath, fileName, content, handleSaveAs, collabCfg]);

  // Resolves to an error message when the copy could not be made, null when it
  // was made or the user backed out of the dialog.
  const handleFork = useCallback(async (): Promise<string | null> => {
    const base = fileName ?? "untitled.md";
    const forkName = base.includes(".")
      ? base.replace(/(\.[^.]+)$/, " copy$1")
      : `${base} copy`;
    const res = await handleSaveAs(forkName);
    if (!res || res.canceled) return null;
    if (!res.success || !res.path) return res?.error ?? "Couldn't write the copy.";
    // A copy is how someone leaves a document they can only read, so it must not
    // be a second window onto that same document. Saving over a file that is
    // already cloud-linked keeps that file's link, so read the row back rather
    // than trusting the new name made it local.
    const row = await getElectronAPI()?.registryGet?.(res.path);
    if (row?.cloud_doc_id) {
      return "That copy is still linked to a synced document. Save it under a name that isn't already in your Library.";
    }
    return null;
  }, [fileName, handleSaveAs]);

  // Every route to "Make a copy" reports through the banner: the menu, the
  // command palette, and the banner's own button.
  const handleMakeCopy = useCallback(async () => {
    setForkError(await handleFork());
  }, [handleFork]);

  // Named for the file manager the reader actually has, so the palette entry
  // matches the File menu and the word they would search for.
  const revealLabel = useMemo(() => {
    const platform = getElectronAPI()?.platform;
    if (platform === "win32") return "Show in Explorer";
    if (platform === "linux") return "Show in File Manager";
    return "Reveal in Finder";
  }, []);

  // Show the open document in Finder, so it can be dragged into another app.
  // A document that has never been saved has no file to point at, so save it
  // first rather than opening a window onto nowhere.
  const handleReveal = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    const current = docRef.current.filePath;
    if (!current) {
      await handlersRef.current.saveAs();
      const saved = docRef.current.filePath;
      if (!saved) return;
      await api.revealFile?.(saved);
      return;
    }
    await api.revealFile?.(current);
  }, []);

  const handleExportHTML = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    const html = buildPDFHTML(getPreviewHTML(), "light");
    const base = (fileName ?? "document").replace(/\.[^.]+$/, "");
    await api.exportHTML({ defaultName: `${base}.html`, html });
  }, [fileName, getPreviewHTML]);

  const handleRename = useCallback(async (newName: string) => {
    const api = getElectronAPI();
    if (!api || !filePath || !newName.trim()) return;
    const res = await api.renameFile({
      oldPath: filePath,
      newName: newName.trim(),
    });
    if (res.success && res.path && res.name) {
      setFilePath(res.path);
      setFileName(res.name);
    }
  }, [filePath]);

  // Window title tracks the open file and dirty state
  useEffect(() => {
    document.title = fileName
      ? `${isDirty ? "• " : ""}${fileName} — Markie`
      : "Markie";
  }, [fileName, isDirty]);

  // Drag and drop
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.relatedTarget === null) {
        setIsDragging(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const file = e.dataTransfer?.files[0];
      if (!file) return;

      // In the desktop app, resolve the real on-disk path so the dropped file
      // tracks in the registry (and can be organized), instead of an untracked
      // in-memory copy. Falls back to the browser File API on the web.
      const api = getElectronAPI();
      const realPath = api?.pathForFile?.(file) ?? null;
      if (realPath) {
        openPath(realPath);
        return;
      }
      const text = await file.text();
      loadFile({ name: file.name, content: text, path: null });
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [loadFile, openPath]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+` toggles the integrated terminal (Cmd+` is a macOS system key)
      if (TERMINAL_ENABLED && e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setShowTerminal((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        // Matched on e.code, not e.key: holding Option on macOS turns "f" into
        // "ƒ", so ⌥⌘F would never be recognised by name.
        //
        // ⌘F finds, ⌥⌘F finds and replaces. ⌘G steps, and opens the bar on the
        // last search when it is closed; the bar owns which match is current,
        // so it is the one that handles the step.
        if (e.code === "KeyF") {
          e.preventDefault();
          setFindWithReplace(e.altKey);
          setShowFind(true);
          return;
        }
        if (e.code === "KeyG") {
          e.preventDefault();
          setShowFind(true);
          return;
        }
        switch (e.key) {
          case "o":
            e.preventDefault();
            handleOpenFile();
            break;
          case "1":
            e.preventDefault();
            setMode("preview");
            break;
          case "2":
            e.preventDefault();
            setMode("edit");
            break;
          case "3":
            e.preventDefault();
            setMode("split");
            break;
          case "s":
            e.preventDefault();
            if (e.shiftKey) {
              handleSaveAs();
            } else {
              handleSave();
            }
            break;
          case "k":
            e.preventDefault();
            setShowPalette((v) => !v);
            break;
          case "l":
            e.preventDefault();
            selectView("library");
            break;
          case "n":
            e.preventDefault();
            handleNewFile();
            break;
          case "/":
            e.preventDefault();
            setShowHelp((v) => !v);
            break;
        }
        if (e.shiftKey && (e.key === "e" || e.key === "E")) {
          e.preventDefault();
          handleExportPDF("dark");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleOpenFile,
    handleExportPDF,
    handleSave,
    handleSaveAs,
    handleNewFile,
    selectView,
  ]);

  // Latest handlers, readable from once-registered IPC listeners
  const handlersRef = useRef({
    openFile: handleOpenFile,
    newFile: handleNewFile,
    exportPDF: handleExportPDF,
    save: handleSave,
    saveAs: handleSaveAs,
    fork: handleMakeCopy,
    reveal: handleReveal,
    exportHTML: handleExportHTML,
    fileOpened: (data: FilePayload) => loadFile(data),
  });
  useEffect(() => {
    handlersRef.current.openFile = handleOpenFile;
    handlersRef.current.newFile = handleNewFile;
    handlersRef.current.exportPDF = handleExportPDF;
    handlersRef.current.save = handleSave;
    handlersRef.current.saveAs = handleSaveAs;
    handlersRef.current.fork = handleMakeCopy;
    handlersRef.current.reveal = handleReveal;
    handlersRef.current.exportHTML = handleExportHTML;
  }, [
    handleOpenFile,
    handleNewFile,
    handleExportPDF,
    handleSave,
    handleSaveAs,
    handleMakeCopy,
    handleReveal,
    handleExportHTML,
  ]);

  // Apply the chosen color mode (system/light/dark) before first paint, and
  // keep "system" tracking the OS preference.
  useEffect(() => {
    applyColorMode(getColorMode());
    const stopWatch = watchSystemColorMode();
    // hand the stored auth token + server URL to the main-process sync engine
    pushSyncConfig();
    // themes follow the account: pull the cloud preset store for availability
    pullCloudThemes().then((pulled) => {
      if (pulled === false) pushCloudThemes();
    });
    return stopWatch;
  }, []);

  // Owner-pinned themes override the local choice while the doc is open
  useEffect(() => {
    if (enforcedTheme) {
      applyTheme(enforcedTheme);
      return () => {
        const store = loadThemeStore();
        applyTheme(findTheme(store, store.activeId).tokens);
      };
    }
  }, [enforcedTheme]);

  // Boot: decide the first painted document — the OS-opened file or the
  // welcome sample — before rendering anything, so the wrong doc never flashes
  useEffect(() => {
    const pending =
      getElectronAPI()?.getInitialFile?.() ?? Promise.resolve(null);
    pending.then((file) => {
      if (file) {
        loadFile(file);
      } else {
        setContent(SAMPLE);
        setSavedContent(SAMPLE);
      }
      setBooted(true);
    });
  }, [loadFile]);

  // Listen for Electron IPC events — each subscription returns an unsubscribe
  // so listeners don't accumulate on the long-lived ipcRenderer (HMR/remount).
  useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    const offs = [
      api.onMenuOpenFile?.(() => handlersRef.current.openFile()),
      api.onMenuNewFile?.(() => handlersRef.current.newFile()),
      api.onMenuExportPDF?.((theme) =>
        handlersRef.current.exportPDF(theme ?? "dark")
      ),
      api.onSetMode?.((m) => setMode(m)),
      api.onToggleStats?.(() => setShowStats((s) => !s)),
      api.onMenuCommandPalette?.(() => setShowPalette((v) => !v)),
      api.onMenuShortcuts?.(() => setShowHelp((v) => !v)),
      api.onMenuTheme?.(() => setShowTheme((v) => !v)),
      api.onMenuSettings?.(() => setShowSettings((v) => !v)),
      api.onMenuLibrary?.(() => selectView("library")),
      api.onDeepLink?.((url) => {
        // markie://auth?token=…&state=… — Google sign-in returning via the
        // bridge. Anything on the machine can fire this deep link, so the token
        // is only adopted when it carries the single-use nonce minted when we
        // opened the browser. See src/lib/auth-state.ts.
        try {
          const u = new URL(url);
          const token = u.searchParams.get("token");
          if (u.host === "auth" && token) {
            if (!consumeAuthState(u.searchParams.get("state"))) {
              console.error("markie://auth rejected: no matching sign-in was pending");
              return;
            }
            adoptAuthToken(token);
            refreshCollabRef.current();
            setAuthNonce((n) => n + 1); // re-render Settings/account state
            setShowSettings(false); // dismiss the sign-in modal — we're in now
            setLibRefreshKey((k) => k + 1); // Library can show cloud files now
            return;
          }
        } catch {
          // not a parseable deep link — fall through
        }
        setShowSettings(true);
      }),
      api.onMenuFormatTables?.(() =>
        setContent((prev) => formatMarkdownTables(prev))
      ),
      api.onMenuFind?.(() => {
        setFindWithReplace(false);
        setShowFind(true);
      }),
      api.onMenuFindReplace?.(() => {
        setFindWithReplace(true);
        setShowFind(true);
      }),
      api.onMenuSave?.(() => handlersRef.current.save()),
      api.onMenuSaveAs?.(() => handlersRef.current.saveAs()),
      api.onMenuFork?.(() => handlersRef.current.fork()),
      api.onMenuReveal?.(() => handlersRef.current.reveal()),
      api.onMenuExportHTML?.(() => handlersRef.current.exportHTML()),
      api.onFileOpened?.((data) => handlersRef.current.fileOpened(data)),
    ];
    return () => offs.forEach((off) => off?.());
  }, [selectView]);

  const commands = useMemo<AppCommand[]>(
    () => [
      { id: "open", title: "Open File…", group: "File", shortcut: "⌘O", run: handleOpenFile },
      { id: "save", title: "Save", group: "File", shortcut: "⌘S", run: handleSave },
      { id: "save-as", title: "Save As…", group: "File", shortcut: "⇧⌘S", run: () => handleSaveAs() },
      { id: "fork", title: "Duplicate (Fork)", group: "File", shortcut: "⇧⌘D", keywords: "copy fork duplicate", run: handleMakeCopy },
      { id: "reveal", title: revealLabel, group: "File", shortcut: "⌥⌘R", keywords: "finder explorer folder show reveal drag locate", run: handleReveal },
      { id: "export-pdf-dark", title: "Export PDF (Dark)", group: "File", shortcut: "⇧⌘E", keywords: "print", run: () => handleExportPDF("dark") },
      { id: "export-pdf-light", title: "Export PDF (Light)", group: "File", keywords: "print", run: () => handleExportPDF("light") },
      { id: "export-html", title: "Export HTML", group: "File", run: handleExportHTML },
      { id: "mode-view", title: "Rich Mode", group: "View", shortcut: "⌘1", keywords: "preview rich wysiwyg formatted view", run: () => setMode("preview") },
      { id: "mode-edit", title: "Source Mode", group: "View", shortcut: "⌘2", keywords: "source raw markdown edit", run: () => setMode("edit") },
      { id: "mode-split", title: "Split Mode", group: "View", shortcut: "⌘3", keywords: "both side by side", run: () => setMode("split") },
      { id: "stats", title: "Statistics", group: "View", shortcut: "⇧⌘I", keywords: "words count reading", run: () => setShowStats((v) => !v) },
      { id: "palette", title: "Command Palette", group: "View", shortcut: "⌘K", run: () => setShowPalette((v) => !v) },
      // Find lives in the source editor (CodeMirror owns ⌘F there). Surface it
      // as a command so it is discoverable from View mode, and say where it
      // lands rather than silently changing the view.
      // No longer "Find in Source": find works in whichever pane you are in,
      // so it no longer drags you into Split to reach the source editor.
      { id: "find", title: "Find…", group: "View", shortcut: "⌘F", keywords: "search find text", run: () => { setFindWithReplace(false); setShowFind(true); } },
      { id: "find-replace", title: "Find and Replace…", group: "View", shortcut: "⌥⌘F", keywords: "search find replace all substitute", run: () => { setFindWithReplace(true); setShowFind(true); } },
      ...(TERMINAL_ENABLED ? [{ id: "terminal", title: "Toggle Terminal", group: "View", shortcut: "⌃`", keywords: "shell console zsh bash powershell cmd", run: () => setShowTerminal((v) => !v) }] as AppCommand[] : []),
      { id: "copy-path", title: "Copy File Path", group: "File", keywords: "link location terminal clipboard", run: () => { const p = docRef.current.filePath; if (p) navigator.clipboard.writeText(p); } },
      { id: "copy-content", title: "Copy Document Contents", group: "File", keywords: "clipboard markdown text", run: () => navigator.clipboard.writeText(docRef.current.content) },
      { id: "format-tables", title: "Format Tables", group: "Format", shortcut: "⌥⌘T", keywords: "align prettify pipes", run: () => setContent((prev) => formatMarkdownTables(prev)) },
      ...BUILT_IN_THEMES.map((t) => ({
        id: `theme-${t.id}`,
        title: `Theme: ${t.name}`,
        group: "Theme" as const,
        keywords: "dark light color style",
        run: () => {
          const mode = colorModeForThemeId(t.id);
          if (mode) {
            applyColorMode(mode);
          } else {
            const store = loadThemeStore();
            saveThemeStore({ ...store, activeId: t.id });
            applyTheme(t.tokens);
          }
          pushCloudThemes();
        },
      })),
      { id: "theme-settings", title: "Theme Settings…", group: "Theme", keywords: "color font preset style", run: () => setShowTheme(true) },
      { id: "settings", title: "Settings…", group: "File", shortcut: "⌘,", keywords: "account sign in sync login", run: () => setShowSettings(true) },
      { id: "library", title: "Library…", group: "File", shortcut: "⌘L", keywords: "documents cloud sync files recent", run: () => selectView("library") },
      { id: "browse", title: "Browse all markdown…", group: "File", keywords: "all files device skills index find", run: () => selectView("browse") },
      { id: "skills", title: "Skills & agent files…", group: "File", keywords: "claude agents codex gemini cursor instructions", run: () => selectView("skills") },
      { id: "new-file", title: "New file", group: "File", shortcut: "⌘N", keywords: "blank create empty document", run: handleNewFile },
      // Ungated on purpose: this used to vanish from the palette exactly when
      // the user could not work out how to share, which is when they search for
      // it. ShareGate explains whatever is missing.
      { id: "share", title: "Share…", group: "File", keywords: "collaborate invite live people sync cloud link", run: () => setShowShare(true) },
      { id: "shortcuts", title: "Keyboard Shortcuts", group: "Help", shortcut: "⌘/", keywords: "help keys", run: () => setShowHelp((v) => !v) },
    ],
    [
      handleOpenFile,
      handleSave,
      handleSaveAs,
      handleMakeCopy,
      handleReveal,
      revealLabel,
      handleExportPDF,
      handleExportHTML,
      handleNewFile,
      selectView,
    ]
  );

  // Which pane the find bar searches. Rebuilt whenever the pane behind it
  // changes so it can never address an editor that has been torn down.
  const findPane: "rich" | "source" =
    mode === "edit" ? "source" : mode === "preview" ? "rich" : lastPane;
  const findTarget = useMemo(() => {
    if (findPane === "source") {
      return sourceView ? sourceFindTarget(sourceView) : null;
    }
    return richEditor ? richFindTarget(richEditor) : null;
  }, [findPane, sourceView, richEditor]);

  const closeFind = useCallback(() => setShowFind(false), []);

  if (!booted) {
    return <div className="h-screen bg-background" />;
  }

  // One resolution, every consumer: the banner, the rich pane, and the source
  // pane all read the same answer instead of each deciding for itself.
  const shareBanner = shareBannerFor(roleState, sharedBy);
  const docEditable = canEditDocument(roleState);

  return (
    <div className="markie-shell h-screen flex flex-col bg-background relative">
      <Toolbar
        mode={mode}
        onModeChange={setMode}
        onOpenFile={handleOpenFile}
        onExportPDF={handleExportPDF}
        onSaveAs={() => handleSaveAs()}
        onExportHTML={handleExportHTML}
        fileName={fileName}
        isDirty={isDirty}
        canRename={filePath !== null}
        onRename={handleRename}
        onShare={handleShareClick}
        canShare={canShare}
        onThemePresets={() => setShowTheme(true)}
        live={!!collabCfg}
        liveStatus={liveStatus}
        peers={peers}
        themeLocked={!!enforcedTheme}
      />

      <div className="markie-workspace flex-1 flex overflow-hidden">
        {/* Far-left app nav */}
        <ActivityBar
          activeView={leftView}
          panelOpen={showLibrary}
          onSelectView={selectView}
          onNewFile={handleNewFile}
          onAgents={() => setShowAgents(true)}
          onShortcuts={() => setShowHelp((v) => !v)}
          onAccount={() => setShowSettings(true)}
          authNonce={authNonce}
        />

        {/* Docked side panel (Library / Browse / Shared / Skills) */}
        {showLibrary && (
          <Library
            key={leftView}
            view={leftView}
            onClose={() => setShowLibrary(false)}
            onOpenPath={openPath}
            onOpenFile={handleOpenFile}
            onAddPaths={addPaths}
            onSignIn={() => setShowSettings(true)}
            onManageShare={handleManageShare}
            onSyncChanged={refreshCollab}
            activePath={filePath}
            refreshKey={libRefreshKey}
          />
        )}

        {/* Document column: the access strip sits above both panes, because it
            explains something about the document, not about one view of it. */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <ShareBanner
            view={shareBanner}
            error={forkError}
            onMakeCopy={handleMakeCopy}
          />
          {updateWaiting && (
            <UpdateStrip
              // "Clean" has to mean nothing is at risk, not merely that the
              // buffer looks saved. A file whose push was rejected holds
              // changes the server never took, and opening it produces a clean
              // buffer over exactly the content a one-click pull would destroy.
              kind={
                isDirty ||
                updateWaiting.syncState === "conflict" ||
                updateWaiting.syncState === "unpushed"
                  ? "dirty"
                  : "clean"
              }
              busy={updateBusy}
              error={updateError}
              onUpdate={handlePullUpdate}
              onReview={() => setShowConflict(true)}
            />
          )}

          <div
            data-markie-document-area
            className={`markie-document-area relative flex-1 min-h-0 min-w-0 overflow-hidden ${
              mode === "split"
                ? "markie-document-area--split grid grid-cols-[minmax(0,0.96fr)_minmax(0,1.04fr)] max-[820px]:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]"
                : "markie-document-area--single flex"
            }`}
          >
            <FindBar
              open={showFind}
              withReplace={findWithReplace}
              target={findTarget}
              // The source pane is also locked during a live session, because
              // shared edits have to travel through the rich pane's Yjs doc.
              canReplace={
                docEditable && !(findPane === "source" && !!collabCfg)
              }
              revision={content}
              onClose={closeFind}
            />

            {/* Editor pane */}
            {(mode === "edit" || mode === "split") && (
              <div
                data-markie-source-pane
                onFocusCapture={() => setLastPane("source")}
                className={`${
                  mode === "split" ? "markie-pane-divider" : ""
                } markie-source-pane h-full min-w-0 w-full flex-1 overflow-hidden flex flex-col`}
              >
                {collabCfg && <LiveSourceBanner />}
                <div className="flex-1 min-h-0 overflow-hidden">
                  <Editor
                    value={content}
                    onChange={setContent}
                    onViewReady={setSourceView}
                    // Read-only for two separate reasons: the rich pane owns the
                    // shared document while a session is live, and a viewer may
                    // not edit at all.
                    readOnly={!!collabCfg || !docEditable}
                  />
                </div>
              </div>
            )}

            {/* Rich View pane with format rail */}
            {(mode === "preview" || mode === "split") && (
              <div
                data-markie-rich-pane
                onFocusCapture={() => setLastPane("rich")}
                className="markie-rich-pane h-full min-w-0 w-full flex-1 overflow-hidden flex"
              >
                <FormatRail editor={richEditor} />
                <div className="flex-1 min-w-0 h-full overflow-hidden">
                  <RichView
                    key={
                      collabCfg
                        ? `live:${collabCfg.docId}:${collabCfg.readonly}`
                        : "solo"
                    }
                    value={content}
                    onChange={setContent}
                    onEditorReady={setRichEditor}
                    collab={collabCfg}
                    readOnly={!docEditable}
                    onPeersChange={handlePeersChange}
                    onCollabStatus={handleCollabStatus}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {TERMINAL_ENABLED && showTerminal && (
        <TerminalPanel
          context={{
            cwd: filePath ? pathDirname(filePath) : null,
            filePath,
          }}
          onClose={() => setShowTerminal(false)}
        />
      )}

      {showStats && (
        <StatsPanel content={content} onClose={() => setShowStats(false)} />
      )}

      {showPalette && (
        <CommandPalette commands={commands} onClose={() => setShowPalette(false)} />
      )}
      {showHelp && (
        <ShortcutsHelp commands={commands} onClose={() => setShowHelp(false)} />
      )}
      {showTheme && (
        <Settings
          authNonce={authNonce}
          initialSection="appearance"
          onClose={() => {
            setShowTheme(false);
            setAuthNonce((n) => n + 1); // account/avatar reflects sign-in/out
            setLibRefreshKey((k) => k + 1);
            refreshCollab(); // sign-in/out changes live eligibility
          }}
        />
      )}
      {showSettings && (
        <Settings
          authNonce={authNonce}
          onClose={() => {
            setShowSettings(false);
            setAuthNonce((n) => n + 1); // account/avatar reflects sign-in/out
            setLibRefreshKey((k) => k + 1);
            refreshCollab(); // sign-in/out changes live eligibility
          }}
        />
      )}
      {showShare && (
        <ShareGate
          filePath={filePath}
          fileName={fileName}
          content={toDisk(fileName, content)}
          onClose={() => setShowShare(false)}
          onChanged={refreshCollab}
          onSignIn={() => {
            setShowShare(false);
            setShowSettings(true);
          }}
        />
      )}
      {showConflict && filePath && (
        <ConflictDialog
          filePath={filePath}
          fileName={fileName ?? "this document"}
          // The buffer, not the file on disk: unsaved text is what a pull would
          // actually cost, so it is what gets counted.
          localContent={toDisk(fileName, content)}
          onClose={() => setShowConflict(false)}
          onResolved={handleConflictResolved}
          onChanged={() => setLibRefreshKey((k) => k + 1)}
        />
      )}
      {manageShare && (
        <ShareDialog
          key={`manage:${manageShare.docId}`}
          docId={manageShare.docId}
          fileName={manageShare.name}
          onClose={() => setManageShare(null)}
          // membership changed → refresh the Shared lists' counts
          onChanged={() => setLibRefreshKey((k) => k + 1)}
        />
      )}

      {showAgents && <AgentsDialog onClose={() => setShowAgents(false)} />}

      <UpdateToast />

      {/* Drag overlay */}
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <div className="text-2xl mb-2">Drop markdown file</div>
            <div className="text-sm opacity-60">.md, .markdown, .mdx, .txt</div>
          </div>
        </div>
      )}
    </div>
  );
}
