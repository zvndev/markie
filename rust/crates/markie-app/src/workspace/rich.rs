//! View mode's rich editor (`markie-editor`) inside the workspace: loading
//! the open document into it, autosaving its edits through `write_text`,
//! and keeping Source mode's text in step.


use gpui_kit::component::ActiveTheme as _;
use gpui_kit::*;

use markie_core::formats::FormatKind;
use markie_editor::style::{DocStyle, WIDTH_STEPS, step_width, width_index};
use markie_editor::{RichEvent, RichView};

use super::{DocKind, Mode, OpenDoc, Workspace};

impl Workspace {
    pub(super) fn new_rich(window: &mut Window, cx: &mut Context<Self>) -> (Entity<RichView>, Subscription) {
        let rich = cx.new(RichView::new);
        let sub = cx.subscribe_in(&rich, window, |this, _, ev: &RichEvent, window, cx| match ev {
            RichEvent::RenderFailed(detail) => this.show_document_failure(detail, cx),
            RichEvent::Changed => {
                // A live room takes the edit first (collab.rs).
                this.live_local_edit(cx);
                this.on_rich_edit(cx)
            }
            RichEvent::Undo => this.live_undo(false, cx),
            RichEvent::Redo => this.live_undo(true, cx),
            RichEvent::OpenPaths(paths) => {
                if let Some(p) = paths.first() {
                    this.open_path(p, window, cx);
                }
            }
            RichEvent::OpenLocal(href) => this.open_rich_link(href, window, cx),
            RichEvent::GrantAttachments(paths) => {
                for path in paths {
                    this.file_grants.grant_attachment(path);
                }
                this.sync_rich_media_grants(cx);
            }
            RichEvent::DocumentLink(reference) => this.follow_cloud_link(reference, cx),
            RichEvent::Zoom(z) => this.set_zoom(*z, cx),
            RichEvent::PageWidth(w) => this.set_width_step(*w, cx),
            RichEvent::History => this.on_show_history(&crate::actions::ShowHistory, window, cx),
            RichEvent::Print => this.on_print(&crate::actions::Print, window, cx),
        });
        (rich, sub)
    }

    /// Is View mode showing the rich editor for the open document?
    pub(super) fn rich_active(&self) -> bool {
        matches!(self.mode, Mode::View | Mode::Split)
            && matches!(self.doc.as_ref(), Some(OpenDoc { format: FormatKind::Markdown | FormatKind::Csv, large: false, kind: DocKind::Text { .. }, .. }))
    }

    /// The document's text as it would be saved, from whichever editor
    /// holds the latest edits.
    pub(super) fn current_text(&self, cx: &App) -> String {
        if self.rich_active() && !(self.mode == Mode::Split && self.split_source_latest) {
            self.rich.read(cx).markdown()
        } else {
            self.editor.read(cx).value().to_string()
        }
    }

    /// Put Markdown text in the rich editor (on open, reload, or coming
    /// back from Source).
    pub(super) fn load_rich(&mut self, text: &str, cx: &mut Context<Self>) {
        self.sync_rich_media_grants(cx);
        let dir = self.doc.as_ref().and_then(|d| d.path.parent().map(|p| p.to_path_buf()));
        self.rich.update(cx, |r, cx| r.load(text, dir, cx));
    }

    fn sync_rich_media_grants(&self, cx: &mut Context<Self>) {
        let grants = self.file_grants.clone();
        let roots = self.registry.as_ref().and_then(|r| r.roots().ok()).unwrap_or_default();
        self.rich.update(cx, |view, cx| view.set_media_grants(grants, roots, cx));
    }

    pub(super) fn on_rich_edit(&mut self, cx: &mut Context<Self>) {
        // Split view (Source beside View) and a live room need the text on
        // every edit. Everything else defers serializing the whole document
        // until typing pauses (`note_edit`).
        if self.mode != Mode::Split && !self.live_holds_file() {
            self.note_edit(cx);
            return;
        }
        let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = &self.doc else { return };
        let text = self.rich.read(cx).markdown();
        self.dirty = &text != saved;
        self.update_stats(&text);
        self.schedule_journal(&text, cx);
        self.split_source_follow(text);
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
        // A launch that lands on the Recent page puts the keyboard on its cards.
        if self.shell.panel_open && self.shell.view == super::rail::LeftView::Recent {
            return self.shell.recent_grid.focus.clone();
        }
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
        let style = doc_style(cx);
        // `showFormatRail`: the pencil is the chosen view and the rich pane shows.
        let rail = self.shell.format_rail_on();
        self.rich.update(cx, |r, cx| {
            r.set_format_rail(rail, cx);
            if (r.zoom - z).abs() > f32::EPSILON || (r.page_width - w).abs() > f32::EPSILON {
                r.set_appearance(z, w, cx);
            }
            r.set_style(style, cx);
        });
    }

    /// Like Electron's open-local-file handler, apply the workspace's
    /// grants before handing a passive file to the OS default app.
    fn open_rich_link(&mut self, href: &str, _window: &mut Window, cx: &mut Context<Self>) {
        use markie_core::links::LinkClick;
        let dir = self.doc.as_ref().filter(|d| !d.untitled).and_then(|d| d.path.parent());
        let roots = self.registry.as_ref().and_then(|r| r.roots().ok()).unwrap_or_default();
        match self.file_grants.classify(href, dir, &roots) {
            LinkClick::Open(path) => cx.open_with_system(&path),
            // Programs and installers are shown in Finder, not run, and the
            // page says so (`openAsLocalFile`).
            LinkClick::Reveal(path) => {
                cx.reveal_path(&path);
                self.rich.update(cx, |r, cx| r.show_notice("Shown in Finder. Markie doesn't run programs or installers from a document link.", cx));
            }
            LinkClick::Refuse(why) => self.rich.update(cx, |r, cx| r.show_notice(why, cx)),
            LinkClick::Web(_) | LinkClick::Ignore => {}
        }
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

fn hex(s: &str) -> Option<Hsla> {
    let h = s.trim().trim_start_matches('#');
    (h.len() == 6).then(|| u32::from_str_radix(h, 16).ok().map(|v| rgb(v).into())).flatten()
}

/// The page's look: the typography and document colours of the preset the
/// theme store paints in this tone (`typographyVars`), custom presets and the
/// person's typography tweaks included.
pub(super) fn doc_style(cx: &App) -> DocStyle {
    let dark = cx.theme().mode.is_dark();
    let (preset, t) = crate::themes::painted(cx, dark);
    let d = DocStyle::default();
    let k = &preset.tokens;
    DocStyle {
        body_font: t.body_font,
        heading_font: t.heading_font,
        line_height: t.line_height as f32,
        paragraph_gap: t.paragraph_gap as f32,
        font_size: t.font_size as f32,
        content_width: t.content_width as f32,
        doc_rule: k.doc_rule.as_deref().and_then(hex).or_else(|| hex(&k.border)).unwrap_or(d.doc_rule),
        link: hex(&k.link).unwrap_or(d.link),
    }
}
