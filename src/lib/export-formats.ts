// The document formats Markie can export a Markdown or plain-text document
// to, beyond the rendered PDF and HTML, and the one function that produces
// each file's bytes.
//
// Pure on purpose: no DOM, no Electron, no React. The desktop hands the bytes
// to main's save dialog (export-document IPC); the web app can hand the same
// bytes to a browser download with the format's mimeType. The heavy parts
// (the Markdown parser and the Office codecs) are imported on demand, so
// reading EXPORT_FORMATS costs nothing on the launch path.
//
// Every rich file is written by Markie's own codecs (src/lib/office), the same
// writers the Word, RTF and ODT editors save with, and each one re-reads its
// own output before returning it. Nothing here is a second Office engine.
//
// What survives, by format:
// - Word: headings (as Heading 1 to 3), bold, italic, code font, bullet and
//   numbered lists (nested ones as deeper list levels), links, and tables
//   with their cell formatting.
// - RTF and OpenDocument: headings (as large bold text), bold, italic, code
//   font, and lists as bullet or number text. Markie's RTF and ODT codecs have
//   no table, list or hyperlink structure, so tables become tab-separated rows
//   and a link keeps its address in brackets after the text.
// - Plain text: the words, with list markers, link addresses and tab-separated
//   table rows. Formatting has no plain-text form.
// - Markdown (from plain text): escaped so it reads exactly as the text did.
import type { DocxOperation } from "@/lib/office/docx-types";
import { splitFrontMatter } from "@/lib/front-matter";

export type ExportFormatId = "docx" | "rtf" | "odt" | "txt" | "md";
/** What the open document is: Markdown is parsed, plain text is taken literally. */
export type ExportSourceKind = "markdown" | "text";

export interface ExportFormat {
  readonly id: ExportFormatId;
  /** The menu label. */
  readonly label: string;
  readonly extension: string;
  readonly mimeType: string;
  /** The save dialog's filter name. */
  readonly filterName: string;
}

export const EXPORT_FORMATS: readonly ExportFormat[] = Object.freeze([
  { id: "docx", label: "Word (.docx)", extension: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filterName: "Word Document" },
  { id: "rtf", label: "RTF (.rtf)", extension: "rtf", mimeType: "application/rtf", filterName: "Rich Text Format" },
  { id: "odt", label: "OpenDocument (.odt)", extension: "odt", mimeType: "application/vnd.oasis.opendocument.text", filterName: "OpenDocument Text" },
  { id: "txt", label: "Plain text (.txt)", extension: "txt", mimeType: "text/plain", filterName: "Plain Text" },
  { id: "md", label: "Markdown (.md)", extension: "md", mimeType: "text/markdown", filterName: "Markdown" },
].map((format) => Object.freeze(format as ExportFormat)));

/** One line of honest disclosure for the menu: where a format loses structure. */
export const EXPORT_FORMAT_NOTE = "RTF and ODT keep text and formatting. Tables there become tab-separated rows.";

export function exportFormat(id: ExportFormatId): ExportFormat {
  const format = EXPORT_FORMATS.find((f) => f.id === id);
  if (!format) throw new Error(`Unknown export format: ${String(id)}`);
  return format;
}

/** The formats offered for a document. A format is not offered as an export of itself. */
export function exportFormatsFor(source: ExportSourceKind): readonly ExportFormat[] {
  return EXPORT_FORMATS.filter((f) => (source === "markdown" ? f.id !== "md" : f.id !== "txt"));
}

/** "Notes.md" becomes "Notes.docx"; no name becomes "document.docx". */
export function exportFileName(fileName: string | null | undefined, id: ExportFormatId): string {
  const base = (fileName ?? "").replace(/\.[^./\\]+$/, "").trim() || "document";
  return `${base}.${exportFormat(id).extension}`;
}

/** Produce the bytes of `text` (a document of kind `source`) in format `id`. */
export async function convertForExport(text: string, source: ExportSourceKind, id: ExportFormatId): Promise<Uint8Array> {
  exportFormat(id);
  const normalized = text.replace(/\r\n?/g, "\n");
  if (id === "md") {
    if (source === "markdown") return encode(normalized);
    return encode(textToMarkdown(normalized));
  }
  if (id === "txt" && source === "text") return encode(normalized);
  const blocks = source === "markdown" ? await markdownBlocks(normalized) : textBlocks(normalized);
  if (id === "txt") return encode(blocksToText(blocks));
  if (id === "docx") return blocksToDocx(blocks);
  return blocksToFlatRich(id, blocks);
}

const encode = (text: string) => new TextEncoder().encode(text);

// ── The document model every writer reads ─────────────────────────────────

export interface ExportInline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}
export type ExportBlock =
  | { kind: "heading"; level: number; content: ExportInline[] }
  | { kind: "paragraph"; content: ExportInline[]; quote: boolean }
  | { kind: "item"; content: ExportInline[]; /** The outermost list the item sits in; a nested list shares its parent's. */ list: number; ordered: boolean; number: number; depth: number; checked: boolean | null; quote: boolean }
  | { kind: "code"; text: string; quote: boolean }
  | { kind: "table"; rows: ExportInline[][][] }
  | { kind: "rule" };

// Plain text: one paragraph per line, taken literally.
function textBlocks(text: string): ExportBlock[] {
  return text.split("\n").map((line) => ({ kind: "paragraph", content: line ? [{ text: line }] : [], quote: false }));
}

/** Markdown parsed the way the renderer parses it (GFM, strict math), front matter set aside. */
export async function markdownBlocks(markdown: string): Promise<ExportBlock[]> {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { default: remarkMath }, { remarkStrictMath }] = await Promise.all([
    import("unified"), import("remark-parse"), import("remark-gfm"), import("remark-math"), import("@/lib/remark-strict-math"),
  ]);
  const body = splitFrontMatter(markdown).body;
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStrictMath).parse(body) as unknown as MdNode;
  const definitions = new Map<string, string>();
  visitAll(tree, (node) => { if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url); });
  const blocks: ExportBlock[] = [];
  const ctx: FlowContext = { quote: false, depth: 0, definitions, lists: { count: 0 } };
  for (const child of tree.children ?? []) flowToBlocks(child, blocks, ctx);
  return blocks;
}

// The slice of mdast this reads. Typed loosely so an unknown node is skipped,
// never a crash.
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  identifier?: string;
  label?: string | null;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  children?: MdNode[];
}
interface FlowContext { quote: boolean; depth: number; definitions: Map<string, string>; lists: { count: number }; rootList?: number }

function visitAll(node: MdNode, fn: (node: MdNode) => void) {
  fn(node);
  for (const child of node.children ?? []) visitAll(child, fn);
}

function flowToBlocks(node: MdNode, out: ExportBlock[], ctx: FlowContext) {
  switch (node.type) {
    case "heading":
      out.push({ kind: "heading", level: Math.min(6, Math.max(1, node.depth ?? 1)), content: phrasing(node.children, ctx) });
      return;
    case "paragraph":
      for (const content of splitOnBreaks(phrasing(node.children, ctx))) out.push({ kind: "paragraph", content, quote: ctx.quote });
      return;
    case "blockquote":
      for (const child of node.children ?? []) flowToBlocks(child, out, { ...ctx, quote: true });
      return;
    case "list": {
      let number = node.start ?? 1;
      const list = ctx.rootList ?? ++ctx.lists.count;
      for (const item of node.children ?? []) {
        if (item.type !== "listItem") continue;
        const [first, ...rest] = item.children ?? [];
        const content = first && first.type === "paragraph" ? phrasing(first.children, ctx) : [];
        out.push({ kind: "item", content, list, ordered: !!node.ordered, number, depth: ctx.depth, checked: item.checked ?? null, quote: ctx.quote });
        const remaining = first && first.type === "paragraph" ? rest : item.children ?? [];
        for (const child of remaining) flowToBlocks(child, out, { ...ctx, depth: ctx.depth + 1, rootList: list });
        number++;
      }
      return;
    }
    case "code":
      out.push({ kind: "code", text: node.value ?? "", quote: ctx.quote });
      return;
    case "math":
      out.push({ kind: "code", text: node.value ?? "", quote: ctx.quote });
      return;
    case "table":
      out.push({ kind: "table", rows: (node.children ?? []).map((row) => (row.children ?? []).map((cell) => phrasing(cell.children, ctx))) });
      return;
    case "thematicBreak":
      out.push({ kind: "rule" });
      return;
    case "html": {
      const text = stripTags(node.value ?? "");
      if (text.trim()) out.push({ kind: "paragraph", content: [{ text }], quote: ctx.quote });
      return;
    }
    case "footnoteDefinition": {
      const label = `[${node.label ?? node.identifier ?? ""}] `;
      const inner: ExportBlock[] = [];
      for (const child of node.children ?? []) flowToBlocks(child, inner, ctx);
      const head = inner[0];
      if (head && (head.kind === "paragraph" || head.kind === "item")) head.content.unshift({ text: label });
      out.push(...inner);
      return;
    }
    default:
      // definition, yaml and anything unknown carry no visible text of their own.
      return;
  }
}

type Marks = Omit<ExportInline, "text">;
function phrasing(children: MdNode[] | undefined, ctx: FlowContext, marks: Marks = {}): ExportInline[] {
  const out: ExportInline[] = [];
  const push = (text: string, extra: Marks = {}) => { if (text) out.push({ text, ...marks, ...extra }); };
  for (const node of children ?? []) {
    switch (node.type) {
      case "text": push((node.value ?? "").replace(/\n/g, " ")); break;
      case "strong": out.push(...phrasing(node.children, ctx, { ...marks, bold: true })); break;
      case "emphasis": out.push(...phrasing(node.children, ctx, { ...marks, italic: true })); break;
      case "delete": out.push(...phrasing(node.children, ctx, marks)); break;
      case "inlineCode": push(node.value ?? "", { code: true }); break;
      case "inlineMath": push(node.value ?? "", { code: true }); break;
      case "break": out.push({ text: "\n" }); break;
      case "link": out.push(...phrasing(node.children, ctx, { ...marks, href: node.url ?? undefined })); break;
      case "linkReference": {
        const href = ctx.definitions.get((node.identifier ?? "").toLowerCase());
        out.push(...phrasing(node.children, ctx, href ? { ...marks, href } : marks));
        break;
      }
      case "image":
      case "imageReference": push(node.alt ? `[${node.alt}]` : "[image]"); break;
      case "footnoteReference": push(`[${node.label ?? node.identifier ?? ""}]`); break;
      case "html": break;
      default: if (node.children) out.push(...phrasing(node.children, ctx, marks)); else push(node.value ?? "");
    }
  }
  return out;
}

// A hard line break inside a paragraph starts a new line. None of the writers
// has an in-paragraph break that every reader agrees on, so it becomes its own
// paragraph, which every reader shows the same way.
function splitOnBreaks(content: ExportInline[]): ExportInline[][] {
  const lines: ExportInline[][] = [[]];
  for (const inline of content) {
    if (inline.text === "\n" && !inline.code) lines.push([]);
    else lines[lines.length - 1].push(inline);
  }
  return lines.filter((line, i) => line.length || i === 0);
}

function stripTags(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
}


// ── Plain text ────────────────────────────────────────────────────────────

function inlineText(content: readonly ExportInline[]): string {
  // Consecutive inlines of one link are one link: "[**a** b](u)" names u once.
  let result = "";
  for (let i = 0; i < content.length; i++) {
    const inline = content[i];
    result += inline.text;
    const next = content[i + 1];
    if (inline.href && next?.href !== inline.href) {
      let label = "";
      for (let j = i; j >= 0 && content[j].href === inline.href; j--) label = content[j].text + label;
      if (label.trim() !== inline.href && `mailto:${label.trim()}` !== inline.href) result += ` (${inline.href})`;
    }
  }
  return result;
}

const itemMarker = (block: Extract<ExportBlock, { kind: "item" }>) =>
  `${block.ordered ? `${block.number}.` : "-"} ${block.checked === true ? "[x] " : block.checked === false ? "[ ] " : ""}`;

export function blocksToText(blocks: readonly ExportBlock[]): string {
  const parts: string[] = [];
  let previous: ExportBlock | undefined;
  for (const block of blocks) {
    const quote = "quote" in block && block.quote ? "> " : "";
    let text: string;
    if (block.kind === "heading") text = inlineText(block.content);
    else if (block.kind === "paragraph") text = quote + inlineText(block.content);
    else if (block.kind === "item") text = quote + "  ".repeat(block.depth) + itemMarker(block) + inlineText(block.content);
    else if (block.kind === "code") text = block.text.split("\n").map((line) => quote + line).join("\n");
    else if (block.kind === "table") text = block.rows.map((row) => row.map((cell) => inlineText(cell)).join("\t")).join("\n");
    else text = "* * *";
    const joiner = previous === undefined ? "" : previous.kind === "item" && block.kind === "item" ? "\n" : "\n\n";
    parts.push(joiner + text);
    previous = block;
  }
  const out = parts.join("");
  return out ? `${out}\n` : "";
}

// ── Markdown from plain text ──────────────────────────────────────────────

/**
 * Plain text as Markdown that renders as the same text: characters Markdown
 * would read as syntax are escaped, and every line break is kept as a hard
 * break, so nothing reflows or turns into a heading, list or link.
 */
export function textToMarkdown(text: string): string {
  const lines = text.split("\n");
  const out = lines.map((line, i) => {
    let escaped = line.replace(/[\\`*_[\]<>|~$&]/g, (c) => `\\${c}`);
    escaped = escaped
      .replace(/^(\s*)([#+=-])/, "$1\\$2")
      .replace(/^(\s*)(\d+)([.)])/, "$1$2\\$3");
    // Leading indentation would make an indented code block; keep it as
    // non-breaking spaces so it still shows.
    escaped = escaped.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    ").replace(/ /g, " "));
    const next = lines[i + 1];
    const hardBreak = line.trim() !== "" && next !== undefined && next.trim() !== "";
    return hardBreak ? `${escaped}\\` : escaped;
  });
  return out.join("\n");
}

// ── Rich lines shared by the Word, RTF and ODT writers ────────────────────

interface Span { start: number; end: number; bold?: boolean; italic?: boolean; code?: boolean; href?: string }
interface RichLine {
  text: string;
  spans: Span[];
  role: "body" | "heading" | "item" | "code" | "rule";
  level?: number;
  quote?: boolean;
  bold?: boolean;
  /** Lines of one block (a paragraph, a whole list, a table) share a group. */
  group?: string;
}

const CODE_FONT = "Courier New";
const LINK_COLOR = "1155CC";
// Characters no Office XML or RTF stream may carry.
const clean = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

interface LineOptions {
  tabs: string;
  /** Keep the link on its span: a real hyperlink, or link styling. */
  keep: (href: string) => boolean;
  /** Write the address as text after the link: writers without hyperlinks, or a link they cannot hold. */
  address: (href: string) => boolean;
}

function lineFrom(content: readonly ExportInline[], options: LineOptions): Pick<RichLine, "text" | "spans"> {
  let text = "";
  const spans: Span[] = [];
  for (let i = 0; i < content.length; i++) {
    const inline = content[i];
    const value = clean(inline.text).replace(/\n/g, " ").replace(/\t/g, options.tabs);
    const start = text.length;
    text += value;
    const href = inline.href && options.keep(inline.href) ? inline.href : undefined;
    if (value && (inline.bold || inline.italic || inline.code || href)) {
      spans.push({ start, end: text.length, bold: inline.bold, italic: inline.italic, code: inline.code, href });
    }
    const next = content[i + 1];
    if (inline.href && next?.href !== inline.href && options.address(inline.href)) {
      let label = "";
      for (let j = i; j >= 0 && content[j].href === inline.href; j--) label = content[j].text + label;
      if (label.trim() !== inline.href && `mailto:${label.trim()}` !== inline.href) text += ` (${clean(inline.href)})`;
    }
  }
  return { text, spans };
}

function codeLines(text: string, quote: boolean, tabs: string): RichLine[] {
  return clean(text).replace(/\t/g, tabs).split("\n").map((line) => ({ text: line, spans: line ? [{ start: 0, end: line.length, code: true }] : [], role: "code", quote }));
}

// ── Word ──────────────────────────────────────────────────────────────────

async function blocksToDocx(blocks: readonly ExportBlock[]): Promise<Uint8Array> {
  const [{ openDocx }, { safeDocxHyperlinkTarget }, { writeZip, DEFAULT_ZIP_LIMITS }] = await Promise.all([
    import("@/lib/office/docx"), import("@/lib/office/docx-hyperlinks"), import("@/lib/office/zip"),
  ]);
  // Word links only to web and mail addresses, by the same rule the Word
  // editor applies. Any other link (a relative file, an anchor) keeps its
  // address as text instead.
  const linkable = (href: string) => { try { safeDocxHyperlinkTarget(href); return true; } catch { return false; } };
  const docxLine = (content: readonly ExportInline[]) => lineFrom(content, { tabs: "    ", keep: linkable, address: (href) => !linkable(href) });

  // Authored in one pass. Building it through the Word editor's operations
  // re-parses the whole package per edit, and a 150-section document took
  // three minutes. The vocabulary below is what those operations write
  // (createDocx, ensureDocxNamedStyle, ensureDocxList, setDocxHyperlink,
  // insert-table), and openDocx re-reads the result before it is returned.
  const links: string[] = [];
  const linkId = (href: string) => {
    let index = links.indexOf(href);
    if (index < 0) { links.push(href); index = links.length - 1; }
    return `rIdLink${index + 1}`;
  };
  // Every top-level Markdown list is one multilevel numbering definition, its
  // nested lists are its deeper levels, and each level starts at its own
  // number. A second list restarts; a list resumed after a nested one carries
  // on, the way Word counts.
  const lists: { kinds: ("bullet" | "numbered")[]; starts: number[] }[] = [];
  let currentList = null as { id: number; numId: number } | null;
  const body: string[] = [];
  let lastWasTable = false;
  const paragraph = (line: RichLine, list?: { numId: number; level: number }) => {
    const properties = [
      line.role === "heading" ? `<w:pStyle w:val="Heading${Math.min(3, line.level ?? 1)}"/>` : "",
      list ? `<w:numPr><w:ilvl w:val="${list.level}"/><w:numId w:val="${list.numId}"/></w:numPr>` : "",
      line.role === "rule" ? `<w:jc w:val="center"/>` : "",
    ].join("");
    body.push(`<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${runsXml(line, linkId)}</w:p>`);
    lastWasTable = false;
  };
  for (const block of blocks) {
    if (block.kind !== "item") currentList = null;
    if (block.kind === "heading") paragraph({ ...docxLine(block.content), role: "heading", level: block.level });
    else if (block.kind === "paragraph") paragraph({ ...docxLine(block.content), role: "body", quote: block.quote });
    else if (block.kind === "item") {
      const line = docxLine(block.content);
      const box = block.checked === true ? "☑ " : block.checked === false ? "☐ " : "";
      if (currentList?.id !== block.list) {
        lists.push({ kinds: [], starts: [] });
        currentList = { id: block.list, numId: lists.length };
      }
      const level = Math.min(8, block.depth);
      const definition = lists[currentList.numId - 1];
      definition.kinds[level] ??= block.ordered ? "numbered" : "bullet";
      definition.starts[level] ??= block.number;
      paragraph({ text: box + line.text, spans: line.spans.map((s) => ({ ...s, start: s.start + box.length, end: s.end + box.length })), role: "item", quote: block.quote }, { numId: currentList.numId, level });
    } else if (block.kind === "code") codeLines(block.text, block.quote, "    ").forEach((line) => paragraph(line));
    else if (block.kind === "rule") paragraph({ text: "* * *", spans: [], role: "rule" });
    else if (block.rows.length) {
      const columns = Math.max(1, ...block.rows.map((row) => row.length));
      const rows = block.rows.map((row, r) => Array.from({ length: columns }, (_, c): RichLine => ({ ...docxLine(row[c] ?? []), role: "body", bold: r === 0 })));
      body.push(tableXml(rows, linkId));
      lastWasTable = true;
    }
  }
  // Word wants a paragraph after a final table, and a body with at least one.
  if (lastWasTable || !body.length) body.push("<w:p/>");

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<w:styles xmlns:w="${W_NS}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr></w:rPr></w:style>${[["Heading1", "Heading 1", 40, 0], ["Heading2", "Heading 2", 32, 1], ["Heading3", "Heading 3", 28, 2]].map(([id, name, size, level]) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/><w:outlineLvl w:val="${level}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`).join("")}</w:styles>`;
  // Children of w:lvl in schema order (ECMA-376 §17.9.6): start, numFmt,
  // suff, lvlText, lvlJc, pPr. Each level hangs its marker 0.25in left of a
  // 0.5in step, which is Word's own default list indent.
  const BULLETS = ["•", "◦", "▪"];
  const levelXml = (kind: "bullet" | "numbered", start: number, level: number) =>
    `<w:lvl w:ilvl="${level}"><w:start w:val="${Math.max(0, Math.min(32767, start))}"/><w:numFmt w:val="${kind === "bullet" ? "bullet" : "decimal"}"/><w:suff w:val="tab"/><w:lvlText w:val="${kind === "bullet" ? BULLETS[level % BULLETS.length] : `%${level + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const numbering = lists.length ? `<w:numbering xmlns:w="${W_NS}">${lists.map((list, i) =>
    `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="multilevel"/>${Array.from({ length: 9 }, (_, level) => levelXml(list.kinds[level] ?? "bullet", list.starts[level] ?? 1, level)).join("")}</w:abstractNum>`).join("")}${lists.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`).join("")}</w:numbering>` : "";
  const relationships = `<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdStyles" Type="${OFFICE_REL}/styles" Target="styles.xml"/>${numbering ? `<Relationship Id="rIdNumbering" Type="${OFFICE_REL}/numbering" Target="numbering.xml"/>` : ""}${links.map((href, i) => `<Relationship Id="rIdLink${i + 1}" Type="${OFFICE_REL}/hyperlink" Target="${xmlAttr(href)}" TargetMode="External"/>`).join("")}</Relationships>`;
  const types = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${numbering ? `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` : ""}</Types>`;
  const parts: [string, string][] = [
    ["[Content_Types].xml", types],
    ["_rels/.rels", `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", document],
    ["word/_rels/document.xml.rels", relationships],
    ["word/styles.xml", styles],
    ...(numbering ? [["word/numbering.xml", numbering] as [string, string]] : []),
  ];
  const encoder = new TextEncoder();
  const bytes = writeZip(parts.map(([name, source]) => ({ name, data: encoder.encode(source) })), DEFAULT_ZIP_LIMITS);
  // The same check every Word save gets: Markie must be able to open what it wrote.
  const reopened = await openDocx(bytes);
  if (!reopened.canEdit) throw new Error("The Word file came out outside what Markie can open. Nothing was saved.");
  return bytes;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xmlText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlAttr = (text: string) => xmlText(text).replace(/"/g, "&quot;");

/** A line's runs, cut at every change of look, with linked stretches wrapped in w:hyperlink. */
function runsXml(line: RichLine, linkId: (href: string) => string): string {
  if (!line.text) return "";
  const cuts = new Set([0, line.text.length]);
  for (const span of line.spans) { cuts.add(span.start); cuts.add(span.end); }
  const points = [...cuts].sort((a, b) => a - b);
  let out = "";
  let openLink: string | undefined;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    const covering = line.spans.filter((s) => s.start <= start && s.end >= end);
    const bold = !!line.bold || covering.some((s) => s.bold);
    const italic = !!line.quote || covering.some((s) => s.italic);
    const code = line.role === "code" || covering.some((s) => s.code);
    const href = covering.find((s) => s.href)?.href;
    if (href !== openLink) {
      if (openLink) out += "</w:hyperlink>";
      if (href) out += `<w:hyperlink r:id="${linkId(href)}">`;
      openLink = href;
    }
    const properties = [
      code ? `<w:rFonts w:ascii="${CODE_FONT}" w:hAnsi="${CODE_FONT}" w:eastAsia="${CODE_FONT}" w:cs="${CODE_FONT}"/>` : "",
      bold ? `<w:b w:val="1"/>` : "",
      italic ? `<w:i w:val="1"/>` : "",
      href ? `<w:color w:val="${LINK_COLOR}"/>` : "",
      href ? `<w:u w:val="single"/>` : "",
    ].join("");
    out += `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlText(line.text.slice(start, end))}</w:t></w:r>`;
  }
  if (openLink) out += "</w:hyperlink>";
  return out;
}

function tableXml(rows: RichLine[][], linkId: (href: string) => string): string {
  const columns = rows[0].length;
  const cellWidth = Math.max(360, Math.floor(9360 / columns));
  const border = `w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"`;
  const grid = `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${cellWidth}"/>`).join("")}</w:tblGrid>`;
  const body = rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/></w:tcPr><w:p>${runsXml(cell, linkId)}</w:p></w:tc>`).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${cellWidth * columns}" w:type="dxa"/><w:tblBorders><w:top ${border}/><w:left ${border}/><w:bottom ${border}/><w:right ${border}/><w:insideH ${border}/><w:insideV ${border}/></w:tblBorders></w:tblPr>${grid}${body}</w:tbl>`;
}

function tabbedRow(cells: readonly Pick<RichLine, "text" | "spans">[], header: boolean): RichLine {
  let text = "";
  const spans: Span[] = [];
  cells.forEach((cell, c) => {
    if (c) text += "\t";
    const offset = text.length;
    text += cell.text;
    spans.push(...cell.spans.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset })));
  });
  return { text, spans, role: "body", bold: header };
}

// ── RTF and OpenDocument ──────────────────────────────────────────────────

const HEADING_POINTS = [24, 18, 15, 13, 12, 12];

async function blocksToFlatRich(format: "rtf" | "odt", blocks: readonly ExportBlock[]): Promise<Uint8Array> {
  const { createRichDocument, applyRichOperations, exportRichDocument } = await import("@/lib/office/rich-document");
  const flat = (content: readonly ExportInline[]) => lineFrom(content, { tabs: "\t", keep: () => true, address: () => true });
  const lines: RichLine[] = [];
  blocks.forEach((block, index) => {
    const start = lines.length;
    if (block.kind === "heading") lines.push({ ...flat(block.content), role: "heading", level: block.level });
    else if (block.kind === "paragraph") lines.push({ ...flat(block.content), role: "body", quote: block.quote });
    else if (block.kind === "item") {
      const line = flat(block.content);
      const marker = "    ".repeat(block.depth) + (block.ordered ? `${block.number}. ` : "• ") + (block.checked === true ? "☑ " : block.checked === false ? "☐ " : "");
      lines.push({ text: marker + line.text, spans: line.spans.map((s) => ({ ...s, start: s.start + marker.length, end: s.end + marker.length })), role: "item", quote: block.quote });
    } else if (block.kind === "code") lines.push(...codeLines(block.text, block.quote, "\t"));
    else if (block.kind === "rule") lines.push({ text: "* * *", spans: [], role: "rule" });
    else lines.push(...block.rows.map((row, r) => tabbedRow(row.map(flat), r === 0)));
    const group = block.kind === "item" ? `list${block.list}` : `block${index}`;
    for (let i = start; i < lines.length; i++) lines[i].group = group;
  });
  if (!lines.length) lines.push({ text: "", spans: [], role: "body" });

  let doc = await createRichDocument(format, lines.map((l) => l.text).join("\n"));
  if (doc.paragraphs.length !== lines.length) throw new Error("The writer did not keep one paragraph per line.");
  const operations: DocxOperation[] = [];
  doc.paragraphs.forEach((paragraph, i) => {
    const line = lines[i];
    const id = paragraph.id;
    const whole = (style: Parameters<typeof styleOf>[0]) => { if (line.text) operations.push({ type: "format-range", paragraphId: id, start: 0, end: line.text.length, style: styleOf(style) }); };
    if (line.role === "heading") {
      whole({ bold: true, size: HEADING_POINTS[(line.level ?? 1) - 1] });
      operations.push({ type: "format-paragraph", paragraphId: id, format: { spacingBeforePoints: 12, spacingAfterPoints: 6 } });
    }
    if (line.role === "rule") operations.push({ type: "format-paragraph", paragraphId: id, format: { alignment: "center" } });
    // A little room after each block, so paragraphs, lists and tables do not
    // run together; the lines inside one block stay tight.
    if (line.role !== "heading" && lines[i + 1]?.group !== line.group) operations.push({ type: "format-paragraph", paragraphId: id, format: { spacingAfterPoints: 6 } });
    if (line.bold) whole({ bold: true });
    if (line.quote) whole({ italic: true });
    for (const span of line.spans) {
      const style = styleOf({ bold: span.bold, italic: span.italic, code: span.code, link: !!span.href });
      if (Object.keys(style).length) operations.push({ type: "format-range", paragraphId: id, start: span.start, end: span.end, style });
    }
  });
  doc = applyRichOperations(doc, operations);
  return exportRichDocument(doc);
}

function styleOf({ bold, italic, code, link, size }: { bold?: boolean; italic?: boolean; code?: boolean; link?: boolean; size?: number }) {
  return {
    ...(bold ? { bold: true } : {}),
    ...(italic ? { italic: true } : {}),
    ...(code ? { fontFamily: CODE_FONT } : {}),
    ...(link ? { underline: "single", color: LINK_COLOR } : {}),
    ...(size ? { fontSizePoints: size } : {}),
  };
}

