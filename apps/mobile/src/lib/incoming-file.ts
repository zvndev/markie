// A file another app hands to Markie: an attachment opened from Mail, an
// AirDrop, "Open in Markie" from Files or the share sheet. iOS copies it into
// the app's own Documents/Inbox and opens a file:// URL; Android sends a
// content:// URI. Capacitor's web view serves both to the page
// (Capacitor.convertFileSrc), so no plugin reads the file.
//
// What comes in is text Markie can show and keep in Markie Cloud. Text files
// arrive as they are. Word, RTF, ODT and HTML are turned into a new text copy,
// the way the desktop imports them; the original file is never changed.
import { classifyDocumentFormat, decodeTextDocument, TextDocumentError } from "@/lib/document-formats";
import type { DocxDocument, DocxParagraph } from "@/lib/office/docx-types";
import { formatFromName, type DocFormat } from "./docs";

export const MAX_INCOMING_BYTES = 16 * 1024 * 1024;

export interface IncomingFile {
  /** The name it will be saved under in Markie Cloud. */
  name: string;
  format: DocFormat;
  content: string;
  /** Set when the file was converted: what it was, for the banner. */
  convertedFrom: string | null;
}

export class IncomingFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncomingFileError";
  }
}

/** A URL that names a file handed to the app, not a link. */
export function isIncomingFileUrl(url: string): boolean {
  return /^(file|content):\/\//i.test(String(url ?? "").trim());
}

/** The file's own name, from the last part of its URL. */
export function nameFromFileUrl(url: string): string {
  let last = "";
  try {
    const parsed = new URL(url);
    last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    last = decodeURIComponent(last);
  } catch {
    last = "";
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  // Android's content:// URIs often end in a number, not a name.
  return cleaned && /[^\d]/.test(cleaned) ? cleaned : "Shared file";
}

const stem = (name: string) => name.replace(/\.[^.]*$/, "") || "Document";

/** Reads and, where needed, converts the bytes of one incoming file. */
export async function decodeIncomingFile(name: string, bytes: Uint8Array): Promise<IncomingFile> {
  if (bytes.byteLength > MAX_INCOMING_BYTES) throw new IncomingFileError("This file is too large to open on a phone.");
  const kind = classifyDocumentFormat(name).kind;

  if (kind === "docx") {
    let doc: DocxDocument;
    try {
      // Loaded only when a Word file arrives, so the app starts without it.
      const { openDocx } = await import("@/lib/office/docx");
      doc = await openDocx(bytes);
    } catch {
      throw new IncomingFileError("This Word document couldn't be read. It may be damaged or protected with a password.");
    }
    return { name: `${stem(name)}.md`, format: "markdown", content: docxToMarkdown(doc), convertedFrom: "Word" };
  }
  if (kind === "rtf" || kind === "odt" || kind === "html") {
    const { convertAdditionalDocument } = await import("@/lib/document-import");
    const result = await convertAdditionalDocument({ name, bytes, format: kind });
    if (!result.ok) throw new IncomingFileError(result.error.message);
    return { name: `${stem(name)}.txt`, format: "text", content: result.text, convertedFrom: kind === "rtf" ? "RTF" : kind === "odt" ? "OpenDocument" : "HTML" };
  }
  if (kind === "doc") throw new IncomingFileError("Older Word files (.doc) open in Markie on your computer. Save it as .docx to open it here.");

  let text: string;
  try {
    text = decodeTextDocument(bytes).text;
  } catch (error) {
    if (error instanceof TextDocumentError && error.code === "binary-content") throw new IncomingFileError("This isn't a text document, so Markie can't open it.");
    throw new IncomingFileError(error instanceof Error ? error.message : "This file couldn't be read as text.");
  }
  // A file with no extension Markie knows is kept as text, under its own name.
  const keptName = kind === "unsupported" && !/\.[a-z0-9]{1,8}$/i.test(name) ? `${name}.txt` : name;
  return { name: keptName, format: formatFromName(keptName), content: text, convertedFrom: null };
}

/** Fetches an incoming file through the web view and decodes it. */
export async function readIncomingFile(url: string, fetchBytes: (url: string) => Promise<Uint8Array>): Promise<IncomingFile> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(url);
  } catch {
    throw new IncomingFileError("Markie couldn't read that file. Try sharing it again.");
  }
  return decodeIncomingFile(nameFromFileUrl(url), bytes);
}

function paragraphMarkdown(paragraph: DocxParagraph): string {
  // Leading spaces and tabs in Word are layout, never a Markdown code block.
  const text = paragraph.text.trim();
  if (!text) return "";
  const style = (paragraph.styleId ?? "").toLowerCase().replace(/[\s_-]/g, "");
  const heading = /^heading([1-6])$/.exec(style)?.[1];
  // A bullet typed as a character ("•\tNorth") rather than a Word list.
  const typedBullet = /^[•◦▪▫‣●○■□–-]\s+(.*)$/s.exec(text);
  if (!paragraph.listKind && typedBullet) return `- ${typedBullet[1].trim()}`;
  if (style === "title") return `# ${text.trim()}`;
  if (heading) return `${"#".repeat(Number(heading))} ${text.trim()}`;
  if (paragraph.listKind) {
    const indent = "  ".repeat(Math.max(0, Math.min(8, paragraph.listLevel ?? 0)));
    return `${indent}${paragraph.listKind === "numbered" ? `${paragraph.listNumber ?? 1}.` : "-"} ${text.trim()}`;
  }
  return text;
}

const cellText = (paragraphs: readonly DocxParagraph[]) => paragraphs.map((p) => p.text.trim()).filter(Boolean).join(" ").replace(/\|/g, "\\|");

/** A Word document as Markdown: headings, lists, paragraphs and tables, in order. */
export function docxToMarkdown(doc: DocxDocument): string {
  const paragraphs = new Map(doc.paragraphs.map((p) => [p.id, p]));
  const tables = new Map(doc.tables.map((t) => [t.id, t]));
  const out: string[] = [];
  let previousList = false;
  for (const block of doc.blocks) {
    if (block.kind === "table") {
      const table = tables.get(block.tableId);
      if (!table || table.rows.length === 0) continue;
      const width = Math.max(...table.rows.map((row) => row.cells.length), 1);
      const row = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
      const rows = table.rows.map((r) => r.cells.map((c) => cellText(c.paragraphs)));
      out.push([row(rows[0]), row(Array(width).fill("---")), ...rows.slice(1).map(row)].join("\n"));
      previousList = false;
      continue;
    }
    const paragraph = paragraphs.get(block.paragraphId);
    if (!paragraph) continue;
    const line = paragraphMarkdown(paragraph);
    if (!line) continue;
    const isList = line.startsWith("- ") || /^\s*(-|\d+\.) /.test(line);
    // Items of one list stay together; everything else is its own paragraph.
    if (isList && previousList) out[out.length - 1] += `\n${line}`;
    else out.push(line);
    previousList = isList;
  }
  return out.length ? `${out.join("\n\n")}\n` : doc.text;
}
