//! Original editing of ECMA-376 WordprocessingML direct properties, paragraphs,
//! sections and rectangular tables. Ported from `docx-edit.ts`, `docx-encoding.ts`,
//! `docx-derived.ts` and `docx-fields.ts`. Values use points at this boundary and
//! twips (1/20 pt) or 240ths of a line in the package vocabulary.

use super::State;
use crate::error::{OfficeError, Result};
use crate::model::*;
use crate::xml::{XmlElement, escape_xml_text, parse_xml, xml_attribute, xml_attribute_text, xml_descendants};
use std::collections::{BTreeMap, HashSet};

pub(crate) const WORD_NAMESPACES: [&str; 2] = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];

/// ECMA-376 Part 1 sequence orders (CT_RPr 17.3.2.28, CT_PPr 17.3.1.26, CT_SectPr 17.6.17).
const R_ORDER: &[&str] = &[
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof",
    "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
    "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath", "rPrChange",
];
pub(crate) const P_ORDER: &[&str] = &[
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs",
    "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
    "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment",
    "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange",
];
const SECTION_ORDER: &[&str] = &[
    "headerReference", "footerReference", "footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc", "pgBorders", "lnNumType", "pgNumType",
    "cols", "formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings", "sectPrChange",
];

pub(crate) fn invalid(code: &str, message: &str) -> OfficeError {
    OfficeError::docx(code, message)
}

pub(crate) fn is_word(node: &XmlElement, name: &str) -> bool {
    WORD_NAMESPACES.contains(&node.namespace.as_str()) && (name.is_empty() || node.local_name == name)
}
pub(crate) fn any_word(node: &XmlElement) -> bool {
    is_word(node, "")
}
pub(crate) fn word_child<'a>(node: Option<&'a XmlElement>, name: &str) -> Option<&'a XmlElement> {
    node?.children.iter().find(|c| is_word(c, name))
}
pub(crate) fn own<'a>(node: Option<&'a XmlElement>, name: &str) -> Option<&'a str> {
    let n = node?;
    xml_attribute(n, name, &n.namespace)
}
pub(crate) fn val(node: Option<&XmlElement>) -> Option<&str> {
    own(node, "val")
}
pub(crate) fn ws_only(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
}
pub(crate) fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

// ---- XML part encodings (W3C XML 1.0 section 4.3.3 and Appendix F) ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum XmlEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

pub fn decode_docx_xml(bytes: &[u8]) -> Result<(String, XmlEncoding)> {
    let encoding = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        XmlEncoding::Utf8Bom
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        XmlEncoding::Utf16Le
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        XmlEncoding::Utf16Be
    } else {
        XmlEncoding::Utf8
    };
    let bad = || invalid("unsupported-encoding", "XML part is not valid UTF-8 or byte-order-marked UTF-16.");
    let text = match encoding {
        XmlEncoding::Utf8 => std::str::from_utf8(bytes).map_err(|_| bad())?.to_string(),
        XmlEncoding::Utf8Bom => std::str::from_utf8(&bytes[3..]).map_err(|_| bad())?.to_string(),
        XmlEncoding::Utf16Le | XmlEncoding::Utf16Be => {
            if bytes.len() % 2 != 0 {
                return Err(bad());
            }
            let little = encoding == XmlEncoding::Utf16Le;
            let units: Vec<u16> =
                bytes[2..].chunks(2).map(|c| if little { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
            String::from_utf16(&units).map_err(|_| bad())?
        }
    };
    // The declaration, when present, must agree with the bytes.
    if let Some(declared) = declared_encoding(&text) {
        let sixteen = matches!(encoding, XmlEncoding::Utf16Le | XmlEncoding::Utf16Be);
        let own_name = match encoding {
            XmlEncoding::Utf16Le => "utf-16le",
            XmlEncoding::Utf16Be => "utf-16be",
            _ => "utf-8",
        };
        let ok = if sixteen { declared == "utf-16" || declared == own_name } else { declared == "utf-8" };
        if !ok {
            return Err(invalid("unsupported-encoding", "XML encoding declaration does not match the part bytes."));
        }
    }
    Ok((text, encoding))
}

/// `/^<\?xml[^>]*?\sencoding[\x20\t\r\n]*=[\x20\t\r\n]*(["'])([^"']*)\1/`, lowercased.
fn declared_encoding(text: &str) -> Option<String> {
    let head = text.strip_prefix("<?xml")?;
    let end = head.find('>').unwrap_or(head.len());
    let head = &head[..end];
    let b = head.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_whitespace() && head[i + 1..].starts_with("encoding") {
            let mut j = i + 1 + "encoding".len();
            while j < b.len() && matches!(b[j], b' ' | b'\t' | b'\r' | b'\n') {
                j += 1;
            }
            if b.get(j) == Some(&b'=') {
                j += 1;
                while j < b.len() && matches!(b[j], b' ' | b'\t' | b'\r' | b'\n') {
                    j += 1;
                }
                if let Some(&q) = b.get(j).filter(|q| **q == b'"' || **q == b'\'') {
                    let rest = &head[j + 1..];
                    let close = rest.find(['"', '\''])?;
                    if rest.as_bytes()[close] == q {
                        return Some(rest[..close].to_lowercase());
                    }
                    return None;
                }
            }
        }
        i += 1;
    }
    None
}

pub fn encode_docx_xml(text: &str, encoding: XmlEncoding) -> Vec<u8> {
    match encoding {
        XmlEncoding::Utf8 => text.as_bytes().to_vec(),
        XmlEncoding::Utf8Bom => [&[0xefu8, 0xbb, 0xbf][..], text.as_bytes()].concat(),
        XmlEncoding::Utf16Le | XmlEncoding::Utf16Be => {
            let little = encoding == XmlEncoding::Utf16Le;
            let mut out = Vec::with_capacity(text.len() * 2 + 2);
            out.extend(if little { 0xfeffu16.to_le_bytes() } else { 0xfeffu16.to_be_bytes() });
            for unit in text.encode_utf16() {
                out.extend(if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            out
        }
    }
}

// ---- identities and source patches ----

#[derive(Clone, Debug)]
pub(crate) struct Patch {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub preserve_identity: bool,
}

impl Patch {
    pub fn new(start: usize, end: usize, text: impl Into<String>) -> Self {
        Self { start, end, text: text.into(), preserve_identity: false }
    }
    pub fn keep(start: usize, end: usize, text: impl Into<String>) -> Self {
        Self { start, end, text: text.into(), preserve_identity: true }
    }
}

pub(crate) fn index_docx_identities(state: &mut State) -> Result<()> {
    let root = parse_xml(&state.source)?;
    let (mut paragraph_index, mut table_index) = (0usize, 0usize);
    for node in xml_descendants(&root) {
        if is_word(node, "p") {
            if !state.identities.contains_key(&node.start) {
                let id = if state.next_id == 0 { format!("p{paragraph_index}") } else { state.fresh("p~") };
                state.identities.insert(node.start, id);
            }
            let paragraph_id = state.identities[&node.start].clone();
            for (run_index, run) in node.children.iter().filter(|n| is_word(n, "r")).enumerate() {
                if !state.identities.contains_key(&run.start) {
                    let id = if state.next_id == 0 { format!("{paragraph_id}:r{run_index}") } else { state.fresh("r~") };
                    state.identities.insert(run.start, id);
                }
            }
            paragraph_index += 1;
        } else if is_word(node, "tbl") {
            if !state.identities.contains_key(&node.start) {
                let id = if state.next_id == 0 { format!("table{table_index}") } else { state.fresh("table~") };
                state.identities.insert(node.start, id);
            }
            table_index += 1;
        }
    }
    if state.next_id == 0 {
        state.next_id = 1;
    }
    Ok(())
}

/// Visible text of a run or inline container as the snapshot exposes it: text,
/// tabs and line/column breaks count; page breaks, field codes and properties do not.
pub(crate) fn docx_inline_text(node: &XmlElement, original: bool) -> String {
    let mut out = String::new();
    inline_text_into(node, original, &mut out);
    out
}
fn inline_text_into(node: &XmlElement, original: bool, out: &mut String) {
    if !any_word(node) {
        return;
    }
    match node.local_name.as_str() {
        "t" => out.push_str(&node.text),
        "delText" => {
            if original {
                out.push_str(&node.text);
            }
        }
        "tab" => out.push('\t'),
        "br" => {
            if xml_attribute(node, "type", &node.namespace) != Some("page") {
                out.push('\n');
            }
        }
        "cr" => out.push('\n'),
        "pPr" | "rPr" | "instrText" => {}
        _ => {
            for child in &node.children {
                inline_text_into(child, original, out);
            }
        }
    }
}

pub(crate) fn patch_docx_source(state: &State, patches: Vec<Patch>) -> Result<State> {
    let mut sorted = patches;
    sorted.sort_by_key(|p| p.start);
    for (i, p) in sorted.iter().enumerate() {
        if p.end < p.start || p.end > state.source.len() || (i > 0 && p.start < sorted[i - 1].end) {
            return Err(invalid("invalid-edit", "Overlapping source edits."));
        }
    }
    let mut identities = BTreeMap::new();
    for (offset, id) in &state.identities {
        let mut displacement: isize = 0;
        let mut deleted = false;
        for patch in &sorted {
            if *offset >= patch.end {
                displacement += patch.text.len() as isize - (patch.end - patch.start) as isize;
            } else if *offset >= patch.start {
                if !(*offset == patch.start && patch.preserve_identity) {
                    deleted = true;
                }
                break;
            }
        }
        if !deleted {
            identities.insert((*offset as isize + displacement) as usize, id.clone());
        }
    }
    let mut source = String::with_capacity(state.source.len());
    let mut cursor = 0;
    for patch in &sorted {
        source.push_str(&state.source[cursor..patch.start]);
        source.push_str(&patch.text);
        cursor = patch.end;
    }
    source.push_str(&state.source[cursor..]);
    let mut next = state.clone();
    next.source = source;
    next.identities = identities;
    index_docx_identities(&mut next)?;
    Ok(next)
}

pub(crate) fn find_node<'a>(state: &State, root: &'a XmlElement, id: &str, kind: &str) -> Result<&'a XmlElement> {
    xml_descendants(root)
        .into_iter()
        .find(|n| is_word(n, kind) && state.identities.get(&n.start).is_some_and(|x| x == id))
        .ok_or_else(|| invalid("invalid-edit", &format!("Unknown {kind} identity.")))
}

pub(crate) fn raw<'a>(state: &'a State, node: &XmlElement) -> &'a str {
    &state.source[node.start..node.end]
}

/// `<w:name xmlns:w="ns" w:k="v".../>` or with content.
pub(crate) fn element(namespace: &str, name: &str, attrs: &[(&str, String)], content: Option<&str>) -> Result<String> {
    let mut properties = String::new();
    for (k, v) in attrs {
        properties.push_str(&format!(" w:{k}=\"{}\"", xml_attribute_text(v)?));
    }
    Ok(match content {
        None => format!("<w:{name} xmlns:w=\"{namespace}\"{properties}/>"),
        Some(c) => format!("<w:{name} xmlns:w=\"{namespace}\"{properties}>{c}</w:{name}>"),
    })
}

/// Opening tag with any self-closing slash removed, plus content and close.
pub(crate) fn wrap(source: &str, node: &XmlElement, content: &str) -> String {
    format!("{}{content}</{}>", open_tag(source, node), node.name)
}
pub(crate) fn open_tag(source: &str, node: &XmlElement) -> String {
    let opening = &source[node.start..node.start_tag_end];
    match opening.strip_suffix("/>") {
        Some(o) => format!("{o}>"),
        None => opening.to_string(),
    }
}

/// Rebuilds a property container from its own raw children: changed Word
/// properties replace in place, removed ones drop, new ones go before the
/// first schema-later sibling. Unmodeled children keep their order verbatim.
fn ordered_properties(state: &State, current: Option<&XmlElement>, changes: &[(&str, Option<String>)], order: &[&str]) -> String {
    struct Item {
        key: Option<String>,
        xml: String,
        rank: isize,
    }
    let rank = |k: &str| order.iter().position(|o| *o == k).map_or(-1, |p| p as isize);
    let mut items: Vec<Item> = current
        .map(|c| {
            c.children
                .iter()
                .map(|n| Item {
                    key: any_word(n).then(|| n.local_name.clone()),
                    xml: raw(state, n).to_string(),
                    rank: if any_word(n) { rank(&n.local_name) } else { -1 },
                })
                .collect()
        })
        .unwrap_or_default();
    for (key, xml) in changes {
        if let Some(index) = items.iter().position(|i| i.key.as_deref() == Some(*key)) {
            match xml {
                None => {
                    items.remove(index);
                }
                Some(x) => items[index].xml = x.clone(),
            }
            continue;
        }
        let Some(xml) = xml else { continue };
        let r = rank(key);
        let at = match items.iter().position(|i| i.rank > r) {
            Some(at) => at,
            None => items.iter().rposition(|i| i.rank >= 0).map_or(0, |last| last + 1),
        };
        items.insert(at, Item { key: Some(key.to_string()), xml: xml.clone(), rank: r });
    }
    items.into_iter().map(|i| i.xml).collect()
}

pub(crate) fn property_patch(state: &State, parent: &XmlElement, kind: &str, changes: &[(&str, Option<String>)], order: &[&str]) -> Result<Patch> {
    let current = word_child(Some(parent), kind);
    let content = ordered_properties(state, current, changes, order);
    if let Some(c) = current {
        return Ok(Patch::new(c.start, c.end, if content.is_empty() { String::new() } else { wrap(&state.source, c, &content) }));
    }
    let created = if content.is_empty() { String::new() } else { element(&parent.namespace, kind, &[], Some(&content))? };
    if parent.self_closing() {
        return Ok(Patch::keep(parent.start, parent.end, wrap(&state.source, parent, &created)));
    }
    Ok(Patch::new(parent.start_tag_end, parent.start_tag_end, created))
}

fn number(value: f64, min: f64, max: f64, field: &str) -> Result<f64> {
    if !value.is_finite() || value < min || value > max {
        return Err(invalid("invalid-format", &format!("{field} must be a number from {} to {}.", js_number(min), js_number(max))));
    }
    Ok(value)
}

fn xml_string(value: &str, field: &str, max: usize) -> Result<String> {
    if value.chars().map(char::len_utf16).sum::<usize>() > max {
        return Err(invalid("invalid-format", &format!("{field} is not a supported string.")));
    }
    escape_xml_text(value)?;
    Ok(value.to_string())
}

pub(crate) const UNDERLINES: &[&str] = &["none", "single", "double", "dotted", "dash", "wave"];

fn format_run(state: &State, run: &XmlElement, style: &RunFormat) -> Result<Patch> {
    let ns = &run.namespace;
    let mut changes: Vec<(&str, Option<String>)> = Vec::new();
    for (value, name) in [(style.bold, "b"), (style.italic, "i")] {
        if let Some(v) = value {
            changes.push((name, v.map(|on| element(ns, name, &[("val", if on { "1" } else { "0" }.into())], None)).transpose()?));
        }
    }
    if let Some(u) = &style.underline {
        if let Some(v) = u
            && !UNDERLINES.contains(&v.as_str())
        {
            return Err(invalid("invalid-format", "Unsupported underline style."));
        }
        changes.push(("u", u.as_ref().map(|v| element(ns, "u", &[("val", v.clone())], None)).transpose()?));
    }
    if let Some(c) = &style.color {
        if let Some(v) = c
            && !(v.eq_ignore_ascii_case("auto") && v.len() == 4 || (v.len() == 6 && v.bytes().all(|b| b.is_ascii_hexdigit())))
        {
            return Err(invalid("invalid-format", "Color must be six hexadecimal digits or auto."));
        }
        changes.push(("color", c.as_ref().map(|v| element(ns, "color", &[("val", v.clone())], None)).transpose()?));
    }
    if let Some(size) = style.font_size_points {
        if let Some(s) = size
            && (number(s, 1.0, 400.0, "Font size")? * 2.0).fract() != 0.0
        {
            return Err(invalid("invalid-format", "Font size must use half-point steps."));
        }
        changes.push(("sz", size.map(|s| element(ns, "sz", &[("val", js_number(s * 2.0))], None)).transpose()?));
    }
    if let Some(font) = &style.font_family {
        if let Some(f) = font
            && (xml_string(f, "Font family", 100)?.trim().is_empty() || f.contains(['\r', '\n', '\t']))
        {
            return Err(invalid("invalid-format", "Unsupported font family."));
        }
        // Specify all four script families; theme attributes would otherwise win.
        changes.push((
            "rFonts",
            font.as_ref()
                .map(|f| element(ns, "rFonts", &[("ascii", f.clone()), ("hAnsi", f.clone()), ("eastAsia", f.clone()), ("cs", f.clone())], None))
                .transpose()?,
        ));
    }
    property_patch(state, run, "rPr", &changes, R_ORDER)
}

/// Ordered attribute map (JavaScript object insertion order).
#[derive(Default)]
struct Attrs(Vec<(String, String)>);
impl Attrs {
    fn set(&mut self, k: &str, v: String) {
        match self.0.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = v,
            None => self.0.push((k.into(), v)),
        }
    }
    fn remove(&mut self, k: &str) {
        self.0.retain(|(key, _)| key != k);
    }
}

fn format_paragraph(state: &State, paragraph: &XmlElement, format: &ParagraphFormat) -> Result<Patch> {
    let ns = &paragraph.namespace;
    let mut changes: Vec<(&str, Option<String>)> = Vec::new();
    if let Some(id) = &format.style_id {
        if let Some(v) = id {
            xml_string(v, "Style ID", 64)?;
            let b = v.as_bytes();
            let ok = !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_alphabetic() || b[0] == b'_') && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-');
            if !ok {
                return Err(invalid("invalid-format", "Unsupported style identity."));
            }
        }
        changes.push(("pStyle", id.as_ref().map(|v| element(ns, "pStyle", &[("val", v.clone())], None)).transpose()?));
    }
    if let Some(a) = &format.alignment {
        if let Some(v) = a
            && !["left", "center", "right", "both"].contains(&v.as_str())
        {
            return Err(invalid("invalid-format", "Unsupported paragraph alignment."));
        }
        changes.push(("jc", a.as_ref().map(|v| element(ns, "jc", &[("val", v.clone())], None)).transpose()?));
    }
    let spacing = word_child(word_child(Some(paragraph), "pPr"), "spacing");
    let mut attrs = Attrs(spacing.map_or(vec![], |s| s.attributes.iter().filter(|a| a.namespace == *ns).map(|a| (a.local_name.clone(), a.value.clone())).collect()));
    let mut changed = false;
    for (value, attr, field) in [
        (format.spacing_before_points, "before", "spacingBeforePoints"),
        (format.spacing_after_points, "after", "spacingAfterPoints"),
        (format.line_spacing_multiple, "line", "lineSpacingMultiple"),
    ] {
        let Some(amount) = value else { continue };
        changed = true;
        match amount {
            None => attrs.remove(attr),
            Some(v) => {
                let (min, max, factor) = if attr == "line" { (0.5, 5.0, 240.0) } else { (0.0, 1000.0, 20.0) };
                attrs.set(attr, js_number(js_round(number(v, min, max, field)? * factor)));
            }
        }
        if attr == "line" {
            if amount.is_none() {
                attrs.remove("lineRule");
            } else {
                attrs.set("lineRule", "auto".into());
            }
        }
        if attr == "before" {
            attrs.remove("beforeAutospacing");
        }
        if attr == "after" {
            attrs.remove("afterAutospacing");
        }
    }
    if changed {
        let pairs: Vec<(&str, String)> = attrs.0.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        changes.push(("spacing", if pairs.is_empty() { None } else { Some(element(ns, "spacing", &pairs, None)?) }));
    }
    property_patch(state, paragraph, "pPr", &changes, P_ORDER)
}

pub(crate) fn docx_page_layout(root: &XmlElement) -> PageLayout {
    let section = word_child(word_child(Some(root), "body"), "sectPr");
    let size = word_child(section, "pgSz");
    let margin = word_child(section, "pgMar");
    let twips = |node: Option<&XmlElement>, key: &str, fallback: f64, signed: bool| -> f64 {
        match own(node, key) {
            Some(t) if digits(t.strip_prefix('-').filter(|_| signed).unwrap_or(t)) => t.parse::<f64>().unwrap_or(fallback * 20.0) / 20.0,
            _ => fallback,
        }
    };
    PageLayout {
        width_points: twips(size, "w", 612.0, false),
        height_points: twips(size, "h", 792.0, false),
        orientation: if own(size, "orient") == Some("landscape") { Orientation::Landscape } else { Orientation::Portrait },
        margin_top_points: twips(margin, "top", 72.0, true),
        margin_right_points: twips(margin, "right", 72.0, false),
        margin_bottom_points: twips(margin, "bottom", 72.0, true),
        margin_left_points: twips(margin, "left", 72.0, false),
    }
}

fn page_layout(state: &State, root: &XmlElement, change: &PageLayoutChange) -> Result<Patch> {
    let previous = docx_page_layout(root);
    let (mut width, mut height) = (previous.width_points, previous.height_points);
    if let Some(paper) = change.paper {
        (width, height) = paper.size();
    }
    let orientation = change.orientation.unwrap_or(previous.orientation);
    (width, height) = if orientation == Orientation::Landscape { (width.max(height), width.min(height)) } else { (width.min(height), width.max(height)) };
    let mut layout = PageLayout { width_points: width, height_points: height, orientation, ..previous };
    if let Some(v) = change.margin_top_points {
        layout.margin_top_points = v;
    }
    if let Some(v) = change.margin_right_points {
        layout.margin_right_points = v;
    }
    if let Some(v) = change.margin_bottom_points {
        layout.margin_bottom_points = v;
    }
    if let Some(v) = change.margin_left_points {
        layout.margin_left_points = v;
    }
    number(layout.margin_top_points, -1000.0, 1000.0, "marginTopPoints")?;
    number(layout.margin_right_points, 0.0, 1000.0, "marginRightPoints")?;
    number(layout.margin_bottom_points, -1000.0, 1000.0, "marginBottomPoints")?;
    number(layout.margin_left_points, 0.0, 1000.0, "marginLeftPoints")?;
    if layout.margin_left_points + layout.margin_right_points >= width - 36.0 || layout.margin_top_points + layout.margin_bottom_points >= height - 36.0 {
        return Err(invalid("invalid-format", "Margins must leave at least half an inch of writing space."));
    }
    let body = word_child(Some(root), "body").expect("body");
    let section = word_child(Some(body), "sectPr");
    let old_margin = word_child(section, "pgMar");
    let twip = |v: f64| js_number(js_round(v * 20.0));
    let keep = |name: &str, fallback: &str| own(old_margin, name).filter(|v| !v.is_empty()).unwrap_or(fallback).to_string();
    let ns = &root.namespace;
    let size = element(
        ns,
        "pgSz",
        &[("w", twip(width)), ("h", twip(height)), ("orient", if orientation == Orientation::Landscape { "landscape" } else { "portrait" }.into())],
        None,
    )?;
    let margins = element(
        ns,
        "pgMar",
        &[
            ("top", twip(layout.margin_top_points)),
            ("right", twip(layout.margin_right_points)),
            ("bottom", twip(layout.margin_bottom_points)),
            ("left", twip(layout.margin_left_points)),
            ("header", keep("header", "720")),
            ("footer", keep("footer", "720")),
            ("gutter", keep("gutter", "0")),
        ],
        None,
    )?;
    if let Some(s) = section {
        let changes = [("pgSz", Some(size)), ("pgMar", Some(margins))];
        return Ok(Patch::new(s.start, s.end, wrap(&state.source, s, &ordered_properties(state, Some(s), &changes, SECTION_ORDER))));
    }
    Ok(Patch::new(body.end_tag_start, body.end_tag_start, element(ns, "sectPr", &[], Some(&format!("{size}{margins}")))?))
}

pub(crate) fn text_run(namespace: &str, text: &str) -> Result<String> {
    xml_string(text, "Paragraph text", 200_000)?;
    if text.contains(['\n', '\r', '\t']) {
        return Err(invalid("invalid-format", "Use separate paragraphs instead of tabs or line breaks."));
    }
    element(namespace, "r", &[], Some(&format!("<w:t xmlns:w=\"{namespace}\" xml:space=\"preserve\">{}</w:t>", escape_xml_text(text)?)))
}

fn insertion_offset(state: &State, root: &XmlElement, after: &InsertAt, allow_cell: bool) -> Result<usize> {
    let body = word_child(Some(root), "body").expect("body");
    match after {
        InsertAt::Start => Ok(body.start_tag_end),
        InsertAt::End => Ok(word_child(Some(body), "sectPr").map_or(body.end_tag_start, |s| s.start)),
        InsertAt::After(id) => {
            let paragraph = find_node(state, root, id, "p")?;
            let in_cell = allow_cell && xml_descendants(root).iter().any(|n| is_word(n, "tc") && n.has_child(paragraph.start));
            if !body.has_child(paragraph.start) && !in_cell {
                return Err(invalid("invalid-edit", "Block insertion requires a top-level paragraph."));
            }
            Ok(paragraph.end)
        }
    }
}

/// The table/paragraph/property operations owned by this module.
pub(crate) fn apply_docx_xml_operation(state: &State, operation: &Operation) -> Result<State> {
    let root = parse_xml(&state.source)?;
    let body = word_child(Some(&root), "body").expect("body");
    let patch = match operation {
        Operation::FormatRun { run_id, style } => format_run(state, find_node(state, &root, run_id, "r")?, style)?,
        Operation::FormatParagraph { paragraph_id, format } => format_paragraph(state, find_node(state, &root, paragraph_id, "p")?, format)?,
        Operation::SetPageLayout { layout } => page_layout(state, &root, layout)?,
        Operation::ReplaceParagraph { paragraph_id, text } => {
            let paragraph = find_node(state, &root, paragraph_id, "p")?;
            if xml_descendants(paragraph).iter().any(|n| is_word(n, "drawing")) {
                return Err(invalid("invalid-edit", "Delete inline images explicitly before replacing their paragraph."));
            }
            let ns = &paragraph.namespace;
            let first_run = paragraph.children.iter().find(|n| is_word(n, "r") && word_child(Some(n), "t").is_some());
            let run = match first_run {
                Some(r) => {
                    let props = word_child(Some(r), "rPr").map_or(String::new(), |p| raw(state, p).to_string());
                    wrap(&state.source, r, &format!("{props}<w:t xmlns:w=\"{ns}\" xml:space=\"preserve\">{}</w:t>", escape_xml_text(&xml_string(text, "Paragraph text", 200_000)?)?))
                }
                None => text_run(ns, text)?,
            };
            if text.contains(['\r', '\n', '\t']) {
                return Err(invalid("invalid-format", "Use separate paragraphs instead of tabs or line breaks."));
            }
            let starts: String = paragraph.children.iter().filter(|n| is_word(n, "commentRangeStart")).map(|n| raw(state, n)).collect();
            let ends: String = paragraph
                .children
                .iter()
                .filter(|n| is_word(n, "commentRangeEnd") || (is_word(n, "r") && word_child(Some(n), "commentReference").is_some()))
                .map(|n| raw(state, n))
                .collect();
            let props = word_child(Some(paragraph), "pPr").map_or("", |p| raw(state, p));
            let content = format!("{props}{starts}{run}{ends}");
            if paragraph.self_closing() {
                Patch::keep(paragraph.start, paragraph.end, wrap(&state.source, paragraph, &content))
            } else {
                Patch::new(paragraph.start_tag_end, paragraph.end_tag_start, content)
            }
        }
        Operation::InsertParagraph { after_paragraph_id, text } => {
            let start = insertion_offset(state, &root, after_paragraph_id, true)?;
            Patch::new(start, start, element(&root.namespace, "p", &[], Some(&text_run(&root.namespace, text)?))?)
        }
        Operation::DeleteParagraph { paragraph_id } => {
            let paragraph = find_node(state, &root, paragraph_id, "p")?;
            let parent = crate::xml::xml_parent(&root, paragraph.start).expect("parent");
            if paragraph.children.iter().any(|n| is_word(n, "commentRangeStart")) {
                return Err(invalid("invalid-edit", "Delete paragraph comments before deleting their paragraph."));
            }
            if word_child(word_child(Some(paragraph), "pPr"), "sectPr").is_some() {
                return Err(invalid(
                    "invalid-edit",
                    "This paragraph ends a document section (its own page setup, headers and footers); it cannot be deleted here.",
                ));
            }
            if xml_descendants(paragraph).iter().any(|n| is_word(n, "drawing")) {
                return Err(invalid("invalid-edit", "Delete inline images explicitly before deleting their paragraph."));
            }
            if parent.children.iter().filter(|n| is_word(n, "p") || is_word(n, "tbl")).count() <= 1 {
                return Err(invalid("invalid-edit", "Keep at least one paragraph in a document or table cell."));
            }
            Patch::new(paragraph.start, paragraph.end, "")
        }
        Operation::InsertTable { after_paragraph_id, rows, columns, cells } => {
            let (rows, columns) = (*rows, *columns);
            number(rows as f64, 1.0, 100.0, "Table rows")?;
            number(columns as f64, 1.0, 20.0, "Table columns")?;
            if rows * columns > 1000 {
                return Err(invalid("invalid-format", "Table dimensions must be integers within 1000 cells."));
            }
            if let Some(c) = cells
                && (c.len() != rows || c.iter().any(|r| r.len() != columns))
            {
                return Err(invalid("invalid-format", "Table cell data must match its dimensions."));
            }
            let layout = docx_page_layout(&root);
            let ns = &root.namespace;
            let cell_width = (((layout.width_points - layout.margin_left_points - layout.margin_right_points) * 20.0 / columns as f64).floor() as i64).max(360);
            let mut grid = String::new();
            for _ in 0..columns {
                grid.push_str(&element(ns, "gridCol", &[("w", cell_width.to_string())], None)?);
            }
            let grid = element(ns, "tblGrid", &[], Some(&grid))?;
            let mut table_rows = String::new();
            for r in 0..rows {
                let mut row = String::new();
                for c in 0..columns {
                    let text = cells.as_ref().and_then(|x| x.get(r)).and_then(|x| x.get(c)).map_or("", String::as_str);
                    let tc_pr = element(ns, "tcPr", &[], Some(&element(ns, "tcW", &[("w", cell_width.to_string()), ("type", "dxa".into())], None)?))?;
                    let p = element(ns, "p", &[], Some(&text_run(ns, text)?))?;
                    row.push_str(&element(ns, "tc", &[], Some(&format!("{tc_pr}{p}")))?);
                }
                table_rows.push_str(&element(ns, "tr", &[], Some(&row))?);
            }
            let start = insertion_offset(state, &root, after_paragraph_id, false)?;
            let tbl_pr = element(ns, "tblPr", &[], Some(&element(ns, "tblW", &[("w", (cell_width * columns as i64).to_string()), ("type", "dxa".into())], None)?))?;
            Patch::new(start, start, element(ns, "tbl", &[], Some(&format!("{tbl_pr}{grid}{table_rows}")))?)
        }
        Operation::DeleteTable { table_id } => {
            let table = find_node(state, &root, table_id, "tbl")?;
            if !body.has_child(table.start) {
                return Err(invalid("invalid-edit", "Nested table editing is unsupported."));
            }
            if xml_descendants(table).iter().any(|n| is_word(n, "commentRangeStart")) {
                return Err(invalid("invalid-edit", "Delete table comments before deleting their table."));
            }
            if xml_descendants(table).iter().any(|n| is_word(n, "drawing")) {
                return Err(invalid("invalid-edit", "Delete inline images explicitly before deleting their table."));
            }
            if body.children.iter().filter(|n| is_word(n, "p") || is_word(n, "tbl")).count() <= 1 {
                return Err(invalid("invalid-edit", "Keep at least one document block."));
            }
            Patch::new(table.start, table.end, "")
        }
        _ => return Err(invalid("invalid-edit", "Unsupported document operation.")),
    };
    patch_docx_source(state, vec![patch])
}

// ---- passive Word analysis caches (docx-derived.ts) ----

pub(crate) fn valid_derived_marker(node: &XmlElement) -> bool {
    if !any_word(node) || !node.children.is_empty() || !node.text.is_empty() {
        return false;
    }
    node.local_name == "lastRenderedPageBreak"
        || (node.local_name == "proofErr"
            && ["spellStart", "spellEnd", "gramStart", "gramEnd"].contains(&xml_attribute(node, "type", &node.namespace).unwrap_or("")))
}

/// A calculated page boundary may split a single logical text run into t nodes.
pub(crate) fn cached_text_run(node: &XmlElement) -> bool {
    let content: Vec<&XmlElement> = node.children.iter().filter(|c| !is_word(c, "rPr")).collect();
    content.iter().any(|c| is_word(c, "lastRenderedPageBreak"))
        && content.iter().all(|c| is_word(c, "t") || is_word(c, "lastRenderedPageBreak"))
        && content.iter().enumerate().all(|(i, c)| !is_word(c, "t") || i == 0 || !is_word(content[i - 1], "t"))
}

/// Replace `xml:space="..."` (or add `xml:space="preserve"`) in a t opening tag.
pub(crate) fn preserve_space(opening: &str) -> String {
    if let Some(at) = find_xml_space(opening) {
        let rest = &opening[at..];
        let eq = rest.find('=').unwrap_or(0);
        let after = &rest[eq + 1..];
        let lead = after.len() - after.trim_start().len();
        let quoted = &after[lead..];
        let q = quoted.chars().next().unwrap_or('"');
        let close = quoted[1..].find(q).map_or(quoted.len(), |c| c + 2);
        let end = at + eq + 1 + lead + close;
        let replaced = format!("{}xml:space=\"preserve\"{}", &opening[..at], &opening[end..]);
        return match replaced.strip_suffix("/>") {
            Some(o) => format!("{o}>"),
            None => replaced,
        };
    }
    let base = opening.strip_suffix("/>").or_else(|| opening.strip_suffix('>')).unwrap_or(opening);
    format!("{base} xml:space=\"preserve\">")
}

/// Position of `xml:space` followed by optional whitespace and `=`.
fn find_xml_space(opening: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = opening[from..].find("xml:space") {
        let at = from + rel;
        let rest = opening[at + 9..].trim_start_matches([' ', '\t', '\r', '\n']);
        if rest.starts_with('=') {
            return Some(at);
        }
        from = at + 9;
    }
    None
}

/// Mutations invalidate calculated pagination; text changes also invalidate
/// proofing. An optional scope confines invalidation, keeping other bytes identical.
pub(crate) fn invalidate_docx_derived(state: &State, proofing: bool, scope: Option<&[(usize, usize)]>) -> Result<State> {
    let root = parse_xml(&state.source)?;
    let nodes: Vec<&XmlElement> = xml_descendants(&root)
        .into_iter()
        .filter(|n| scope.is_none_or(|s| s.iter().any(|(a, b)| n.start >= *a && n.end <= *b)))
        .collect();
    let merged: Vec<&XmlElement> = nodes
        .iter()
        .copied()
        .filter(|n| is_word(n, "r") && cached_text_run(n) && n.children.iter().filter(|c| is_word(c, "t")).count() > 1)
        .collect();
    let merged_children: HashSet<usize> = merged.iter().flat_map(|r| r.children.iter().map(|c| c.start)).collect();
    let mut patches = Vec::new();
    for run in &merged {
        let texts: Vec<&XmlElement> = run.children.iter().filter(|n| is_word(n, "t")).collect();
        let first = texts[0];
        // Keep the first text node's namespace bindings while combining the marker-separated text.
        let opening = format!("<{}{}", first.name, &state.source[first.start + 1 + first.name.len()..first.start_tag_end]);
        let opening = match opening.strip_suffix("/>") {
            Some(o) => format!("{o}>"),
            None => opening,
        };
        let spaced = preserve_space(&opening);
        let mut contents = String::new();
        for node in &run.children {
            if node.start == first.start {
                let joined: String = texts.iter().map(|t| t.text.as_str()).collect();
                contents.push_str(&format!("{spaced}{}</{}>", escape_xml_text(&joined)?, first.name));
            } else if !(is_word(node, "t") || is_word(node, "lastRenderedPageBreak")) {
                contents.push_str(raw(state, node));
            }
        }
        patches.push(Patch::new(run.start_tag_end, run.end_tag_start, contents));
    }
    for node in &nodes {
        if (is_word(node, "lastRenderedPageBreak") || (proofing && is_word(node, "proofErr"))) && !merged_children.contains(&node.start) {
            patches.push(Patch::new(node.start, node.end, ""));
        }
    }
    if patches.is_empty() {
        return Ok(state.clone());
    }
    patch_docx_source(state, patches)
}

// ---- complex fields (docx-fields.ts, ECMA-376 17.16.18) ----

#[derive(Default)]
pub(crate) struct FieldScan {
    /// Start offsets of runs that belong to a field.
    pub runs: HashSet<usize>,
    /// Start offsets of paragraphs that contain field runs or lie inside a field.
    pub paragraphs: HashSet<usize>,
    /// Start offsets of paragraphs whose paragraph mark is inside an open field.
    pub open_after: HashSet<usize>,
    pub problem: Option<&'static str>,
}

pub(crate) fn scan_docx_fields(root: &XmlElement) -> FieldScan {
    let mut scan = FieldScan::default();
    let mut depth: i64 = 0;
    for paragraph in xml_descendants(root).into_iter().filter(|n| is_word(n, "p")) {
        for run in xml_descendants(paragraph).into_iter().filter(|n| is_word(n, "r")) {
            let mut inside = depth > 0;
            for child in &run.children {
                if is_word(child, "instrText") {
                    inside = true;
                }
                if !is_word(child, "fldChar") {
                    continue;
                }
                inside = true;
                match xml_attribute(child, "fldCharType", &child.namespace) {
                    Some("begin") => depth += 1,
                    Some("end") => {
                        depth -= 1;
                        if depth < 0 {
                            scan.problem = Some("Field end has no matching field start.");
                            return scan;
                        }
                    }
                    Some("separate") if depth > 0 => {}
                    _ => {
                        scan.problem = Some("Field separator is outside a field.");
                        return scan;
                    }
                }
            }
            if inside {
                scan.runs.insert(run.start);
                scan.paragraphs.insert(paragraph.start);
            }
        }
        if depth > 0 {
            scan.open_after.insert(paragraph.start);
            scan.paragraphs.insert(paragraph.start);
        }
    }
    if depth != 0 {
        scan.problem = Some("Field start has no matching field end.");
    }
    scan
}

/// A run's text node rewritten to `text`, with the run's other children verbatim.
pub(crate) fn docx_run_text_fragment(source: &str, run: &XmlElement, text_node: &XmlElement, text: &str) -> Result<String> {
    let opening = preserve_space(&source[text_node.start..text_node.start_tag_end]);
    Ok(format!(
        "{}{opening}{}</{}>{}",
        &source[run.start..text_node.start],
        escape_xml_text(text)?,
        text_node.name,
        &source[text_node.end..run.end]
    ))
}
