/** Self-authored specification-shaped fixtures; no third-party document assets. */
import { writeZip, type ZipEntry } from "./zip";

export const ODT_FIXTURE_CONTENT = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"><office:automatic-styles><style:style style:name="Centered" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="6pt"/></style:style><style:style style:name="Accent" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#336699" fo:font-size="125%"/></style:style></office:automatic-styles><office:body><office:text><text:p text:style-name="Centered">  OpenDocument <text:span text:style-name="Accent">  editing </text:span> works.  </text:p><text:p>Unicode: café, Ελληνικά, 日本語, 👋<text:s text:c="2"/>tabs<text:tab/>and<text:line-break/>lines.</text:p></office:text></office:body></office:document-content>`;
export const ODT_FIXTURE_STYLES = `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"><office:font-face-decls><style:font-face style:name="Editorial" svg:font-family="Georgia"/></office:font-face-decls><office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt" style:font-name="Editorial" fo:color="#222222"/></style:default-style><style:style style:name="Body" style:family="paragraph"><style:text-properties fo:font-size="16pt"/><style:paragraph-properties fo:margin-top="3pt"/></style:style></office:styles></office:document-styles>`;

export function odtFixture(options: { content?: string; styles?: string; manifest?: string; extra?: readonly ZipEntry[] } = {}): Uint8Array {
  const enc = new TextEncoder();
  const extra = options.extra ?? [{ name: "Pictures/retained.bin", data: new Uint8Array([4, 3, 2, 1]) }];
  const manifest = options.manifest ?? `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>${extra.map(e => `<manifest:file-entry manifest:full-path="${e.name}" manifest:media-type="application/octet-stream"/>`).join("")}</manifest:manifest>`;
  return writeZip([
    { name: "mimetype", data: enc.encode("application/vnd.oasis.opendocument.text") },
    { name: "content.xml", data: enc.encode(options.content ?? ODT_FIXTURE_CONTENT) },
    { name: "styles.xml", data: enc.encode(options.styles ?? ODT_FIXTURE_STYLES) },
    { name: "meta.xml", data: enc.encode('<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.3"><office:meta/></office:document-meta>') },
    { name: "META-INF/manifest.xml", data: enc.encode(manifest) }, ...extra,
  ]);
}
