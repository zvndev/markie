"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Toolbar } from "@/components/toolbar";
import { Editor } from "@/components/editor";
import { Preview } from "@/components/preview";
import { buildPDFHTML, type PDFTheme } from "@/lib/pdf-styles";

const SAMPLE = `# Welcome to Marker

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
  const [content, setContent] = useState(SAMPLE);
  const [mode, setMode] = useState<ViewMode>("split");
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const previewRef = useRef<HTMLElement>(null);

  const wordCount = content.trim()
    ? content.trim().split(/\s+/).length
    : 0;
  const charCount = content.length;

  const handleOpenFile = useCallback(() => {
    if (typeof window !== "undefined" && (window as any).electronAPI) {
      (window as any).electronAPI.openFile().then((result: { name: string; content: string } | null) => {
        if (result) {
          setContent(result.content);
          setFileName(result.name);
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
    };
    input.click();
  }, []);

  const getPreviewHTML = useCallback((): string => {
    if (previewRef.current) {
      return previewRef.current.innerHTML;
    }
    // Fallback: if ref not available, return raw content
    return `<pre>${content}</pre>`;
  }, [content]);

  const handleExportPDF = useCallback((theme: PDFTheme) => {
    const html = getPreviewHTML();
    const fullHTML = buildPDFHTML(html, theme);

    // In Electron, send HTML to main process for printToPDF
    if (typeof window !== "undefined" && (window as any).electronAPI) {
      (window as any).electronAPI.exportPDF(fullHTML);
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
            setMode("edit");
            break;
          case "2":
            e.preventDefault();
            setMode("split");
            break;
          case "3":
            e.preventDefault();
            setMode("preview");
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
  }, [handleOpenFile, handleExportPDF]);

  // Listen for Electron IPC events
  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).electronAPI) return;

    const api = (window as any).electronAPI;
    api.onMenuOpenFile?.(() => handleOpenFile());
    api.onMenuExportPDF?.(() => handleExportPDF("dark"));
    api.onSetMode?.((m: ViewMode) => setMode(m));
    api.onFileOpened?.((data: { name: string; content: string }) => {
      setContent(data.content);
      setFileName(data.name);
    });
  }, [handleOpenFile, handleExportPDF]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <Toolbar
        mode={mode}
        onModeChange={setMode}
        onOpenFile={handleOpenFile}
        onExportPDF={handleExportPDF}
        fileName={fileName}
        charCount={charCount}
        wordCount={wordCount}
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
