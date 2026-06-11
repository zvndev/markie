"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Toolbar } from "@/components/toolbar";
import { Editor } from "@/components/editor";
import { Preview } from "@/components/preview";
import { StatsPanel } from "@/components/stats-panel";
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

export default function Home() {
  const [content, setContent] = useState("");
  const [booted, setBooted] = useState(false);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const previewRef = useRef<HTMLElement>(null);

  const isDirty = content !== savedContent;

  const handleOpenFile = useCallback(() => {
    const api = getElectronAPI();
    if (api) {
      api.openFile().then((result) => {
        if (result) {
          setContent(result.content);
          setFileName(result.name);
          setFilePath(result.path);
          setSavedContent(result.content);
        }
      });
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.mdx,.txt";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      setContent(text);
      setFileName(file.name);
      setFilePath(null);
      setSavedContent(text);
    };
    input.click();
  }, []);

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
    const res = await api.saveFileAs({
      defaultName: defaultName ?? fileName ?? "untitled.md",
      content,
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
    const res = await api.saveFile({ filePath, content });
    if (res.success) setSavedContent(content);
  }, [filePath, content, handleSaveAs]);

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
      setContent(text);
      setFileName(file.name);
      setFilePath(null);
      setSavedContent(text);
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

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
    fileOpened: (data: FilePayload) => {
      setContent(data.content);
      setFileName(data.name);
      setFilePath(data.path);
      setSavedContent(data.content);
    },
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

  // Boot: decide the first painted document — the OS-opened file or the
  // welcome sample — before rendering anything, so the wrong doc never flashes
  useEffect(() => {
    const pending =
      getElectronAPI()?.getInitialFile?.() ?? Promise.resolve(null);
    pending.then((file) => {
      if (file) {
        setContent(file.content);
        setFileName(file.name);
        setFilePath(file.path);
        setSavedContent(file.content);
      } else {
        setContent(SAMPLE);
        setSavedContent(SAMPLE);
      }
      setBooted(true);
    });
  }, []);

  // Listen for Electron IPC events — registered exactly once
  useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    api.onMenuOpenFile?.(() => handlersRef.current.openFile());
    api.onMenuExportPDF?.((theme) => handlersRef.current.exportPDF(theme ?? "dark"));
    api.onSetMode?.((m) => setMode(m));
    api.onToggleStats?.(() => setShowStats((s) => !s));
    api.onMenuSave?.(() => handlersRef.current.save());
    api.onMenuSaveAs?.(() => handlersRef.current.saveAs());
    api.onMenuFork?.(() => handlersRef.current.fork());
    api.onMenuExportHTML?.(() => handlersRef.current.exportHTML());
    api.onFileOpened?.((data) => handlersRef.current.fileOpened(data));
  }, []);

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

        {/* Preview pane */}
        {(mode === "preview" || mode === "split") && (
          <div
            className={`${
              mode === "split" ? "w-1/2" : "w-full"
            } h-full overflow-hidden`}
          >
            <Preview ref={previewRef} content={content} />
          </div>
        )}
      </div>

      {showStats && (
        <StatsPanel content={content} onClose={() => setShowStats(false)} />
      )}

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
