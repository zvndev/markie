//! Source-splice paragraph transactions (split, join, range replace). Ported
//! from `docx-structure.ts`. A split copies pPr verbatim to both halves; the
//! clone only drops w14 paraId/textId (MS-DOCX 2.6).

use super::State;
use super::edit::*;
use crate::error::{OfficeError, Result};
use crate::model::{Paragraph, TextPosition, TextRange};
use crate::xml::{XMLNS_NAMESPACE, XmlElement, escape_xml_text, parse_xml, xml_descendants, xml_parent};
use std::collections::BTreeMap;

const W14: &str = "http://schemas.microsoft.com/office/word/2010/wordml";

fn fail(message: &str) -> OfficeError {
    invalid("unsupported-structure", message)
}

/// Whether `offset` (a byte offset on a char boundary) is a grapheme boundary.
/// Approximates UAX #29 extended grapheme clusters without a Unicode data
/// dependency: combining marks, variation selectors, ZWJ sequences, emoji
/// modifiers, regional-indicator pairs, Hangul syllable jamo and CRLF.
pub fn grapheme_boundary(text: &str, offset: usize) -> bool {
    if offset == 0 || offset >= text.len() {
        return offset <= text.len() && text.is_char_boundary(offset);
    }
    if !text.is_char_boundary(offset) {
        return false;
    }
    let before = text[..offset].chars().next_back().unwrap_or(' ');
    let after = text[offset..].chars().next().unwrap_or(' ');
    if before == '\r' && after == '\n' {
        return false;
    }
    let extend = |c: char| {
        let u = c as u32;
        matches!(u, 0x0300..=0x036f | 0x0483..=0x0489 | 0x0591..=0x05bd | 0x0610..=0x061a | 0x064b..=0x065f | 0x0670 | 0x06d6..=0x06dc
            | 0x0900..=0x0903 | 0x093a..=0x094f | 0x0e31 | 0x0e34..=0x0e3a | 0x0e47..=0x0e4e | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff
            | 0x200c | 0x200d | 0x20d0..=0x20ff | 0xfe00..=0xfe0f | 0xfe20..=0xfe2f | 0x1f3fb..=0x1f3ff | 0xe0020..=0xe007f | 0xe0100..=0xe01ef)
    };
    if extend(after) || before == '\u{200d}' {
        return false;
    }
    let regional = |c: char| (0x1f1e6..=0x1f1ff).contains(&(c as u32));
    if regional(before) && regional(after) {
        let run = text[..offset].chars().rev().take_while(|c| regional(*c)).count();
        return run % 2 == 0;
    }
    let jamo = |c: char| matches!(c as u32, 0x1100..=0x11ff | 0xac00..=0xd7a3);
    let trailing = |c: char| matches!(c as u32, 0x1160..=0x11ff);
    !(jamo(before) && trailing(after))
}

pub(crate) fn normalize_docx_range(paragraphs: &[Paragraph], range: &TextRange) -> Result<(TextPosition, TextPosition)> {
    let check = |position: &TextPosition| -> Result<usize> {
        let index = paragraphs.iter().position(|p| p.id == position.paragraph_id);
        let Some(index) = index.filter(|i| position.offset <= paragraphs[*i].text.len()) else {
            return Err(invalid("invalid-range", "Selection endpoint is outside the document."));
        };
        if !grapheme_boundary(&paragraphs[index].text, position.offset) {
            return Err(invalid("invalid-range", "Selection cannot split a grapheme."));
        }
        Ok(index)
    };
    let (a, b) = (check(&range.anchor)?, check(&range.focus)?);
    Ok(if a < b || (a == b && range.anchor.offset <= range.focus.offset) { (range.anchor.clone(), range.focus.clone()) } else { (range.focus.clone(), range.anchor.clone()) })
}

pub(crate) struct RangeResult {
    pub state: State,
    pub paragraph_id: String,
    pub offset: usize,
}

/// Validates every owner before preparing a single source patch. Paragraphs
/// with section marks, inline objects, fields or several text nodes per run
/// are refused rather than restructured.
pub(crate) fn replace_docx_source_range(state: &State, start: &TextPosition, end: &TextPosition, text: &str) -> Result<RangeResult> {
    let root = parse_xml(&state.source)?;
    let all = xml_descendants(&root);
    let paragraphs: Vec<&XmlElement> = all.iter().copied().filter(|n| is_word(n, "p")).collect();
    let id_of = |n: &XmlElement| state.identities.get(&n.start).cloned();
    let first = paragraphs.iter().copied().find(|p| id_of(p).as_deref() == Some(start.paragraph_id.as_str()));
    let last = paragraphs.iter().copied().find(|p| id_of(p).as_deref() == Some(end.paragraph_id.as_str()));
    let (Some(first), Some(last)) = (first, last) else {
        return Err(invalid("invalid-range", "Unknown source paragraph."));
    };
    let parent = xml_parent(&root, first.start).ok_or_else(|| invalid("invalid-range", "Source paragraph owner is missing."))?;
    if (!is_word(parent, "body") && !is_word(parent, "tc")) || !parent.has_child(last.start) {
        return Err(fail("Selection must stay within one document body or table cell."));
    }
    let i0 = parent.children.iter().position(|c| c.start == first.start).unwrap();
    let i1 = parent.children.iter().position(|c| c.start == last.start).unwrap();
    let siblings: Vec<&XmlElement> = parent.children[i0..=i1.max(i0)].iter().collect();
    if siblings.is_empty() || siblings.iter().any(|n| !is_word(n, "p")) {
        return Err(fail("Selection cannot cross a table or another structural owner."));
    }
    let raw = |n: &XmlElement| &state.source[n.start..n.end];
    let non_ws = |s: &str| s.chars().any(|c| !c.is_whitespace());
    let has_source_gaps = |node: &XmlElement| {
        let mut cursor = node.start_tag_end;
        for child in &node.children {
            if non_ws(&state.source[cursor..child.start]) {
                return true;
            }
            cursor = child.end;
        }
        !node.self_closing() && non_ws(&state.source[cursor..node.end_tag_start])
    };
    for pair in siblings.windows(2) {
        if non_ws(&state.source[pair[0].end..pair[1].start]) {
            return Err(fail("Unmodeled source gaps between paragraphs require preservation before structural editing."));
        }
    }
    let fields = scan_docx_fields(&root);
    if siblings.iter().any(|p| fields.paragraphs.contains(&p.start)) {
        return Err(fail("Paragraphs inside a field result (for example a table of contents) are regenerated by Word and cannot be split or joined."));
    }
    for paragraph in &siblings {
        if has_source_gaps(paragraph) || raw(paragraph).contains("<!--") {
            return Err(fail("Unmodeled paragraph source gaps or XML comments require preservation before structural editing."));
        }
        if word_child(word_child(Some(paragraph), "pPr"), "sectPr").is_some() {
            return Err(fail("Paragraph section boundaries require explicit mapping before structural editing."));
        }
        let runs = || paragraph.children.iter().filter(|n| is_word(n, "r"));
        if runs().any(|run| run.children.iter().filter(|n| is_word(n, "t")).count() > 1) {
            return Err(fail("Normalize multiple text nodes before structural editing."));
        }
        if paragraph.children.iter().any(|n| !is_word(n, "pPr") && !is_word(n, "r")) || runs().any(|run| run.children.iter().any(|n| !is_word(n, "rPr") && !is_word(n, "t"))) {
            return Err(fail("Resolve comments, revisions, hyperlinks, images or authored breaks before structural editing in their paragraph."));
        }
    }
    let property = |p: &XmlElement| word_child(Some(p), "pPr").map_or(String::new(), |x| raw(x).to_string());
    let lines: Vec<&str> = text.split('\n').collect();
    let last_length: usize = last.children.iter().filter(|n| is_word(n, "r")).map(|r| word_child(Some(r), "t").map_or(0, |t| t.text.len())).sum();
    // A suffix moved under a different pPr could silently change named-style inheritance.
    if first.start != last.start && lines.len() == 1 && end.offset < last_length && property(first) != property(last) {
        return Err(fail("Joining paragraphs with different paragraph properties would change suffix formatting."));
    }
    let fragment = |paragraph: &XmlElement, from: usize, to: usize| -> Result<String> {
        let mut cursor = 0;
        let mut out = String::new();
        for run in paragraph.children.iter().filter(|n| is_word(n, "r")) {
            let node = word_child(Some(run), "t");
            let value = node.map_or("", |t| t.text.as_str());
            // Empty formatting runs are authored too; a boundary run goes to the suffix.
            if value.is_empty() {
                if cursor >= from && cursor < to {
                    out.push_str(raw(run));
                }
                continue;
            }
            let a = from.saturating_sub(cursor);
            let b = value.len().min(to.saturating_sub(cursor));
            cursor += value.len();
            if a >= b {
                continue;
            }
            if a == 0 && b == value.len() {
                out.push_str(raw(run));
            } else {
                out.push_str(&docx_run_text_fragment(&state.source, run, node.unwrap(), &value[a..b])?);
            }
        }
        Ok(out)
    };
    let runs: Vec<&XmlElement> = first.children.iter().filter(|n| is_word(n, "r")).collect();
    let mut cursor = 0;
    let prototype = runs
        .iter()
        .copied()
        .find(|run| {
            cursor += word_child(Some(run), "t").map_or(0, |t| t.text.len());
            cursor >= start.offset
        })
        .or(runs.last().copied());
    let mut namespaces: BTreeMap<String, String> = BTreeMap::new();
    let mut ordered_ns: Vec<String> = Vec::new();
    for ancestor in all.iter().filter(|n| n.start <= first.start && n.end >= first.end) {
        for attr in ancestor.attributes.iter().filter(|a| a.namespace == XMLNS_NAMESPACE) {
            if namespaces.insert(attr.name.clone(), attr.value.clone()).is_none() {
                ordered_ns.push(attr.name.clone());
            }
        }
    }
    // The insertion run may enter a paragraph with different prefix bindings.
    let insert = |value: &str, retain_empty: bool| -> Result<String> {
        if value.is_empty() && !retain_empty {
            return Ok(String::new());
        }
        let Some(prototype) = prototype else {
            return Ok(format!("<w:r xmlns:w=\"{}\"><w:t xml:space=\"preserve\">{}</w:t></w:r>", first.namespace, escape_xml_text(value)?));
        };
        let text_node = word_child(Some(prototype), "t");
        let xml = match text_node {
            Some(t) => docx_run_text_fragment(&state.source, prototype, t, value)?,
            None => format!(
                "{}{}<w:t xmlns:w=\"{}\" xml:space=\"preserve\">{}</w:t></{}>",
                open_tag(&state.source, prototype),
                word_child(Some(prototype), "rPr").map_or("", |p| raw(p)),
                first.namespace,
                escape_xml_text(value)?,
                prototype.name
            ),
        };
        let existing: Vec<&str> = prototype.attributes.iter().filter(|a| a.namespace == XMLNS_NAMESPACE).map(|a| a.name.as_str()).collect();
        let mut bindings = String::new();
        for name in ordered_ns.iter().filter(|n| !existing.contains(&n.as_str())) {
            bindings.push_str(&format!(" {name}=\"{}\"", escape_xml_text(&namespaces[name])?.replace('"', "&quot;")));
        }
        let name_end = xml[1..].find(|c: char| c.is_whitespace() || c == '/' || c == '>').map_or(xml.len(), |i| i + 1);
        Ok(format!("{}{bindings}{}", &xml[..name_end], &xml[name_end..]))
    };
    let prefix = fragment(first, 0, start.offset)?;
    let suffix = fragment(last, end.offset, usize::MAX)?;
    let paragraph_xml = |paragraph: &XmlElement, content: &str, clone: bool| -> String {
        let mut opening = open_tag(&state.source, paragraph);
        if clone {
            for attr in paragraph.attributes.iter().filter(|a| a.namespace == W14 && (a.local_name == "paraId" || a.local_name == "textId")) {
                opening = remove_attribute(&opening, &attr.name);
            }
        }
        format!("{opening}{}{content}</{}>", property(paragraph), paragraph.name)
    };
    // For a join, suffix lexical bindings must match the first paragraph's scope.
    if first.start != last.start
        && lines.len() == 1
        && !suffix.is_empty()
        && last.attributes.iter().any(|a| a.namespace == XMLNS_NAMESPACE && namespaces.get(&a.name) != Some(&a.value))
    {
        return Err(fail("Joining these paragraph namespace scopes is not yet supported."));
    }
    let mut output: Vec<String> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let last_line = index == lines.len() - 1;
        let owner = if last_line && index > 0 { last } else { first };
        let length = (if index == 0 { start.offset } else { 0 }) + line.len() + if last_line { last_length - end.offset.min(last_length) } else { 0 };
        // A blank paragraph needs an actual editable source owner for the next input transaction.
        let empty_owner = if length == 0 { insert("", true)? } else { String::new() };
        let content = format!("{empty_owner}{}{}{}", if index == 0 { prefix.as_str() } else { "" }, insert(line, false)?, if last_line { suffix.as_str() } else { "" });
        output.push(paragraph_xml(owner, &content, index > 0));
    }
    let joined: String = output.concat();
    let next = patch_docx_source(state, vec![Patch::keep(first.start, last.end, joined)])?;
    let last_start = first.start + output[..output.len() - 1].iter().map(String::len).sum::<usize>();
    let paragraph_id = next.identities.get(&last_start).cloned().unwrap_or_default();
    let offset = (if lines.len() == 1 { start.offset } else { 0 }) + lines[lines.len() - 1].len();
    Ok(RangeResult { state: next, paragraph_id, offset })
}

/// `\s+name\s*=\s*(["'])...\1` removed from an opening tag.
fn remove_attribute(opening: &str, name: &str) -> String {
    let mut from = 0;
    while let Some(rel) = opening[from..].find(name) {
        let at = from + rel;
        let lead = opening[..at].len() - opening[..at].trim_end().len();
        let after = opening[at + name.len()..].trim_start();
        if lead > 0 && after.starts_with('=') {
            let value = after[1..].trim_start();
            if let Some(q) = value.chars().next().filter(|c| *c == '"' || *c == '\'')
                && let Some(close) = value[1..].find(q) {
                    let consumed = opening.len() - value.len() + 1 + close + 1;
                    return format!("{}{}", &opening[..at - lead], &opening[consumed..]);
                }
        }
        from = at + name.len();
    }
    opening.to_string()
}
