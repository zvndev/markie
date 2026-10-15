/** Original, non-validating bounded XML subset reader. W3C XML 1.0 + Namespaces:
 * https://www.w3.org/TR/xml/ and https://www.w3.org/TR/xml-names/
 * Source offsets let DOCX edits leave unrelated XML untouched. No DTD, external
 * entities, network access, executable markup or HTML interpretation is used.
 */
export interface XmlAttribute {
  name: string;
  localName: string;
  namespace: string;
  value: string;
}

export interface XmlElement {
  name: string;
  localName: string;
  namespace: string;
  attributes: XmlAttribute[];
  children: XmlElement[];
  text: string;
  start: number;
  startTagEnd: number;
  endTagStart: number;
  end: number;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const namePattern = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;

function validCodePoint(point: number): boolean {
  return point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xd7ff)
    || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff);
}

export function assertXmlText(text: string): void {
  for (const character of text) {
    if (!validCodePoint(character.codePointAt(0)!)) throw new XmlError("XML contains an invalid character.");
  }
}

export function escapeXmlText(text: string): string {
  assertXmlText(text);
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

function decodeEntities(text: string): string {
  let output = "";
  let cursor = 0;
  for (;;) {
    const amp = text.indexOf("&", cursor);
    if (amp < 0) return output + text.slice(cursor);
    output += text.slice(cursor, amp);
    const end = text.indexOf(";", amp + 1);
    if (end < 0 || end - amp > 32) throw new XmlError("Invalid XML entity.");
    const entity = text.slice(amp + 1, end);
    const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) output += predefined[entity];
    else if (/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
      const point = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!validCodePoint(point)) throw new XmlError("Invalid XML character reference.");
      output += String.fromCodePoint(point);
    } else throw new XmlError("Custom XML entities are not supported.");
    cursor = end + 1;
  }
}

export function xmlAttribute(node: XmlElement, localName: string, namespace = ""): string | undefined {
  return node.attributes.find((a) => a.localName === localName && a.namespace === namespace)?.value;
}

export function xmlDescendants(node: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    result.push(current);
    for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]);
  }
  return result;
}

export function parseXml(source: string, maxCharacters = 8 * 1024 * 1024): XmlElement {
  if (source.length > maxCharacters) throw new XmlError("XML exceeds the character limit.");
  assertXmlText(source);
  const stack: { node: XmlElement; namespaces: Map<string, string> }[] = [];
  let root: XmlElement | undefined;
  let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const declarationOffset = cursor;
  let nodeCount = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      const next = source.indexOf("<", cursor);
      const end = next < 0 ? source.length : next;
      const raw = source.slice(cursor, end);
      if (raw.includes("]]>")) throw new XmlError("Invalid XML text delimiter.");
      // XML Misc permits literal S outside the document element, not entity or
      // character references that merely *decode* into whitespace.
      if (!stack.length && !/^[\x20\t\r\n]*$/.test(raw)) throw new XmlError("XML text is outside its root element.");
      const text = decodeEntities(raw.replace(/\r\n?/g, "\n"));
      if (stack.length) stack[stack.length - 1].node.text += text;
      cursor = end;
      continue;
    }
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      if (end < 0 || source.slice(cursor + 4, end).includes("--") || source[end - 1] === "-") {
        throw new XmlError("Malformed XML comment.");
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", cursor)) {
      const end = source.indexOf("]]>", cursor + 9);
      if (!stack.length || end < 0) throw new XmlError("Malformed XML CDATA.");
      stack[stack.length - 1].node.text += source.slice(cursor + 9, end).replace(/\r\n?/g, "\n");
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", cursor)) {
      const end = source.indexOf("?>", cursor + 2);
      if (end < 0) throw new XmlError("Unterminated XML instruction.");
      const instruction = source.slice(cursor + 2, end);
      // Only a leading UTF-8 XML declaration belongs to the supported subset.
      if (cursor !== declarationOffset || !/^xml[\x20\t\r\n]+version[\x20\t\r\n]*=[\x20\t\r\n]*(["'])1\.0\1(?:[\x20\t\r\n]+encoding[\x20\t\r\n]*=[\x20\t\r\n]*(["'])[Uu][Tt][Ff]-8\2)?(?:[\x20\t\r\n]+standalone[\x20\t\r\n]*=[\x20\t\r\n]*(["'])(?:yes|no)\3)?[\x20\t\r\n]*$/.test(instruction)) {
        throw new XmlError("Unsupported XML instruction or encoding.");
      }
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", cursor)) throw new XmlError("DTD and XML declarations are forbidden.");
    if (source.startsWith("</", cursor)) {
      const end = source.indexOf(">", cursor + 2);
      if (end < 0) throw new XmlError("Unterminated closing XML tag.");
      const closing = source.slice(cursor + 2, end);
      const match = /^([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)[\x20\t\r\n]*$/.exec(closing);
      if (!match) throw new XmlError("Invalid closing XML tag.");
      const name = match[1];
      const current = stack.pop();
      if (!current || name !== current.node.name) throw new XmlError("Mismatched XML tags.");
      current.node.endTagStart = cursor;
      current.node.end = end + 1;
      cursor = end + 1;
      continue;
    }
    let end = cursor + 1;
    let quote = "";
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      else if (character === "<") throw new XmlError("Invalid XML start tag.");
    }
    if (end === source.length) throw new XmlError("Unterminated XML start tag.");
    const selfClosing = source[end - 1] === "/";
    const inside = source.slice(cursor + 1, selfClosing ? end - 1 : end);
    const nameMatch = /^[^\x20\t\r\n/]+/.exec(inside);
    if (!nameMatch || !namePattern.test(nameMatch[0])) throw new XmlError("Unsupported or invalid XML name.");
    const name = nameMatch[0];
    const rawAttributes: { name: string; value: string }[] = [];
    const attrNames = new Set<string>();
    let offset = name.length;
    while (offset < inside.length) {
      const rest = inside.slice(offset);
      if (/^[\x20\t\r\n]*$/.test(rest)) break;
      const match = /^[\x20\t\r\n]+([^\x20\t\r\n=]+)[\x20\t\r\n]*=[\x20\t\r\n]*(["'])([^]*?)\2/.exec(rest);
      if (!match || !namePattern.test(match[1]) || match[3].includes("<") || attrNames.has(match[1])) {
        throw new XmlError("Invalid or duplicate XML attribute.");
      }
      attrNames.add(match[1]);
      rawAttributes.push({ name: match[1], value: decodeEntities(match[3].replace(/\r\n?/g, "\n").replace(/[\t\n]/g, " ")) });
      if (rawAttributes.length > 128) throw new XmlError("XML attribute count exceeds its limit.");
      offset += match[0].length;
    }
    const namespaces = new Map(stack.length ? stack[stack.length - 1].namespaces : [["xml", XML_NAMESPACE]]);
    for (const attribute of rawAttributes) {
      if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) {
        const prefix = attribute.name === "xmlns" ? "" : attribute.name.slice(6);
        if (prefix === "xmlns" || attribute.value === XMLNS_NAMESPACE
          || (prefix === "xml") !== (attribute.value === XML_NAMESPACE)
          || (prefix && !attribute.value)) throw new XmlError("Invalid namespace declaration.");
        namespaces.set(prefix, attribute.value);
      }
    }
    const qualify = (qualified: string, isAttribute: boolean): { localName: string; namespace: string } => {
      const colon = qualified.indexOf(":");
      if (qualified === "xmlns" || qualified.startsWith("xmlns:")) {
        return { localName: colon < 0 ? "xmlns" : qualified.slice(colon + 1), namespace: XMLNS_NAMESPACE };
      }
      const prefix = colon < 0 ? "" : qualified.slice(0, colon);
      const namespace = colon < 0 && isAttribute ? "" : namespaces.get(prefix) || "";
      if (colon >= 0 && !namespace) throw new XmlError("Unbound XML namespace prefix.");
      return { localName: colon < 0 ? qualified : qualified.slice(colon + 1), namespace };
    };
    if (name === "xmlns" || name.startsWith("xmlns:")) throw new XmlError("Reserved XML namespace name.");
    const attributes = rawAttributes.map((a) => ({ ...a, ...qualify(a.name, true) }));
    const expandedNames = new Set<string>();
    for (const a of attributes) {
      const expanded = `${a.namespace}|${a.localName}`;
      if (expandedNames.has(expanded)) throw new XmlError("Duplicate expanded XML attribute.");
      expandedNames.add(expanded);
    }
    const node: XmlElement = {
      name, ...qualify(name, false), attributes, children: [], text: "",
      start: cursor, startTagEnd: end + 1, endTagStart: selfClosing ? end - 1 : -1, end: selfClosing ? end + 1 : -1,
    };
    if (++nodeCount > 100000 || stack.length >= 128) throw new XmlError("XML structure exceeds its limits.");
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else if (root) throw new XmlError("XML contains multiple root elements.");
    else root = node;
    if (!selfClosing) stack.push({ node, namespaces });
    cursor = end + 1;
  }
  if (stack.length || !root) throw new XmlError("Incomplete XML document.");
  return root;
}
