//! Numbering (ECMA-376 17.9), portable comments (17.13.4), inline insertion and
//! deletion revisions (17.13.5) and range formatting. Ported from
//! `docx-numbering.ts`, `docx-comments.ts`, `docx-revisions.ts` and
//! `docx-revisions-range.ts`.

use super::State;
use super::edit::*;
use super::parts::{append_docx_xml, docx_part_source, ensure_docx_part, related_docx_part};
use crate::error::Result;
use crate::model::*;
use crate::xml::{XMLNS_NAMESPACE, XML_NAMESPACE, XmlElement, escape_xml_text, parse_xml, xml_attribute, xml_attribute_text, xml_descendants, xml_parent};
use std::collections::{BTreeMap, HashSet};

// ---- numbering ----

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct NumberingLevel {
    pub kind: ListKind,
    pub start: u32,
    pub restart: Option<u32>,
}

pub(crate) struct NumberingInspection {
    pub definitions: BTreeMap<String, BTreeMap<u32, NumberingLevel>>,
    definition_order: Vec<String>,
    pub problem: Option<&'static str>,
}

const NUMBERED_FORMATS: &[&str] = &["decimal", "decimalZero", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "ordinal", "hex"];
const ABSTRACT_CHILDREN: &[&str] = &["nsid", "multiLevelType", "name", "styleLink", "numStyleLink", "tmpl", "lvl"];

fn bounded_int(raw: Option<&str>, min: u32, max: u32) -> Option<u32> {
    let raw = raw.filter(|r| digits(r))?;
    let value: u64 = raw.parse().ok().or(Some(u64::MAX))?;
    (value >= min as u64 && value <= max as u64).then_some(value as u32)
}

fn parse_level(node: &XmlElement) -> Option<(u32, NumberingLevel)> {
    let level = bounded_int(own(Some(node), "ilvl"), 0, 8)?;
    let format = val(word_child(Some(node), "numFmt"));
    let start_raw = val(word_child(Some(node), "start"));
    let restart_raw = val(word_child(Some(node), "lvlRestart"));
    let start = match start_raw {
        None => 1,
        Some(s) => bounded_int(Some(s), 0, 999_999)?,
    };
    let restart = match restart_raw {
        None => None,
        Some(r) => Some(bounded_int(Some(r), 0, 9)?),
    };
    if word_child(Some(node), "lvlPicBulletId").is_some() {
        return None;
    }
    match format {
        Some("bullet") => Some((level, NumberingLevel { kind: ListKind::Bullet, start, restart })),
        Some(f) if NUMBERED_FORMATS.contains(&f) => Some((level, NumberingLevel { kind: ListKind::Numbered, start, restart })),
        _ => None,
    }
}

fn canonical(id: &str, max_digits: usize, allow_zero: bool) -> bool {
    let b = id.as_bytes();
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return false;
    }
    if b[0] == b'0' {
        return allow_zero && b.len() == 1;
    }
    b.len() <= max_digits
}

pub(crate) fn inspect_docx_numbering(state: &State) -> Result<NumberingInspection> {
    let mut out = NumberingInspection { definitions: BTreeMap::new(), definition_order: Vec::new(), problem: None };
    let Some(name) = related_docx_part(state, "numbering")? else { return Ok(out) };
    let Some(source) = docx_part_source(state, &name)? else { return Ok(out) };
    let root = parse_xml(&source)?;
    if !is_word(&root, "numbering") || root.children.len() > 2000 {
        out.problem = Some("Unsupported numbering root or too many lists.");
        return Ok(out);
    }
    if root.children.iter().any(|n| !any_word(n) || !["abstractNum", "num", "numPicBullet"].contains(&n.local_name.as_str())) {
        out.problem = Some("Numbering part contains unsupported top-level content.");
        return Ok(out);
    }
    let mut abstracts: BTreeMap<String, BTreeMap<u32, NumberingLevel>> = BTreeMap::new();
    for node in root.children.iter().filter(|n| is_word(n, "abstractNum")) {
        let id = own(Some(node), "abstractNumId");
        let multi = val(word_child(Some(node), "multiLevelType"));
        let bad = match id {
            None => true,
            Some(id) => !canonical(id, 9, true) || abstracts.contains_key(id),
        } || node.children.iter().any(|c| !any_word(c) || !ABSTRACT_CHILDREN.contains(&c.local_name.as_str()))
            || multi.is_some_and(|m| !["singleLevel", "multilevel", "hybridMultilevel"].contains(&m));
        if bad {
            out.problem = Some("List definition is outside the editable numbering subset.");
            return Ok(out);
        }
        let mut levels = BTreeMap::new();
        for level_node in node.children.iter().filter(|n| is_word(n, "lvl")) {
            match parse_level(level_node) {
                Some((l, d)) if !levels.contains_key(&l) => {
                    levels.insert(l, d);
                }
                _ => {
                    out.problem = Some("List level is missing, duplicated or unsupported.");
                    return Ok(out);
                }
            }
        }
        if levels.is_empty() || levels.len() > 9 {
            out.problem = Some("List definition has no usable levels.");
            return Ok(out);
        }
        abstracts.insert(id.unwrap_or("").to_string(), levels);
    }
    for node in root.children.iter().filter(|n| is_word(n, "num")) {
        let id = own(Some(node), "numId");
        let abstract_levels = abstracts.get(val(word_child(Some(node), "abstractNumId")).unwrap_or(""));
        let bad = match id {
            None => true,
            Some(id) => !canonical(id, 9, false) || out.definitions.contains_key(id),
        } || abstract_levels.is_none()
            || node.children.iter().any(|c| !any_word(c) || !["abstractNumId", "lvlOverride"].contains(&c.local_name.as_str()))
            || node.children.iter().filter(|c| is_word(c, "abstractNumId")).count() != 1;
        if bad {
            out.problem = Some("Numbering instance is missing or unsupported.");
            return Ok(out);
        }
        let mut levels = abstract_levels.cloned().unwrap_or_default();
        for o in node.children.iter().filter(|n| is_word(n, "lvlOverride")) {
            let unsupported = "Numbering level override is unsupported.";
            let Some(level) = bounded_int(own(Some(o), "ilvl"), 0, 8) else {
                out.problem = Some(unsupported);
                return Ok(out);
            };
            if let Some(replacement) = word_child(Some(o), "lvl") {
                match parse_level(replacement) {
                    Some((l, d)) if l == level => {
                        levels.insert(level, d);
                    }
                    _ => {
                        out.problem = Some(unsupported);
                        return Ok(out);
                    }
                }
            } else if let Some(raw) = val(word_child(Some(o), "startOverride")) {
                let start = bounded_int(Some(raw), 0, 999_999);
                match (start, levels.get(&level).copied()) {
                    (Some(s), Some(base)) => {
                        levels.insert(level, NumberingLevel { start: s, ..base });
                    }
                    _ => {
                        out.problem = Some(unsupported);
                        return Ok(out);
                    }
                }
            }
        }
        let id = id.unwrap_or("").to_string();
        out.definition_order.push(id.clone());
        out.definitions.insert(id, levels);
    }
    Ok(out)
}

fn ensure_docx_list(state: &State, kind: ListKind) -> Result<(State, String)> {
    let inspected = inspect_docx_numbering(state)?;
    if let Some(p) = inspected.problem {
        return Err(invalid("unsupported-numbering", p));
    }
    // TypeScript's Map reuses the first matching instance in the document.
    if let Some(id) = inspected.definition_order.iter().find(|id| {
        inspected.definitions[*id].get(&0).is_some_and(|level| level.kind == kind)
    }) {
        return Ok((state.clone(), id.clone()));
    }
    let namespace = parse_xml(&state.source)?.namespace;
    let (ensured, name) = ensure_docx_part(
        state,
        "numbering",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
        &format!("<w:numbering xmlns:w=\"{namespace}\"/>"),
        &namespace,
    )?;
    let source = docx_part_source(&ensured, &name)?.unwrap_or_default();
    let root = parse_xml(&source)?;
    let abstract_id = root
        .children
        .iter()
        .filter(|n| is_word(n, "abstractNum"))
        .map(|n| own(Some(n), "abstractNumId").and_then(|v| v.parse::<i64>().ok()).unwrap_or(-1))
        .fold(-1, i64::max)
        + 1;
    let id = inspected.definitions.keys().filter_map(|k| k.parse::<i64>().ok()).fold(0, i64::max) + 1;
    let (format, text) = if kind == ListKind::Bullet { ("bullet", "•") } else { ("decimal", "%1.") };
    let abstract_xml = format!(
        "<w:abstractNum xmlns:w=\"{namespace}\" w:abstractNumId=\"{abstract_id}\"><w:multiLevelType w:val=\"singleLevel\"/><w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{format}\"/><w:lvlText w:val=\"{text}\"/><w:suff w:val=\"space\"/></w:lvl></w:abstractNum>"
    );
    let num = format!("<w:num xmlns:w=\"{namespace}\" w:numId=\"{id}\"><w:abstractNumId w:val=\"{abstract_id}\"/></w:num>");
    // Abstract definitions must precede all instance definitions in the schema.
    let with_abstract = match root.children.iter().find(|n| is_word(n, "num")) {
        Some(first) => format!("{}{abstract_xml}{}", &source[..first.start], &source[first.start..]),
        None => append_docx_xml(&source, &abstract_xml)?,
    };
    let mut next = state.clone();
    next.part_overrides = ensured.part_overrides.clone();
    next.part_overrides.set(&name, append_docx_xml(&with_abstract, &num)?.into_bytes());
    Ok((next, id.to_string()))
}

pub(crate) fn set_docx_list(state: &State, paragraph_id: &str, kind: Option<ListKind>) -> Result<State> {
    let (next, id) = match kind {
        None => (state.clone(), String::new()),
        Some(k) => ensure_docx_list(state, k)?,
    };
    let root = parse_xml(&next.source)?;
    let paragraph = xml_descendants(&root)
        .into_iter()
        .find(|n| is_word(n, "p") && next.identities.get(&n.start).is_some_and(|x| x == paragraph_id))
        .ok_or_else(|| invalid("invalid-edit", "Unknown paragraph identity."))?;
    let current = word_child(word_child(Some(paragraph), "pPr"), "numPr");
    let content = if kind.is_none() { String::new() } else { format!("<w:numPr xmlns:w=\"{}\"><w:ilvl w:val=\"0\"/><w:numId w:val=\"{id}\"/></w:numPr>", paragraph.namespace) };
    if let Some(c) = current {
        return patch_docx_source(&next, vec![Patch::new(c.start, c.end, content)]);
    }
    if content.is_empty() {
        return Ok(next);
    }
    let patch = property_patch(&next, paragraph, "pPr", &[("numPr", Some(content))], P_ORDER)?;
    patch_docx_source(&next, vec![patch])
}

// ---- comments ----

fn id_of(node: &XmlElement) -> Option<&str> {
    xml_attribute(node, "id", &node.namespace)
}

pub(crate) struct CommentInspection {
    pub comments: Vec<Comment>,
    pub problem: Option<&'static str>,
}

pub(crate) fn inspect_docx_comments(state: &State) -> Result<CommentInspection> {
    let fail = |p: &'static str| Ok(CommentInspection { comments: vec![], problem: Some(p) });
    let root = parse_xml(&state.source)?;
    let all = xml_descendants(&root);
    let anchors: Vec<&XmlElement> =
        all.iter().copied().filter(|n| any_word(n) && ["commentRangeStart", "commentRangeEnd", "commentReference"].contains(&n.local_name.as_str())).collect();
    let name = related_docx_part(state, "comments")?;
    let source = match &name {
        Some(n) => docx_part_source(state, n)?,
        None => None,
    };
    let Some(source) = source else {
        return if anchors.is_empty() { Ok(CommentInspection { comments: vec![], problem: None }) } else { fail("Comment anchors have no comments part.") };
    };
    let comments_root = parse_xml(&source)?;
    if !is_word(&comments_root, "comments") || comments_root.namespace != root.namespace || !ws_only(&comments_root.text) || comments_root.children.len() > 1000 {
        return fail("Unsupported or oversized comments part.");
    }
    let mut ids: HashSet<String> = HashSet::new();
    let mut comments = Vec::new();
    for node in &comments_root.children {
        let id = id_of(node);
        let allowed_children = |name: &str| -> &'static [&'static str] {
            match name {
                "comment" => &["p"],
                "p" => &["r"],
                "r" => &["t"],
                _ => &[],
            }
        };
        let id_ok = id.is_some_and(|i| canonical(i, 10, true) && i.parse::<u64>().unwrap_or(u64::MAX) <= 2_147_483_647 && !ids.contains(i));
        let structure_bad = !is_word(node, "comment")
            || !id_ok
            || node.children.is_empty()
            || node.children.iter().any(|p| !is_word(p, "p"))
            || !ws_only(&node.text)
            || xml_descendants(node).iter().any(|n| {
                !any_word(n)
                    || n.namespace != root.namespace
                    || !["comment", "p", "r", "t"].contains(&n.local_name.as_str())
                    || n.children.iter().any(|c| !allowed_children(&n.local_name).contains(&c.local_name.as_str()))
                    || (n.local_name != "t" && !ws_only(&n.text))
                    || n.attributes.iter().any(|a| {
                        a.namespace != XMLNS_NAMESPACE
                            && !(a.namespace == node.namespace && ["id", "author", "initials", "date"].contains(&a.local_name.as_str()) && n.start == node.start)
                            && !(is_word(n, "t") && a.namespace == XML_NAMESPACE && a.local_name == "space")
                    })
            });
        if structure_bad {
            return fail("Read-only: comments contain unsupported formatting, identity or thread state.");
        }
        let id = id.unwrap_or("");
        ids.insert(id.to_string());
        let matches: Vec<&XmlElement> = anchors.iter().copied().filter(|a| id_of(a) == Some(id)).collect();
        let count = |n: &str| matches.iter().filter(|m| is_word(m, n)).count();
        if matches.len() != 3 || count("commentRangeStart") != 1 || count("commentRangeEnd") != 1 || count("commentReference") != 1 {
            return fail("Read-only: comments need one complete paragraph anchor.");
        }
        let start = matches.iter().find(|n| is_word(n, "commentRangeStart")).unwrap();
        let end = matches.iter().find(|n| is_word(n, "commentRangeEnd")).unwrap();
        let reference = matches.iter().find(|n| is_word(n, "commentReference")).unwrap();
        let paragraph = all.iter().find(|n| is_word(n, "p") && n.has_child(start.start) && n.has_child(end.start));
        let reference_run = paragraph.and_then(|p| p.children.iter().find(|n| is_word(n, "r") && n.has_child(reference.start)));
        let text_runs: Vec<&XmlElement> = paragraph.map_or(vec![], |p| xml_descendants(p).into_iter().filter(|n| is_word(n, "r") && word_child(Some(n), "t").is_some()).collect());
        let ok = match (paragraph, reference_run) {
            (Some(p), Some(rr)) => {
                !text_runs.is_empty()
                    && start.end <= text_runs[0].start
                    && end.start >= text_runs[text_runs.len() - 1].end
                    && rr.start >= end.end
                    && rr.children.len() == 1
                    && state.identities.contains_key(&p.start)
            }
            _ => false,
        };
        if !ok {
            return fail("Read-only: comment range is not a supported whole-paragraph range.");
        }
        let paragraph = paragraph.unwrap();
        comments.push(Comment {
            id: id.to_string(),
            paragraph_id: state.identities[&paragraph.start].clone(),
            author: xml_attribute(node, "author", &node.namespace).unwrap_or("").to_string(),
            date: xml_attribute(node, "date", &node.namespace).map(str::to_string),
            text: node.children.iter().map(|p| xml_descendants(p).iter().filter(|n| is_word(n, "t")).map(|n| n.text.as_str()).collect::<String>()).collect::<Vec<_>>().join("\n"),
        });
    }
    if anchors.iter().any(|a| !ids.contains(id_of(a).unwrap_or(""))) {
        return fail("Read-only: comment anchor points to a missing comment.");
    }
    Ok(CommentInspection { comments, problem: None })
}

/// UTC time as `YYYY-MM-DDTHH:MM:SS.mmmZ`, like `Date.prototype.toISOString`.
pub(crate) fn iso_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (now.as_secs() as i64, now.subsec_millis());
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub(crate) fn apply_docx_comment_operation(state: &State, operation: &Operation) -> Result<State> {
    let inspected = inspect_docx_comments(state)?;
    if let Some(p) = inspected.problem {
        return Err(invalid("unsupported-comments", p));
    }
    let root = parse_xml(&state.source)?;
    let namespace = root.namespace.clone();
    match operation {
        Operation::AddComment { paragraph_id, text, author } => {
            let units = |s: &str| s.chars().map(char::len_utf16).sum::<usize>();
            if text.trim().is_empty() || units(text) > 10000 || text.contains('\r') || author.trim().is_empty() || units(author) > 128 || author.contains(['\r', '\n', '\t']) {
                return Err(invalid("invalid-comment", "Comments require an author and 1–10000 characters of text."));
            }
            escape_xml_text(text)?;
            escape_xml_text(author)?;
            let paragraph = xml_descendants(&root)
                .into_iter()
                .find(|n| is_word(n, "p") && state.identities.get(&n.start).is_some_and(|x| x == paragraph_id))
                .filter(|p| xml_descendants(p).iter().any(|n| is_word(n, "r") && word_child(Some(n), "t").is_some()))
                .ok_or_else(|| invalid("invalid-comment", "Comment requires a paragraph containing a text run."))?;
            let id = inspected.comments.iter().map(|c| c.id.parse::<i64>().unwrap_or(0)).fold(-1, i64::max) + 1;
            if id > 2_147_483_647 || inspected.comments.len() >= 1000 {
                return Err(invalid("comment-limit", "Too many comments."));
            }
            let (ensured, name) = ensure_docx_part(
                state,
                "comments",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
                &format!("<w:comments xmlns:w=\"{namespace}\"/>"),
                &namespace,
            )?;
            let mut lines = String::new();
            for line in text.split('\n') {
                lines.push_str(&format!("<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>", escape_xml_text(line)?));
            }
            let comment = format!("<w:comment xmlns:w=\"{namespace}\" w:id=\"{id}\" w:author=\"{}\" w:date=\"{}\">{lines}</w:comment>", xml_attribute_text(author)?, iso_now());
            let mut overrides = ensured.part_overrides.clone();
            overrides.set(&name, append_docx_xml(&docx_part_source(&ensured, &name)?.unwrap_or_default(), &comment)?.into_bytes());
            let runs: Vec<&XmlElement> = xml_descendants(paragraph).into_iter().filter(|n| is_word(n, "r") && word_child(Some(n), "t").is_some()).collect();
            let start = paragraph.children.iter().find(|n| n.start <= runs[0].start && n.end >= runs[0].end).unwrap().start;
            let last = runs[runs.len() - 1];
            let end = paragraph.children.iter().find(|n| n.start <= last.start && n.end >= last.end).unwrap().end;
            let mut next = patch_docx_source(
                state,
                vec![
                    Patch::new(start, start, format!("<w:commentRangeStart xmlns:w=\"{namespace}\" w:id=\"{id}\"/>")),
                    Patch::new(end, end, format!("<w:commentRangeEnd xmlns:w=\"{namespace}\" w:id=\"{id}\"/><w:r xmlns:w=\"{namespace}\"><w:commentReference w:id=\"{id}\"/></w:r>")),
                ],
            )?;
            next.part_overrides = overrides;
            Ok(next)
        }
        Operation::DeleteComment { comment_id } => {
            let comment = inspected.comments.iter().find(|c| &c.id == comment_id).ok_or_else(|| invalid("invalid-comment", "Unknown comment identity."))?;
            let name = related_docx_part(state, "comments")?.unwrap_or_default();
            let source = docx_part_source(state, &name)?.unwrap_or_default();
            let comments_root = parse_xml(&source)?;
            let node = comments_root.children.iter().find(|n| id_of(n) == Some(comment.id.as_str())).unwrap();
            let mut overrides = state.part_overrides.clone();
            overrides.set(&name, format!("{}{}", &source[..node.start], &source[node.end..]).into_bytes());
            let mut patches = Vec::new();
            for marker in xml_descendants(&root).into_iter().filter(|n| any_word(n) && ["commentRangeStart", "commentRangeEnd", "commentReference"].contains(&n.local_name.as_str()) && id_of(n) == Some(comment.id.as_str())) {
                let target = if is_word(marker, "commentReference") {
                    xml_descendants(&root).into_iter().find(|n| is_word(n, "r") && n.has_child(marker.start)).unwrap_or(marker)
                } else {
                    marker
                };
                patches.push(Patch::new(target.start, target.end, ""));
            }
            let mut next = patch_docx_source(state, patches)?;
            next.part_overrides = overrides;
            Ok(next)
        }
        _ => Err(invalid("invalid-edit", "Unsupported document operation.")),
    }
}

// ---- revisions ----

#[derive(Clone, Debug)]
pub(crate) struct RevisionRange {
    pub revision: Revision,
    pub node: XmlElement,
    pub paragraph_start: usize,
    pub paragraph_end: usize,
}

pub(crate) struct RevisionInspection {
    pub ranges: Vec<RevisionRange>,
    pub problem: Option<&'static str>,
}

fn valid_date(value: &str) -> bool {
    let b = value.as_bytes();
    let num = |a: usize, n: usize| -> Option<u32> { value.get(a..a + n).filter(|s| s.bytes().all(|c| c.is_ascii_digit())).and_then(|s| s.parse().ok()) };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return false;
    }
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (num(0, 4), num(5, 2), num(8, 2), num(11, 2), num(14, 2), num(17, 2)) else {
        return false;
    };
    let mut rest = &value[19..];
    if let Some(f) = rest.strip_prefix('.') {
        let n = f.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=7).contains(&n) {
            return false;
        }
        rest = &f[n..];
    }
    let zone_ok = if rest == "Z" {
        true
    } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) && &rest[3..4] == ":" {
        match (rest[1..3].parse::<u32>(), rest[4..6].parse::<u32>()) {
            (Ok(h), Ok(m)) if rest[1..3].bytes().all(|c| c.is_ascii_digit()) && rest[4..6].bytes().all(|c| c.is_ascii_digit()) => h <= 14 && m <= 59 && (h != 14 || m == 0),
            _ => false,
        }
    } else {
        false
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    // Date.parse also rejects hour 24 and the like; these bounds cover it.
    zone_ok && year >= 1 && (1..=12).contains(&month) && day >= 1 && day <= days[(month.max(1) - 1) as usize] && hour <= 23 && minute <= 59 && second <= 59
}

pub(crate) fn inspect_docx_revisions(state: &State) -> Result<RevisionInspection> {
    let fail = |p| Ok(RevisionInspection { ranges: vec![], problem: Some(p) });
    let root = parse_xml(&state.source)?;
    let all = xml_descendants(&root);
    let nodes: Vec<&XmlElement> = all.iter().copied().filter(|n| any_word(n) && (n.local_name == "ins" || n.local_name == "del")).collect();
    if nodes.len() > 2000 {
        return fail("Too many tracked ranges.");
    }
    let mut ranges = Vec::new();
    let mut ids: HashSet<String> = HashSet::new();
    for node in nodes {
        let paragraph = all.iter().find(|n| is_word(n, "p") && n.has_child(node.start));
        let id = own(Some(node), "id");
        let author = own(Some(node), "author");
        let date = own(Some(node), "date");
        let kind = if node.local_name == "ins" { "t" } else { "delText" };
        let bad = paragraph.is_none_or(|p| node.namespace != p.namespace)
            || !id.is_some_and(|i| canonical(i, 10, true) && i.parse::<u64>().unwrap_or(u64::MAX) <= 2_147_483_647 && !ids.contains(i))
            || !author.is_some_and(|a| !a.trim().is_empty() && a.chars().map(char::len_utf16).sum::<usize>() <= 255 && !a.contains(['\r', '\n', '\t']))
            || !date.is_some_and(valid_date)
            || !ws_only(&node.text)
            || node.children.is_empty()
            || node.attributes.iter().any(|a| a.namespace != XMLNS_NAMESPACE && !(a.namespace == node.namespace && ["id", "author", "date"].contains(&a.local_name.as_str())))
            || node.children.iter().any(|r| {
                !is_word(r, "r") || r.namespace != node.namespace || r.children.iter().filter(|c| is_word(c, kind)).count() != 1 || r.children.iter().any(|c| !is_word(c, "rPr") && !is_word(c, kind))
            });
        if bad {
            return fail("Only direct, authored and dated plain-run insertion/deletion ranges are editable.");
        }
        let paragraph = paragraph.unwrap();
        ids.insert(id.unwrap().to_string());
        ranges.push(RevisionRange {
            revision: Revision {
                id: id.unwrap().to_string(),
                paragraph_id: state.identities.get(&paragraph.start).cloned().unwrap_or_default(),
                kind: if node.local_name == "ins" { RevisionKind::Insertion } else { RevisionKind::Deletion },
                author: author.unwrap().to_string(),
                date: date.unwrap().to_string(),
                text: node.children.iter().map(|r| word_child(Some(r), kind).map_or("", |t| t.text.as_str())).collect(),
            },
            node: node.clone(),
            paragraph_start: paragraph.start,
            paragraph_end: paragraph.end,
        });
    }
    for text in all.iter().filter(|n| is_word(n, "delText")) {
        if !ranges.iter().any(|r| r.revision.kind == RevisionKind::Deletion && text.start > r.node.start && text.end < r.node.end) {
            return fail("Deleted text has no supported deletion owner.");
        }
    }
    Ok(RevisionInspection { ranges, problem: None })
}

/// Renames `from` text nodes inside a run to `to`, keeping their prefixes.
fn rename_text(source: &str, run: &XmlElement, from: &str, to: &str) -> String {
    let mut result = source[run.start..run.end].to_string();
    let targets: Vec<&XmlElement> = xml_descendants(run).into_iter().filter(|n| is_word(n, from)).collect();
    for text in targets.into_iter().rev() {
        let prefix = text.name.split_once(':').map_or(String::new(), |(p, _)| format!("{p}:"));
        let name = format!("{prefix}{to}");
        let opening = format!("<{name}{}", &source[text.start + 1 + text.name.len()..text.start_tag_end]);
        let replaced = if text.self_closing() {
            opening
        } else {
            format!("{opening}{}</{name}{}", &source[text.start_tag_end..text.end_tag_start], &source[text.end_tag_start + 2 + text.name.len()..text.end])
        };
        result = format!("{}{replaced}{}", &result[..text.start - run.start], &result[text.end - run.start..]);
    }
    result
}

fn attach_run_namespaces(raw: &str, run: &XmlElement, owner: &XmlElement) -> Result<String> {
    let own_names: HashSet<&str> = run.attributes.iter().filter(|a| a.namespace == XMLNS_NAMESPACE).map(|a| a.name.as_str()).collect();
    let mut additions = String::new();
    for a in owner.attributes.iter().filter(|a| a.namespace == XMLNS_NAMESPACE && !own_names.contains(a.name.as_str())) {
        additions.push_str(&format!(" {}=\"{}\"", a.name, xml_attribute_text(&a.value)?));
    }
    if additions.is_empty() {
        return Ok(raw.to_string());
    }
    let opening_end = run.start_tag_end - run.start - 1;
    let head = &raw[..opening_end];
    let head = head.strip_suffix('/').unwrap_or(head);
    Ok(format!("{head}{additions}>{}", &raw[opening_end + 1..]))
}

fn own_run_namespaces(source: &str, run: &XmlElement, owner: &XmlElement, deleted: bool) -> Result<String> {
    let raw = if deleted { rename_text(source, run, "delText", "t") } else { source[run.start..run.end].to_string() };
    attach_run_namespaces(&raw, run, owner)
}

fn restored_range(source: &str, range: &RevisionRange, accept: bool) -> Result<String> {
    let deletion = range.revision.kind == RevisionKind::Deletion;
    let keep = if accept { !deletion } else { deletion };
    if !keep {
        return Ok(String::new());
    }
    range.node.children.iter().map(|run| own_run_namespaces(source, run, &range.node, deletion)).collect()
}

/// Derived display/validation view only; never exported instead of the source.
pub(crate) fn project_docx_revision_view(state: &State, final_view: bool) -> Result<State> {
    let inspected = inspect_docx_revisions(state)?;
    if let Some(p) = inspected.problem {
        return Err(invalid("unsupported-revisions", p));
    }
    if inspected.ranges.is_empty() {
        return Ok(state.clone());
    }
    let patches: Vec<Patch> =
        inspected.ranges.iter().map(|r| Ok(Patch::new(r.node.start, r.node.end, restored_range(&state.source, r, final_view)?))).collect::<Result<_>>()?;
    let mut next = patch_docx_source(state, patches)?;
    // A whole-paragraph deletion can leave a point comment with no text runs.
    let root = parse_xml(&next.source)?;
    let mut empty = Vec::new();
    for paragraph in xml_descendants(&root).into_iter().filter(|n| is_word(n, "p")) {
        if !paragraph.children.iter().any(|n| is_word(n, "r") && word_child(Some(n), "t").is_some()) {
            let end = paragraph.children.iter().find(|n| is_word(n, "commentRangeEnd")).map_or(paragraph.end_tag_start, |n| n.start);
            if !paragraph.self_closing() && end >= paragraph.start_tag_end {
                empty.push(Patch::new(end, end, format!("<w:r xmlns:w=\"{}\"><w:t xml:space=\"preserve\"/></w:r>", paragraph.namespace)));
            }
        }
    }
    if !empty.is_empty() {
        next = patch_docx_source(&next, empty)?;
    }
    Ok(next)
}

fn replace_text_run(source: &str, run: Option<&XmlElement>, namespace: &str, text: &str) -> Result<String> {
    let Some(run) = run else {
        return Ok(format!("<w:r xmlns:w=\"{namespace}\"><w:t xml:space=\"preserve\">{}</w:t></w:r>", escape_xml_text(text)?));
    };
    let props = word_child(Some(run), "rPr").map_or("", |p| &source[p.start..p.end]);
    Ok(format!("{}{props}<w:t xmlns:w=\"{namespace}\" xml:space=\"preserve\">{}</w:t></{}>", open_tag(source, run), escape_xml_text(text)?, run.name))
}

pub(crate) fn apply_docx_revision_operation(state: &State, operation: &Operation) -> Result<State> {
    let inspected = inspect_docx_revisions(state)?;
    if let Some(p) = inspected.problem {
        return Err(invalid("unsupported-revisions", p));
    }
    if let Operation::TrackParagraphText { paragraph_id, text, author } = operation {
        return track_paragraph(state, &inspected, paragraph_id, text, author);
    }
    let all = matches!(operation, Operation::AcceptAllRevisions | Operation::RejectAllRevisions);
    let accept = matches!(operation, Operation::AcceptRevision { .. } | Operation::AcceptAllRevisions);
    let id = match operation {
        Operation::AcceptRevision { revision_id } | Operation::RejectRevision { revision_id } => Some(revision_id.as_str()),
        _ => None,
    };
    let selected: Vec<&RevisionRange> = inspected.ranges.iter().filter(|r| all || Some(r.revision.id.as_str()) == id).collect();
    if !all && selected.is_empty() {
        return Err(invalid("invalid-revision", "Unknown revision identity."));
    }
    let patches: Vec<Patch> = selected.iter().map(|r| Ok(Patch::new(r.node.start, r.node.end, restored_range(&state.source, r, accept)?))).collect::<Result<_>>()?;
    let mut next = patch_docx_source(state, patches)?;
    let root = parse_xml(&next.source)?;
    let mut empties = Vec::new();
    for paragraph in xml_descendants(&root).into_iter().filter(|n| is_word(n, "p")) {
        let pid = next.identities.get(&paragraph.start).cloned();
        let Some(range) = selected.iter().find(|r| Some(&r.revision.paragraph_id) == pid.as_ref()) else { continue };
        if !paragraph.children.iter().any(|n| is_word(n, "ins") || is_word(n, "del") || (is_word(n, "r") && word_child(Some(n), "t").is_some())) {
            let run = &range.node.children[0];
            let empty = attach_run_namespaces(&replace_text_run(&state.source, Some(run), &paragraph.namespace, "")?, run, &range.node)?;
            let offset = paragraph.children.iter().find(|n| is_word(n, "commentRangeEnd")).map_or(paragraph.end_tag_start, |n| n.start);
            empties.push(Patch::new(offset, offset, empty));
        }
    }
    if !empties.is_empty() {
        next = patch_docx_source(&next, empties)?;
    }
    Ok(next)
}

fn track_paragraph(state: &State, inspected: &RevisionInspection, paragraph_id: &str, text: &str, author: &str) -> Result<State> {
    let units = |s: &str| s.chars().map(char::len_utf16).sum::<usize>();
    if units(text) > 200_000 || text.contains(['\r', '\n', '\t']) || author.trim().is_empty() || units(author) > 255 || author.contains(['\r', '\n', '\t']) {
        return Err(invalid("invalid-revision", "Tracked paragraph text requires one paragraph and a valid author."));
    }
    escape_xml_text(text)?;
    escape_xml_text(author)?;
    let root = parse_xml(&state.source)?;
    let paragraph = xml_descendants(&root)
        .into_iter()
        .find(|n| is_word(n, "p") && state.identities.get(&n.start).is_some_and(|x| x == paragraph_id))
        .ok_or_else(|| invalid("invalid-revision", "Unknown paragraph identity."))?;
    if xml_descendants(paragraph).iter().any(|n| is_word(n, "drawing")) {
        return Err(invalid("unsupported-revision", "Paragraph text tracking cannot replace inline pictures."));
    }
    let current: Vec<&RevisionRange> = inspected.ranges.iter().filter(|r| r.revision.paragraph_id == paragraph_id).collect();
    let direct_runs: Vec<&XmlElement> = paragraph.children.iter().filter(|n| is_word(n, "r") && word_child(Some(n), "t").is_some()).collect();
    let kinds: HashSet<RevisionKind> = current.iter().map(|r| r.revision.kind).collect();
    if !current.is_empty()
        && (current.len() > 2
            || current.iter().any(|r| r.revision.author != author)
            || kinds.len() != current.len()
            || direct_runs.iter().any(|r| !word_child(Some(r), "t").unwrap().text.is_empty()))
    {
        return Err(invalid("unsupported-revision", "Resolve existing paragraph revisions before tracking another author's replacement."));
    }
    let previous_deleted = current.iter().find(|r| r.revision.kind == RevisionKind::Deletion).copied();
    let previous_inserted = current.iter().find(|r| r.revision.kind == RevisionKind::Insertion).copied();
    let original_text = match previous_deleted {
        Some(d) => d.revision.text.clone(),
        None if current.is_empty() => direct_runs.iter().map(|r| word_child(Some(r), "t").unwrap().text.as_str()).collect(),
        None => String::new(),
    };
    let displayed = match previous_inserted {
        Some(i) => i.revision.text.clone(),
        None if current.is_empty() => original_text.clone(),
        None => String::new(),
    };
    if displayed == text {
        return Ok(state.clone());
    }
    let namespace = &paragraph.namespace;
    let mut next_id: u64 = state.next_revision_id.unwrap_or_else(|| (inspected.ranges.iter().map(|r| r.revision.id.parse::<i64>().unwrap_or(0)).fold(-1, i64::max) + 1) as u64);
    let mut allocate = || -> Result<String> {
        if next_id > 2_147_483_647 {
            return Err(invalid("revision-limit", "Revision identity limit reached."));
        }
        let id = next_id.to_string();
        next_id += 1;
        Ok(id)
    };
    let date = iso_now();
    let deletion_id = match previous_deleted {
        Some(d) => Some(d.revision.id.clone()),
        None if !original_text.is_empty() => Some(allocate()?),
        None => None,
    };
    let insertion_id = match previous_inserted {
        Some(i) => Some(i.revision.id.clone()),
        None if !text.is_empty() => Some(allocate()?),
        None => None,
    };
    let deletion_runs: String = match previous_deleted {
        Some(d) => d.node.children.iter().map(|r| own_run_namespaces(&state.source, r, &d.node, false)).collect::<Result<String>>()?,
        None => direct_runs.iter().map(|r| rename_text(&state.source, r, "t", "delText")).collect(),
    };
    let baseline_run = previous_deleted.map(|d| &d.node.children[0]).or(direct_runs.first().copied()).or(previous_inserted.map(|i| &i.node.children[0]));
    let baseline_owner = previous_deleted.map(|d| &d.node).or(previous_inserted.map(|i| &i.node));
    let insertion_run = replace_text_run(&state.source, baseline_run, namespace, text)?;
    let owned_insertion = match (baseline_run, baseline_owner) {
        (Some(r), Some(o)) => attach_run_namespaces(&insertion_run, r, o)?,
        _ => insertion_run,
    };
    let author_text = xml_attribute_text(author)?;
    let deleted = match &deletion_id {
        None => String::new(),
        Some(id) => format!(
            "<w:del xmlns:w=\"{namespace}\" w:id=\"{id}\" w:author=\"{author_text}\" w:date=\"{}\">{deletion_runs}</w:del>",
            previous_deleted.map_or(date.clone(), |d| if d.revision.date.is_empty() { date.clone() } else { d.revision.date.clone() })
        ),
    };
    let inserted = match &insertion_id {
        Some(id) if !text.is_empty() => format!("<w:ins xmlns:w=\"{namespace}\" w:id=\"{id}\" w:author=\"{author_text}\" w:date=\"{date}\">{owned_insertion}</w:ins>"),
        _ => String::new(),
    };
    let empty_run = if deleted.is_empty() && inserted.is_empty() {
        let run = replace_text_run(&state.source, baseline_run, namespace, "")?;
        match (baseline_run, baseline_owner) {
            (Some(r), Some(o)) => attach_run_namespaces(&run, r, o)?,
            _ => run,
        }
    } else {
        String::new()
    };
    let props = word_child(Some(paragraph), "pPr").map_or("", |p| &state.source[p.start..p.end]);
    let starts: String = paragraph.children.iter().filter(|n| is_word(n, "commentRangeStart")).map(|n| &state.source[n.start..n.end]).collect();
    let ends: String = paragraph
        .children
        .iter()
        .filter(|n| is_word(n, "commentRangeEnd") || (is_word(n, "r") && word_child(Some(n), "commentReference").is_some()))
        .map(|n| &state.source[n.start..n.end])
        .collect();
    let contents = format!("{props}{starts}{deleted}{inserted}{empty_run}{ends}");
    let patch = if paragraph.self_closing() {
        Patch::keep(paragraph.start, paragraph.end, format!("{}{contents}</{}>", open_tag(&state.source, paragraph), paragraph.name))
    } else {
        Patch::new(paragraph.start_tag_end, paragraph.end_tag_start, contents)
    };
    let mut next = patch_docx_source(state, vec![patch])?;
    next.next_revision_id = Some(next_id);
    Ok(next)
}

/// Offsets are the snapshot's visible paragraph text (UTF-8 bytes here).
pub(crate) fn format_docx_text_range(state: &State, paragraph_id: &str, start: usize, end: usize, style: &RunFormat) -> Result<State> {
    let root = parse_xml(&state.source)?;
    let paragraph = xml_descendants(&root)
        .into_iter()
        .find(|p| is_word(p, "p") && state.identities.get(&p.start).is_some_and(|x| x == paragraph_id))
        .ok_or_else(|| invalid("invalid-edit", "Unknown paragraph identity."))?;
    if xml_descendants(paragraph).iter().any(|n| any_word(n) && (n.local_name == "ins" || n.local_name == "del")) {
        return Err(invalid("unsupported-edit", "Resolve paragraph revisions before changing inline formatting."));
    }
    let runs: Vec<&XmlElement> = xml_descendants(paragraph).into_iter().filter(|n| is_word(n, "r")).collect();
    let text: String = runs.iter().map(|r| docx_inline_text(r, false)).collect();
    if end <= start || end > text.len() {
        return Err(invalid("invalid-range", "Select a nonempty text range inside one paragraph."));
    }
    if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
        return Err(invalid("invalid-range", "Selection cannot split a Unicode character."));
    }
    let mut cursor = 0;
    let mut selected: Vec<(String, usize, usize)> = Vec::new();
    for run in &runs {
        let content = docx_inline_text(run, false);
        let local_start = start.saturating_sub(cursor);
        let local_end = content.len().min(end.saturating_sub(cursor));
        if local_start < local_end {
            if run.children.iter().any(|c| !is_word(c, "rPr") && !is_word(c, "t")) || run.children.iter().filter(|c| is_word(c, "t")).count() != 1 {
                return Err(invalid("unsupported-edit", "Selection intersects a mixed text/object run."));
            }
            selected.push((state.identities.get(&run.start).cloned().unwrap_or_default(), local_start, local_end));
        }
        cursor += content.len();
    }
    let mut next = state.clone();
    for (id, a, b) in selected.into_iter().rev() {
        let root = parse_xml(&next.source)?;
        let current = xml_descendants(&root).into_iter().find(|r| is_word(r, "r") && next.identities.get(&r.start) == Some(&id)).expect("run");
        let text_node = word_child(Some(current), "t").expect("t");
        let fragment = |t: &str| docx_run_text_fragment(&next.source, current, text_node, t);
        let prefix = if a > 0 { fragment(&text_node.text[..a])? } else { String::new() };
        let middle = fragment(&text_node.text[a..b])?;
        let suffix = if b < text_node.text.len() { fragment(&text_node.text[b..])? } else { String::new() };
        let selected_offset = current.start + prefix.len();
        let mut split = patch_docx_source(&next, vec![Patch::keep(current.start, current.end, format!("{prefix}{middle}{suffix}"))])?;
        if !split.identities.contains_key(&selected_offset) {
            let fresh = split.fresh("r~");
            split.identities.insert(selected_offset, fresh);
        }
        let selected_id = split.identities[&selected_offset].clone();
        next = apply_docx_xml_operation(&split, &Operation::FormatRun { run_id: selected_id, style: style.clone() })?;
    }
    Ok(next)
}

#[allow(dead_code)]
pub(crate) fn parent_of<'a>(root: &'a XmlElement, node: &XmlElement) -> Option<&'a XmlElement> {
    xml_parent(root, node.start)
}
