// A document leaving the phone as a file: its own source, a self-contained
// HTML page, or a PDF. Each one is handed to the system share sheet as a real
// file, so it can be saved to Files, AirDropped or mailed.
//
// Nothing here renders a document its own way. HTML and PDF are built by the
// desktop's exporters, reached through the `@` alias:
//
// - Markdown and text: `@/lib/markdown-html` then `@/lib/pdf-styles`
//   (buildPDFHTML), the page the desktop's "Export HTML" and "Export PDF"
//   write, in its light and dark themes.
// - A Live Doc (Darkmown): the scriptless still preview the phone already
//   shows before the trust choice (`@/lib/darkmown/preview`). Its controls
//   can't run in a file, so the result is offered as a still copy and says so.
// - Word, RTF and OpenDocument: the original bytes, and a PDF only when the
//   desktop's own print view supports the file (`@/lib/office/docx-print`
//   canPrintDocx), on the file's own page size and margins.
//
// What each kind offers is decided in one place (exportOffer), and the work
// goes through a small device interface (ExportDevice) so it can be tested
// without a phone. Files are written under the app's cache folder
// (native.ts), never backed up, and removed once the share sheet is done with
// them and again at the next launch.
import type { RichDocument } from "@/lib/office/rich-text-types";
import { splitFrontMatter } from "@/lib/front-matter";
import { classifyDocumentFormat } from "@/lib/document-formats";
import { COMMENT_OUTPUT_CONFIRMATION } from "@/lib/document-output-policy";
import type { PDFTheme } from "@/lib/pdf-styles";
import { MAX_DOCUMENT_ASSETS, isLocalRef, refOf } from "./document-html";
import type { CloudDoc } from "./docs";

export type ExportId = "file" | "html" | "pdf" | "pdf-dark";

export type ExportBody =
  | { kind: "markdown" | "text" | "darkmown"; text: string }
  /** `document` is null for a file the phone can't read (an old .doc). */
  | { kind: "office"; document: RichDocument | null; printable: boolean };

export interface ExportSource {
  /** The document's real name, with its extension. */
  name: string;
  body: ExportBody;
  /** The file's own bytes, when it has them: "Copy of the file" sends these untouched. */
  bytes?: Uint8Array | null;
  /** One of the document's own pictures, by the ref it wrote. */
  loadAsset?: (ref: string) => Promise<Blob | null>;
}

export interface ExportOption {
  id: ExportId;
  label: string;
  /** The name the file leaves with. */
  fileName: string;
  /** Asked before the work starts, when the result leaves something out. */
  confirm?: string;
}

export interface ExportOffer {
  options: ExportOption[];
  /** One plain line on what the result is, or why something isn't offered. */
  note: string | null;
}

export const STILL_COPY_NOTE = "HTML and PDF are a still copy. Buttons and inputs only run in Markie.";
export const LIVE_DOC_TOO_LONG_NOTE = "This Live Doc is too long for an HTML or PDF copy.";
export const OFFICE_PDF_NOTE = "The PDF uses the file's own page setup. HTML is not offered for this kind of file.";
export const OFFICE_NO_PDF_NOTE = "PDF is not offered for this file. Markie can't lay out everything in it faithfully.";
export const OLD_WORD_NOTE = "Older Word files (.doc) leave as the original file only.";

/** The still preview refuses anything longer (src/lib/darkmown/preview.ts). */
const DARKMOWN_STILL_MAX_CHARS = 200_000;
/** All of a document's own pictures together, folded into one HTML file. */
export const MAX_INLINE_PICTURE_BYTES = 30_000_000;
const PICTURE_CONCURRENCY = 4;

// ── Names ────────────────────────────────────────────────────────────────

const FALLBACK_BASE = "Document";
const MAX_BASE_CHARS = 120;

/** A name safe to write as one file: no folders, no control characters, no leading dots. */
function cleanName(name: string): string {
  return String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
}

function splitName(name: string): { base: string; extension: string } {
  const cleaned = cleanName(name);
  const match = /^(.*)\.([A-Za-z0-9]{1,8})$/.exec(cleaned);
  const base = (match ? match[1] : cleaned).trim().slice(0, MAX_BASE_CHARS).trim() || FALLBACK_BASE;
  return { base, extension: match ? match[2] : "" };
}

function defaultExtension(body: ExportBody): string {
  if (body.kind === "markdown") return "md";
  if (body.kind === "darkmown") return "wd";
  if (body.kind === "text") return "txt";
  return "";
}

/** The document's own name: `Notes.md` stays `Notes.md`; a name with no extension gets its kind's. */
export function sourceFileName(source: ExportSource): string {
  const { base, extension } = splitName(source.name);
  const ext = extension || defaultExtension(source.body);
  return ext ? `${base}.${ext}` : base;
}

/** `Notes.md` becomes `Notes.pdf`. */
export function exportFileName(source: ExportSource, extension: "html" | "pdf"): string {
  return `${splitName(source.name).base}.${extension}`;
}

// ── What each kind offers ────────────────────────────────────────────────

export function exportOffer(source: ExportSource): ExportOffer {
  const file: ExportOption = { id: "file", label: "Copy of the file", fileName: sourceFileName(source) };
  const html: ExportOption = { id: "html", label: "HTML", fileName: exportFileName(source, "html") };
  const pdf: ExportOption = { id: "pdf", label: "PDF", fileName: exportFileName(source, "pdf") };
  const dark: ExportOption = { id: "pdf-dark", label: "PDF, dark", fileName: exportFileName(source, "pdf") };
  const body = source.body;
  if (body.kind !== "office") {
    if (body.kind !== "darkmown") return { options: [file, html, pdf, dark], note: null };
    if (body.text.length > DARKMOWN_STILL_MAX_CHARS) return { options: [file], note: LIVE_DOC_TOO_LONG_NOTE };
    return { options: [file, html, pdf, dark], note: STILL_COPY_NOTE };
  }
  // A Word, RTF or OpenDocument file is its own bytes or nothing.
  const options = source.bytes ? [file] : [];
  if (!body.document) return { options, note: OLD_WORD_NOTE };
  if (!body.printable) return { options, note: OFFICE_NO_PDF_NOTE };
  // Paper is white: a Word page has no dark variant.
  return { options: [...options, { ...pdf, ...(body.document.comments.length ? { confirm: COMMENT_OUTPUT_CONFIRMATION } : {}) }], note: OFFICE_PDF_NOTE };
}

/** The source for a document from the Markdown and text store. */
export function docExportSource(doc: Pick<CloudDoc, "name" | "format" | "content">, loadAsset?: ExportSource["loadAsset"]): ExportSource {
  return { name: doc.name, body: { kind: doc.format, text: doc.content }, loadAsset };
}

/**
 * The source for a file from the document platform (office.tsx). The bytes
 * are the ones the server sent, so a copy is the original file exactly.
 */
export async function platformExportSource(name: string, bytes: Uint8Array, opened: { text: string } | { document: RichDocument } | null): Promise<ExportSource> {
  if (opened && "text" in opened) {
    const kind = classifyDocumentFormat(name).kind;
    return { name, bytes, body: { kind: kind === "markdown" || kind === "darkmown" ? kind : "text", text: opened.text } };
  }
  if (!opened) return { name, bytes, body: { kind: "office", document: null, printable: false } };
  const { canPrintDocx } = await import("@/lib/office/docx-print");
  return { name, bytes, body: { kind: "office", document: opened.document, printable: canPrintDocx(opened.document) } };
}

// ── The HTML ─────────────────────────────────────────────────────────────

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

// Two things the desktop's stylesheet has no rule for, because the desktop
// never needs them: a text file shown as text (the phone's own reading view
// is a <pre>, not Markdown), and the line that stands in for a picture the
// phone couldn't fetch.
const PHONE_EXPORT_CSS = `
  .markdown-body pre.markie-text { margin: 0; padding: 0; border: 0; border-radius: 0; background: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; page-break-inside: auto; break-inside: auto; }
  .markdown-body .markie-picture-missing { color: #71717a; font-style: italic; }
`;

/** Adds a stylesheet to a built page, just before its head closes. */
function addCss(html: string, css: string): string {
  const at = html.search(/<\/head>/i);
  return at < 0 ? html : `${html.slice(0, at)}<style>${css}</style>\n${html.slice(at)}`;
}

function addTitle(html: string, title: string): string {
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<title>${escapeHtml(title)}</title>`);
}

/** A blob's bytes. `Blob.arrayBuffer` where there is one; FileReader for a web view (or a test DOM) without it. */
function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the picture."));
    reader.readAsArrayBuffer(blob);
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/**
 * The document's own pictures (`![](shots/a.png)`), folded into the page as
 * data: URIs so the file stands alone. They come from the same asset route
 * the reading view uses. One the phone can't fetch becomes a line naming it,
 * as it does on screen. A picture on the web keeps its address.
 */
export async function inlinePictures(html: string, loadAsset: ExportSource["loadAsset"], doc: Document = document): Promise<string> {
  const template = doc.createElement("template");
  template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll("img[src]")).filter((img) => isLocalRef((img.getAttribute("src") ?? "").trim()));
  if (!images.length) return html;
  // A few at a time, so a document opened offline doesn't wait on each
  // picture in turn. A picture that fails is left out; it never fails the export.
  const refs = Array.from(new Set(images.map((img) => refOf(img.getAttribute("src") ?? "")))).filter(Boolean).slice(0, MAX_DOCUMENT_ASSETS);
  const blobs = new Map<string, Blob | null>();
  const queue = [...refs];
  const worker = async () => {
    while (queue.length) {
      const ref = queue.shift()!;
      blobs.set(ref, loadAsset ? await Promise.resolve().then(() => loadAsset(ref)).catch(() => null) : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PICTURE_CONCURRENCY, refs.length) }, worker));
  const fetched = new Map<string, string | null>();
  let total = 0;
  for (const ref of refs) {
    const blob = blobs.get(ref);
    let uri: string | null = null;
    if (blob && /^image\//i.test(blob.type) && total + blob.size <= MAX_INLINE_PICTURE_BYTES) {
      total += blob.size;
      uri = await bytesOf(blob).then((bytes) => `data:${blob.type};base64,${toBase64(bytes)}`, () => null);
    }
    fetched.set(ref, uri);
  }
  for (const img of images) {
    const ref = refOf(img.getAttribute("src") ?? "");
    const uri = fetched.get(ref);
    img.removeAttribute("srcset");
    if (uri) {
      img.setAttribute("src", uri);
      continue;
    }
    const note = doc.createElement("span");
    note.className = "markie-picture-missing";
    const alt = (img.getAttribute("alt") ?? "").trim();
    note.textContent = alt ? `Picture not available: ${alt}` : "Picture not available";
    img.replaceWith(note);
  }
  return template.innerHTML;
}

/** The page an export writes: the HTML file as it is, and what the PDF is printed from. */
export async function buildExportHtml(source: ExportSource, theme: PDFTheme): Promise<string> {
  const body = source.body;
  if (body.kind === "darkmown") {
    const { compileDarkmownPreview } = await import("@/lib/darkmown/preview");
    // Not trusted, so scriptless: every control is there and none can run.
    return (await compileDarkmownPreview(body.text, false, { colorScheme: theme })).srcDoc;
  }
  if (body.kind === "office") {
    if (!body.document || !body.printable) throw new Error("This file can't be made into a PDF.");
    const { buildDocxPrintHTML } = await import("@/lib/office/docx-print");
    return buildDocxPrintHTML(body.document, splitName(source.name).base);
  }
  const { buildPDFHTML } = await import("@/lib/pdf-styles");
  let content: string;
  if (body.kind === "markdown") {
    const { renderMarkdownHTML } = await import("@/lib/markdown-html");
    // Front matter is metadata, held aside from the reading view and so from this.
    content = await inlinePictures(renderMarkdownHTML(splitFrontMatter(body.text).body), source.loadAsset);
  } else {
    content = `<pre class="markie-text">${escapeHtml(body.text)}</pre>`;
  }
  return addTitle(addCss(await buildPDFHTML(content, theme), PHONE_EXPORT_CSS), splitName(source.name).base);
}

// ── The PDF ──────────────────────────────────────────────────────────────

const POINTS_PER_CM = 72 / 2.54;
const A4 = { width: 595.28, height: 841.89 };
// The inset the desktop's stylesheet gives every page: `padding: 2cm 2.2cm`.
const INSET = { top: 2 * POINTS_PER_CM, right: 2.2 * POINTS_PER_CM, bottom: 2 * POINTS_PER_CM, left: 2.2 * POINTS_PER_CM };
const NO_MARGINS = { top: 0, right: 0, bottom: 0, left: 0 };

/** The paper behind each kind, as its own stylesheet paints it. A test holds these to the stylesheets. */
export const PAGE_BACKGROUND = {
  markdown: { light: "#ffffff", dark: "#09090b" },
  darkmown: { light: "#ffffff", dark: "#18181b" },
} as const;

/** What the native printer is given. Lengths are PDF points. */
export interface PrintJob {
  html: string;
  page: { width: number; height: number };
  /** Kept clear by the printer on every page. */
  margins: { top: number; right: number; bottom: number; left: number };
  /** Painted across the whole page first, so a dark page is dark to its edges. */
  background: string;
}

/**
 * The page geometry for a PDF, which the two platforms take differently.
 *
 * The desktop prints with no page margin and insets the text with padding on
 * the body that repeats on every page (`box-decoration-break: clone`), which
 * is what lets a dark page reach the paper's edge (src/lib/pdf-styles.ts).
 * Android's web view is Chromium, so it prints the desktop's page as it is.
 * iOS's WebKit doesn't repeat that padding, so there the printer keeps the
 * same inset as real margins, paints the paper itself, and the page's own
 * padding is taken off.
 */
export function printJobFor(source: ExportSource, html: string, theme: PDFTheme, platform: "ios" | "android" | "web"): PrintJob {
  const body = source.body;
  if (body.kind === "office") {
    const layout = body.document!.pageLayout;
    return {
      html,
      page: { width: layout.widthPoints, height: layout.heightPoints },
      margins: { top: layout.marginTopPoints, right: layout.marginRightPoints, bottom: layout.marginBottomPoints, left: layout.marginLeftPoints },
      background: "#ffffff",
    };
  }
  const still = body.kind === "darkmown";
  const background = PAGE_BACKGROUND[still ? "darkmown" : "markdown"][theme];
  const colours = "-webkit-print-color-adjust: exact; print-color-adjust: exact;";
  if (platform === "ios") {
    const css = `html, body { margin: 0 !important; padding: 0 !important; max-width: none !important; ${colours} }${still ? " main { max-width: none !important; }" : ""}`;
    return { html: addCss(html, css), page: A4, margins: INSET, background };
  }
  // The still preview is a screen page; give it the desktop's paper.
  const css = still ? `@page { size: A4; margin: 0; } body { padding: 2cm 2.2cm !important; -webkit-box-decoration-break: clone; box-decoration-break: clone; ${colours} } main { max-width: none !important; }` : "";
  return { html: css ? addCss(html, css) : html, page: A4, margins: NO_MARGINS, background };
}

// ── Doing it ─────────────────────────────────────────────────────────────

export type ExportOutcome = "shared" | "canceled" | "saved";

/** The device's part, in native.ts. Paths are inside the app's share folder in its cache. */
export interface ExportDevice {
  platform: "ios" | "android" | "web";
  /** Writes one file and returns its file: URI. */
  write(path: string, data: string | Uint8Array): Promise<string>;
  /** Prints a page to a PDF file off screen and returns its file: URI. */
  print(job: PrintJob, path: string): Promise<string>;
  /** The system share sheet with one file. False when the person backed out. */
  share(uri: string, title: string): Promise<boolean>;
  /** Removes one export's folder. Never throws. */
  remove(folder: string): Promise<void>;
  /** A desktop browser: the same bytes as a download. */
  download(name: string, data: string | Uint8Array, mimeType: string): void;
  /** A desktop browser: the page in a print window, where "Save as PDF" is. */
  printWindow(html: string): void;
  later(work: () => void, ms: number): void;
}

// On iOS the share sheet reports back once the chosen app has the file, so it
// is removed at once. Android reports back as soon as the person picks an app,
// which may still be reading the file; it stays this long, and the next launch
// removes whatever is left (sweepShareFiles in native.ts).
export const ANDROID_REMOVE_AFTER_MS = 5 * 60_000;

const MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", wd: "text/plain", txt: "text/plain", csv: "text/csv", json: "application/json",
  html: "text/html", pdf: "application/pdf", rtf: "application/rtf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", odt: "application/vnd.oasis.opendocument.text", doc: "application/msword",
};
const mimeFor = (name: string) => MIME[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

let counter = 0;
const newFolder = () => `export-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Makes one export and hands it to the share sheet (or, in a desktop browser, to a download). */
export async function runExport(source: ExportSource, id: ExportId, device: ExportDevice): Promise<ExportOutcome> {
  const option = exportOffer(source).options.find((entry) => entry.id === id);
  if (!option) throw new Error("This document can't be exported that way.");
  const theme: PDFTheme = id === "pdf-dark" ? "dark" : "light";
  const web = device.platform === "web";

  // Build first, in memory: a failure here leaves nothing on the device.
  let data: string | Uint8Array | null = null;
  let job: PrintJob | null = null;
  if (id === "file") {
    data = source.bytes ?? (source.body.kind === "office" ? null : source.body.text);
    if (data === null) throw new Error("This file's contents aren't on the phone.");
  } else {
    // An HTML file is the light page, as the desktop's is.
    const html = await buildExportHtml(source, theme);
    if (id === "html") data = html;
    else job = printJobFor(source, html, theme, device.platform);
  }

  if (web) {
    if (job) device.printWindow(job.html);
    else device.download(option.fileName, data!, mimeFor(option.fileName));
    return "saved";
  }

  const folder = newFolder();
  const path = `${folder}/${option.fileName}`;
  let shared = false;
  try {
    const uri = job ? await device.print(job, path) : await device.write(path, data!);
    shared = await device.share(uri, option.fileName);
    return shared ? "shared" : "canceled";
  } finally {
    if (shared && device.platform === "android") device.later(() => void device.remove(folder), ANDROID_REMOVE_AFTER_MS);
    else await device.remove(folder);
  }
}
