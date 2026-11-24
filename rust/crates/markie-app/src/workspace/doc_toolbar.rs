//! The row and footer Electron's document workspace puts around a text
//! document: `text-document-editor.tsx` (its start controls and the shared
//! `FormattingToolbar`) and `document-workspace.tsx` (`docs-status`).
//!
//! Plain text, JSON, YAML, XML and CSV source get the literal-text row:
//! format, Find, encoding and newline, history, zoom, font and size. A
//! Darkmown `.wd` adds the Markdown source controls: paragraph style, bold,
//! italic and bullet list, which edit the source text the way
//! `setSourceStyle` and `wrap` do. A `.wd` also gets the workspace's status
//! footer: whether the file has your latest words, then the word count and
//! the format.
//!
//! The stylesheet decides the sizes, not the Tailwind classes:
//! `.docs-workspace button { font: inherit }` gives the buttons the
//! workspace's 13 px, `.markie-doc-toolbar button` their 0 6 px padding and
//! 4 px radius, and the inputs and selects stay at 11 px.

use std::cell::Cell;
use std::ops::Range;

use gpui_kit::component::input::{Redo, Search, Undo};
use gpui_kit::component::menu::{DropdownMenu, PopupMenu, PopupMenuItem};
use gpui_kit::component::Selectable;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::formats::{FormatKind, TextEncoding};
use markie_office_view::icons;

use super::{DocKind, Workspace};
use crate::themes;

thread_local! {
    /// The text field's font size in CSS px, Electron's default 14. A viewing
    /// preference, as in Electron; it is not saved into the file.
    static FONT_SIZE: Cell<f32> = const { Cell::new(14.0) };
    /// Its font, an index into `DOC_FONTS`; Electron starts at "mono".
    static FONT: Cell<usize> = const { Cell::new(MONO_FONT) };
}

const MONO_FONT: usize = 6;

/// How far GPUI Kit's code editor sets its text in from its own edges at
/// the default size: left (6 px of padding and the 6 px gutter margin it
/// keeps without line numbers), right and top. A pane that wants Electron's
/// textarea padding gives the editor that much less.
pub(super) const EDITOR_INSET: (Pixels, Pixels, Pixels) = (px(12.), px(10.), px(8.));

/// `BLOCK_STYLES` in `formatting-toolbar.tsx`.
const STYLES: [(&str, &str); 6] = [
    ("paragraph", "Normal text"),
    ("h1", "Heading 1"),
    ("h2", "Heading 2"),
    ("h3", "Heading 3"),
    ("quote", "Quote"),
    ("code", "Code block"),
];

pub(super) fn font_size() -> f32 {
    FONT_SIZE.with(Cell::get)
}

/// The family the text field draws in: `fontStack(appearance.fontFamily)`.
pub(super) fn font_family(theme_font: &SharedString) -> SharedString {
    let (id, ..) = markie_editor::style::DOC_FONTS[FONT.with(Cell::get)];
    match id {
        "mono" => markie_editor::MONO.into(),
        "system" => theme_font.clone(),
        "sans" => ".SystemUIFont".into(),
        other => markie_editor::style::typeface(other).unwrap_or(markie_editor::MONO).into(),
    }
}

/// "LF", "CRLF", "CR", "MIXED" or "NONE" from the first 64 KB.
pub(super) fn newline_label(text: &str) -> &'static str {
    let mut end = text.len().min(65_536);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let sample = &text.as_bytes()[..end];
    let (mut lf, mut crlf, mut cr) = (0, 0, 0);
    let mut i = 0;
    while i < sample.len() {
        match sample[i] {
            b'\r' if sample.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    match ((lf > 0) as u8 + (crlf > 0) as u8 + (cr > 0) as u8, lf, crlf) {
        (0, ..) => "NONE",
        (1, l, _) if l > 0 => "LF",
        (1, _, c) if c > 0 => "CRLF",
        (1, ..) => "CR",
        _ => "MIXED",
    }
}

/// `session.text.trim().split(/\s+/).length`, 0 for blank text. JavaScript's
/// `\s` and `trim` also take U+FEFF.
pub(super) fn word_count(text: &str) -> usize {
    text.split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|w| !w.is_empty()).count()
}

/// The footer's right side: "230 words · DARKMOWN", and the search note past
/// a million characters (JavaScript counts UTF-16 units).
pub(super) fn status_words(text: &str, format: &str) -> String {
    let long = text.encode_utf16().count() > 1024 * 1024;
    format!("{} words · {format}{}", word_count(text), if long { " · First 1M characters searchable" } else { "" })
}

/// `session.format.toUpperCase()`: Electron's session formats are
/// darkmown, text, markdown, csv, json, yaml and xml.
pub(super) fn format_name(format: FormatKind) -> String {
    match format {
        FormatKind::Darkmown => "DARKMOWN".into(),
        FormatKind::Text => "TEXT".into(),
        other => other.label().to_uppercase(),
    }
}

/// The footer's left side and its title: `status` and `statusDetail`.
pub(super) fn save_status(has_file: bool, edited: bool) -> (&'static str, &'static str) {
    match (has_file, edited) {
        (false, _) => ("Not saved to a file yet", "Kept safe on this Mac as you type. Save file to choose where it goes."),
        (true, true) => ("Edited", "Your changes are kept safe on this Mac. Save file to write them to the file."),
        (true, false) => ("Saved", "Saved"),
    }
}

/// `wrap(before, after)`: the new text and the selection inside the marks.
pub(super) fn wrap(text: &str, sel: Range<usize>, before: &str, after: &str) -> (String, Range<usize>) {
    let out = format!("{}{before}{}{after}{}", &text[..sel.start], &text[sel.clone()], &text[sel.end..]);
    (out, sel.start + before.len()..sel.end + before.len())
}

/// `setSourceStyle`: the whole lines the selection touches get the style's
/// prefix in place of any heading or quote mark; "code" fences the
/// selection. Answers the range replaced, its replacement, and the new
/// selection.
pub(super) fn line_style(text: &str, sel: Range<usize>, style: &str) -> (Range<usize>, String, Range<usize>) {
    if style == "code" {
        let (_, inner) = wrap(text, sel.clone(), "```\n", "\n```");
        let replacement = format!("```\n{}\n```", &text[sel.clone()]);
        return (sel, replacement, inner);
    }
    let prefix = match style {
        "quote" => "> ".to_string(),
        "h1" | "h2" | "h3" => format!("{} ", "#".repeat(style[1..].parse::<usize>().unwrap_or(1))),
        _ => String::new(),
    };
    let start = text[..sel.start].rfind('\n').map_or(0, |i| i + 1);
    let end = text[sel.end..].find('\n').map_or(text.len(), |i| sel.end + i);
    let replacement = text[start..end]
        .split('\n')
        .map(|line| format!("{prefix}{}", strip_block_mark(line)))
        .collect::<Vec<_>>()
        .join("\n");
    let len = replacement.len();
    (start..end, replacement, start..start + len)
}

/// `line.replace(/^(?:#{1,6}\s+|>\s+)/, "")`.
fn strip_block_mark(line: &str) -> &str {
    let hashes = line.len() - line.trim_start_matches('#').len();
    let rest = if (1..=6).contains(&hashes) {
        &line[hashes..]
    } else if let Some(rest) = line.strip_prefix('>') {
        rest
    } else {
        return line;
    };
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() { line } else { trimmed }
}

/// A hand-drawn element that opens a GPUI Kit menu (its dropdown wants a
/// `Selectable` trigger).
#[derive(IntoElement)]
struct Trigger(Stateful<Div>, bool);

impl RenderOnce for Trigger {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        self.0
    }
}

impl Styled for Trigger {
    fn style(&mut self) -> &mut StyleRefinement {
        self.0.style()
    }
}

impl InteractiveElement for Trigger {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.0.interactivity()
    }
}

impl Selectable for Trigger {
    fn selected(mut self, selected: bool) -> Self {
        self.1 = selected;
        self
    }
    fn is_selected(&self) -> bool {
        self.1
    }
}

impl DropdownMenu for Trigger {}

impl Workspace {
    /// The toolbar row above a literal text document or a `.wd` source.
    pub(super) fn text_toolbar(&self, cx: &mut Context<Self>) -> Div {
        let p = themes::palette(cx);
        let Some(doc) = &self.doc else { return div() };
        let darkmown = doc.format == FormatKind::Darkmown;
        let (encoding, bom, newline) = match &doc.kind {
            DocKind::Text { encoding, bom, saved } => (*encoding, *bom, newline_label(saved)),
            _ => (TextEncoding::Utf8, false, "LF"),
        };
        let encoding = match encoding {
            TextEncoding::Utf8 => "UTF-8",
            TextEncoding::Utf16Le => "UTF-16LE",
            TextEncoding::Utf16Be => "UTF-16BE",
        };
        let label = if darkmown {
            "Darkmown · Source".to_string()
        } else if doc.format == FormatKind::Csv {
            format!("CSV · {}", if self.mode == super::Mode::View { "Table" } else { "Text" })
        } else {
            format!("{} · Literal text", format_name(doc.format))
        };
        let size = font_size();
        let (fg, muted, hover) = (p.foreground, p.muted, p.accent.opacity(0.4));
        let editor_focus = self.editor.read(cx).focus_handle(cx);
        let ws = cx.entity().downgrade();
        // `.markie-doc-toolbar button`: 28 px tall, at least 28 wide, 0 6 px.
        let button = |id: &'static str| {
            div()
                .id(id)
                .h(px(28.))
                .min_w(px(28.))
                .px(px(6.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .text_size(px(13.))
                .text_color(muted)
                .cursor_pointer()
                .hover(move |s| s.bg(hover).text_color(fg))
        };
        let icon = |data: &'static [u8]| svg().data(data).size(px(15.)).text_color(muted);
        let send = |action: Box<dyn Action>, focus: FocusHandle| {
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                focus.focus(window, cx);
                window.dispatch_action(action.boxed_clone(), cx);
            }
        };
        let divider = || div().w(px(1.)).h(px(20.)).mx(px(4.)).flex_none().bg(p.border);
        // `.markie-overlay-field`, 28 px tall.
        let field = |id: &'static str, width: f32| {
            div()
                .id(id)
                .w(px(width))
                .h(px(28.))
                .flex_none()
                .flex()
                .items_center()
                .rounded(px(7.))
                .border_1()
                .border_color(p.border)
                .bg(themes::mix(p.background, p.surface, 0.82))
                .text_size(px(11.))
                .text_color(fg)
        };
        let select = |id: &'static str, value: &'static str| {
            // A native select sets its text in a little past `px-1.5`.
            field(id, 140.)
                .pl(px(9.))
                .pr(px(4.))
                .cursor_pointer()
                .child(div().flex_1().min_w_0().truncate().child(value))
                .child(svg().data(icons::CHEVRON).size(px(12.)).text_color(fg))
        };
        // History: dim until there is some; an edited document has some.
        let history = !self.dirty;
        let row = h_row()
            .w_full()
            .flex_none()
            .gap(px(2.))
            .px(px(8.))
            .py(px(4.))
            .border_b_1()
            .border_color(p.border)
            .bg(p.surface)
            .child(
                h_row()
                    .flex_none()
                    .gap(px(2.))
                    .child(div().flex_none().text_size(px(11.)).text_color(muted).child(label))
                    .child(button("text-find").child("Find").on_click(cx.listener(|this, _, window, cx| {
                        // Find from Preview shows the source first (`revealSource`).
                        this.reveal_darkmown_source(cx);
                        let focus = this.editor.read(cx).focus_handle(cx);
                        focus.focus(window, cx);
                        window.dispatch_action(Box::new(Search), cx);
                    })))
                    .child(div().flex_none().text_size(px(11.)).text_color(muted).child(format!("{encoding}{} · {newline}", if bom { " BOM" } else { "" }))),
            )
            .child(button("text-undo").child(icon(icons::UNDO)).when(history, |d| d.opacity(0.35)).on_click(send(Box::new(Undo), editor_focus.clone())))
            .child(button("text-redo").child(icon(icons::REDO)).when(history, |d| d.opacity(0.35)).on_click(send(Box::new(Redo), editor_focus.clone())))
            .child(divider())
            .child(button("text-zoom-out").child(icon(icons::ZOOM_OUT)).on_click(cx.listener(|this, _, _, cx| this.step_text_zoom(-1, cx))))
            .child(div().w(px(38.)).flex_none().text_center().text_size(px(11.)).text_color(muted).child(format!("{}%", (self.zoom * 100.0).round())))
            .child(button("text-zoom-in").child(icon(icons::ZOOM_IN)).on_click(cx.listener(|this, _, _, cx| this.step_text_zoom(1, cx))))
            .child(divider())
            .when(darkmown, |row| {
                let ws = ws.clone();
                row.child(Trigger(select("text-style", "Normal text"), false).dropdown_menu(move |menu: PopupMenu, _, _| {
                    STYLES.iter().fold(menu, |menu, (id, label)| {
                        let ws = ws.clone();
                        menu.item(PopupMenuItem::new(*label).on_click(move |_, window, cx| {
                            if let Some(ws) = ws.upgrade() {
                                ws.update(cx, |ws, cx| ws.source_style(id, window, cx));
                            }
                        }))
                    })
                }))
            })
            .child(Trigger(select("text-font", markie_editor::style::DOC_FONTS[FONT.with(Cell::get)].1), false).dropdown_menu(move |menu: PopupMenu, _, _| {
                let current = FONT.with(Cell::get);
                markie_editor::style::DOC_FONTS.iter().enumerate().fold(menu, |menu, (i, (_, label, _))| {
                    let ws = ws.clone();
                    menu.item(PopupMenuItem::new(*label).checked(i == current).on_click(move |_, _, cx| {
                        FONT.with(|f| f.set(i));
                        if let Some(ws) = ws.upgrade() {
                            ws.update(cx, |_, cx| cx.notify());
                        }
                    }))
                })
            }))
            .child(button("text-size-down").child(icon(icons::MINUS)).on_click(cx.listener(move |_, _, _, cx| {
                FONT_SIZE.with(|s| s.set(markie_editor::style::clamp_font_size(size - 1.0)));
                cx.notify();
            })))
            // `text-center` on a number input: Chromium keeps room for the
            // spin buttons, so the digits sit at the left.
            .child(field("text-size", 38.).pl(px(5.)).child(format!("{size}")))
            .child(button("text-size-up").child(icon(icons::PLUS)).on_click(cx.listener(move |_, _, _, cx| {
                FONT_SIZE.with(|s| s.set(markie_editor::style::clamp_font_size(size + 1.0)));
                cx.notify();
            })));
        if !darkmown {
            return row;
        }
        row.child(divider())
            .child(button("text-bold").child(div().text_size(px(13.)).font_weight(FontWeight::BOLD).child("B")).on_click(cx.listener(|this, _, window, cx| this.source_wrap("**", "**", window, cx))))
            .child(button("text-italic").child(div().text_size(px(13.)).font_family("Georgia").italic().child("I")).on_click(cx.listener(|this, _, window, cx| this.source_wrap("_", "_", window, cx))))
            .child(divider())
            .child(button("text-bullet").child(icon(icons::BULLETS)).on_click(cx.listener(|this, _, window, cx| this.source_wrap("- ", "", window, cx))))
    }

    /// `docs-status`: 38 px, 12 px muted text, 18 px apart.
    pub(super) fn doc_status(&self, cx: &mut Context<Self>) -> Div {
        let p = themes::palette(cx);
        let Some(doc) = &self.doc else { return div() };
        let (status, detail) = save_status(!self.is_untitled(), self.dirty);
        let words = status_words(&self.current_text(cx), &format_name(doc.format));
        h_row()
            .w_full()
            .flex_none()
            .h(px(38.))
            .gap(px(18.))
            .px(px(18.))
            .border_t_1()
            .border_color(themes::mix(p.foreground, p.border, 0.1))
            .bg(p.background)
            .text_size(px(12.))
            .text_color(p.muted)
            .child(
                div()
                    .id("doc-status")
                    .flex_1()
                    .min_w_0()
                    .child(status)
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(detail).build(window, cx)),
            )
            .child(div().flex_none().child(words))
    }

    /// The toolbar's mark buttons: wrap the selection, keep it selected
    /// inside the marks, through the editor's own undo history.
    pub(super) fn source_wrap(&mut self, before: &str, after: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.reveal_darkmown_source(cx);
        let (text, sel) = {
            let s = self.editor.read(cx);
            (s.value().to_string(), s.selected_range())
        };
        let inner = sel.start + before.len()..sel.end + before.len();
        let replacement = format!("{before}{}{after}", &text[sel.clone()]);
        self.replace_source(sel, &replacement, inner, window, cx);
    }

    /// The paragraph style menu.
    pub(super) fn source_style(&mut self, style: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.reveal_darkmown_source(cx);
        let (text, sel) = {
            let s = self.editor.read(cx);
            (s.value().to_string(), s.selected_range())
        };
        let (range, replacement, next) = line_style(&text, sel, style);
        self.replace_source(range, &replacement, next, window, cx);
    }

    fn replace_source(&mut self, range: Range<usize>, replacement: &str, select: Range<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let focus = self.editor.read(cx).focus_handle(cx);
        focus.focus(window, cx);
        self.editor.update(cx, |s, cx| {
            s.set_selected_range(range, cx);
            s.replace(replacement.to_string(), window, cx);
            s.set_selected_range(select, cx);
        });
        self.on_edit(cx);
    }

    /// `onSourceEditRequested`: a toolbar edit from Preview shows the source.
    fn reveal_darkmown_source(&mut self, cx: &mut Context<Self>) {
        if self.is_darkmown_doc() && self.darkmown.mode == super::darkmown::Mode::Preview {
            self.darkmown.mode = super::darkmown::Mode::Split;
            cx.notify();
        }
    }
}

fn h_row() -> Div {
    div().flex().flex_row().items_center()
}

#[cfg(test)]
mod tests {
    use super::{line_style, save_status, status_words, word_count, wrap};

    #[test]
    fn words_count_as_split_on_whitespace_does() {
        assert_eq!(word_count(""), 0);
        assert_eq!(word_count("  \n\t "), 0);
        assert_eq!(word_count("\u{feff}one  two\nthree"), 3);
        assert_eq!(status_words("a b", "DARKMOWN"), "2 words · DARKMOWN");
    }

    #[test]
    fn the_footer_says_whether_the_file_has_your_words() {
        assert_eq!(save_status(true, false).0, "Saved");
        assert_eq!(save_status(true, true).0, "Edited");
        assert_eq!(save_status(false, true).0, "Not saved to a file yet");
    }

    #[test]
    fn marks_wrap_the_selection_and_keep_it_selected() {
        let (text, sel) = wrap("say hello now", 4..9, "**", "**");
        assert_eq!(text, "say **hello** now");
        assert_eq!(&text[sel], "hello");
        let (text, sel) = wrap("item", 0..0, "- ", "");
        assert_eq!((text.as_str(), sel), ("- item", 2..2));
    }

    #[test]
    fn styles_replace_the_whole_lines_marks() {
        let text = "intro\n## old\n> quoted\nend";
        // A selection across the heading and the quote lines.
        let (range, replacement, next) = line_style(text, 8..15, "h1");
        assert_eq!(&text[range.clone()], "## old\n> quoted");
        assert_eq!(replacement, "# old\n# quoted");
        assert_eq!(next, range.start..range.start + replacement.len());
        let (_, replacement, _) = line_style(text, 0..0, "quote");
        assert_eq!(replacement, "> intro");
        let (_, replacement, _) = line_style(text, 9..9, "paragraph");
        assert_eq!(replacement, "old");
        // "#hashtag" has no space after the marks, so it is not a heading.
        let (_, replacement, _) = line_style("#tag", 0..0, "h2");
        assert_eq!(replacement, "## #tag");
        let (range, replacement, next) = line_style("a\nb", 0..3, "code");
        assert_eq!((range, replacement.as_str(), next), (0..3, "```\na\nb\n```", 4..7));
    }
}
