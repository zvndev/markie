import { DocxError, type DocxNamedStyle, type DocxRunStyle, type DocxParagraphFormat } from "./docx-types";
import { escapeXmlText, parseXml, xmlAttribute, type XmlElement } from "./xml";
import { type ZipEntry } from "./zip";
import { isWord, wordChild, type DocxEditState } from "./docx-edit";

export const DOCX_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
export const DOCX_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const DOCX_R_STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export interface DocxPartsState {
  entries: readonly ZipEntry[];
  mainPart: string;
  partOverrides: Map<string, Uint8Array>;
  deletedParts?: ReadonlySet<string>;
}

export function docxPart(state: DocxPartsState, name: string): Uint8Array | undefined {
  if (state.deletedParts?.has(name)) return undefined;
  return state.partOverrides.get(name) ?? state.entries.find((p) => p.name === name)?.data;
}
export function docxPartSource(state: DocxPartsState, name: string): string | undefined {
  const bytes = docxPart(state, name);
  return bytes && decoder.decode(bytes);
}
export function docxEntries(state: DocxPartsState): ZipEntry[] {
  const parts = new Map(state.entries.filter((p) => !state.deletedParts?.has(p.name)).map((p) => [p.name, p.data]));
  for (const [name, data] of state.partOverrides) if (!state.deletedParts?.has(name)) parts.set(name, data);
  return [...parts].map(([name, data]) => ({ name, data }));
}
export function docxRelationshipsPart(mainPart: string): string {
  const slash = mainPart.lastIndexOf("/");
  return `${mainPart.slice(0, slash + 1)}_rels/${mainPart.slice(slash + 1)}.rels`;
}
export function appendDocxXml(source: string, content: string): string {
  const root = parseXml(source);
  if (root.endTagStart < root.startTagEnd) return source.slice(0, root.start) + source.slice(root.start, root.startTagEnd).replace(/\/>$/, ">") + content + `</${root.name}>` + source.slice(root.end);
  return source.slice(0, root.endTagStart) + content + source.slice(root.endTagStart);
}
export function xmlAttributeText(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}
/** Existing packages may declare root .rels only with an Override. A newly
 * created main relationship part therefore needs its own declaration. */
export function declareDocxRelationshipPart(manifest: string, name: string): string {
  const type = "application/vnd.openxmlformats-package.relationships+xml";
  const declared = parseXml(manifest).children.some((n) => (n.localName === "Override" && xmlAttribute(n, "PartName") === `/${name}` && xmlAttribute(n, "ContentType") === type)
    || (n.localName === "Default" && xmlAttribute(n, "Extension")?.toLowerCase() === "rels" && xmlAttribute(n, "ContentType") === type));
  return declared ? manifest : appendDocxXml(manifest, `<Override xmlns="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/${xmlAttributeText(name)}" ContentType="${type}"/>`);
}
export function relatedDocxPart(state: DocxPartsState, kind: string): string | undefined {
  const source = docxPartSource(state, docxRelationshipsPart(state.mainPart));
  if (!source) return undefined;
  const root = parseXml(source);
  const node = root.children.find((n) => [DOCX_R, DOCX_R_STRICT].some((r) => xmlAttribute(n, "Type") === `${r}/${kind}`));
  if (!node) return undefined;
  const target = xmlAttribute(node, "Target")!;
  if (target.startsWith("/")) return target.slice(1);
  const segments = state.mainPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}
export function ensureDocxPart(state: DocxPartsState, kind: "styles" | "comments" | "numbering", contentType: string, content: string, namespace: string): { state: DocxPartsState; name: string } {
  const existing = relatedDocxPart(state, kind);
  if (existing) return { state, name: existing };
  const directory = state.mainPart.slice(0, state.mainPart.lastIndexOf("/") + 1);
  let name = `${directory}${kind}.xml`;
  for (let n = 1; docxPart(state, name); n++) name = `${directory}markie-${kind}-${n}.xml`;
  const relName = docxRelationshipsPart(state.mainPart);
  const relSource = docxPartSource(state, relName) || `<Relationships xmlns="${DOCX_REL}"/>`;
  const ids = new Set(parseXml(relSource).children.map((node) => xmlAttribute(node, "Id")));
  let id = "rIdMarkie1";
  for (let n = 2; ids.has(id); n++) id = `rIdMarkie${n}`;
  const r = namespace.includes("purl.oclc.org") ? DOCX_R_STRICT : DOCX_R;
  const overrides = new Map(state.partOverrides);
  overrides.set(name, encoder.encode(content));
  overrides.set(relName, encoder.encode(appendDocxXml(relSource, `<Relationship xmlns="${DOCX_REL}" Id="${id}" Type="${r}/${kind}" Target="${name.slice(directory.length)}"/>`)));
  const manifest = docxPartSource(state, "[Content_Types].xml")!;
  const updatedManifest = declareDocxRelationshipPart(appendDocxXml(manifest, `<Override xmlns="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/${xmlAttributeText(name)}" ContentType="${contentType}"/>`), relName);
  overrides.set("[Content_Types].xml", encoder.encode(updatedManifest));
  return { state: { ...state, partOverrides: overrides }, name };
}

export const BUILTIN_DOCX_STYLES: Readonly<Record<string, { name: string; size?: number; bold?: boolean }>> = Object.freeze({
  Normal: { name: "Normal" }, Title: { name: "Title", size: 56 }, Subtitle: { name: "Subtitle", size: 32 },
  Heading1: { name: "Heading 1", size: 40, bold: true }, Heading2: { name: "Heading 2", size: 32, bold: true }, Heading3: { name: "Heading 3", size: 28, bold: true },
});

export function readDocxStyles(state: DocxPartsState): readonly DocxNamedStyle[] {
  const name = relatedDocxPart(state, "styles");
  const source = name && docxPartSource(state, name);
  if (!source) return Object.freeze([]);
  const root = parseXml(source);
  return Object.freeze(root.children.filter((n) => isWord(n, "style") && xmlAttribute(n, "type", n.namespace) === "paragraph").map((n) => Object.freeze({
    id: xmlAttribute(n, "styleId", n.namespace) || "", name: xmlAttribute(n.children.find((c) => isWord(c, "name")) || n, "val", n.namespace) || "",
  })).filter((style) => style.id));
}

const wordValue = (node: XmlElement | undefined, attribute = "val") => node && xmlAttribute(node, attribute, node.namespace);

/** Original, bounded resolution of the supported ECMA-376 properties only.
 * Theme fonts, numbering/table styles and layout are not inferred here. */
export function readDocxRunStyle(props: XmlElement | undefined): DocxRunStyle {
  const onOff = (name: string) => {
    const property = wordChild(props, name);
    return property ? !["false", "0", "off"].includes(wordValue(property) || "true") : undefined;
  };
  const size = wordValue(wordChild(props, "sz"));
  const font = wordChild(props, "rFonts"), underline = wordChild(props, "u");
  return Object.fromEntries(Object.entries({
    bold: onOff("b"), italic: onOff("i"), underline: underline ? wordValue(underline) ?? "single" : undefined,
    color: wordValue(wordChild(props, "color")), fontFamily: wordValue(font, "ascii") ?? wordValue(font, "hAnsi"),
    fontSizePoints: size && /^\d+$/.test(size) ? Number(size) / 2 : undefined,
  }).filter(([, value]) => value !== undefined));
}

function readParagraphStyle(props: XmlElement | undefined): DocxParagraphFormat {
  const spacing = wordChild(props, "spacing");
  const amount = (name: string, divisor: number) => {
    const text = wordValue(spacing, name);
    return text && /^\d+$/.test(text) ? Number(text) / divisor : undefined;
  };
  return Object.fromEntries(Object.entries({
    alignment: wordValue(wordChild(props, "jc")), spacingBeforePoints: amount("before", 20), spacingAfterPoints: amount("after", 20),
    lineSpacingMultiple: [undefined, "auto"].includes(wordValue(spacing, "lineRule")) ? amount("line", 240) : null,
  }).filter(([, value]) => value !== undefined));
}

export function docxStyleResolver(state: DocxPartsState) {
  const name = relatedDocxPart(state, "styles"), source = name && docxPartSource(state, name);
  const root = source ? parseXml(source) : undefined;
  const definitions = root?.children.filter((node) => isWord(node, "style")) ?? [];
  const styles = new Map(definitions.map((node) => [`${wordValue(node, "type")}:${wordValue(node, "styleId")}`, node]));
  const defaults = wordChild(root, "docDefaults");
  const defaultRunProps = wordChild(wordChild(defaults, "rPrDefault"), "rPr");
  const baseRun = readDocxRunStyle(defaultRunProps);
  const baseParagraph = readParagraphStyle(wordChild(wordChild(defaults, "pPrDefault"), "pPr"));
  const defaultId = (type: string) => wordValue(definitions.find((node) => wordValue(node, "type") === type && ["1", "true", "on"].includes(wordValue(node, "default") ?? "")), "styleId");
  const defaultParagraph = defaultId("paragraph"), defaultCharacter = defaultId("character");
  const cache = new Map<string, readonly XmlElement[]>();
  const chain = (type: string, id: string | undefined): readonly XmlElement[] => {
    const key = `${type}:${id ?? ""}`, cached = cache.get(key);
    if (cached) return cached;
    const nodes: XmlElement[] = [], visited = new Set<string>();
    let next = id;
    // Malformed cycles and very deep chains cannot recurse or hang the renderer.
    while (next && !visited.has(next) && nodes.length < 128) {
      visited.add(next); const node = styles.get(`${type}:${next}`); if (!node) break;
      nodes.unshift(node); next = wordValue(wordChild(node, "basedOn"));
    }
    cache.set(key, nodes); return nodes;
  };
  const omitUnresolvedTheme = (result: { -readonly [K in keyof DocxRunStyle]: DocxRunStyle[K] }, props?: XmlElement) => {
    const font = wordChild(props, "rFonts"), color = wordChild(props, "color");
    if (wordValue(font, "asciiTheme") || wordValue(font, "hAnsiTheme")) delete result.fontFamily;
    if (wordValue(color, "themeColor")) delete result.color;
  };
  return {
    paragraph(id?: string): DocxParagraphFormat {
      return Object.assign({}, baseParagraph, ...chain("paragraph", id ?? defaultParagraph).map((node) => readParagraphStyle(wordChild(node, "pPr"))));
    },
    run(paragraphId: string | undefined, characterId: string | undefined, direct: DocxRunStyle, directProps?: XmlElement): Readonly<DocxRunStyle> {
      const result = { ...baseRun };
      omitUnresolvedTheme(result, defaultRunProps);
      for (const node of [...chain("paragraph", paragraphId ?? defaultParagraph), ...chain("character", characterId ?? defaultCharacter)]) {
        const props = wordChild(node, "rPr"), style = readDocxRunStyle(props);
        // Bold/italic are toggle properties in named styles, absolute in direct formatting.
        const { bold, italic, ...properties } = style; Object.assign(result, properties);
        omitUnresolvedTheme(result, props);
        if (bold) result.bold = !result.bold;
        if (italic) result.italic = !result.italic;
      }
      Object.assign(result, direct); omitUnresolvedTheme(result, directProps);
      return Object.freeze(result);
    },
  };
}

export function ensureDocxNamedStyle<T extends DocxPartsState & DocxEditState>(state: T, id: string): T {
  if (readDocxStyles(state).some((s) => s.id === id)) return state;
  if (!Object.hasOwn(BUILTIN_DOCX_STYLES, id)) throw new DocxError("invalid-format", "Paragraph style is not defined in this document.");
  const namespace = parseXml(state.source).namespace;
  const result = ensureDocxPart(state, "styles", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml", `<w:styles xmlns:w="${namespace}"/>`, namespace);
  const style = BUILTIN_DOCX_STYLES[id];
  const source = docxPartSource(result.state, result.name)!;
  const node = `<w:style xmlns:w="${namespace}" w:type="paragraph" w:styleId="${id}"><w:name w:val="${style.name}"/>${id === "Normal" ? "" : '<w:basedOn w:val="Normal"/>'}<w:pPr><w:spacing w:after="${id.startsWith("Heading") ? 120 : 0}"/>${id.startsWith("Heading") ? `<w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/>` : ""}</w:pPr><w:rPr>${style.bold ? "<w:b/>" : ""}${style.size ? `<w:sz w:val="${style.size}"/>` : ""}</w:rPr></w:style>`;
  const partOverrides = new Map(result.state.partOverrides);
  partOverrides.set(result.name, encoder.encode(appendDocxXml(source, node)));
  const next = { ...state, partOverrides };
  return id === "Normal" || readDocxStyles(next).some((s) => s.id === "Normal") ? next : ensureDocxNamedStyle(next, "Normal");
}

export function ownNodeXml(source: string, node: XmlElement): string { return source.slice(node.start, node.end); }
