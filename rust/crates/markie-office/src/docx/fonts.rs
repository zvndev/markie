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
