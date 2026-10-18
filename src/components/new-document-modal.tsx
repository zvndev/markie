import { useEffect, useRef } from "react";
import type { EditableDocumentFormat } from "@/lib/document-session";

// Every type a person can start from blank. Legacy .doc and HTML are absent
// on purpose: Markie has no native DOC writer and no rich HTML editor, so
// offering them here would promise a file it cannot honestly create.
export const NEW_DOCUMENT_TYPES: ReadonlyArray<{
  format: EditableDocumentFormat;
  label: string;
  extension: string;
  description: string;
}> = [
  { format: "markdown", label: "Markdown", extension: ".md", description: "Notes and docs with rich and source views" },
  { format: "docx", label: "Word", extension: ".docx", description: "A Word document, edited in its original format" },
  { format: "rtf", label: "Rich Text", extension: ".rtf", description: "Formatted text that opens in most word processors" },
  { format: "odt", label: "OpenDocument", extension: ".odt", description: "The open word-processor format used by LibreOffice" },
  { format: "text", label: "Plain Text", extension: ".txt", description: "Literal text, exactly as written" },
  { format: "darkmown", label: "Darkmown", extension: ".wd", description: "Interactive notes with state and controls" },
  { format: "csv", label: "CSV", extension: ".csv", description: "Comma-separated values with a table preview" },
  { format: "json", label: "JSON", extension: ".json", description: "Structured data as literal source" },
  { format: "yaml", label: "YAML", extension: ".yaml", description: "Configuration and data as literal source" },
  { format: "xml", label: "XML", extension: ".xml", description: "Markup data as literal source" },
];

const ARIA_LABEL: Partial<Record<EditableDocumentFormat, string>> = {
  markdown: "New Markdown document",
  docx: "New Word document",
  text: "New text document",
};

export function NewDocumentModal({ onCreate, onClose }: {
  onCreate: (format: EditableDocumentFormat) => void;
  onClose: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prior = document.activeElement;
    first.current?.focus();
    return () => {
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="New document"
        className="w-full max-w-md rounded-xl border border-border bg-surface p-4 shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        }}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-medium text-foreground">New document</h2>
            <p className="mt-0.5 text-[12px] text-muted">Choose a file type to start writing.</p>
          </div>
          <button
            type="button"
            aria-label="Cancel new document"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]"
          >
            ×
          </button>
        </div>
        <ul className="mt-2 max-h-[60dvh] divide-y divide-border/60 overflow-y-auto">
          {NEW_DOCUMENT_TYPES.map((type, index) => (
            <li key={type.format}>
              <button
                ref={index === 0 ? first : undefined}
                type="button"
                aria-label={ARIA_LABEL[type.format] ?? `New ${type.label} document`}
                onClick={() => onCreate(type.format)}
                className="flex w-full items-baseline gap-3 rounded-md px-2 py-2 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]"
              >
                <span className="w-28 shrink-0 text-[13px] text-foreground">
                  {type.label} <span className="text-[11px] text-muted">{type.extension}</span>
                </span>
                <span className="min-w-0 text-[12px] text-muted">{type.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
