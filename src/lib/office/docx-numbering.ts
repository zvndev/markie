/** Original ECMA-376 §17.9 single-level bullet/decimal numbering. The package
 * carries real abstract/instance definitions, not literal bullet text or CSS.
 */
import { DocxError } from "./docx-types";
import { isWord, patchDocxSource, wordChild, type DocxEditState } from "./docx-edit";
import { appendDocxXml, docxPartSource, ensureDocxPart, relatedDocxPart, type DocxPartsState } from "./docx-parts";
import { parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";
const encoder = new TextEncoder();
const attribute = (node: XmlElement | undefined, name: string) => node && xmlAttribute(node, name, node.namespace);
interface Numbering { id: string; kind: "bullet" | "numbered"; start: number }
interface Inspection { definitions: ReadonlyMap<string, Numbering>; problem?: string }

export function inspectDocxNumbering(state: DocxPartsState): Inspection {
  const name = relatedDocxPart(state, "numbering");
  const source = name && docxPartSource(state, name);
  if (!source) return { definitions: new Map() };
  const root = parseXml(source);
  if (!isWord(root, "numbering") || root.children.length > 2000) return { definitions: new Map(), problem: "Unsupported numbering root or too many lists." };
  const abstracts = new Map<string, Omit<Numbering, "id">>();
  const definitions = new Map<string, Numbering>();
  const allowedChildren: Record<string, string[]> = { numbering: ["abstractNum", "num"], abstractNum: ["multiLevelType", "lvl"], multiLevelType: [], lvl: ["start", "numFmt", "lvlText", "suff"], start: [], numFmt: [], lvlText: [], suff: [], num: ["abstractNumId"], abstractNumId: [] };
  const attrs: Record<string, string[]> = { numbering: [], abstractNum: ["abstractNumId"], multiLevelType: ["val"], lvl: ["ilvl"], start: ["val"], numFmt: ["val"], lvlText: ["val"], suff: ["val"], num: ["numId"], abstractNumId: ["val"] };
  for (const node of xmlDescendants(root)) {
    if (!isWord(node) || node.namespace !== root.namespace || !Object.hasOwn(allowedChildren, node.localName) || !/^[\x20\t\r\n]*$/.test(node.text)
      || node.children.some((c) => !allowedChildren[node.localName].includes(c.localName))
      || node.attributes.some((a) => a.namespace !== "http://www.w3.org/2000/xmlns/" && !(a.namespace === node.namespace && attrs[node.localName].includes(a.localName)))
      || new Set(node.children.map((c) => c.localName)).size !== node.children.length) {
      // Several abstract/num siblings are normal, unlike duplicate properties.
      if (node === root && node.children.every((c) => isWord(c) && ["abstractNum", "num"].includes(c.localName)) && !node.text.trim() && node.attributes.every((a) => a.namespace === "http://www.w3.org/2000/xmlns/")) continue;
      return { definitions, problem: "Only plain single-level bullet/decimal lists are editable." };
    }
  }
  for (const node of root.children.filter((n) => isWord(n, "abstractNum"))) {
    const id = attribute(node, "abstractNumId");
    const level = wordChild(node, "lvl");
    const format = attribute(wordChild(level, "numFmt"), "val");
    const text = attribute(wordChild(level, "lvlText"), "val");
    const start = attribute(wordChild(level, "start"), "val");
    if (!id || !/^(?:0|[1-9]\d{0,8})$/.test(id) || abstracts.has(id) || !level || attribute(level, "ilvl") !== "0"
      || attribute(wordChild(node, "multiLevelType"), "val") !== "singleLevel" || !["decimal", "bullet"].includes(format || "")
      || text !== (format === "decimal" ? "%1." : "•") || !start || !/^[1-9]\d{0,5}$/.test(start)
      || attribute(wordChild(level, "suff"), "val") !== "space") return { definitions, problem: "List definition is outside the editable single-level subset." };
    abstracts.set(id, { kind: format === "decimal" ? "numbered" : "bullet", start: Number(start) });
  }
  for (const node of root.children.filter((n) => isWord(n, "num"))) {
    const id = attribute(node, "numId");
    const abstract = abstracts.get(attribute(wordChild(node, "abstractNumId"), "val") || "");
    if (!id || !/^[1-9]\d{0,8}$/.test(id) || definitions.has(id) || !abstract || node.children.length !== 1) return { definitions, problem: "Numbering instance is missing or unsupported." };
    definitions.set(id, { id, ...abstract });
  }
  return { definitions };
}

export function ensureDocxList<T extends DocxPartsState & DocxEditState>(state: T, kind: "bullet" | "numbered"): { state: T; id: string } {
  const inspected = inspectDocxNumbering(state);
  if (inspected.problem) throw new DocxError("unsupported-numbering", inspected.problem);
  const existing = [...inspected.definitions.values()].find((d) => d.kind === kind);
  if (existing) return { state, id: existing.id };
  const namespace = parseXml(state.source).namespace;
  const ensured = ensureDocxPart(state, "numbering", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml", `<w:numbering xmlns:w="${namespace}"/>`, namespace);
  const source = docxPartSource(ensured.state, ensured.name)!;
  const root = parseXml(source);
  const abstractId = String(root.children.filter((n) => isWord(n, "abstractNum")).reduce((max, n) => Math.max(max, Number(attribute(n, "abstractNumId"))), -1) + 1);
  const id = String([...inspected.definitions.keys()].reduce((max, value) => Math.max(max, Number(value)), 0) + 1);
  const abstract = `<w:abstractNum xmlns:w="${namespace}" w:abstractNumId="${abstractId}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${kind === "bullet" ? "bullet" : "decimal"}"/><w:lvlText w:val="${kind === "bullet" ? "•" : "%1."}"/><w:suff w:val="space"/></w:lvl></w:abstractNum>`;
  const num = `<w:num xmlns:w="${namespace}" w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/></w:num>`;
  // Abstract definitions must precede all instance definitions in the schema.
  const firstNum = root.children.find((n) => isWord(n, "num"));
  const withAbstract = firstNum ? source.slice(0, firstNum.start) + abstract + source.slice(firstNum.start) : appendDocxXml(source, abstract);
  const partOverrides = new Map(ensured.state.partOverrides);
  partOverrides.set(ensured.name, encoder.encode(appendDocxXml(withAbstract, num)));
  return { state: { ...state, partOverrides }, id };
}

export function setDocxList<T extends DocxPartsState & DocxEditState>(state: T, paragraphId: string, kind: "bullet" | "numbered" | null): T {
  if (kind !== null && !["bullet", "numbered"].includes(kind)) throw new DocxError("invalid-format", "Unsupported list type.");
  const ensured = kind === null ? { state, id: "" } : ensureDocxList(state, kind);
  const next = ensured.state;
  const root = parseXml(next.source);
  const paragraph = xmlDescendants(root).find((n) => isWord(n, "p") && next.identities.get(n.start) === paragraphId);
  if (!paragraph) throw new DocxError("invalid-edit", "Unknown paragraph identity.");
  const properties = wordChild(paragraph, "pPr");
  const current = wordChild(properties, "numPr");
  const content = kind === null ? "" : `<w:numPr xmlns:w="${paragraph.namespace}"><w:ilvl w:val="0"/><w:numId w:val="${ensured.id}"/></w:numPr>`;
  if (current) return { ...next, ...patchDocxSource(next, [{ start: current.start, end: current.end, text: content }]) };
  if (!content) return next;
  if (properties) {
    if (properties.endTagStart < properties.startTagEnd) {
      const xml = next.source.slice(properties.start, properties.startTagEnd).replace(/\/>$/, ">") + content + `</${properties.name}>`;
      return { ...next, ...patchDocxSource(next, [{ start: properties.start, end: properties.end, text: xml }]) };
    }
    const before = properties.children.find((n) => ["spacing", "ind", "jc"].includes(n.localName));
    const offset = before?.start ?? properties.endTagStart;
    return { ...next, ...patchDocxSource(next, [{ start: offset, end: offset, text: content }]) };
  }
  const xml = `<w:pPr xmlns:w="${paragraph.namespace}">${content}</w:pPr>`;
  if (paragraph.endTagStart < paragraph.startTagEnd) return { ...next, ...patchDocxSource(next, [{ start: paragraph.start, end: paragraph.end, text: next.source.slice(paragraph.start, paragraph.startTagEnd).replace(/\/>$/, ">") + xml + `</${paragraph.name}>`, preserveIdentity: true }]) };
  return { ...next, ...patchDocxSource(next, [{ start: paragraph.startTagEnd, end: paragraph.startTagEnd, text: xml }]) };
}
