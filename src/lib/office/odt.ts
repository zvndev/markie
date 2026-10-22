/** Original bounded ODF 1.2/1.3 text codec, from OASIS ODF 1.3 Parts 2 and 3.
 * https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part2-packages/OpenDocument-v1.3-os-part2-packages.html
 * https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html
 * No external document-engine implementation is used. Unsupported semantics
 * reject the import rather than becoming a silently flattened editable copy.
 * Editable paragraph spacing is 0–1000pt and line height 50–500%, matching the
 * shared rich-editing model; larger source values are rejected on import.
 */
import { DocxError, type DocxOperation, type DocxRunStyle, type DocxTextEdit } from "./docx-types";
import { createRichSnapshot, applySimpleRichOperations, rebaseSimpleRichDefaults, replaceSimpleRichText } from "./rich-text-model";
import type { NativeRichDocument, RichParagraphInput, RichRunInput } from "./rich-text-types";
import { escapeXmlText, parseXml, xmlAttribute, type XmlElement } from "./xml";
import { readZip, writeZip, validateZipPath, type ZipEntry } from "./zip";
import { appendOdtXml, odtPageProperties, odtPageStyles, readOdtPageGeometry, type OdtPageGeometry } from "./odt-page-layout";

const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const STYLE = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const FO = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
const SVG = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
const MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const MIME = "application/vnd.oasis.opendocument.text";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
interface State { original: Uint8Array; entries: ZipEntry[]; content: string; root: XmlElement; text: XmlElement; defaults: Resolved; geometry?: OdtPageGeometry; stylesRoot?: XmlElement; initial: NativeRichDocument }
const owned = new WeakMap<NativeRichDocument, State>();
function fail(message: string): never { throw new DocxError("unsupported-odt", message); }
function attrs(node: XmlElement, allowed: readonly string[]): void {
  if (node.attributes.some(a => a.namespace !== XMLNS && !allowed.includes(`${a.namespace}|${a.localName}`))) {
    fail(`Unsupported ODT attributes on ${node.localName}.`);
  }
}
const key = (ns: string, name: string) => `${ns}|${name}`;
const is = (node: XmlElement, ns: string, name: string) => node.namespace === ns && node.localName === name;
function only(node: XmlElement, ns: string, name: string, required = true): XmlElement | undefined {
  const children = node.children.filter(c => is(c, ns, name));
  if (children.length > 1 || (required && !children.length)) fail(`Missing or ambiguous ODT ${name}.`);
  return children[0];
}
function version(node: XmlElement): void {
  const value = xmlAttribute(node, "version", OFFICE);
  if (value !== "1.2" && value !== "1.3") fail("Only the bounded ODF 1.2/1.3 text subset is supported.");
}
function length(value: string, base?: number): number {
  const m = /^(\d+(?:\.\d+)?)(pt|in|cm|mm|pc|%)$/.exec(value);
  if (!m) fail("Unsupported ODT length.");
  const number = Number(m[1]);
  const factor = { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, "%": (base ?? NaN) / 100 }[m[2]]!;
  const result = number * factor;
  if (!Number.isFinite(result) || result > 2000) fail("ODT length is outside the supported bounds.");
  return result;
}
type Resolved = { run: DocxRunStyle; paragraph: Omit<RichParagraphInput, "runs"> };

function styleResolver(roots: readonly XmlElement[]) {
  const fonts = new Map<string, string>();
  const styles = new Map<string, XmlElement>();
  const defaults = new Map<string, XmlElement>();
  for (const root of roots) {
    for (const container of root.children) {
      if (is(container, OFFICE, "font-face-decls")) {
        attrs(container, []);
        if (container.text.trim()) fail("Invalid ODT font declarations.");
        for (const face of container.children) {
          if (!is(face, STYLE, "font-face") || face.children.length || face.text.trim()) fail("Unsupported ODT font declaration.");
          attrs(face, [key(STYLE, "name"), key(SVG, "font-family"), key(STYLE, "font-family-generic"), key(STYLE, "font-pitch")]);
          const name = xmlAttribute(face, "name", STYLE);
          const family = xmlAttribute(face, "font-family", SVG)?.replace(/^(['"])(.*)\1$/, "$2");
          if (!name || !family || family.length > 200 || /[,\x00-\x1f]/.test(family) || (fonts.has(name) && fonts.get(name) !== family)) fail("Ambiguous ODT font declaration.");
          fonts.set(name, family);
        }
      } else if (is(container, OFFICE, "styles") || is(container, OFFICE, "automatic-styles")) {
        attrs(container, []);
        if (container.text.trim()) fail("Invalid ODT style container.");
        for (const node of container.children) {
          if (is(container, OFFICE, "automatic-styles") && is(node, STYLE, "page-layout")) continue; // Validated separately, including unused layouts.
          if (!is(node, STYLE, "style") && !is(node, STYLE, "default-style")) fail("Unsupported ODT style kind.");
          const family = xmlAttribute(node, "family", STYLE);
          if (family !== "paragraph" && family !== "text") fail("Unsupported ODT style family.");
          attrs(node, [key(STYLE, "family"), key(STYLE, "name"), key(STYLE, "display-name"), key(STYLE, "parent-style-name"), key(STYLE, "next-style-name"), key(STYLE, "master-page-name")]);
          const master = xmlAttribute(node, "master-page-name", STYLE);
          // Even the same master forces a page break when applied to a
          // paragraph. Until those boundaries are represented, reject every
          // reference, including inherited, unused and first-paragraph styles.
          if (master !== undefined) fail("Unsupported ODT master-page switch or forced page break.");
          const name = xmlAttribute(node, "name", STYLE);
          const map = is(node, STYLE, "default-style") ? defaults : styles;
          const id = is(node, STYLE, "default-style") ? family : `${family}|${name}`;
          if ((!name && map === styles) || map.has(id)) fail("Missing or duplicate ODT style.");
          map.set(id, node);
        }
      }
    }
  }
  function apply(node: XmlElement, base: Resolved): Resolved {
    if (node.text.trim()) fail("Invalid ODT style content.");
    const run: { -readonly [K in keyof DocxRunStyle]: DocxRunStyle[K] } = { ...base.run };
    const paragraph = { ...base.paragraph };
    const seen = new Set<string>();
    for (const properties of node.children) {
      if (properties.text.trim()) fail("Invalid ODT property content.");
      if (seen.has(properties.localName)) fail("Duplicate ODT style properties.");
      seen.add(properties.localName);
      if (is(properties, STYLE, "text-properties")) {
        if (properties.children.length) fail("Unsupported ODT text properties.");
        attrs(properties, [key(FO, "font-weight"), key(FO, "font-style"), key(FO, "font-size"), key(FO, "font-family"), key(FO, "color"), key(STYLE, "font-name"), key(STYLE, "text-underline-style"), key(STYLE, "text-underline-type"), key(STYLE, "text-underline-color")]);
        const weight = xmlAttribute(properties, "font-weight", FO);
        if (weight !== undefined) { if (!["normal", "bold", "400", "700"].includes(weight)) fail("Unsupported ODT font weight."); run.bold = weight === "bold" || weight === "700"; }
        const italic = xmlAttribute(properties, "font-style", FO);
        if (italic !== undefined) { if (italic !== "normal" && italic !== "italic") fail("Unsupported ODT font style."); run.italic = italic === "italic"; }
        const size = xmlAttribute(properties, "font-size", FO);
        if (size !== undefined) { run.fontSizePoints = length(size, base.run.fontSizePoints); if (run.fontSizePoints < 1 || run.fontSizePoints > 400) fail("Unsupported ODT font size."); }
        const name = xmlAttribute(properties, "font-name", STYLE);
        const family = xmlAttribute(properties, "font-family", FO);
        if (name !== undefined || family !== undefined) {
          const value = name !== undefined ? fonts.get(name) : family?.replace(/^(['"])(.*)\1$/, "$2");
          if (!value || value.length > 200 || /[,\x00-\x1f]/.test(value)) fail("Unsupported or missing ODT font.");
          run.fontFamily = value;
        }
        const color = xmlAttribute(properties, "color", FO);
        if (color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(color)) fail("Unsupported ODT text color."); run.color = color.slice(1); }
        const underline = xmlAttribute(properties, "text-underline-style", STYLE);
        const underlineType = xmlAttribute(properties, "text-underline-type", STYLE);
        const underlineColor = xmlAttribute(properties, "text-underline-color", STYLE);
        if (underlineType !== undefined && underlineType !== "single") fail("Unsupported ODT underline type.");
        if (underlineColor !== undefined && underlineColor !== "font-color") fail("Unsupported ODT underline color.");
        if (underline !== undefined) { if (underline !== "none" && underline !== "solid") fail("Unsupported ODT underline style."); run.underline = underline === "solid" ? "single" : "none"; }
      } else if (is(properties, STYLE, "paragraph-properties")) {
        if (xmlAttribute(node, "family", STYLE) !== "paragraph") fail("ODT text styles cannot carry paragraph properties.");
        if (properties.children.length) fail("Unsupported ODT paragraph properties.");
        attrs(properties, [key(FO, "text-align"), key(FO, "margin-top"), key(FO, "margin-bottom"), key(FO, "line-height")]);
        const align = xmlAttribute(properties, "text-align", FO);
        if (align !== undefined) {
          if (!["left", "right", "center", "justify"].includes(align)) fail("Unsupported ODT paragraph alignment.");
          paragraph.alignment = align === "justify" ? "both" : align;
        }
        const before = xmlAttribute(properties, "margin-top", FO), after = xmlAttribute(properties, "margin-bottom", FO);
        if (before !== undefined) { paragraph.spacingBeforePoints = length(before); if (paragraph.spacingBeforePoints > 1000) fail("ODT paragraph spacing exceeds the supported 1000-point limit."); }
        if (after !== undefined) { paragraph.spacingAfterPoints = length(after); if (paragraph.spacingAfterPoints > 1000) fail("ODT paragraph spacing exceeds the supported 1000-point limit."); }
        const line = xmlAttribute(properties, "line-height", FO);
        if (line !== undefined) {
          if (!/^\d+(?:\.\d+)?%$/.test(line)) fail("Unsupported ODT line height.");
          paragraph.lineSpacingMultiple = Number(line.slice(0, -1)) / 100;
          if (paragraph.lineSpacingMultiple < 0.5 || paragraph.lineSpacingMultiple > 5) fail("ODT line height is outside the supported 50–500% range.");
        }
      } else fail("Unsupported ODT style properties.");
    }
    return { run, paragraph };
  }
  function resolve(family: string, name: string | undefined, base: Resolved): Resolved {
    const chain: XmlElement[] = [];
    const seen = new Set<string>();
    for (let current = name; current;) {
      if (seen.has(current) || seen.size >= 128) fail("Cyclic or excessively deep ODT style inheritance.");
      seen.add(current);
      const node = styles.get(`${family}|${current}`);
      if (!node) fail("Missing ODT named style.");
      chain.unshift(node);
      current = xmlAttribute(node, "parent-style-name", STYLE);
    }
    let result = base;
    const fallback = defaults.get(family);
    if (fallback) {
      const resolved = apply(fallback, { run: {}, paragraph: {} });
      // Family defaults fill only missing properties. A nested span inherits
      // its enclosing span/paragraph before consulting family defaults.
      result = { run: { ...resolved.run, ...base.run }, paragraph: { ...resolved.paragraph, ...base.paragraph } };
    }
    for (const node of chain) result = apply(node, result);
    return result;
  }
  // Validate unused styles too: edits must not hide unsupported document semantics.
  for (const [id, node] of styles) resolve(id.split("|")[0], xmlAttribute(node, "name", STYLE), { run: { fontSizePoints: 12 }, paragraph: {} });
  for (const node of defaults.values()) apply(node, { run: {}, paragraph: {} });
  return resolve;
}

function readParagraph(node: XmlElement, source: string, resolve: ReturnType<typeof styleResolver>, budget: { characters: number }): RichParagraphInput {
  attrs(node, [key(TEXT, "style-name")]);
  const base = resolve("paragraph", xmlAttribute(node, "style-name", TEXT), { run: {}, paragraph: {} });
  const runs: RichRunInput[] = [];
  let pending: DocxRunStyle | undefined;
  function requireRoom(count: number) {
    if (budget.characters + count > 1_000_000) fail("ODT decoded text exceeds the supported character limit.");
  }
  function emit(text: string, style: DocxRunStyle) {
    if (!text) return;
    requireRoom(text.length);
    budget.characters += text.length;
    const previous = runs[runs.length - 1];
    if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) runs[runs.length - 1] = { text: previous.text + text, style };
    else runs.push({ text, style });
  }
  function literal(text: string, style: DocxRunStyle) {
    for (const token of text.split(/([ \t\r\n]+)/)) {
      if (!token) continue;
      if (/^[ \t\r\n]+$/.test(token)) pending ??= style;
      else { if (pending && runs.length) emit(" ", pending); pending = undefined; emit(token, style); }
    }
  }
  function explicit(text: string, style: DocxRunStyle) {
    if (pending && runs.length) emit(" ", pending);
    pending = undefined;
    emit(text, style);
  }
  function visit(element: XmlElement, style: DocxRunStyle) {
    let cursor = element.startTagEnd;
    for (const child of element.children) {
      literal(parseXml(`<x>${source.slice(cursor, child.start)}</x>`).text, style);
      if (is(child, TEXT, "span")) {
        attrs(child, [key(TEXT, "style-name")]);
        const resolved = resolve("text", xmlAttribute(child, "style-name", TEXT), { run: style, paragraph: {} });
        visit(child, resolved.run);
      } else if (is(child, TEXT, "s")) {
        attrs(child, [key(TEXT, "c")]);
        const count = xmlAttribute(child, "c", TEXT) ?? "1";
        if (!/^\d{1,6}$/.test(count) || Number(count) < 1 || Number(count) > 100000 || child.children.length || child.text) fail("Invalid ODT explicit spaces.");
        requireRoom(Number(count) + (pending && runs.length ? 1 : 0));
        explicit(" ".repeat(Number(count)), style);
      } else if (is(child, TEXT, "tab") || is(child, TEXT, "line-break")) {
        attrs(child, []);
        if (child.children.length || child.text) fail("Invalid ODT whitespace element.");
        explicit(child.localName === "tab" ? "\t" : "\n", style);
      } else fail(`Unsupported ODT inline ${child.localName}; original file was not converted.`);
      cursor = child.end;
    }
    if (element.endTagStart >= element.startTagEnd) literal(parseXml(`<x>${source.slice(cursor, element.endTagStart)}</x>`).text, style);
  }
  visit(node, base.run);
  return { ...base.paragraph, runs: runs.length ? runs : [{ text: "", style: base.run }] };
}

export async function openOdt(input: Uint8Array): Promise<NativeRichDocument> {
  const original = new Uint8Array(input);
  const view = new DataView(original.buffer);
  if (original.length < 38 || view.getUint32(0, true) !== 0x04034b50 || view.getUint16(8, true) !== 0
    || view.getUint16(26, true) !== 8 || view.getUint16(28, true) !== 0 || utf8.decode(original.slice(30, 38)) !== "mimetype") {
    fail("ODT requires mimetype as the first, uncompressed ZIP entry without an extra field.");
  }
  const entries = await readZip(original);
  const parts = new Map(entries.map(e => [e.name, e.data]));
  if (utf8.decode(parts.get("mimetype")) !== MIME) fail("This package is not an ODT text document.");
  if (entries.some(e => /^(?:META-INF\/.*signatures|Basic\/|Scripts\/|Object(?:\d+)?(?:\/|$))/i.test(e.name))) fail("Signed, executable and embedded-object ODT packages are unsupported.");
  const manifestBytes = parts.get("META-INF/manifest.xml");
  if (!manifestBytes) fail("ODT manifest is missing.");
  const manifest = parseXml(utf8.decode(manifestBytes));
  if (!is(manifest, MANIFEST, "manifest")) fail("Invalid ODT manifest namespace.");
  attrs(manifest, [key(MANIFEST, "version")]);
  if (manifest.text.trim()) fail("Invalid ODT manifest content.");
  const declarations = new Map<string, string>();
  for (const entry of manifest.children) {
    if (!is(entry, MANIFEST, "file-entry") || entry.children.length || entry.text.trim()) fail("Encrypted or unsupported ODT manifest entries are unsupported.");
    attrs(entry, [key(MANIFEST, "full-path"), key(MANIFEST, "media-type"), key(MANIFEST, "version")]);
    const path = xmlAttribute(entry, "full-path", MANIFEST), media = xmlAttribute(entry, "media-type", MANIFEST);
    if (!path || media === undefined || declarations.has(path) || path === "mimetype" || path === "META-INF/manifest.xml") fail("Invalid or duplicate ODT manifest entry.");
    if (path !== "/") { validateZipPath(path); if (!parts.has(path) && !path.endsWith("/")) fail("ODT manifest references a missing part."); }
    declarations.set(path, media);
  }
  if (declarations.get("/") !== MIME || declarations.get("content.xml") !== "text/xml") fail("ODT manifest media types do not match the text document.");
  for (const entry of entries) if (entry.name !== "mimetype" && !entry.name.startsWith("META-INF/") && !entry.name.endsWith("/") && !declarations.has(entry.name)) fail("ODT package has an undeclared file.");
  const contentBytes = parts.get("content.xml");
  if (!contentBytes) fail("ODT content is missing.");
  const content = utf8.decode(contentBytes), root = parseXml(content);
  if (!is(root, OFFICE, "document-content")) fail("Invalid ODT content root.");
  version(root); attrs(root, [key(OFFICE, "version")]);
  for (const child of root.children) if (!["font-face-decls", "automatic-styles", "body"].some(name => is(child, OFFICE, name))) fail("Unsupported ODT content structure.");
  only(root, OFFICE, "font-face-decls", false); only(root, OFFICE, "automatic-styles", false);
  if (root.children.at(-1)?.localName !== "body" || root.text.trim()) fail("Unsupported ODT content order.");
  const body = only(root, OFFICE, "body")!; attrs(body, []);
  if (body.children.length !== 1 || body.text.trim()) fail("Unsupported ODT document body.");
  const text = only(body, OFFICE, "text")!; attrs(text, []);
  if (text.text.trim()) fail("ODT body text must be inside paragraphs.");
  const roots = [root];
  let stylesRoot: XmlElement | undefined;
  if (parts.has("styles.xml")) {
    if (declarations.get("styles.xml") !== "text/xml") fail("Invalid ODT styles media type.");
    const styles = parseXml(utf8.decode(parts.get("styles.xml")));
    if (!is(styles, OFFICE, "document-styles")) fail("Invalid ODT styles root.");
    version(styles); attrs(styles, [key(OFFICE, "version")]);
    if (styles.text.trim()) fail("Invalid ODT styles document content.");
    only(styles, OFFICE, "font-face-decls", false); only(styles, OFFICE, "styles", false); only(styles, OFFICE, "automatic-styles", false); only(styles, OFFICE, "master-styles", false);
    for (const child of styles.children) if (!["font-face-decls", "styles", "automatic-styles", "master-styles"].some(name => is(child, OFFICE, name))) fail("Unsupported ODT page, master or style structure.");
    stylesRoot = styles;
    roots.unshift(styles);
  }
  const geometry = readOdtPageGeometry(roots);
  const resolve = styleResolver(roots);
  const budget = { characters: 0 };
  if (text.children.length > 10000) fail("ODT paragraph count exceeds the supported limit.");
  const paragraphs = text.children.map((node, index) => {
    if (index) budget.characters++;
    if (!is(node, TEXT, "p")) fail(`Unsupported ODT block ${node.localName}; original file was not converted.`);
    return readParagraph(node, content, resolve, budget);
  });
  const document = createRichSnapshot("odt", paragraphs.length ? paragraphs : [{ runs: [{ text: "" }] }], { pageLayout: geometry?.layout, diagnostics: [{ code: "odt-bounded-rich-text", severity: "info", message: "ODT rich text supports paragraphs, fonts, colors, basic emphasis, spacing and a single static page layout. Complex layouts and interactive content are not converted." }] });
  const defaults = resolve("text", undefined, resolve("paragraph", undefined, { run: {}, paragraph: {} }));
  owned.set(document, { original, entries, content, root, text, defaults, geometry, stylesRoot, initial: document });
  return document;
}

function stateFor(document: NativeRichDocument): State {
  const state = owned.get(document);
  if (!state || document.format !== "odt") throw new DocxError("foreign-document", "ODT operations require an original ODT session.");
  return state;
}
/** Ownership, not structural equality, authorizes replacing a session snapshot. */
export function isSameOdtSource(first: NativeRichDocument, second: NativeRichDocument): boolean {
  const state = owned.get(first);
  return state !== undefined && state === owned.get(second);
}
/** Clearing direct formatting exposes the retained ODF defaults. Keep those
 * effective values visible immediately, not only after export/reopen. The same
 * rule applies to newly inserted paragraphs. Styles.xml is never discarded. */
function resolveDefaults(document: NativeRichDocument, state: State): NativeRichDocument {
  return rebaseSimpleRichDefaults(document, state.defaults);
}
export function applyOdtOperations(document: NativeRichDocument, operations: readonly DocxOperation[]): NativeRichDocument {
  const state = stateFor(document);
  for (const operation of operations) {
    if ((operation.type === "insert-paragraph" || operation.type === "replace-paragraph") && operation.text.includes("\r")) fail("ODT uses line-feed characters for line breaks; literal carriage returns are unsupported.");
    if (operation.type === "format-run" || operation.type === "format-range") {
      if (operation.style.color === "auto") fail("Automatic system text color is not supported by this ODT subset; choose a color or clear direct formatting.");
      if (operation.style.underline != null && !["none", "single"].includes(operation.style.underline)) fail("This ODT subset supports single underline only.");
      if (operation.style.fontFamily != null && /[,]/.test(operation.style.fontFamily)) fail("This ODT subset requires one font family.");
    }
  }
  const edited = applySimpleRichOperations(document, operations);
  const next = edited === document ? document : operations.every(op => op.type === "set-page-layout") ? edited : resolveDefaults(edited, state);
  owned.set(next, state); return next;
}
export function replaceOdtText(document: NativeRichDocument, edits: readonly DocxTextEdit[]): NativeRichDocument {
  const state = stateFor(document);
  if (edits.some(edit => edit.text.includes("\r"))) fail("ODT uses line-feed characters for line breaks; literal carriage returns are unsupported.");
  const edited = replaceSimpleRichText(document, edits);
  const next = edited === document ? document : resolveDefaults(edited, state); owned.set(next, state); return next;
}
function serializeText(text: string): string {
  const pieces: string[] = [];
  for (const match of text.matchAll(/ +|\t|\n|\r|[^ \t\n\r]+/g)) {
    const token = match[0];
    if (token[0] === " ") {
      // Keep generated text within the same parser/node budgets as its source.
      // Each count is bounded to the reader's preallocation limit.
      for (let remaining = token.length; remaining > 0;) {
        const count = Math.min(remaining, 100000);
        pieces.push(count === 1 ? "<text:s/>" : `<text:s text:c="${count}"/>`);
        remaining -= count;
      }
    } else pieces.push(token === "\t" ? "<text:tab/>" : token === "\n" ? "<text:line-break/>" : token === "\r" ? "&#13;" : escapeXmlText(token));
  }
  return pieces.join("");
}
function editedOdtContent(document: NativeRichDocument, state: State): string {
  const namespaces = `xmlns:office="${OFFICE}" xmlns:text="${TEXT}" xmlns:style="${STYLE}" xmlns:fo="${FO}"`;
  // Generated names avoid every original style name, including unused styles.
  let prefix = "Markie";
  while (state.content.includes(prefix) || state.entries.some(e => e.name === "styles.xml" && utf8.decode(e.data).includes(prefix))) prefix += "_";
  const styles: string[] = [];
  const paragraphs = document.paragraphs.map((p, i) => {
    const name = `${prefix}P${i}`;
    const alignment = p.alignment === "both" ? "justify" : p.alignment;
    const props = [alignment ? `fo:text-align="${escapeXmlText(alignment)}"` : "",
      p.spacingBeforePoints !== undefined ? `fo:margin-top="${p.spacingBeforePoints}pt"` : "",
      p.spacingAfterPoints !== undefined ? `fo:margin-bottom="${p.spacingAfterPoints}pt"` : "",
      p.lineSpacingMultiple !== undefined ? `fo:line-height="${p.lineSpacingMultiple * 100}%"` : ""].filter(Boolean).join(" ");
    styles.push(`<style:style ${namespaces} style:name="${name}" style:family="paragraph"><style:paragraph-properties ${props}/></style:style>`);
    const runs = p.runs.map((r, j) => {
      const runName = `${prefix}T${i}_${j}`, s = r.style;
      const properties = [`fo:font-weight="${s.bold ? "bold" : "normal"}"`, `fo:font-style="${s.italic ? "italic" : "normal"}"`,
        `style:text-underline-style="${s.underline && s.underline !== "none" ? "solid" : "none"}"`,
        s.fontFamily ? `fo:font-family="${escapeXmlText(s.fontFamily).replace(/"/g, "&quot;")}"` : "",
        s.fontSizePoints !== undefined ? `fo:font-size="${s.fontSizePoints}pt"` : "", s.color ? `fo:color="#${s.color}"` : ""].filter(Boolean).join(" ");
      styles.push(`<style:style ${namespaces} style:name="${runName}" style:family="text"><style:text-properties ${properties}/></style:style>`);
      return `<text:span text:style-name="${runName}">${serializeText(r.text)}</text:span>`;
    }).join("");
    return `<text:p text:style-name="${name}">${runs}</text:p>`;
  }).join("");
  const text = `<office:text ${namespaces}>${paragraphs}</office:text>`;
  let content = state.content.slice(0, state.text.start) + text + state.content.slice(state.text.end);
  const automatic = only(state.root, OFFICE, "automatic-styles", false);
  if (automatic) {
    const existing = automatic.endTagStart < automatic.startTagEnd ? "" : state.content.slice(automatic.startTagEnd, automatic.endTagStart);
    const opening = state.content.slice(automatic.start, automatic.startTagEnd).replace(/\/>$/, ">");
    const replacement = `${opening}${existing}${styles.join("")}</${automatic.name}>`;
    content = content.slice(0, automatic.start) + replacement + content.slice(automatic.end);
  } else {
    const body = only(state.root, OFFICE, "body")!;
    content = content.slice(0, body.start) + `<office:automatic-styles ${namespaces}>${styles.join("")}</office:automatic-styles>` + content.slice(body.start);
  }
  return content;
}
export async function exportOdt(document: NativeRichDocument): Promise<Uint8Array> {
  const state = stateFor(document);
  if (!document.modified) return new Uint8Array(state.original);
  const namespaces = `xmlns:office="${OFFICE}" xmlns:text="${TEXT}" xmlns:style="${STYLE}" xmlns:fo="${FO}"`;
  const bodyChanged = document.paragraphs.length !== state.initial.paragraphs.length || document.paragraphs.some((p, i) => p !== state.initial.paragraphs[i]);
  const layoutChanged = JSON.stringify(document.pageLayout) !== JSON.stringify(state.initial.pageLayout);
  if (!bodyChanged && !layoutChanged) return new Uint8Array(state.original);
  const content = bodyChanged ? editedOdtContent(document, state) : state.content;
  let entries = state.entries.map(entry => entry.name === "content.xml" ? { name: entry.name, data: encoder.encode(content) } : entry);
  if (layoutChanged) {
    const oldStyles = state.entries.find(e => e.name === "styles.xml");
    let styles = oldStyles ? utf8.decode(oldStyles.data) : `<office:document-styles ${namespaces} office:version="${xmlAttribute(state.root, "version", OFFICE)}"/>`;
    if (state.geometry) {
      const node = state.geometry.properties;
      styles = styles.slice(0, node.start) + odtPageProperties(document.pageLayout) + styles.slice(node.end);
    } else {
      let name = "MarkiePage";
      while (styles.includes(name) || state.content.includes(name)) name += "_";
      const generated = odtPageStyles(document.pageLayout, name);
      const root = state.stylesRoot ?? parseXml(styles);
      const automatic = only(root, OFFICE, "automatic-styles", false);
      const masters = only(root, OFFICE, "master-styles", false);
      // Empty existing containers are expanded rather than duplicated.
      if (!automatic && !masters) styles = appendOdtXml(styles, root, `<office:automatic-styles ${namespaces}>${generated.automatic}</office:automatic-styles>${generated.master}`);
      else {
        if (!masters) styles = appendOdtXml(styles, root, generated.master);
        else styles = appendOdtXml(styles, masters, parseXml(generated.master).children.map(n => generated.master.slice(n.start, n.end)).join(""));
        // Reparse after insertion: the root/container may have been self-closing.
        const updatedRoot = parseXml(styles);
        const updatedAutomatic = only(updatedRoot, OFFICE, "automatic-styles", false);
        if (updatedAutomatic) styles = appendOdtXml(styles, updatedAutomatic, generated.automatic);
        else {
          const updatedMaster = only(updatedRoot, OFFICE, "master-styles")!;
          styles = styles.slice(0, updatedMaster.start) + `<office:automatic-styles ${namespaces}>${generated.automatic}</office:automatic-styles>` + styles.slice(updatedMaster.start);
        }
      }
    }
    if (oldStyles) entries = entries.map(e => e.name === "styles.xml" ? { name: e.name, data: encoder.encode(styles) } : e);
    else {
      entries.push({ name: "styles.xml", data: encoder.encode(styles) });
      entries = entries.map(e => {
        if (e.name !== "META-INF/manifest.xml") return e;
        const source = utf8.decode(e.data), root = parseXml(source);
        return { name: e.name, data: encoder.encode(appendOdtXml(source, root, `<manifest:file-entry xmlns:manifest="${MANIFEST}" manifest:full-path="styles.xml" manifest:media-type="text/xml"/>`)) };
      });
    }
  }
  const output = writeZip([entries.find(entry => entry.name === "mimetype")!, ...entries.filter(entry => entry.name !== "mimetype")]);
  // Never hand an unreopenable or text-lossy edited candidate to persistence.
  // This applies the same XML/node/decoded-text limits used for user imports.
  const verification = await openOdt(output);
  if (verification.text !== document.text) fail("Edited ODT failed same-format text verification; the source was not overwritten.");
  for (const field of Object.keys(document.pageLayout) as (keyof typeof document.pageLayout)[]) {
    const actual = verification.pageLayout[field], expected = document.pageLayout[field];
    if (typeof actual === "number" && typeof expected === "number" ? Math.abs(actual - expected) > 0.000001 : actual !== expected) fail("Edited ODT failed same-format page-layout verification; the source was not overwritten.");
  }
  return output;
}

export async function createOdt(text = ""): Promise<NativeRichDocument> {
  if (text.includes("\r")) fail("ODT uses line-feed characters for line breaks; literal carriage returns are unsupported.");
  const namespaces = `xmlns:office="${OFFICE}" xmlns:text="${TEXT}" xmlns:style="${STYLE}" xmlns:fo="${FO}"`;
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${namespaces} office:version="1.3"><office:body><office:text>${text.split("\n").map(p => `<text:p>${serializeText(p)}</text:p>`).join("")}</office:text></office:body></office:document-content>`;
  const layout = odtPageStyles({ widthPoints: 612, heightPoints: 792, orientation: "portrait", marginTopPoints: 72, marginRightPoints: 72, marginBottomPoints: 72, marginLeftPoints: 72 });
  const styles = `<office:document-styles ${namespaces} office:version="1.3"><office:automatic-styles>${layout.automatic}</office:automatic-styles>${layout.master}</office:document-styles>`;
  const manifest = `<manifest:manifest xmlns:manifest="${MANIFEST}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return openOdt(writeZip([{ name: "mimetype", data: encoder.encode(MIME) }, { name: "content.xml", data: encoder.encode(content) }, { name: "styles.xml", data: encoder.encode(styles) }, { name: "META-INF/manifest.xml", data: encoder.encode(manifest) }]));
}
