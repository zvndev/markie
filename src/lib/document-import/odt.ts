import { readZip, ZipError } from "../office/zip";
import { parseXml, xmlAttribute, xmlDescendants, XmlError, type XmlElement } from "../office/xml";
import { decodeImportText, DocumentImportError, textAccumulator, type DocumentImportLimits, type ImportedDocumentText } from "./types";

// OASIS OpenDocument 1.3 Part 2 §§3.2–3.4; Part 3 §§3.4,5.1,5.5,6.1.
// https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part2-packages/OpenDocument-v1.3-os-part2-packages.html
// https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html
const MIME = "application/vnd.oasis.opendocument.text";
const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const OMIT_TEXT = new Set(["tracked-changes", "changed-region", "deletion", "note", "hidden-text", "hidden-paragraph", "conditional-text", "script"]);

export async function extractOdtText(bytes: Uint8Array, limits: DocumentImportLimits): Promise<ImportedDocumentText> {
  try {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 38 || header.getUint32(0, true) !== 0x04034b50 || header.getUint16(8, true) !== 0 || header.getUint16(26, true) !== 8 || header.getUint16(28, true) !== 0 || decodeImportText(bytes.subarray(30, 38), true) !== "mimetype") throw new DocumentImportError("malformed", "ODT must begin with an uncompressed mimetype entry without ZIP extra fields.");
    const entries = await readZip(bytes, { maxArchiveBytes: limits.maxInputBytes, maxEntryBytes: limits.maxInputBytes, maxExpandedBytes: limits.maxExpandedBytes, maxEntries: limits.maxArchiveEntries, maxCompressionRatio: limits.maxCompressionRatio });
    const parts = new Map(entries.map((entry) => [entry.name, entry.data]));
    if (!parts.has("mimetype") || decodeImportText(parts.get("mimetype")!, true) !== MIME) throw new DocumentImportError("unsupported", "This is not an OpenDocument Text package.");
    const manifestBytes = parts.get("META-INF/manifest.xml"), content = parts.get("content.xml");
    if (!manifestBytes || !content) throw new DocumentImportError("malformed", "ODT requires a manifest and content.xml.");
    const manifest = parseXml(decodeImportText(manifestBytes, true), limits.maxInputBytes);
    if (manifest.namespace !== MANIFEST || manifest.localName !== "manifest") throw new DocumentImportError("malformed", "ODT manifest namespace is invalid.");
    const manifestNodes = xmlDescendants(manifest);
    if (manifestNodes.some((node) => node.namespace === MANIFEST && ["encryption-data", "encrypted-key"].includes(node.localName))) throw new DocumentImportError("encrypted", "Encrypted ODT packages are not converted.");
    const rootEntries = manifest.children.filter((node) => node.namespace === MANIFEST && node.localName === "file-entry" && xmlAttribute(node, "full-path", MANIFEST) === "/");
    const contentEntries = manifest.children.filter((node) => node.namespace === MANIFEST && node.localName === "file-entry" && xmlAttribute(node, "full-path", MANIFEST) === "content.xml");
    if (rootEntries.length !== 1 || xmlAttribute(rootEntries[0], "media-type", MANIFEST) !== MIME || contentEntries.length !== 1 || xmlAttribute(contentEntries[0], "media-type", MANIFEST) !== "text/xml") throw new DocumentImportError("malformed", "ODT manifest media types or content references are invalid.");
    const source = decodeImportText(content, true), root = parseXml(source, limits.maxInputBytes);
    const budget = [{ node: manifest, depth: 1 }, { node: root, depth: 1 }]; let structuralNodes = 0;
    while (budget.length) { const task = budget.pop()!; if (++structuralNodes > limits.maxNodes || task.depth > limits.maxDepth) throw new DocumentImportError("limit-exceeded", "ODT XML structure exceeds the import budget."); for (const child of task.node.children) budget.push({ node: child, depth: task.depth + 1 }); }
    if (root.namespace !== OFFICE || root.localName !== "document-content") throw new DocumentImportError("malformed", "ODT content root namespace is invalid.");
    const version = xmlAttribute(root, "version", OFFICE);
    if (version !== "1.2" && version !== "1.3") throw new DocumentImportError("unsupported", "Only the common OpenDocument 1.2/1.3 text subset is converted.");
    const bodies = root.children.filter((node) => node.namespace === OFFICE && node.localName === "body");
    const texts = bodies.length === 1 ? bodies[0].children.filter((node) => node.namespace === OFFICE && node.localName === "text") : [];
    if (texts.length !== 1) throw new DocumentImportError("malformed", "ODT requires exactly one office:text body.");
    const output = textAccumulator(limits);
    type Task = { node?: XmlElement; depth: number; paragraph: boolean; raw?: string; newline?: boolean };
    const stack: Task[] = [{ node: texts[0], depth: 1, paragraph: false }];
    let count = 0, omitted = false;
    while (stack.length) {
      const task = stack.pop()!;
      if (task.newline) { output.append("\n"); continue; }
      if (task.raw !== undefined) {
        if (task.paragraph && task.raw) output.append(parseXml(`<t>${task.raw}</t>`, task.raw.length + 7).text.replace(/[\t\n\r ]+/g, " "));
        continue;
      }
      const node = task.node!;
      if (++count > limits.maxNodes || task.depth > limits.maxDepth) throw new DocumentImportError("limit-exceeded", "ODT structure exceeds the import budget.");
      const display = xmlAttribute(node, "display", TEXT);
      if ((node.namespace === TEXT && (OMIT_TEXT.has(node.localName) || display === "none" || display === "condition" || xmlAttribute(node, "condition", TEXT) !== undefined)) || (node.namespace === OFFICE && node.localName !== "text") || ![TEXT, TABLE, OFFICE].includes(node.namespace)) { omitted = true; continue; }
      const paragraph = task.paragraph || (node.namespace === TEXT && ["p", "h"].includes(node.localName));
      if (node.namespace === TEXT && node.localName === "s") {
        const raw = xmlAttribute(node, "c", TEXT) ?? "1";
        if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > limits.maxTextCodeUnits) throw new DocumentImportError("limit-exceeded", "ODT repeated spaces exceed the text budget.");
        if (paragraph) output.append(" ".repeat(Number(raw))); continue;
      }
      if (node.namespace === TEXT && ["tab", "line-break"].includes(node.localName)) { if (paragraph) output.append(node.localName === "tab" ? "\t" : "\n"); continue; }
      const isParagraph = node.namespace === TEXT && ["p", "h"].includes(node.localName);
      const work: Task[] = [];
      let cursor = node.startTagEnd;
      for (const child of node.children) { if (cursor < child.start) work.push({ raw: source.slice(cursor, child.start), depth: task.depth, paragraph }); work.push({ node: child, depth: task.depth + 1, paragraph }); cursor = child.end; }
      if (cursor < node.endTagStart) work.push({ raw: source.slice(cursor, node.endTagStart), depth: task.depth, paragraph });
      if (isParagraph) work.push({ newline: true, depth: task.depth, paragraph });
      for (let i = work.length - 1; i >= 0; i--) stack.push(work[i]);
    }
    return { text: output.result().replace(/\n$/, ""), warnings: [
      "ODT was converted to a new plain-text copy. Styles, page layout, table geometry, links, fields, media and embedded objects are not preserved; no external resources are loaded.",
      "Only main-body paragraph/heading text is converted. Tracked-deleted text, comments, notes, hidden/conditional content and scripts are excluded; revision history is not preserved.",
      ...(omitted ? ["Unsupported, private annotation/history or embedded content was omitted."] : []),
    ] };
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    if (error instanceof ZipError) throw new DocumentImportError(/limit|expansion/.test(error.code) ? "limit-exceeded" : /unsupported|platform/.test(error.code) ? "unsupported" : "malformed", "ODT package could not be safely decoded.");
    if (error instanceof XmlError) throw new DocumentImportError(/limit/.test(error.message) ? "limit-exceeded" : "malformed", "ODT XML is invalid or exceeds the supported safe subset.");
    throw new DocumentImportError("malformed", "ODT text could not be safely converted.");
  }
}
