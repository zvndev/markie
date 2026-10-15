/** Original bounded raster/inline DrawingML support from ECMA-376 §§20–21,
 * W3C PNG chunks and JPEG marker framing; never executes SVG/HTML or fetches
 * linked pictures. Platform image decoders, not this package layer, render it.
 * https://www.w3.org/TR/PNG-Chunks
 * https://ecma-international.org/publications-and-standards/standards/ecma-376/
 */
import { DocxError } from "./docx-types";
import { isWord, patchDocxSource, wordChild, type DocxEditState } from "./docx-edit";
import { appendDocxXml, declareDocxRelationshipPart, DOCX_R, DOCX_R_STRICT, DOCX_REL, docxEntries, docxPart, docxPartSource, docxRelationshipsPart, xmlAttributeText, type DocxPartsState } from "./docx-parts";
import { parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";
import { zipCrc32 } from "./zip";

const encoder = new TextEncoder();
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export interface DocxMediaInfo {
  readonly id: string;
  readonly paragraphId: string;
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly altText: string;
  readonly contentType: "image/png" | "image/jpeg";
}
export interface DocxImageInput {
  readonly afterParagraphId?: string | null;
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/jpeg";
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly altText?: string;
}
export interface DocxMediaState extends DocxEditState, DocxPartsState { deletedParts: Set<string>; nextImageId?: number }
interface Bitmap { width: number; height: number }
const bad = (message: string): never => { throw new DocxError("invalid-image", message); };
function dimensions(width: number, height: number): Bitmap {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 32_000_000) bad("Image dimensions exceed the safe raster limit.");
  return { width, height };
}

/** Structural framing/CRC and pixel budgets, not a replacement raster decoder. */
export function inspectDocxBitmap(input: Uint8Array, type: "image/png" | "image/jpeg"): Bitmap {
  if (!(input instanceof Uint8Array) || input.length < 16 || input.length > MAX_IMAGE_BYTES) bad("Image exceeds its byte limits.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (type === "image/png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((byte, i) => input[i] === byte)) bad("PNG signature is invalid.");
    let cursor = 8;
    let image: Bitmap | undefined;
    let idat = false;
    let idatEnded = false;
    let chunks = 0;
    let palette = false;
    let indexed = false;
    while (cursor + 12 <= input.length) {
      if (++chunks > 2048) bad("Image contains too many PNG chunks.");
      const size = view.getUint32(cursor);
      const end = cursor + 12 + size;
      if (end > input.length) bad("Truncated PNG chunk.");
      const kind = String.fromCharCode(...input.subarray(cursor + 4, cursor + 8));
      if (!/^[A-Za-z]{4}$/.test(kind) || zipCrc32(input.subarray(cursor + 4, cursor + 8 + size)) !== view.getUint32(cursor + 8 + size)) bad("PNG chunk integrity check failed.");
      if (chunks === 1 && kind !== "IHDR") bad("PNG must begin with IHDR.");
      if (kind === "IHDR") {
        if (image || size !== 13) bad("Invalid or repeated PNG header.");
        image = dimensions(view.getUint32(cursor + 8), view.getUint32(cursor + 12));
        const color = input[cursor + 17];
        const depth = input[cursor + 16];
        const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!allowed[color]?.includes(depth) || input[cursor + 18] !== 0 || input[cursor + 19] !== 0 || input[cursor + 20] > 1) bad("Unsupported PNG header.");
        indexed = color === 3;
      } else if (kind === "PLTE") {
        if (idat || palette || !size || size > 768 || size % 3) bad("Invalid PNG palette.");
        palette = true;
      } else if (kind === "IDAT") {
        if (idatEnded || (indexed && !palette)) bad("Invalid PNG data ordering.");
        idat = true;
      } else if (kind === "IEND") {
        if (size || end !== input.length || !idat || !image) bad("Invalid PNG end record.");
        return image!;
      } else {
        if (idat) idatEnded = true;
        if (kind[0] === kind[0].toUpperCase() || ["acTL", "fcTL", "fdAT"].includes(kind)) bad("Unknown critical or animated PNG chunks are unsupported.");
      }
      cursor = end;
    }
    return bad("PNG end record is missing.");
  }
  if (type !== "image/jpeg" || input[0] !== 0xff || input[1] !== 0xd8 || input[input.length - 2] !== 0xff || input[input.length - 1] !== 0xd9) bad("JPEG signature is invalid.");
  let cursor = 2;
  let image: Bitmap | undefined;
  let markers = 0;
  while (cursor + 4 <= input.length) {
    if (++markers > 2048 || input[cursor++] !== 0xff) bad("Invalid JPEG marker framing.");
    while (input[cursor] === 0xff) cursor++;
    const marker = input[cursor++];
    if ([0, 0xd8, 0xd9, 0x01].includes(marker) || (marker >= 0xd0 && marker <= 0xd7)) bad("Unexpected JPEG marker.");
    const length = cursor + 2 <= input.length ? view.getUint16(cursor) : 0;
    if (length < 2 || cursor + length > input.length - 2) bad("Truncated JPEG segment.");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (image || length < 8 || input[cursor + 2] !== 8) bad("Unsupported JPEG frame.");
      image = dimensions(view.getUint16(cursor + 5), view.getUint16(cursor + 3));
    } else if (marker >= 0xc3 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) bad("Unsupported JPEG frame encoding.");
    if (marker === 0xda) {
      if (!image) bad("JPEG scan has no supported frame.");
      return image!; // Entropy decoding belongs to the platform decoder.
    }
    cursor += length;
  }
  return bad("JPEG scan is missing.");
}

function namespaces(wordNamespace: string) {
  const strict = wordNamespace.includes("purl.oclc.org");
  const base = strict ? "http://purl.oclc.org/ooxml/drawingml/" : "http://schemas.openxmlformats.org/drawingml/2006/";
  return { a: `${base}main`, wp: `${base}wordprocessingDrawing`, pic: `${base}picture`, r: strict ? DOCX_R_STRICT : DOCX_R };
}
function makeInline(namespace: string, relationshipId: string, drawingId: string, width: number, height: number, alt: string): string {
  const ns = namespaces(namespace);
  const cx = Math.round(width * 12700), cy = Math.round(height * 12700);
  return `<w:r xmlns:w="${namespace}" xmlns:wp="${ns.wp}" xmlns:a="${ns.a}" xmlns:pic="${ns.pic}" xmlns:r="${ns.r}"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="Picture ${drawingId}" descr="${xmlAttributeText(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${ns.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="Picture ${drawingId}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

export function insertDocxImage<T extends DocxMediaState>(state: T, input: DocxImageInput): T {
  inspectDocxBitmap(input.bytes, input.contentType);
  if (![input.widthPoints, input.heightPoints].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 2000)
    || typeof (input.altText ?? "") !== "string" || (input.altText?.length ?? 0) > 2000) bad("Invalid image display size or alternative text.");
  const root = parseXml(state.source);
  const body = wordChild(root, "body")!;
  const current = inspectDocxImages(state);
  if (current.problem) bad(current.problem);
  if (current.images.length >= 100) bad("A document may contain at most 100 supported pictures.");
  const directory = state.mainPart.slice(0, state.mainPart.lastIndexOf("/") + 1);
  let name = `${directory}media/markie-image1.${input.contentType === "image/png" ? "png" : "jpg"}`;
  for (let n = 2; docxPart(state, name) || state.deletedParts.has(name); n++) name = `${directory}media/markie-image${n}.${input.contentType === "image/png" ? "png" : "jpg"}`;
  const relName = docxRelationshipsPart(state.mainPart);
  const relSource = docxPartSource(state, relName) || `<Relationships xmlns="${DOCX_REL}"/>`;
  const ids = new Set(parseXml(relSource).children.map((n) => xmlAttribute(n, "Id")));
  let id = "rIdImage1";
  for (let n = 2; ids.has(id); n++) id = `rIdImage${n}`;
  const ns = namespaces(root.namespace);
  const partOverrides = new Map(state.partOverrides);
  partOverrides.set(name, new Uint8Array(input.bytes));
  partOverrides.set(relName, encoder.encode(appendDocxXml(relSource, `<Relationship xmlns="${DOCX_REL}" Id="${id}" Type="${ns.r}/image" Target="${name.slice(directory.length)}"/>`)));
  partOverrides.set("[Content_Types].xml", encoder.encode(declareDocxRelationshipPart(appendDocxXml(docxPartSource(state, "[Content_Types].xml")!, `<Override xmlns="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/${name}" ContentType="${input.contentType}"/>`), relName)));
  let offset = wordChild(body, "sectPr")?.start ?? body.endTagStart;
  if (input.afterParagraphId === null) offset = body.startTagEnd;
  else if (input.afterParagraphId !== undefined) {
    const p = body.children.find((n) => isWord(n, "p") && state.identities.get(n.start) === input.afterParagraphId);
    if (!p) throw new DocxError("invalid-edit", "Image insertion requires a top-level paragraph.");
    offset = p.end;
  }
  const nextImageId = state.nextImageId ?? current.images.reduce((max, image) => Math.max(max, Number(image.id)), 0) + 1;
  const drawingId = String(nextImageId);
  const xml = `<w:p xmlns:w="${root.namespace}">${makeInline(root.namespace, id, drawingId, input.widthPoints, input.heightPoints, input.altText || "")}</w:p>`;
  return { ...state, ...patchDocxSource(state, [{ start: offset, end: offset, text: xml }]), partOverrides, nextImageId: nextImageId + 1 };
}

interface InternalImage extends DocxMediaInfo { drawing: XmlElement; run: XmlElement; partName: string; relationshipId: string }
export function inspectDocxImages(state: DocxEditState & DocxPartsState): { images: readonly InternalImage[]; problem?: string } {
  const root = parseXml(state.source);
  const ns = namespaces(root.namespace);
  const all = xmlDescendants(root);
  const drawings = all.filter((n) => isWord(n, "drawing"));
  if (!drawings.length) return { images: [] };
  if (drawings.length > 100) return { images: [], problem: "Too many inline pictures." };
  const relSource = docxPartSource(state, docxRelationshipsPart(state.mainPart));
  const rels = relSource ? parseXml(relSource).children : [];
  const manifest = parseXml(docxPartSource(state, "[Content_Types].xml")!);
  const images: InternalImage[] = [];
  const ids = new Set<string>();
  let totalPixels = 0;
  for (const drawing of drawings) {
    const nodes = xmlDescendants(drawing);
    const inline = drawing.children[0];
    const docPr = nodes.find((n) => n.namespace === ns.wp && n.localName === "docPr");
    const extent = nodes.find((n) => n.namespace === ns.wp && n.localName === "extent");
    const blip = nodes.find((n) => n.namespace === ns.a && n.localName === "blip");
    const id = docPr && xmlAttribute(docPr, "id");
    const relationshipId = blip && xmlAttribute(blip, "embed", ns.r);
    const relation = rels.find((n) => xmlAttribute(n, "Id") === relationshipId && xmlAttribute(n, "Type") === `${ns.r}/image` && !xmlAttribute(n, "TargetMode"));
    const target = relation && xmlAttribute(relation, "Target");
    const directory = state.mainPart.slice(0, state.mainPart.lastIndexOf("/") + 1);
    const partName = target?.startsWith("/") ? target.slice(1) : target && `${directory}${target}`;
    const type = partName && manifest.children.find((n) => n.localName === "Override" && xmlAttribute(n, "PartName") === `/${partName}`);
    const contentType = type && xmlAttribute(type, "ContentType");
    const data = partName && docxPart(state, partName);
    const run = all.find((n) => isWord(n, "r") && n.children.includes(drawing));
    const paragraph = run && all.find((n) => isWord(n, "p") && n.children.includes(run));
    const cx = extent && xmlAttribute(extent, "cx"), cy = extent && xmlAttribute(extent, "cy");
    if (!inline || inline.namespace !== ns.wp || inline.localName !== "inline" || drawing.children.length !== 1 || !id || !/^[1-9]\d{0,8}$/.test(id) || ids.has(id)
      || !relationshipId || !relation || !partName || !data || !["image/png", "image/jpeg"].includes(contentType || "") || !run || !paragraph
      || !cx || !cy || !/^\d+$/.test(cx) || !/^\d+$/.test(cy) || Number(cx) < 12700 || Number(cy) < 12700 || Number(cx) > 25400000 || Number(cy) > 25400000) return { images: [], problem: "Unsupported or unresolved inline image." };
    // Exact shape grammar is intentionally stricter than arbitrary DrawingML.
    const expected = parseXml(`<w:p xmlns:w="${root.namespace}">${makeInline(root.namespace, relationshipId, id, Number(cx) / 12700, Number(cy) / 12700, xmlAttribute(docPr!, "descr") || "")}</w:p>`).children[0].children[0];
    const shape = (n: XmlElement): string => `${n.namespace}|${n.localName}[${n.attributes.filter((a) => a.namespace !== "http://www.w3.org/2000/xmlns/").map((a) => `${a.namespace}|${a.localName}=${a.value}`).sort().join(";")}]${n.text}{${n.children.map(shape).join("")}}`;
    if (shape(drawing) !== shape(expected)) return { images: [], problem: "Picture contains unsupported DrawingML effects, shapes or links." };
    try {
      const bitmap = inspectDocxBitmap(data, contentType as "image/png" | "image/jpeg");
      totalPixels += bitmap.width * bitmap.height;
      if (totalPixels > 64_000_000) return { images: [], problem: "Document exceeds the aggregate image pixel budget." };
    } catch { return { images: [], problem: "Embedded bitmap failed structural validation." }; }
    ids.add(id);
    images.push({ id, paragraphId: state.identities.get(paragraph.start)!, widthPoints: Number(cx) / 12700, heightPoints: Number(cy) / 12700, altText: xmlAttribute(docPr!, "descr") || "", contentType: contentType as "image/png" | "image/jpeg", drawing, run, partName, relationshipId });
  }
  return { images };
}

export function deleteDocxImage<T extends DocxMediaState>(state: T, id: string): T {
  const inspected = inspectDocxImages(state);
  if (inspected.problem) bad(inspected.problem);
  const image = inspected.images.find((i) => i.id === id);
  if (!image) throw new DocxError("invalid-image", "Unknown image identity.");
  const partOverrides = new Map(state.partOverrides);
  const deletedParts = new Set(state.deletedParts);
  // A valid Word run can hold text or another picture alongside this drawing.
  // Remove only the selected drawing; do not erase the run's other content.
  const next = { ...state, ...patchDocxSource(state, [{ start: image.drawing.start, end: image.drawing.end, text: "" }]), partOverrides, deletedParts };
  if (!inspected.images.some((other) => other.id !== id && other.relationshipId === image.relationshipId)) {
    const relName = docxRelationshipsPart(state.mainPart);
    const source = docxPartSource(state, relName)!;
    const relation = parseXml(source).children.find((n) => xmlAttribute(n, "Id") === image.relationshipId)!;
    partOverrides.set(relName, encoder.encode(source.slice(0, relation.start) + source.slice(relation.end)));
  }
  if (!inspected.images.some((other) => other.id !== id && other.partName === image.partName)) {
    // Refuse to erase data referenced anywhere else in the package graph.
    const otherReference = docxEntries(state).filter((p) => p.name.endsWith(".rels")).some((p) => {
      const sourcePart = p.name === "_rels/.rels" ? "" : p.name.replace(/(^|\/)\_rels\/([^/]+)\.rels$/, "$1$2");
      return parseXml(new TextDecoder("utf-8", { fatal: true }).decode(p.data)).children.some((relation) => {
        if (p.name === docxRelationshipsPart(state.mainPart) && xmlAttribute(relation, "Id") === image.relationshipId) return false;
        if (xmlAttribute(relation, "TargetMode") === "External") return false;
        const target = xmlAttribute(relation, "Target") || "";
        const segments = target.startsWith("/") ? [] : sourcePart.split("/").slice(0, -1);
        for (const piece of target.replace(/^\//, "").split("/")) { if (piece === "..") segments.pop(); else segments.push(piece); }
        return segments.join("/") === image.partName;
      });
    });
    if (otherReference) throw new DocxError("unsupported-image", "Image has another package owner and cannot be erased safely.");
    deletedParts.add(image.partName);
    partOverrides.delete(image.partName);
    const manifest = docxPartSource(state, "[Content_Types].xml")!;
    const override = parseXml(manifest).children.find((n) => xmlAttribute(n, "PartName") === `/${image.partName}`);
    if (override) partOverrides.set("[Content_Types].xml", encoder.encode(manifest.slice(0, override.start) + manifest.slice(override.end)));
  }
  return next;
}
