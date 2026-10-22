/** Original single-master geometry subset of OASIS ODF 1.3 Part 3,
 * sections 16.5, 17.2 and physical page-size, margin and orientation attributes.
 * https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html
 * No external engine implementation is consulted or embedded. */
import { DocxError, type DocxPageLayout } from "./docx-types";
import { xmlAttribute, type XmlElement } from "./xml";

const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const STYLE = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const FO = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const is = (node: XmlElement, ns: string, name: string) => node.namespace === ns && node.localName === name;
function fail(): never { throw new DocxError("unsupported-odt", "Unsupported or ambiguous ODT page layout; the original file was not converted."); }
function attrs(node: XmlElement, allowed: readonly string[]) {
  if (node.attributes.some(a => a.namespace !== XMLNS && !allowed.includes(`${a.namespace}|${a.localName}`))) fail();
}
function points(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)(pt|in|cm|mm|pc)$/.exec(value ?? "");
  if (!match) fail();
  const result = Number(match[1]) * ({ pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12 }[match[2]]!);
  if (!Number.isFinite(result) || result > 2000) fail();
  return result;
}
export interface OdtPageGeometry { readonly layout: DocxPageLayout; readonly properties: XmlElement }
/** Layout styles live in styles.xml automatic-styles. A sole static master is
 * the document default. Paragraph master references remain unsupported because
 * they introduce page boundaries, even when they select this same master. */
export function readOdtPageGeometry(roots: readonly XmlElement[]): OdtPageGeometry | undefined {
  const layouts: XmlElement[] = [], masters: XmlElement[] = [];
  for (const root of roots) for (const container of root.children) {
    if (is(container, OFFICE, "automatic-styles")) {
      for (const node of container.children) if (is(node, STYLE, "page-layout")) {
        if (!is(root, OFFICE, "document-styles")) fail();
        layouts.push(node);
      }
    }
    if (is(container, OFFICE, "master-styles")) {
      attrs(container, []);
      if (!is(root, OFFICE, "document-styles") || container.text.trim()) fail();
      for (const node of container.children) { if (!is(node, STYLE, "master-page")) fail(); masters.push(node); }
    }
  }
  if (!layouts.length && !masters.length) return undefined;
  if (layouts.length !== 1 || masters.length !== 1) fail();
  const layout = layouts[0], master = masters[0];
  attrs(layout, [`${STYLE}|name`, `${STYLE}|page-usage`]);
  const usage = xmlAttribute(layout, "page-usage", STYLE);
  if ((usage !== undefined && usage !== "all") || layout.text.trim() || layout.children.length !== 1) fail();
  attrs(master, [`${STYLE}|name`, `${STYLE}|display-name`, `${STYLE}|page-layout-name`, `${STYLE}|next-style-name`]);
  const name = xmlAttribute(master, "name", STYLE), layoutName = xmlAttribute(layout, "name", STYLE);
  const next = xmlAttribute(master, "next-style-name", STYLE);
  if (!name || !layoutName || name.length > 200 || layoutName.length > 200 || (next !== undefined && next !== name)
    || xmlAttribute(master, "page-layout-name", STYLE) !== layoutName || master.children.length || master.text.trim()) fail();
  const properties = layout.children[0];
  if (!is(properties, STYLE, "page-layout-properties") || properties.children.length || properties.text.trim()) fail();
  attrs(properties, ["page-width", "page-height", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left"].map(n => `${FO}|${n}`).concat(`${STYLE}|print-orientation`));
  const widthPoints = points(xmlAttribute(properties, "page-width", FO));
  const heightPoints = points(xmlAttribute(properties, "page-height", FO));
  const orientation = xmlAttribute(properties, "print-orientation", STYLE) ?? "portrait";
  if (!["portrait", "landscape"].includes(orientation) || Math.min(widthPoints, heightPoints) < 72
    || (orientation === "portrait" ? widthPoints > heightPoints : heightPoints > widthPoints)) fail();
  const margin = xmlAttribute(properties, "margin", FO);
  const marginTopPoints = points(xmlAttribute(properties, "margin-top", FO) ?? margin);
  const marginRightPoints = points(xmlAttribute(properties, "margin-right", FO) ?? margin);
  const marginBottomPoints = points(xmlAttribute(properties, "margin-bottom", FO) ?? margin);
  const marginLeftPoints = points(xmlAttribute(properties, "margin-left", FO) ?? margin);
  if (Math.max(marginTopPoints, marginRightPoints, marginBottomPoints, marginLeftPoints) > 1440
    || marginTopPoints + marginBottomPoints >= heightPoints || marginLeftPoints + marginRightPoints >= widthPoints) fail();
  return { properties, layout: { widthPoints, heightPoints, orientation: orientation as "portrait" | "landscape", marginTopPoints, marginRightPoints, marginBottomPoints, marginLeftPoints } };
}
export function odtPageProperties(layout: DocxPageLayout): string {
  return `<style:page-layout-properties xmlns:style="${STYLE}" xmlns:fo="${FO}" fo:page-width="${layout.widthPoints}pt" fo:page-height="${layout.heightPoints}pt" style:print-orientation="${layout.orientation}" fo:margin-top="${layout.marginTopPoints}pt" fo:margin-right="${layout.marginRightPoints}pt" fo:margin-bottom="${layout.marginBottomPoints}pt" fo:margin-left="${layout.marginLeftPoints}pt"/>`;
}
export function odtPageStyles(layout: DocxPageLayout, name = "MarkiePage"): { automatic: string; master: string } {
  return { automatic: `<style:page-layout xmlns:style="${STYLE}" style:name="${name}">${odtPageProperties(layout)}</style:page-layout>`,
    master: `<office:master-styles xmlns:office="${OFFICE}" xmlns:style="${STYLE}"><style:master-page xmlns:style="${STYLE}" style:name="${name}" style:page-layout-name="${name}"/></office:master-styles>` };
}
export function appendOdtXml(source: string, node: XmlElement, markup: string): string {
  if (node.endTagStart >= node.startTagEnd) return source.slice(0, node.endTagStart) + markup + source.slice(node.endTagStart);
  return source.slice(0, node.start) + source.slice(node.start, node.startTagEnd).replace(/\/>$/, ">") + markup + `</${node.name}>` + source.slice(node.end);
}
