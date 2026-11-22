//! Text hyperlinks with OPC external relationships (ECMA-376 17.16.22) and
//! explicit page breaks (17.3.3.1). Ported from `docx-hyperlinks.ts` and
//! `docx-page-breaks.ts`. Nothing is fetched, launched or followed here.

use super::State;
use super::edit::*;
use super::parts::{DOCX_R, DOCX_R_STRICT, DOCX_REL, append_docx_xml, declare_docx_relationship_part, docx_part_source, docx_relationships_part};
use crate::error::Result;
use crate::xml::{XMLNS_NAMESPACE, XmlElement, parse_xml, xml_attribute, xml_attribute_text, xml_descendants};

fn unsafe_link(message: &str) -> crate::error::OfficeError {
    invalid("unsafe-link", message)
}

/// Normalizes like the WHATWG URL serializer for the shapes we accept: a
/// lowercase scheme and host, and "/" for an empty http(s) path.
pub fn safe_docx_hyperlink_target(value: &str) -> Result<String> {
    let units = value.chars().map(char::len_utf16).sum::<usize>();
    let bad_char = value.chars().any(|c| c.is_whitespace() || (c as u32) <= 0x20 || c == '\u{7f}' || c == '\\');
    let lower = value.to_ascii_lowercase();
    let bad_escape = lower.match_indices('%').any(|(i, _)| {
        let h = &lower.as_bytes()[i + 1..];
        h.len() >= 2 && ((h[0] == b'0' || h[0] == b'1') && h[1].is_ascii_hexdigit() || (h[0] == b'7' && h[1] == b'f'))
    });
    if value.is_empty() || units > 4096 || bad_char || bad_escape {
        return Err(unsafe_link("Link destination contains unsupported whitespace or control characters."));
    }
    let invalid_url = || unsafe_link("Link must be an explicit HTTP, HTTPS or simple mailto URL.");
    let parsed = url::Url::parse(value).map_err(|_| invalid_url())?;
    if matches!(parsed.scheme(), "http" | "https")
        && (lower.starts_with("http://") || lower.starts_with("https://"))
        && parsed.host_str().is_some()
        && parsed.username().is_empty() && parsed.password().is_none()
    {
        return Ok(parsed.to_string());
    }
    if parsed.scheme() == "mailto" && parsed.query().is_none() && parsed.fragment().is_none()
        && !value.contains('%')
    {
        let address = value.get(7..).unwrap_or("");
        let simple = address.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && local.bytes().all(|b| b".!$&'*+/=^_`{|}~-".contains(&b) || b.is_ascii_alphanumeric())
                && valid_mail_domain(domain)
        });
        if simple { return Ok(parsed.to_string()); }
    }
    Err(unsafe_link("Only credential-free HTTP/HTTPS and simple mailto destinations are supported."))
}

/// `(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}`
fn valid_mail_domain(domain: &str) -> bool {
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let tld = labels[labels.len() - 1];
    if !(2..=63).contains(&tld.len()) || !tld.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    labels[..labels.len() - 1].iter().all(|l| {
        let b = l.as_bytes();
        !b.is_empty() && b.len() <= 63 && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
    })
}

/// A destination that may be preserved untouched (never fetched or followed).
pub(crate) fn preservable_docx_hyperlink_target(value: Option<&str>) -> bool {
    let Some(value) = value.filter(|v| !v.is_empty()) else { return false };
    if value.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
        return false;
    }
    let scheme = value.find(':').map(|i| &value[..i]).filter(|s| {
        s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
    });
    match scheme {
        None => {
            let b = value.as_bytes();
            !(value.starts_with('/') || value.starts_with('\\') || value.contains("..") || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'))
        }
        Some(s) => ["http", "https", "mailto", "tel"].contains(&s.to_ascii_lowercase().as_str()),
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Link {
    pub id: String,
    pub paragraph_id: String,
    pub text: String,
    pub target: String,
    pub run_ids: Vec<String>,
    pub node: XmlElement,
    pub relationship_id: String,
}

pub(crate) struct LinkInspection {
    pub links: Vec<Link>,
    pub problem: Option<&'static str>,
}

fn r_namespace(ns: &str) -> &'static str {
    if ns.contains("purl.oclc.org") { DOCX_R_STRICT } else { DOCX_R }
}

/// Assigns identities to link runs (hence `&mut`), as the TypeScript does.
pub(crate) fn inspect_docx_hyperlinks(state: &mut State) -> Result<LinkInspection> {
    let fail = |p| Ok(LinkInspection { links: vec![], problem: Some(p) });
    let root = parse_xml(&state.source)?;
    let all = xml_descendants(&root);
    let rel_source = docx_part_source(state, &docx_relationships_part(&state.main_part))?;
    let rel_root = rel_source.map(|s| parse_xml(&s)).transpose()?;
    let rels: &[XmlElement] = rel_root.as_ref().map_or(&[], |r| &r.children);
    let nodes: Vec<&XmlElement> = all.iter().copied().filter(|n| is_word(n, "hyperlink")).collect();
    if nodes.len() > 2000 {
        return fail("Too many text hyperlinks.");
    }
    let mut links = Vec::new();
    for node in nodes {
        let paragraph = all.iter().find(|p| is_word(p, "p") && p.has_child(node.start));
        let r = r_namespace(&node.namespace);
        let id = xml_attribute(node, "id", r);
        let relation = rels.iter().find(|rel| rel.plain("Id") == id && id.is_some() && rel.plain("Type") == Some(&format!("{r}/hyperlink")) && rel.plain("TargetMode") == Some("External"));
        let history = own(Some(node), "history");
        let tooltip = own(Some(node), "tooltip");
        if paragraph.is_none()
            || node.children.is_empty()
            || !ws_only(&node.text)
            || node.attributes.iter().any(|a| {
                a.namespace != XMLNS_NAMESPACE
                    && !(a.namespace == r && a.local_name == "id")
                    && !(a.namespace == node.namespace && ["history", "tooltip", "anchor", "docLocation", "tgtFrame"].contains(&a.local_name.as_str()))
            })
            || node.children.iter().any(|run| !is_word(run, "r") || run.namespace != node.namespace)
        {
            return fail("Only direct ordinary text hyperlinks are editable.");
        }
        if let Some(rel) = relation
            && !preservable_docx_hyperlink_target(rel.plain("Target"))
        {
            return fail("Hyperlink destination is unsafe or unsupported.");
        }
        let target = relation
            .filter(|_| own(Some(node), "anchor").is_none() && own(Some(node), "docLocation").is_none())
            .and_then(|rel| safe_docx_hyperlink_target(rel.plain("Target").unwrap_or("")).ok());
        let ordinary = target.is_some()
            && history.is_none_or(|h| ["true", "false", "on", "off", "0", "1"].contains(&h))
            && tooltip.map_or(0, |t| t.chars().map(char::len_utf16).sum::<usize>()) <= 260
            && node.children.iter().all(|run| {
                word_child(Some(run), "t").is_some()
                    && run.children.iter().all(|c| is_word(c, "rPr") || is_word(c, "t"))
                    && run.children.iter().filter(|c| is_word(c, "t")).count() == 1
            });
        for run in &node.children {
            if !state.identities.contains_key(&run.start) {
                let fresh = state.fresh("r~");
                state.identities.insert(run.start, fresh);
            }
        }
        let (Some(target), Some(id), true) = (target, id, ordinary) else { continue };
        if !state.identities.contains_key(&node.start) {
            let fresh = state.fresh("hyperlink~");
            state.identities.insert(node.start, fresh);
        }
        let paragraph = paragraph.unwrap();
        links.push(Link {
            id: state.identities[&node.start].clone(),
            paragraph_id: state.identities.get(&paragraph.start).cloned().unwrap_or_default(),
            text: node.children.iter().map(|run| word_child(Some(run), "t").unwrap().text.as_str()).collect(),
            target,
            run_ids: node.children.iter().map(|run| state.identities[&run.start].clone()).collect(),
            node: node.clone(),
            relationship_id: id.to_string(),
        });
    }
    Ok(LinkInspection { links, problem: None })
}

fn add_relationship(state: &State, target: &str) -> Result<(State, String)> {
    let name = docx_relationships_part(&state.main_part);
    let source = docx_part_source(state, &name)?.unwrap_or_else(|| format!("<Relationships xmlns=\"{DOCX_REL}\"/>"));
    let ids: Vec<String> = parse_xml(&source)?.children.iter().filter_map(|n| n.plain("Id").map(str::to_string)).collect();
    let mut id = "rIdLink1".to_string();
    let mut n = 2;
    while ids.contains(&id) {
        id = format!("rIdLink{n}");
        n += 1;
    }
    let r = r_namespace(&parse_xml(&state.source)?.namespace);
    let mut next = state.clone();
    next.part_overrides.set(
        &name,
        append_docx_xml(&source, &format!("<Relationship xmlns=\"{DOCX_REL}\" Id=\"{id}\" Type=\"{r}/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>", xml_attribute_text(target)?))?
            .into_bytes(),
    );
    let manifest = docx_part_source(state, "[Content_Types].xml")?.unwrap_or_default();
    let updated = declare_docx_relationship_part(&manifest, &name)?;
    if updated != manifest {
        next.part_overrides.set("[Content_Types].xml", updated.into_bytes());
    }
    Ok((next, id))
}

fn remove_unused_relationship(state: State, id: &str) -> Result<State> {
    let root = parse_xml(&state.source)?;
    if xml_descendants(&root).iter().any(|n| n.attributes.iter().any(|a| (a.namespace == DOCX_R || a.namespace == DOCX_R_STRICT) && a.value == id)) {
        return Ok(state);
    }
    let name = docx_relationships_part(&state.main_part);
    let source = docx_part_source(&state, &name)?.unwrap_or_default();
    let rels = parse_xml(&source)?;
    let Some(relation) = rels.children.iter().find(|n| n.plain("Id") == Some(id)) else { return Ok(state) };
    let mut next = state.clone();
    next.part_overrides.set(&name, format!("{}{}", &source[..relation.start], &source[relation.end..]).into_bytes());
    Ok(next)
}

pub(crate) fn set_docx_hyperlink(state: &State, paragraph_id: &str, start: usize, end: usize, target_value: &str) -> Result<State> {
    let target = safe_docx_hyperlink_target(target_value)?;
    let root = parse_xml(&state.source)?;
    let paragraph = xml_descendants(&root)
        .into_iter()
        .find(|n| is_word(n, "p") && state.identities.get(&n.start).is_some_and(|x| x == paragraph_id))
        .ok_or_else(|| invalid("invalid-link", "Unknown paragraph identity."))?;
    let runs: Vec<&XmlElement> = xml_descendants(paragraph).into_iter().filter(|n| is_word(n, "r")).collect();
    let text: String = runs.iter().map(|r| docx_inline_text(r, false)).collect();
    if end <= start || end > text.len() || !text.is_char_boundary(start) || !text.is_char_boundary(end) {
        return Err(invalid("invalid-link", "Select a valid nonempty text range inside one paragraph."));
    }
    let mut cursor = 0;
    let mut selected: Vec<(&XmlElement, usize, usize)> = Vec::new();
    for run in &runs {
        let value = docx_inline_text(run, false);
        if cursor < end && cursor + value.len() > start {
            if !paragraph.has_child(run.start) || run.children.iter().any(|n| !is_word(n, "rPr") && !is_word(n, "t")) || run.children.iter().filter(|n| is_word(n, "t")).count() != 1 {
                return Err(invalid("unsupported-link", "Selection intersects an existing link, revision or inline object."));
            }
            selected.push((run, start.saturating_sub(cursor), value.len().min(end - cursor)));
        }
        cursor += value.len();
    }
    let (first, last) = (selected[0], selected[selected.len() - 1]);
    let interior = paragraph.children.iter().filter(|n| n.start > first.0.start && n.end < last.0.end);
    if interior.clone().any(|n| !is_word(n, "r") || n.children.iter().any(|c| !is_word(c, "rPr") && !is_word(c, "t"))) {
        return Err(invalid("unsupported-link", "A link cannot absorb comments, breaks or other inline containers."));
    }
    let slice = |entry: (&XmlElement, usize, usize), from: usize, to: usize| -> Result<String> {
        let t = word_child(Some(entry.0), "t").unwrap();
        docx_run_text_fragment(&state.source, entry.0, t, &t.text[from..to])
    };
    let first_len = word_child(Some(first.0), "t").unwrap().text.len();
    let last_len = word_child(Some(last.0), "t").unwrap().text.len();
    let prefix = if first.1 > 0 { slice(first, 0, first.1)? } else { String::new() };
    let suffix = if last.2 < last_len { slice(last, last.2, last_len)? } else { String::new() };
    let contents = if first.0.start == last.0.start {
        slice(first, first.1, first.2)?
    } else {
        format!("{}{}{}", slice(first, first.1, first_len)?, &state.source[first.0.end..last.0.start], slice(last, 0, last.2)?)
    };
    let (rel_state, rel_id) = add_relationship(state, &target)?;
    let r = r_namespace(&paragraph.namespace);
    let xml = format!("{prefix}<w:hyperlink xmlns:w=\"{}\" xmlns:r=\"{r}\" r:id=\"{rel_id}\">{contents}</w:hyperlink>{suffix}", paragraph.namespace);
    let mut next = patch_docx_source(state, vec![Patch::new(first.0.start, last.0.end, xml)])?;
    next.part_overrides = rel_state.part_overrides;
    inspect_docx_hyperlinks(&mut next)?;
    Ok(next)
}

pub(crate) fn update_docx_hyperlink(state: &State, id: &str, target_value: &str) -> Result<State> {
    let target = safe_docx_hyperlink_target(target_value)?;
    let mut probe = state.clone();
    let inspected = inspect_docx_hyperlinks(&mut probe)?;
    let link = inspected.links.iter().find(|l| l.id == id);
    let (None, Some(link)) = (inspected.problem, link) else {
        return Err(invalid("invalid-link", inspected.problem.unwrap_or("Unknown hyperlink identity.")));
    };
    let (rel_state, rel_id) = add_relationship(&probe, &target)?;
    let mut attrs = Vec::new();
    for a in &link.node.attributes {
        let value = if (a.namespace == DOCX_R || a.namespace == DOCX_R_STRICT) && a.local_name == "id" { rel_id.as_str() } else { a.value.as_str() };
        attrs.push(format!("{}=\"{}\"", a.name, xml_attribute_text(value)?));
    }
    let opening = format!("<{}{}>", link.node.name, if attrs.is_empty() { String::new() } else { format!(" {}", attrs.join(" ")) });
    let mut next = patch_docx_source(&probe, vec![Patch::keep(link.node.start, link.node.start_tag_end, opening)])?;
    next.part_overrides = rel_state.part_overrides;
    remove_unused_relationship(next, &link.relationship_id)
}

pub(crate) fn remove_docx_hyperlink(state: &State, id: &str) -> Result<State> {
    let mut probe = state.clone();
    let inspected = inspect_docx_hyperlinks(&mut probe)?;
    let link = inspected.links.iter().find(|l| l.id == id);
    let (None, Some(link)) = (inspected.problem, link) else {
        return Err(invalid("invalid-link", inspected.problem.unwrap_or("Unknown hyperlink identity.")));
    };
    let mut contents = String::new();
    for run in &link.node.children {
        let raw = &probe.source[run.start..run.end];
        let own_names: Vec<&str> = run.attributes.iter().filter(|a| a.namespace == XMLNS_NAMESPACE).map(|a| a.name.as_str()).collect();
        let mut attrs = String::new();
        for a in link.node.attributes.iter().filter(|a| a.namespace == XMLNS_NAMESPACE && !own_names.contains(&a.name.as_str())) {
            attrs.push_str(&format!(" {}=\"{}\"", a.name, xml_attribute_text(&a.value)?));
        }
        let offset = run.start_tag_end - run.start - 1;
        contents.push_str(&if attrs.is_empty() { raw.to_string() } else { format!("{}{attrs}{}", &raw[..offset], &raw[offset..]) });
    }
    let next = patch_docx_source(&probe, vec![Patch::new(link.node.start, link.node.end, contents)])?;
    remove_unused_relationship(next, &link.relationship_id)
}

// ---- explicit page breaks ----

#[derive(Clone, Debug)]
pub(crate) struct PageBreakInfo {
    pub id: String,
    pub paragraph_id: String,
    pub run_id: String,
    pub offset: usize,
    pub node_start: usize,
    pub node_end: usize,
    pub run_start: usize,
    pub local_offset: usize,
}

pub(crate) struct BreakInspection {
    pub breaks: Vec<PageBreakInfo>,
    pub problem: Option<&'static str>,
}

pub(crate) fn inspect_docx_page_breaks(state: &mut State) -> Result<BreakInspection> {
    let fail = |p| Ok(BreakInspection { breaks: vec![], problem: Some(p) });
    let root = parse_xml(&state.source)?;
    let all = xml_descendants(&root);
    let mut result = Vec::new();
    let mut line_breaks = 0usize;
    for paragraph in all.iter().filter(|n| is_word(n, "p")) {
        let mut offset = 0usize;
        for run in xml_descendants(paragraph).into_iter().filter(|n| is_word(n, "r")) {
            let mut local = 0usize;
            for child in &run.children {
                // Offsets follow the snapshot's visible run text.
                if !is_word(child, "br") {
                    let length = docx_inline_text(child, false).len();
                    offset += length;
                    local += length;
                    continue;
                }
                let kind = xml_attribute(child, "type", &child.namespace);
                if kind != Some("page") {
                    if !child.children.is_empty()
                        || !child.text.is_empty()
                        || child.attributes.iter().any(|a| a.namespace != XMLNS_NAMESPACE && !(a.namespace == child.namespace && (a.local_name == "type" || a.local_name == "clear")))
                    {
                        return fail("Unsupported line break markup.");
                    }
                    line_breaks += 1;
                    offset += 1;
                    local += 1;
                    continue;
                }
                if !paragraph.has_child(run.start)
                    || !child.children.is_empty()
                    || !child.text.is_empty()
                    || child.attributes.iter().any(|a| a.namespace != XMLNS_NAMESPACE && !(a.namespace == child.namespace && a.local_name == "type"))
                {
                    return fail("Only ordinary direct-run explicit page breaks are editable.");
                }
                if !state.identities.contains_key(&child.start) {
                    let fresh = state.fresh("page-break~");
                    state.identities.insert(child.start, fresh);
                }
                if !state.identities.contains_key(&run.start) {
                    let fresh = state.fresh("r~");
                    state.identities.insert(run.start, fresh);
                }
                result.push(PageBreakInfo {
                    id: state.identities[&child.start].clone(),
                    paragraph_id: state.identities.get(&paragraph.start).cloned().unwrap_or_default(),
                    run_id: state.identities[&run.start].clone(),
                    offset,
                    node_start: child.start,
                    node_end: child.end,
                    run_start: run.start,
                    local_offset: local,
                });
                if result.len() > 2000 {
                    return fail("Too many explicit page breaks.");
                }
            }
        }
    }
    if all.iter().filter(|n| is_word(n, "br")).count() != result.len() + line_breaks {
        return fail("Break is outside a supported paragraph run.");
    }
    Ok(BreakInspection { breaks: result, problem: None })
}

pub(crate) fn insert_docx_page_break(state: &State, paragraph_id: &str, offset: usize) -> Result<State> {
    let root = parse_xml(&state.source)?;
    let paragraph = xml_descendants(&root)
        .into_iter()
        .find(|p| is_word(p, "p") && state.identities.get(&p.start).is_some_and(|x| x == paragraph_id))
        .ok_or_else(|| invalid("invalid-break", "Unknown paragraph identity."))?;
    if xml_descendants(paragraph).iter().any(|n| any_word(n) && (n.local_name == "ins" || n.local_name == "del")) {
        return Err(invalid("unsupported-break", "Resolve paragraph revisions before inserting a page break."));
    }
    let text: String = paragraph.children.iter().filter(|n| is_word(n, "r") || is_word(n, "hyperlink")).map(|n| docx_inline_text(n, false)).collect();
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err(invalid("invalid-break", "Page break offset must be a valid paragraph text boundary."));
    }
    let ns = &paragraph.namespace;
    let xml = format!("<w:r xmlns:w=\"{ns}\"><w:br w:type=\"page\"/></w:r>");
    let mut cursor = 0;
    for child in &paragraph.children {
        if !is_word(child, "r") && !is_word(child, "hyperlink") {
            continue;
        }
        let value = docx_inline_text(child, false);
        if value.is_empty() && (word_child(Some(child), "commentReference").is_some() || word_child(Some(child), "drawing").is_some()) {
            continue;
        }
        if offset == cursor {
            return patch_docx_source(state, vec![Patch::new(child.start, child.start, xml)]);
        }
        if offset == cursor + value.len() {
            return patch_docx_source(state, vec![Patch::new(child.end, child.end, xml)]);
        }
        if offset > cursor && offset < cursor + value.len() {
            let text_node = word_child(Some(child), "t");
            let Some(text_node) = text_node.filter(|_| is_word(child, "r") && child.children.iter().all(|n| is_word(n, "rPr") || is_word(n, "t"))) else {
                return Err(invalid("unsupported-break", "Cannot split a hyperlink or mixed object run with a page break."));
            };
            let index = offset - cursor;
            let before = docx_run_text_fragment(&state.source, child, text_node, &text_node.text[..index])?;
            let after = docx_run_text_fragment(&state.source, child, text_node, &text_node.text[index..])?;
            return patch_docx_source(state, vec![Patch::keep(child.start, child.end, format!("{before}{xml}{after}"))]);
        }
        cursor += value.len();
    }
    let empty = format!("<w:r xmlns:w=\"{ns}\"><w:t xml:space=\"preserve\"/></w:r>");
    if paragraph.self_closing() {
        return patch_docx_source(state, vec![Patch::keep(paragraph.start, paragraph.end, format!("{}{xml}{empty}</{}>", open_tag(&state.source, paragraph), paragraph.name))]);
    }
    let end = paragraph.children.iter().find(|n| is_word(n, "commentRangeEnd")).map_or(paragraph.end_tag_start, |n| n.start);
    patch_docx_source(state, vec![Patch::new(end, end, xml)])
}

pub(crate) fn remove_docx_page_break(state: &State, id: &str) -> Result<State> {
    let mut probe = state.clone();
    let inspected = inspect_docx_page_breaks(&mut probe)?;
    let selected = inspected.breaks.iter().find(|b| b.id == id);
    let (None, Some(selected)) = (inspected.problem, selected) else {
        return Err(invalid("invalid-break", inspected.problem.unwrap_or("Unknown page break identity.")));
    };
    patch_docx_source(&probe, vec![Patch::new(selected.node_start, selected.node_end, "")])
}
