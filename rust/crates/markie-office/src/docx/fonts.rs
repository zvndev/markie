//! Fonts embedded in a Word document (`src/lib/office/docx-fonts.ts`).
//!
//! Word can save the fonts a document uses inside the file
//! (`word/fonts/font1.odttf`). Each is a TrueType or OpenType font whose first
//! 32 bytes are XORed with a key, the font's GUID from `word/fontTable.xml`
//! (ECMA-376 Part 4, 2.8.1). This reads the table, finds the parts and
//! removes the obfuscation.
//!
//! Nothing here changes the package. The bytes that come back are copies, and
//! saving keeps every font part exactly as it arrived.

use std::collections::HashMap;

use crate::xml::{XmlElement, parse_xml, xml_descendants};
use crate::zip::ZipEntry;

const W: [&str; 2] = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
const R: [&str; 2] = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocxFontVariant {
    Regular,
    Bold,
    Italic,
    BoldItalic,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocxEmbeddedFont {
    /// The name the document's runs use for it.
    pub family: String,
    pub variant: DocxFontVariant,
    /// The font itself, with the obfuscation removed.
    pub data: Vec<u8>,
    /// The package part it came from.
    pub part: String,
}

const MAX_FONTS: usize = 32;
const MAX_FONT_BYTES: usize = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

/// The 16-byte key a font key GUID stands for, or None when it is not a GUID.
pub fn docx_font_key(font_key: &str) -> Option<[u8; 16]> {
    let text = font_key.trim();
    let text = text.strip_prefix('{').unwrap_or(text);
    let text = text.strip_suffix('}').unwrap_or(text);
    let groups: Vec<&str> = text.split('-').collect();
    if groups.iter().map(|g| g.len()).collect::<Vec<_>>() != [8, 4, 4, 4, 12] || !text.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let hex: String = groups.concat();
    let mut key = [0u8; 16];
    for (i, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[30 - i * 2..32 - i * 2], 16).ok()?;
    }
    Some(key)
}

/// Removes (or applies: XOR is its own inverse) the obfuscation on an .odttf
/// part. Returns a new buffer; the part itself is never changed.
pub fn deobfuscate_docx_font(data: &[u8], font_key: &str) -> Option<Vec<u8>> {
    let key = docx_font_key(font_key)?;
    if data.len() < 32 {
        return None;
    }
    let mut font = data.to_vec();
    for (i, byte) in font.iter_mut().take(32).enumerate() {
        *byte ^= key[i % 16];
    }
    Some(font)
}

/// Whether the first four bytes say this is a font Markie will load:
/// TrueType (1.0 or 'true') or OpenType ('OTTO').
pub fn is_sfnt(data: &[u8]) -> bool {
    data.len() >= 12 && matches!(&data[..4], [0, 1, 0, 0] | b"true" | b"OTTO")
}

fn relationships_part(part: &str) -> String {
    match part.rfind('/') {
        Some(slash) => format!("{}_rels/{}.rels", &part[..slash + 1], &part[slash + 1..]),
        None => format!("_rels/{part}.rels"),
    }
}

fn resolve(source: &str, target: &str) -> Option<String> {
    if target.is_empty() || target.chars().any(|c| matches!(c, '\\' | ':' | '%' | '?' | '#' | '\u{7f}') || c <= ' ') {
        return None;
    }
    let mut pieces: Vec<&str> = if target.starts_with('/') { Vec::new() } else { source.split('/').collect::<Vec<_>>().split_last().map(|(_, rest)| rest.to_vec()).unwrap_or_default() };
    for piece in target.strip_prefix('/').unwrap_or(target).split('/') {
        match piece {
            "" | "." => return None,
            ".." => {
                pieces.pop()?;
            }
            other => pieces.push(other),
        }
    }
    Some(pieces.join("/"))
}

fn decode(data: &[u8]) -> Option<XmlElement> {
    parse_xml(std::str::from_utf8(data).ok()?).ok()
}

fn attr_in<'a>(node: &'a XmlElement, name: &str, namespaces: &[&str]) -> Option<&'a str> {
    namespaces.iter().find_map(|ns| node.attr(name, ns)).filter(|v| !v.is_empty())
}

/// The embedded fonts in a package's parts. Never fails: a font table that
/// cannot be read, a key that is not a GUID, or bytes that are not a font
/// once the key is applied are all simply not fonts, and the document opens
/// without them exactly as it did before.
pub fn read_docx_embedded_fonts(entries: &[ZipEntry]) -> Vec<DocxEmbeddedFont> {
    let parts: HashMap<&str, &[u8]> = entries.iter().map(|e| (e.name.as_str(), e.data.as_slice())).collect();
    let mut fonts = Vec::new();
    let mut total = 0usize;
    for entry in entries {
        let file = entry.name.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
        if !(file.starts_with("fonttable") && file.ends_with(".xml")) {
            continue;
        }
        let Some(table) = decode(&entry.data).filter(|t| t.local_name == "fonts" && W.contains(&t.namespace.as_str())) else { continue };
        let Some(rels) = parts.get(relationships_part(&entry.name).as_str()).and_then(|d| decode(d)) else { continue };
        let mut targets: HashMap<&str, String> = HashMap::new();
        for rel in &rels.children {
            let (Some(id), Some(target)) = (rel.plain("Id"), rel.plain("Target")) else { continue };
            if rel.plain("TargetMode") == Some("External") || !rel.plain("Type").is_some_and(|t| t.ends_with("/font")) {
                continue;
            }
            if let Some(resolved) = resolve(&entry.name, target) {
                targets.insert(id, resolved);
            }
        }
        for font in xml_descendants(&table) {
            if font.local_name != "font" || !W.contains(&font.namespace.as_str()) {
                continue;
            }
            let Some(family) = attr_in(font, "name", &W).map(str::trim).filter(|f| !f.is_empty() && f.encode_utf16().count() <= 200 && !f.chars().any(|c| c < ' ' || c == '\u{7f}')) else { continue };
            for embed in &font.children {
                if !W.contains(&embed.namespace.as_str()) {
                    continue;
                }
                let variant = match embed.local_name.as_str() {
                    "embedRegular" => DocxFontVariant::Regular,
                    "embedBold" => DocxFontVariant::Bold,
                    "embedItalic" => DocxFontVariant::Italic,
                    "embedBoldItalic" => DocxFontVariant::BoldItalic,
                    _ => continue,
                };
                let Some(part) = attr_in(embed, "id", &R).and_then(|id| targets.get(id)) else { continue };
                let Some(raw) = parts.get(part.as_str()) else { continue };
                if raw.len() > MAX_FONT_BYTES || total + raw.len() > MAX_TOTAL_BYTES || fonts.len() >= MAX_FONTS {
                    continue;
                }
                // A part with no key is taken as it is, when it is a font already.
                let data = match attr_in(embed, "fontKey", &W) {
                    Some(key) => deobfuscate_docx_font(raw, key),
                    None => Some(raw.to_vec()),
                };
                let Some(data) = data.filter(|d| is_sfnt(d)) else { continue };
                total += raw.len();
                fonts.push(DocxEmbeddedFont { family: family.to_string(), variant, data, part: part.clone() });
            }
        }
    }
    fonts
}

/// The name a document's embedded family is loaded under: private to the
/// font's own bytes, so it never stands in for an installed font of the same
/// name and two documents that embed different fonts under one name do not
/// share one.
pub fn embedded_alias(family: &str, data: &[u8]) -> String {
    // FNV-1a over the font, which is all the name has to tell apart.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    let plain: String = family.chars().filter(|c| c.is_ascii_alphanumeric() || *c == ' ').take(40).collect();
    format!("Markie Doc {:08x} {}", hash as u32, plain.trim())
}

fn be16(data: &[u8], at: usize) -> Option<usize> {
    data.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]) as usize)
}

fn be32(data: &[u8], at: usize) -> Option<usize> {
    data.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
}

fn checksum(table: &[u8]) -> u32 {
    table.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

/// A `name` table that calls the font `family`, in the style `variant`.
fn name_table(family: &str, variant: DocxFontVariant) -> Vec<u8> {
    let style = match variant {
        DocxFontVariant::Regular => "Regular",
        DocxFontVariant::Bold => "Bold",
        DocxFontVariant::Italic => "Italic",
        DocxFontVariant::BoldItalic => "Bold Italic",
    };
    let postscript: String = format!("{family}-{style}").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    // Family, style, unique id, full name, PostScript name.
    let names: [(u16, String); 5] = [(1, family.to_string()), (2, style.to_string()), (3, format!("{family} {style}")), (4, format!("{family} {style}")), (6, postscript)];
    let mut records = Vec::new();
    let mut strings = Vec::new();
    for (id, text) in &names {
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        // Windows, Unicode BMP, US English.
        for field in [3u16, 1, 0x0409, *id, bytes.len() as u16, strings.len() as u16] {
            records.extend(field.to_be_bytes());
        }
        strings.extend(bytes);
    }
    let mut table = Vec::new();
    for field in [0u16, names.len() as u16, (6 + records.len()) as u16] {
        table.extend(field.to_be_bytes());
    }
    table.extend(records);
    table.extend(strings);
    table
}

/// The same font under another family name: its `name` table replaced and
/// the file's directory and checksums written again. None when the bytes
/// are not a single TrueType or OpenType font this can read.
pub fn rename_font_family(data: &[u8], family: &str, variant: DocxFontVariant) -> Option<Vec<u8>> {
    if !is_sfnt(data) {
        return None;
    }
    let count = be16(data, 4)?;
    let mut tables: Vec<([u8; 4], Vec<u8>)> = Vec::with_capacity(count + 1);
    for i in 0..count {
        let record = 12 + i * 16;
        let tag: [u8; 4] = data.get(record..record + 4)?.try_into().ok()?;
        let (offset, length) = (be32(data, record + 8)?, be32(data, record + 12)?);
        if &tag != b"name" {
            tables.push((tag, data.get(offset..offset.checked_add(length)?)?.to_vec()));
        }
    }
    tables.push((*b"name", name_table(family, variant)));
    tables.sort_by_key(|(tag, _)| *tag);
    // `head.checkSumAdjustment` is zero while the file is summed.
    for (tag, table) in tables.iter_mut() {
        if tag == b"head" {
            table.get_mut(8..12)?.fill(0);
        }
    }
    let n = tables.len();
    let pow = 1usize << (usize::BITS - 1 - n.leading_zeros());
    let mut out = Vec::new();
    out.extend_from_slice(&data[..4]);
    for field in [n as u16, (pow * 16) as u16, pow.trailing_zeros() as u16, ((n - pow) * 16) as u16] {
        out.extend(field.to_be_bytes());
    }
    let mut offset = 12 + n * 16;
    let mut head_at = None;
    for (tag, table) in &tables {
        out.extend_from_slice(tag);
        out.extend(checksum(table).to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((table.len() as u32).to_be_bytes());
        if tag == b"head" {
            head_at = Some(offset);
        }
        offset += table.len().div_ceil(4) * 4;
    }
    for (_, table) in &tables {
        out.extend_from_slice(table);
        out.resize(out.len().div_ceil(4) * 4, 0);
    }
    if let Some(at) = head_at {
        let adjustment = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
        out.get_mut(at + 8..at + 12)?.copy_from_slice(&adjustment.to_be_bytes());
    }
    Some(out)
}

/// A document's embedded fonts ready to load: each family under its private
/// alias, with (the name the document's runs use, the alias) for the view.
/// A font that cannot be renamed is left out, and its text is drawn as it
/// would be with no embedded copy.
pub fn aliased_embedded_fonts(fonts: &[DocxEmbeddedFont]) -> (Vec<Vec<u8>>, Vec<(String, String)>) {
    let mut data = Vec::new();
    let mut names: Vec<(String, String)> = Vec::new();
    for font in fonts {
        // One alias for a family: its first face names it.
        let alias = match names.iter().find(|(family, _)| family.eq_ignore_ascii_case(&font.family)) {
            Some((_, alias)) => alias.clone(),
            None => embedded_alias(&font.family, &font.data),
        };
        if let Some(renamed) = rename_font_family(&font.data, &alias, font.variant) {
            data.push(renamed);
            if !names.iter().any(|(family, _)| family.eq_ignore_ascii_case(&font.family)) {
                names.push((font.family.clone(), alias));
            }
        }
    }
    (data, names)
}

/// The embedded fonts of a DOCX file's bytes, or none when it cannot be read.
pub fn docx_embedded_fonts(bytes: &[u8]) -> Vec<DocxEmbeddedFont> {
    match crate::zip::read_zip(bytes, crate::zip::ZipLimits::default()) {
        Ok(entries) => read_docx_embedded_fonts(&entries),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_the_guid_read_backwards() {
        let key = docx_font_key("{1DFFA2A4-0B2A-4F7C-9E35-8C0A4E2B7D11}").unwrap();
        assert_eq!(key[0], 0x11);
        assert_eq!(key[15], 0x1d);
        assert_eq!(docx_font_key("1dffa2a4-0b2a-4f7c-9e35-8c0a4e2b7d11"), Some(key));
        assert_eq!(docx_font_key("not-a-guid"), None);
        assert_eq!(docx_font_key("{1DFFA2A4-0B2A-4F7C-9E35-8C0A4E2B7DZZ}"), None);
    }

    #[test]
    fn xor_is_its_own_inverse_and_only_touches_32_bytes() {
        let font: Vec<u8> = [0u8, 1, 0, 0].into_iter().chain((4..80).map(|i| i as u8)).collect();
        let key = "{1DFFA2A4-0B2A-4F7C-9E35-8C0A4E2B7D11}";
        let hidden = deobfuscate_docx_font(&font, key).unwrap();
        assert_ne!(&hidden[..32], &font[..32]);
        assert_eq!(&hidden[32..], &font[32..]);
        assert!(!is_sfnt(&hidden));
        assert_eq!(deobfuscate_docx_font(&hidden, key).unwrap(), font);
        assert_eq!(deobfuscate_docx_font(&font[..20], key), None);
        assert!(is_sfnt(b"OTTO\0\0\0\0\0\0\0\0") && is_sfnt(b"true\0\0\0\0\0\0\0\0") && !is_sfnt(b"wOF2\0\0\0\0\0\0\0\0"));
    }

    /// A real font (the bundled Carlito, unpacked by the test below it)
    /// is not needed to check the rewrite: any well-formed table directory will do.
    fn tiny_font() -> Vec<u8> {
        let head = vec![0u8; 54];
        let glyf = vec![7u8; 10];
        let name = name_table("Old Name", DocxFontVariant::Regular);
        let tables: [(&[u8; 4], &Vec<u8>); 3] = [(b"glyf", &glyf), (b"head", &head), (b"name", &name)];
        let mut out = vec![0, 1, 0, 0, 0, 3, 0, 32, 0, 1, 0, 16];
        let mut offset = 12 + 16 * 3;
        for (tag, table) in tables {
            out.extend_from_slice(tag);
            out.extend(checksum(table).to_be_bytes());
            out.extend((offset as u32).to_be_bytes());
            out.extend((table.len() as u32).to_be_bytes());
            offset += table.len().div_ceil(4) * 4;
        }
        for (_, table) in tables {
            out.extend_from_slice(table);
            out.resize(out.len().div_ceil(4) * 4, 0);
        }
        out
    }

    fn family_of(font: &[u8]) -> String {
        let count = be16(font, 4).unwrap();
        let record = (0..count).map(|i| 12 + i * 16).find(|r| &font[*r..*r + 4] == b"name").unwrap();
        let table = &font[be32(font, record + 8).unwrap()..][..be32(font, record + 12).unwrap()];
        let strings = be16(table, 4).unwrap();
        let (length, offset) = (be16(table, 6 + 8).unwrap(), be16(table, 6 + 10).unwrap());
        let units: Vec<u16> = table[strings + offset..strings + offset + length].chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn an_embedded_font_is_loaded_under_a_private_name() {
        let font = tiny_font();
        assert_eq!(family_of(&font), "Old Name");
        let alias = embedded_alias("Brand Sans!", &font);
        assert!(alias.starts_with("Markie Doc ") && alias.ends_with(" Brand Sans"), "{alias}");
        assert_ne!(alias, embedded_alias("Brand Sans!", &[1, 2, 3]), "another font, another name");
        let renamed = rename_font_family(&font, &alias, DocxFontVariant::Bold).unwrap();
        assert_eq!(family_of(&renamed), alias);
        // The other tables are untouched, and the file sums to the magic number.
        assert!(renamed.windows(10).any(|w| w == [7u8; 10]));
        assert_eq!(checksum(&renamed), 0xB1B0_AFBA);
        assert_eq!(rename_font_family(b"wOF2 not a font", &alias, DocxFontVariant::Regular), None);
        // A family's faces share one alias.
        let fonts = vec![
            DocxEmbeddedFont { family: "Brand Sans".into(), variant: DocxFontVariant::Regular, data: font.clone(), part: "a".into() },
            DocxEmbeddedFont { family: "Brand Sans".into(), variant: DocxFontVariant::Bold, data: renamed.clone(), part: "b".into() },
        ];
        let (data, names) = aliased_embedded_fonts(&fonts);
        assert_eq!((data.len(), names.len()), (2, 1));
        assert_eq!(family_of(&data[1]), names[0].1);
    }

    #[test]
    fn targets_stay_inside_the_package() {
        assert_eq!(resolve("word/fontTable.xml", "fonts/font1.odttf").as_deref(), Some("word/fonts/font1.odttf"));
        assert_eq!(resolve("word/fontTable.xml", "/word/fonts/a.odttf").as_deref(), Some("word/fonts/a.odttf"));
        assert_eq!(resolve("word/fontTable.xml", "../x.odttf").as_deref(), Some("x.odttf"));
        assert_eq!(resolve("word/fontTable.xml", "../../x.odttf"), None);
        assert_eq!(resolve("word/fontTable.xml", "http://x/y"), None);
        assert_eq!(relationships_part("word/fontTable.xml"), "word/_rels/fontTable.xml.rels");
    }
}
