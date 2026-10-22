import { useEffect, useRef, type KeyboardEvent } from "react";
import type { EditableDocumentFormat } from "@/lib/document-session";
import { DocumentFormatMark } from "./document-format-mark";

// Every type a person can start from blank. Legacy .doc and HTML are absent
// on purpose: Markie has no native DOC writer and no rich HTML editor, so
// offering them here would promise a file it cannot honestly create.
export const NEW_DOCUMENT_TYPES: ReadonlyArray<{
  format: EditableDocumentFormat;
  label: string;
  extension: string;
  description: string;
  group: "writing" | "data";
  featured?: boolean;
}> = [
  { format: "markdown", label: "Markdown", extension: ".md", description: "Notes and docs with rich and source views", group: "writing", featured: true },
  { format: "docx", label: "Word", extension: ".docx", description: "Native Word formatting and page layout", group: "writing" },
  { format: "rtf", label: "Rich Text", extension: ".rtf", description: "Portable formatting for Word and TextEdit", group: "writing" },
  { format: "odt", label: "OpenDocument", extension: ".odt", description: "The open format for LibreOffice", group: "writing" },
  { format: "text", label: "Plain Text", extension: ".txt", description: "Exactly the characters you type", group: "writing" },
  { format: "darkmown", label: "Darkmown", extension: ".wd", description: "Notes with live values and interactive controls", group: "writing", featured: true },
  { format: "csv", label: "CSV", extension: ".csv", description: "Rows and columns with a table preview", group: "data" },
  { format: "json", label: "JSON", extension: ".json", description: "Structured data as literal source", group: "data" },
  { format: "yaml", label: "YAML", extension: ".yaml", description: "Config and data as literal source", group: "data" },
  { format: "xml", label: "XML", extension: ".xml", description: "Tagged data as literal source", group: "data" },
];

const ARIA_LABEL: Partial<Record<EditableDocumentFormat, string>> = {
  markdown: "New Markdown document",
  docx: "New Word document",
  text: "New text document",
};

type NewDocumentType = (typeof NEW_DOCUMENT_TYPES)[number];

function WritingTypeButton({ type, first, onCreate }: {
  type: NewDocumentType;
  first: boolean;
  onCreate: (format: EditableDocumentFormat) => void;
}) {
  return (
    <button
      type="button"
      data-new-document-first={first ? "true" : undefined}
      data-new-document-format={type.format}
      aria-label={ARIA_LABEL[type.format] ?? `New ${type.label} document`}
      onClick={() => onCreate(type.format)}
      className={`group relative flex min-h-[138px] items-start gap-3.5 overflow-hidden rounded-[14px] border border-border/80 bg-surface-2/60 p-4 text-left shadow-[inset_0_1px_rgba(255,255,255,0.05),0_3px_12px_rgba(0,0,0,0.08)] transition hover:-translate-y-px hover:border-foreground/25 hover:bg-accent/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--status-blue)] ${type.featured ? "sm:col-span-2" : ""}`}
    >
      <DocumentFormatMark format={type.format} size={type.featured ? "lg" : "md"} />
      <span className="min-w-0 flex-1 pt-0.5">
        <span className="flex flex-col items-start gap-1.5">
          <span className="whitespace-nowrap text-[15px] font-semibold leading-none text-foreground">{type.label}</span>
          <span className="rounded-full border border-border/80 bg-background/45 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted">{type.extension}</span>
        </span>
        <span className="mt-2 block max-w-[34ch] text-[12.5px] leading-snug text-muted">{type.description}</span>
      </span>
      <span aria-hidden="true" className="absolute bottom-3 right-3 flex h-6 w-6 items-center justify-center rounded-full border border-border/70 text-[13px] text-muted opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">→</span>
    </button>
  );
}

function DataTypeButton({ type, onCreate }: {
  type: NewDocumentType;
  onCreate: (format: EditableDocumentFormat) => void;
}) {
  return (
    <button
      type="button"
      data-new-document-format={type.format}
      aria-label={ARIA_LABEL[type.format] ?? `New ${type.label} document`}
      onClick={() => onCreate(type.format)}
      className="group flex min-h-[76px] w-full items-center gap-3 rounded-[12px] border border-border/75 bg-background/35 px-3 py-2.5 text-left shadow-[inset_0_1px_rgba(255,255,255,0.04)] transition hover:border-foreground/22 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--status-blue)]"
    >
      <DocumentFormatMark format={type.format} size="md" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold leading-none text-foreground">{type.label}</span>
          <span className="font-mono text-[10px] text-muted">{type.extension}</span>
        </span>
        <span className="mt-1.5 block truncate text-[11.5px] text-muted">{type.description}</span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-muted opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">→</span>
    </button>
  );
}

export function NewDocumentModal({ onCreate, onClose }: {
  onCreate: (format: EditableDocumentFormat) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const prior = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>("[data-new-document-first]")?.focus();
    return () => {
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus();
    };
  }, []);

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-new-document-format]") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || buttons.length === 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
          : (index + 1) % buttons.length;
    buttons[next]?.focus();
  };

  const writing = NEW_DOCUMENT_TYPES.filter((type) => type.group === "writing");
  const data = NEW_DOCUMENT_TYPES.filter((type) => type.group === "data");

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="New document"
        className="markie-overlay-panel overlay-panel-enter max-h-[88dvh] w-[min(920px,calc(100vw-2rem))] overflow-y-auto rounded-[18px] p-5 sm:p-6"
        onKeyDown={moveFocus}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-semibold leading-tight tracking-tight text-foreground">New document</h2>
            <p className="mt-1 text-[12.5px] text-muted">Choose a format. Files stay in that format.</p>
          </div>
          <button
            type="button"
            aria-label="Cancel new document"
            onClick={onClose}
            className="markie-overlay-close shrink-0"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <h3 className="mb-2.5 mt-6 text-[13px] font-semibold text-foreground">Writing</h3>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {writing.map((type, index) => <WritingTypeButton key={type.format} type={type} first={index === 0} onCreate={onCreate} />)}
        </div>

        <h3 className="mb-2.5 mt-6 text-[13px] font-semibold text-foreground">Data and source</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {data.map((type) => <DataTypeButton key={type.format} type={type} onCreate={onCreate} />)}
        </div>
      </section>
    </div>
  );
}
