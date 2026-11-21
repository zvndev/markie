//! A Markdown document as top-level blocks that keep their source bytes.
//!
//! Every byte of the file belongs to exactly one place: the front matter,
//! the leading blank lines, a block's own text, or the separator after it.
//! An untouched block is written back from its bytes, so a document nobody
//! edited is reproduced exactly, by construction rather than by comparison.
//! Only a block whose nodes were replaced goes through the serializer.

use std::ops::Range;

use pulldown_cmark::{Event, Parser};

use crate::model::Node;
use crate::parse::{self, Ev, Opaque, Parsed};
use crate::serialize::nodes_to_markdown_with;

#[derive(Debug, Clone)]
pub struct Document {
    /// Front matter with both fences, or "". It never enters the editor.
    pub front_matter: String,
    /// Blank lines before the first block.
    pub leading: String,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone)]
pub struct Block {
    /// The block's source bytes, with no trailing line ending.
    pub source: String,
    /// The bytes between this block and the next (or the end of the file).
    pub trailing: String,
    pub content: BlockContent,
    /// Set once the nodes no longer come from `source`.
    pub edited: bool,
    /// Position in the document as it was read; None for a new block.
    pub origin: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BlockContent {
    Nodes(Vec<Node>),
    /// Kept as source only. A room cannot hold it; see live-room-carry.ts.
    Opaque(Opaque),
}

impl Block {
    pub fn nodes(&self) -> &[Node] {
        match &self.content {
            BlockContent::Nodes(n) => n,
            BlockContent::Opaque(_) => &[],
        }
    }

    pub fn is_opaque(&self) -> bool {
        matches!(self.content, BlockContent::Opaque(_))
    }

    /// The block's Markdown as it will be written, given the document's
    /// link reference definitions.
    pub fn markdown(&self, definitions: &str) -> String {
        if self.edited {
            nodes_to_markdown_with(self.nodes(), definitions)
        } else {
            self.source.clone()
        }
    }
}

/// `^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)`, as front-matter.ts.
pub fn front_matter_len(md: &str) -> usize {
    let open = if md.starts_with("---\n") {
        4
    } else if md.starts_with("---\r\n") {
        5
    } else {
        return 0;
    };
    let b = md.as_bytes();
    let mut i = open;
    while i < b.len() {
        if b[i] == b'\n' {
            let rest = &md[i + 1..];
            for fence in ["---", "..."] {
                if let Some(after) = rest.strip_prefix(fence) {
                    let end = i + 1 + fence.len();
                    if after.is_empty() {
                        return end;
                    }
                    if after.starts_with('\n') {
                        return end + 1;
                    }
                    if after.starts_with("\r\n") {
                        return end + 2;
                    }
                }
            }
        }
        i += 1;
    }
    0
}

impl Document {
    pub fn parse(md: &str) -> Document {
        let fm = front_matter_len(md);
        let mut doc = Document::parse_body(&md[fm..]);
        doc.front_matter = md[..fm].to_string();
        doc
    }

    /// Parse text that has no front matter (an editor block, a room body).
    pub fn parse_body(body: &str) -> Document {
        let front_matter = String::new();
        // Display math is a block rule in Markie's markdown-it (rich-math.ts)
        // and only an inline one in pulldown, so its blocks are found first
        // and blanked out for pulldown, offsets unchanged.
        let math = display_math_blocks(body);
        let masked = mask(body, &math);
        let events: Vec<Ev> = Parser::new_ext(&masked, parse::options()).into_offset_iter().collect();

        // Top-level groups of events: (byte range, event range).
        let mut groups: Vec<(Range<usize>, Range<usize>)> = Vec::new();
        let mut depth = 0usize;
        let mut group_start = 0usize;
        for (k, (ev, range)) in events.iter().enumerate() {
            match ev {
                Event::Start(_) => {
                    if depth == 0 {
                        group_start = k;
                        groups.push((range.clone(), k..k));
                    }
                    depth += 1;
                }
                Event::End(_) => {
                    depth -= 1;
                    if depth == 0 {
                        groups.last_mut().unwrap().1 = group_start..k + 1;
                    }
                }
                _ if depth == 0 => groups.push((range.clone(), k..k + 1)),
                _ => {}
            }
        }

        for (range, _) in &math {
            groups.push((range.clone(), usize::MAX..usize::MAX));
        }
        groups.sort_by_key(|(r, _)| r.start);

        let mut doc = Document { front_matter, leading: String::new(), blocks: Vec::new() };
        let mut cursor = 0usize;
        for (bytes, evs) in groups {
            let start = bytes.start.max(cursor);
            doc.push_gap(&body[cursor..start]);
            let text = body[start..bytes.end.max(start)].trim_end_matches([' ', '\t', '\r', '\n']);
            let end = start + text.len();
            let content = if evs.start == usize::MAX {
                let source = math.iter().find(|(r, _)| r.start == bytes.start).unwrap().1.clone();
                BlockContent::Nodes(vec![Node::MathBlock { source }])
            } else {
                match parse::convert_block_events(body, &events[evs]) {
                    Parsed::Nodes(n) => BlockContent::Nodes(n),
                    Parsed::Opaque(o) => BlockContent::Opaque(o),
                }
            };
            doc.push_block(text.to_string(), content);
            cursor = end;
        }
        doc.push_gap(&body[cursor..]);
        for (i, b) in doc.blocks.iter_mut().enumerate() {
            b.origin = Some(i);
        }
        doc
    }

    fn push_block(&mut self, source: String, content: BlockContent) {
        self.blocks.push(Block { source, trailing: String::new(), content, edited: false, origin: None });
    }

    /// Bytes between blocks: blank lines are separators, anything else is
    /// text the parser consumed without an event (link reference
    /// definitions), kept as an opaque block.
    fn push_gap(&mut self, gap: &str) {
        let mut rest = gap;
        while !rest.is_empty() {
            let line_end = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
            let line = &rest[..line_end];
            if line.trim().is_empty() {
                match self.blocks.last_mut() {
                    Some(b) => b.trailing.push_str(line),
                    None => self.leading.push_str(line),
                }
                rest = &rest[line_end..];
                continue;
            }
            // A run of non-blank lines.
            let mut end = 0;
            let mut r = rest;
            while !r.is_empty() {
                let le = r.find('\n').map(|i| i + 1).unwrap_or(r.len());
                if r[..le].trim().is_empty() {
                    break;
                }
                end += le;
                r = &r[le..];
            }
            let text = rest[..end].trim_end_matches(['\r', '\n']);
            let tail = &rest[text.len()..end];
            self.push_block(text.to_string(), BlockContent::Opaque(Opaque::Definition));
            self.blocks.last_mut().unwrap().trailing.push_str(tail);
            rest = &rest[end..];
        }
    }

    /// Every editable node in the document, in order: what a room holds.
    pub fn nodes(&self) -> Vec<Node> {
        self.blocks.iter().flat_map(|b| b.nodes().iter().cloned()).collect()
    }

    /// Link reference and footnote definitions, which give an edited block's
    /// `[text][label]` and `[^label]` their meaning.
    pub fn definitions(&self) -> String {
        self.blocks
            .iter()
            .filter(|b| {
                matches!(b.content, BlockContent::Opaque(Opaque::Definition | Opaque::FootnoteDefinition))
            })
            .map(|b| b.source.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// One block's Markdown as `to_markdown` writes it.
    pub fn block_markdown(&self, index: usize) -> String {
        let b = &self.blocks[index];
        if b.edited { b.markdown(&self.definitions()) } else { b.source.clone() }
    }

    pub fn to_markdown(&self) -> String {
        let definitions = if self.blocks.iter().any(|b| b.edited) { self.definitions() } else { String::new() };
        let mut out = String::with_capacity(self.front_matter.len() + self.leading.len() + 64);
        out.push_str(&self.front_matter);
        out.push_str(&self.leading);
        let last_origin = self.blocks.iter().filter_map(|b| b.origin).max();
        let n = self.blocks.len();
        for (i, b) in self.blocks.iter().enumerate() {
            out.push_str(&b.markdown(&definitions));
            if i + 1 == n {
                // The file's own ending, from whichever block ended it.
                let ending = self
                    .blocks
                    .iter()
                    .find(|x| x.origin.is_some() && x.origin == last_origin)
                    .map(|x| x.trailing.clone())
                    .unwrap_or_else(|| "\n".into());
                if b.origin == last_origin && b.origin.is_some() {
                    out.push_str(&b.trailing);
                } else {
                    out.push_str(last_line_ending(&ending));
                }
            } else {
                let next = &self.blocks[i + 1];
                let adjacent = !b.edited
                    && !next.edited
                    && b.origin.is_some()
                    && next.origin.is_some()
                    && next.origin == b.origin.map(|o| o + 1);
                if adjacent || b.trailing.matches('\n').count() >= 2 {
                    out.push_str(&b.trailing);
                } else {
                    out.push_str("\n\n");
                }
            }
        }
        out
    }

    /// Replace a block's nodes (the user edited it).
    pub fn set_nodes(&mut self, index: usize, nodes: Vec<Node>) {
        let b = &mut self.blocks[index];
        b.content = BlockContent::Nodes(nodes);
        b.edited = true;
    }

    /// Mutable nodes of an editable block; marks it edited.
    pub fn nodes_mut(&mut self, index: usize) -> Option<&mut Vec<Node>> {
        let b = &mut self.blocks[index];
        match &mut b.content {
            BlockContent::Nodes(n) => {
                b.edited = true;
                Some(n)
            }
            BlockContent::Opaque(_) => None,
        }
    }

    pub fn insert_block(&mut self, index: usize, nodes: Vec<Node>) {
        self.blocks.insert(
            index,
            Block {
                source: String::new(),
                trailing: "\n\n".into(),
                content: BlockContent::Nodes(nodes),
                edited: true,
                origin: None,
            },
        );
    }

    pub fn remove_block(&mut self, index: usize) {
        self.blocks.remove(index);
    }
}

fn last_line_ending(trailing: &str) -> &str {
    if trailing.is_empty() {
        ""
    } else if trailing.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// Top-level display math blocks, as `displayBlockAt` in rich-math.ts reads
/// them: `$$` opening a block (never interrupting a paragraph), one math
/// span through the end of a line, then a blank line or the end. Returns
/// each block's byte range and its TipTap `source`.
fn display_math_blocks(body: &str) -> Vec<(Range<usize>, String)> {
    let mut lines: Vec<(usize, &str)> = Vec::new();
    let mut at = 0;
    for l in body.split_inclusive('\n') {
        lines.push((at, l));
        at += l.len();
    }
    let bare = |l: &str| l.trim_end_matches(['\r', '\n']).to_string();
    let blank = |l: &str| l.trim().is_empty();
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut can_open = true;
    let mut i = 0;
    while i < lines.len() {
        let (off, line) = lines[i];
        let text = bare(line);
        let indent = text.len() - text.trim_start_matches(' ').len();
        let t = text.trim_start_matches(' ');
        if let Some((ch, n)) = fence {
            let run = t.chars().take_while(|c| *c == ch).count();
            if indent <= 3 && run >= n && t[run..].trim().is_empty() {
                fence = None;
            }
            can_open = false;
            i += 1;
            continue;
        }
        if indent <= 3 && (t.starts_with("```") || t.starts_with("~~~")) {
            let ch = t.chars().next().unwrap();
            fence = Some((ch, t.chars().take_while(|c| *c == ch).count()));
            i += 1;
            continue;
        }
        if blank(line) {
            can_open = true;
            i += 1;
            continue;
        }
        if can_open && indent <= 3 && t.starts_with("$$") {
            // The run of lines up to a blank one.
            let start = off + indent;
            let mut j = i;
            while j < lines.len() && !blank(lines[j].1) {
                j += 1;
            }
            let run_end = lines[j - 1].0 + bare(lines[j - 1].1).len();
            let run = &body[start..run_end];
            if let Some(end) = crate::parse::math_span_end(run, 0) {
                // The line the span closes on, and what follows it there.
                let mut k = i;
                while lines[k].0 + bare(lines[k].1).len() < start + end {
                    k += 1;
                }
                let line_end = lines[k].0 + bare(lines[k].1).len();
                let after_ok = body[start + end..line_end].trim().is_empty();
                let next_ok = k + 1 >= lines.len() || blank(lines[k + 1].1);
                if after_ok && next_ok {
                    let source = body[start..line_end].replace("\r\n", "\n");
                    out.push((off..line_end, source));
                    i = k + 1;
                    can_open = false;
                    continue;
                }
            }
        }
        // ATX headings end themselves; other lines may continue a paragraph.
        can_open = t.starts_with('#');
        i += 1;
    }
    out
}

fn mask(body: &str, blocks: &[(Range<usize>, String)]) -> String {
    if blocks.is_empty() {
        return body.to_string();
    }
    let mut b = body.as_bytes().to_vec();
    for (r, _) in blocks {
        for x in &mut b[r.clone()] {
            if *x != b'\n' && *x != b'\r' {
                *x = b' ';
            }
        }
    }
    // Only ASCII bytes were replaced, and only inside whole characters'
    // ranges? No: the range may hold UTF-8 sequences, all replaced fully.
    String::from_utf8(b).expect("masking replaces whole byte ranges")
}
