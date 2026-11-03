// Export on the web, for the read view's bar and the web editor's toolbar:
// every format src/lib/export-formats.ts writes, plus the page as HTML, the
// original file and PDF, each as a browser download.
//
// PDF is the browser's own print-to-PDF. The document is put in a print-only
// layer and the page's print styles (doc-view.css) hide everything else and
// lay it out on light paper, so "Save as PDF" in the print sheet writes the
// document, not the app around it. The other formats are bytes made here by
// the same pure converters the desktop uses and handed to a download, which
// is all a page may do.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  EXPORT_FORMAT_NOTE,
  convertForExport,
  exportFileName,
  exportFormat,
  exportFormatsFor,
  type ExportFormat,
  type ExportFormatId,
} from "@/lib/export-formats";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";

/** What the open document is, for which exports make sense. */
export type WebExportSource = "markdown" | "text" | "darkmown" | "office";

export interface WebExportProps {
  /** The document's name, with its extension. */
  name: string;
  source: WebExportSource;
  /** The document's text at the moment of the click. */
  read: () => string;
  /** The document rendered to HTML (Markdown and text), for PDF and HTML. */
  html?: () => string;
  /** The original file's bytes, when they are not just the text (Word, RTF, ODT). */
  original?: () => Promise<Uint8Array>;
  /** Class names for the menu button, so it sits in either bar. */
  buttonClassName?: string;
  /** Where the menu opens from. */
  align?: "left" | "right";
}

const ORIGINAL_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  wd: "text/plain",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
};

function extensionOf(name: string): string {
  return /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
}

/** Hands `data` to the browser as a download named `fileName`. */
export function downloadBytes(data: Uint8Array | string, fileName: string, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName, rel: "noopener" });
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The converted formats offered for a source. A format is never offered as an export of itself. */
export function webExportFormats(source: WebExportSource, name: string): readonly ExportFormat[] {
  if (source === "darkmown") return [];
  if (source === "markdown") return exportFormatsFor("markdown");
  const own = extensionOf(name);
  return exportFormatsFor("text").filter((format) => format.extension !== own);
}

/** Name for the original download: the document's own name, or one with a sensible extension. */
export function originalFileName(name: string, source: WebExportSource): string {
  if (extensionOf(name)) return name;
  return `${name || "document"}.${source === "darkmown" ? "wd" : source === "text" ? "txt" : "md"}`;
}

/**
 * Prints `html` alone. The print layer is a portal that only print styles
 * show; it is removed once the print sheet closes.
 */
function usePrintLayer() {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (html === null) return;
    const root = document.documentElement;
    root.classList.add("markie-printing");
    const done = () => { root.classList.remove("markie-printing"); setHtml(null); };
    window.addEventListener("afterprint", done, { once: true });
    // Paint the layer before the sheet opens.
    const frame = requestAnimationFrame(() => window.print());
    return () => { cancelAnimationFrame(frame); window.removeEventListener("afterprint", done); root.classList.remove("markie-printing"); };
  }, [html]);
  const layer = html === null ? null : createPortal(
    <div className="markie-print-layer" aria-hidden="true"><div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} /></div>,
    document.body,
  );
  return { print: (next: string) => setHtml(next), layer };
}

const ICON = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "shrink-0" };

export function WebExportMenu({ name, source, read, html, original, buttonClassName, align = "right" }: WebExportProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const { print, layer } = usePrintLayer();
  useDismissibleLayer(open, root, () => setOpen(false));

  const formats = webExportFormats(source, name);
  const ext = extensionOf(originalFileName(name, source));
  const textSource = source === "markdown" ? "markdown" : "text";

  const run = async (label: string, job: () => Promise<void> | void) => {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch (err) {
      setError(`Couldn't export as ${label}. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  };

  const downloadOriginal = () => run(`.${ext}`, async () => {
    const fileName = originalFileName(name, source);
    if (original) downloadBytes(await original(), fileName, ORIGINAL_TYPES[ext] ?? "application/octet-stream");
    else downloadBytes(read(), fileName, `${ORIGINAL_TYPES[ext] ?? "text/plain"};charset=utf-8`);
  });
  const downloadAs = (id: ExportFormatId) => run(exportFormat(id).label, async () => {
    const format = exportFormat(id);
    const data = await convertForExport(read(), textSource, id);
    downloadBytes(data, exportFileName(name, id), format.mimeType);
  });
  const downloadHtml = () => run("HTML", async () => {
    if (!html) return;
    const { buildPDFHTML } = await import("@/lib/pdf-styles");
    downloadBytes(await buildPDFHTML(html(), "light"), exportFileName(name, "md").replace(/\.md$/, ".html"), "text/html;charset=utf-8");
  });
  const printPdf = () => run("PDF", () => { if (html) print(html()); });

  const item = "markie-menu-item flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted disabled:opacity-40";
  return <div ref={root} className="relative" data-web-export>
    <button type="button" aria-label="Export" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}
      className={buttonClassName ?? "markie-toolbar-action flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:text-foreground"}>
      <svg {...ICON}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
      <span className="hidden sm:inline">{busy ? "Exporting…" : "Export"}</span>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
    </button>
    {open ? <div role="menu" aria-labelledby={labelId} className={`markie-menu-panel absolute top-full z-50 mt-1.5 min-w-[210px] rounded-lg py-1.5 ${align === "right" ? "right-0" : "left-0"}`}>
      <p id={labelId} className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted/80">Download as</p>
      <button type="button" role="menuitem" data-export="original" className={item} onClick={() => void downloadOriginal()}>
        <svg {...ICON}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
        Original (.{ext})
      </button>
      {html ? <button type="button" role="menuitem" data-export="pdf" className={item} onClick={() => void printPdf()}>
        <svg {...ICON}><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
        PDF (print)…
      </button> : null}
      {html ? <button type="button" role="menuitem" data-export="html" className={item} onClick={() => void downloadHtml()}>
        <svg {...ICON}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
        Web page (.html)
      </button> : null}
      {formats.map((format) => <button key={format.id} type="button" role="menuitem" data-export={format.id} className={item} onClick={() => void downloadAs(format.id)}>
        <svg {...ICON}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>
        {format.label}
      </button>)}
      {formats.some((format) => format.id === "rtf" || format.id === "odt") ? <p role="note" className="mt-1 max-w-[230px] border-t border-border px-3 pt-2 text-[11px] leading-relaxed text-muted">{EXPORT_FORMAT_NOTE} PDF opens your browser&apos;s print sheet: choose Save as PDF.</p> : null}
    </div> : null}
    {error ? <p role="alert" className="markie-menu-panel absolute right-0 top-full z-50 mt-1.5 w-60 rounded-lg px-3 py-2 text-[11.5px] text-foreground">{error} <button type="button" className="underline" onClick={() => setError(null)}>Dismiss</button></p> : null}
    {layer}
  </div>;
}
