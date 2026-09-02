"use client";

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Toolbar } from "@/components/toolbar";
import { Editor } from "@/components/editor";
import { RichView, type FlushRich } from "@/components/rich-view";
import { FormatRail } from "@/components/format-rail";
import { DocToolbar } from "@/components/doc-toolbar";
import {
  appearanceKey,
  appearanceVars,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  stepZoom,
  type DocAppearance,
} from "@/lib/doc-appearance";
import { StatsPanel } from "@/components/stats-panel";
import type { Editor as TipTapEditor } from "@tiptap/react";
import { formatMarkdownTables } from "@/lib/format-tables";
import { csvToMarkdownTable, csvDropsContent, markdownTableToCSV } from "@/lib/csv";
import { CommandPalette } from "@/components/command-palette";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { Settings } from "@/components/settings";
import { Library } from "@/components/library";
import { ActivityBar } from "@/components/activity-bar";
import { RichPaneError } from "@/components/rich-pane-error";
import {
  formatRailDisabled,
  isPanelView,
  selectLeftView,
  showFormatRail,
  showSidePanel,
  type LeftView,
} from "@/lib/left-rail";
import { ShareDialog } from "@/components/share-dialog";
import { ShareGate } from "@/components/share-gate";
import {
  ShareBanner,
  LiveSourceBanner,
  UpdateStrip,
} from "@/components/share-banner";
import { ConflictDialog } from "@/components/conflict-dialog";
import { DiskChangeStrip, DiskConflictDialog } from "@/components/disk-change";
import { DraftStrip } from "@/components/draft-strip";
import { HistoryDialog } from "@/components/history-dialog";
import { diskChangeKind } from "@/lib/disk-change";
import { ErrorBoundary } from "@/components/error-boundary";
import { RichLossBanner, RichPreparingNote } from "@/components/rich-guard";
import { useRichSafety } from "@/lib/use-rich-safety";
import { AgentsDialog } from "@/components/agents-dialog";
import { UpdateToast } from "@/components/update-toast";
import { FindBar } from "@/components/find-bar";
import { richFindTarget } from "@/lib/rich-find";
import { sourceFindTarget } from "@/lib/source-find";
import type { EditorView as SourceView } from "@codemirror/view";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
import { undoTargetFor } from "@/lib/undo-target";
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
  collabWsBase,
  getAuthToken,
  pushSyncConfig,
  sharesClient,
} from "@/lib/auth-client";
import { consumeAuthState } from "@/lib/auth-state";
import { authStore } from "@/lib/auth-store";
import { markWelcomeSeen, shouldShowWelcome } from "@/lib/first-run";
import { WELCOME_DOC } from "@/lib/welcome-doc";
import { SignInDialog } from "@/components/sign-in";
import type { SignInReason } from "@/lib/auth-errors";
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
import {
  getElectronAPI,
  getSafeAPI,
  type DocUpdate,
  type FilePayload,
  type SaveResult,
} from "@/lib/electron";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { pathDirname } from "@/lib/path-utils";
import { setAssetBaseDir } from "@/lib/asset-url";
import { useDocument, type EditInput } from "@/lib/use-document";
import { useSaveGuard, type SaveGuard } from "@/lib/use-save-guard";
import { useDocumentExport } from "@/lib/use-export";

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

// What handleSave returns when a write was refused because the file moved
// underneath it. Not an error to show: the strip is already saying it.
const DISK_CHANGED = "changed-on-disk";

// A short, stable fingerprint of the collab token, so the RichView key changes
// when the token is rotated (revoke-and-reissue keeps the same doc id) without
// putting the token itself into a DOM key.
const tokenTag = (token: string) => {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h * 33) ^ token.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// CSV files stay true CSV on disk; in the app they live as a markdown table
const fromDisk = (name: string | null, raw: string) =>
  isCSVName(name) ? csvToMarkdownTable(raw) : raw;
const toDisk = (name: string | null, md: string) =>
  isCSVName(name) ? markdownTableToCSV(md) : md;

export default function Home() {
  // One owner for the buffer, its path, and whether it is dirty, so autosave,
  // drafts, and flush-on-transition attach to one place instead of five
  // useStates whose invariants nothing enforced. The transitions come out by
  // name because they are stable while the values are not: a callback that
  // writes the buffer has to keep its identity, or effects keyed on it re-run
  // in the middle of an edit.
  const doc = useDocument();
  const { content, fileName, filePath, isDirty } = doc;
  const { edit: editDoc, applyExternal: applyExternalDoc, load: loadDoc, reset: resetDoc, markSaved, setLocation } = doc;
  const { latest: latestContent } = doc;
  const [booted, setBooted] = useState(false);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [isDragging, setIsDragging] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Non-null while a gated surface is asking for a session; the value is what
  // it wants the session for, which is what the dialog puts at the top.
  const [signInReason, setSignInReason] = useState<SignInReason | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  // which side-panel view the left rail has selected
  const [leftView, setLeftView] = useState<LeftView>("library");
  const leftViewRef = useRef<LeftView>("library");
  const [showTerminal, setShowTerminal] = useState(false);
  // Latches on the first open. Hiding the terminal must not unmount it — that
  // kills the shells and whatever they were running.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [richEditor, setRichEditor] = useState<TipTapEditor | null>(null);
  const [sourceView, setSourceView] = useState<SourceView | null>(null);
  const [showFind, setShowFind] = useState(false);
  const [findWithReplace, setFindWithReplace] = useState(false);
  // In Split both panes are on screen, so find follows the one you last
  // touched. In the single-pane modes there is nothing to choose between.
  const [lastPane, setLastPane] = useState<"rich" | "source">("rich");
  // How this document is displayed. Never written to the file — markdown has no
  // way to say "Charter at 17px", and inventing one would mean putting HTML in
  // somebody's notes.
  const [appearance, setAppearance] = useState<DocAppearance>(DEFAULT_APPEARANCE);
  // bumps when auth changes out-of-band (deep-link sign-in) so account UI refreshes
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
  // The one place a document-level failure can be said out loud: a copy that
  // could not be written, an export the main process refused, a Save As that
  // silently reshaped the file. Shown on the banner; there is no toast system.
  const [forkError, setForkError] = useState<string | null>(null);
  // The rich pane's debounced serializer, so a save or an export can settle it
  // before reading the document rather than writing what it said 250 ms ago.
  const flushRichRef = useRef<FlushRich | null>(null);
  const handleFlushReady = useCallback((f: FlushRich | null) => {
    flushRichRef.current = f;
  }, []);
  // The server has a newer snapshot of the open document. Null when it does not.
  const [updateWaiting, setUpdateWaiting] = useState<DocUpdate | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [showConflict, setShowConflict] = useState(false);
  // Set when something else edited the open file. Holds the new on-disk text so
  // a reload does not have to go back to the filesystem and race the next edit.
  const [diskChange, setDiskChange] = useState<string | null>(null);
  const [showDiskConflict, setShowDiskConflict] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [peers, setPeers] = useState<PeerUser[]>([]);
  const [liveStatus, setLiveStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");
  // Owner-pinned theme on the open shared doc (non-owners only)
  const [enforcedTheme, setEnforcedTheme] = useState<ThemeTokens | null>(null);

  useEffect(() => {
    leftViewRef.current = leftView;
  }, [leftView]);

  useEffect(() => {
    if (showTerminal) setTerminalMounted(true);
  }, [showTerminal]);

  // Latest open-doc path + content, read by palette command closures without
  // rebuilding the command list on every keystroke.
  const docRef = useRef({ filePath, content, isDirty });
  useEffect(() => {
    docRef.current = { filePath, content, isDirty };
  }, [filePath, content, isDirty]);

  // Where a document's own pictures are, so `![](demo/shot.png)` resolves
  // against the folder the file came from instead of against the app's origin.
  // Set before paint: an effect that ran after would render every image once
  // against the wrong base and only then correct itself.
  useLayoutEffect(() => {
    setAssetBaseDir(filePath ? pathDirname(filePath) : null);
  }, [filePath]);

  // Whether rich edits may reach this document. Rendering rich is always safe,
  // so the verdict is resolved after first paint rather than on the open path;
  // until it lands, rich is read-only and Source is byte-faithful as ever.
  const {
    assess: assessRichSafety,
    override: overrideRichSafety,
    risks: richLossy,
    blocked: richBlocked,
    armed: richArmed,
    preparing: richPreparing,
  } = useRichSafety();

  // What the server says this user may do with the open document. Read by the
  // panes, the format rail, and the autosave gate alike.
  const docEditable = canEditDocument(roleState);
  // The save machinery is built further down, because it needs handleSave.
  // Everything declared up here that has to reach it goes through this ref.
  const saveGuardRef = useRef<Pick<SaveGuard, "cancel" | "settle">>({
    cancel: () => {},
    settle: async () => {},
  });
  // Everything that must land before the buffer is replaced or the window
  // dies. Never allowed to throw: a transition the user cannot complete is
  // worse than a save that did not, and the draft journal holds the rest.
  const settleDocument = useCallback(() => saveGuardRef.current.settle(), []);

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
        const { user: me } = await authStore.ready();
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
      .then((res) => {
        const updates = Array.isArray(res?.updates) ? res.updates : [];
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
        applyExternalDoc(pulled);
        assessRichSafety(pulled, docRef.current.filePath);
      }
      setUpdateWaiting(null);
      setLibRefreshKey((k) => k + 1);
    } catch {
      setUpdateError("Couldn't reach the server.");
    } finally {
      setUpdateBusy(false);
    }
  }, [filePath, fileName, assessRichSafety, applyExternalDoc]);

  // Whatever the dialog did, the file on disk now holds this content.
  const handleConflictResolved = useCallback(
    (next: string) => {
      const pulled = fromDisk(fileName, next);
      applyExternalDoc(pulled);
      assessRichSafety(pulled, docRef.current.filePath);
      setUpdateWaiting(null);
      setUpdateError(null);
    },
    [fileName, assessRichSafety, applyExternalDoc]
  );

  // A document that is being swapped out must not leave its access behind for
  // the next one to inherit; refreshCollab re-resolves it against the server.
  // Docs with no cloud copy stay "local" so opening a plain file never flashes
  // an access banner at someone nobody has shared anything with.
  const resetDocAccess = useCallback(() => {
    setRoleState((prev) => (prev === "local" ? "local" : "checking"));
    setSharedBy(null);
    // Tear the live session down in the same tick the document changes. The
    // RichView key only covers collab-to-collab moves, so a config left
    // standing kept file A's room mounted under file B: B's content never
    // reached the editor, A's markdown kept arriving through onChange, and the
    // next save wrote A into B's path.
    setCollabCfg(null);
    setEnforcedTheme(null);
    setPeers([]);
    // The conflict dialog is about one document's divergence from its cloud
    // copy. Left standing across a swap it described the previous file — and
    // its own state was frozen on the file it opened with, so the key on
    // <ConflictDialog> remounts it per document as well.
    setShowConflict(false);
    setUpdateError(null);
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
  // The panel a click on the pencil comes back to, so clicking it twice is not
  // a dead end.
  const lastPanelRef = useRef<LeftView>("library");
  const selectView = useCallback((v: LeftView) => {
    setShowLibrary((open) => {
      const next = selectLeftView(
        { view: leftViewRef.current, panelOpen: open, richVisible: true, canEdit: true },
        v,
        lastPanelRef.current
      );
      // Only a panel view can be "the panel you were on"; the pencil and the
      // full-width views have none to come back to.
      if (isPanelView(next.view)) lastPanelRef.current = next.view;
      setLeftView(next.view);
      return next.panelOpen;
    });
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
  const handleNewFile = useCallback(async () => {
    await settleDocument();
    dismissDocumentUI();
    resetDocAccess();
    resetDoc();
    setCanShare(false);
    assessRichSafety("", null);
  }, [dismissDocumentUI, resetDocAccess, assessRichSafety, resetDoc, settleDocument]);

  const handlePeersChange = useCallback((p: PeerUser[]) => setPeers(p), []);
  const handleCollabStatus = useCallback(
    (s: "connecting" | "connected" | "disconnected") => setLiveStatus(s),
    []
  );

  const loadFile = useCallback(
    async (data: { name: string; content: string; path: string | null; unsaved?: boolean }) => {
      // Whatever the last document still owes disk lands before this one
      // replaces it. This is the P0: Markie used to drop it silently.
      await settleDocument();
      dismissDocumentUI();
      // Re-opening the document that is already open (Library click, a reveal,
      // a re-track) is not a document swap. Tearing the session down here left
      // it down: refreshCollab is keyed on filePath, so an unchanged path never
      // re-resolved the role and the live session never came back.
      if (!data.path || data.path !== docRef.current.filePath) resetDocAccess();
      const md = fromDisk(data.name, data.content);
      // A snapshot revert arrives with unsaved:true: the buffer holds the old
      // version while the file on disk still holds the new one, so the document
      // must show as dirty until the user saves (or discards) the revert.
      loadDoc({ name: data.name, content: md, path: data.path, unsaved: data.unsaved });
      if (data.path) {
        getElectronAPI()?.registryTrack?.({
          path: data.path,
          name: data.name,
          content: data.content,
        });
      }
      setLibRefreshKey((k) => k + 1);
      assessRichSafety(md, data.path);
    },
    [dismissDocumentUI, resetDocAccess, assessRichSafety, loadDoc, settleDocument]
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
    (md?: string): string => renderMarkdownHTML(md ?? content),
    [content]
  );

  // The document as it stands *now*. The rich pane serializes on a 250 ms
  // debounce, so exporting or saving straight after a keystroke used to use the
  // previous version of the text; flushing returns the current one and pushes
  // it into state on the way past.
  // Nothing pending in the rich pane means the buffer is already current, but
  // "current" has to mean the last write, not the last render: an autosave
  // fires from a timer and can beat React to it.
  const currentMarkdown = useCallback(
    (): string => flushRichRef.current?.() ?? latestContent(),
    [latestContent]
  );

  // Paper, PDF, and standalone HTML all render through main's one hidden
  // window, so they share one in-flight guard and one error surface.
  const { exporting, exportPDF, exportHTML, printDocument } = useDocumentExport({
    previewHTML: getPreviewHTML,
    currentMarkdown,
    docPath: () => docRef.current.filePath,
    fileName,
    onError: setForkError,
  });

  const handleSaveAs = useCallback(async (defaultName?: string): Promise<SaveResult | null> => {
    const api = getSafeAPI();
    if (!api) return null;
    const name = defaultName ?? fileName ?? "untitled.md";
    const md = currentMarkdown();
    // The extension the user types in the dialog is the one that decides the
    // format, and they only type it after the content has been encoded. Hand
    // main both encodings so it can write the right one once, instead of the
    // renderer writing the file a second time behind the save sheet.
    const csvContent = markdownTableToCSV(md);
    const res = await api.saveFileAs({
      defaultName: name,
      content: md,
      csvContent,
    });
    if (res?.error) return res;
    if (res.success && res.path && res.name) {
      // Which bytes actually landed. An older main has no `wroteCsv` and wrote
      // `content` verbatim, so a .csv still needs the one re-encode + rewrite.
      let written = res.wroteCsv === undefined ? md : res.wroteCsv ? csvContent : md;
      if (res.wroteCsv === undefined && isCSVName(res.name)) {
        written = csvContent;
        const rewrite = await api.saveFile({ filePath: res.path, content: written });
        if (rewrite?.error || rewrite?.success === false) {
          return {
            success: false,
            path: res.path,
            name: res.name,
            error:
              rewrite?.error ??
              `Saved, but couldn't rewrite ${res.name} in that format.`,
          };
        }
      }
      // CSV keeps the first table and nothing else. Saying so after the fact is
      // the least we owe someone who just watched their prose disappear.
      const dropped = isCSVName(res.name) ? csvDropsContent(md) : null;
      setForkError(
        dropped?.drops
          ? dropped.hasTable
            ? `Saved as CSV: ${dropped.droppedLines} line${dropped.droppedLines === 1 ? "" : "s"} outside the first table are not in that file.`
            : "Saved as CSV: this document has no table, so the file is empty."
          : null
      );
      // A different file is open now, so whatever access the last one carried
      // stops applying here.
      resetDocAccess();
      setLocation(res.path, res.name);
      markSaved(md);
      // Save As commits the untitled buffer, so its journal entry is spent too.
      void getElectronAPI()?.draftSave?.({ path: null, name: null, content: "" });
      // A file Markie wrote and now has open belongs in the registry like any
      // file it opens. A fresh row is local-only with no cloud doc, which is
      // exactly what a copy has to stay.
      await api.registryTrack?.({
        path: res.path,
        name: res.name,
        content: written,
      });
      setLibRefreshKey((k) => k + 1);
    }
    return res;
  }, [fileName, currentMarkdown, resetDocAccess, markSaved, setLocation]);

  // Resolves to an error message when the save landed on disk but not in the
  // cloud, and to null otherwise.
  const handleSave = useCallback(async (
    // force: the user has already resolved a disk conflict in the app, so main
    // does not put the same question a second time in a native dialog.
    // autosave: nobody asked for this write, so it must never raise a dialog
    // and must refuse rather than overwrite a file that moved underneath it.
    { force = false, autosave = false }: { force?: boolean; autosave?: boolean } = {}
  ): Promise<string | null> => {
    const api = getSafeAPI();
    if (!api) return null;
    // A manual save is the flush. Cancelling first means the pending timer
    // cannot fire straight after it and write the same bytes twice.
    if (!autosave) saveGuardRef.current.cancel();
    if (!filePath) {
      const saved = await handleSaveAs();
      return saved?.error ?? null;
    }
    const md = currentMarkdown();
    const diskContent = toDisk(fileName, md);
    const res = await api.saveFile({ filePath, content: diskContent, force, autosave });
    // Every caller of handleSave discards the return value, so a save that
    // never reached disk has to say so here or it says nothing at all.
    if (res?.error) {
      setForkError(res.error);
      return res.error;
    }
    // The file changed underneath us and the user chose to take the disk copy
    // rather than overwrite it. Load it in place of what they had.
    if (res.code === "reloaded" && typeof res.content === "string") {
      const reloaded = fromDisk(fileName, res.content);
      applyExternalDoc(reloaded);
      assessRichSafety(reloaded, filePath);
      return null;
    }
    // An autosave found the same collision. Nothing was written and nobody was
    // interrupted: raise the strip the user already knows, and let the gate
    // below hold autosave off until they resolve it.
    if (res.code === "disk-changed" && typeof res.content === "string") {
      setDiskChange(res.content);
      return DISK_CHANGED;
    }
    if (res.success) {
      markSaved(md);
      // These bytes are on disk now, so the journal entry for them is spent.
      void getElectronAPI()?.draftSave?.({ path: filePath, name: fileName, content: "" });
      // ⌘S on a .csv keeps the first table and drops the rest, every time.
      // Only on a save the user asked for: repeating it every second while
      // they type would bury the banner in its own noise.
      const dropped = !autosave && isCSVName(fileName) ? csvDropsContent(md) : null;
      if (dropped?.drops) {
        setForkError(
          dropped.hasTable
            ? `Saved as CSV: ${dropped.droppedLines} line${dropped.droppedLines === 1 ? "" : "s"} outside the first table are not in that file.`
            : "Saved as CSV: this document has no table, so the file is empty."
        );
      }
      // Push the snapshot if this file is cloud-synced — except during a live
      // session, where peers saving would race the version counter into fake
      // conflicts; the Yjs update log is the source of truth while live.
      if (!collabCfg) {
        const push = await api.docPush?.({
          path: filePath,
          name: fileName ?? "untitled.md",
          content: diskContent,
        });
        // The file is on disk but not in the cloud. The Library shows the row
        // as "Not backed up", but nobody reads a return value: every caller of
        // handleSave discards it, so this used to be a backup that silently
        // never happened. Say it on the banner as well.
        // TODO(toast): move this to a toast once the toast system lands.
        if (push?.error) {
          setForkError(push.error);
          return push.error;
        }
      }
    }
    return null;
  }, [filePath, fileName, currentMarkdown, handleSaveAs, collabCfg, assessRichSafety, applyExternalDoc, markSaved]);

  // Autosave arms only where a write is provably safe: a real file to write,
  // the right to write it, no unresolved disk conflict, and either Source
  // (CodeMirror is byte-faithful) or a rich pipeline that has proved it can
  // reconstruct this document. "Not proved yet" counts as not safe.
  const autosaveEligible =
    filePath !== null &&
    docEditable &&
    diskChange === null &&
    !showDiskConflict &&
    (mode === "edit" || richArmed);
  const saveGuard = useSaveGuard({
    save: async () => (await handleSave({ autosave: true })) === null,
    eligible: autosaveEligible,
    docKey: filePath,
    document: { path: filePath, name: fileName, content, dirty: isDirty },
    booted,
  });
  useEffect(() => {
    saveGuardRef.current = saveGuard;
  }, [saveGuard]);

  // The one way a user edit reaches the buffer, and so the only thing that may
  // ever arm a write. Loads, pulls, and reloads go through the document hook's
  // other transitions and must never come through here.
  const editContent = useCallback(
    (md: EditInput) => {
      editDoc(md);
      saveGuard.noteEdit();
    },
    [editDoc, saveGuard]
  );

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
    const err = await handleFork();
    // Only a failure overwrites the banner. A copy that worked may already have
    // put a "saved as CSV, here is what it dropped" warning there, and clearing
    // it unconditionally was how that warning went unread.
    if (err) setForkError(err);
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

  const handleRename = useCallback(async (newName: string) => {
    const api = getElectronAPI();
    if (!api || !filePath || !newName.trim()) return;
    const res = await api.renameFile({
      oldPath: filePath,
      newName: newName.trim(),
    });
    if (res.success && res.path && res.name) {
      setLocation(res.path, res.name);
    }
  }, [filePath, setLocation]);

  // The web build has no main process to hold the window open, so the
  // browser's own prompt is the only net under an unsaved buffer.
  useEffect(() => {
    if (getElectronAPI()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (docRef.current.isDirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

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
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleOpenFile,
    handleSave,
    handleSaveAs,
    handleNewFile,
    selectView,
  ]);

  // Latest handlers, readable from once-registered IPC listeners
  // ⌘Z has to reach whichever editor the caret is in. Each keeps its own
  // history and none can undo the others, so the target is decided from focus.
  const runUndoRedo = useCallback(
    (direction: "undo" | "redo") => {
      const target = undoTargetFor(document.activeElement, {
        hasRich: !!richEditor,
        hasSource: !!sourceView,
      });
      if (target === "rich" && richEditor) {
        richEditor.chain().focus()[direction]().run();
      } else if (target === "source" && sourceView) {
        (direction === "undo" ? cmUndo : cmRedo)(sourceView);
        sourceView.focus();
      } else if (target === "native") {
        // A plain field: let the platform do what it already does well.
        document.execCommand(direction);
      }
    },
    [richEditor, sourceView]
  );

  // The IPC subscriptions below are installed once, so anything they compare
  // against has to be read through a ref rather than captured.
  const filePathRef = useRef<string | null>(null);
  useEffect(() => {
    filePathRef.current = filePath;
    // Follow the document that is actually open: Save As and Fork move it, and
    // a watcher left on the old path reports edits to a file nobody is reading.
    void getElectronAPI()?.watchFile?.(filePath)?.catch?.(() => {});
    // A different document cannot inherit the previous one's conflict.
    setDiskChange(null);
    setShowDiskConflict(false);
  }, [filePath]);

  // Take what is on disk, dropping the buffer. Used by the strip (where there
  // is nothing to drop) and by the dialog's explicit "discard mine".
  // fromDisk, because the disk text may be CSV or another to-disk format and
  // the buffer always holds markdown.
  const reloadFromDisk = useCallback(() => {
    if (diskChange === null) return;
    const md = fromDisk(fileName, diskChange);
    applyExternalDoc(md);
    assessRichSafety(md, docRef.current.filePath);
    setDiskChange(null);
    setShowDiskConflict(false);
  }, [diskChange, fileName, assessRichSafety, applyExternalDoc]);

  // Keep both: save the buffer under a new name and leave the changed file
  // alone. The only resolution that destroys nothing.
  const saveCopyOfMine = useCallback(
    async (suggestedName: string) => {
      const saved = await handleSaveAs(suggestedName);
      // A cancelled save sheet answers { canceled: true }, not success: the
      // conflict still stands and the dialog stays.
      if (!saved?.success) return;
      // Save As re-points the document, and the effect on filePath clears the
      // conflict and re-aims the watcher at the copy.
      setShowDiskConflict(false);
    },
    [handleSaveAs]
  );

  const handlersRef = useRef({
    openFile: handleOpenFile,
    newFile: handleNewFile,
    exportPDF: exportPDF,
    save: handleSave,
    saveAs: handleSaveAs,
    fork: handleMakeCopy,
    reveal: handleReveal,
    exportHTML: exportHTML,
    fileOpened: (data: FilePayload) => void loadFile(data),
    settle: settleDocument,
    undoRedo: (d: "undo" | "redo") => runUndoRedo(d),
    print: printDocument,
    zoom: (step: number) => {
      void step;
    },
  });
  useEffect(() => {
    // Kept current so the once-registered IPC listeners always call the latest
    // closures rather than the ones captured on first render.
    handlersRef.current.undoRedo = runUndoRedo;
    handlersRef.current.openFile = handleOpenFile;
    handlersRef.current.newFile = handleNewFile;
    handlersRef.current.save = handleSave;
    handlersRef.current.saveAs = handleSaveAs;
    handlersRef.current.fork = handleMakeCopy;
    handlersRef.current.reveal = handleReveal;
  }, [handleOpenFile, handleNewFile, handleSave, handleSaveAs, handleMakeCopy, handleReveal, runUndoRedo]);

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

  // Boot: decide the first painted document — the OS-opened file, the one-time
  // welcome document, or the sample — before rendering anything, so the wrong
  // doc never flashes
  useEffect(() => {
    const pending =
      getElectronAPI()?.getInitialFile?.() ?? Promise.resolve(null);
    pending
      .then(async (file) => {
        // A handler that answers with { error } instead of a payload must not
        // be mistaken for a file: loading it would blank the editor.
        //
        // Awaited so `booted` really does mean "the first document has landed":
        // draft recovery matches what it finds against the open path.
        if (file && typeof file.content === "string") {
          await loadFile(file);
        } else if (shouldShowWelcome({ openedFile: false })) {
          applyExternalDoc(WELCOME_DOC);
          assessRichSafety(WELCOME_DOC, null);
          markWelcomeSeen();
        } else {
          applyExternalDoc(SAMPLE);
          assessRichSafety(SAMPLE, null);
        }
      })
      // A rejected getInitialFile used to leave `booted` false forever, and
      // the pre-boot placeholder is an empty div: the app launched to a blank
      // window with no way out. The welcome document is a better answer than
      // nothing.
      .catch((err) => {
        console.error("Markie: couldn't read the file to open at launch", err);
        applyExternalDoc(SAMPLE);
        assessRichSafety(SAMPLE, null);
      })
      .finally(() => setBooted(true));
  }, [loadFile, assessRichSafety, applyExternalDoc]);

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
            void authStore.refresh(); // every auth-aware surface updates at once
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
        editContent((prev) => formatMarkdownTables(prev))
      ),
      api.onMenuFind?.(() => {
        setFindWithReplace(false);
        setShowFind(true);
      }),
      api.onMenuPrint?.(() => handlersRef.current.print()),
      api.onMenuZoom?.((step) => handlersRef.current.zoom(step)),
      api.onMenuUndo?.(() => handlersRef.current.undoRedo("undo")),
      api.onMenuRedo?.(() => handlersRef.current.undoRedo("redo")),
      api.onMenuFindReplace?.(() => {
        setFindWithReplace(true);
        setShowFind(true);
      }),
      api.onMenuHistory?.(() => setShowHistory(true)),
      api.onMenuSave?.(() => handlersRef.current.save()),
      api.onMenuSaveAs?.(() => handlersRef.current.saveAs()),
      api.onMenuFork?.(() => handlersRef.current.fork()),
      api.onMenuReveal?.(() => handlersRef.current.reveal()),
      api.onMenuExportHTML?.(() => handlersRef.current.exportHTML()),
      api.onFileOpened?.((data) => handlersRef.current.fileOpened(data)),
      // Main is holding the window open for us. Settle, then answer, and
      // answer even if settling threw: a renderer that never replies just
      // makes the user wait out the two second cap.
      api.onAppWillClose?.(() => {
        void (async () => {
          try {
            await handlersRef.current.settle();
          } finally {
            getElectronAPI()?.appCloseReady?.();
          }
        })();
      }),
      api.onFileChangedOnDisk?.((data) => {
        // Ignore a change to a file we are no longer showing: the watcher can
        // fire once more between opening a new document and re-pointing.
        if (data.path !== filePathRef.current) return;
        setDiskChange(data.content);
      }),
    ];
    return () => offs.forEach((off) => off?.());
  }, [selectView, editContent]);

  const commands = useMemo<AppCommand[]>(
    () => [
      { id: "open", title: "Open File…", group: "File", shortcut: "⌘O", run: handleOpenFile },
      { id: "save", title: "Save", group: "File", shortcut: "⌘S", run: handleSave },
      { id: "save-as", title: "Save As…", group: "File", shortcut: "⇧⌘S", run: () => handleSaveAs() },
      { id: "fork", title: "Duplicate (Fork)", group: "File", shortcut: "⇧⌘D", keywords: "copy fork duplicate", run: handleMakeCopy },
      { id: "reveal", title: revealLabel, group: "File", shortcut: "⌥⌘R", keywords: "finder explorer folder show reveal drag locate", run: handleReveal },
      { id: "export-pdf-dark", title: "Export PDF (Dark)", group: "File", shortcut: "⇧⌘E", keywords: "print", run: () => exportPDF("dark") },
      { id: "export-pdf-light", title: "Export PDF (Light)", group: "File", keywords: "print", run: () => exportPDF("light") },
      { id: "export-html", title: "Export HTML", group: "File", run: exportHTML },
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
      { id: "format-tables", title: "Format Tables", group: "Format", shortcut: "⌥⌘T", keywords: "align prettify pipes", run: () => editContent((prev) => formatMarkdownTables(prev)) },
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
      { id: "library", title: "Library…", group: "File", shortcut: "⌘L", keywords: "documents cloud sync files recent projects organize workspace group", run: () => selectView("library") },
      { id: "browse", title: "Browse all markdown…", group: "File", keywords: "all files device skills index find", run: () => selectView("browse") },
      { id: "skills", title: "Skills & agent files…", group: "File", keywords: "claude agents codex gemini cursor instructions", run: () => selectView("skills") },
      { id: "new-file", title: "New file", group: "File", shortcut: "⌘N", keywords: "blank create empty document", run: handleNewFile },
      // Ungated on purpose: this used to vanish from the palette exactly when
      // the user could not work out how to share, which is when they search for
      // it. ShareGate explains whatever is missing.
      { id: "share", title: "Share…", group: "File", keywords: "collaborate invite live people sync cloud link", run: () => setShowShare(true) },
      { id: "history", title: "History…", group: "File", keywords: "versions restore snapshot revert previous", run: () => setShowHistory(true) },
      { id: "shortcuts", title: "Keyboard Shortcuts", group: "Help", shortcut: "⌘/", keywords: "help keys", run: () => setShowHelp((v) => !v) },
    ],
    [
      handleOpenFile,
      handleSave,
      handleSaveAs,
      handleMakeCopy,
      handleReveal,
      revealLabel,
      exportPDF,
      exportHTML,
      handleNewFile,
      selectView,
      editContent,
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

  // Appearance follows the document, so opening a different file does not
  // inherit the last one's font. Keyed by path where there is one, since that
  // survives a re-sync.
  const appearanceStore = appearanceKey(filePath ?? fileName);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(appearanceStore);
      setAppearance(normalizeAppearance(raw ? JSON.parse(raw) : null));
    } catch {
      // Unreadable or absent: the default is a perfectly good answer.
      setAppearance(DEFAULT_APPEARANCE);
    }
  }, [appearanceStore]);

  const changeAppearance = useCallback(
    (next: DocAppearance) => {
      const clean = normalizeAppearance(next);
      setAppearance(clean);
      try {
        window.localStorage.setItem(appearanceStore, JSON.stringify(clean));
      } catch {
        // Out of quota or private mode: it still applies for this session.
      }
    },
    [appearanceStore]
  );

  // ⌘+ / ⌘- / ⌘0 are the same document zoom the toolbar shows a percentage
  // for, so the menu and the toolbar always report one number. Deliberately
  // not Electron's { role: "zoomIn" }, which scales the entire interface.
  const handleZoom = useCallback(
    (step: number) => {
      // 0 means "actual size"; anything else is one step in that direction.
      setAppearance((prev) => {
        const next = normalizeAppearance({
          ...prev,
          zoom:
            step === 0
              ? DEFAULT_APPEARANCE.zoom
              : stepZoom(prev.zoom, step > 0 ? 1 : -1),
        });
        try {
          window.localStorage.setItem(appearanceStore, JSON.stringify(next));
        } catch {
          // Out of quota or private mode: it still applies for this session.
        }
        return next;
      });
    },
    [appearanceStore]
  );

  // Zoom is declared after the IPC handlers are registered, so it is the one
  // that still has to be kept current here.
  useEffect(() => {
    handlersRef.current.zoom = handleZoom;
  }, [handleZoom]);


  if (!booted) {
    return <div className="h-screen bg-background" />;
  }

  // One resolution, every consumer: the banner, the rich pane, and the source
  // pane all read the same answer instead of each deciding for itself.
  const shareBanner = shareBannerFor(roleState, sharedBy);

  // One answer for what the left edge is showing, read by the panel, the
  // formatting rail and the activity bar alike.
  const leftState = {
    view: leftView,
    panelOpen: showLibrary,
    richVisible: mode === "preview" || mode === "split",
    canEdit: docEditable,
  };

  return (
    <div className="markie-shell h-screen flex flex-col bg-background relative">
      <Toolbar
        mode={mode}
        onModeChange={setMode}
        onOpenFile={handleOpenFile}
        onExportPDF={exportPDF}
        onSaveAs={() => handleSaveAs()}
        onExportHTML={exportHTML}
        exporting={exporting}
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
          canFormat={mode === "preview" || mode === "split"}
          onNewFile={handleNewFile}
          onAgents={() => setShowAgents(true)}
          onShortcuts={() => setShowHelp((v) => !v)}
          onAccount={() => setShowSettings(true)}
        />

        {/* Docked side panel (Library / Browse / Shared / Skills) */}
        {showSidePanel(leftState) && isPanelView(leftView) && (
          <Library
            key={leftView}
            view={leftView}
            onClose={() => setShowLibrary(false)}
            onOpenPath={openPath}
            onOpenFile={handleOpenFile}
            onAddPaths={addPaths}
            onSignIn={() => setSignInReason("sync")}
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
            onDismissError={() => setForkError(null)}
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

          {/* Unsaved work from a session that ended badly. Offered once, above
              the document, and only for the document that is open. */}
          {saveGuard.recovered && (
            <DraftStrip
              savedAt={saveGuard.recovered.savedAt}
              onRestore={() => {
                const entry = saveGuard.recovered;
                if (!entry) return;
                saveGuard.acceptRecovered();
                void loadFile({
                  name: entry.name ?? "untitled.md",
                  content: entry.content,
                  path: entry.path,
                  unsaved: true,
                });
              }}
              onDiscard={saveGuard.discardRecovered}
            />
          )}

          {/* Something else edited this file. With a clean buffer the reload
              cannot cost anything, so it is a strip; with unsaved work it is a
              real decision and opens the dialog. */}
          {diskChange !== null && (
            <DiskChangeStrip
              fileName={fileName ?? "This document"}
              onReload={() =>
                diskChangeKind(isDirty) === "clean"
                  ? reloadFromDisk()
                  : setShowDiskConflict(true)
              }
            />
          )}

          {/* The formatting row, above the document and below the app chrome,
              where every editor puts it. */}
          <DocToolbar
            editor={richEditor}
            appearance={appearance}
            onAppearance={changeAppearance}
            onPrint={printDocument}
            onHistory={filePath ? () => setShowHistory(true) : undefined}
            canEdit={docEditable}
          />

          <div
            data-markie-document-area
            style={appearanceVars(appearance) as React.CSSProperties}
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
                    onChange={editContent}
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
                {showFormatRail(leftState) && (
                  <FormatRail editor={richEditor} disabled={formatRailDisabled(leftState)} />
                )}
                <div className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
                  {richBlocked && !collabCfg && (
                    <RichLossBanner
                      risks={richLossy ?? []}
                      onEditSource={() => setMode("edit")}
                      onOverride={overrideRichSafety}
                    />
                  )}
                  {richPreparing && !collabCfg && <RichPreparingNote />}
                  <div className="flex-1 min-h-0">
                  <ErrorBoundary
                    fallback={(_error, reset) => (
                      <RichPaneError
                        onSwitchToSource={() => {
                          reset();
                          setMode("edit");
                        }}
                        onReload={() => window.location.reload()}
                      />
                    )}
                  >
                    <RichView
                      key={
                        collabCfg
                          ? `live:${collabCfg.docId}:${collabCfg.readonly}:${tokenTag(collabCfg.token)}`
                          : "solo"
                      }
                      value={content}
                      onChange={editContent}
                      onEditorReady={setRichEditor}
                      collab={collabCfg}
                      readOnly={!docEditable || !richArmed}
                      canModerate={roleState === "owner"}
                      onPeersChange={handlePeersChange}
                      onCollabStatus={handleCollabStatus}
                      onFlushReady={handleFlushReady}
                    />
                  </ErrorBoundary>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mounted on first open and kept mounted: unmounting the panel kills its
          shells, so "Hide terminal" used to end every running command. Hidden
          with display:none instead; `contents` keeps the visible panel laid out
          exactly as if the wrapper were not there. */}
      {TERMINAL_ENABLED && terminalMounted && (
        <div className={showTerminal ? "contents" : "hidden"}>
          <TerminalPanel
            context={{
              cwd: filePath ? pathDirname(filePath) : null,
              filePath,
            }}
            onClose={() => setShowTerminal(false)}
          />
        </div>
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
          initialSection="appearance"
          onClose={() => {
            setShowTheme(false);
            setLibRefreshKey((k) => k + 1);
            refreshCollab(); // sign-in/out changes live eligibility
          }}
        />
      )}
      {showSettings && (
        <Settings
          onClose={() => {
            setShowSettings(false);
            setLibRefreshKey((k) => k + 1);
            refreshCollab(); // sign-in/out changes live eligibility
          }}
        />
      )}
      {signInReason && (
        <SignInDialog
          reason={signInReason}
          onClose={() => setSignInReason(null)}
          onDone={() => {
            setLibRefreshKey((k) => k + 1); // cloud files can be listed now
            refreshCollab(); // sign-in changes live eligibility
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
        />
      )}
      {showDiskConflict && diskChange !== null && (
        <DiskConflictDialog
          fileName={fileName ?? "This document"}
          // Compare disk-form to disk-form: the buffer holds markdown, the
          // file may be CSV or another to-disk format.
          localContent={toDisk(fileName, currentMarkdown())}
          diskContent={diskChange}
          onClose={() => setShowDiskConflict(false)}
          onSaveCopy={saveCopyOfMine}
          onOverwrite={() => {
            // Keep the buffer and let the normal save run; force skips the
            // save-time prompt for the question the dialog just answered.
            setDiskChange(null);
            setShowDiskConflict(false);
            void handlersRef.current.save({ force: true });
          }}
          onDiscardMine={reloadFromDisk}
        />
      )}
      {showConflict && filePath && (
        <ConflictDialog
          // The dialog resolves its diff once, on mount. Without a key per
          // document it kept showing the first file it was ever opened for.
          key={filePath ?? "none"}
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

      {showHistory && filePath && (
        <HistoryDialog
          filePath={filePath}
          fileName={fileName ?? "this document"}
          onClose={() => setShowHistory(false)}
          onRestore={(versionContent) => {
            setShowHistory(false);
            // Loaded as unsaved, never written: reading history must not be
            // able to cost anyone the document they were looking at.
            void loadFile({
              name: fileName ?? "untitled.md",
              content: versionContent,
              path: filePath,
              unsaved: true,
            });
          }}
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
