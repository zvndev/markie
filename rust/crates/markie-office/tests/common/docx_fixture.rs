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
