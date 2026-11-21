//! Shared DOCX test helpers (port of the helpers at the top of docx*.test.ts).
#![allow(dead_code)]
pub use markie_office::docx::*;
pub use markie_office::model::*;
pub use markie_office::zip::{DEFAULT_ZIP_LIMITS, ZipEntry, ZipLimits, read_zip, write_zip};

pub const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
pub const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub const REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
pub const CT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";

pub fn fixture(transform: impl FnOnce(&mut Vec<ZipEntry>)) -> Vec<u8> {
    let mut entries = read_zip(&export_docx(&create_docx("Hello\nWorld").unwrap()).unwrap(), DEFAULT_ZIP_LIMITS).unwrap();
    transform(&mut entries);
    write_zip(&entries, DEFAULT_ZIP_LIMITS).unwrap()
}
pub fn change_xml(entries: &mut [ZipEntry], name: &str, change: impl FnOnce(&str) -> String) {
    let entry = entries.iter_mut().find(|e| e.name == name).unwrap();
    entry.data = change(&String::from_utf8(entry.data.clone()).unwrap()).into_bytes();
}
pub fn body(entries: &mut [ZipEntry], markup: &str) {
    change_xml(entries, "word/document.xml", |_| format!(r#"<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{markup}</w:body></w:document>"#));
}
pub fn add_relationship(entries: &mut Vec<ZipEntry>, kind: &str, target: &str, extra: &str) {
    entries.push(ZipEntry::new("word/_rels/document.xml.rels", format!(r#"<Relationships xmlns="{REL}"><Relationship Id="rId2" Type="{R}/{kind}" Target="{target}"{extra}/></Relationships>"#)));
}
pub fn open(bytes: &[u8]) -> DocxDocument { open_docx(bytes, DEFAULT_ZIP_LIMITS).unwrap_or_else(|e| panic!("{}", e.message)) }
pub fn open_err(bytes: &[u8]) -> String { open_docx(bytes, DEFAULT_ZIP_LIMITS).err().expect("expected rejection").message }
pub fn export(d: &DocxDocument) -> Vec<u8> { export_docx(d).unwrap_or_else(|e| panic!("{}", e.message)) }
pub fn reopen(d: &DocxDocument) -> DocxDocument { open(&export(d)) }
pub fn edit(id: &str, text: &str) -> Vec<TextEdit> { vec![TextEdit { run_id: id.into(), text: text.into() }] }
pub fn replace(d: &DocxDocument, id: &str, text: &str) -> DocxDocument { replace_docx_text(d, &edit(id, text)).unwrap_or_else(|e| panic!("{}", e.message)) }
pub fn apply(d: &DocxDocument, ops: &[Operation]) -> DocxDocument { apply_docx_operations(d, ops).unwrap_or_else(|e| panic!("{}", e.message)) }
pub fn apply_err(d: &DocxDocument, ops: &[Operation]) -> String { apply_docx_operations(d, ops).err().expect("expected rejection").message }
pub fn part(bytes: &[u8], name: &str) -> Option<String> {
    read_zip(bytes, DEFAULT_ZIP_LIMITS).unwrap().into_iter().find(|e| e.name == name).map(|e| String::from_utf8(e.data).unwrap())
}
pub fn document_xml(bytes: &[u8]) -> String { part(bytes, "word/document.xml").unwrap() }
pub fn fmt(f: impl FnOnce(&mut RunFormat)) -> RunFormat { let mut r = RunFormat::default(); f(&mut r); r }
pub fn package(parts: &[(&str, String)]) -> Vec<u8> {
    write_zip(&parts.iter().map(|(n, d)| ZipEntry::new(*n, d.clone())).collect::<Vec<_>>(), DEFAULT_ZIP_LIMITS).unwrap()
}

/// Original 1x1 red RGBA PNG (one zero filter byte plus four samples).
pub fn png(width: u32, height: u32) -> Vec<u8> {
    let chunk = |name: &[u8], data: &[u8]| {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend(name); out.extend(data);
        let crc = markie_office::zip::zip_crc32(&out[4..]);
        out.extend(crc.to_be_bytes()); out
    };
    let mut ihdr = width.to_be_bytes().to_vec(); ihdr.extend(height.to_be_bytes()); ihdr.extend([8u8, 6, 0, 0, 0]);
    let idat = miniz_oxide::deflate::compress_to_vec_zlib(&[0, 255, 0, 0, 255], 6);
    let mut out = vec![137u8, 80, 78, 71, 13, 10, 26, 10];
    out.extend(chunk(b"IHDR", &ihdr)); out.extend(chunk(b"IDAT", &idat)); out.extend(chunk(b"IEND", &[]));
    out
}
pub fn image(after: InsertAt, w: f64, h: f64) -> Operation {
    Operation::InsertImage(ImageInput { after_paragraph_id: after, bytes: png(1, 1), content_type: ImageType::Png, width_points: w, height_points: h, alt_text: None })
}
pub fn swap_part(bytes: &[u8], name: &str, change: impl FnOnce(&str) -> String) -> Vec<u8> {
    let mut parts = read_zip(bytes, DEFAULT_ZIP_LIMITS).unwrap();
    change_xml(&mut parts, name, change);
    write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap()
}
/// Replaces the `<Default Extension="rels" .../>` with an override-only declaration.
pub fn override_only_rels(bytes: &[u8]) -> Vec<u8> {
    swap_part(bytes, "[Content_Types].xml", |x| {
        let s = x.find(r#"<Default Extension="rels""#).unwrap(); let e = s + x[s..].find("/>").unwrap() + 2;
        format!("{}{}{}", &x[..s], r#"<Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#, &x[e..])
    })
}
