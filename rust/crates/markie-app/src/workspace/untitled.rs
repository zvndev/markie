//! Unsaved, untitled documents, as Electron's `handleNewFile` makes them:
//! a buffer with no file behind it. Autosave keeps it in the draft journal
//! (Electron's `draftSave({ path: null })`), ⌘S asks where to put it (Save
//! As), and leaving it for another document journals it without a dialog,
//! as `useSaveGuard().settle()` does. "Make Interactive" opens the open
//! Markdown's text as one of these, as an unsaved `.wd`.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::*;

use markie_core::document;
use markie_core::drafts::Drafts;
use markie_core::formats::{FormatKind, TextEncoding, kind_for_extension};

use super::{DocKind, Mode, OpenDoc, Workspace};

/// `"Trip notes.md"` becomes `"Trip notes.wd"`; an untitled document
/// becomes `"Untitled.wd"` (page.tsx `interactiveCopyName`).
pub(super) fn interactive_copy_name(name: Option<&str>) -> String {
    let name = name.unwrap_or("");
    let lower = name.to_ascii_lowercase();
    let stem = [".markdown", ".mdx", ".md"]
        .iter()
        .find(|ext| lower.ends_with(*ext))
        .map_or(name, |ext| &name[..name.len() - ext.len()])
        .trim();
    format!("{}.wd", if stem.is_empty() { "Untitled" } else { stem })
}

/// The name an untitled buffer of this extension shows and suggests in Save As.
pub(super) fn untitled_name(ext: &str) -> String {
    format!("Untitled.{ext}")
}

/// Can Make Interactive turn this document into a `.wd`? Markdown only:
/// Electron leaves plain text and CSV out.
pub(super) fn can_make_interactive(format: FormatKind, large: bool) -> bool {
    format == FormatKind::Markdown && !large
}

impl Workspace {
    pub(super) fn is_untitled(&self) -> bool {
        self.doc.as_ref().is_some_and(|d| d.untitled)
    }

    /// Before another document replaces this one. A file saves as before; an
    /// untitled buffer goes to the journal, the only copy there will be.
    pub(super) fn settle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // An edit still inside its settle delay: make `dirty` exact first.
        self.settle_edit_now(cx);
        if self.is_untitled() {
            if self.dirty {
                let text = self.current_text(cx);
                let _ = self.drafts.save(None, &text);
            }
            return;
        }
        if self.dirty || matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(o)) if o.is_dirty(cx)) {
            self.save(window, cx);
        }
    }

    /// Open `text` as an unsaved document called `name`.
    pub(super) fn open_untitled(&mut self, name: String, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.open_untitled_with_baseline(name, text, false, window, cx);
    }

    pub(super) fn open_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_untitled_with_baseline(untitled_name("md"), super::first_run::WELCOME_DOC.into(), true, window, cx);
    }

    fn open_untitled_with_baseline(&mut self, name: String, text: String, clean: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.invalidate_import();
        self.settle(window, cx);
        self.doc_notes.clear();
        let ext = Path::new(&name).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        let format = kind_for_extension(&ext);
        let literal = !matches!(format, FormatKind::Markdown | FormatKind::Darkmown | FormatKind::Csv);
        self.editor.update(cx, |state, cx| {
            state.set_highlighter(if literal { "text" } else if format == FormatKind::Csv { "markdown" } else { format.editor_language() }, cx);
            state.set_line_number(!literal, window, cx);
            state.set_value(text.clone(), window, cx);
        });
        if let Some(old) = &self.doc {
            if !old.untitled {
                self.disk.forget(&old.path);
            }
        }
        self.doc = Some(OpenDoc {
            path: PathBuf::from(&name),
            format,
            large: false,
            kind: DocKind::Text { encoding: TextEncoding::Utf8, bom: false, saved: if clean { text.clone() } else { String::new() } },
            untitled: true,
        });
        if literal {
            self.mode = Mode::Source;
        } else if !super::mode_allowed(format, false, self.mode) {
            self.mode = Mode::View;
        }
        self.split_source_latest = false;
        self.split_echo = None;
        self.set_preview(&text, format, cx);
        self.update_stats(&text);
        self.dirty = !clean && !text.is_empty();
        self.autosave.cancel();
        self.disk_conflict = None;
        self.disk_missing = false;
        self.viewing_version = None;
        if self.dirty {
            let _ = self.drafts.save(None, &text);
        }
        if self.mode == Mode::Source {
            self.focus_editor(window, cx);
        } else if self.rich_active() {
            self.load_rich(&text, cx);
            self.focus_rich(window, cx);
        }
        window.set_window_title(&name);
        self.collab_on_open(cx);
        cx.notify();
    }

    /// ⌘S on an untitled buffer: Save As, then the written file is the open
    /// document, and the journal entry is spent.
    pub(super) fn save_untitled(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        let name = doc.path.to_string_lossy().into_owned();
        let text = self.current_text(cx);
        let dir = self.default_dir();
        let rx = cx.prompt_for_new_path(&dir, Some(&name));
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(target))) = rx.await else { return };
            // Saved as .csv, the first table is written as CSV (handleSaveAs).
            let as_csv = kind_for_extension(&target.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()) == FormatKind::Csv;
            let bytes = if as_csv { super::csv_doc::markdown_table_to_csv(&text) } else { text.clone() };
            let written = document::save_text(&target, &bytes, TextEncoding::Utf8, false);
            this.update_in(cx, |this, window, cx| match written {
                Ok(()) => {
                    let _ = this.drafts.discard(&Drafts::key_for(None));
                    // The buffer is on disk now: nothing left to settle.
                    this.dirty = false;
                    this.open_path(&target, window, cx);
                    this.rescan(cx);
                }
                Err(e) => window.push_notification(format!("Markie could not save: {e:#}"), cx),
            })
            .ok();
        })
        .detach();
    }

    /// File > Make Interactive: the Markdown on screen as an unsaved `.wd`.
    /// The Markdown file is never written.
    pub(super) fn make_interactive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        if !can_make_interactive(doc.format, doc.large) || !matches!(doc.kind, DocKind::Text { .. }) {
            return;
        }
        let name = doc.path.file_name().map(|n| n.to_string_lossy().into_owned());
        let text = self.current_text(cx);
        let copy = interactive_copy_name(name.as_deref());
        self.open_untitled(copy, text, window, cx);
    }

    /// The untitled journal entry, when this launch opened nothing else.
    pub(super) fn untitled_draft_pending(&self) -> bool {
        self.recovered.iter().any(|d| d.meta.path.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::{can_make_interactive, interactive_copy_name, untitled_name};
    use markie_core::formats::FormatKind;

    #[test]
    fn interactive_copy_takes_the_markdown_name() {
        assert_eq!(interactive_copy_name(Some("Trip notes.md")), "Trip notes.wd");
        assert_eq!(interactive_copy_name(Some("a.markdown")), "a.wd");
        assert_eq!(interactive_copy_name(Some("b.MDX")), "b.wd");
        assert_eq!(interactive_copy_name(Some("Untitled.md")), "Untitled.wd");
        assert_eq!(interactive_copy_name(Some(".md")), "Untitled.wd");
        assert_eq!(interactive_copy_name(None), "Untitled.wd");
        assert_eq!(interactive_copy_name(Some("plain")), "plain.wd");
    }

    #[test]
    fn only_markdown_becomes_interactive() {
        assert!(can_make_interactive(FormatKind::Markdown, false));
        assert!(!can_make_interactive(FormatKind::Markdown, true));
        for f in [FormatKind::Text, FormatKind::Csv, FormatKind::Darkmown, FormatKind::Docx] {
            assert!(!can_make_interactive(f, false), "{f:?}");
        }
    }

    #[test]
    fn untitled_names() {
        assert_eq!(untitled_name("md"), "Untitled.md");
        assert_eq!(untitled_name("wd"), "Untitled.wd");
    }
}
