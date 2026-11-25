//! Source-mode keys from CodeMirror's basic setup that GPUI Kit's code
//! editor lacks, ported from `@codemirror/commands` and `@codemirror/search`
//! as Electron's Source runs them:
//!
//! | Keys | Command |
//! |---|---|
//! | ⌥↑ ⌥↓ | `moveLineUp`, `moveLineDown` |
//! | ⇧⌥↑ ⇧⌥↓ | `copyLineUp`, `copyLineDown` (GPUI Kit had add-a-cursor here) |
//! | ⇧⌘K | `deleteLine` |
//! | ⌘D | `selectNextOccurrence` |
//! | ⇧⌘L | `selectSelectionMatches`, or the word at the cursor (⇧⌘L is Toggle Theme everywhere else) |
//! | ⌥⌘G | `gotoLine`, in a strip like the find bar |
//! | ⌘↵ | `insertBlankLine` |
//! | ⌘G ⇧⌘G | the find bar's next and previous match (Electron's app-owned keys) |
//! | ⌃L | `selectLine` |
//! | ⇧⌘\ | `cursorMatchingBracket` |
//! | ⌘Home ⌘End | `cursorDocStart`, `cursorDocEnd`, with ⇧ to select |
//! | ⌃B ⌃F ⌃P ⌃N ⌃D ⌃H ⌃K ⌃⌥H ⌃V ⌃O ⌃T | CodeMirror's macOS Emacs keys |
//!
//! Each command is one undo step: the lines it touches are replaced in one
//! edit. GPUI Kit does not let an app read every cursor, so with several
//! cursors the line commands act on the main one (CodeMirror acts on each).
//! ⌘D keeps its own list of the matches it added for the same reason.

use std::ops::Range;

use gpui_kit::component::input::{self as kit, Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, Sizable as _};
use gpui_kit::*;

use super::Workspace;
use super::source::SOURCE;

actions!(
    markie_source,
    [
        MoveLineUp,
        MoveLineDown,
        CopyLineUp,
        CopyLineDown,
        DeleteLine,
        SelectNextOccurrence,
        SelectAllOccurrences,
        GoToLine,
        InsertBlankLine,
        SelectLine,
        CursorMatchingBracket,
        FindNextMatch,
        FindPreviousMatch,
        SplitLine,
        TransposeChars,
    ]
);

/// The keys, all in Source text only (`source::SOURCE`).
pub fn key_bindings() -> Vec<KeyBinding> {
    let src = Some(SOURCE);
    vec![
        KeyBinding::new("alt-up", MoveLineUp, src),
        KeyBinding::new("alt-down", MoveLineDown, src),
        KeyBinding::new("shift-alt-up", CopyLineUp, src),
        KeyBinding::new("shift-alt-down", CopyLineDown, src),
        KeyBinding::new("cmd-shift-k", DeleteLine, src),
        KeyBinding::new("cmd-d", SelectNextOccurrence, src),
        KeyBinding::new("cmd-shift-l", SelectAllOccurrences, src),
        KeyBinding::new("cmd-alt-g", GoToLine, src),
        KeyBinding::new("cmd-enter", InsertBlankLine, src),
        KeyBinding::new("cmd-g", FindNextMatch, src),
        KeyBinding::new("cmd-shift-g", FindPreviousMatch, src),
        KeyBinding::new("ctrl-l", SelectLine, src),
        KeyBinding::new("cmd-shift-\\", CursorMatchingBracket, src),
        KeyBinding::new("cmd-home", kit::MoveToStart, src),
        KeyBinding::new("cmd-end", kit::MoveToEnd, src),
        KeyBinding::new("cmd-shift-home", kit::SelectToStart, src),
        KeyBinding::new("cmd-shift-end", kit::SelectToEnd, src),
        // CodeMirror's `emacsStyleKeymap`, which it binds on macOS.
        KeyBinding::new("ctrl-b", kit::MoveLeft, src),
        KeyBinding::new("ctrl-f", kit::MoveRight, src),
        KeyBinding::new("ctrl-p", kit::MoveUp, src),
        KeyBinding::new("ctrl-n", kit::MoveDown, src),
        KeyBinding::new("ctrl-d", kit::Delete, src),
        KeyBinding::new("ctrl-h", kit::Backspace, src),
        KeyBinding::new("ctrl-k", kit::DeleteToEndOfLine, src),
        KeyBinding::new("ctrl-alt-h", kit::DeleteToPreviousWordStart, src),
        KeyBinding::new("ctrl-v", kit::MovePageDown, src),
        KeyBinding::new("ctrl-o", SplitLine, src),
        KeyBinding::new("ctrl-t", TransposeChars, src),
    ]
}

// ------------------------------------------------------------ the commands

/// One change: replace `range` with `text`, then select `select` (in the
/// text after the change). `None` means the command does nothing here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Edit {
    pub range: Range<usize>,
    pub text: String,
    pub select: Range<usize>,
}

fn line_start(text: &str, at: usize) -> usize {
    text[..at].rfind('\n').map_or(0, |i| i + 1)
}

fn line_end(text: &str, at: usize) -> usize {
    text[at..].find('\n').map_or(text.len(), |i| at + i)
}

/// `selectedLineBlocks` for one selection: whole lines, without the line
/// a non-empty selection only touches at its start.
fn block(text: &str, sel: &Range<usize>) -> Range<usize> {
    let from = line_start(text, sel.start);
    let mut last = sel.end;
    if sel.end > sel.start && sel.end == line_start(text, sel.end) {
        last = sel.end - 1;
    }
    from..line_end(text, last)
}

fn shift(r: &Range<usize>, by: isize) -> Range<usize> {
    r.start.saturating_add_signed(by)..r.end.saturating_add_signed(by)
}

/// `moveLineUp` and `moveLineDown`: the lines swap with the one above or
/// below; the selection moves with them.
pub(super) fn move_lines(text: &str, sel: Range<usize>, up: bool) -> Option<Edit> {
    let b = block(text, &sel);
    let body = &text[b.clone()];
    if up {
        if b.start == 0 {
            return None;
        }
        let prev = line_start(text, b.start - 1);
        let above = &text[prev..b.start - 1];
        Some(Edit { range: prev..b.end, text: format!("{body}\n{above}"), select: shift(&sel, -(above.len() as isize + 1)) })
    } else {
        if b.end >= text.len() {
            return None;
        }
        let next_end = line_end(text, b.end + 1);
        let below = &text[b.end + 1..next_end];
        Some(Edit { range: b.start..next_end, text: format!("{below}\n{body}"), select: shift(&sel, below.len() as isize + 1) })
    }
}

/// `copyLineUp` and `copyLineDown`: the lines doubled. Down leaves the
/// selection in the lower copy, up in the upper one.
pub(super) fn copy_lines(text: &str, sel: Range<usize>, up: bool) -> Edit {
    let b = block(text, &sel);
    let body = &text[b.clone()];
    if up {
        Edit { range: b.end..b.end, text: format!("\n{body}"), select: sel }
    } else {
        Edit { range: b.start..b.start, text: format!("{body}\n"), select: shift(&sel, body.len() as isize + 1) }
    }
}

fn column(text: &str, at: usize) -> usize {
    text[line_start(text, at)..at].chars().count()
}

/// The byte offset `col` characters into the line starting at `start`,
/// clamped to the line's end.
fn at_column(text: &str, start: usize, col: usize) -> usize {
    let end = line_end(text, start);
    text[start..end].char_indices().nth(col).map_or(end, |(i, _)| start + i)
}

/// `deleteLine`: the lines go with one line break. The cursor lands on the
/// next line at the same column, or at the end of the line above when the
/// last line went.
pub(super) fn delete_lines(text: &str, sel: Range<usize>) -> Edit {
    let b = block(text, &sel);
    let col = column(text, sel.end);
    let (from, to) = if b.start > 0 {
        (b.start - 1, b.end)
    } else if b.end < text.len() {
        (b.start, b.end + 1)
    } else {
        (b.start, b.end)
    };
    let after = format!("{}{}", &text[..from], &text[to..]);
    let cursor = if b.end < text.len() {
        // The line below now starts where the deleted lines did.
        let start = if b.start > 0 { from + 1 } else { 0 };
        at_column(&after, start, col)
    } else {
        from
    };
    Edit { range: from..to, text: String::new(), select: cursor..cursor }
}

/// `insertBlankLine` (⌘↵): a new line after the current one with its
/// indentation, the cursor on it; the line itself is not split.
pub(super) fn insert_blank_line(text: &str, sel: Range<usize>) -> Edit {
    let end = line_end(text, sel.end);
    let start = line_start(text, end);
    let indent: String = text[start..end].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    let insert = format!("\n{indent}");
    let cursor = end + insert.len();
    Edit { range: end..end, text: insert, select: cursor..cursor }
}

/// `splitLine` (⌃O): a line break after the cursor; the cursor stays.
pub(super) fn split_line(sel: Range<usize>) -> Edit {
    Edit { range: sel.clone(), text: "\n".into(), select: sel.start..sel.start }
}

/// `transposeChars` (⌃T): swap the characters on each side of the cursor,
/// a line break included at a line's start or end, as CodeMirror does.
pub(super) fn transpose_chars(text: &str, sel: Range<usize>) -> Option<Edit> {
    let pos = sel.start;
    if sel.start != sel.end || pos == 0 || pos == text.len() {
        return None;
    }
    let from = text[..pos].char_indices().next_back().map(|(i, _)| i)?;
    let to = pos + text[pos..].chars().next()?.len_utf8();
    Some(Edit { range: from..to, text: format!("{}{}", &text[pos..to], &text[from..pos]), select: to..to })
}

/// `selectLine` (⌃L): the whole lines, with the line break after them.
pub(super) fn line_selection(text: &str, sel: Range<usize>) -> Range<usize> {
    let b = block(text, &sel);
    b.start..(b.end + 1).min(text.len())
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `wordAt`: the word around `at`, if the cursor touches one.
pub(super) fn word_at(text: &str, at: usize) -> Option<Range<usize>> {
    let start = text[..at].char_indices().rev().take_while(|(_, c)| word_char(*c)).last().map_or(at, |(i, _)| i);
    let end = text[at..].char_indices().find(|(_, c)| !word_char(*c)).map_or(text.len(), |(i, _)| at + i);
    (start < end).then_some(start..end)
}

fn is_whole_word(text: &str, r: &Range<usize>) -> bool {
    word_at(text, r.start).is_some_and(|w| w == *r)
}

/// `findNextOccurrence`: the next `query` after the newest selection,
/// wrapping once, skipping what is already selected. A query that was a
/// whole word only matches whole words.
pub(super) fn next_occurrence(text: &str, query: &str, selected: &[Range<usize>], full_word: bool) -> Option<Range<usize>> {
    if query.is_empty() {
        return None;
    }
    let last = selected.last()?;
    let ok = |r: &Range<usize>| !full_word || is_whole_word(text, r);
    let after = text[last.end..].match_indices(query).map(|(i, _)| last.end + i..last.end + i + query.len()).find(|r| ok(r));
    if after.is_some() {
        return after;
    }
    // Round from the top, up to just before the newest selection.
    let limit = last.start.saturating_sub(1);
    text.match_indices(query)
        .map(|(i, _)| i..i + query.len())
        .take_while(|r| r.end <= limit)
        .find(|r| ok(r) && !selected.iter().any(|s| s.start == r.start))
}

/// `selectSelectionMatches`: every match of `query`, at most a thousand.
pub(super) fn all_occurrences(text: &str, query: &str) -> Option<Vec<Range<usize>>> {
    if query.is_empty() {
        return None;
    }
    let found: Vec<Range<usize>> = text.match_indices(query).map(|(i, _)| i..i + query.len()).take(1001).collect();
    (found.len() <= 1000).then_some(found)
}

const BRACKETS: [(char, char); 3] = [('(', ')'), ('[', ']'), ('{', '}')];

/// Where the bracket at `pos` closes (or opens), by nesting.
fn bracket_pair(text: &str, pos: usize, c: char) -> Option<usize> {
    let &(open, close) = BRACKETS.iter().find(|(o, cl)| *o == c || *cl == c)?;
    let mut depth = 0i32;
    if c == open {
        for (i, d) in text[pos..].char_indices() {
            depth += if d == open { 1 } else if d == close { -1 } else { 0 };
            if depth == 0 {
                return Some(pos + i);
            }
        }
    } else {
        for (i, d) in text[..pos + c.len_utf8()].char_indices().rev() {
            depth += if d == close { 1 } else if d == open { -1 } else { 0 };
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn is_bracket(c: char) -> bool {
    BRACKETS.iter().any(|(o, cl)| *o == c || *cl == c)
}

/// `cursorMatchingBracket` (⇧⌘\): a bracket just before the cursor first,
/// else one just after. From before, the cursor lands before its pair; from
/// after, past it.
pub(super) fn matching_bracket(text: &str, at: usize) -> Option<usize> {
    if let Some((pos, c)) = text[..at].char_indices().next_back().filter(|(_, c)| is_bracket(*c)) {
        return bracket_pair(text, pos, c);
    }
    let c = text[at..].chars().next().filter(|c| is_bracket(*c))?;
    bracket_pair(text, at, c).map(|m| m + text[m..].chars().next().map_or(0, char::len_utf8))
}

/// `gotoLine`'s field: `42`, `42:7` (a column), `+3` or `-3` (from the
/// current line) and `50%`. Lines and columns count as CodeMirror's do: lines
/// from 1, the column as characters into the line.
pub(super) fn goto_target(text: &str, current: usize, query: &str) -> Option<usize> {
    let q = query.trim();
    let (sign, rest) = match q.chars().next() {
        Some('+') => (Some(1i64), &q[1..]),
        Some('-') => (Some(-1i64), &q[1..]),
        _ => (None, q),
    };
    let (rest, percent) = rest.strip_suffix('%').map_or((rest, false), |r| (r, true));
    let (line_part, col_part) = rest.split_once(':').map_or((rest, None), |(l, c)| (l, Some(c)));
    if !line_part.chars().all(|c| c.is_ascii_digit()) || col_part.is_some_and(|c| c.is_empty() || !c.chars().all(|d| d.is_ascii_digit())) {
        return None;
    }
    if line_part.is_empty() && col_part.is_none() {
        return None;
    }
    let lines = text.split('\n').count() as i64;
    let current_line = text[..current].matches('\n').count() as i64 + 1;
    let col: usize = col_part.map_or(Some(0), |c| c.parse().ok())?;
    let mut line = if line_part.is_empty() { current_line } else { line_part.parse::<i64>().ok()? };
    if !line_part.is_empty() && percent {
        let mut pc = line as f64 / 100.;
        if let Some(s) = sign {
            pc = pc * s as f64 + current_line as f64 / lines as f64;
        }
        line = (lines as f64 * pc).round() as i64;
    } else if !line_part.is_empty() {
        if let Some(s) = sign {
            line = line * s + current_line;
        }
    }
    let line = line.clamp(1, lines) as usize;
    let start = text.split('\n').take(line - 1).map(|l| l.len() + 1).sum::<usize>();
    Some(at_column(text, start, col))
}

// --------------------------------------------------------------- the glue

/// Go to Line's field, and ⌘D's run of added matches: the query, whether it
/// was a whole word, every range it selected, and the selection it left.
/// `multi` is set when a gesture may have left more than one cursor, and
/// cleared when the selection is set to one again: GPUI Kit does not say
/// how many there are, and the Markdown keys (`source_markdown.rs`) only
/// act with one.
#[derive(Default)]
pub(super) struct SourceKeys {
    goto: Option<(Entity<InputState>, Subscription)>,
    next: Option<(String, bool, Vec<Range<usize>>, Range<usize>)>,
    pub(super) multi: bool,
}

impl Workspace {
    pub(super) fn source_text_and_selection(&self, cx: &App) -> (String, Range<usize>) {
        let state = self.editor.read(cx);
        (state.text().to_string(), state.selected_range())
    }

    /// Apply one command as one undo step. It leaves one cursor.
    pub(super) fn apply_source_edit(&mut self, edit: Edit, window: &mut Window, cx: &mut Context<Self>) {
        self.source_keys.next = None;
        self.source_keys.multi = false;
        self.editor.update(cx, |s, cx| {
            s.set_selected_range(edit.range.clone(), cx);
            s.replace(edit.text, window, cx);
            s.set_selected_range(edit.select, cx);
        });
    }

    fn source_command(&mut self, f: impl FnOnce(&str, Range<usize>) -> Option<Edit>, window: &mut Window, cx: &mut Context<Self>) {
        let (text, sel) = self.source_text_and_selection(cx);
        if let Some(edit) = f(&text, sel) {
            self.apply_source_edit(edit, window, cx);
        }
    }

    pub(super) fn source_key_actions(d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        d.on_action(cx.listener(|this, _: &MoveLineUp, w, cx| this.source_command(|t, s| move_lines(t, s, true), w, cx)))
            .on_action(cx.listener(|this, _: &MoveLineDown, w, cx| this.source_command(|t, s| move_lines(t, s, false), w, cx)))
            .on_action(cx.listener(|this, _: &CopyLineUp, w, cx| this.source_command(|t, s| Some(copy_lines(t, s, true)), w, cx)))
            .on_action(cx.listener(|this, _: &CopyLineDown, w, cx| this.source_command(|t, s| Some(copy_lines(t, s, false)), w, cx)))
            .on_action(cx.listener(|this, _: &DeleteLine, w, cx| this.source_command(|t, s| Some(delete_lines(t, s)), w, cx)))
            .on_action(cx.listener(|this, _: &InsertBlankLine, w, cx| this.source_command(|t, s| Some(insert_blank_line(t, s)), w, cx)))
            .on_action(cx.listener(|this, _: &SplitLine, w, cx| this.source_command(|_, s| Some(split_line(s)), w, cx)))
            .on_action(cx.listener(|this, _: &TransposeChars, w, cx| this.source_command(transpose_chars, w, cx)))
            .on_action(cx.listener(|this, _: &SelectLine, _, cx| {
                let (text, sel) = this.source_text_and_selection(cx);
                this.source_keys.multi = false;
                this.editor.update(cx, |s, cx| s.set_selected_range(line_selection(&text, sel), cx));
            }))
            .on_action(cx.listener(|this, _: &CursorMatchingBracket, _, cx| {
                let (text, sel) = this.source_text_and_selection(cx);
                if let Some(to) = matching_bracket(&text, sel.end) {
                    this.source_keys.multi = false;
                    this.editor.update(cx, |s, cx| s.set_selected_range(to..to, cx));
                }
            }))
            .on_action(cx.listener(|this, _: &SelectNextOccurrence, _, cx| this.select_next_occurrence(cx)))
            .on_action(cx.listener(|this, _: &SelectAllOccurrences, _, cx| this.select_all_occurrences(cx)))
            .on_action(cx.listener(|this, _: &FindNextMatch, w, cx| this.source_find_step(true, w, cx)))
            .on_action(cx.listener(|this, _: &FindPreviousMatch, w, cx| this.source_find_step(false, w, cx)))
            .on_action(cx.listener(|this, _: &GoToLine, w, cx| this.open_goto_line(w, cx)))
    }

    /// ⌘D: with nothing selected, the word at the cursor; then each press
    /// adds the next match as another selection.
    fn select_next_occurrence(&mut self, cx: &mut Context<Self>) {
        let (text, sel) = self.source_text_and_selection(cx);
        if sel.start == sel.end {
            let Some(word) = word_at(&text, sel.start) else { return };
            self.editor.update(cx, |s, cx| s.set_selected_range(word.clone(), cx));
            self.source_keys.next = Some((text[word.clone()].to_string(), true, vec![word.clone()], word));
            return;
        }
        // Carry on the run while its last selection is still the one on
        // screen; otherwise this selection starts a new one.
        let (query, full_word, mut ranges) = match self.source_keys.next.take() {
            Some((q, w, r, left)) if left == sel => (q, w, r),
            _ => (text[sel.clone()].to_string(), false, vec![sel.clone()]),
        };
        let Some(found) = next_occurrence(&text, &query, &ranges, full_word) else {
            self.source_keys.next = Some((query, full_word, ranges, sel));
            return;
        };
        ranges.push(found.clone());
        ranges.sort_by_key(|r| r.start);
        self.source_keys.multi = true;
        self.editor.update(cx, |s, cx| s.add_selection(found.clone(), cx));
        let left = self.editor.read(cx).selected_range();
        self.source_keys.next = Some((query, full_word, ranges, left));
    }

    /// ⇧⌘L in Source: every match of the selection, or every whole-word
    /// match of the word at the cursor. The selection that was there stays
    /// the main one, and the view stays where it was.
    fn select_all_occurrences(&mut self, cx: &mut Context<Self>) {
        let (text, sel) = self.source_text_and_selection(cx);
        let from_word = sel.start == sel.end;
        let main = if from_word { word_at(&text, sel.start) } else { Some(sel) };
        let Some(main) = main else { return };
        let Some(all) = all_occurrences(&text, &text[main.clone()]) else { return };
        let others: Vec<Range<usize>> = all.into_iter().filter(|r| *r != main && (!from_word || is_whole_word(&text, r))).collect();
        self.source_keys.next = None;
        self.source_keys.multi = !others.is_empty();
        self.editor.update(cx, |s, cx| {
            let scroll = s.scroll_offset();
            s.set_selected_range(main.clone(), cx);
            for r in &others {
                s.add_selection(r.clone(), cx);
            }
            s.set_scroll_offset(scroll, cx);
        });
    }

    /// ⌘G and ⇧⌘G: the find bar's next and previous match, selected. With
    /// no search yet they open the find bar.
    fn source_find_step(&mut self, next: bool, window: &mut Window, cx: &mut Context<Self>) {
        let found = self.editor.update(cx, |s, cx| {
            let r = if next { s.next_search_match(cx) } else { s.previous_search_match(cx) };
            if let Some(r) = &r {
                s.set_selected_range(r.clone(), cx);
            }
            r
        });
        if found.is_some() {
            self.source_keys.multi = false;
        }
        if found.is_none() {
            window.dispatch_action(Box::new(kit::Search), cx);
        }
    }

    /// ⌥⌘G: the Go to Line strip over Source, like the find bar.
    fn open_goto_line(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Line, or line:column"));
        let sub = cx.subscribe_in(&input, window, |this, input, ev: &InputEvent, window, cx| match ev {
            InputEvent::PressEnter { .. } => {
                let query = input.read(cx).value().to_string();
                let (text, sel) = this.source_text_and_selection(cx);
                match goto_target(&text, sel.end, &query) {
                    Some(at) => {
                        this.close_goto_line(window, cx);
                        this.source_keys.multi = false;
                        this.editor.update(cx, |s, cx| s.set_selected_range(at..at, cx));
                    }
                    None => input.update(cx, |s, cx| s.set_value("", window, cx)),
                }
            }
            InputEvent::Blur => {
                if this.source_keys.goto.as_ref().is_some_and(|(i, _)| i == input) {
                    this.source_keys.goto = None;
                    cx.notify();
                }
            }
            _ => {}
        });
        let handle = input.read(cx).focus_handle(cx);
        self.source_keys.goto = Some((input, sub));
        handle.focus(window, cx);
        cx.notify();
    }

    fn close_goto_line(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.source_keys.goto.take().is_some() {
            self.focus_editor(window, cx);
            cx.notify();
        }
    }

    /// The strip, drawn above the Source text when open.
    pub(super) fn render_goto_line(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (input, _) = self.source_keys.goto.as_ref()?;
        let theme = cx.theme();
        Some(
            div()
                .id("goto-line")
                .key_context("GoToLine")
                .flex()
                .items_center()
                .gap_2()
                .py_2()
                .px_3()
                .w_full()
                .bg(theme.tokens.popover)
                .border_b_1()
                .border_color(theme.border)
                .font_family(theme.font_family.clone())
                .role(Role::Dialog)
                .aria_label("Go to line")
                .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                    if ev.keystroke.key == "escape" {
                        this.close_goto_line(window, cx);
                        cx.stop_propagation();
                    }
                }))
                .child(div().flex_none().text_sm().text_color(theme.muted_foreground).child("Go to line"))
                .child(div().w(px(220.)).child(Input::new(input).small().w_full()))
                .into_any_element(),
        )
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// Source keys in the real editor, without a keyboard: `ops` run in
    /// order, each `{"select": [a, b]}`, `{"cmd": name}` (the actions of this
    /// module, as their keys run them), `{"undo": true}`, `{"goto": "12:3"}`,
    /// `{"key": "enter"}` or `{"key": "backspace"}` (GPUI Kit's own action,
    /// dispatched as the key would, so the Markdown keys take it or let it
    /// through), `{"type": "text"}` (typed at the selection) and
    /// `{"paste": "https://…"}` (the paste-as-link command with that text,
    /// since a scene never touches the pasteboard).
    /// Only the main selection can be read back; deleting through several
    /// cursors in a hidden window did not give repeatable results, so the
    /// extra selections ⌘D and ⇧⌘L add are covered by the unit tests.
    /// After each op a `markie-source-state` line logs the text and the
    /// selection, so a check can read what every key did.
    pub(super) fn scene_source(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use serde_json::Value;
        if self.doc.is_none() {
            return false;
        }
        if *step == 0 {
            self.set_mode(super::Mode::Source, window, cx);
            self.focus_editor(window, cx);
            *step = 1;
            return false;
        }
        let ops = args.get("ops").and_then(Value::as_array).cloned().unwrap_or_default();
        let i = *step - 1;
        // What the step before did, a frame later.
        if i > 0 && i <= ops.len() {
            let (text, sel) = self.source_text_and_selection(cx);
            eprintln!("markie-source-state {}", serde_json::json!({ "after": ops[i - 1], "text": text, "selection": [sel.start, sel.end] }));
        }
        if let Some(op) = ops.get(i) {
            if let Some([a, b]) = op.get("select").and_then(Value::as_array).map(|v| [v[0].as_u64().unwrap_or(0) as usize, v[1].as_u64().unwrap_or(0) as usize]).as_ref() {
                self.editor.update(cx, |s, cx| s.set_selected_range(*a..*b, cx));
            }
            if op.get("undo").is_some() {
                window.dispatch_action(Box::new(kit::Undo), cx);
            }
            match op.get("key").and_then(Value::as_str) {
                Some("enter") => window.dispatch_action(Box::new(kit::Enter { secondary: false, shift: false }), cx),
                Some("backspace") => window.dispatch_action(Box::new(kit::Backspace), cx),
                _ => {}
            }
            if let Some(t) = op.get("type").and_then(Value::as_str) {
                let t = t.to_string();
                self.editor.update(cx, |s, cx| s.replace(t, window, cx));
            }
            if let Some(clip) = op.get("paste").and_then(Value::as_str) {
                self.source_markdown_command(|t, s| super::source_markdown::paste_url_link(t, s, clip), window, cx);
            }
            if let Some(q) = op.get("goto").and_then(Value::as_str) {
                let (text, sel) = self.source_text_and_selection(cx);
                if let Some(at) = goto_target(&text, sel.end, q) {
                    self.editor.update(cx, |s, cx| s.set_selected_range(at..at, cx));
                }
            }
            match op.get("cmd").and_then(Value::as_str).unwrap_or_default() {
                "move-up" => self.source_command(|t, s| move_lines(t, s, true), window, cx),
                "move-down" => self.source_command(|t, s| move_lines(t, s, false), window, cx),
                "copy-up" => self.source_command(|t, s| Some(copy_lines(t, s, true)), window, cx),
                "copy-down" => self.source_command(|t, s| Some(copy_lines(t, s, false)), window, cx),
                "delete-line" => self.source_command(|t, s| Some(delete_lines(t, s)), window, cx),
                "blank-line" => self.source_command(|t, s| Some(insert_blank_line(t, s)), window, cx),
                "next" => self.select_next_occurrence(cx),
                "all" => self.select_all_occurrences(cx),
                "goto-open" => self.open_goto_line(window, cx),
                _ => {}
            }
            *step += 1;
            return false;
        }
        *step += 1;
        *step > ops.len() + 4
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob export brings its own `test` attribute.
    use super::{
        Edit, SOURCE, all_occurrences, copy_lines, delete_lines, goto_target, insert_blank_line, key_bindings, line_selection,
        matching_bracket, move_lines, next_occurrence, split_line, transpose_chars, word_at,
    };
    use std::ops::Range;

    fn apply(text: &str, e: &Edit) -> String {
        format!("{}{}{}", &text[..e.range.start], e.text, &text[e.range.end..])
    }

    /// The text with `|` for the cursor, or `[` `]` around a selection.
    fn marked(text: &str) -> (String, Range<usize>) {
        if let Some(i) = text.find('|') {
            return (text.replacen('|', "", 1), i..i);
        }
        let a = text.find('[').unwrap();
        let b = text.find(']').unwrap() - 1;
        (text.replacen('[', "", 1).replacen(']', "", 1), a..b)
    }

    fn show(text: &str, sel: &Range<usize>) -> String {
        if sel.start == sel.end {
            format!("{}|{}", &text[..sel.start], &text[sel.start..])
        } else {
            format!("{}[{}]{}", &text[..sel.start], &text[sel.clone()], &text[sel.end..])
        }
    }

    fn run(f: impl Fn(&str, Range<usize>) -> Option<Edit>, input: &str) -> Option<String> {
        let (text, sel) = marked(input);
        f(&text, sel).map(|e| show(&apply(&text, &e), &e.select))
    }

    #[test]
    fn alt_up_and_down_move_lines_with_the_selection() {
        let up = |t: &str, s| move_lines(t, s, true);
        let down = |t: &str, s| move_lines(t, s, false);
        assert_eq!(run(up, "one\ntw|o\nthree").as_deref(), Some("tw|o\none\nthree"));
        assert_eq!(run(down, "one\ntw|o\nthree").as_deref(), Some("one\nthree\ntw|o"));
        assert_eq!(run(up, "o|ne\ntwo"), None, "nothing above the first line");
        assert_eq!(run(down, "one\nt|wo"), None, "nothing below the last line");
        // A selection over two lines moves both; one ending at a line's start
        // leaves that line alone.
        assert_eq!(run(down, "[a\nb]\nc\nd").as_deref(), Some("c\n[a\nb]\nd"));
        assert_eq!(run(down, "[a\n]b\nc").as_deref(), Some("b\n[a\n]c"));
    }

    #[test]
    fn shift_alt_up_and_down_copy_lines() {
        let up = |t: &str, s| Some(copy_lines(t, s, true));
        let down = |t: &str, s| Some(copy_lines(t, s, false));
        assert_eq!(run(down, "a\nb|b\nc").as_deref(), Some("a\nbb\nb|b\nc"), "down leaves the cursor in the lower copy");
        assert_eq!(run(up, "a\nb|b\nc").as_deref(), Some("a\nb|b\nbb\nc"), "up keeps it in the upper copy");
        assert_eq!(run(down, "[x\ny]").as_deref(), Some("x\ny\n[x\ny]"), "a multi-line selection copies whole lines");
    }

    #[test]
    fn shift_cmd_k_deletes_lines_and_keeps_the_column() {
        let del = |t: &str, s| Some(delete_lines(t, s));
        assert_eq!(run(del, "one\ntw|o\nthree").as_deref(), Some("one\nth|ree"));
        assert_eq!(run(del, "on|e\ntwo").as_deref(), Some("tw|o"), "the first line takes its line break");
        assert_eq!(run(del, "one\ntw|o").as_deref(), Some("one|"), "the last line takes the one before it");
        assert_eq!(run(del, "a\n[b\nc]\nd").as_deref(), Some("a\nd|"), "from the selection's end, a column down");
        assert_eq!(run(del, "on|ly").as_deref(), Some("|"));
    }

    #[test]
    fn cmd_enter_opens_a_line_below_without_splitting() {
        let blank = |t: &str, s| Some(insert_blank_line(t, s));
        assert_eq!(run(blank, "  - it|em\nnext").as_deref(), Some("  - item\n  |\nnext"));
        assert_eq!(run(blank, "la|st").as_deref(), Some("last\n|"));
    }

    #[test]
    fn emacs_split_and_transpose() {
        assert_eq!(run(|_, s| Some(split_line(s)), "ab|cd").as_deref(), Some("ab|\ncd"));
        assert_eq!(run(transpose_chars, "ab|cd").as_deref(), Some("acb|d"));
        assert_eq!(run(transpose_chars, "abc|\nx").as_deref(), Some("ab\nc|x"), "at a line end the break swaps, as CodeMirror's");
        assert_eq!(run(transpose_chars, "|ab"), None);
        assert_eq!(run(transpose_chars, "ab|"), None);
    }

    #[test]
    fn cmd_d_takes_the_word_then_each_next_match() {
        let text = "cat catalog cat bobcat cat";
        assert_eq!(word_at(text, 1), Some(0..3));
        // From a whole word, only whole words match.
        assert_eq!(next_occurrence(text, "cat", &[0..3], true), Some(12..15));
        assert_eq!(next_occurrence(text, "cat", &[0..3, 12..15], true), Some(23..26));
        // Wrapping round skips what is already selected; nothing left: None.
        assert_eq!(next_occurrence(text, "cat", &[0..3, 12..15, 23..26], true), None);
        assert_eq!(next_occurrence(text, "cat", &[12..15], true), Some(23..26));
        assert_eq!(next_occurrence(text, "cat", &[23..26], true), Some(0..3), "wraps to the top");
        // A selection that is not a word matches anywhere.
        assert_eq!(next_occurrence(text, "cat", &[0..3], false), Some(4..7));
    }

    #[test]
    fn shift_cmd_l_selects_every_match() {
        assert_eq!(all_occurrences("a-b a-b ab", "a-b"), Some(vec![0..3, 4..7]));
        assert_eq!(all_occurrences("x", ""), None);
        let many = "z ".repeat(1001);
        assert_eq!(all_occurrences(&many, "z"), None, "more than a thousand is refused, as CodeMirror does");
    }

    #[test]
    fn cmd_alt_g_reads_lines_columns_offsets_and_percent() {
        let text = "one\ntwo\nthree\nfour";
        assert_eq!(goto_target(text, 0, "3"), Some(8));
        assert_eq!(goto_target(text, 0, "3:2"), Some(10));
        assert_eq!(goto_target(text, 0, "3:99"), Some(13), "a column past the end is the line's end");
        assert_eq!(goto_target(text, 0, "99"), Some(14), "a line past the end is the last line");
        assert_eq!(goto_target(text, 4, "+2"), Some(14), "relative to the cursor's line");
        assert_eq!(goto_target(text, 14, "-3"), Some(0));
        assert_eq!(goto_target(text, 0, "50%"), Some(4));
        assert_eq!(goto_target(text, 0, "abc"), None);
        assert_eq!(goto_target(text, 0, ""), None);
    }

    #[test]
    fn ctrl_l_selects_the_line_and_cmd_shift_backslash_finds_the_pair() {
        let (text, sel) = marked("a\nb|b\nc");
        assert_eq!(&text[line_selection(&text, sel)], "bb\n");
        let t = "f(a[b]{c})";
        assert_eq!(matching_bracket(t, 1), Some(10), "before ( goes past its )");
        assert_eq!(matching_bracket(t, 10), Some(1), "after ) goes to its (");
        assert_eq!(matching_bracket(t, 0), None);
    }

    #[test]
    fn every_key_is_bound_in_source_text_only() {
        let typed = |k: &'static str| [gpui_kit::Keystroke::parse(k).unwrap()];
        let bindings = key_bindings();
        for keys in ["alt-up", "alt-down", "shift-alt-up", "shift-alt-down", "cmd-shift-k", "cmd-d", "cmd-shift-l", "cmd-alt-g", "cmd-enter"] {
            let b = bindings.iter().find(|b| b.match_keystrokes(&typed(keys)) == Some(false)).unwrap_or_else(|| panic!("{keys}"));
            assert_eq!(b.predicate().map(|p| p.to_string()).as_deref(), Some(SOURCE), "{keys}");
        }
    }
}
