//! Clean-room DOCX engine from ECMA-376 Parts 1 and 2 (WordprocessingML, OPC),
//! W3C XML and PKWARE APPNOTE. Ported from `src/lib/office/docx.ts`.
//!
//! This is NOT a Word-compatible layout or review engine. It safely edits a
//! deliberately narrow subset; other documents open read-only. An untouched
//! document exports its original bytes; edits rewrite only the parts they own.

mod edit;
pub mod fonts;
mod links;
mod media;
mod parts;
mod review;
mod structure;

use crate::error::{OfficeError, Result};
use crate::model::*;
use crate::xml::{XMLNS_NAMESPACE, XML_NAMESPACE, XmlElement, escape_xml_text, parse_xml, utf16_len, xml_attribute, xml_descendants};
use crate::zip::{DEFAULT_ZIP_LIMITS, ZipEntry, ZipLimits, read_zip, resolve_zip_limits, write_zip};
use edit::*;
use links::*;
use media::*;
use parts::*;
use review::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

pub use edit::{XmlEncoding, decode_docx_xml, encode_docx_xml};
pub use links::safe_docx_hyperlink_target;
pub use media::{Bitmap, inspect_docx_bitmap};
pub use structure::grapheme_boundary;

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = DOCX_R;
const R_STRICT: &str = DOCX_R_STRICT;
const REL: &str = DOCX_REL;
const CT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const VML: &str = "urn:schemas-microsoft-com:vml";
const OFFICE: &str = "urn:schemas-microsoft-com:office:office";
const W14: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
const MC: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/// Insertion-ordered part overrides (a JavaScript `Map`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PartMap(Vec<(String, Vec<u8>)>);
impl PartMap {
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, d)| d.as_slice())
    }
    pub fn set(&mut self, name: &str, data: Vec<u8>) {
        match self.0.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = data,
            None => self.0.push((name.to_string(), data)),
        }
    }
    pub fn remove(&mut self, name: &str) {
        self.0.retain(|(n, _)| n != name);
    }
    pub fn has(&self, name: &str) -> bool {
        self.0.iter().any(|(n, _)| n == name)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, Vec<u8>)> {
        self.0.iter()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TextNode {
    start: usize,
    start_tag_end: usize,
    end: usize,
    name: String,
    text: String,
}

/// The engine session behind one snapshot. Cheap to clone: package bytes are shared.
#[derive(Clone, Debug)]
pub(crate) struct State {
    pub source: String,
    pub identities: BTreeMap<usize, String>,
    pub next_id: u64,
    pub entries: Arc<Vec<ZipEntry>>,
    pub main_part: String,
    pub part_overrides: PartMap,
    pub deleted_parts: BTreeSet<String>,
    pub next_image_id: Option<u64>,
    pub next_revision_id: Option<u64>,
    original: Arc<Vec<u8>>,
    original_source: Arc<String>,
    run_nodes: HashMap<String, TextNode>,
    original_run_nodes: Arc<HashMap<String, (String, String)>>,
    limits: ZipLimits,
    encodings: Arc<HashMap<String, XmlEncoding>>,
}

impl State {
    /// `${prefix}${nextId++}`
    pub(crate) fn fresh(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}{}", self.next_id);
        self.next_id += 1;
        id
    }
    /// Entries (minus deletions) then new overrides, as `docxEntries` lists them.
    pub(crate) fn all_part_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.entries.iter().filter(|e| !self.deleted_parts.contains(&e.name)).map(|e| e.name.clone()).collect();
        for (name, _) in self.part_overrides.iter() {
            if !self.deleted_parts.contains(name) && !names.contains(name) {
                names.push(name.clone());
            }
        }
        names
    }
    fn entries_out(&self) -> Vec<ZipEntry> {
        self.all_part_names().into_iter().map(|name| {
            let data = parts::docx_part(self, &name).unwrap_or_default().to_vec();
            ZipEntry { name, data }
        }).collect()
    }
    fn modified(&self) -> bool {
        self.source != *self.original_source || !self.part_overrides.is_empty() || !self.deleted_parts.is_empty()
    }
}

/// An opened DOCX snapshot. Operations return a new snapshot; old ones stay
/// valid (undo history), exactly like the immutable TypeScript snapshots.
#[derive(Clone, Debug)]
pub struct DocxDocument {
    pub doc: RichDocument,
    state: State,
}

impl std::ops::Deref for DocxDocument {
    type Target = RichDocument;
    fn deref(&self) -> &RichDocument {
        &self.doc
    }
}

fn err(code: &str, message: &str) -> OfficeError {
    OfficeError::docx(code, message)
}

pub(crate) fn relationship_source(name: &str) -> Result<String> {
    if name == "_rels/.rels" {
        return Ok(String::new());
    }
    let bad = || err("invalid-relationships", &format!("Invalid relationships part: {name}"));
    let file = name.strip_suffix(".rels").ok_or_else(bad)?;
    let (dir, base) = match file.rfind("_rels/") {
        Some(i) if i == 0 || file.as_bytes()[i - 1] == b'/' => (&file[..i], &file[i + 6..]),
        _ => return Err(bad()),
    };
    if base.is_empty() || base.contains('/') {
        return Err(bad());
    }
    Ok(format!("{dir}{base}"))
}

fn resolve_target(source: &str, target: &str) -> Result<String> {
    // Parent walks are allowed inside the package; aliases, schemes and backslashes fail shut.
    let bad = |m: &str| err("invalid-relationships", m);
    if target.is_empty() || target.chars().any(|c| c == '\\' || (c as u32) <= 0x20 || c == '\u{7f}' || matches!(c, ':' | '%' | '?' | '#')) || target.starts_with("//") {
        return Err(bad("Unsupported or unsafe internal relationship target."));
    }
    let mut pieces: Vec<&str> = if target.starts_with('/') { vec![] } else { source.split('/').collect() };
    if !target.starts_with('/') {
        pieces.pop();
    }
    for piece in target.strip_prefix('/').unwrap_or(target).split('/') {
        if piece.is_empty() || piece == "." {
            return Err(bad("Ambiguous relationship target."));
        }
        if piece == ".." {
            if pieces.pop().is_none() {
                return Err(bad("Relationship escapes the package."));
            }
        } else {
            pieces.push(piece);
        }
    }
    Ok(pieces.join("/"))
}

#[derive(Clone, Debug)]
struct Relationship {
    id: String,
    kind: String,
    target: String,
    external: bool,
}

fn parse_relationships(name: &str, root: &XmlElement, parts: &HashSet<String>) -> Result<Vec<Relationship>> {
    let source = relationship_source(name)?;
    let bad = |m: &str| err("invalid-relationships", m);
    if !source.is_empty() && !parts.contains(&source) {
        return Err(bad("Relationships source part is missing."));
    }
    if root.namespace != REL || root.local_name != "Relationships" || !ws_only(&root.text) {
        return Err(bad("Invalid package relationships root."));
    }
    let mut ids = HashSet::new();
    let mut out = Vec::new();
    for node in &root.children {
        let (id, kind, target, mode) = (node.plain("Id"), node.plain("Type"), node.plain("Target"), node.plain("TargetMode"));
        let type_ok = kind.is_some_and(|t| {
            t.find("://").is_some_and(|i| i > 0 && t.as_bytes()[0].is_ascii_alphabetic() && t[..i].bytes().all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b)))
        });
        let invalid_node = node.namespace != REL
            || node.local_name != "Relationship"
            || !node.children.is_empty()
            || !ws_only(&node.text)
            || id.is_none_or(|i| i.is_empty() || i.chars().any(char::is_whitespace) || ids.contains(i))
            || !type_ok
            || target.is_none_or(str::is_empty)
            || mode.is_some_and(|m| m != "Internal" && m != "External")
            || node.attributes.iter().any(|a| a.namespace != XMLNS_NAMESPACE && (!a.namespace.is_empty() || !["Id", "Type", "Target", "TargetMode"].contains(&a.name.as_str())));
        if invalid_node {
            return Err(bad("Invalid, duplicate or unsupported package relationship."));
        }
        ids.insert(id.unwrap().to_string());
        let external = mode == Some("External");
        let resolved = if external { target.unwrap().to_string() } else { resolve_target(&source, target.unwrap())? };
        if !external && (!parts.contains(&resolved) || resolved.ends_with('/') || resolved == "[Content_Types].xml" || resolved.ends_with(".rels")) {
            return Err(bad(&format!("Relationship points to a missing or invalid part: {resolved}")));
        }
        out.push(Relationship { id: id.unwrap().to_string(), kind: kind.unwrap().to_string(), target: resolved, external });
    }
    Ok(out)
}

fn content_types(root: &XmlElement, names: &[String]) -> Result<Vec<(String, String)>> {
    let bad = |m: &str| err("invalid-content-types", m);
    if root.namespace != CT || root.local_name != "Types" || !ws_only(&root.text) {
        return Err(bad("DOCX has no valid content-types manifest."));
    }
    let set: HashSet<&str> = names.iter().map(String::as_str).collect();
    let mut defaults: HashMap<String, String> = HashMap::new();
    let mut overrides: HashMap<String, String> = HashMap::new();
    for node in &root.children {
        let kind = node.plain("ContentType");
        let kind_ok = kind.is_some_and(|t| t.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && !b.contains('/') && !t.chars().any(char::is_whitespace)));
        if node.namespace != CT || !kind_ok || !node.children.is_empty() || !ws_only(&node.text) {
            return Err(bad("Invalid content-type declaration."));
        }
        let allowed: &[&str] = if node.local_name == "Default" { &["Extension", "ContentType"] } else { &["PartName", "ContentType"] };
        if node.attributes.iter().any(|a| a.namespace != XMLNS_NAMESPACE && (!a.namespace.is_empty() || !allowed.contains(&a.name.as_str()))) {
            return Err(bad("Unsupported content-type attributes."));
        }
        match node.local_name.as_str() {
            "Default" => {
                let ext = node.plain("Extension");
                let ok = ext.is_some_and(|e| !e.is_empty() && e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
                let lower = ext.unwrap_or("").to_lowercase();
                if !ok || defaults.contains_key(&lower) {
                    return Err(bad("Invalid or duplicate default content type."));
                }
                defaults.insert(lower, kind.unwrap().to_string());
            }
            "Override" => {
                let name = node.plain("PartName");
                let part = name.and_then(|n| n.strip_prefix('/'));
                match part {
                    Some(p) if set.contains(p) && !overrides.contains_key(p) => {
                        overrides.insert(p.to_string(), kind.unwrap().to_string());
                    }
                    _ => return Err(bad("Invalid or duplicate content-type override.")),
                }
            }
            _ => return Err(bad("Unknown content-type declaration.")),
        }
    }
    let mut result = Vec::new();
    for name in names {
        if name == "[Content_Types].xml" || name.ends_with('/') {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        let Some(kind) = overrides.get(name).or_else(|| defaults.get(&ext)) else {
            return Err(bad(&format!("Part has no declared content type: {name}")));
        };
        if name.ends_with(".rels") && kind != "application/vnd.openxmlformats-package.relationships+xml" {
            return Err(bad("Relationships part has an invalid content type."));
        }
        result.push((name.clone(), kind.clone()));
    }
    Ok(result)
}

fn allowed_children(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "document" => &["body"],
        "body" => &["p", "tbl", "sectPr", "bookmarkStart", "bookmarkEnd"],
        "p" => &["pPr", "commentRangeStart", "bookmarkStart", "bookmarkEnd", "r", "hyperlink", "ins", "del", "commentRangeEnd", "proofErr"],
        "r" => &["rPr", "t", "delText", "br", "tab", "cr", "commentReference", "drawing", "pict", "lastRenderedPageBreak", "fldChar", "instrText"],
        "hyperlink" | "ins" | "del" => &["r"],
        "tbl" => &["tblPr", "tblGrid", "tr"],
        "tr" => &["trPr", "tblPrEx", "tc"],
        "tc" => &["tcPr", "p"],
        _ => return None,
    })
}
fn allowed_attributes(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "document" | "body" | "p" | "r" | "tr" | "tbl" | "tc" | "t" | "delText" | "instrText" | "tab" | "cr" | "lastRenderedPageBreak" => &[],
        "br" => &["type", "clear"],
        "fldChar" => &["fldCharType", "dirty", "fldLock"],
        "commentRangeStart" | "commentRangeEnd" | "commentReference" => &["id"],
        "bookmarkStart" => &["id", "name", "colFirst", "colLast", "displacedByCustomXml"],
        "bookmarkEnd" => &["id", "displacedByCustomXml"],
        "ins" | "del" => &["id", "author", "date"],
        "hyperlink" => &["history", "tooltip", "anchor", "docLocation", "tgtFrame"],
        "proofErr" => &["type"],
        _ => return None,
    })
}
const PROPERTY_CONTAINERS: &[&str] = &["pPr", "rPr", "sectPr", "tblPr", "trPr", "tcPr", "tblGrid", "tblPrEx"];
const PROPERTY_REVISIONS: &[&str] = &["pPrChange", "rPrChange", "sectPrChange", "ins", "del", "moveFrom", "moveTo", "numberingChange"];
const REPEATABLE_PROPERTIES: &[&str] = &["headerReference", "footerReference", "gridCol"];
const HIDDEN_TEXT: &[&str] = &["vanish", "specVanish"];
const OPAQUE_INLINE: &[&str] = &["hyperlink", "br", "pict", "bookmarkStart", "bookmarkEnd", "tab", "cr", "fldChar", "instrText"];
const EDITED_PROPERTY_CONTAINERS: &[&str] = &["pPr", "rPr", "sectPr"];
const SAFE_OFFICE_DEPENDENCIES: &[&str] = &[
    "officeDocument", "styles", "theme", "fontTable", "settings", "webSettings", "extended-properties", "custom-properties", "comments",
    "numbering", "image", "header", "footer", "font", "customXml", "customXmlProps",
];
const SAFE_EXTENSION_DEPENDENCIES: &[&str] = &[
    "http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects",
    "http://schemas.microsoft.com/office/2011/relationships/webextension",
    "http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes",
    "http://schemas.microsoft.com/office/2011/relationships/people",
    "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
    "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
    "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
];
const BINARY_DEPENDENCIES: &[&str] = &["image", "thumbnail", "font"];

/// Word-namespace descendants outside property containers.
fn inline_words(node: &XmlElement) -> Vec<&XmlElement> {
    let mut result = Vec::new();
    fn visit<'a>(current: &'a XmlElement, out: &mut Vec<&'a XmlElement>) {
        for child in &current.children {
            if !any_word(child) || PROPERTY_CONTAINERS.contains(&child.local_name.as_str()) {
                continue;
            }
            out.push(child);
            visit(child, out);
        }
    }
    visit(node, &mut result);
    result
}

/// A legacy VML horizontal rule is an opaque, text-free shape preserved verbatim.
fn is_horizontal_rule_pict(node: &XmlElement) -> bool {
    if !is_word(node, "pict") || node.children.len() != 1 {
        return false;
    }
    let shape = &node.children[0];
    if shape.namespace != VML || !(shape.local_name == "rect" || shape.local_name == "shape") {
        return false;
    }
    let hr = xml_attribute(shape, "hr", OFFICE);
    if !hr.is_some_and(|h| ["t", "true", "1", "on"].contains(&h.to_lowercase().as_str())) {
        return false;
    }
    xml_descendants(node).iter().all(|n| ws_only(&n.text) && n.local_name != "imagedata" && n.local_name != "textbox")
}
fn safe_horizontal_rules(root: &XmlElement) -> Vec<usize> {
    xml_descendants(root).into_iter().filter(|n| is_word(n, "pict") && is_horizontal_rule_pict(n)).map(|n| n.start).collect()
}

/// Generator templates ship separator-only footnote/endnote parts.
fn is_separator_only_notes(root: &XmlElement, kind: &str) -> bool {
    let note = if kind == "footnotes" { "footnote" } else { "endnote" };
    if !is_word(root, kind) || root.children.len() > 8 {
        return false;
    }
    root.children.iter().all(|n| is_word(n, note) && ["separator", "continuationSeparator", "continuationNotice"].contains(&own(Some(n), "type").unwrap_or("")))
}

fn has_story_review_state(root: &XmlElement) -> bool {
    xml_descendants(root).iter().any(|n| any_word(n) && (["ins", "del", "moveFrom", "moveTo", "commentRangeStart", "commentReference"].contains(&n.local_name.as_str()) || n.local_name.ends_with("PrChange")))
}

fn whole_number(value: Option<&str>) -> bool {
    value.is_some_and(|v| v == "0" || (digits(v) && !v.starts_with('0') && v.len() <= 10))
}

fn unsupported_properties(container: &XmlElement) -> Option<String> {
    let mut seen = HashSet::new();
    if EDITED_PROPERTY_CONTAINERS.contains(&container.local_name.as_str()) {
        for child in &container.children {
            let key = format!("{}|{}", child.namespace, child.local_name);
            if !seen.insert(key) && !(any_word(child) && REPEATABLE_PROPERTIES.contains(&child.local_name.as_str())) {
                return Some(container.name.clone());
            }
        }
    }
    for node in xml_descendants(container) {
        if !ws_only(&node.text) || (node.start != container.start && any_word(node) && (PROPERTY_REVISIONS.contains(&node.local_name.as_str()) || HIDDEN_TEXT.contains(&node.local_name.as_str()))) {
            return Some(node.name.clone());
        }
    }
    None
}

fn table_span(row: &XmlElement) -> Option<u64> {
    let grid = |name: &str| val(word_child(word_child(Some(row), "trPr"), name));
    let mut span = 0u64;
    let cells: Vec<Option<&str>> = row.children.iter().filter(|n| is_word(n, "tc")).map(|c| Some(val(word_child(word_child(Some(c), "tcPr"), "gridSpan")).unwrap_or("1"))).collect();
    for amount in [grid("gridBefore"), grid("gridAfter")].into_iter().chain(cells) {
        let Some(a) = amount else { continue };
        if !whole_number(Some(a)) {
            return None;
        }
        span += a.parse::<u64>().unwrap_or(0);
    }
    Some(span)
}

fn ignorable_list(value: &str) -> bool {
    let parts: Vec<&str> = value.split([' ', '\t', '\r', '\n']).collect();
    !value.is_empty() && !value.starts_with(char::is_whitespace) && !value.ends_with(char::is_whitespace)
        && parts.iter().filter(|p| !p.is_empty()).all(|p| crate::xml::valid_name(p) && !p.contains(':'))
}

fn unsupported_markup(root: &XmlElement, safe: &[usize]) -> Option<String> {
    let mut bookmark_starts: HashMap<String, (usize, String)> = HashMap::new();
    let mut bookmark_ends: HashMap<String, (usize, String)> = HashMap::new();
    let skipped: HashSet<usize> = safe.iter().copied().collect();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if (is_word(node, "drawing") || is_word(node, "pict")) && skipped.contains(&node.start) {
            continue;
        }
        if any_word(node) && PROPERTY_CONTAINERS.contains(&node.local_name.as_str()) && node.start != root.start {
            if let Some(p) = unsupported_properties(node) {
                return Some(p);
            }
            continue;
        }
        for child in node.children.iter().rev() {
            stack.push(child);
        }
        let local = node.local_name.as_str();
        if is_word(node, "bookmarkStart") || is_word(node, "bookmarkEnd") {
            let id = own(Some(node), "id");
            let id_ok = id.is_some_and(|i| {
                let d = i.strip_prefix('-').unwrap_or(i);
                digits(d) && d.len() <= 10
            });
            let seen = if local == "bookmarkStart" { &mut bookmark_starts } else { &mut bookmark_ends };
            if !id_ok || seen.contains_key(id.unwrap()) {
                return Some(node.name.clone());
            }
            if local == "bookmarkStart" && own(Some(node), "name").is_none() {
                return Some(node.name.clone());
            }
            seen.insert(id.unwrap().to_string(), (node.start, node.name.clone()));
        }
        let Some(allowed_attrs) = allowed_attributes(local).filter(|_| any_word(node)) else { return Some(node.name.clone()) };
        if (local == "proofErr" || local == "lastRenderedPageBreak") && !valid_derived_marker(node) {
            return Some(node.name.clone());
        }
        if local == "br" && (!matches!(own(Some(node), "type"), None | Some("page" | "textWrapping" | "column")) || !matches!(own(Some(node), "clear"), None | Some("none" | "left" | "right" | "all"))) {
            return Some(node.name.clone());
        }
        if local == "fldChar" && !["begin", "separate", "end"].contains(&own(Some(node), "fldCharType").unwrap_or("")) {
            return Some(node.name.clone());
        }
        let allowed = allowed_children(local).unwrap_or(&[]);
        if node.children.iter().any(|c| !any_word(c) || c.namespace != node.namespace || !allowed.contains(&c.local_name.as_str())) {
            return Some(node.name.clone());
        }
        let text_node = ["t", "delText", "instrText"].contains(&local);
        if !text_node && !ws_only(&node.text) {
            return Some(node.name.clone());
        }
        let bad_attr = node.attributes.iter().any(|a| {
            a.namespace != XMLNS_NAMESPACE
                && !(text_node && a.namespace == XML_NAMESPACE && a.local_name == "space" && (a.value == "default" || a.value == "preserve"))
                && !(a.namespace == node.namespace && allowed_attrs.contains(&a.local_name.as_str()))
                && !(["p", "r", "tr"].contains(&local) && a.namespace == node.namespace && a.local_name.starts_with("rsid") && a.local_name[4..].bytes().all(|b| b.is_ascii_alphabetic()))
                && !(local == "hyperlink" && (a.namespace == R || a.namespace == R_STRICT) && a.local_name == "id")
                && !(local == "document" && a.namespace == MC && a.local_name == "Ignorable" && ignorable_list(&a.value))
                && !(["p", "tr"].contains(&local) && a.namespace == W14 && (a.local_name == "paraId" || a.local_name == "textId") && a.value.len() == 8 && a.value.bytes().all(|b| b.is_ascii_hexdigit()))
        });
        if bad_attr {
            return Some(node.name.clone());
        }
        let names: Vec<&str> = node.children.iter().map(|c| c.local_name.as_str()).collect();
        let props = format!("{local}Pr");
        let structure_bad = (local == "document" && names != ["body"])
            || (local == "body" && (names.iter().filter(|n| **n == "sectPr").count() > 1 || (names.contains(&"sectPr") && names.last() != Some(&"sectPr"))))
            || ((local == "p" || local == "r") && (names.iter().filter(|n| **n == props).count() > 1 || (names.contains(&props.as_str()) && names[0] != props)));
        if structure_bad {
            return Some(node.name.clone());
        }
        if local == "r" && names.contains(&"commentReference") && (names.contains(&"t") || names.iter().filter(|n| **n == "commentReference").count() != 1) {
            return Some(node.name.clone());
        }
        if local == "tbl" {
            let rows: Vec<&XmlElement> = node.children.iter().filter(|n| is_word(n, "tr")).collect();
            // Rows must cover the declared grid; an empty tblGrid means every row covers the same span.
            let declared = word_child(Some(node), "tblGrid").map_or(0, |g| g.children.iter().filter(|n| is_word(n, "gridCol")).count() as u64);
            let columns = if declared > 0 { declared } else { rows.first().and_then(|r| table_span(r)).unwrap_or(0) };
            if columns == 0 || columns > 63 || rows.is_empty() || rows.len() > 1000 || rows.len() as u64 * columns > 20000 || names.first() != Some(&"tblPr") || names.get(1) != Some(&"tblGrid") || rows.iter().any(|r| table_span(r) != Some(columns)) {
                return Some(node.name.clone());
            }
        }
        if local == "tr" && (!names.contains(&"tc") || names[names.iter().position(|n| *n == "tc").unwrap()..].iter().any(|n| *n != "tc")) {
            return Some(node.name.clone());
        }
        if local == "tc" && (!names.contains(&"p") || names.last() != Some(&"p") || names.iter().filter(|n| **n == "tcPr").count() > 1 || (names.contains(&"tcPr") && names[0] != "tcPr")) {
            return Some(node.name.clone());
        }
    }
    for (id, (start, name)) in &bookmark_starts {
        match bookmark_ends.get(id) {
            Some((end, _)) if *end > *start => {}
            _ => return Some(name.clone()),
        }
    }
    for (id, (_, name)) in &bookmark_ends {
        if !bookmark_starts.contains_key(id) {
            return Some(name.clone());
        }
    }
    if scan_docx_fields(root).problem.is_some() {
        return Some("w:fldChar".into());
    }
    None
}

fn safe_drawings(state: &State, root: &XmlElement) -> Result<Vec<usize>> {
    let media = inspect_docx_images(state)?;
    let mut safe: Vec<usize> = if media.problem.is_some() { vec![] } else { media.images.iter().map(|i| i.drawing_start).collect() };
    safe.extend(safe_horizontal_rules(root));
    Ok(safe)
}

fn snapshot(mut state: State, diagnostics: Vec<Diagnostic>, metadata: BTreeMap<String, String>, revision: u64) -> Result<DocxDocument> {
    let root = parse_xml(&state.source)?;
    index_docx_identities(&mut state)?;
    let editable = !diagnostics.iter().any(|d| d.severity == Severity::Warning);
    let revisions = inspect_docx_revisions(&state)?;
    let hyperlinks = inspect_docx_hyperlinks(&mut state)?;
    let page_breaks = inspect_docx_page_breaks(&mut state)?;
    let fields = scan_docx_fields(&root);
    let numbering = inspect_docx_numbering(&state)?.definitions;
    let resolver = StyleResolver::new(&state)?;
    let revision_for_run = |r: &XmlElement| revisions.ranges.iter().find(|range| r.start > range.node.start && r.end < range.node.end);
    let mut list_counts: HashMap<String, BTreeMap<u32, u32>> = HashMap::new();
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let mut paragraph_ids: HashMap<usize, String> = HashMap::new();
    for p in xml_descendants(&root).into_iter().filter(|n| is_word(n, "p")) {
        let ppr = word_child(Some(p), "pPr");
        let style_id = val(word_child(ppr, "pStyle")).map(str::to_string);
        let inherited = resolver.paragraph(style_id.as_deref());
        let pending_paragraph = revisions.ranges.iter().any(|r| r.paragraph_start == p.start);
        let all_runs: Vec<&XmlElement> = xml_descendants(p).into_iter().filter(|n| is_word(n, "r")).collect();
        let read_run = |state: &mut State, r: &XmlElement, original: bool| -> Run {
            if !state.identities.contains_key(&r.start) {
                let id = state.fresh("r~");
                state.identities.insert(r.start, id);
            }
            let id = state.identities[&r.start].clone();
            let text_node = word_child(Some(r), "t");
            let tracked = revision_for_run(r).is_some();
            let hyperlink = hyperlinks.links.iter().find(|l| l.run_ids.contains(&id));
            let text = docx_inline_text(r, original);
            // Per-run lock: typeable only when the visible text is exactly one text node.
            let texts: Vec<&XmlElement> = r.children.iter().filter(|n| is_word(n, "t")).collect();
            let source_text = if cached_text_run(r) { Some(texts.iter().map(|n| n.text.as_str()).collect::<String>()) } else if texts.len() == 1 { Some(texts[0].text.clone()) } else { None };
            let text_editable = text_node.is_some() && Some(&text) == source_text.as_ref() && !fields.runs.contains(&r.start);
            if text_editable && !tracked && !pending_paragraph {
                let t = text_node.unwrap();
                state.run_nodes.insert(id.clone(), TextNode { start: t.start, start_tag_end: t.start_tag_end, end: t.end, name: t.name.clone(), text: t.text.clone() });
            }
            let props = word_child(Some(r), "rPr");
            let style = read_docx_run_style(props);
            let resolved = resolver.run(style_id.as_deref(), val(word_child(props, "rStyle")), &style, props, &text);
            Run {
                can_edit: editable && text_editable && !tracked && !original && !pending_paragraph,
                hyperlink_id: hyperlink.map(|h| h.id.clone()),
                target: hyperlink.map(|h| h.target.clone()),
                page_breaks: page_breaks.breaks.iter().filter(|b| b.run_start == r.start).map(|b| RunPageBreak { id: b.id.clone(), offset: b.local_offset }).collect(),
                id,
                text,
                style,
                resolved_style: Some(resolved),
            }
        };
        let runs: Vec<Run> = all_runs.iter().filter(|r| revision_for_run(r).is_none_or(|x| x.revision.kind != RevisionKind::Deletion)).map(|r| read_run(&mut state, r, false)).collect();
        let original_runs: Option<Vec<Run>> = if revisions.problem.is_some() {
            None
        } else {
            Some(all_runs.iter().filter(|r| revision_for_run(r).is_none_or(|x| x.revision.kind != RevisionKind::Insertion)).map(|r| read_run(&mut state, r, true)).collect())
        };
        let spacing = word_child(ppr, "spacing");
        let num_pr = word_child(ppr, "numPr");
        let num_id = val(word_child(num_pr, "numId"));
        let ilvl = val(word_child(num_pr, "ilvl"));
        let list_level: u32 = ilvl.filter(|v| v.len() == 1 && digits(v)).and_then(|v| v.parse().ok()).unwrap_or(0);
        let definition = num_id.and_then(|n| numbering.iter().find(|(id, _)| id.as_str() == n).map(|(id, levels)| (id.clone(), levels)));
        let level = definition.as_ref().and_then(|(_, levels)| levels.get(&list_level).copied());
        let mut list_number = None;
        if let (Some((def_id, levels)), Some(level)) = (&definition, level) {
            let counters = list_counts.entry(def_id.clone()).or_default();
            let number = counters.get(&list_level).map_or(level.start, |c| c + 1);
            counters.insert(list_level, number);
            list_number = Some(number);
            // Deeper counters restart under a new shallower item unless lvlRestart says otherwise.
            let deeper: Vec<u32> = counters.keys().copied().filter(|d| *d > list_level).collect();
            for d in deeper {
                let restart = levels.get(&d).and_then(|l| l.restart);
                if restart.is_none_or(|r| r > list_level) {
                    counters.remove(&d);
                }
            }
        }
        let spacing_number = |name: &str, divisor: f64| own(spacing, name).filter(|t| digits(t)).and_then(|t| t.parse::<f64>().ok()).map(|v| v / divisor);
        let rule = own(spacing, "lineRule");
        let id = state.identities.get(&p.start).cloned().unwrap_or_default();
        paragraph_ids.insert(p.start, id.clone());
        paragraphs.push(Paragraph {
            text: runs.iter().map(|r| r.text.as_str()).collect(),
            style_id: style_id.clone(),
            alignment: val(word_child(ppr, "jc")).map(str::to_string).or(inherited.alignment.flatten()),
            spacing_before_points: spacing_number("before", 20.0).or(inherited.spacing_before_points.flatten()),
            spacing_after_points: spacing_number("after", 20.0).or(inherited.spacing_after_points.flatten()),
            line_spacing_multiple: if spacing.is_none() || rule.is_none() || rule == Some("auto") { spacing_number("line", 240.0).or(inherited.line_spacing_multiple.flatten()) } else { None },
            list_kind: level.map(|l| l.kind),
            list_level: level.map(|_| list_level),
            list_number: if level.is_some_and(|l| l.kind == ListKind::Numbered) { list_number } else { None },
            original_text: original_runs.as_ref().map(|r| r.iter().map(|x| x.text.as_str()).collect()),
            original_runs,
            revision_ids: revisions.ranges.iter().filter(|r| r.paragraph_start == p.start).map(|r| r.revision.id.clone()).collect(),
            runs,
            id,
        });
    }
    let body = word_child(Some(&root), "body").expect("body");
    let tables: Vec<Table> = body
        .children
        .iter()
        .filter(|n| is_word(n, "tbl"))
        .map(|table| Table {
            id: state.identities.get(&table.start).cloned().unwrap_or_default(),
            rows: table.children.iter().filter(|n| is_word(n, "tr")).map(|row| TableRow {
                cells: row.children.iter().filter(|n| is_word(n, "tc")).map(|cell| TableCell {
                    paragraph_ids: cell.children.iter().filter(|n| is_word(n, "p")).filter_map(|p| paragraph_ids.get(&p.start).cloned()).collect(),
                }).collect(),
            }).collect(),
        })
        .collect();
    let blocks: Vec<Block> = body
        .children
        .iter()
        .filter_map(|n| {
            let id = state.identities.get(&n.start).cloned().unwrap_or_default();
            if is_word(n, "p") { Some(Block::Paragraph(id)) } else if is_word(n, "tbl") { Some(Block::Table(id)) } else { None }
        })
        .collect();
    let comments = if revisions.problem.is_some() { inspect_docx_comments(&state)?.comments } else { inspect_docx_comments(&project_docx_revision_view(&state, true)?)?.comments };
    let images = inspect_docx_images(&state)?.images;
    let doc = RichDocument {
        format: Format::Docx,
        text: paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n"),
        original_text: if revisions.problem.is_some() { None } else { Some(paragraphs.iter().map(|p| p.original_text.clone().unwrap_or_default()).collect::<Vec<_>>().join("\n")) },
        revisions: revisions.ranges.iter().map(|r| r.revision.clone()).collect(),
        page_layout: docx_page_layout(&root),
        comments,
        styles: read_docx_styles(&state)?,
        images: images.iter().map(|i| Picture { id: i.id.clone(), paragraph_id: i.paragraph_id.clone(), width_points: i.width_points, height_points: i.height_points, alt_text: i.alt_text.clone(), content_type: i.content_type }).collect(),
        hyperlinks: hyperlinks.links.iter().map(|l| Hyperlink { id: l.id.clone(), paragraph_id: l.paragraph_id.clone(), text: l.text.clone(), target: l.target.clone(), run_ids: l.run_ids.clone() }).collect(),
        page_breaks: page_breaks.breaks.iter().map(|b| PageBreak { id: b.id.clone(), paragraph_id: b.paragraph_id.clone(), run_id: b.run_id.clone(), offset: b.offset }).collect(),
        paragraphs,
        tables,
        blocks,
        metadata,
        diagnostics,
        can_edit: editable,
        revision,
        modified: state.modified(),
    };
    Ok(DocxDocument { doc, state })
}

/// Full package preflight precedes exposure of text; no links or resources are fetched.
pub fn open_docx(input: &[u8], limits: ZipLimits) -> Result<DocxDocument> {
    let limits = resolve_zip_limits(limits)?;
    if input.len() > limits.max_archive_bytes {
        return Err(err("archive-limit", "DOCX exceeds the archive size limit."));
    }
    let original = input.to_vec();
    let entries = read_zip(&original, limits)?;
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    let name_set: HashSet<String> = names.iter().cloned().collect();
    let Some(manifest_part) = entries.iter().find(|e| e.name == "[Content_Types].xml") else {
        return Err(err("invalid-content-types", "DOCX content-types manifest is missing."));
    };
    let mut encodings: HashMap<String, XmlEncoding> = HashMap::new();
    let mut read_xml = |name: &str, bytes: &[u8]| -> Result<String> {
        let (text, encoding) = decode_docx_xml(bytes)?;
        if encoding != XmlEncoding::Utf8 {
            encodings.insert(name.to_string(), encoding);
        }
        Ok(text)
    };
    let manifest = parse_xml(&read_xml(&manifest_part.name, &manifest_part.data)?)?;
    let types = content_types(&manifest, &names)?;
    let type_of = |name: &str| types.iter().find(|(n, _)| n == name).map(|(_, t)| t.as_str());
    let mut roots: Vec<(String, XmlElement)> = Vec::new();
    let mut sources: HashMap<String, String> = HashMap::new();
    let (mut xml_characters, mut xml_nodes) = (0usize, 0usize);
    for part in entries.iter() {
        let kind = type_of(&part.name).unwrap_or("");
        let lower = part.name.to_lowercase();
        let k = kind.to_lowercase();
        if lower.ends_with(".xml") || lower.ends_with(".rels") || k.ends_with("+xml") || k.ends_with("/xml") {
            let source = read_xml(&part.name, &part.data)?;
            xml_characters += utf16_len(&source);
            if xml_characters > 16 * 1024 * 1024 {
                return Err(err("xml-limit", "DOCX exceeds the total XML size limit."));
            }
            let root = if part.name == "[Content_Types].xml" { manifest.clone() } else { parse_xml(&source)? };
            xml_nodes += xml_descendants(&root).len();
            if xml_nodes > 200_000 {
                return Err(err("xml-limit", "DOCX exceeds the total XML structure limit."));
            }
            sources.insert(part.name.clone(), source);
            roots.push((part.name.clone(), root));
        }
    }
    let root_of = |name: &str| roots.iter().find(|(n, _)| n == name).map(|(_, r)| r);
    let mut relationships: Vec<(String, Vec<Relationship>)> = Vec::new();
    for (name, root) in &roots {
        if name.ends_with(".rels") {
            relationships.push((relationship_source(name)?, parse_relationships(name, root, &name_set)?));
        }
    }
    let rels_of = |source: &str| relationships.iter().find(|(s, _)| s == source).map(|(_, r)| r);
    let main_relationships: Vec<&Relationship> = rels_of("").map_or(vec![], |r| r.iter().filter(|x| x.kind == format!("{R}/officeDocument") || x.kind == format!("{R_STRICT}/officeDocument")).collect());
    if main_relationships.len() != 1 || main_relationships[0].external {
        return Err(err("missing-document", "Package must have exactly one internal Word document relationship."));
    }
    let main_part = main_relationships[0].target.clone();
    if type_of(&main_part) != Some(MAIN_TYPE) {
        return Err(err("unsupported-document", "Only non-macro DOCX documents are supported."));
    }
    let (Some(source), Some(root)) = (sources.get(&main_part).cloned(), root_of(&main_part)) else {
        return Err(err("missing-document", "Word document body is missing or malformed."));
    };
    if !is_word(root, "document") || root.children.iter().filter(|n| is_word(n, "body")).count() != 1 {
        return Err(err("missing-document", "Word document body is missing or malformed."));
    }
    for (name, xml_root) in &roots {
        if name.ends_with(".rels") {
            continue;
        }
        let ids: HashSet<&str> = rels_of(name).map_or(HashSet::new(), |r| r.iter().map(|x| x.id.as_str()).collect());
        for node in xml_descendants(xml_root) {
            if node.attributes.iter().any(|a| (a.namespace == R || a.namespace == R_STRICT) && !ids.contains(a.value.as_str())) {
                return Err(err("invalid-relationships", &format!("Unresolved relationship reference in {name}.")));
            }
        }
    }
    let mut diagnostics = vec![Diagnostic::info(
        "limited-foundation",
        "Supported direct formatting, bounded style/theme display resolution, paragraphs, page properties and basic rectangular tables. No pagination or generic Word compatibility guarantee.",
    )];
    let entries = Arc::new(entries);
    let mut state = State {
        source: source.clone(),
        identities: BTreeMap::new(),
        next_id: 0,
        entries,
        main_part: main_part.clone(),
        part_overrides: PartMap::default(),
        deleted_parts: BTreeSet::new(),
        next_image_id: None,
        next_revision_id: None,
        original: Arc::new(original),
        original_source: Arc::new(source.clone()),
        run_nodes: HashMap::new(),
        original_run_nodes: Arc::new(HashMap::new()),
        limits,
        encodings: Arc::new(HashMap::new()),
    };
    index_docx_identities(&mut state)?;
    let hyperlinks = inspect_docx_hyperlinks(&mut state)?;
    let page_breaks = inspect_docx_page_breaks(&mut state)?;
    let media = inspect_docx_images(&state)?;
    let safe = safe_drawings(&state, root)?;
    let main = |d: Diagnostic| d.with_part(main_part.clone());
    if let Some(unsupported) = unsupported_markup(root, &safe) {
        diagnostics.push(main(Diagnostic::warning("unsupported-markup", format!("Read-only: {unsupported} contains markup outside the safe text-editing subset."))));
    }
    if let Some(p) = media.problem {
        diagnostics.push(main(Diagnostic::warning("unsupported-image", format!("Read-only: {p}"))));
    }
    if let Some(p) = hyperlinks.problem {
        diagnostics.push(main(Diagnostic::warning("unsupported-hyperlink", format!("Read-only: {p}"))));
    }
    if let Some(p) = page_breaks.problem {
        diagnostics.push(main(Diagnostic::warning("unsupported-page-break", format!("Read-only: {p}"))));
    }
    for (name, kind) in &types {
        let k = kind.to_lowercase();
        let n = name.to_lowercase();
        let vba = n.split('/').next_back().is_some_and(|f| f.starts_with("vbaproject."));
        if k.contains("macro") || k.contains("vba") || k.contains("oleobject") || k.contains("digital-signature") || n.starts_with("_xmlsignatures/") || vba {
            diagnostics.push(Diagnostic::warning("active-or-signed-content", "Read-only: package contains executable, embedded or signed content.").with_part(name.clone()));
        }
    }
    // Only dependencies the editor never rewrites are eligible for edits.
    let mut safe_relationships: HashSet<String> = HashSet::new();
    for ns in [R, R_STRICT] {
        for kind in SAFE_OFFICE_DEPENDENCIES {
            safe_relationships.insert(format!("{ns}/{kind}"));
        }
    }
    for s in SAFE_EXTENSION_DEPENDENCIES {
        safe_relationships.insert(s.to_string());
    }
    safe_relationships.insert(format!("{REL}/metadata/core-properties"));
    safe_relationships.insert(format!("{REL}/metadata/thumbnail"));
    for (part, rels) in &relationships {
        for rel in rels {
            let kind = &rel.kind[rel.kind.rfind('/').map_or(0, |i| i + 1)..];
            // A hyperlink destination is preserved verbatim, never fetched.
            if rel.external && [R, R_STRICT].iter().any(|ns| rel.kind == format!("{ns}/hyperlink")) && preservable_docx_hyperlink_target(Some(&rel.target)) {
                continue;
            }
            if (kind == "footnotes" || kind == "endnotes") && !rel.external && root_of(&rel.target).is_some_and(|r| is_separator_only_notes(r, kind)) {
                continue;
            }
            let part_name = if part.is_empty() { "_rels/.rels".to_string() } else { part.clone() };
            if rel.external || !safe_relationships.contains(&rel.kind) {
                diagnostics.push(
                    if rel.external {
                        Diagnostic::warning("external-relationship", "Read-only: package contains an external relationship; it was not fetched.")
                    } else {
                        Diagnostic::warning("unsupported-dependency", format!("Read-only: {kind} dependencies are not supported for safe editing."))
                    }
                    .with_part(part_name),
                );
            } else if !BINARY_DEPENDENCIES.contains(&kind) && root_of(&rel.target).is_none() {
                diagnostics.push(Diagnostic::warning("opaque-formatting-dependency", "Read-only: a formatting or settings dependency was not inspectable as declared XML.").with_part(rel.target.clone()));
            } else if (kind == "header" || kind == "footer") && root_of(&rel.target).is_some_and(has_story_review_state) {
                diagnostics.push(Diagnostic::warning("unsupported-revisions", format!("Read-only: the {kind} contains tracked changes or comment anchors that this editor cannot show.")).with_part(rel.target.clone()));
            }
        }
    }
    if relationships.iter().flat_map(|(_, r)| r).any(|r| !r.external && (r.kind.ends_with("/header") || r.kind.ends_with("/footer"))) {
        diagnostics.push(Diagnostic::info("unrendered-header-footer", "Headers and footers are preserved unchanged but are not shown, edited or printed here."));
    }
    // Protection and tracked-revision settings are honored even without ranges.
    for (part, xml_root) in &roots {
        if xml_descendants(xml_root).iter().any(|n| any_word(n) && ["documentProtection", "writeProtection", "trackRevisions"].contains(&n.local_name.as_str())) {
            diagnostics.push(Diagnostic::warning("protected-or-review-document", "Read-only: document protection or tracked-revision settings require a fuller engine.").with_part(part.clone()));
        }
    }
    let mut metadata = BTreeMap::new();
    let core_rel = rels_of("").and_then(|r| r.iter().find(|x| x.kind == format!("{REL}/metadata/core-properties") && !x.external));
    if let Some(core) = core_rel.and_then(|c| root_of(&c.target)) {
        let namespaces = ["http://purl.org/dc/elements/1.1/", "http://purl.org/dc/terms/", "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"];
        for node in &core.children {
            if namespaces.contains(&node.namespace.as_str()) && node.children.is_empty() {
                metadata.insert(node.local_name.clone(), node.text.clone());
            }
        }
    }
    state.encodings = Arc::new(encodings);
    index_docx_identities(&mut state)?;
    let revisions = inspect_docx_revisions(&state)?;
    if let Some(p) = revisions.problem {
        diagnostics.push(Diagnostic::warning("unsupported-revisions", format!("Read-only: {p}")));
    }
    let comment_problem = if revisions.problem.is_some() { inspect_docx_comments(&state)?.problem } else { inspect_docx_comments(&project_docx_revision_view(&state, true)?)?.problem };
    if let Some(p) = comment_problem {
        diagnostics.push(Diagnostic::warning("unsupported-comments", if p.starts_with("Read-only:") { p.to_string() } else { format!("Read-only: {p}") }));
    }
    let numbering = inspect_docx_numbering(&state)?;
    let unresolved = xml_descendants(root).iter().filter(|n| is_word(n, "numPr")).any(|n| {
        let definition = numbering.definitions.iter().find(|(id, _)| Some(id.as_str()) == val(word_child(Some(n), "numId")));
        let ilvl = val(word_child(Some(n), "ilvl")).unwrap_or("0");
        definition.is_none() || !(ilvl.len() == 1 && digits(ilvl)) || !definition.unwrap().1.contains_key(&ilvl.parse::<u32>().unwrap_or(99))
    });
    if numbering.problem.is_some() || unresolved {
        diagnostics.push(Diagnostic::warning("unsupported-numbering", format!("Read-only: {}", numbering.problem.unwrap_or("Paragraph numbering is unresolved or outside the supported levels."))));
    }
    let document = snapshot(state, diagnostics, metadata, 0)?;
    let mut originals = HashMap::new();
    for (id, node) in &document.state.run_nodes {
        originals.insert(id.clone(), (node.text.clone(), source[node.start..node.end].to_string()));
    }
    let mut document = document;
    document.state.original_run_nodes = Arc::new(originals);
    Ok(document)
}

fn require_editable(document: &DocxDocument) -> Result<()> {
    if !document.can_edit {
        return Err(err("read-only", "This package cannot be safely edited by the current engine."));
    }
    Ok(())
}

/// Edits are atomic, snapshot-local and only target supported run ids.
pub fn replace_docx_text(document: &DocxDocument, edits: &[TextEdit]) -> Result<DocxDocument> {
    require_editable(document)?;
    let ids: HashSet<&str> = edits.iter().map(|e| e.run_id.as_str()).collect();
    if ids.len() != edits.len() || edits.iter().any(|e| !document.state.run_nodes.contains_key(&e.run_id)) {
        return Err(err("invalid-edit", "Unknown or duplicate run ID."));
    }
    let current: HashMap<&str, &str> = document.paragraphs.iter().flat_map(|p| p.runs.iter().map(|r| (r.id.as_str(), r.text.as_str()))).collect();
    if edits.iter().all(|e| current.get(e.run_id.as_str()) == Some(&e.text.as_str())) {
        return Ok(document.clone());
    }
    // Only the edited paragraphs' proofing and page caches are invalidated.
    let state = &document.state;
    let root = parse_xml(&state.source)?;
    let scope: Vec<(usize, usize)> = xml_descendants(&root)
        .into_iter()
        .filter(|p| is_word(p, "p") && edits.iter().any(|e| { let n = &state.run_nodes[&e.run_id]; n.start > p.start && n.end < p.end }))
        .map(|p| (p.start, p.end))
        .collect();
    let invalidated = invalidate_docx_derived(state, true, Some(&scope))?;
    // Derived page markers may have split a logical run; re-index text targets.
    let mut cleared = invalidated;
    cleared.run_nodes = HashMap::new();
    let refreshed = snapshot(cleared, document.diagnostics.clone(), document.metadata.clone(), document.revision)?;
    let state = refreshed.state;
    let mut patches = Vec::new();
    for edit in edits {
        let Some(node) = state.run_nodes.get(&edit.run_id) else { return Err(err("invalid-edit", "Unknown or duplicate run ID.")) };
        if edit.text.contains(['\t', '\n']) {
            return Err(err("unsupported-edit", "Run replacement cannot insert tabs or paragraph breaks."));
        }
        escape_xml_text(&edit.text)?;
        let original = state.original_run_nodes.get(&edit.run_id);
        let xml = match original {
            Some((text, xml)) if *text == edit.text => xml.clone(),
            _ => format!("{}{}</{}>", preserve_space(&state.source[node.start..node.start_tag_end]), escape_xml_text(&edit.text)?, node.name),
        };
        patches.push(Patch::new(node.start, node.end, xml));
    }
    let mut next = patch_docx_source(&state, patches)?;
    if next.source.len() > state.limits.max_entry_bytes {
        return Err(err("edit-limit", "Text edits exceed the document-part size limit."));
    }
    next.run_nodes = HashMap::new();
    snapshot(next, document.diagnostics.clone(), document.metadata.clone(), document.revision + 1)
}

/// The document and caret after a range edit.
#[derive(Clone, Debug)]
pub struct RangeEdit {
    pub document: DocxDocument,
    pub selection: TextRange,
}

/// Atomic source-preserving split, join or range replacement with a mapped caret.
pub fn replace_docx_range(document: &DocxDocument, range: &TextRange, text: &str) -> Result<RangeEdit> {
    require_editable(document)?;
    if utf16_len(text) > 200_000 || text.contains(['\r', '\t']) {
        return Err(err("invalid-edit", "Range replacement requires LF-normalized text without tabs."));
    }
    escape_xml_text(text)?;
    let (start, end) = structure::normalize_docx_range(&document.paragraphs, range)?;
    let first = document.paragraphs.iter().position(|p| p.id == start.paragraph_id).unwrap();
    let last = document.paragraphs.iter().position(|p| p.id == end.paragraph_id).unwrap();
    let count = last + 1 - first;
    let selected: Vec<&str> = document.paragraphs[first..=last]
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let a = if i == 0 { start.offset } else { 0 };
            let b = if i == count - 1 { end.offset } else { p.text.len() };
            &p.text[a..b.max(a)]
        })
        .collect();
    if selected.join("\n") == text {
        return Ok(RangeEdit { document: document.clone(), selection: TextRange { anchor: end.clone(), focus: end } });
    }
    let prepared = invalidate_docx_derived(&document.state, true, None)?;
    let result = structure::replace_docx_source_range(&prepared, &start, &end, text)?;
    if result.state.source.len() > prepared.limits.max_entry_bytes {
        return Err(err("edit-limit", "Range edit exceeds the document-part size limit."));
    }
    let mut candidate = result.state;
    candidate.run_nodes = HashMap::new();
    let root = parse_xml(&candidate.source)?;
    let safe = safe_drawings(&candidate, &root)?;
    if let Some(u) = unsupported_markup(&root, &safe) {
        return Err(err("unsupported-edit", &format!("Range edit produced unsupported markup: {u}.")));
    }
    let next = snapshot(candidate, document.diagnostics.clone(), document.metadata.clone(), document.revision + 1)?;
    let position = TextPosition { paragraph_id: result.paragraph_id, offset: result.offset };
    Ok(RangeEdit { document: next, selection: TextRange { anchor: position.clone(), focus: position } })
}

fn find_paragraph<'a>(state: &State, root: &'a XmlElement, id: &str) -> Option<&'a XmlElement> {
    xml_descendants(root).into_iter().find(|n| is_word(n, "p") && state.identities.get(&n.start).is_some_and(|x| x == id))
}

/// Atomic rich operations; input snapshots remain usable as undo history.
pub fn apply_docx_operations(document: &DocxDocument, operations: &[Operation]) -> Result<DocxDocument> {
    require_editable(document)?;
    if operations.len() > 1000 {
        return Err(err("invalid-edit", "Invalid operation batch."));
    }
    let limits = document.state.limits;
    let mut next = document.state.clone();
    for operation in operations {
        let before = next.clone();
        let name = operation.name();
        let text_change = ["replace-paragraph", "delete-paragraph", "insert-paragraph", "insert-table", "delete-table", "track-paragraph-text", "accept-revision", "reject-revision", "accept-all-revisions", "reject-all-revisions"].contains(&name);
        next = invalidate_docx_derived(&next, text_change, None)?;
        let prepared_source = next.source.clone();
        let paragraph_id = match operation {
            Operation::ReplaceParagraph { paragraph_id, .. } | Operation::DeleteParagraph { paragraph_id } | Operation::TrackParagraphText { paragraph_id, .. } | Operation::FormatRange { paragraph_id, .. } => Some(paragraph_id.as_str()),
            _ => None,
        };
        if matches!(operation, Operation::ReplaceParagraph { .. } | Operation::DeleteParagraph { .. } | Operation::TrackParagraphText { .. }) {
            let root = parse_xml(&next.source)?;
            if let Some(paragraph) = find_paragraph(&next, &root, paragraph_id.unwrap())
                && (scan_docx_fields(&root).paragraphs.contains(&paragraph.start) || inline_words(paragraph).iter().any(|n| OPAQUE_INLINE.contains(&n.local_name.as_str())))
            {
                return Err(err("unsupported-inline-content", "Remove hyperlinks, bookmarks, fields, tabs, line breaks, horizontal rules and explicit page breaks before replacing, deleting or tracking all paragraph text."));
            }
        }
        if let Operation::InsertParagraph { after_paragraph_id: InsertAt::After(id), .. } = operation {
            let root = parse_xml(&next.source)?;
            if let Some(paragraph) = find_paragraph(&next, &root, id)
                && scan_docx_fields(&root).open_after.contains(&paragraph.start)
            {
                return Err(err("unsupported-inline-content", "Paragraphs cannot be inserted inside a field result such as a table of contents."));
            }
        }
        if let Operation::DeleteTable { table_id } = operation {
            let root = parse_xml(&next.source)?;
            if let Some(table) = xml_descendants(&root).into_iter().find(|n| is_word(n, "tbl") && next.identities.get(&n.start) == Some(table_id))
                && inline_words(table).iter().any(|n| ["hyperlink", "br", "bookmarkStart", "bookmarkEnd", "fldChar", "instrText"].contains(&n.local_name.as_str()))
            {
                return Err(err("unsupported-inline-content", "Remove table hyperlinks, bookmarks, fields and explicit page breaks before deleting the table."));
            }
        }
        let pending = inspect_docx_revisions(&next)?.ranges;
        let resolves = ["track-paragraph-text", "accept-revision", "reject-revision", "accept-all-revisions", "reject-all-revisions"].contains(&name);
        if !resolves && !pending.is_empty() {
            if matches!(operation, Operation::AddComment { .. } | Operation::DeleteComment { .. }) {
                return Err(err("unsupported-revision", "Resolve text revisions before changing comment annotations."));
            }
            if matches!(operation, Operation::ReplaceParagraph { .. } | Operation::DeleteParagraph { .. } | Operation::FormatRange { .. }) && pending.iter().any(|r| Some(r.revision.paragraph_id.as_str()) == paragraph_id) {
                return Err(err("unsupported-revision", "Resolve paragraph revisions before an untracked replacement, deletion or inline format edit."));
            }
            if let Operation::FormatRun { run_id, .. } = operation {
                let root = parse_xml(&next.source)?;
                if let Some(run) = xml_descendants(&root).into_iter().find(|n| is_word(n, "r") && next.identities.get(&n.start) == Some(run_id))
                    && pending.iter().any(|r| run.start > r.paragraph_start && run.end < r.paragraph_end)
                {
                    return Err(err("unsupported-revision", "Resolve paragraph revisions before changing run formatting."));
                }
            }
            if let Operation::DeleteTable { table_id } = operation {
                let root = parse_xml(&next.source)?;
                if let Some(table) = xml_descendants(&root).into_iter().find(|n| is_word(n, "tbl") && next.identities.get(&n.start) == Some(table_id))
                    && pending.iter().any(|r| r.paragraph_start > table.start && r.paragraph_end < table.end)
                {
                    return Err(err("unsupported-revision", "Resolve table text revisions before deleting the table."));
                }
            }
        }
        if let Operation::FormatParagraph { format: ParagraphFormat { style_id: Some(Some(id)), .. }, .. } = operation {
            next = ensure_docx_named_style(&next, id)?;
        }
        next = match operation {
            _ if resolves => apply_docx_revision_operation(&next, operation)?,
            Operation::AddComment { .. } | Operation::DeleteComment { .. } => apply_docx_comment_operation(&next, operation)?,
            Operation::SetList { paragraph_id, kind } => set_docx_list(&next, paragraph_id, *kind)?,
            Operation::InsertImage(input) => insert_docx_image(&next, input)?,
            Operation::DeleteImage { image_id } => delete_docx_image(&next, image_id)?,
            Operation::FormatRange { paragraph_id, start, end, style } => format_docx_text_range(&next, paragraph_id, *start, *end, style)?,
            Operation::SetHyperlink { paragraph_id, start, end, target } => set_docx_hyperlink(&next, paragraph_id, *start, *end, target)?,
            Operation::UpdateHyperlink { hyperlink_id, target } => update_docx_hyperlink(&next, hyperlink_id, target)?,
            Operation::RemoveHyperlink { hyperlink_id } => remove_docx_hyperlink(&next, hyperlink_id)?,
            Operation::InsertPageBreak { paragraph_id, offset } => insert_docx_page_break(&next, paragraph_id, *offset)?,
            Operation::RemovePageBreak { page_break_id } => remove_docx_page_break(&next, page_break_id)?,
            _ => apply_docx_xml_operation(&next, operation)?,
        };
        // No mutation means no invalidation of the original analysis caches.
        if next.source == prepared_source && next.part_overrides == before.part_overrides && next.deleted_parts == before.deleted_parts {
            next = before;
        }
        if next.source.len() > limits.max_entry_bytes {
            return Err(err("edit-limit", "Document edits exceed the part size limit."));
        }
        if next.part_overrides.iter().any(|(_, d)| d.len() > limits.max_entry_bytes) {
            return Err(err("edit-limit", "Document part edits exceed the size limit."));
        }
        let media = inspect_docx_images(&next)?;
        if let Some(p) = media.problem {
            return Err(err("unsupported-image", p));
        }
        if let Some(p) = inspect_docx_hyperlinks(&mut next)?.problem {
            return Err(err("unsupported-hyperlink", p));
        }
        if let Some(p) = inspect_docx_page_breaks(&mut next)?.problem {
            return Err(err("unsupported-page-break", p));
        }
        let root = parse_xml(&next.source)?;
        let mut safe: Vec<usize> = media.images.iter().map(|i| i.drawing_start).collect();
        safe.extend(safe_horizontal_rules(&root));
        if let Some(u) = unsupported_markup(&root, &safe) {
            return Err(err("unsupported-edit", &format!("Operation produced unsupported markup: {u}.")));
        }
        if let Some(p) = inspect_docx_revisions(&next)?.problem {
            return Err(err("unsupported-revisions", p));
        }
        if let Some(p) = inspect_docx_comments(&project_docx_revision_view(&next, true)?)?.problem {
            return Err(err("unsupported-comments", p));
        }
    }
    next.run_nodes = HashMap::new();
    snapshot(next, document.diagnostics.clone(), document.metadata.clone(), document.revision + 1)
}

/// Untouched (or reverted) snapshots return an owned byte-identical original.
pub fn export_docx(document: &DocxDocument) -> Result<Vec<u8>> {
    let state = &document.state;
    if !state.modified() {
        return Ok(state.original.to_vec());
    }
    if !document.can_edit {
        return Err(err("read-only", "Cannot export edits to an unsupported package."));
    }
    // Rewritten XML parts keep the byte encoding (and BOM) they arrived with.
    let encoding = |name: &str| state.encodings.get(name).copied().unwrap_or(XmlEncoding::Utf8);
    let entries: Vec<ZipEntry> = state
        .entries_out()
        .into_iter()
        .map(|part| {
            if part.name == state.main_part {
                ZipEntry { data: encode_docx_xml(&state.source, encoding(&part.name)), name: part.name }
            } else if state.encodings.contains_key(&part.name) && state.part_overrides.has(&part.name) {
                let text = String::from_utf8_lossy(&part.data).to_string();
                ZipEntry { data: encode_docx_xml(&text, encoding(&part.name)), name: part.name }
            } else {
                part
            }
        })
        .collect();
    let bytes = write_zip(&entries, state.limits)?;
    // Re-read output before releasing it; the same guarantees apply to output.
    open_docx(&bytes, state.limits)?;
    Ok(bytes)
}

/// An owned copy of a picture's bytes for the host to decode; never a remote URL.
pub fn get_docx_image_bytes(document: &DocxDocument, image_id: &str) -> Result<Vec<u8>> {
    let images = inspect_docx_images(&document.state)?.images;
    let image = images.iter().find(|i| i.id == image_id).ok_or_else(|| err("invalid-image", "Unknown image identity."))?;
    Ok(docx_part(&document.state, &image.part_name).unwrap_or_default().to_vec())
}

/// A minimal interoperable package authored from the public OPC/WordML vocabulary.
pub fn create_docx(text: &str) -> Result<DocxDocument> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut paragraphs = String::new();
    for line in normalized.split('\n') {
        if line.contains('\t') {
            return Err(err("unsupported-edit", "New plain documents do not support tabs yet."));
        }
        paragraphs.push_str(&format!("<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>", escape_xml_text(line)?));
    }
    let parts = [
        ("[Content_Types].xml", format!("<Types xmlns=\"{CT}\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"{MAIN_TYPE}\"/></Types>")),
        ("_rels/.rels", format!("<Relationships xmlns=\"{REL}\"><Relationship Id=\"rId1\" Type=\"{R}/officeDocument\" Target=\"word/document.xml\"/></Relationships>")),
        ("word/document.xml", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"{W}\"><w:body>{paragraphs}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>")),
    ];
    let entries: Vec<ZipEntry> = parts.into_iter().map(|(n, s)| ZipEntry::new(n, s)).collect();
    open_docx(&write_zip(&entries, DEFAULT_ZIP_LIMITS)?, DEFAULT_ZIP_LIMITS)
}

#[cfg(test)]
mod theme_tests;

#[cfg(test)]
impl State {
    /// A parts-only state for resolver unit tests (no main document parsing).
    pub(crate) fn parts_only(entries: Vec<ZipEntry>, main_part: &str) -> State {
        State {
            source: String::new(),
            identities: BTreeMap::new(),
            next_id: 0,
            entries: Arc::new(entries),
            main_part: main_part.into(),
            part_overrides: PartMap::default(),
            deleted_parts: BTreeSet::new(),
            next_image_id: None,
            next_revision_id: None,
            original: Arc::new(vec![]),
            original_source: Arc::new(String::new()),
            run_nodes: HashMap::new(),
            original_run_nodes: Arc::new(HashMap::new()),
            limits: DEFAULT_ZIP_LIMITS,
            encodings: Arc::new(HashMap::new()),
        }
    }
}
