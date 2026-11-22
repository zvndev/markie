//! View mode's rich editor (`markie-editor`) inside the workspace: loading
//! the open document into it, autosaving its edits through `write_text`,
//! and keeping Source mode's text in step.

use gpui_kit::*;

use markie_core::formats::FormatKind;
use markie_editor::{RichEvent, RichView};

use super::{DocKind, Mode, OpenDoc, Workspace};

impl Workspace {
    pub(super) fn new_rich(window: &mut Window, cx: &mut Context<Self>) -> (Entity<RichView>, Subscription) {
        let rich = cx.new(RichView::new);
        let sub = cx.subscribe_in(&rich, window, |this, _, ev: &RichEvent, window, cx| match ev {
            RichEvent::Changed => this.on_rich_edit(cx),
            RichEvent::OpenPaths(paths) => {
                if let Some(p) = paths.first() {
                    this.open_path(p, window, cx);
                }
            }
            RichEvent::OpenLocal(href) => this.open_rich_link(href, window, cx),
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

    fn on_rich_edit(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = &self.doc else { return };
        let text = self.rich.read(cx).markdown();
        self.dirty = &text != saved;
        self.update_stats(&text);
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

    /// Zoom and page width follow the workspace's settings.
    pub(super) fn sync_rich_appearance(&self, cx: &mut Context<Self>) {
        let (z, w) = (self.zoom, self.page_width);
        self.rich.update(cx, |r, cx| {
            if (r.zoom - z).abs() > f32::EPSILON || (r.page_width - w).abs() > f32::EPSILON {
                r.set_appearance(z, w, cx);
            }
        });
    }

    /// A click on a link to a file (local-link.ts `openLocalFile`): a
    /// document opens here, anything else in its own app.
    fn open_rich_link(&mut self, href: &str, window: &mut Window, cx: &mut Context<Self>) {
        let href = href.split('#').next().unwrap_or("");
        if href.is_empty() {
            return;
        }
        let decoded = href.replace("%20", " ");
        let raw = decoded.strip_prefix("file://").unwrap_or(&decoded);
        let path = std::path::Path::new(raw);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            let Some(dir) = self.doc.as_ref().and_then(|d| d.path.parent().map(|p| p.to_path_buf())) else { return };
            dir.join(path)
        };
        if !path.exists() {
            return;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if markie_editor::attach::opens_as_document(&name) {
            self.open_path(&path, window, cx);
        } else if path.is_dir() || is_program(&path) {
            // Programs and installers are shown in Finder, never run.
            cx.reveal_path(&path);
        } else {
            cx.open_with_system(&path);
        }
    }
}

fn is_program(p: &std::path::Path) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    matches!(ext.as_str(), "app" | "command" | "sh" | "pkg" | "dmg" | "exe" | "msi" | "bat" | "cmd" | "jar" | "scpt" | "workflow" | "terminal")
}
