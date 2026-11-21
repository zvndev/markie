//! Original bounded ODF 1.2/1.3 text codec, from OASIS ODF 1.3 Parts 2 and 3.
//! Ported from `src/lib/office/odt.ts`. Unsupported semantics reject the
//! editable import; `open_odt_for_display` then falls back to a read-only view.

mod page_layout;
mod readonly;

use crate::error::{OfficeError, Result};
use crate::model::*;
use crate::rich_text_model::*;
use crate::xml::{XmlElement, escape_xml_text, parse_xml, xml_attribute, xml_descendants};
use crate::zip::{DEFAULT_ZIP_LIMITS, ZipEntry, read_zip, validate_zip_path, write_zip};
use page_layout::{OdtPageGeometry, append_odt_xml, odt_page_properties, odt_page_styles, read_odt_page_geometry, split_length, unit_factor};
use readonly::{merge_run, read_odt_display_body};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) const OFFICE: &str = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
pub(crate) const TEXT: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
pub(crate) const TABLE: &str = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
pub(crate) const STYLE: &str = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
pub(crate) const FO: &str = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
pub(crate) const SVG: &str = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
const MANIFEST: &str = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const MIME: &str = "application/vnd.oasis.opendocument.text";
const XMLNS: &str = "http://www.w3.org/2000/xmlns/";

fn fail(message: &str) -> OfficeError {
    OfficeError::docx("unsupported-odt", message)
}

pub(crate) fn is(node: &XmlElement, ns: &str, name: &str) -> bool {
    node.namespace == ns && node.local_name == name
}

pub(crate) fn attrs(node: &XmlElement, allowed: &[(&str, &str)]) -> Result<()> {
    if node
        .attributes
        .iter()
        .any(|a| a.namespace != XMLNS && !allowed.iter().any(|(ns, n)| *ns == a.namespace && *n == a.local_name))
    {
        return Err(fail(&format!("Unsupported ODT attributes on {}.", node.local_name)));
    }
    Ok(())
}

fn only<'a>(node: &'a XmlElement, ns: &str, name: &str, required: bool) -> Result<Option<&'a XmlElement>> {
    let children: Vec<&XmlElement> = node.children.iter().filter(|c| is(c, ns, name)).collect();
    if children.len() > 1 || (required && children.is_empty()) {
        return Err(fail(&format!("Missing or ambiguous ODT {name}.")));
    }
    Ok(children.first().copied())
}

fn version(node: &XmlElement) -> Result<()> {
    match xml_attribute(node, "version", OFFICE) {
        Some("1.2" | "1.3") => Ok(()),
        _ => Err(fail("Only the bounded ODF 1.2/1.3 text subset is supported.")),
    }
}

/// `^\d+(?:\.\d+)?$`
pub(crate) fn is_decimal(value: &str) -> bool {
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}

/// Splits on `([ \t\r\n]+)` keeping separators: (is_whitespace, token).
pub(crate) fn split_whitespace_tokens(value: &str) -> Vec<(bool, &str)> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut space: Option<bool> = None;
    for (i, c) in value.char_indices() {
        let ws = matches!(c, ' ' | '\t' | '\r' | '\n');
        if space.is_some_and(|s| s != ws) {
            out.push((space.unwrap_or(false), &value[start..i]));
            start = i;
        }
        space = Some(ws);
    }
    if start < value.len() {
        out.push((space.unwrap_or(false), &value[start..]));
    }
    out
}

fn length(value: &str, base: Option<f64>) -> Result<f64> {
    let (number, unit) = split_length(value).ok_or_else(|| fail("Unsupported ODT length."))?;
    let factor = if unit == "%" { base.map_or(f64::NAN, |b| b / 100.0) } else { unit_factor(unit).ok_or_else(|| fail("Unsupported ODT length."))? };
    let result = number * factor;
    if !result.is_finite() || result > 2000.0 {
        return Err(fail("ODT length is outside the supported bounds."));
    }
    Ok(result)
}

fn unquote(value: &str) -> &str {
    if value.len() >= 2 && ((value.starts_with('\'') && value.ends_with('\'')) || (value.starts_with('"') && value.ends_with('"'))) {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn bad_family(value: &str) -> bool {
    value.chars().map(char::len_utf16).sum::<usize>() > 200 || value.chars().any(|c| c == ',' || (c as u32) < 0x20)
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Resolved {
    run: RunStyle,
    paragraph: ParagraphDefaults,
}

fn merge_paragraph(under: &ParagraphDefaults, over: &ParagraphDefaults) -> ParagraphDefaults {
    ParagraphDefaults {
        alignment: over.alignment.clone().or_else(|| under.alignment.clone()),
        spacing_before_points: over.spacing_before_points.or(under.spacing_before_points),
        spacing_after_points: over.spacing_after_points.or(under.spacing_after_points),
        line_spacing_multiple: over.line_spacing_multiple.or(under.line_spacing_multiple),
    }
}

struct Resolver<'a> {
    fonts: HashMap<String, String>,
    styles: HashMap<String, &'a XmlElement>,
    defaults: HashMap<String, &'a XmlElement>,
}

impl<'a> Resolver<'a> {
    fn new(roots: &[&'a XmlElement]) -> Result<Self> {
        let mut r = Resolver { fonts: HashMap::new(), styles: HashMap::new(), defaults: HashMap::new() };
        for root in roots {
            for container in &root.children {
                if is(container, OFFICE, "font-face-decls") {
                    attrs(container, &[])?;
                    if !container.text.trim().is_empty() {
                        return Err(fail("Invalid ODT font declarations."));
                    }
                    for face in &container.children {
                        if !is(face, STYLE, "font-face") || !face.children.is_empty() || !face.text.trim().is_empty() {
                            return Err(fail("Unsupported ODT font declaration."));
                        }
                        attrs(face, &[(STYLE, "name"), (SVG, "font-family"), (STYLE, "font-family-generic"), (STYLE, "font-pitch")])?;
                        let name = xml_attribute(face, "name", STYLE);
                        let family = xml_attribute(face, "font-family", SVG).map(unquote);
                        let (Some(name), Some(family)) = (name, family) else {
                            return Err(fail("Ambiguous ODT font declaration."));
                        };
                        if family.is_empty() || bad_family(family) || r.fonts.get(name).is_some_and(|f| f != family) {
                            return Err(fail("Ambiguous ODT font declaration."));
                        }
                        r.fonts.insert(name.to_string(), family.to_string());
                    }
                } else if is(container, OFFICE, "styles") || is(container, OFFICE, "automatic-styles") {
                    attrs(container, &[])?;
                    if !container.text.trim().is_empty() {
                        return Err(fail("Invalid ODT style container."));
                    }
                    for node in &container.children {
                        if is(container, OFFICE, "automatic-styles") && is(node, STYLE, "page-layout") {
                            continue; // Validated separately, including unused layouts.
                        }
                        if !is(node, STYLE, "style") && !is(node, STYLE, "default-style") {
                            return Err(fail("Unsupported ODT style kind."));
                        }
                        let family = xml_attribute(node, "family", STYLE);
                        let Some(family) = family.filter(|f| *f == "paragraph" || *f == "text") else {
                            return Err(fail("Unsupported ODT style family."));
                        };
                        attrs(
                            node,
                            &[(STYLE, "family"), (STYLE, "name"), (STYLE, "display-name"), (STYLE, "parent-style-name"), (STYLE, "next-style-name"), (STYLE, "master-page-name")],
                        )?;
                        // Even the same master forces a page break; reject every reference.
                        if xml_attribute(node, "master-page-name", STYLE).is_some() {
                            return Err(fail("Unsupported ODT master-page switch or forced page break."));
                        }
                        let name = xml_attribute(node, "name", STYLE);
                        let is_default = is(node, STYLE, "default-style");
                        if !is_default && name.is_none() {
                            return Err(fail("Missing or duplicate ODT style."));
                        }
                        let (map, id) = if is_default {
                            (&mut r.defaults, family.to_string())
                        } else {
                            (&mut r.styles, format!("{family}|{}", name.unwrap_or("")))
                        };
                        if map.insert(id, node).is_some() {
                            return Err(fail("Missing or duplicate ODT style."));
                        }
                    }
                }
            }
        }
        // Validate unused styles too: edits must not hide unsupported document semantics.
        let ids: Vec<(String, &XmlElement)> = r.styles.iter().map(|(k, v)| (k.clone(), *v)).collect();
        for (id, node) in ids {
            let family = id.split('|').next().unwrap_or("");
            r.resolve(family, xml_attribute(node, "name", STYLE), &Resolved { run: RunStyle { font_size_points: Some(12.0), ..Default::default() }, ..Default::default() })?;
        }
        for node in r.defaults.values() {
            r.apply(node, &Resolved::default())?;
        }
        Ok(r)
    }

    fn apply(&self, node: &XmlElement, base: &Resolved) -> Result<Resolved> {
        if !node.text.trim().is_empty() {
            return Err(fail("Invalid ODT style content."));
        }
        let mut run = base.run.clone();
        let mut paragraph = base.paragraph.clone();
        let mut seen: Vec<&str> = Vec::new();
        for properties in &node.children {
            if !properties.text.trim().is_empty() {
                return Err(fail("Invalid ODT property content."));
            }
            if seen.contains(&properties.local_name.as_str()) {
                return Err(fail("Duplicate ODT style properties."));
            }
            seen.push(&properties.local_name);
            if is(properties, STYLE, "text-properties") {
                if !properties.children.is_empty() {
                    return Err(fail("Unsupported ODT text properties."));
                }
                attrs(
                    properties,
                    &[
                        (FO, "font-weight"),
                        (FO, "font-style"),
                        (FO, "font-size"),
                        (FO, "font-family"),
                        (FO, "color"),
                        (STYLE, "font-name"),
                        (STYLE, "text-underline-style"),
                        (STYLE, "text-underline-type"),
                        (STYLE, "text-underline-color"),
                    ],
                )?;
                if let Some(weight) = xml_attribute(properties, "font-weight", FO) {
                    if !["normal", "bold", "400", "700"].contains(&weight) {
                        return Err(fail("Unsupported ODT font weight."));
                    }
                    run.bold = Some(weight == "bold" || weight == "700");
                }
                if let Some(italic) = xml_attribute(properties, "font-style", FO) {
                    if italic != "normal" && italic != "italic" {
                        return Err(fail("Unsupported ODT font style."));
                    }
                    run.italic = Some(italic == "italic");
                }
                if let Some(size) = xml_attribute(properties, "font-size", FO) {
                    let points = length(size, base.run.font_size_points)?;
                    if !(1.0..=400.0).contains(&points) {
                        return Err(fail("Unsupported ODT font size."));
                    }
                    run.font_size_points = Some(points);
                }
                let name = xml_attribute(properties, "font-name", STYLE);
                let family = xml_attribute(properties, "font-family", FO);
                if name.is_some() || family.is_some() {
                    let value = match name {
                        Some(n) => self.fonts.get(n).cloned(),
                        None => family.map(|f| unquote(f).to_string()),
                    };
                    match value {
                        Some(v) if !v.is_empty() && !bad_family(&v) => run.font_family = Some(v),
                        _ => return Err(fail("Unsupported or missing ODT font.")),
                    }
                }
                if let Some(color) = xml_attribute(properties, "color", FO) {
                    if !(color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())) {
                        return Err(fail("Unsupported ODT text color."));
                    }
                    run.color = Some(color[1..].to_string());
                }
                if xml_attribute(properties, "text-underline-type", STYLE).is_some_and(|t| t != "single") {
                    return Err(fail("Unsupported ODT underline type."));
                }
                if xml_attribute(properties, "text-underline-color", STYLE).is_some_and(|c| c != "font-color") {
                    return Err(fail("Unsupported ODT underline color."));
                }
                if let Some(u) = xml_attribute(properties, "text-underline-style", STYLE) {
                    if u != "none" && u != "solid" {
                        return Err(fail("Unsupported ODT underline style."));
                    }
                    run.underline = Some(if u == "solid" { "single" } else { "none" }.into());
                }
            } else if is(properties, STYLE, "paragraph-properties") {
                if xml_attribute(node, "family", STYLE) != Some("paragraph") {
                    return Err(fail("ODT text styles cannot carry paragraph properties."));
                }
                if !properties.children.is_empty() {
                    return Err(fail("Unsupported ODT paragraph properties."));
                }
                attrs(properties, &[(FO, "text-align"), (FO, "margin-top"), (FO, "margin-bottom"), (FO, "line-height")])?;
                if let Some(align) = xml_attribute(properties, "text-align", FO) {
                    if !["left", "right", "center", "justify"].contains(&align) {
                        return Err(fail("Unsupported ODT paragraph alignment."));
                    }
                    paragraph.alignment = Some(if align == "justify" { "both" } else { align }.into());
                }
                for (attribute, before) in [("margin-top", true), ("margin-bottom", false)] {
                    if let Some(v) = xml_attribute(properties, attribute, FO) {
                        let points = length(v, None)?;
                        if points > 1000.0 {
                            return Err(fail("ODT paragraph spacing exceeds the supported 1000-point limit."));
                        }
                        if before {
                            paragraph.spacing_before_points = Some(points);
                        } else {
                            paragraph.spacing_after_points = Some(points);
                        }
                    }
                }
                if let Some(line) = xml_attribute(properties, "line-height", FO) {
                    let Some(number) = line.strip_suffix('%').filter(|n| is_decimal(n)) else {
                        return Err(fail("Unsupported ODT line height."));
                    };
                    let multiple = number.parse::<f64>().unwrap_or(0.0) / 100.0;
                    if !(0.5..=5.0).contains(&multiple) {
                        return Err(fail("ODT line height is outside the supported 50–500% range."));
                    }
                    paragraph.line_spacing_multiple = Some(multiple);
                }
            } else {
                return Err(fail("Unsupported ODT style properties."));
            }
        }
        Ok(Resolved { run, paragraph })
    }

    fn resolve(&self, family: &str, name: Option<&str>, base: &Resolved) -> Result<Resolved> {
        let mut chain: Vec<&XmlElement> = Vec::new();
        let mut seen: Vec<&str> = Vec::new();
        let mut current = name;
        while let Some(c) = current {
            if seen.contains(&c) || seen.len() >= 128 {
                return Err(fail("Cyclic or excessively deep ODT style inheritance."));
            }
            seen.push(c);
            let Some(node) = self.styles.get(&format!("{family}|{c}")) else {
                return Err(fail("Missing ODT named style."));
            };
            chain.insert(0, node);
            current = xml_attribute(node, "parent-style-name", STYLE);
        }
        let mut result = base.clone();
        if let Some(fallback) = self.defaults.get(family) {
            // Family defaults fill only missing properties.
            let resolved = self.apply(fallback, &Resolved::default())?;
            result = Resolved { run: merge_run(&resolved.run, &base.run), paragraph: merge_paragraph(&resolved.paragraph, &base.paragraph) };
        }
        for node in chain {
            result = self.apply(node, &result)?;
        }
        Ok(result)
    }
}

struct Budget {
    characters: usize,
}

fn read_paragraph(node: &XmlElement, source: &str, resolver: &Resolver, budget: &mut Budget) -> Result<ParagraphInput> {
    attrs(node, &[(TEXT, "style-name")])?;
    let base = resolver.resolve("paragraph", xml_attribute(node, "style-name", TEXT), &Resolved::default())?;
    struct Acc<'b> {
        runs: Vec<RunInput>,
        pending: Option<RunStyle>,
        budget: &'b mut Budget,
    }
    impl Acc<'_> {
        fn room(&self, count: usize) -> Result<()> {
            if self.budget.characters + count > 1_000_000 {
                return Err(fail("ODT decoded text exceeds the supported character limit."));
            }
            Ok(())
        }
        fn emit(&mut self, text: &str, style: &RunStyle) -> Result<()> {
            if text.is_empty() {
                return Ok(());
            }
            let n = text.chars().map(char::len_utf16).sum();
            self.room(n)?;
            self.budget.characters += n;
            match self.runs.last_mut() {
                Some(previous) if previous.style == *style => previous.text.push_str(text),
                _ => self.runs.push(RunInput { text: text.into(), style: style.clone() }),
            }
            Ok(())
        }
        fn literal(&mut self, text: &str, style: &RunStyle) -> Result<()> {
            for (space, token) in split_whitespace_tokens(text) {
                if space {
                    if self.pending.is_none() {
                        self.pending = Some(style.clone());
                    }
                } else {
                    if let Some(p) = self.pending.take()
                        && !self.runs.is_empty()
                    {
                        self.emit(" ", &p)?;
                    }
                    self.emit(token, style)?;
                }
            }
            Ok(())
        }
        fn explicit(&mut self, text: &str, style: &RunStyle) -> Result<()> {
            if let Some(p) = self.pending.take()
                && !self.runs.is_empty()
            {
                self.emit(" ", &p)?;
            }
            self.emit(text, style)
        }
    }
    fn visit(acc: &mut Acc, element: &XmlElement, style: &RunStyle, source: &str, resolver: &Resolver) -> Result<()> {
        let mut cursor = element.start_tag_end;
        for child in &element.children {
            acc.literal(&parse_xml(&format!("<x>{}</x>", &source[cursor..child.start]))?.text, style)?;
            if is(child, TEXT, "span") {
                attrs(child, &[(TEXT, "style-name")])?;
                let resolved = resolver.resolve("text", xml_attribute(child, "style-name", TEXT), &Resolved { run: style.clone(), ..Default::default() })?;
                visit(acc, child, &resolved.run, source, resolver)?;
            } else if is(child, TEXT, "s") {
                attrs(child, &[(TEXT, "c")])?;
                let count = xml_attribute(child, "c", TEXT).unwrap_or("1");
                let n = count.parse::<usize>().ok().filter(|_| count.len() <= 6 && count.bytes().all(|b| b.is_ascii_digit()));
                let Some(n) = n.filter(|n| (1..=100_000).contains(n) && child.children.is_empty() && child.text.is_empty()) else {
                    return Err(fail("Invalid ODT explicit spaces."));
                };
                acc.room(n + usize::from(acc.pending.is_some() && !acc.runs.is_empty()))?;
                acc.explicit(&" ".repeat(n), style)?;
            } else if is(child, TEXT, "tab") || is(child, TEXT, "line-break") {
                attrs(child, &[])?;
                if !child.children.is_empty() || !child.text.is_empty() {
                    return Err(fail("Invalid ODT whitespace element."));
                }
                acc.explicit(if child.local_name == "tab" { "\t" } else { "\n" }, style)?;
            } else {
                return Err(fail(&format!("Unsupported ODT inline {}; original file was not converted.", child.local_name)));
            }
            cursor = child.end;
        }
        if !element.self_closing() {
            acc.literal(&parse_xml(&format!("<x>{}</x>", &source[cursor..element.end_tag_start]))?.text, style)?;
        }
        Ok(())
    }
    let mut acc = Acc { runs: vec![], pending: None, budget };
    visit(&mut acc, node, &base.run, source, resolver)?;
    let runs = if acc.runs.is_empty() { vec![RunInput { text: String::new(), style: base.run.clone() }] } else { acc.runs };
    Ok(ParagraphInput {
        runs,
        alignment: base.paragraph.alignment,
        spacing_before_points: base.paragraph.spacing_before_points,
        spacing_after_points: base.paragraph.spacing_after_points,
        line_spacing_multiple: base.paragraph.line_spacing_multiple,
        ..Default::default()
    })
}

#[derive(Debug)]
pub(crate) struct OdtState {
    original: Vec<u8>,
    entries: Vec<ZipEntry>,
    content: String,
    text_start: usize,
    text_end: usize,
    defaults: Resolved,
    geometry: Option<OdtPageGeometry>,
    styles_source: Option<String>,
    version: Option<String>,
    initial: RichDocument,
}

/// An opened ODT document: the shared projection plus its owned source.
#[derive(Clone, Debug)]
pub struct OdtDocument {
    pub(crate) native: NativeDocument,
    pub(crate) state: Arc<OdtState>,
}

impl std::ops::Deref for OdtDocument {
    type Target = RichDocument;
    fn deref(&self) -> &RichDocument {
        &self.native.doc
    }
}

fn utf8(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| OfficeError::docx("invalid-odt", "ODT part is not valid UTF-8."))
}

fn forbidden_part(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (lower.starts_with("meta-inf/") && lower["meta-inf/".len()..].contains("signatures"))
        || lower.starts_with("basic/")
        || lower.starts_with("scripts/")
        || lower.strip_prefix("object").is_some_and(|rest| {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            let rest = &rest[digits..];
            rest.is_empty() || rest.starts_with('/')
        })
}

fn check_header(original: &[u8]) -> Result<()> {
    let le16 = |at: usize| u16::from_le_bytes([original[at], original[at + 1]]);
    if original.len() < 38
        || u32::from_le_bytes([original[0], original[1], original[2], original[3]]) != 0x0403_4b50
        || le16(8) != 0
        || le16(26) != 8
        || le16(28) != 0
        || &original[30..38] != b"mimetype"
    {
        return Err(fail("ODT requires mimetype as the first, uncompressed ZIP entry without an extra field."));
    }
    Ok(())
}

pub fn open_odt(input: &[u8]) -> Result<OdtDocument> {
    let original = input.to_vec();
    check_header(&original)?;
    let entries = read_zip(&original, DEFAULT_ZIP_LIMITS)?;
    let parts: HashMap<&str, &[u8]> = entries.iter().map(|e| (e.name.as_str(), e.data.as_slice())).collect();
    if parts.get("mimetype").map(|m| utf8(m)).transpose()?.as_deref() != Some(MIME) {
        return Err(fail("This package is not an ODT text document."));
    }
    if entries.iter().any(|e| forbidden_part(&e.name)) {
        return Err(fail("Signed, executable and embedded-object ODT packages are unsupported."));
    }
    let Some(manifest_bytes) = parts.get("META-INF/manifest.xml") else {
        return Err(fail("ODT manifest is missing."));
    };
    let manifest = parse_xml(&utf8(manifest_bytes)?)?;
    if !is(&manifest, MANIFEST, "manifest") {
        return Err(fail("Invalid ODT manifest namespace."));
    }
    attrs(&manifest, &[(MANIFEST, "version")])?;
    if !manifest.text.trim().is_empty() {
        return Err(fail("Invalid ODT manifest content."));
    }
    let mut declarations: HashMap<String, String> = HashMap::new();
    for entry in &manifest.children {
        if !is(entry, MANIFEST, "file-entry") || !entry.children.is_empty() || !entry.text.trim().is_empty() {
            return Err(fail("Encrypted or unsupported ODT manifest entries are unsupported."));
        }
        attrs(entry, &[(MANIFEST, "full-path"), (MANIFEST, "media-type"), (MANIFEST, "version")])?;
        let path = xml_attribute(entry, "full-path", MANIFEST);
        let media = xml_attribute(entry, "media-type", MANIFEST);
        let (Some(path), Some(media)) = (path, media) else {
            return Err(fail("Invalid or duplicate ODT manifest entry."));
        };
        if path.is_empty() || declarations.contains_key(path) || path == "mimetype" || path == "META-INF/manifest.xml" {
            return Err(fail("Invalid or duplicate ODT manifest entry."));
        }
        if path != "/" {
            validate_zip_path(path)?;
            if !parts.contains_key(path) && !path.ends_with('/') {
                return Err(fail("ODT manifest references a missing part."));
            }
        }
        declarations.insert(path.to_string(), media.to_string());
    }
    if declarations.get("/").map(String::as_str) != Some(MIME) || declarations.get("content.xml").map(String::as_str) != Some("text/xml") {
        return Err(fail("ODT manifest media types do not match the text document."));
    }
    for entry in &entries {
        if entry.name != "mimetype" && !entry.name.starts_with("META-INF/") && !entry.name.ends_with('/') && !declarations.contains_key(&entry.name) {
            return Err(fail("ODT package has an undeclared file."));
        }
    }
    let Some(content_bytes) = parts.get("content.xml") else {
        return Err(fail("ODT content is missing."));
    };
    let content = utf8(content_bytes)?;
    let root = parse_xml(&content)?;
    if !is(&root, OFFICE, "document-content") {
        return Err(fail("Invalid ODT content root."));
    }
    version(&root)?;
    attrs(&root, &[(OFFICE, "version")])?;
    for child in &root.children {
        if !["font-face-decls", "automatic-styles", "body"].iter().any(|n| is(child, OFFICE, n)) {
            return Err(fail("Unsupported ODT content structure."));
        }
    }
    only(&root, OFFICE, "font-face-decls", false)?;
    only(&root, OFFICE, "automatic-styles", false)?;
    if root.children.last().map(|c| c.local_name.as_str()) != Some("body") || !root.text.trim().is_empty() {
        return Err(fail("Unsupported ODT content order."));
    }
    let body = only(&root, OFFICE, "body", true)?.expect("body");
    attrs(body, &[])?;
    if body.children.len() != 1 || !body.text.trim().is_empty() {
        return Err(fail("Unsupported ODT document body."));
    }
    let text = only(body, OFFICE, "text", true)?.expect("text");
    attrs(text, &[])?;
    if !text.text.trim().is_empty() {
        return Err(fail("ODT body text must be inside paragraphs."));
    }
    let mut styles_source: Option<String> = None;
    let styles_root = match parts.get("styles.xml") {
        Some(bytes) => {
            if declarations.get("styles.xml").map(String::as_str) != Some("text/xml") {
                return Err(fail("Invalid ODT styles media type."));
            }
            let source = utf8(bytes)?;
            let styles = parse_xml(&source)?;
            if !is(&styles, OFFICE, "document-styles") {
                return Err(fail("Invalid ODT styles root."));
            }
            version(&styles)?;
            attrs(&styles, &[(OFFICE, "version")])?;
            if !styles.text.trim().is_empty() {
                return Err(fail("Invalid ODT styles document content."));
            }
            for name in ["font-face-decls", "styles", "automatic-styles", "master-styles"] {
                only(&styles, OFFICE, name, false)?;
            }
            for child in &styles.children {
                if !["font-face-decls", "styles", "automatic-styles", "master-styles"].iter().any(|n| is(child, OFFICE, n)) {
                    return Err(fail("Unsupported ODT page, master or style structure."));
                }
            }
            styles_source = Some(source);
            Some(styles)
        }
        None => None,
    };
    let mut roots: Vec<&XmlElement> = Vec::new();
    if let Some(s) = &styles_root {
        roots.push(s);
    }
    roots.push(&root);
    let geometry = read_odt_page_geometry(&roots)?;
    let resolver = Resolver::new(&roots)?;
    let mut budget = Budget { characters: 0 };
    if text.children.len() > 10000 {
        return Err(fail("ODT paragraph count exceeds the supported limit."));
    }
    let mut paragraphs = Vec::with_capacity(text.children.len());
    for (index, node) in text.children.iter().enumerate() {
        if index > 0 {
            budget.characters += 1;
        }
        if !is(node, TEXT, "p") {
            return Err(fail(&format!("Unsupported ODT block {}; original file was not converted.", node.local_name)));
        }
        paragraphs.push(read_paragraph(node, &content, &resolver, &mut budget)?);
    }
    if paragraphs.is_empty() {
        paragraphs.push(ParagraphInput { runs: vec![RunInput::default()], ..Default::default() });
    }
    let native = create_rich_snapshot(
        Format::Odt,
        &paragraphs,
        SnapshotOptions {
            page_layout: geometry.as_ref().map(|g| g.layout),
            diagnostics: vec![Diagnostic::info(
                "odt-bounded-rich-text",
                "ODT rich text supports paragraphs, fonts, colors, basic emphasis, spacing and a single static page layout. Complex layouts and interactive content are not converted.",
            )],
            ..Default::default()
        },
    )?;
    let paragraph_defaults = resolver.resolve("paragraph", None, &Resolved::default())?;
    let defaults = resolver.resolve("text", None, &paragraph_defaults)?;
    let state = OdtState {
        original,
        entries: entries.clone(),
        text_start: text.start,
        text_end: text.end,
        defaults,
        geometry,
        styles_source,
        version: xml_attribute(&root, "version", OFFICE).map(str::to_string),
        initial: native.doc.clone(),
        content,
    };
    Ok(OdtDocument { native, state: Arc::new(state) })
}

/// Opens an ODT for editing when it fits the bounded codec, and otherwise
/// read-only for display. Only "unsupported-odt" refusals fall back: malformed
/// XML, ZIP damage, encryption, signatures, macros and objects still refuse.
pub fn open_odt_for_display(input: &[u8]) -> Result<OdtDocument> {
    match open_odt(input) {
        Ok(d) => Ok(d),
        Err(e) if e.code == "unsupported-odt" => open_odt_read_only(input, &e.message),
        Err(e) => Err(e),
    }
}

/// A read-only snapshot owned like an editable one, so export returns the original bytes.
pub fn open_odt_read_only(input: &[u8], reason: &str) -> Result<OdtDocument> {
    let original = input.to_vec();
    check_header(&original)?;
    let entries = read_zip(&original, DEFAULT_ZIP_LIMITS)?;
    let parts: HashMap<&str, &[u8]> = entries.iter().map(|e| (e.name.as_str(), e.data.as_slice())).collect();
    if parts.get("mimetype").map(|m| utf8(m)).transpose()?.as_deref() != Some(MIME) {
        return Err(fail("This package is not an ODT text document."));
    }
    if entries.iter().any(|e| forbidden_part(&e.name)) {
        return Err(fail("Signed, executable and embedded-object ODT packages are unsupported."));
    }
    let Some(manifest_bytes) = parts.get("META-INF/manifest.xml") else {
        return Err(fail("ODT manifest is missing."));
    };
    let manifest = parse_xml(&utf8(manifest_bytes)?)?;
    if !is(&manifest, MANIFEST, "manifest") {
        return Err(fail("Invalid ODT manifest namespace."));
    }
    if xml_descendants(&manifest).iter().any(|n| n.namespace == MANIFEST && (n.local_name == "encryption-data" || n.local_name == "encrypted-key")) {
        return Err(fail("Encrypted ODT packages are unsupported."));
    }
    let media = |path: &str| -> Vec<Option<&str>> {
        manifest
            .children
            .iter()
            .filter(|n| is(n, MANIFEST, "file-entry") && xml_attribute(n, "full-path", MANIFEST) == Some(path))
            .map(|n| xml_attribute(n, "media-type", MANIFEST))
            .collect()
    };
    if media("/") != vec![Some(MIME)] || media("content.xml") != vec![Some("text/xml")] {
        return Err(fail("ODT manifest media types do not match the text document."));
    }
    let Some(content_bytes) = parts.get("content.xml") else {
        return Err(fail("ODT content is missing."));
    };
    let content = utf8(content_bytes)?;
    let root = parse_xml(&content)?;
    if !is(&root, OFFICE, "document-content") {
        return Err(fail("Invalid ODT content root."));
    }
    let bodies: Vec<&XmlElement> = root.children.iter().filter(|n| is(n, OFFICE, "body")).collect();
    let texts: Vec<&XmlElement> = if bodies.len() == 1 { bodies[0].children.iter().filter(|n| is(n, OFFICE, "text")).collect() } else { vec![] };
    if texts.len() != 1 {
        return Err(fail("ODT requires exactly one office:text body."));
    }
    let text = texts[0];
    let mut styles_source = None;
    let styles_root = match parts.get("styles.xml") {
        Some(bytes) => {
            let source = utf8(bytes)?;
            let styles = parse_xml(&source)?;
            if is(&styles, OFFICE, "document-styles") {
                styles_source = Some(source);
                Some(styles)
            } else {
                None
            }
        }
        None => None,
    };
    let mut roots: Vec<&XmlElement> = Vec::new();
    if let Some(s) = &styles_root {
        roots.push(s);
    }
    roots.push(&root);
    let geometry = read_odt_page_geometry(&roots).ok().flatten();
    let body = read_odt_display_body(&content, text, &roots)?;
    let mut diagnostics = vec![Diagnostic::warning(
        "odt-read-only",
        format!("This OpenDocument file opens read-only because Markie can't edit all of its features yet. Exporting keeps the original file unchanged. Detail: {reason}"),
    )];
    if body.omitted {
        diagnostics.push(Diagnostic::info(
            "odt-omitted",
            "Pictures, comments, notes, hidden text and other content Markie can't show are left out of this view.",
        ));
    }
    let native = create_rich_snapshot(
        Format::Odt,
        &body.paragraphs,
        SnapshotOptions { page_layout: geometry.as_ref().map(|g| g.layout), diagnostics, can_edit: Some(false), blocks: body.blocks, ..Default::default() },
    )?;
    let state = OdtState {
        original,
        entries: entries.clone(),
        text_start: text.start,
        text_end: text.end,
        defaults: Resolved::default(),
        geometry,
        styles_source,
        version: xml_attribute(&root, "version", OFFICE).map(str::to_string),
        initial: native.doc.clone(),
        content,
    };
    Ok(OdtDocument { native, state: Arc::new(state) })
}

/// Ownership, not structural equality, authorizes replacing a session snapshot.
pub fn is_same_odt_source(first: &OdtDocument, second: &OdtDocument) -> bool {
    Arc::ptr_eq(&first.state, &second.state)
}

/// Clearing direct formatting exposes the retained ODF defaults immediately.
fn resolve_defaults(document: &NativeDocument, state: &OdtState) -> Result<NativeDocument> {
    rebase_simple_rich_defaults(document, &state.defaults.run, &state.defaults.paragraph)
}

pub fn apply_odt_operations(document: &OdtDocument, operations: &[Operation]) -> Result<OdtDocument> {
    let state = &document.state;
    for operation in operations {
        match operation {
            Operation::InsertParagraph { text, .. } | Operation::ReplaceParagraph { text, .. } if text.contains('\r') => {
                return Err(fail("ODT uses line-feed characters for line breaks; literal carriage returns are unsupported."));
            }
            Operation::FormatRun { style, .. } | Operation::FormatRange { style, .. } => {
                if style.color.as_ref().is_some_and(|c| c.as_deref() == Some("auto")) {
                    return Err(fail("Automatic system text color is not supported by this ODT subset; choose a color or clear direct formatting."));
                }
                if let Some(Some(u)) = &style.underline
                    && u != "none"
                    && u != "single"
                {
                    return Err(fail("This ODT subset supports single underline only."));
                }
                if let Some(Some(f)) = &style.font_family
                    && f.contains(',')
                {
                    return Err(fail("This ODT subset requires one font family."));
                }
            }
            _ => {}
        }
    }
    let edited = apply_simple_rich_operations(&document.native, operations)?;
    let next = if edited == document.native || operations.iter().all(|op| matches!(op, Operation::SetPageLayout { .. })) {
        edited
    } else {
        resolve_defaults(&edited, state)?
    };
    Ok(OdtDocument { native: next, state: state.clone() })
}

pub fn replace_odt_text(document: &OdtDocument, edits: &[TextEdit]) -> Result<OdtDocument> {
    let state = &document.state;
    if edits.iter().any(|e| e.text.contains('\r')) {
        return Err(fail("ODT uses line-feed characters for line breaks; literal carriage returns are unsupported."));
    }
    let edited = replace_simple_rich_text(&document.native, edits)?;
    let next = if edited == document.native { edited } else { resolve_defaults(&edited, state)? };
    Ok(OdtDocument { native: next, state: state.clone() })
}

fn serialize_text(text: &str) -> Result<String> {
    let mut pieces = String::new();
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            ' ' => {
                let mut count = 1;
                while chars.peek().is_some_and(|(_, c)| *c == ' ') {
                    chars.next();
                    count += 1;
                }
                // Each count is bounded to the reader's preallocation limit.
                let mut remaining = count;
                while remaining > 0 {
                    let n = remaining.min(100_000);
                    pieces.push_str(&if n == 1 { "<text:s/>".to_string() } else { format!("<text:s text:c=\"{n}\"/>") });
                    remaining -= n;
                }
            }
            '\t' => pieces.push_str("<text:tab/>"),
            '\n' => pieces.push_str("<text:line-break/>"),
            '\r' => pieces.push_str("&#13;"),
            _ => {
                let mut end = i + c.len_utf8();
                while let Some((j, d)) = chars.peek().copied() {
                    if matches!(d, ' ' | '\t' | '\n' | '\r') {
                        break;
                    }
                    chars.next();
                    end = j + d.len_utf8();
                }
                pieces.push_str(&escape_xml_text(&text[i..end])?);
            }
        }
    }
    Ok(pieces)
}

fn namespaces() -> String {
    format!("xmlns:office=\"{OFFICE}\" xmlns:text=\"{TEXT}\" xmlns:style=\"{STYLE}\" xmlns:fo=\"{FO}\"")
}

fn edited_odt_content(document: &RichDocument, state: &OdtState) -> Result<String> {
    let ns = namespaces();
    // Generated names avoid every original style name, including unused styles.
    let mut prefix = String::from("Markie");
    while state.content.contains(&prefix) || state.styles_source.as_deref().is_some_and(|s| s.contains(&prefix)) {
        prefix.push('_');
    }
    let mut styles = String::new();
    let mut paragraphs = String::new();
    for (i, p) in document.paragraphs.iter().enumerate() {
        let name = format!("{prefix}P{i}");
        let alignment = p.alignment.as_deref().map(|a| if a == "both" { "justify" } else { a });
        let mut props: Vec<String> = Vec::new();
        if let Some(a) = alignment.filter(|a| !a.is_empty()) {
            props.push(format!("fo:text-align=\"{}\"", escape_xml_text(a)?));
        }
        if let Some(v) = p.spacing_before_points {
            props.push(format!("fo:margin-top=\"{}pt\"", js_number(v)));
        }
        if let Some(v) = p.spacing_after_points {
            props.push(format!("fo:margin-bottom=\"{}pt\"", js_number(v)));
        }
        if let Some(v) = p.line_spacing_multiple {
            props.push(format!("fo:line-height=\"{}%\"", js_number(v * 100.0)));
        }
        styles.push_str(&format!(
            "<style:style {ns} style:name=\"{name}\" style:family=\"paragraph\"><style:paragraph-properties {}/></style:style>",
            props.join(" ")
        ));
        let mut runs = String::new();
        for (j, r) in p.runs.iter().enumerate() {
            let run_name = format!("{prefix}T{i}_{j}");
            let s = &r.style;
            let mut properties = vec![
                format!("fo:font-weight=\"{}\"", if s.bold == Some(true) { "bold" } else { "normal" }),
                format!("fo:font-style=\"{}\"", if s.italic == Some(true) { "italic" } else { "normal" }),
                format!("style:text-underline-style=\"{}\"", if s.underline.as_deref().is_some_and(|u| !u.is_empty() && u != "none") { "solid" } else { "none" }),
            ];
            if let Some(f) = s.font_family.as_deref().filter(|f| !f.is_empty()) {
                properties.push(format!("fo:font-family=\"{}\"", escape_xml_text(f)?.replace('"', "&quot;")));
            }
            if let Some(size) = s.font_size_points {
                properties.push(format!("fo:font-size=\"{}pt\"", js_number(size)));
            }
            if let Some(c) = s.color.as_deref().filter(|c| !c.is_empty()) {
                properties.push(format!("fo:color=\"#{c}\""));
            }
            styles.push_str(&format!(
                "<style:style {ns} style:name=\"{run_name}\" style:family=\"text\"><style:text-properties {}/></style:style>",
                properties.join(" ")
            ));
            runs.push_str(&format!("<text:span text:style-name=\"{run_name}\">{}</text:span>", serialize_text(&r.text)?));
        }
        paragraphs.push_str(&format!("<text:p text:style-name=\"{name}\">{runs}</text:p>"));
    }
    let text = format!("<office:text {ns}>{paragraphs}</office:text>");
    let mut content = format!("{}{text}{}", &state.content[..state.text_start], &state.content[state.text_end..]);
    let root = parse_xml(&content)?;
    match only(&root, OFFICE, "automatic-styles", false)? {
        Some(automatic) => {
            let existing = if automatic.self_closing() { "" } else { &content[automatic.start_tag_end..automatic.end_tag_start] };
            let opening = &content[automatic.start..automatic.start_tag_end];
            let opening = opening.strip_suffix("/>").map_or(opening.to_string(), |o| format!("{o}>"));
            let replacement = format!("{opening}{existing}{styles}</{}>", automatic.name);
            content = format!("{}{replacement}{}", &content[..automatic.start], &content[automatic.end..]);
        }
        None => {
            let body = only(&root, OFFICE, "body", true)?.expect("body");
            content = format!("{}<office:automatic-styles {ns}>{styles}</office:automatic-styles>{}", &content[..body.start], &content[body.start..]);
        }
    }
    Ok(content)
}

/// Untouched (or reverted) documents return their original bytes.
pub fn export_odt(document: &OdtDocument) -> Result<Vec<u8>> {
    let state = &document.state;
    if !document.modified {
        return Ok(state.original.clone());
    }
    let ns = namespaces();
    let body_changed = document.paragraphs != state.initial.paragraphs;
    let layout_changed = document.page_layout != state.initial.page_layout;
    if !body_changed && !layout_changed {
        return Ok(state.original.clone());
    }
    let content = if body_changed { edited_odt_content(document, state)? } else { state.content.clone() };
    let mut entries: Vec<ZipEntry> =
        state.entries.iter().map(|e| if e.name == "content.xml" { ZipEntry::new(e.name.clone(), content.clone().into_bytes()) } else { e.clone() }).collect();
    if layout_changed {
        let mut styles = state.styles_source.clone().unwrap_or_else(|| {
            format!("<office:document-styles {ns} office:version=\"{}\"/>", state.version.as_deref().unwrap_or(""))
        });
        if let Some(geometry) = &state.geometry {
            styles = format!("{}{}{}", &styles[..geometry.properties_start], odt_page_properties(&document.page_layout), &styles[geometry.properties_end..]);
        } else {
            let mut name = String::from("MarkiePage");
            while styles.contains(&name) || state.content.contains(&name) {
                name.push('_');
            }
            let (automatic_markup, master_markup) = odt_page_styles(&document.page_layout, &name);
            let root = parse_xml(&styles)?;
            let automatic = only(&root, OFFICE, "automatic-styles", false)?;
            let masters = only(&root, OFFICE, "master-styles", false)?;
            if automatic.is_none() && masters.is_none() {
                styles = append_odt_xml(&styles, &root, &format!("<office:automatic-styles {ns}>{automatic_markup}</office:automatic-styles>{master_markup}"));
            } else {
                match masters {
                    None => styles = append_odt_xml(&styles, &root, &master_markup),
                    Some(m) => {
                        let generated = parse_xml(&master_markup)?;
                        let inner: String = generated.children.iter().map(|n| n.raw(&master_markup)).collect();
                        styles = append_odt_xml(&styles, m, &inner);
                    }
                }
                // Reparse after insertion: the root or container may have been self-closing.
                let updated = parse_xml(&styles)?;
                match only(&updated, OFFICE, "automatic-styles", false)? {
                    Some(a) => styles = append_odt_xml(&styles, a, &automatic_markup),
                    None => {
                        let master = only(&updated, OFFICE, "master-styles", true)?.expect("master");
                        styles = format!(
                            "{}<office:automatic-styles {ns}>{automatic_markup}</office:automatic-styles>{}",
                            &styles[..master.start],
                            &styles[master.start..]
                        );
                    }
                }
            }
        }
        if state.styles_source.is_some() {
            for e in entries.iter_mut() {
                if e.name == "styles.xml" {
                    e.data = styles.clone().into_bytes();
                }
            }
        } else {
            entries.push(ZipEntry::new("styles.xml", styles.into_bytes()));
            for e in entries.iter_mut() {
                if e.name == "META-INF/manifest.xml" {
                    let source = utf8(&e.data)?;
                    let root = parse_xml(&source)?;
                    e.data = append_odt_xml(
                        &source,
                        &root,
                        &format!("<manifest:file-entry xmlns:manifest=\"{MANIFEST}\" manifest:full-path=\"styles.xml\" manifest:media-type=\"text/xml\"/>"),
                    )
                    .into_bytes();
                }
            }
        }
    }
    let mut ordered: Vec<ZipEntry> = entries.iter().filter(|e| e.name == "mimetype").cloned().collect();
    ordered.extend(entries.into_iter().filter(|e| e.name != "mimetype"));
    let output = write_zip(&ordered, DEFAULT_ZIP_LIMITS)?;
    // Never hand an unreopenable or text-lossy edited candidate to persistence.
    let verification = open_odt(&output)?;
    if verification.text != document.text {
        return Err(fail("Edited ODT failed same-format text verification; the source was not overwritten."));
    }
    let (a, b) = (verification.page_layout, document.page_layout);
    let close = |x: f64, y: f64| (x - y).abs() <= 0.000001;
    if !(close(a.width_points, b.width_points)
        && close(a.height_points, b.height_points)
        && a.orientation == b.orientation
        && close(a.margin_top_points, b.margin_top_points)
        && close(a.margin_right_points, b.margin_right_points)
        && close(a.margin_bottom_points, b.margin_bottom_points)
        && close(a.margin_left_points, b.margin_left_points))
    {
        return Err(fail("Edited ODT failed same-format page-layout verification; the source was not overwritten."));
    }
    Ok(output)
}

pub fn create_odt(text: &str) -> Result<OdtDocument> {
    if text.contains('\r') {
        return Err(fail("ODT uses line-feed characters for line breaks; literal carriage returns are unsupported."));
    }
    let ns = namespaces();
    let mut body = String::new();
    for p in text.split('\n') {
        body.push_str(&format!("<text:p>{}</text:p>", serialize_text(p)?));
    }
    let content = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><office:document-content {ns} office:version=\"1.3\"><office:body><office:text>{body}</office:text></office:body></office:document-content>");
    let (automatic, master) = odt_page_styles(&DEFAULT_PAGE_LAYOUT, "MarkiePage");
    let styles = format!("<office:document-styles {ns} office:version=\"1.3\"><office:automatic-styles>{automatic}</office:automatic-styles>{master}</office:document-styles>");
    let manifest = format!("<manifest:manifest xmlns:manifest=\"{MANIFEST}\" manifest:version=\"1.3\"><manifest:file-entry manifest:full-path=\"/\" manifest:media-type=\"{MIME}\"/><manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/><manifest:file-entry manifest:full-path=\"styles.xml\" manifest:media-type=\"text/xml\"/></manifest:manifest>");
    open_odt(&write_zip(
        &[
            ZipEntry::new("mimetype", MIME),
            ZipEntry::new("content.xml", content),
            ZipEntry::new("styles.xml", styles),
            ZipEntry::new("META-INF/manifest.xml", manifest),
        ],
        DEFAULT_ZIP_LIMITS,
    )?)
}
