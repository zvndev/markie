//! Package parts, relationships, named styles and the display-only theme subset.
//! Ported from `docx-parts.ts` and `docx-theme.ts` (MS-OI29500 2.1.72 HSL
//! transforms with our deterministic rounding; 2.1.88 font slot cascade).

use super::State;
use super::edit::{WORD_NAMESPACES, decode_docx_xml, is_word, own, val, word_child};
use crate::error::{OfficeError, Result};
use crate::model::{NamedStyle, ParagraphFormat, RunStyle};
use crate::xml::{XmlElement, parse_xml, xml_attribute, xml_attribute_text};
use std::cell::RefCell;
use std::collections::HashMap;

pub(crate) const DOCX_REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
pub(crate) const DOCX_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub(crate) const DOCX_R_STRICT: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const TYPES: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const DRAWING: [&str; 2] = ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"];

/// Part bytes, honoring overrides and deletions.
pub(crate) fn docx_part<'a>(state: &'a State, name: &str) -> Option<&'a [u8]> {
    if state.deleted_parts.contains(name) {
        return None;
    }
    if let Some(data) = state.part_overrides.get(name) {
        return Some(data);
    }
    state.entries.iter().find(|p| p.name == name).map(|p| p.data.as_slice())
}

/// Overrides are always held as UTF-8; export re-encodes a rewritten part.
pub(crate) fn docx_part_source(state: &State, name: &str) -> Result<Option<String>> {
    if state.deleted_parts.contains(name) {
        return Ok(None);
    }
    if let Some(data) = state.part_overrides.get(name) {
        return Ok(Some(String::from_utf8(data.to_vec()).map_err(|_| OfficeError::docx("unsupported-encoding", "Override is not UTF-8."))?));
    }
    match state.entries.iter().find(|p| p.name == name) {
        Some(p) => Ok(Some(decode_docx_xml(&p.data)?.0)),
        None => Ok(None),
    }
}

pub(crate) fn docx_relationships_part(main_part: &str) -> String {
    let slash = main_part.rfind('/').map_or(0, |s| s + 1);
    format!("{}_rels/{}.rels", &main_part[..slash], &main_part[slash..])
}

pub(crate) fn append_docx_xml(source: &str, content: &str) -> Result<String> {
    let root = parse_xml(source)?;
    if root.self_closing() {
        let opening = &source[root.start..root.start_tag_end];
        let opening = opening.strip_suffix("/>").map_or(opening.to_string(), |o| format!("{o}>"));
        return Ok(format!("{}{opening}{content}</{}>{}", &source[..root.start], root.name, &source[root.end..]));
    }
    Ok(format!("{}{content}{}", &source[..root.end_tag_start], &source[root.end_tag_start..]))
}

/// A newly created main relationship part needs its own content-type declaration.
pub(crate) fn declare_docx_relationship_part(manifest: &str, name: &str) -> Result<String> {
    let kind = "application/vnd.openxmlformats-package.relationships+xml";
    let root = parse_xml(manifest)?;
    let declared = root.children.iter().any(|n| {
        (n.local_name == "Override" && n.plain("PartName") == Some(&format!("/{name}")) && n.plain("ContentType") == Some(kind))
            || (n.local_name == "Default" && n.plain("Extension").is_some_and(|e| e.eq_ignore_ascii_case("rels")) && n.plain("ContentType") == Some(kind))
    });
    if declared {
        return Ok(manifest.to_string());
    }
    append_docx_xml(manifest, &format!("<Override xmlns=\"{TYPES}\" PartName=\"/{}\" ContentType=\"{kind}\"/>", xml_attribute_text(name)?))
}

pub(crate) fn related_docx_part(state: &State, kind: &str) -> Result<Option<String>> {
    let Some(source) = docx_part_source(state, &docx_relationships_part(&state.main_part))? else { return Ok(None) };
    let root = parse_xml(&source)?;
    let node = root.children.iter().find(|n| [DOCX_R, DOCX_R_STRICT].iter().any(|r| n.plain("Type") == Some(&format!("{r}/{kind}"))));
    let Some(node) = node else { return Ok(None) };
    let target = node.plain("Target").unwrap_or("");
    if let Some(abs) = target.strip_prefix('/') {
        return Ok(Some(abs.to_string()));
    }
    Ok(Some(resolve_relative(&state.main_part, target)))
}

/// Resolves a relative target against a source part (`..` pops).
pub(crate) fn resolve_relative(source_part: &str, target: &str) -> String {
    let mut segments: Vec<&str> = if target.starts_with('/') { vec![] } else { source_part.split('/').collect() };
    if !target.starts_with('/') {
        segments.pop();
    }
    for segment in target.trim_start_matches('/').split('/') {
        if segment == ".." {
            segments.pop();
        } else {
            segments.push(segment);
        }
    }
    segments.join("/")
}

pub(crate) fn ensure_docx_part(state: &State, kind: &str, content_type: &str, content: &str, namespace: &str) -> Result<(State, String)> {
    if let Some(existing) = related_docx_part(state, kind)? {
        return Ok((state.clone(), existing));
    }
    let directory = &state.main_part[..state.main_part.rfind('/').map_or(0, |s| s + 1)];
    let mut name = format!("{directory}{kind}.xml");
    let mut n = 1;
    while docx_part(state, &name).is_some() {
        name = format!("{directory}markie-{kind}-{n}.xml");
        n += 1;
    }
    let rel_name = docx_relationships_part(&state.main_part);
    let rel_source = docx_part_source(state, &rel_name)?.unwrap_or_else(|| format!("<Relationships xmlns=\"{DOCX_REL}\"/>"));
    let ids: Vec<String> = parse_xml(&rel_source)?.children.iter().filter_map(|n| n.plain("Id").map(str::to_string)).collect();
    let mut id = "rIdMarkie1".to_string();
    let mut k = 2;
    while ids.contains(&id) {
        id = format!("rIdMarkie{k}");
        k += 1;
    }
    let r = if namespace.contains("purl.oclc.org") { DOCX_R_STRICT } else { DOCX_R };
    let mut next = state.clone();
    next.part_overrides.set(&name, content.as_bytes().to_vec());
    next.part_overrides.set(
        &rel_name,
        append_docx_xml(&rel_source, &format!("<Relationship xmlns=\"{DOCX_REL}\" Id=\"{id}\" Type=\"{r}/{kind}\" Target=\"{}\"/>", &name[directory.len()..]))?
            .into_bytes(),
    );
    let manifest = docx_part_source(state, "[Content_Types].xml")?.unwrap_or_default();
    let with_part = append_docx_xml(&manifest, &format!("<Override xmlns=\"{TYPES}\" PartName=\"/{}\" ContentType=\"{content_type}\"/>", xml_attribute_text(&name)?))?;
    next.part_overrides.set("[Content_Types].xml", declare_docx_relationship_part(&with_part, &rel_name)?.into_bytes());
    Ok((next, name))
}

pub(crate) struct BuiltinStyle {
    pub name: &'static str,
    pub size: Option<u32>,
    pub bold: bool,
}

pub(crate) fn builtin_style(id: &str) -> Option<BuiltinStyle> {
    Some(match id {
        "Normal" => BuiltinStyle { name: "Normal", size: None, bold: false },
        "Title" => BuiltinStyle { name: "Title", size: Some(56), bold: false },
        "Subtitle" => BuiltinStyle { name: "Subtitle", size: Some(32), bold: false },
        "Heading1" => BuiltinStyle { name: "Heading 1", size: Some(40), bold: true },
        "Heading2" => BuiltinStyle { name: "Heading 2", size: Some(32), bold: true },
        "Heading3" => BuiltinStyle { name: "Heading 3", size: Some(28), bold: true },
        _ => return None,
    })
}

pub(crate) fn read_docx_styles(state: &State) -> Result<Vec<NamedStyle>> {
    let Some(name) = related_docx_part(state, "styles")? else { return Ok(vec![]) };
    let Some(source) = docx_part_source(state, &name)? else { return Ok(vec![]) };
    let root = parse_xml(&source)?;
    Ok(root
        .children
        .iter()
        .filter(|n| is_word(n, "style") && own(Some(n), "type") == Some("paragraph"))
        .map(|n| NamedStyle {
            id: own(Some(n), "styleId").unwrap_or("").to_string(),
            name: xml_attribute(n.children.iter().find(|c| is_word(c, "name")).unwrap_or(n), "val", &n.namespace).unwrap_or("").to_string(),
        })
        .filter(|s| !s.id.is_empty())
        .collect())
}

/// Bounded resolution of the supported ECMA-376 run properties.
pub(crate) fn read_docx_run_style(props: Option<&XmlElement>) -> RunStyle {
    let on_off = |name: &str| word_child(props, name).map(|p| !["false", "0", "off"].contains(&val(Some(p)).unwrap_or("true")));
    let size = val(word_child(props, "sz"));
    let font = word_child(props, "rFonts");
    let underline = word_child(props, "u");
    RunStyle {
        bold: on_off("b"),
        italic: on_off("i"),
        underline: underline.map(|u| val(Some(u)).unwrap_or("single").to_string()),
        color: val(word_child(props, "color")).map(str::to_string),
        font_family: own(font, "ascii").or_else(|| own(font, "hAnsi")).map(str::to_string),
        font_size_points: size.filter(|s| super::edit::digits(s)).and_then(|s| s.parse::<f64>().ok()).map(|v| v / 2.0),
    }
}

/// Paragraph properties; `line_spacing_multiple: Some(None)` is the TS `null`
/// (an explicit non-auto line rule that masks inherited multiples).
fn read_paragraph_style(props: Option<&XmlElement>) -> ParagraphFormat {
    let spacing = word_child(props, "spacing");
    let amount = |name: &str, divisor: f64| own(spacing, name).filter(|t| super::edit::digits(t)).and_then(|t| t.parse::<f64>().ok()).map(|v| v / divisor);
    let rule = own(spacing, "lineRule");
    ParagraphFormat {
        style_id: None,
        alignment: val(word_child(props, "jc")).map(|a| Some(a.to_string())),
        spacing_before_points: amount("before", 20.0).map(Some),
        spacing_after_points: amount("after", 20.0).map(Some),
        line_spacing_multiple: if rule.is_none() || rule == Some("auto") { amount("line", 240.0).map(Some) } else { Some(None) },
    }
}

fn assign_paragraph(target: &mut ParagraphFormat, layer: &ParagraphFormat) {
    if layer.alignment.is_some() {
        target.alignment = layer.alignment.clone();
    }
    if layer.spacing_before_points.is_some() {
        target.spacing_before_points = layer.spacing_before_points;
    }
    if layer.spacing_after_points.is_some() {
        target.spacing_after_points = layer.spacing_after_points;
    }
    if layer.line_spacing_multiple.is_some() {
        target.line_spacing_multiple = layer.line_spacing_multiple;
    }
}

pub(crate) struct StyleResolver {
    root: Option<XmlElement>,
    themes: ThemeResolver,
    default_paragraph: Option<String>,
    default_character: Option<String>,
    cache: RefCell<HashMap<String, Vec<usize>>>,
}

impl StyleResolver {
    pub(crate) fn new(state: &State) -> Result<Self> {
        let themes = ThemeResolver::new(state);
        let name = related_docx_part(state, "styles")?;
        let source = match name {
            Some(n) => docx_part_source(state, &n)?,
            None => None,
        };
        let root = source.map(|s| parse_xml(&s)).transpose()?;
        let mut r = StyleResolver { root, themes, default_paragraph: None, default_character: None, cache: RefCell::new(HashMap::new()) };
        r.default_paragraph = r.default_id("paragraph");
        r.default_character = r.default_id("character");
        Ok(r)
    }
    fn definitions(&self) -> Vec<&XmlElement> {
        self.root.as_ref().map_or(vec![], |r| r.children.iter().filter(|n| is_word(n, "style")).collect())
    }
    fn default_id(&self, kind: &str) -> Option<String> {
        self.definitions()
            .into_iter()
            .find(|n| own(Some(n), "type") == Some(kind) && ["1", "true", "on"].contains(&own(Some(n), "default").unwrap_or("")))
            .and_then(|n| own(Some(n), "styleId").map(str::to_string))
    }
    fn defaults(&self) -> Option<&XmlElement> {
        word_child(self.root.as_ref(), "docDefaults")
    }
    /// Indices into `definitions()`, base first. Cycles and very deep chains stop.
    fn chain(&self, kind: &str, id: Option<&str>) -> Vec<usize> {
        let key = format!("{kind}:{}", id.unwrap_or(""));
        if let Some(c) = self.cache.borrow().get(&key) {
            return c.clone();
        }
        let defs = self.definitions();
        let mut nodes: Vec<usize> = Vec::new();
        let mut visited: Vec<String> = Vec::new();
        let mut next = id.map(str::to_string);
        while let Some(n) = next.filter(|n| !n.is_empty()) {
            if visited.contains(&n) || nodes.len() >= 128 {
                break;
            }
            visited.push(n.clone());
            // Later definitions with the same key win, as a JavaScript Map built from the list.
            let Some(index) = defs.iter().rposition(|d| own(Some(d), "type") == Some(kind) && own(Some(d), "styleId") == Some(n.as_str())) else { break };
            nodes.insert(0, index);
            next = val(word_child(Some(defs[index]), "basedOn")).map(str::to_string);
        }
        self.cache.borrow_mut().insert(key, nodes.clone());
        nodes
    }

    pub(crate) fn paragraph(&self, id: Option<&str>) -> ParagraphFormat {
        let base = read_paragraph_style(word_child(word_child(self.defaults(), "pPrDefault"), "pPr"));
        let mut result = base;
        let defs = self.definitions();
        let id = id.map(str::to_string).or_else(|| self.default_paragraph.clone());
        for index in self.chain("paragraph", id.as_deref()) {
            assign_paragraph(&mut result, &read_paragraph_style(word_child(Some(defs[index]), "pPr")));
        }
        result
    }

    pub(crate) fn run(&self, paragraph_id: Option<&str>, character_id: Option<&str>, direct: &RunStyle, direct_props: Option<&XmlElement>, text: &str) -> RunStyle {
        let default_props = word_child(word_child(self.defaults(), "rPrDefault"), "rPr");
        let mut result = read_docx_run_style(default_props);
        let mut layers: Vec<Option<&XmlElement>> = vec![default_props];
        let defs = self.definitions();
        let paragraph_id = paragraph_id.map(str::to_string).or_else(|| self.default_paragraph.clone());
        let character_id = character_id.map(str::to_string).or_else(|| self.default_character.clone());
        let chain: Vec<usize> = self.chain("paragraph", paragraph_id.as_deref()).into_iter().chain(self.chain("character", character_id.as_deref())).collect();
        for index in chain {
            let props = word_child(Some(defs[index]), "rPr");
            let style = read_docx_run_style(props);
            layers.push(props);
            // Bold/italic toggle in named styles, but are absolute in direct formatting.
            if style.underline.is_some() {
                result.underline = style.underline.clone();
            }
            if style.color.is_some() {
                result.color = style.color.clone();
            }
            if style.font_family.is_some() {
                result.font_family = style.font_family.clone();
            }
            if style.font_size_points.is_some() {
                result.font_size_points = style.font_size_points;
            }
            if style.bold == Some(true) {
                result.bold = Some(!result.bold.unwrap_or(false));
            }
            if style.italic == Some(true) {
                result.italic = Some(!result.italic.unwrap_or(false));
            }
        }
        macro_rules! direct {
            ($f:ident) => {
                if direct.$f.is_some() {
                    result.$f = direct.$f.clone();
                }
            };
        }
        direct!(bold);
        direct!(italic);
        direct!(underline);
        direct!(color);
        direct!(font_family);
        direct!(font_size_points);
        layers.push(direct_props);
        let themed = self.themes.run(&layers, text);
        // Undefined selected authority masks inherited values.
        result.font_family = themed.font_family;
        if let Some(color) = themed.color {
            result.color = color;
        }
        result
    }
}

pub(crate) fn ensure_docx_named_style(state: &State, id: &str) -> Result<State> {
    if read_docx_styles(state)?.iter().any(|s| s.id == id) {
        return Ok(state.clone());
    }
    let Some(style) = builtin_style(id) else {
        return Err(OfficeError::docx("invalid-format", "Paragraph style is not defined in this document."));
    };
    let namespace = parse_xml(&state.source)?.namespace;
    let (next, name) = ensure_docx_part(
        state,
        "styles",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
        &format!("<w:styles xmlns:w=\"{namespace}\"/>"),
        &namespace,
    )?;
    let source = docx_part_source(&next, &name)?.unwrap_or_default();
    let heading = id.starts_with("Heading");
    let node = format!(
        "<w:style xmlns:w=\"{namespace}\" w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{}\"/>{}<w:pPr><w:spacing w:after=\"{}\"/>{}</w:pPr><w:rPr>{}{}</w:rPr></w:style>",
        style.name,
        if id == "Normal" { "" } else { "<w:basedOn w:val=\"Normal\"/>" },
        if heading { 120 } else { 0 },
        if heading { format!("<w:outlineLvl w:val=\"{}\"/>", id[id.len() - 1..].parse::<u32>().unwrap_or(1) - 1) } else { String::new() },
        if style.bold { "<w:b/>" } else { "" },
        style.size.map_or(String::new(), |s| format!("<w:sz w:val=\"{s}\"/>")),
    );
    let mut result = state.clone();
    result.part_overrides = next.part_overrides.clone();
    result.part_overrides.set(&name, append_docx_xml(&source, &node)?.into_bytes());
    if id == "Normal" || read_docx_styles(&result)?.iter().any(|s| s.id == "Normal") {
        return Ok(result);
    }
    ensure_docx_named_style(&result, "Normal")
}

// ---- theme (docx-theme.ts) ----

const SYSTEM_COLORS: &[&str] = &[
    "scrollBar", "background", "activeCaption", "inactiveCaption", "menu", "window", "windowFrame", "menuText", "windowText", "captionText",
    "activeBorder", "inactiveBorder", "appWorkspace", "highlight", "highlightText", "btnFace", "btnShadow", "grayText", "btnText",
    "inactiveCaptionText", "btnHighlight", "3dDkShadow", "3dLight", "infoText", "infoBk", "hotLight", "gradientActiveCaption",
    "gradientInactiveCaption", "menuHighlight", "menuBar",
];
const MAPPING_KEYS: &[(&str, &str)] = &[
    ("dark1", "t1"), ("text1", "t1"), ("dark2", "t2"), ("text2", "t2"), ("light1", "bg1"), ("background1", "bg1"), ("light2", "bg2"),
    ("background2", "bg2"), ("accent1", "accent1"), ("accent2", "accent2"), ("accent3", "accent3"), ("accent4", "accent4"),
    ("accent5", "accent5"), ("accent6", "accent6"), ("hyperlink", "hyperlink"), ("followedHyperlink", "followedHyperlink"),
];
const DEFAULT_MAPPING: &[(&str, &str)] = &[
    ("t1", "dark1"), ("t2", "dark2"), ("bg1", "light1"), ("bg2", "light2"), ("accent1", "accent1"), ("accent2", "accent2"),
    ("accent3", "accent3"), ("accent4", "accent4"), ("accent5", "accent5"), ("accent6", "accent6"), ("hyperlink", "hyperlink"),
    ("followedHyperlink", "followedHyperlink"),
];
const DRAWING_SLOTS: &[(&str, &str)] = &[
    ("dark1", "dk1"), ("dark2", "dk2"), ("light1", "lt1"), ("light2", "lt2"), ("accent1", "accent1"), ("accent2", "accent2"),
    ("accent3", "accent3"), ("accent4", "accent4"), ("accent5", "accent5"), ("accent6", "accent6"), ("hyperlink", "hlink"),
    ("followedHyperlink", "folHlink"),
];
fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}
fn rgb_hex(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn unique_child<'a>(node: Option<&'a XmlElement>, name: &str, namespaces: &[&str]) -> Option<&'a XmlElement> {
    let matches: Vec<&XmlElement> = node?.children.iter().filter(|c| c.local_name == name && namespaces.contains(&c.namespace.as_str())).collect();
    (matches.len() == 1).then(|| matches[0])
}
fn theme_word_child<'a>(node: Option<&'a XmlElement>, name: &str) -> Option<&'a XmlElement> {
    unique_child(node, name, &WORD_NAMESPACES)
}
fn drawing_child<'a>(node: Option<&'a XmlElement>, name: &str) -> Option<&'a XmlElement> {
    let ns = node.map(|n| n.namespace.clone());
    match ns {
        Some(ns) => unique_child(node, name, &[ns.as_str()]),
        None => None,
    }
}

/// Unlike editing lookups, display dependencies must be unique, internal,
/// safely addressed and declared with the exact expected content type.
fn dependency(state: &State, kind: &str) -> (Option<XmlElement>, bool) {
    let read = |name: &str| -> Option<XmlElement> {
        let bytes = docx_part(state, name)?;
        decode_docx_xml(bytes).ok().and_then(|(t, _)| parse_xml(&t).ok())
    };
    let relationships = match read(&docx_relationships_part(&state.main_part)) {
        None => return (None, true),
        Some(r) => r,
    };
    if relationships.local_name != "Relationships" || relationships.namespace != DOCX_REL {
        return (None, false);
    }
    let matches: Vec<&XmlElement> = relationships
        .children
        .iter()
        .filter(|n| n.local_name == "Relationship" && n.namespace == DOCX_REL && [DOCX_R, DOCX_R_STRICT].iter().any(|r| n.plain("Type") == Some(&format!("{r}/{kind}"))))
        .collect();
    if matches.is_empty() {
        return (None, true);
    }
    if matches.len() != 1 {
        return (None, false);
    }
    let relationship = matches[0];
    let (Some(id), Some(target)) = (relationship.plain("Id"), relationship.plain("Target")) else { return (None, false) };
    if relationships.children.iter().filter(|n| n.plain("Id") == Some(id)).count() != 1
        || !matches!(relationship.plain("TargetMode"), None | Some("Internal"))
        || target.is_empty()
        || target.chars().any(|c| matches!(c, '\\' | '%' | '?' | '#' | ':') || c.is_whitespace())
    {
        return (None, false);
    }
    let mut segments: Vec<&str> = if target.starts_with('/') { vec![] } else { state.main_part.split('/').collect() };
    if !target.starts_with('/') {
        segments.pop();
    }
    for segment in target.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            return (None, false);
        }
        if segment == "." {
            continue;
        }
        if segment == ".." {
            if segments.pop().is_none() {
                return (None, false);
            }
        } else {
            segments.push(segment);
        }
    }
    let name = segments.join("/");
    let Some(manifest) = read("[Content_Types].xml") else { return (None, false) };
    if manifest.local_name != "Types" || manifest.namespace != TYPES {
        return (None, false);
    }
    let extension = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let overrides: Vec<&XmlElement> =
        manifest.children.iter().filter(|n| n.namespace == TYPES && n.local_name == "Override" && n.plain("PartName") == Some(&format!("/{name}"))).collect();
    let defaults: Vec<&XmlElement> = manifest
        .children
        .iter()
        .filter(|n| n.namespace == TYPES && n.local_name == "Default" && n.plain("Extension").map(str::to_lowercase).as_deref() == Some(extension.as_str()))
        .collect();
    let declaration = if overrides.is_empty() { defaults } else { overrides };
    let expected = if kind == "theme" {
        "application/vnd.openxmlformats-officedocument.theme+xml"
    } else {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"
    };
    if declaration.len() != 1 || declaration[0].plain("ContentType") != Some(expected) {
        return (None, false);
    }
    let root = read(&name);
    match root {
        Some(r) if r.local_name == kind && (if kind == "theme" { DRAWING.contains(&r.namespace.as_str()) } else { WORD_NAMESPACES.contains(&r.namespace.as_str()) }) => (Some(r), false),
        _ => (None, false),
    }
}

/// HSL tint/shade with our deterministic channel rounding.
fn transform_color(rgb: &str, tint: Option<&str>, shade: Option<&str>) -> Option<String> {
    let Some(amount) = tint.or(shade) else { return Some(rgb.to_string()) };
    if amount.len() != 2 || !amount.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |o: usize| u8::from_str_radix(&rgb[o..o + 2], 16).unwrap_or(0) as f64 / 255.0;
    let (r, g, b) = (channel(0), channel(2), channel(4));
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let delta = max - min;
    let lightness = (max + min) / 2.0;
    let saturation = if delta == 0.0 { 0.0 } else { delta / (1.0 - (2.0 * lightness - 1.0).abs()) };
    let hue = if delta == 0.0 {
        0.0
    } else if max == r {
        ((g - b) / delta + 6.0) % 6.0
    } else if max == g {
        (b - r) / delta + 2.0
    } else {
        (r - g) / delta + 4.0
    };
    let factor = u8::from_str_radix(amount, 16).unwrap_or(0) as f64 / 255.0;
    let next = lightness * factor + if tint.is_some() { 1.0 - factor } else { 0.0 };
    let chroma = (1.0 - (2.0 * next - 1.0).abs()) * saturation;
    let x = chroma * (1.0 - ((hue % 2.0) - 1.0).abs());
    let m = next - chroma / 2.0;
    let channels = if hue < 1.0 {
        [chroma, x, 0.0]
    } else if hue < 2.0 {
        [x, chroma, 0.0]
    } else if hue < 3.0 {
        [0.0, chroma, x]
    } else if hue < 4.0 {
        [0.0, x, chroma]
    } else if hue < 5.0 {
        [x, 0.0, chroma]
    } else {
        [chroma, 0.0, x]
    };
    Some(channels.iter().map(|c| format!("{:02x}", crate::model::js_round((c + m).clamp(0.0, 1.0) * 255.0) as u8)).collect())
}

#[derive(Clone, Debug, Default)]
struct FontAuthority {
    literal: Option<String>,
    theme: Option<String>,
}

pub(crate) struct ThemeRun {
    pub font_family: Option<String>,
    /// `None` = no color layer; `Some(None)` = a color layer with unresolved authority.
    pub color: Option<Option<String>>,
}

pub(crate) struct ThemeResolver {
    latin_theme_known: bool,
    latin_fonts: HashMap<&'static str, Option<String>>,
    mapped_colors: HashMap<&'static str, Option<String>>,
}

impl ThemeResolver {
    pub(crate) fn new(state: &State) -> Self {
        let (theme, _) = dependency(state, "theme");
        let (settings, settings_absent) = dependency(state, "settings");
        let elements = drawing_child(theme.as_ref(), "themeElements");
        let colors = drawing_child(elements, "clrScheme");
        let fonts = drawing_child(elements, "fontScheme");
        let mappings: Vec<&XmlElement> = settings.as_ref().map_or(vec![], |s| s.children.iter().filter(|n| is_word(n, "clrSchemeMapping")).collect());
        let languages: Vec<&XmlElement> = settings.as_ref().map_or(vec![], |s| s.children.iter().filter(|n| is_word(n, "themeFontLang")).collect());
        let settings_known = settings_absent || settings.is_some();
        let latin_theme_known = settings_known && languages.len() <= 1 && val(languages.first().copied()).is_none();
        let mut latin_fonts = HashMap::new();
        for kind in ["major", "minor"] {
            let family = drawing_child(fonts, &format!("{kind}Font"));
            let latin = drawing_child(family, "latin");
            let typeface = latin.filter(|l| l.children.is_empty()).and_then(|l| l.plain("typeface"));
            latin_fonts.insert(kind, typeface.filter(|t| !t.trim().is_empty()).map(str::to_string));
        }
        let mut palette: HashMap<&str, Option<String>> = HashMap::new();
        for (_, slot) in DRAWING_SLOTS {
            let selected = drawing_child(colors, slot);
            let mut rgb = None;
            if let Some(sel) = selected
                && sel.children.len() == 1
            {
                let value = &sel.children[0];
                let candidate = value.plain(if value.local_name == "sysClr" { "lastClr" } else { "val" });
                if Some(value.namespace.as_str()) == colors.map(|c| c.namespace.as_str())
                    && value.children.is_empty()
                    && (value.local_name == "srgbClr" || value.local_name == "sysClr")
                    && candidate.is_some_and(rgb_hex)
                    && (value.local_name != "sysClr" || SYSTEM_COLORS.contains(&value.plain("val").unwrap_or("")))
                {
                    rgb = candidate.map(str::to_lowercase);
                }
            }
            palette.insert(slot, rgb);
        }
        let mut mapped_colors = HashMap::new();
        for (token, key) in MAPPING_KEYS {
            let mapped = own(mappings.first().copied(), key).map(str::to_string).or_else(|| lookup(DEFAULT_MAPPING, key).map(str::to_string));
            let slot = mapped.as_deref().and_then(|m| lookup(DRAWING_SLOTS, m));
            let value = if settings_known && mappings.len() <= 1 { slot.and_then(|s| palette.get(s).cloned().flatten()) } else { None };
            mapped_colors.insert(*token, value);
        }
        ThemeResolver { latin_theme_known, latin_fonts, mapped_colors }
    }

    fn color(&self, node: &XmlElement) -> Option<String> {
        let Some(token) = own(Some(node), "themeColor") else { return val(Some(node)).map(str::to_string) };
        let rgb = self.mapped_colors.get(token).cloned().flatten()?;
        transform_color(&rgb, own(Some(node), "themeTint"), own(Some(node), "themeShade"))
    }

    fn font(&self, authority: Option<&FontAuthority>, guarded: bool) -> Option<String> {
        let authority = authority?;
        if guarded {
            return None;
        }
        let Some(theme) = &authority.theme else { return authority.literal.clone().filter(|l| !l.is_empty()) };
        let valid = ["major", "minor"].iter().any(|k| theme.strip_prefix(k).is_some_and(|rest| rest == "Ascii" || rest == "HAnsi"));
        if !self.latin_theme_known || !valid {
            return None;
        }
        self.latin_fonts.get(if theme.starts_with("major") { "major" } else { "minor" }).cloned().flatten()
    }

    pub(crate) fn run(&self, layers: &[Option<&XmlElement>], text: &str) -> ThemeRun {
        let (mut ascii, mut hansi): (Option<FontAuthority>, Option<FontAuthority>) = (None, None);
        let mut effective: Option<String> = None;
        let (mut has_color, mut cs, mut rtl, mut ambiguous) = (false, false, false, false);
        let mut hint: Option<String> = None;
        for layer in layers {
            let font_nodes = layer.map_or(0, |l| l.children.iter().filter(|n| is_word(n, "rFonts")).count());
            if font_nodes > 1 {
                ambiguous = true;
            }
            let font_node = theme_word_child(*layer, "rFonts");
            for (slot, target) in [("ascii", &mut ascii), ("hAnsi", &mut hansi)] {
                let literal = own(font_node, slot);
                let theme = own(font_node, &format!("{slot}Theme"));
                if literal.is_some() || theme.is_some() {
                    *target = Some(match theme {
                        Some(t) => FontAuthority { theme: Some(t.to_string()), literal: None },
                        None => FontAuthority { literal: literal.map(str::to_string), theme: None },
                    });
                }
            }
            if let Some(h) = own(font_node, "hint") {
                hint = Some(h.to_string());
            }
            for name in ["cs", "rtl"] {
                if let Some(node) = theme_word_child(*layer, name) {
                    let on = !["false", "0", "off"].contains(&val(Some(node)).unwrap_or("true"));
                    if name == "cs" {
                        cs = on;
                    } else {
                        rtl = on;
                    }
                }
            }
            let color_nodes: Vec<&XmlElement> = layer.map_or(vec![], |l| l.children.iter().filter(|n| is_word(n, "color")).collect());
            if !color_nodes.is_empty() {
                has_color = true;
                effective = if color_nodes.len() == 1 { self.color(color_nodes[0]) } else { None };
            }
        }
        let latin = |c: char| matches!(c as u32, 0..=0x24f | 0x1e00..=0x1eff | 0x2000..=0x206f);
        let unsupported_script = text.chars().any(|c| !latin(c));
        let guarded = cs || rtl || hint.as_deref().is_some_and(|h| h != "default") || unsupported_script || ambiguous;
        let non_ascii = !text.is_ascii();
        let has_ascii = text.chars().any(|c| c.is_ascii());
        let selected = if non_ascii && !unsupported_script { hansi.as_ref() } else { ascii.as_ref() };
        let mut font_family = if ambiguous { None } else { self.font(selected, guarded) };
        if non_ascii && has_ascii && !unsupported_script && self.font(ascii.as_ref(), guarded) != self.font(hansi.as_ref(), guarded) {
            font_family = None;
        }
        ThemeRun { font_family, color: has_color.then_some(effective) }
    }
}
