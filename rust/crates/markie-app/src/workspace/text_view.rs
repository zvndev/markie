//! Plain text, CSV source, JSON, YAML and XML as Electron's
//! `TextDocumentEditor` shows them: a toolbar row with the format, Find,
//! encoding and newline, history, zoom, font and size, over the literal text
//! in a padded monospace field with no line numbers or syntax colors.

use std::cell::Cell;

use gpui_kit::component::ActiveTheme;
use gpui_kit::component::input::{Editor, Redo, Search, Undo};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::formats::{FormatKind, TextEncoding};
use markie_office_view::icons;

use super::{DocKind, Workspace};

thread_local! {
    /// The text view's font size in CSS px, Electron's default 14. A viewing
    /// preference, as in Electron; it is not saved into the file.
    static FONT_SIZE: Cell<f32> = const { Cell::new(14.0) };
}

/// "LF", "CRLF", "CR", "MIXED" or "NONE" from the first 64 KB.
fn newline_label(text: &str) -> &'static str {
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

impl Workspace {
    pub(super) fn render_text(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let Some(doc) = &self.doc else { return div().into_any_element() };
        let (encoding, bom, newline) = match &doc.kind {
            DocKind::Text { encoding, bom, saved } => (*encoding, *bom, newline_label(saved)),
            _ => (TextEncoding::Utf8, false, "LF"),
        };
        let encoding = match encoding {
            TextEncoding::Utf8 => "UTF-8",
            TextEncoding::Utf16Le => "UTF-16LE",
            TextEncoding::Utf16Be => "UTF-16BE",
        };
        let format = match doc.format {
            FormatKind::Text => "TEXT".to_string(),
            other => other.label().to_uppercase(),
        };
        let size = FONT_SIZE.with(Cell::get);
        let (fg, muted, hover) = (theme.foreground, theme.muted_foreground, theme.accent.opacity(0.4));
        let editor_focus = self.editor.read(cx).focus_handle(cx);
        let button = |id: &'static str, icon: &'static [u8]| {
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
                .text_color(muted)
                .hover(move |s| s.bg(hover).text_color(fg))
                .child(svg().data(icon).size(px(15.)).text_color(muted))
        };
        let send = |action: Box<dyn Action>, focus: FocusHandle| {
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                focus.focus(window, cx);
                window.dispatch_action(action.boxed_clone(), cx);
            }
        };
        let divider = || div().w(px(1.)).h(px(20.)).mx(px(4.)).flex_none().bg(theme.border);
        let toolbar = h_flex_row()
            .w_full()
            .flex_none()
            .gap(px(2.))
            .px(px(8.))
            .py(px(4.))
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.muted)
            .text_size(px(11.))
            .child(div().flex_none().text_color(muted).child(format!("{format} · Literal text")))
            .child(
                div()
                    .id("text-find")
                    .h(px(28.))
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .rounded(px(4.))
                    .text_color(muted)
                    .hover(move |s| s.bg(hover).text_color(fg))
                    .child("Find")
                    .on_click(send(Box::new(Search), editor_focus.clone())),
            )
            .child(div().flex_none().text_size(px(9.)).text_color(muted).child(format!("{encoding}{} · {newline}", if bom { " BOM" } else { "" })))
            // Electron dims history until there is some; an edited document has some.
            .child(button("text-undo", icons::UNDO).when(!self.dirty, |d| d.opacity(0.35)).on_click(send(Box::new(Undo), editor_focus.clone())))
            .child(button("text-redo", icons::REDO).when(!self.dirty, |d| d.opacity(0.35)).on_click(send(Box::new(Redo), editor_focus.clone())))
            .child(divider())
            .child(button("text-zoom-out", icons::ZOOM_OUT).on_click(cx.listener(|this, _, _, cx| this.step_text_zoom(-1, cx))))
            .child(div().w(px(38.)).flex_none().text_center().text_color(muted).child(format!("{}%", (self.zoom * 100.0).round())))
            .child(button("text-zoom-in", icons::ZOOM_IN).on_click(cx.listener(|this, _, _, cx| this.step_text_zoom(1, cx))))
            .child(divider())
            .child(
                div()
                    .w(px(140.))
                    .h(px(28.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .pl(px(6.))
                    .pr(px(4.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.background)
                    .text_color(fg)
                    .child(div().flex_1().child("Monospace"))
                    .child(svg().data(icons::CHEVRON).size(px(12.)).text_color(fg)),
            )
            .child(button("text-size-down", icons::MINUS).on_click(cx.listener(move |_, _, _, cx| {
                FONT_SIZE.with(|s| s.set((size - 1.0).max(10.0)));
                cx.notify();
            })))
            .child(
                div()
                    .w(px(38.))
                    .h(px(28.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.background)
                    .text_color(fg)
                    .child(format!("{size}")),
            )
            .child(button("text-size-up", icons::PLUS).on_click(cx.listener(move |_, _, _, cx| {
                FONT_SIZE.with(|s| s.set((size + 1.0).min(32.0)));
                cx.notify();
            })));
        // Electron pads the field by clamp(24px, 5vw, 64px) of the window.
        let pad = px(64.);
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.background)
            .child(toolbar)
            .child(
                div().flex_1().min_h_0().pl(pad).pt(pad).child(
                    Editor::new(&self.editor)
                        .bordered(false)
                        .h(relative(1.))
                        .font_family(theme.mono_font_family.clone())
                        .text_size(px(size * self.zoom))
                        .line_height(relative(1.85)),
                ),
            )
            .into_any_element()
    }

    /// Electron's zoom presets, as the Word toolbar steps them.
    fn step_text_zoom(&mut self, direction: i32, cx: &mut Context<Self>) {
        const STEPS: [f32; 8] = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];
        let nearest = (0..STEPS.len()).min_by(|a, b| (STEPS[*a] - self.zoom).abs().total_cmp(&(STEPS[*b] - self.zoom).abs())).unwrap_or(3);
        let next = STEPS[(nearest as i32 + direction).clamp(0, STEPS.len() as i32 - 1) as usize];
        self.set_zoom(next, cx);
        self.zoom = next;
        cx.notify();
    }
}

fn h_flex_row() -> Div {
    div().flex().flex_row().items_center()
}

/// Electron's `formatMegabytes`: one decimal under 10 MB, none above.
fn megabytes(bytes: usize) -> String {
    let mb = bytes as f64 / 1_000_000.0;
    if mb < 10.0 { format!("{mb:.1} MB") } else { format!("{} MB", mb.round()) }
}

/// Electron's `LargeDocStrip` above a document opened in source view because
/// of its size: a statement with nothing to click.
pub(super) fn large_strip(bytes: usize, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let note = if bytes >= 100_000_000 {
        format!("This document is now {}, more than Markie opens (100 MB). It still saves, but Markie will not open it again until it is smaller.", megabytes(bytes))
    } else {
        format!("Large document ({}). Opened in source view; rich editing and live collaboration are off for files over 1.0 MB.", megabytes(bytes))
    };
    h_flex_row()
        .flex_none()
        .gap(px(8.))
        .px(px(12.))
        .py(px(6.))
        .bg(theme.muted)
        .border_b_1()
        .border_color(theme.border)
        .child(div().text_size(px(12.)).line_height(px(12.)).child("≡"))
        .child(div().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().text_size(px(11.)).text_color(theme.muted_foreground).child(note))
        .into_any_element()
}
