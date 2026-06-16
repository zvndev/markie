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
import { ThemeSettings } from "@/components/theme-settings";
import { Settings } from "@/components/settings";
import { Library } from "@/components/library";
import { ActivityBar, type LeftView } from "@/components/activity-bar";
import { ShareDialog } from "@/components/share-dialog";
import { AgentsDialog } from "@/components/agents-dialog";
import { UpdateToast } from "@/components/update-toast";
import { TerminalPanel } from "@/components/terminal-panel";
import { TERMINAL_ENABLED } from "@/lib/features";
import {
  applyColorMode,
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
import { colorForName, type CollabConfig, type PeerUser } from "@/lib/collab";
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
import { getElectronAPI, type FilePayload } from "@/lib/electron";
import { renderMarkdownHTML } from "@/lib/markdown-html";

const SAMPLE = `# Welcome to Markie

A beautiful markdown viewer and editor. Start writing, paste content, or open a file.

## Features

- **Live preview** — See your markdown rendered in real-time
- **Syntax highlighting** — Code blocks with full language support
- **GFM support** — Tables, task lists, strikethrough, and more
- **Math rendering** — LaTeX via KaTeX: $E = mc^2$
- **Dark theme** — Easy on the eyes

## Code Example

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const message = greet("World");
console.log(message);
\`\`\`

## Table

| Feature | Status |
|---------|--------|
| Markdown parsing | ✅ Done |
| Syntax highlighting | ✅ Done |
| File open | ✅ Done |
| Export | ✅ Done |

## Task List

- [x] Set up project
- [x] Build editor
- [x] Build preview
- [x] PDF export (light + dark)

> "The best way to predict the future is to invent it." — Alan Kay

---

Start editing to see changes live!
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
  leftViewRef.current = leftView;
  const [showTerminal, setShowTerminal] = useState(false);
  const [richEditor, setRichEditor] = useState<TipTapEditor | null>(null);
  // bumps when auth changes out-of-band (deep-link sign-in) so account UI refreshes
  const [authNonce, setAuthNonce] = useState(0);
  // bumps to refresh the Library panel (file opened/saved, sync changed)
  const [libRefreshKey, setLibRefreshKey] = useState(0);
  const [showShare, setShowShare] = useState(false);
  const [cloudId, setCloudId] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  // Manage sharing on an arbitrary owned doc (from the Shared → "by me" tab),
  // independent of whichever doc is currently open.
  const [manageShare, setManageShare] = useState<{ docId: string; name: string } | null>(null);
  const [showAgents, setShowAgents] = useState(false);
  const [collabCfg, setCollabCfg] = useState<CollabConfig | null>(null);
  const [peers, setPeers] = useState<PeerUser[]>([]);
  const [liveStatus, setLiveStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");
  // Owner-pinned theme on the open shared doc (non-owners only)
  const [enforcedTheme, setEnforcedTheme] = useState<ThemeTokens | null>(null);

  const isDirty = content !== savedContent;

  // Latest open-doc path + content, read by palette command closures without
  // rebuilding the command list on every keystroke.
  const docRef = useRef({ filePath, content });
  useEffect(() => {
    docRef.current = { filePath, content };
  }, [filePath, content]);

  // A doc goes live when it's cloud-synced, we're signed in, and at least one
  // other person has been invited. Re-checked on file open, sign-in changes,
  // sync changes, and share-list changes.
  const refreshCollab = useCallback(() => {
    const api = getElectronAPI();
    const entryPromise =
      api?.registryGet && filePath
        ? api.registryGet(filePath)
        : Promise.resolve(null);
    entryPromise.then(async (entry) => {
      const cid = entry?.cloud_doc_id ?? null;
      const token = getAuthToken();
      setCloudId(cid);
      setCanShare(!!cid && !!token);
      if (!cid || !token) {
        setCollabCfg(null);
        setEnforcedTheme(null);
        return;
      }
      const me = await authClient.me();
      const members = me ? await sharesClient.list(cid) : null;
      if (!me || !members || members.length === 0) {
        setCollabCfg(null);
        setEnforcedTheme(null);
        return;
      }
      const mine = members.find((m) => m.user_id === me.id);
      // Members read with the owner's pinned theme when one is set;
      // the owner always keeps their own live theme
      if (mine) {
        getDocTheme(cid).then(setEnforcedTheme);
      } else {
        setEnforcedTheme(null);
      }
      const readonly = mine?.role === "viewer";
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

  // Share entry point that works from anywhere: open the dialog if the doc is
  // already shareable, otherwise guide the user through the prerequisites
  // (sign in, then sync this file to the cloud).
  const handleShareClick = useCallback(() => {
    if (canShare) {
      setShowShare(true);
      return;
    }
    if (!getAuthToken()) {
      setShowSettings(true); // need to sign in first
      return;
    }
    // signed in — open the Library so they can sync this file, then share
    setLeftView("library");
    setShowLibrary(true);
  }, [canShare]);

  // Open the share dialog to manage people on a doc I own (Shared → "by me").
  const handleManageShare = useCallback((docId: string, name: string) => {
    setManageShare({ docId, name });
  }, []);

  // Left rail: select a side-panel view. Clicking the active view closes it.
  const selectView = useCallback((v: LeftView) => {
    setShowLibrary((open) => !(open && leftViewRef.current === v));
    setLeftView(v);
  }, []);

  // Start a fresh, unsaved markdown doc.
  const handleNewFile = useCallback(() => {
    setContent("");
    setSavedContent("");
    setFileName(null);
    setFilePath(null);
    setCloudId(null);
    setCanShare(false);
  }, []);

  const handlePeersChange = useCallback((p: PeerUser[]) => setPeers(p), []);
  const handleCollabStatus = useCallback(
    (s: "connecting" | "connected" | "disconnected") => setLiveStatus(s),
    []
  );

  const loadFile = useCallback(
    (data: { name: string; content: string; path: string | null }) => {
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
    []
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
      api.openFile().then((result) => {
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

  const handleSaveAs = useCallback(async (defaultName?: string) => {
    const api = getElectronAPI();
    if (!api) return;
    const name = defaultName ?? fileName ?? "untitled.md";
    const res = await api.saveFileAs({
      defaultName: name,
      content: toDisk(name, content),
    });
    if (res.success && res.path && res.name) {
      setFilePath(res.path);
      setFileName(res.name);
      setSavedContent(content);
    }
  }, [fileName, content]);

  const handleSave = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    if (!filePath) {
      await handleSaveAs();
      return;
    }
    const diskContent = toDisk(fileName, content);
    const res = await api.saveFile({ filePath, content: diskContent });
    if (res.success) {
      setSavedContent(content);
      // Push the snapshot if this file is cloud-synced — except during a live
      // session, where peers saving would race the version counter into fake
      // conflicts; the Yjs update log is the source of truth while live.
      if (!collabCfg) {
        api.docPush?.({
          path: filePath,
          name: fileName ?? "untitled.md",
          content: diskContent,
        });
      }
    }
  }, [filePath, fileName, content, handleSaveAs, collabCfg]);

  const handleFork = useCallback(async () => {
    const base = fileName ?? "untitled.md";
    const forkName = base.includes(".")
      ? base.replace(/(\.[^.]+)$/, " copy$1")
      : `${base} copy`;
    await handleSaveAs(forkName);
  }, [fileName, handleSaveAs]);

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
  }, [handleOpenFile, handleExportPDF, handleSave, handleSaveAs]);

  // Latest handlers, readable from once-registered IPC listeners
  const handlersRef = useRef({
    openFile: handleOpenFile,
    exportPDF: handleExportPDF,
    save: handleSave,
    saveAs: handleSaveAs,
    fork: handleFork,
    exportHTML: handleExportHTML,
    fileOpened: (data: FilePayload) => loadFile(data),
  });
  useEffect(() => {
    handlersRef.current.openFile = handleOpenFile;
    handlersRef.current.exportPDF = handleExportPDF;
    handlersRef.current.save = handleSave;
    handlersRef.current.saveAs = handleSaveAs;
    handlersRef.current.fork = handleFork;
    handlersRef.current.exportHTML = handleExportHTML;
  }, [
    handleOpenFile,
    handleExportPDF,
    handleSave,
    handleSaveAs,
    handleFork,
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
        // markie://auth?token=... — Google sign-in returning via the bridge
        try {
          const u = new URL(url);
          const token = u.searchParams.get("token");
          if (u.host === "auth" && token) {
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
      api.onMenuSave?.(() => handlersRef.current.save()),
      api.onMenuSaveAs?.(() => handlersRef.current.saveAs()),
      api.onMenuFork?.(() => handlersRef.current.fork()),
      api.onMenuExportHTML?.(() => handlersRef.current.exportHTML()),
      api.onFileOpened?.((data) => handlersRef.current.fileOpened(data)),
    ];
    return () => offs.forEach((off) => off?.());
  }, []);

  const commands = useMemo<AppCommand[]>(
    () => [
      { id: "open", title: "Open File…", group: "File", shortcut: "⌘O", run: handleOpenFile },
      { id: "save", title: "Save", group: "File", shortcut: "⌘S", run: handleSave },
      { id: "save-as", title: "Save As…", group: "File", shortcut: "⇧⌘S", run: () => handleSaveAs() },
      { id: "fork", title: "Duplicate (Fork)", group: "File", shortcut: "⇧⌘D", keywords: "copy fork duplicate", run: handleFork },
      { id: "export-pdf-dark", title: "Export PDF (Dark)", group: "File", shortcut: "⇧⌘E", keywords: "print", run: () => handleExportPDF("dark") },
      { id: "export-pdf-light", title: "Export PDF (Light)", group: "File", keywords: "print", run: () => handleExportPDF("light") },
      { id: "export-html", title: "Export HTML", group: "File", run: handleExportHTML },
      { id: "mode-view", title: "View Mode", group: "View", shortcut: "⌘1", keywords: "preview rich", run: () => setMode("preview") },
      { id: "mode-edit", title: "Edit Mode", group: "View", shortcut: "⌘2", keywords: "source raw markdown", run: () => setMode("edit") },
      { id: "mode-split", title: "Split Mode", group: "View", shortcut: "⌘3", run: () => setMode("split") },
      { id: "stats", title: "Statistics", group: "View", shortcut: "⇧⌘I", keywords: "words count reading", run: () => setShowStats((v) => !v) },
      { id: "palette", title: "Command Palette", group: "View", shortcut: "⌘K", run: () => setShowPalette((v) => !v) },
      ...(TERMINAL_ENABLED ? [{ id: "terminal", title: "Toggle Terminal", group: "View", shortcut: "⌃`", keywords: "shell console zsh bash", run: () => setShowTerminal((v) => !v) }] as AppCommand[] : []),
      { id: "copy-path", title: "Copy File Path", group: "File", keywords: "link location terminal clipboard", run: () => { const p = docRef.current.filePath; if (p) navigator.clipboard.writeText(p); } },
      { id: "copy-content", title: "Copy Document Contents", group: "File", keywords: "clipboard markdown text", run: () => navigator.clipboard.writeText(docRef.current.content) },
      { id: "format-tables", title: "Format Tables", group: "Format", shortcut: "⌥⌘T", keywords: "align prettify pipes", run: () => setContent((prev) => formatMarkdownTables(prev)) },
      ...BUILT_IN_THEMES.map((t) => ({
        id: `theme-${t.id}`,
        title: `Theme: ${t.name}`,
        group: "Theme" as const,
        keywords: "dark light color style",
        run: () => {
          const store = loadThemeStore();
          saveThemeStore({ ...store, activeId: t.id });
          applyTheme(t.tokens);
          pushCloudThemes();
        },
      })),
      { id: "theme-settings", title: "Theme Settings…", group: "Theme", keywords: "color font preset style", run: () => setShowTheme(true) },
      { id: "settings", title: "Settings…", group: "File", shortcut: "⌘,", keywords: "account sign in sync login", run: () => setShowSettings(true) },
      { id: "library", title: "Library…", group: "File", shortcut: "⌘L", keywords: "documents cloud sync files recent", run: () => selectView("library") },
      { id: "browse", title: "Browse all markdown…", group: "File", keywords: "all files device skills index find", run: () => selectView("browse") },
      { id: "skills", title: "Skills & agent files…", group: "File", keywords: "claude agents codex gemini cursor instructions", run: () => selectView("skills") },
      { id: "new-file", title: "New file", group: "File", shortcut: "⌘N", keywords: "blank create empty document", run: handleNewFile },
      ...(canShare
        ? [{ id: "share", title: "Share…", group: "File" as const, keywords: "collaborate invite live people", run: () => setShowShare(true) }]
        : []),
      { id: "shortcuts", title: "Keyboard Shortcuts", group: "Help", shortcut: "⌘/", keywords: "help keys", run: () => setShowHelp((v) => !v) },
    ],
    [handleOpenFile, handleSave, handleSaveAs, handleFork, handleExportPDF, handleExportHTML, canShare]
  );

  if (!booted) {
    return <div className="h-screen bg-background" />;
  }

  return (
    <div className="h-screen flex flex-col bg-background relative">
      <Toolbar
        mode={mode}
        onModeChange={setMode}
        onOpenFile={handleOpenFile}
        onExportPDF={handleExportPDF}
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

      <div className="flex-1 flex overflow-hidden">
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
            view={leftView}
            onClose={() => setShowLibrary(false)}
            onOpenPath={openPath}
            onOpenFile={handleOpenFile}
            onAddPaths={addPaths}
            onSignIn={() => setShowSettings(true)}
            onManageShare={handleManageShare}
            activePath={filePath}
            refreshKey={libRefreshKey}
          />
        )}

        {/* Editor pane */}
        {(mode === "edit" || mode === "split") && (
          <div
            className={`${
              mode === "split" ? "w-1/2 border-r border-border" : "w-full"
            } h-full overflow-hidden flex flex-col`}
          >
            {collabCfg && (
              <div className="px-3 py-1 text-[11px] text-muted bg-surface border-b border-border shrink-0">
                Live session — source is read-only, edit in View
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              <Editor
                value={content}
                onChange={setContent}
                readOnly={!!collabCfg}
              />
            </div>
          </div>
        )}

        {/* Rich View pane with format rail */}
        {(mode === "preview" || mode === "split") && (
          <div
            className={`${
              mode === "split" ? "w-1/2" : "w-full"
            } h-full overflow-hidden flex`}
          >
            <FormatRail editor={richEditor} />
            <div className="flex-1 h-full overflow-hidden">
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
                onPeersChange={handlePeersChange}
                onCollabStatus={handleCollabStatus}
              />
            </div>
          </div>
        )}
      </div>

      {TERMINAL_ENABLED && showTerminal && (
        <TerminalPanel
          cwd={filePath ? filePath.slice(0, filePath.lastIndexOf("/")) || null : null}
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
      {showTheme && <ThemeSettings onClose={() => setShowTheme(false)} />}
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
      {showShare && cloudId && (
        <ShareDialog
          key={cloudId}
          docId={cloudId}
          fileName={fileName ?? "Untitled"}
          onClose={() => setShowShare(false)}
          onChanged={refreshCollab}
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
