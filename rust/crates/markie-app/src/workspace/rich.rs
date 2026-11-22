//! View mode's rich editor (`markie-editor`) inside the workspace: loading
//! the open document into it, autosaving its edits through `write_text`,
//! and keeping Source mode's text in step.

use std::cell::RefCell;
use std::sync::OnceLock;

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::*;
use serde::Deserialize;

use markie_core::formats::FormatKind;
use markie_editor::style::{DocStyle, WIDTH_STEPS, step_width, width_index};
use markie_editor::{RichEvent, RichView};

use super::{DocKind, Mode, OpenDoc, Workspace};

impl Workspace {
    pub(super) fn new_rich(cx: &mut Context<Self>) -> (Entity<RichView>, Subscription) {
        let rich = cx.new(RichView::new);
        let sub = cx.subscribe(&rich, |this, _, ev: &RichEvent, cx| match ev {
            RichEvent::Changed => {
                // A live room takes the edit first (collab.rs).
                this.live_local_edit(cx);
                this.on_rich_edit(cx)
            }
            RichEvent::Undo => this.live_undo(false, cx),
            RichEvent::Redo => this.live_undo(true, cx),
            RichEvent::DocumentLink(reference) => this.follow_cloud_link(reference, cx),
            RichEvent::Zoom(z) => this.set_zoom(*z, cx),
            RichEvent::PageWidth(w) => this.set_width_step(*w, cx),
            RichEvent::History => this.toggle_side(super::SidePanel::History, cx),
            RichEvent::Print => {}
        });
        (rich, sub)
    }

    /// Is View mode showing the rich editor for the open document?
    pub(super) fn rich_active(&self) -> bool {
        self.mode == Mode::View
            && matches!(self.doc.as_ref(), Some(OpenDoc { format: FormatKind::Markdown, large: false, kind: DocKind::Text { .. }, .. }))
    }

    /// The document's text as it would be saved, from whichever editor
    /// holds the latest edits.
    pub(super) fn current_text(&self, cx: &App) -> String {
        if self.rich_active() {
            self.rich.read(cx).markdown()
        } else {
            self.editor.read(cx).value().to_string()
        }
    }

    /// Put Markdown text in the rich editor (on open, reload, or coming
    /// back from Source).
    pub(super) fn load_rich(&mut self, text: &str, cx: &mut Context<Self>) {
        let dir = self.doc.as_ref().and_then(|d| d.path.parent().map(|p| p.to_path_buf()));
        self.rich.update(cx, |r, cx| r.load(text, dir, cx));
    }

    pub(super) fn on_rich_edit(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = &self.doc else { return };
        let text = self.rich.read(cx).markdown();
        self.dirty = &text != saved;
        self.update_stats(&text);
        // A live room that cannot carry this file leaves the file alone.
        if self.live_holds_file() {
            cx.notify();
            return;
        }
        if self.dirty && self.disk_conflict.is_none() {
            self.autosave.note_change(std::time::Instant::now());
            self.schedule_autosave(cx);
        }
        cx.notify();
    }

    /// Leaving View for Source: Source gets the rich editor's text.
    pub(super) fn rich_to_source(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.rich.read(cx).markdown();
        if self.editor.read(cx).value().as_ref() as &str != text.as_str() {
            self.editor.update(cx, |s, cx| s.set_value(text, window, cx));
        }
    }

    /// What gets focus when the window opens: the rich editor when View
    /// mode shows one, else the workspace.
    pub fn startup_focus(&self, cx: &App) -> FocusHandle {
        if self.rich_active() { self.rich.read(cx).focus_handle().clone() } else { self.focus_handle.clone() }
    }

    pub(super) fn focus_rich(&self, window: &mut Window, cx: &mut Context<Self>) {
        // After this frame: the click that switched modes would otherwise
        // keep focus on the button.
        let handle = self.rich.read(cx).focus_handle().clone();
        window.defer(cx, move |window, cx| handle.focus(window, cx));
    }

    /// The outline in View mode: the heading at `line` in the rich editor.
    pub(super) fn reveal_section_line(&mut self, line: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(k) = self.sections.iter().position(|s| s.line == line) else { return false };
        let text = self.sections[k].text.clone();
        let index = {
            let outline = self.rich.read(cx).editor.outline();
            if outline.len() == self.sections.len() {
                Some(k)
            } else {
                // Count headings with the same text up to this one.
                let nth = self.sections[..k].iter().filter(|s| s.text == text).count();
                outline.iter().enumerate().filter(|(_, e)| e.text == text).nth(nth).map(|(i, _)| i)
            }
        };
        let Some(i) = index else { return false };
        self.rich.update(cx, |r, cx| r.reveal_heading(i, window, cx));
        true
    }

    /// Zoom, page width and the template's typography follow the
    /// workspace's settings and theme.
    pub(super) fn sync_rich_appearance(&self, cx: &mut Context<Self>) {
        let (z, w) = (self.zoom, self.page_width);
        let style = doc_style(cx.theme().background);
        self.rich.update(cx, |r, cx| {
            if (r.zoom - z).abs() > f32::EPSILON || (r.page_width - w).abs() > f32::EPSILON {
                r.set_appearance(z, w, cx);
            }
            r.set_style(style, cx);
        });
    }

    /// Electron's formatting row, above the Source pane too.
    pub(super) fn source_toolbar(&self, cx: &mut Context<Self>) -> Entity<markie_editor::SourceToolbar> {
        self.sync_rich_appearance(cx);
        self.rich.update(cx, |r, cx| r.source_toolbar(cx))
    }

    /// A step of Electron's page widths. "Default" is stored as 768, the
    /// width this setting always meant, and "Full" as the 1600 ceiling.
    pub(super) fn set_width_step(&mut self, step: f32, cx: &mut Context<Self>) {
        let px = match width_index(step) {
            0 => 768.0,
            4 => 1600.0,
            i => WIDTH_STEPS[i],
        };
        self.set_page_width(px, cx);
    }

    pub(super) fn step_page_width(&mut self, wider: bool, cx: &mut Context<Self>) {
        self.set_width_step(step_width(self.page_width, wider), cx);
    }
}

/// One variant's typography in `themes/templates.json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Typography {
    background: String,
    doc_rule: Option<String>,
    border: String,
    link: String,
    body_font: Option<String>,
    heading_font: Option<String>,
    line_height: Option<f32>,
    paragraph_gap: Option<f32>,
    font_size: Option<f32>,
    content_width: Option<f32>,
}

#[derive(Deserialize)]
struct TemplateTypography {
    light: Typography,
    dark: Typography,
}

fn hex(s: &str) -> Option<Hsla> {
    let h = s.trim().trim_start_matches('#');
    (h.len() == 6).then(|| u32::from_str_radix(h, 16).ok().map(|v| rgb(v).into())).flatten()
}

/// The page's look for the theme in use, found by its background colour
/// (every template variant has its own), and kept until that changes.
fn doc_style(background: Hsla) -> DocStyle {
    static ALL: OnceLock<Vec<TemplateTypography>> = OnceLock::new();
    thread_local! {
        static LAST: RefCell<Option<(Hsla, DocStyle)>> = const { RefCell::new(None) };
    }
    if let Some(style) = LAST.with(|l| l.borrow().as_ref().filter(|(bg, _)| *bg == background).map(|(_, s)| s.clone())) {
        return style;
    }
    let all = ALL.get_or_init(|| serde_json::from_str(include_str!("../../themes/templates.json")).unwrap_or_default());
    let found = all.iter().flat_map(|t| [&t.light, &t.dark]).find(|v| hex(&v.background) == Some(background));
    let style = found
        .map(|v| {
            let d = DocStyle::default();
            DocStyle {
                body_font: v.body_font.clone().unwrap_or(d.body_font),
                heading_font: v.heading_font.clone().unwrap_or(d.heading_font),
                line_height: v.line_height.unwrap_or(d.line_height),
                paragraph_gap: v.paragraph_gap.unwrap_or(d.paragraph_gap),
                font_size: v.font_size.unwrap_or(d.font_size),
                content_width: v.content_width.unwrap_or(d.content_width),
                doc_rule: v.doc_rule.as_deref().and_then(hex).or_else(|| hex(&v.border)).unwrap_or(d.doc_rule),
                link: hex(&v.link).unwrap_or(d.link),
            }
        })
        .unwrap_or_default();
    LAST.with(|l| *l.borrow_mut() = Some((background, style.clone())));
    style
}
