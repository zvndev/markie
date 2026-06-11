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
  const [richEditor, setRichEditor] = useState<TipTapEditor | null>(null);

  const isDirty = content !== savedContent;

  const loadFile = useCallback(
    (data: { name: string; content: string; path: string | null }) => {
      const md = fromDisk(data.name, data.content);
      setContent(md);
      setFileName(data.name);
      setFilePath(data.path);
      setSavedContent(md);
    },
    []
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
    const res = await api.saveFile({
      filePath,
      content: toDisk(fileName, content),
    });
    if (res.success) setSavedContent(content);
  }, [filePath, fileName, content, handleSaveAs]);

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
  }, [loadFile]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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

  // Apply the persisted theme before first paint of the booted UI
  useEffect(() => {
    const store = loadThemeStore();
    applyTheme(findTheme(store, store.activeId).tokens);
  }, []);

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

  // Listen for Electron IPC events — registered exactly once
  useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    api.onMenuOpenFile?.(() => handlersRef.current.openFile());
    api.onMenuExportPDF?.((theme) => handlersRef.current.exportPDF(theme ?? "dark"));
    api.onSetMode?.((m) => setMode(m));
    api.onToggleStats?.(() => setShowStats((s) => !s));
    api.onMenuCommandPalette?.(() => setShowPalette((v) => !v));
    api.onMenuShortcuts?.(() => setShowHelp((v) => !v));
    api.onMenuTheme?.(() => setShowTheme((v) => !v));
    api.onMenuFormatTables?.(() =>
      setContent((prev) => formatMarkdownTables(prev))
    );
    api.onMenuSave?.(() => handlersRef.current.save());
    api.onMenuSaveAs?.(() => handlersRef.current.saveAs());
    api.onMenuFork?.(() => handlersRef.current.fork());
    api.onMenuExportHTML?.(() => handlersRef.current.exportHTML());
    api.onFileOpened?.((data) => handlersRef.current.fileOpened(data));
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
        },
      })),
      { id: "theme-settings", title: "Theme Settings…", group: "Theme", keywords: "color font preset style", run: () => setShowTheme(true) },
      { id: "shortcuts", title: "Keyboard Shortcuts", group: "Help", shortcut: "⌘/", keywords: "help keys", run: () => setShowHelp((v) => !v) },
    ],
    [handleOpenFile, handleSave, handleSaveAs, handleFork, handleExportPDF, handleExportHTML]
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
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Editor pane */}
        {(mode === "edit" || mode === "split") && (
          <div
            className={`${
              mode === "split" ? "w-1/2 border-r border-border" : "w-full"
            } h-full overflow-hidden`}
          >
            <Editor value={content} onChange={setContent} />
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
                value={content}
                onChange={setContent}
                onEditorReady={setRichEditor}
              />
            </div>
          </div>
        )}
      </div>

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
