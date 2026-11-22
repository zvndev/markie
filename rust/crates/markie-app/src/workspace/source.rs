//! Document commands that work on the Markdown text in either mode, as
//! page.tsx runs them: Format Tables (⌥⌘T) and Find and Replace (⌥⌘F).
//! Source mode itself is GPUI Kit's code editor: tree-sitter highlighting
//! with fenced languages, folding, line numbers, wrapping, multiple cursors
//! (⌘⌥↑ and ⌘⌥↓), its own search bar and undo. On top of it, CodeMirror's
//! two mouse gestures from Electron's basic setup: ⌘-click adds a cursor
//! (`clickAddsSelectionRange`) and ⌥-drag selects a rectangle
//! (`rectangularSelection`), one range per line.

use std::cell::RefCell;
use std::ops::Range;

use gpui_kit::*;

use super::Workspace;

/// One line of the text: where it starts in bytes and in UTF-16 units (what
/// the input handler reports), and its text without the newline.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Line {
    byte: usize,
    utf16: usize,
    text: String,
}

pub(super) fn lines_of(text: &str) -> Vec<Line> {
    let mut out = Vec::new();
    let (mut byte, mut utf16) = (0, 0);
    for piece in text.split('\n') {
        out.push(Line { byte, utf16, text: piece.to_string() });
        byte += piece.len() + 1;
        utf16 += piece.encode_utf16().count() + 1;
    }
    out
}

/// A UTF-16 offset as (line, column in characters).
pub(super) fn locate(lines: &[Line], utf16: usize) -> (usize, usize) {
    let l = lines.partition_point(|x| x.utf16 <= utf16).saturating_sub(1);
    let line = &lines[l];
    let mut u = line.utf16;
    let mut col = 0;
    for c in line.text.chars() {
        if u >= utf16 {
            break;
        }
        u += c.len_utf16();
        col += 1;
    }
    (l, col)
}

/// The byte offset of (line, column), the column clamped to the line.
pub(super) fn byte_at(lines: &[Line], (l, col): (usize, usize)) -> usize {
    let line = &lines[l.min(lines.len() - 1)];
    line.byte + line.text.char_indices().nth(col).map(|(b, _)| b).unwrap_or(line.text.len())
}

/// `rectangularSelection`: from the anchor's line to the head's, the
/// columns between the two on each line. A line too short to reach the
/// left column gets nothing, unless the rectangle has no width, when every
/// line gets a cursor at the column or its end.
pub(super) fn rect_ranges(lines: &[Line], a: (usize, usize), b: (usize, usize)) -> Vec<Range<usize>> {
    let (top, bottom) = (a.0.min(b.0), a.0.max(b.0));
    let (left, right) = (a.1.min(b.1), a.1.max(b.1));
    let mut out = Vec::new();
    for l in top..=bottom.min(lines.len().saturating_sub(1)) {
        let len = lines[l].text.chars().count();
        if left == right {
            let at = byte_at(lines, (l, left.min(len)));
            out.push(at..at);
        } else if left <= len {
            out.push(byte_at(lines, (l, left))..byte_at(lines, (l, right.min(len))));
        }
    }
    out
}

thread_local! {
    /// An ⌥-drag in progress: the text's lines and the anchor.
    static RECT: RefCell<Option<(Vec<Line>, (usize, usize))>> = const { RefCell::new(None) };
}

actions!(markie_source, [FormatTables, FindReplace]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("cmd-alt-t", FormatTables, None), KeyBinding::new("cmd-alt-f", FindReplace, None)]);
}

impl Workspace {
    /// The Source editor with CodeMirror's ⌘-click and ⌥-drag. The presses
    /// are taken in the capture phase, before GPUI Kit's own (where ⌥-click
    /// adds a cursor and ⌥⇧-drag selects a block, both kept).
    pub(super) fn source_mouse(&self, editor: impl IntoElement, cx: &mut Context<Self>) -> Div {
        div()
            .size_full()
            .min_h_0()
            .child(editor)
            .capture_any_mouse_down(cx.listener(|this, ev: &MouseDownEvent, window, cx| this.source_mouse_down(ev, window, cx)))
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, window, cx| this.source_mouse_move(ev, window, cx)))
            .capture_any_mouse_up(cx.listener(|_, _: &MouseUpEvent, _, _| {
                RECT.with(|r| r.borrow_mut().take());
            }))
    }

    fn source_point(&self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> Option<usize> {
        self.editor.update(cx, |s, cx| s.character_index_for_point(at, window, cx))
    }

    fn source_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        RECT.with(|r| r.borrow_mut().take());
        let m = ev.modifiers;
        if ev.button != MouseButton::Left || ev.click_count != 1 || m.shift || m.control || m.alt == m.platform {
            return;
        }
        let Some(u) = self.source_point(ev.position, window, cx) else { return };
        let lines = lines_of(&self.editor.read(cx).text().to_string());
        let at = locate(&lines, u);
        let byte = byte_at(&lines, at);
        let h = self.editor.read(cx).focus_handle(cx);
        h.focus(window, cx);
        if m.platform {
            self.editor.update(cx, |s, cx| s.add_selection(byte..byte, cx));
        } else {
            self.editor.update(cx, |s, cx| s.set_selected_range(byte..byte, cx));
            RECT.with(|r| *r.borrow_mut() = Some((lines, at)));
        }
        window.prevent_default();
        cx.stop_propagation();
    }

    fn source_mouse_move(&mut self, ev: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !RECT.with(|r| r.borrow().is_some()) {
            return;
        }
        if ev.pressed_button != Some(MouseButton::Left) {
            RECT.with(|r| r.borrow_mut().take());
            return;
        }
        let Some(u) = self.source_point(ev.position, window, cx) else { return };
        let ranges = RECT.with(|r| {
            let r = r.borrow();
            let (lines, anchor) = r.as_ref()?;
            Some(rect_ranges(lines, *anchor, locate(lines, u)))
        });
        let Some(ranges) = ranges else { return };
        let Some(first) = ranges.first().cloned() else { return };
        self.editor.update(cx, |s, cx| {
            s.set_selected_range(first, cx);
            for r in ranges.into_iter().skip(1) {
                s.add_selection(r, cx);
            }
        });
    }

    pub(super) fn source_actions(d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        d.on_action(cx.listener(Self::on_format_tables)).on_action(cx.listener(Self::on_find_replace))
    }

    fn on_format_tables(&mut self, _: &FormatTables, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.doc.as_ref().map(|d| &d.kind), Some(super::DocKind::Text { .. })) {
            return;
        }
        let text = self.current_text(cx);
        let formatted = markie_core::format_tables::format_markdown_tables(&text);
        if formatted == text {
            return;
        }
        self.editor.update(cx, |s, cx| s.set_value(formatted.clone(), window, cx));
        if self.rich_active() {
            self.load_rich(&formatted, cx);
        }
        self.on_edit(cx);
    }

    fn on_find_replace(&mut self, _: &FindReplace, window: &mut Window, cx: &mut Context<Self>) {
        if self.rich_active() {
            // The View find bar always has its replace field.
            let h = self.rich.read(cx).focus_handle().clone();
            h.focus(window, cx);
            window.dispatch_action(Box::new(markie_editor::Find), cx);
        } else {
            let h = self.editor.read(cx).focus_handle(cx);
            h.focus(window, cx);
            window.dispatch_action(Box::new(gpui_kit::component::input::Replace), cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{byte_at, lines_of, locate, rect_ranges};

    #[test]
    fn offsets_map_between_utf16_and_lines() {
        let lines = lines_of("ab\ncé🎉d\n\nlast");
        assert_eq!(locate(&lines, 0), (0, 0));
        assert_eq!(locate(&lines, 3), (1, 0));
        // The emoji is two UTF-16 units and one character.
        assert_eq!(locate(&lines, 7), (1, 3));
        assert_eq!(byte_at(&lines, (1, 3)), 3 + 1 + 2 + 4);
        assert_eq!(locate(&lines, 10), (3, 0));
    }

    #[test]
    fn an_option_drag_selects_the_same_columns_on_each_line() {
        let text = "alpha\nbe\ngamma\n";
        let lines = lines_of(text);
        let r = rect_ranges(&lines, (0, 1), (2, 4));
        let parts: Vec<&str> = r.iter().map(|r| &text[r.clone()]).collect();
        // "be" is long enough to start at column 1 and is cut at its end.
        assert_eq!(parts, vec!["lph", "e", "amm"]);
        // A line shorter than the left column gets nothing.
        let r = rect_ranges(&lines, (0, 3), (2, 5));
        assert_eq!(r.len(), 2);
        // No width: a cursor on every line, at the column or the line's end.
        let r = rect_ranges(&lines, (0, 4), (2, 4));
        assert_eq!(r.iter().map(|r| r.start).collect::<Vec<_>>(), vec![4, 8, 13]);
    }
}
