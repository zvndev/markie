//! Port of src/lib/office/odt.fixture.ts: self-authored, specification-shaped fixtures.
#![allow(dead_code)]
use markie_office::zip::{DEFAULT_ZIP_LIMITS, ZipEntry, write_zip};

pub const ODT_FIXTURE_CONTENT: &str = r##"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"><office:automatic-styles><style:style style:name="Centered" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="6pt"/></style:style><style:style style:name="Accent" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#336699" fo:font-size="125%"/></style:style></office:automatic-styles><office:body><office:text><text:p text:style-name="Centered">  OpenDocument <text:span text:style-name="Accent">  editing </text:span> works.  </text:p><text:p>Unicode: café, Ελληνικά, 日本語, 👋<text:s text:c="2"/>tabs<text:tab/>and<text:line-break/>lines.</text:p></office:text></office:body></office:document-content>"##;
pub const ODT_FIXTURE_STYLES: &str = r##"<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"><office:font-face-decls><style:font-face style:name="Editorial" svg:font-family="Georgia"/></office:font-face-decls><office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt" style:font-name="Editorial" fo:color="#222222"/></style:default-style><style:style style:name="Body" style:family="paragraph"><style:text-properties fo:font-size="16pt"/><style:paragraph-properties fo:margin-top="3pt"/></style:style></office:styles></office:document-styles>"##;

#[derive(Default)]
pub struct Opts { pub content: Option<String>, pub styles: Option<String>, pub manifest: Option<String>, pub extra: Option<Vec<ZipEntry>> }

pub fn odt_fixture(o: Opts) -> Vec<u8> {
    let extra = o.extra.unwrap_or_else(|| vec![ZipEntry::new("Pictures/retained.bin", vec![4u8, 3, 2, 1])]);
    let manifest = o.manifest.unwrap_or_else(|| format!(r#"<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>{}</manifest:manifest>"#,
        extra.iter().map(|e| format!(r#"<manifest:file-entry manifest:full-path="{}" manifest:media-type="application/octet-stream"/>"#, e.name)).collect::<String>()));
    let mut entries = vec![
        ZipEntry::new("mimetype", "application/vnd.oasis.opendocument.text"),
        ZipEntry::new("content.xml", o.content.unwrap_or_else(|| ODT_FIXTURE_CONTENT.to_string())),
        ZipEntry::new("styles.xml", o.styles.unwrap_or_else(|| ODT_FIXTURE_STYLES.to_string())),
        ZipEntry::new("meta.xml", r#"<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.3"><office:meta/></office:document-meta>"#),
        ZipEntry::new("META-INF/manifest.xml", manifest),
    ];
    entries.extend(extra);
    write_zip(&entries, DEFAULT_ZIP_LIMITS).unwrap()
}

/// `content.replace(/<office:text>[\s\S]*<\/office:text>/, with)`
pub fn with_text(body: &str) -> String {
    let start = ODT_FIXTURE_CONTENT.find("<office:text>").unwrap();
    let end = ODT_FIXTURE_CONTENT.rfind("</office:text>").unwrap() + "</office:text>".len();
    format!("{}{}{}", &ODT_FIXTURE_CONTENT[..start], body, &ODT_FIXTURE_CONTENT[end..])
}
