//! Fonts embedded in a Word file: read for display, and kept on save.
mod common {
    pub mod docx_fixture;
}
use common::docx_fixture::*;
use markie_office::docx::fonts::{DocxFontVariant, deobfuscate_docx_font, docx_embedded_fonts};

const KEY: &str = "{1DFFA2A4-0B2A-4F7C-9E35-8C0A4E2B7D11}";

/// Bytes that start like a TrueType font.
fn font_bytes(seed: u8) -> Vec<u8> {
    [0u8, 1, 0, 0].into_iter().chain((0..400u32).map(|i| (i as u8).wrapping_mul(7).wrapping_add(seed))).collect()
}

fn with_fonts(dangling: bool) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let extra = if dangling { format!(r#"<w:embedItalic r:id="rId9" w:fontKey="{KEY}"/>"#) } else { String::new() };
    let regular = deobfuscate_docx_font(&font_bytes(1), KEY).unwrap();
    let bold = deobfuscate_docx_font(&font_bytes(2), KEY).unwrap();
    let (r, b) = (regular.clone(), bold.clone());
    let bytes = fixture(move |entries| {
        change_xml(entries, "[Content_Types].xml", |xml| {
            xml.replace(
                "</Types>",
                r#"<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>"#,
            )
        });
        entries.push(ZipEntry::new(
            "word/fontTable.xml",
            format!(
                r#"<w:fonts xmlns:w="{W}" xmlns:r="{R}"><w:font w:name="Brand Sans"><w:embedRegular r:id="rId1" w:fontKey="{KEY}"/><w:embedBold r:id="rId2" w:fontKey="{KEY}"/>{extra}</w:font><w:font w:name="Loose"><w:embedRegular r:id="rId3" w:fontKey="nope"/></w:font></w:fonts>"#
            ),
        ));
        entries.push(ZipEntry::new(
            "word/_rels/fontTable.xml.rels",
            format!(
                r#"<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{R}/font" Target="fonts/font1.odttf"/><Relationship Id="rId2" Type="{R}/font" Target="fonts/font2.odttf"/><Relationship Id="rId3" Type="{R}/font" Target="fonts/font1.odttf"/></Relationships>"#
            ),
        ));
        entries.push(ZipEntry::new("word/fonts/font1.odttf", r));
        entries.push(ZipEntry::new("word/fonts/font2.odttf", b));
    });
    (bytes, regular, bold)
}

#[test]
fn embedded_fonts_are_read_with_the_obfuscation_removed() {
    let (bytes, _, _) = with_fonts(true);
    let fonts = docx_embedded_fonts(&bytes);
    // A missing part and a key that is not a GUID are simply not fonts.
    assert_eq!(fonts.len(), 2);
    assert_eq!((fonts[0].family.as_str(), fonts[0].variant, fonts[0].part.as_str()), ("Brand Sans", DocxFontVariant::Regular, "word/fonts/font1.odttf"));
    assert_eq!(fonts[0].data, font_bytes(1));
    assert_eq!((fonts[1].variant, &fonts[1].data), (DocxFontVariant::Bold, &font_bytes(2)));
    assert!(docx_embedded_fonts(b"not a zip").is_empty());
}

#[test]
fn saving_keeps_the_embedded_fonts_exactly_as_they_arrived() {
    let (bytes, regular, bold) = with_fonts(false);
    let opened = open(&bytes);
    let run = opened.paragraphs[0].runs[0].id.clone();
    let saved = export(&replace(&opened, &run, "Changed"));
    let entries = read_zip(&saved, DEFAULT_ZIP_LIMITS).unwrap();
    let part = |name: &str| entries.iter().find(|e| e.name == name).map(|e| e.data.clone());
    assert_eq!(part("word/fonts/font1.odttf"), Some(regular), "still obfuscated, byte for byte");
    assert_eq!(part("word/fonts/font2.odttf"), Some(bold));
    assert!(String::from_utf8(part("word/fontTable.xml").unwrap()).unwrap().contains(KEY));
    assert!(String::from_utf8(part("word/document.xml").unwrap()).unwrap().contains("Changed"));
    assert_eq!(docx_embedded_fonts(&saved).len(), 2);
}
