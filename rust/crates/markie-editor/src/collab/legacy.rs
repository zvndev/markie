//! A room written before the model stamp, brought up to date or refused:
//! `planLegacyRoom` from `src/lib/rich-room-migrate.ts`.
//!
//! Two things changed in what a rich room holds:
//!
//! * Math is a node holding its TeX. An older room holds `$…$` as text, with
//!   a formula's line breaks folded into spaces by the parse that seeded it.
//!   Each span becomes a math node, its source taken from the document the
//!   pane opened on wherever that source folds to the same text. A span that
//!   is literal text there (`\$x\$`) stays text; a span the document does
//!   not have was typed in the room as math, so it becomes math.
//! * Front matter stays out of the room. An older build seeded it as a rule
//!   and some paragraphs. Its nodes come out when they are exactly what the
//!   opened front matter parses to; otherwise the leading block comes out
//!   only when it is front-matter shaped and everything after it is the body
//!   the pane opened on. Anything else is refused: nothing typed in the room
//!   is ever lost.
//!
//! The plan works on the room's own nodes, so every block it does not touch
//! is written back exactly as it was.
use std::collections::{HashMap, HashSet};

use markie_rich::document::Document;
use markie_rich::parse::math_span_end;
use markie_rich::room::{Attrs, RoomNode, from_room, to_room};
use markie_rich::serialize::nodes_to_markdown;
use serde_json::json;

/// What to do with a room an older build seeded.
#[derive(Debug, Clone, PartialEq)]
pub enum LegacyPlan {
    /// Nothing to change: claim it as it is.
    None,
    Migrate { room: Vec<RoomNode>, front_matter_removed: bool, formulas: usize },
    /// The room holds what cannot be brought up to date safely.
    Refuse,
}

/// `fold`: how the HTML parse folded whitespace in ordinary text.
pub fn fold(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut in_run = false;
    for c in source.chars() {
        if matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{c}') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `splitMath`: plain runs and math spans, in order.
pub fn split_math(text: &str) -> Vec<(bool, String)> {
    let b = text.as_bytes();
    let mut parts = Vec::new();
    let mut plain_from = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'$' {
            i += 1;
            continue;
        }
        match math_span_end(text, i) {
            None => {
                // A `$$` that opens nothing is not two chances to open.
                i += if b.get(i + 1) == Some(&b'$') { 2 } else { 1 };
            }
            Some(end) => {
                if i > plain_from {
                    parts.push((false, text[plain_from..i].to_string()));
                }
                parts.push((true, text[i..end].to_string()));
                plain_from = end;
                i = end;
            }
        }
    }
    if plain_from < text.len() {
        parts.push((false, text[plain_from..].to_string()));
    }
    parts
}

fn is_code_run(attrs: &Attrs) -> bool {
    attrs.contains_key("code")
}

/// The opened document's formulas by folded text (None when two sources fold
/// alike), and its literal dollar spans.
fn baseline_math(body: &str) -> (HashMap<String, Option<String>>, HashSet<String>) {
    let mut sources: HashMap<String, Option<String>> = HashMap::new();
    let mut literal = HashSet::new();
    if !body.contains('$') {
        return (sources, literal);
    }
    fn walk(nodes: &[RoomNode], sources: &mut HashMap<String, Option<String>>, literal: &mut HashSet<String>) {
        for n in nodes {
            match n {
                RoomNode::Element { name, attrs, children } => {
                    if name == "mathBlock" || name == "mathInline" {
                        let source = attrs.get("source").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        let key = fold(&source);
                        let next = match sources.get(&key) {
                            None => Some(source),
                            Some(Some(known)) if *known == source => Some(source),
                            _ => None,
                        };
                        sources.insert(key, next);
                    } else if name != "codeBlock" {
                        walk(children, sources, literal);
                    }
                }
                RoomNode::Text(runs) => {
                    for (text, attrs) in runs {
                        if is_code_run(attrs) {
                            continue;
                        }
                        for (math, part) in split_math(text) {
                            if math {
                                literal.insert(fold(&part));
                            }
                        }
                    }
                }
            }
        }
    }
    walk(&to_room(&Document::parse_body(body).nodes()), &mut sources, &mut literal);
    (sources, literal)
}

struct MathPlan {
    sources: HashMap<String, Option<String>>,
    literal: HashSet<String>,
    formulas: usize,
}

impl MathPlan {
    /// The source a span held as text stands for, or None when it is text.
    fn source_for(&self, span: &str, as_written: String) -> Option<String> {
        let key = fold(span);
        if let Some(Some(recovered)) = self.sources.get(&key) {
            return Some(recovered.clone());
        }
        if self.literal.contains(&key) {
            return None;
        }
        Some(as_written)
    }

    fn math_el(name: &str, source: String) -> RoomNode {
        RoomNode::Element { name: name.into(), attrs: Attrs::from([("source".to_string(), json!(source))]), children: Vec::new() }
    }

    /// The children with math spans turned into nodes; None when unchanged.
    fn children(&mut self, nodes: &[RoomNode]) -> Option<Vec<RoomNode>> {
        let mut changed = false;
        let mut out = Vec::with_capacity(nodes.len());
        for n in nodes {
            match self.node(n) {
                Some(mut replaced) => {
                    changed = true;
                    out.append(&mut replaced);
                }
                None => out.push(n.clone()),
            }
        }
        changed.then_some(out)
    }

    fn node(&mut self, n: &RoomNode) -> Option<Vec<RoomNode>> {
        match n {
            RoomNode::Element { name, .. } if name == "codeBlock" => None,
            RoomNode::Element { name, attrs, children } => {
                // A paragraph that is nothing but one `$$…$$` is display math.
                if name == "paragraph"
                    && let [RoomNode::Text(runs)] = children.as_slice()
                    && let [(text, marks)] = runs.as_slice()
                    && marks.is_empty()
                {
                    let parts = split_math(text);
                    if let [(true, span)] = parts.as_slice()
                        && span.starts_with("$$")
                    {
                        // What an older build wrote for such a paragraph.
                        let written = format!("$$\n{}\n$$", span[2..span.len() - 2].trim());
                        return self.source_for(span, written).map(|source| {
                            self.formulas += 1;
                            vec![Self::math_el("mathBlock", source)]
                        });
                    }
                }
                self.children(children).map(|children| vec![RoomNode::Element { name: name.clone(), attrs: attrs.clone(), children }])
            }
            RoomNode::Text(runs) => {
                let mut out = Vec::new();
                let mut pending: Vec<(String, Attrs)> = Vec::new();
                let mut changed = false;
                for (text, attrs) in runs {
                    if is_code_run(attrs) {
                        pending.push((text.clone(), attrs.clone()));
                        continue;
                    }
                    for (math, part) in split_math(text) {
                        let source = if math { self.source_for(&part, part.clone()) } else { None };
                        match source {
                            Some(source) => {
                                changed = true;
                                self.formulas += 1;
                                if !pending.is_empty() {
                                    out.push(RoomNode::Text(std::mem::take(&mut pending)));
                                }
                                // Markie RS's model has no marks on a formula.
                                out.push(Self::math_el("mathInline", source));
                            }
                            None => match pending.last_mut() {
                                Some((t, a)) if a == attrs => t.push_str(&part),
                                _ => pending.push((part, attrs.clone())),
                            },
                        }
                    }
                }
                if !pending.is_empty() {
                    out.push(RoomNode::Text(pending));
                }
                changed.then_some(out)
            }
        }
    }
}

fn is_empty_paragraph(n: &RoomNode) -> bool {
    matches!(n, RoomNode::Element { name, children, .. } if name == "paragraph" && children.is_empty())
}

/// `blocksOf`: the top-level nodes without the empty paragraph TipTap adds.
fn blocks_of(mut nodes: Vec<RoomNode>) -> Vec<RoomNode> {
    while nodes.last().is_some_and(is_empty_paragraph) {
        nodes.pop();
    }
    nodes
}

fn parse_room(markdown: &str) -> Vec<RoomNode> {
    blocks_of(to_room(&Document::parse_body(markdown).nodes()))
}

/// The Markdown a run of room nodes writes, or None when this build cannot
/// read them.
fn serialize(nodes: &[RoomNode]) -> Option<String> {
    from_room(nodes).ok().map(|n| nodes_to_markdown(&n))
}

fn text_of(n: &RoomNode) -> String {
    match n {
        RoomNode::Text(runs) => runs.iter().map(|(t, _)| t.as_str()).collect(),
        RoomNode::Element { children, .. } => children.iter().map(text_of).collect(),
    }
}

fn is_textblock(n: &RoomNode) -> bool {
    matches!(n, RoomNode::Element { name, .. } if matches!(name.as_str(), "paragraph" | "heading" | "codeBlock"))
}

fn named(n: &RoomNode, want: &str) -> bool {
    matches!(n, RoomNode::Element { name, .. } if name == want)
}

const MAX_FRONT_MATTER_NODES: usize = 24;

fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `THEMATIC_BREAK` on the body's first non-blank line.
fn starts_with_rule(body: &str) -> bool {
    let Some(first) = body.split('\n').find(|l| !l.trim().is_empty()) else { return false };
    let indent = first.len() - first.trim_start_matches(' ').len();
    if indent > 3 {
        return false;
    }
    let rest = first.trim_start_matches(' ').trim_end_matches([' ', '\t']);
    let Some(mark) = rest.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else { return false };
    rest.chars().all(|c| c == mark || c == ' ' || c == '\t') && rest.chars().filter(|c| *c == mark).count() >= 3
}

/// `YAML_KEY`: `^\s*["']?[\w.-][\w .\-"']*:(\s|$)`.
fn yaml_key_line(line: &str) -> bool {
    let s = line.trim_start();
    let s = s.strip_prefix(['"', '\'']).unwrap_or(s);
    let mut chars = s.char_indices();
    let Some((_, first)) = chars.next() else { return false };
    if !(word(first) || first == '.' || first == '-') {
        return false;
    }
    for (i, c) in chars {
        if c == ':' {
            // The class before the colon has no colon in it.
            return s[i + 1..].chars().next().is_none_or(char::is_whitespace);
        }
        if !(word(c) || matches!(c, ' ' | '.' | '-' | '"' | '\'')) {
            return false;
        }
    }
    false
}

/// `STORED_KEY` counts: a key per line, a list item's included.
fn stored_keys(text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for line in text.lines() {
        let mut s = line.trim_start_matches([' ', '\t']);
        if let Some(rest) = s.strip_prefix('-')
            && rest.starts_with([' ', '\t'])
        {
            s = rest.trim_start_matches([' ', '\t']);
        }
        let s = s.strip_prefix(['"', '\'']).unwrap_or(s);
        let key: String = s.chars().take_while(|c| word(*c) || matches!(c, '.' | '-')).collect();
        if key.is_empty() {
            continue;
        }
        let rest = &s[key.len()..];
        let rest = rest.strip_prefix(['"', '\'']).unwrap_or(rest).trim_start_matches([' ', '\t']);
        if let Some(after) = rest.strip_prefix(':')
            && after.chars().next().is_none_or(char::is_whitespace)
        {
            *counts.entry(key).or_default() += 1;
        }
    }
    counts
}

/// `ROOM_KEY` counts: a word and a colon after a space, in folded text.
fn room_keys(text: &str, counts: &mut HashMap<String, usize>) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let at_start = i == 0 || chars[i - 1].is_whitespace();
        if !at_start {
            i += 1;
            continue;
        }
        let mut j = i;
        if matches!(chars.get(j), Some('"' | '\'')) {
            j += 1;
        }
        let k0 = j;
        while j < chars.len() && (word(chars[j]) || matches!(chars[j], '.' | '-')) {
            j += 1;
        }
        if j == k0 {
            i += 1;
            continue;
        }
        let key: String = chars[k0..j].iter().collect();
        if matches!(chars.get(j), Some('"' | '\'')) {
            j += 1;
        }
        if chars.get(j) == Some(&':') && chars.get(j + 1).is_none_or(|c| c.is_whitespace()) {
            *counts.entry(key).or_default() += 1;
            i = j + 1;
            continue;
        }
        i += 1;
    }
}

fn count_keys(n: &RoomNode, found: &mut HashMap<String, usize>) {
    if is_textblock(n) {
        room_keys(&text_of(n), found);
    } else if let RoomNode::Element { children, .. } = n {
        for c in children {
            count_keys(c, found);
        }
    }
}

/// `frontMatterShaped`: what an older build made of some front matter block.
fn front_matter_shaped(nodes: &[RoomNode], front_matter: &str) -> bool {
    if nodes.len() < 2 || !named(&nodes[0], "horizontalRule") {
        return false;
    }
    let last = &nodes[nodes.len() - 1];
    let underlined = matches!(last, RoomNode::Element { name, attrs, .. } if name == "heading" && attrs.get("level").and_then(|l| l.as_f64()) == Some(2.0));
    if !underlined && !named(last, "horizontalRule") {
        return false;
    }
    let middle = &nodes[1..nodes.len() - 1];
    let mut lines: Vec<String> = middle.iter().filter(|n| is_textblock(n)).map(text_of).collect();
    if underlined {
        lines.push(text_of(last));
    }
    if !lines.iter().all(|l| yaml_key_line(l)) {
        return false;
    }
    let wanted = stored_keys(front_matter);
    let mut found = HashMap::new();
    for n in nodes {
        count_keys(n, &mut found);
    }
    if found.is_empty() || found.iter().any(|(k, n)| *n > wanted.get(k).copied().unwrap_or(0)) {
        return false;
    }
    let yaml = if middle.is_empty() { Some(String::new()) } else { serialize(middle) };
    let Some(yaml) = yaml else { return false };
    let gap = if yaml.is_empty() { String::new() } else { format!("{yaml}\n\n") };
    let block = if underlined { format!("---\n{gap}{}\n---\n", text_of(last)) } else { format!("---\n{gap}---\n") };
    serialize(&parse_room(&block)).is_some_and(|a| Some(a) == serialize(nodes))
}

/// `planLegacyRoom` for a pane that opened on `front_matter` + `baseline_body`.
pub fn plan_legacy_room(room: &[RoomNode], front_matter: &str, baseline_body: &str) -> LegacyPlan {
    let (sources, literal) = baseline_math(baseline_body);
    let mut math = MathPlan { sources, literal, formulas: 0 };
    let migrated = math.children(room);
    let edited = migrated.is_some();
    let room: Vec<RoomNode> = migrated.unwrap_or_else(|| room.to_vec());

    let mut front_end = 0;
    if !front_matter.is_empty() {
        let wanted = parse_room(front_matter);
        if !wanted.is_empty() && room.len() >= wanted.len() && serialize(&room[..wanted.len()]).is_some_and(|a| Some(a) == serialize(&wanted)) {
            front_end = wanted.len();
        }
    }
    if front_end == 0 && !front_matter.is_empty() && room.first().is_some_and(|n| named(n, "horizontalRule")) && !starts_with_rule(baseline_body) {
        // The room starts with front matter other than the stored copy's.
        // It comes out only when it is front-matter shaped and everything
        // after it is the body this pane opened on.
        let body = serialize(&parse_room(baseline_body));
        for k in 2..=MAX_FRONT_MATTER_NODES.min(room.len()) {
            if !front_matter_shaped(&room[..k], front_matter) {
                continue;
            }
            if serialize(&blocks_of(room[k..].to_vec())).is_some_and(|rest| Some(rest) == body) {
                front_end = k;
            }
            break;
        }
        if front_end == 0 {
            return LegacyPlan::Refuse;
        }
    }
    if front_end == 0 && !edited {
        return LegacyPlan::None;
    }
    let mut out: Vec<RoomNode> = room[front_end..].to_vec();
    if out.is_empty() {
        out.push(RoomNode::Element { name: "paragraph".into(), attrs: Attrs::new(), children: Vec::new() });
    }
    LegacyPlan::Migrate { room: out, front_matter_removed: front_end > 0, formulas: math.formulas }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> RoomNode {
        RoomNode::Element { name: "paragraph".into(), attrs: Attrs::new(), children: vec![RoomNode::Text(vec![(text.into(), Attrs::new())])] }
    }

    fn math(name: &str, source: &str) -> RoomNode {
        RoomNode::Element { name: name.into(), attrs: Attrs::from([("source".to_string(), json!(source))]), children: vec![] }
    }

    #[test]
    fn split_math_matches_rich_math_ts() {
        assert_eq!(split_math("a $x$ b"), vec![(false, "a ".into()), (true, "$x$".into()), (false, " b".into())]);
        assert_eq!(split_math("cost $5 and $6"), vec![(false, "cost $5 and $6".into())]);
        assert_eq!(split_math("$$ $x$"), vec![(false, "$$ ".into()), (true, "$x$".into())]);
        assert_eq!(fold("a\n  b\tc"), "a b c");
    }

    #[test]
    fn math_text_becomes_nodes_with_the_opened_sources() {
        // The room folded a two-line formula; the opened document has it.
        let room = vec![p("Euler: $e^{i\\pi} + 1 = 0$ ok"), p("$$ a + b $$")];
        let body = "Euler: $e^{i\\pi} + 1 = 0$ ok\n\n$$\na +\nb\n$$\n";
        let LegacyPlan::Migrate { room, formulas, front_matter_removed } = plan_legacy_room(&room, "", body) else { panic!("migrate") };
        assert_eq!(formulas, 2);
        assert!(!front_matter_removed);
        let RoomNode::Element { children, .. } = &room[0] else { panic!() };
        assert_eq!(children[1], math("mathInline", "$e^{i\\pi} + 1 = 0$"));
        assert_eq!(room[1], math("mathBlock", "$$\na +\nb\n$$"));
    }

    #[test]
    fn literal_dollars_stay_text_and_unknown_spans_become_math() {
        let body = "Price \\$x\\$ here\n";
        assert_eq!(plan_legacy_room(&[p("Price $x$ here")], "", body), LegacyPlan::None);
        let LegacyPlan::Migrate { formulas, .. } = plan_legacy_room(&[p("typed $y$ in the room")], "", "plain\n") else { panic!() };
        assert_eq!(formulas, 1);
    }

    #[test]
    fn the_stored_front_matter_comes_out_and_typed_text_is_never_lost() {
        let fm = "---\ntitle: Plan\n---\n";
        let mut room = parse_room(fm);
        room.push(p("Body"));
        let LegacyPlan::Migrate { room: out, front_matter_removed, .. } = plan_legacy_room(&room, fm, "Body\n") else { panic!("migrate") };
        assert!(front_matter_removed);
        assert_eq!(out, vec![p("Body")]);
        // A room that starts with a rule the stored front matter does not
        // explain, and something typed after it: refused, not trimmed.
        let odd = vec![RoomNode::Element { name: "horizontalRule".into(), attrs: Attrs::new(), children: vec![] }, p("Note: call Bob"), p("Body")];
        assert_eq!(plan_legacy_room(&odd, fm, "Body\n"), LegacyPlan::Refuse);
        // No front matter in the copy: nothing is taken out.
        assert_eq!(plan_legacy_room(&[p("Body")], "", "Body\n"), LegacyPlan::None);
    }

    #[test]
    fn yaml_lines_and_keys_read_like_the_regexes() {
        assert!(yaml_key_line("title: Plan"));
        assert!(yaml_key_line("  \"tags\": [a]"));
        assert!(!yaml_key_line("Live note"));
        assert!(!yaml_key_line("a:b: c"));
        assert_eq!(stored_keys("title: a\ntags:\n  - x: 1\n"), HashMap::from([("title".into(), 1), ("tags".into(), 1), ("x".into(), 1)]));
        let mut found = HashMap::new();
        room_keys("title: Plan owner: Kim", &mut found);
        assert_eq!(found, HashMap::from([("title".into(), 1), ("owner".into(), 1)]));
        assert!(starts_with_rule("\n---\nx"));
        assert!(!starts_with_rule("Body"));
    }
}
