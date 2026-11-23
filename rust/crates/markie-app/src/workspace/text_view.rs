//! Plain text, CSV source, JSON, YAML and XML as Electron's
//! `TextDocumentEditor` shows them: a toolbar row with the format, Find,
//! encoding and newline, history, zoom, font and size, over the literal text
//! in a padded monospace field with no line numbers or syntax colors. The
//! row is shared with the `.wd` source (`doc_toolbar.rs`).

use gpui_kit::component::ActiveTheme;
use gpui_kit::component::input::Editor;
use gpui_kit::*;

use super::{Workspace, doc_toolbar};

impl Workspace {
    pub(super) fn render_text(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        if self.doc.is_none() {
            return div().into_any_element();
        }
        // Electron pads the field by clamp(24px, 5vw, 64px) of the window.
        let pad = px(64.);
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.background)
            .child(self.text_toolbar(cx))
            .child(
                div().flex_1().min_h_0().pl(pad - doc_toolbar::EDITOR_INSET.0).pt(pad - doc_toolbar::EDITOR_INSET.2).child(
                    Editor::new(&self.editor)
                        .bordered(false)
                        .h(relative(1.))
                        .font_family(doc_toolbar::font_family(&theme.mono_font_family))
                        .text_size(px(doc_toolbar::font_size() * self.zoom))
                        .line_height(relative(1.85)),
                ),
            )
            .into_any_element()
    }

    /// Electron's zoom presets, as the Word toolbar steps them.
    pub(super) fn step_text_zoom(&mut self, direction: i32, cx: &mut Context<Self>) {
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
