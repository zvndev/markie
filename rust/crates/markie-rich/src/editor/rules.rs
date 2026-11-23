//! TipTap's input rules, as Markie's editor has them (StarterKit, TaskItem,
//! Highlight, LocalImage and rich-math.ts's formula rule).
//!
//! A rule runs after typed text lands, against the text of the textblock
//! before the caret, exactly as `inputRulesPlugin` in `@tiptap/core` does:
//!
//! * never inside a code block, nor next to text with the `code` mark;
//! * never while an input method is composing (the view only calls in on
//!   committed text);
//! * on Enter too, with `"\n"` as the typed text, so `#` then Enter makes a
//!   heading and ```` ``` ```` then Enter makes a code block.
//!
//! Each rule is its own undo step, after the keystroke that triggered it, and
//! Backspace straight after a rule takes it back (TipTap's `undoInputRule`),
//! leaving the characters as typed.
//!
//! The regular expressions are TipTap's, matched by hand (the crate has no
//! regex engine). Each matcher names the expression it implements.

use super::tree::{self, Frame, ListKind};
use super::{EditKind, Editor, LeafKind, Pos};

/// The marks an input rule can add.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarkKind {
    Bold,
    Italic,
    Strike,
    Code,
    Highlight,
}
use crate::document::BlockContent;
use crate::edit::Unit;
use crate::model::*;

/// What a matched mark rule changes, in unit offsets of the leaf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MarkMatch {
    /// The opening delimiter's first unit.
    pub open: usize,
    /// The marked text.
    pub inner: (usize, usize),
    /// One past the closing delimiter (the caret).
    pub end: usize,
}

const OBJ: char = '\u{fffc}';

fn chars_of(units: &[Unit]) -> Vec<char> {
    units
        .iter()
        .map(|u| match u {
            Unit::Char(c, _) => *c,
            Unit::Atom(_) => OBJ,
        })
        .collect()
}

/// `(?:^|\s)(D(?!\s+D)((?:[^c]+))D(?!\s+D))$`, the shape of Bold, Italic,
/// Strike and Highlight's input rules, where `D` is `delim` and `c` its
/// character.
pub(crate) fn delimited(text: &[char], delim: &str) -> Option<MarkMatch> {
    let d: Vec<char> = delim.chars().collect();
    let c = d[0];
    let n = text.len();
    if n < 2 * d.len() + 1 || !text.ends_with(&d) {
        return None;
    }
    let inner_end = n - d.len();
    let mut inner_start = inner_end;
    while inner_start > 0 && text[inner_start - 1] != c {
        inner_start -= 1;
    }
    if inner_start == inner_end || inner_start < d.len() {
        return None;
    }
    let open = inner_start - d.len();
    if text[open..inner_start] != d[..] {
        return None;
    }
    if open > 0 && !text[open - 1].is_whitespace() {
        return None;
    }
    // (?!\s+D): the text may not be only spaces before the closing delimiter.
    if text[inner_start..inner_end].iter().all(|c| c.is_whitespace()) {
        return None;
    }
    Some(MarkMatch { open, inner: (inner_start, inner_end), end: n })
}

/// Code's ``(^|[^`])`([^`]+)`(?!`)$``.
pub(crate) fn backticked(text: &[char]) -> Option<MarkMatch> {
    let n = text.len();
    if n < 3 || text[n - 1] != '`' {
        return None;
    }
    let inner_end = n - 1;
    let mut inner_start = inner_end;
    while inner_start > 0 && text[inner_start - 1] != '`' {
        inner_start -= 1;
    }
    if inner_start == inner_end || inner_start == 0 {
        return None;
    }
    let open = inner_start - 1;
    if open > 0 && text[open - 1] == '`' {
        return None;
    }
    Some(MarkMatch { open, inner: (inner_start, inner_end), end: n })
}

/// The mark rules in TipTap's extension order: Bold, Code, Italic, Strike
/// (StarterKit), then Highlight.
pub(crate) fn mark_rule(text: &[char]) -> Option<(MarkKind, MarkMatch)> {
    if let Some(m) = delimited(text, "**").or_else(|| delimited(text, "__")) {
        return Some((MarkKind::Bold, m));
    }
    if let Some(m) = backticked(text) {
        return Some((MarkKind::Code, m));
    }
    if let Some(m) = delimited(text, "*").or_else(|| delimited(text, "_")) {
        return Some((MarkKind::Italic, m));
    }
    if let Some(m) = delimited(text, "~~") {
        return Some((MarkKind::Strike, m));
    }
    if let Some(m) = delimited(text, "==") {
        return Some((MarkKind::Highlight, m));
    }
    None
}

/// LocalImage's `(?:^|\s)(!\[(.+|:?)]\((\S+)(?:(?:\s+)["'](\S+)["'])?\))$`:
/// (start of `![`, alt, src, title).
pub(crate) fn image_rule(text: &[char]) -> Option<(usize, String, String, Option<String>)> {
    let n = text.len();
    if n < 5 || text[n - 1] != ')' {
        return None;
    }
    for i in 0..n.saturating_sub(4) {
        if text[i] != '!' || text[i + 1] != '[' || (i > 0 && !text[i - 1].is_whitespace()) {
            continue;
        }
        let rest = &text[i + 2..n - 1];
        if rest.contains(&OBJ) {
            continue;
        }
        // The alt text is greedy: the last `](` that leaves a valid address.
        for j in (0..rest.len().saturating_sub(1)).rev() {
            if rest[j] != ']' || rest[j + 1] != '(' {
                continue;
            }
            let alt: String = rest[..j].iter().collect();
            let tail: String = rest[j + 2..].iter().collect();
            if let Some((src, title)) = image_target(&tail) {
                return Some((i, alt, src, title));
            }
        }
    }
    None
}

fn image_target(tail: &str) -> Option<(String, Option<String>)> {
    if tail.is_empty() {
        return None;
    }
    if !tail.chars().any(char::is_whitespace) {
        return Some((tail.to_string(), None));
    }
    let src_end = tail.find(char::is_whitespace)?;
    let src = &tail[..src_end];
    let title = tail[src_end..].trim_start();
    if src.is_empty() || title.len() < 3 || title.chars().any(char::is_whitespace) {
        return None;
    }
    let first = title.chars().next()?;
    let last = title.chars().last()?;
    if !matches!(first, '"' | '\'') || !matches!(last, '"' | '\'') {
        return None;
    }
    Some((src.to_string(), Some(title[1..title.len() - 1].to_string())))
}

/// rich-math.ts: `(?:^|[^\\$])(\$[^\s$][^$\n]*\$)$`, and the span must be one
/// the document reader would take as a formula. Returns where `$` opens.
pub(crate) fn math_rule(text: &[char]) -> Option<usize> {
    let n = text.len();
    if n < 3 || text[n - 1] != '$' {
        return None;
    }
    let mut open = n - 1;
    while open > 0 && text[open - 1] != '$' && text[open - 1] != '\n' {
        open -= 1;
    }
    if open == 0 || text[open - 1] != '$' {
        return None;
    }
    let open = open - 1;
    let first = text[open + 1];
    if first.is_whitespace() || first == '$' || open + 1 == n - 1 {
        return None;
    }
    if open > 0 && matches!(text[open - 1], '\\' | '$') {
        return None;
    }
    let span: String = text[open..].iter().collect();
    (crate::parse::math_span_end(&span, 0) == Some(span.len())).then_some(open)
}

/// The textblock rules, given the whole text before the caret plus what was
/// typed (TipTap's `^…$` patterns).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum BlockRule {
    Quote,
    List(ListKind, u64, bool),
    Code(Option<String>),
    Heading(u8),
    Rule,
}

fn is_space(c: char) -> bool {
    c.is_whitespace()
}

pub(crate) fn block_rule(text: &[char]) -> Option<BlockRule> {
    let n = text.len();
    if n < 2 || !is_space(text[n - 1]) {
        // Only `---` and `—-` fire without a trailing space.
        let s: String = text.iter().collect();
        return (s == "---" || s == "\u{2014}-").then_some(BlockRule::Rule);
    }
    let body: String = text[..n - 1].iter().collect();
    let lead = body.trim_start_matches(char::is_whitespace);
    // Blockquote: ^\s*>\s$
    if lead == ">" {
        return Some(BlockRule::Quote);
    }
    // BulletList: ^\s*([-+*])\s$
    if lead == "-" || lead == "+" || lead == "*" {
        return Some(BlockRule::List(ListKind::Bullet, 1, false));
    }
    // CodeBlock: ^```([a-z]+)?[\s\n]$ and ^~~~([a-z]+)?[\s\n]$
    for fence in ["```", "~~~"] {
        if let Some(lang) = body.strip_prefix(fence) {
            if lang.chars().all(|c| c.is_ascii_lowercase()) {
                return Some(BlockRule::Code((!lang.is_empty()).then(|| lang.to_string())));
            }
        }
    }
    // Heading: ^(#{1,6})\s$
    if !body.is_empty() && body.len() <= 6 && body.chars().all(|c| c == '#') {
        return Some(BlockRule::Heading(body.len() as u8));
    }
    // HorizontalRule: ^(?:---|—-|___\s|\*\*\*\s)$
    if body == "___" || body == "***" {
        return Some(BlockRule::Rule);
    }
    // OrderedList: ^(\d+)\.\s$
    if let Some(num) = body.strip_suffix('.') {
        if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
            return Some(BlockRule::List(ListKind::Ordered, num.parse().unwrap_or(1), false));
        }
    }
    // TaskItem: ^\s*(\[([( |x])?\])\s$
    if matches!(lead, "[ ]" | "[]" | "[x]" | "[(]") {
        return Some(BlockRule::List(ListKind::Task, 1, lead == "[x]"));
    }
    None
}

impl Editor {
    /// After text was typed at the caret: run the first rule that matches.
    /// `typed` is what the keystroke inserted, `"\n"` for Enter (which then
    /// is not inserted at all). Returns whether a rule ran.
    pub(crate) fn run_input_rules(&mut self, typed: &str) -> bool {
        if self.has_selection() || typed.is_empty() {
            return false;
        }
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return false };
        if !leaf.kind.is_rich() {
            return false;
        }
        let units = self.units(p.block, p.leaf);
        let caret = p.offset.min(units.len());
        let enter = typed == "\n";
        let typed_len = if enter { 0 } else { typed.chars().count() };
        let from = caret.saturating_sub(typed_len);
        // Never next to code (the node before or after where typing began).
        let code_at = |i: Option<usize>| i.and_then(|i| units.get(i)).is_some_and(|u| matches!(u, Unit::Char(_, m) if m.code));
        if code_at(from.checked_sub(1)) || code_at(Some(caret)) {
            return false;
        }
        let mut text = chars_of(&units[..caret]);
        if enter {
            text.push('\n');
        }
        if let Some(rule) = block_rule(&text) {
            if self.apply_block_rule(p, &leaf.path, leaf.kind, caret, rule) {
                return true;
            }
        }
        if enter {
            return false;
        }
        if let Some((kind, m)) = mark_rule(&text) {
            return self.apply_mark_rule(p, &units, kind, m);
        }
        if let Some(open) = math_rule(&text) {
            let source: String = units[open..caret].iter().map(|u| u.display()).collect();
            let path = leaf.path.clone();
            self.rule_step(p.block..p.block + 1, |ed| {
                let mut u = units.clone();
                u.splice(open..caret, [Unit::Atom(Inline::Math { source })]);
                ed.set_units(p.block, p.leaf, &u);
                ed.put_caret(p.block, path, open + 1);
            });
            return true;
        }
        if let Some((start, alt, src, title)) = image_rule(&text) {
            return self.apply_image_rule(p, &leaf.path, &units, start, caret, alt, src, title);
        }
        false
    }

    /// One rule as its own undo step, remembered so Backspace can take it
    /// back. TipTap closes the history before a rule's transaction, so the
    /// rule starts a new group; typing straight after it joins that group.
    fn rule_step(&mut self, blocks: std::ops::Range<usize>, f: impl FnOnce(&mut Editor)) {
        self.break_undo();
        let v = self.version;
        self.transact(blocks, EditKind::Replacing, f);
        if self.version != v {
            self.rule_undo = Some(self.sel_version);
        }
    }

    /// Backspace straight after a rule: undo the rule, keep the typing.
    pub(crate) fn undo_input_rule(&mut self) -> bool {
        if self.rule_undo.take() != Some(self.sel_version) || self.has_selection() {
            return false;
        }
        if self.undo() {
            self.redo.pop();
            return true;
        }
        false
    }

    fn apply_mark_rule(&mut self, p: Pos, units: &[Unit], kind: MarkKind, m: MarkMatch) -> bool {
        // A mark that excludes the new one (code excludes every mark) stops
        // the rule.
        if kind != MarkKind::Code
            && units[m.open..m.end].iter().any(|u| matches!(u, Unit::Char(_, mk) if mk.code))
        {
            return false;
        }
        if units[m.inner.0..m.inner.1].iter().any(|u| matches!(u, Unit::Atom(_))) && kind == MarkKind::Code {
            return false;
        }
        let path = self.leaf(p).map(|l| l.path.clone()).unwrap_or_default();
        let mut u: Vec<Unit> = Vec::with_capacity(units.len());
        u.extend_from_slice(&units[..m.open]);
        for unit in &units[m.inner.0..m.inner.1] {
            let mut unit = unit.clone();
            if let Unit::Char(_, mk) = &mut unit {
                apply_mark(mk, kind);
            }
            u.push(unit);
        }
        let caret = u.len();
        u.extend_from_slice(&units[m.end..]);
        // TipTap removes the stored mark: what is typed next is plain again.
        let mut next = super::ops::marks_before(&u, caret);
        clear_mark(&mut next, kind);
        self.rule_step(p.block..p.block + 1, |ed| {
            ed.set_units(p.block, p.leaf, &u);
            ed.put_caret(p.block, path, caret);
        });
        self.typing = Some(next);
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_image_rule(&mut self, p: Pos, path: &[usize], units: &[Unit], start: usize, caret: usize, alt: String, src: String, title: Option<String>) -> bool {
        if self.must_stay_paragraph(p.block, path) || self.leaf(p).is_some_and(|l| l.in_cell()) {
            return false;
        }
        let before = crate::edit::unflatten(&units[..start]);
        let after = crate::edit::unflatten(&units[caret..]);
        let image = Node::Image { src, alt: (!alt.is_empty()).then_some(alt), title, width: None };
        let path = path.to_vec();
        self.rule_step(p.block..p.block + 1, |ed| {
            let Some(nodes) = ed.nodes_mut(p.block) else { return };
            let Some(Node::Paragraph { content, align }) = tree::node_at(nodes, &path).cloned() else { return };
            let _ = content;
            let (c, i) = tree::split_path(&path);
            let c = c.to_vec();
            let Some(cont) = tree::container_mut(nodes, &c) else { return };
            let mut repl = Vec::new();
            if !before.is_empty() {
                repl.push(Node::Paragraph { content: before.clone(), align: align.clone() });
            }
            repl.push(image.clone());
            let caret_index = i + repl.len();
            repl.push(Node::Paragraph { content: after.clone(), align });
            cont.splice(i..i + 1, repl);
            let mut cp = c.clone();
            cp.push(caret_index);
            ed.put_caret(p.block, cp, 0);
        });
        true
    }

    /// Apply a textblock rule to the leaf at `path` whose first `strip`
    /// units are the typed prefix.
    fn apply_block_rule(&mut self, p: Pos, path: &[usize], kind: LeafKind, strip: usize, rule: BlockRule) -> bool {
        let frames = self.leaf_frames(p.block, path);
        if frames.iter().any(|f| matches!(f, Frame::Cell { .. })) {
            return false;
        }
        let first_in_item = self.must_stay_paragraph(p.block, path);
        let heading = matches!(kind, LeafKind::Heading(_));
        match &rule {
            // A list item starts with a paragraph (`paragraph block*`).
            BlockRule::Heading(_) | BlockRule::Code(_) | BlockRule::Rule if first_in_item => return false,
            // A heading cannot go into a list item.
            BlockRule::List(..) if heading => return false,
            _ => {}
        }
        let units = self.units(p.block, p.leaf);
        let rest = crate::edit::unflatten(&units[strip.min(units.len())..]);
        let align = match self.node_at(p.block, path) {
            Some(Node::Paragraph { align, .. } | Node::Heading { align, .. }) => align.clone(),
            _ => None,
        };
        let (c, i) = tree::split_path(path);
        let c = c.to_vec();
        // The node before, for joining a new list or quote onto it.
        let join_prev_block = c.is_empty() && i == 0 && p.block > 0;
        let prev: Option<Node> = if i > 0 {
            self.doc.blocks.get(p.block).and_then(|b| match &b.content {
                BlockContent::Nodes(n) => tree::container_of(n, &c).and_then(|cont| cont.get(i - 1)).cloned(),
                _ => None,
            })
        } else if join_prev_block {
            match &self.doc.blocks[p.block - 1].content {
                BlockContent::Nodes(n) => n.last().cloned(),
                _ => None,
            }
        } else {
            None
        };
        let block = p.block;
        let path = path.to_vec();
        let range = if join_prev_block { block - 1..block + 1 } else { block..block + 1 };
        self.rule_step(range, |ed| {
            let Some(nodes) = ed.nodes_mut(block) else { return };
            match rule {
                BlockRule::Heading(level) => {
                    *tree::node_at_mut(nodes, &path).unwrap() = Node::Heading { level, content: rest, align };
                    ed.put_caret(block, path.clone(), 0);
                }
                BlockRule::Code(language) => {
                    let code = inline_text(&rest);
                    *tree::node_at_mut(nodes, &path).unwrap() = Node::CodeBlock { language, code };
                    ed.put_caret(block, path.clone(), 0);
                }
                BlockRule::Rule => {
                    let cont = tree::container_mut(nodes, &c).unwrap();
                    cont[i] = match &cont[i] {
                        Node::Heading { level, .. } => Node::Heading { level: *level, content: rest, align },
                        _ => Node::Paragraph { content: rest, align },
                    };
                    cont.insert(i, Node::HorizontalRule);
                    let mut cp = c.clone();
                    cp.push(i + 1);
                    ed.put_caret(block, cp, 0);
                }
                BlockRule::Quote | BlockRule::List(..) => {
                    let inner = if heading {
                        let level = match kind { LeafKind::Heading(l) => l, _ => 1 };
                        Node::Heading { level, content: rest, align }
                    } else {
                        Node::Paragraph { content: rest, align }
                    };
                    let joined = join_into(prev.as_ref(), &rule, inner.clone());
                    match joined {
                        Some((node, item_path)) => {
                            // Remove the paragraph and grow the node before it.
                            if join_prev_block {
                                let cont = tree::container_mut(nodes, &c).unwrap();
                                cont.remove(i);
                                let empty = cont.is_empty();
                                let prev_nodes = ed.nodes_mut(block - 1).unwrap();
                                let last = prev_nodes.len() - 1;
                                prev_nodes[last] = node;
                                if empty {
                                    ed.doc.blocks.remove(block);
                                }
                                let mut cp = vec![last];
                                cp.extend(item_path);
                                ed.put_caret(block - 1, cp, 0);
                            } else {
                                let cont = tree::container_mut(nodes, &c).unwrap();
                                cont[i - 1] = node;
                                cont.remove(i);
                                let mut cp = c.clone();
                                cp.push(i - 1);
                                cp.extend(item_path);
                                ed.put_caret(block, cp, 0);
                            }
                        }
                        None => {
                            let (node, inner_path) = wrap(&rule, inner);
                            *tree::node_at_mut(nodes, &path).unwrap() = node;
                            let mut cp = path.clone();
                            cp.extend(inner_path);
                            ed.put_caret(block, cp, 0);
                        }
                    }
                }
            }
        });
        true
    }
}

fn wrap(rule: &BlockRule, inner: Node) -> (Node, Vec<usize>) {
    match rule {
        BlockRule::Quote => (Node::Blockquote(vec![inner]), vec![0]),
        BlockRule::List(ListKind::Bullet, ..) => (Node::BulletList { tight: true, items: vec![vec![inner]] }, vec![0, 0]),
        BlockRule::List(ListKind::Ordered, start, _) => {
            (Node::OrderedList { tight: true, start: *start, items: vec![vec![inner]] }, vec![0, 0])
        }
        BlockRule::List(ListKind::Task, _, checked) => {
            (Node::TaskList { items: vec![TaskItem { checked: *checked, content: vec![inner] }] }, vec![0, 0])
        }
        _ => (inner, vec![]),
    }
}

/// wrappingInputRule's join: a new list (or quote) right after one of its
/// kind joins it. An ordered list joins only when its number follows on.
fn join_into(prev: Option<&Node>, rule: &BlockRule, inner: Node) -> Option<(Node, Vec<usize>)> {
    let prev = prev?.clone();
    match (prev, rule) {
        (Node::Blockquote(mut c), BlockRule::Quote) => {
            c.push(inner);
            let at = c.len() - 1;
            Some((Node::Blockquote(c), vec![at]))
        }
        (Node::BulletList { tight, mut items }, BlockRule::List(ListKind::Bullet, ..)) => {
            items.push(vec![inner]);
            let at = items.len() - 1;
            Some((Node::BulletList { tight, items }, vec![at, 0]))
        }
        (Node::OrderedList { tight, start, mut items }, BlockRule::List(ListKind::Ordered, n, _))
            if items.len() as u64 + start == *n =>
        {
            items.push(vec![inner]);
            let at = items.len() - 1;
            Some((Node::OrderedList { tight, start, items }, vec![at, 0]))
        }
        (Node::TaskList { mut items }, BlockRule::List(ListKind::Task, _, checked)) => {
            items.push(TaskItem { checked: *checked, content: vec![inner] });
            let at = items.len() - 1;
            Some((Node::TaskList { items }, vec![at, 0]))
        }
        _ => None,
    }
}

fn apply_mark(m: &mut Marks, kind: MarkKind) {
    match kind {
        MarkKind::Bold => m.bold = true,
        MarkKind::Italic => m.italic = true,
        MarkKind::Strike => m.strike = true,
        MarkKind::Highlight => {
            if m.highlight.is_none() {
                m.highlight = Some(Highlight { color: None });
            }
        }
        // Code excludes every other mark: ProseMirror drops them.
        MarkKind::Code => *m = Marks { code: true, ..Marks::default() },
    }
}

fn clear_mark(m: &mut Marks, kind: MarkKind) {
    match kind {
        MarkKind::Bold => m.bold = false,
        MarkKind::Italic => m.italic = false,
        MarkKind::Strike => m.strike = false,
        MarkKind::Highlight => m.highlight = None,
        MarkKind::Code => m.code = false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn delimited_matches_tiptap() {
        assert_eq!(delimited(&t("a **bold**"), "**").map(|m| m.inner), Some((4, 8)));
        assert_eq!(delimited(&t("**bold**"), "**").map(|m| m.inner), Some((2, 6)));
        assert!(delimited(&t("x**bold**"), "**").is_none(), "needs a space or the start before");
        assert!(delimited(&t("** **"), "**").is_none());
        assert!(delimited(&t("**bold*"), "*").is_none(), "italic does not fire inside bold");
        assert!(delimited(&t("**bold**"), "*").is_none());
        assert_eq!(delimited(&t("*it*"), "*").map(|m| m.inner), Some((1, 3)));
        assert_eq!(delimited(&t("say ==hi=="), "==").map(|m| m.open), Some(4));
    }

    #[test]
    fn code_and_image_and_math() {
        assert_eq!(backticked(&t("a `x`")).map(|m| m.inner), Some((3, 4)));
        assert!(backticked(&t("``x`")).is_none());
        let (i, alt, src, title) = image_rule(&t("see ![cat](cat.png)")).unwrap();
        assert_eq!((i, alt.as_str(), src.as_str(), title), (4, "cat", "cat.png", None));
        let (_, _, src, title) = image_rule(&t("![a](b.png \"T\")")).unwrap();
        assert_eq!((src.as_str(), title.as_deref()), ("b.png", Some("T")));
        assert!(image_rule(&t("x![a](b)")).is_none());
        assert_eq!(math_rule(&t("so $x^2$")), Some(3));
        assert!(math_rule(&t("$5 and $")).is_none());
        assert!(math_rule(&t("$ x$")).is_none());
        assert!(math_rule(&t("\\$x$")).is_none());
    }

    #[test]
    fn block_rules_match_tiptap() {
        assert_eq!(block_rule(&t("# ")), Some(BlockRule::Heading(1)));
        assert_eq!(block_rule(&t("###\n")), Some(BlockRule::Heading(3)));
        assert_eq!(block_rule(&t("####### ")), None);
        assert_eq!(block_rule(&t("  - ")), Some(BlockRule::List(ListKind::Bullet, 1, false)));
        assert_eq!(block_rule(&t("3. ")), Some(BlockRule::List(ListKind::Ordered, 3, false)));
        assert_eq!(block_rule(&t("[x] ")), Some(BlockRule::List(ListKind::Task, 1, true)));
        assert_eq!(block_rule(&t("[X] ")), None);
        assert_eq!(block_rule(&t("```rust ")), Some(BlockRule::Code(Some("rust".into()))));
        assert_eq!(block_rule(&t("```Rust ")), None);
        assert_eq!(block_rule(&t("~~~\n")), Some(BlockRule::Code(None)));
        assert_eq!(block_rule(&t("---")), Some(BlockRule::Rule));
        assert_eq!(block_rule(&t("*** ")), Some(BlockRule::Rule));
        assert_eq!(block_rule(&t("--- ")), None);
        assert_eq!(block_rule(&t("> ")), Some(BlockRule::Quote));
    }
}
