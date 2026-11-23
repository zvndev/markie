//! Office documents in the workspace: DOCX, RTF and ODT in the native Word
//! page view, and DOC as extracted text with a TXT copy, like Electron.
//!
//! Save writes the engine's export, which is the original file's bytes when
//! nothing changed. Read-only documents are never written.

use std::path::{Path, PathBuf};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::*;

use markie_core::formats::FormatKind;
use markie_office::legacy_doc::{DocImportOptions, extract_legacy_doc_text_off_thread};
use markie_office::model::Format;
use markie_office::rich_document::{create_rich_document, open_rich_document};
use markie_office_view::editor::WordEditor;
use markie_office_view::{WordView, WordViewEvent};

use super::{DocKind, Mode, OpenDoc, Workspace};

pub(super) enum Source {
    /// DOCX, RTF or ODT, saved in its own format.
    Rich,
    /// A Word 97 file: read-only extracted text, offered as a TXT copy.
    LegacyDoc { text: Option<String>, warnings: Vec<String> },
}

pub(super) struct OfficeDoc {
    pub view: Entity<WordView>,
    pub source: Source,
    _subscription: Subscription,
}

impl OfficeDoc {
    pub fn is_dirty(&self, cx: &App) -> bool {
        matches!(self.source, Source::Rich) && self.view.read(cx).editor.is_dirty()
    }

    /// Focus the page on the next frame, after the window's own startup focus.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        let handle = self.view.read(cx).focus_handle(cx);
        window.on_next_frame(move |window, cx| handle.focus(window, cx));
    }
}

pub(super) fn engine_format(format: FormatKind) -> Option<Format> {
    match format {
        FormatKind::Docx => Some(Format::Docx),
        FormatKind::Rtf => Some(Format::Rtf),
        FormatKind::Odt => Some(Format::Odt),
        _ => None,
    }
}

fn first_save_path(mut path: PathBuf, key: &Path, format: FormatKind) -> Option<PathBuf> {
    if path.extension().is_none() && let Some(ext) = key.extension() {
        path.set_extension(ext);
    }
    (markie_core::formats::classify(&path.to_string_lossy()) == format).then_some(path)
}

impl Workspace {
    /// A View menu Word item that no focused page took (the toolbar or the
    /// title bar had the click): it goes to the open Word document, as
    /// Electron's View menu reaches the document with or without focus.
    pub fn route_word_view_command(&mut self, id: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(DocKind::Office(office)) = self.doc.as_ref().map(|d| &d.kind) {
            let view = office.view.clone();
            view.update(cx, |view, cx| view.view_command(id, window, cx));
        }
    }

    pub(super) fn on_document_details(&mut self, _: &crate::actions::DocumentDetails, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = &self.doc else { return };
        let Some(name) = doc.path.file_name() else { return };
        let mut detail = format!("{}\n{}", name.to_string_lossy(), doc.format.label());
        if let DocKind::Office(office) = &doc.kind {
            let editor = &office.view.read(cx).editor;
            if !markie_export::office_pdf::can_print(editor.rich()) {
                detail.push_str("\n\nPrint and PDF are unavailable for this document's unsupported features or pending revisions. You can still export the source document.");
            }
            for warning in &editor.rich().diagnostics {
                detail.push_str("\n");
                detail.push_str(&warning.message);
            }
        }
        let _ = window.prompt(PromptLevel::Info, "Document Details", Some(&detail), &["OK"], cx);
    }

    pub(super) fn open_untitled_office(&mut self, name: String, format: FormatKind, bytes: &[u8], window: &mut Window, cx: &mut Context<Self>) {
        let key = markie_core::paths::data_dir().join("unsaved-office")
            .join(format!("{}-{}", markie_core::clock::now_ms(), self.import_epoch.saturating_add(1)))
            .join(name);
        self.resume_untitled_office(key, format, bytes, window, cx);
    }

    fn resume_untitled_office(&mut self, key: PathBuf, format: FormatKind, bytes: &[u8], window: &mut Window, cx: &mut Context<Self>) {
        let Some(engine) = engine_format(format) else { return };
        let document = match open_rich_document(engine, bytes) {
            Ok(document) => document,
            Err(error) => return window.push_notification(error.message, cx),
        };
        self.invalidate_import();
        self.settle(window, cx);
        self.document_failure = None;
        let (view, subscription) = view_for(WordEditor::new(document), window, cx);
        let office = OfficeDoc { view, source: Source::Rich, _subscription: subscription };
        office.focus(window, cx);
        // The recovery key is not a document file.
        let name = key.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.doc = Some(OpenDoc { path: key, format, large: false, kind: DocKind::Office(office), untitled: true });
        self.mode = Mode::View;
        self.dirty = false;
        self.doc_notes.clear();
        self.words = 0;
        self.sections.clear();
        self.disk_missing = false;
        self.disk_conflict = None;
        self.autosave.cancel();
        self.viewing_version = None;
        self.collab_on_open(cx);
        window.set_window_title(&name);
        cx.notify();
    }

    pub(super) fn render_untitled_office_offer(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (path, revision) = self.pending_office.as_ref()?;
        let (path, revision) = (path.clone(), *revision);
        Some(h_flex().gap_3().p_2()
            .child("Markie recovered unsaved changes to an Office document.")
            .child(Button::new("reopen-office-draft").small().label("Restore")
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.pending_office = None;
                    if let Some(bytes) = this.recovery.read(&path, revision) {
                        let format = markie_core::formats::classify(&path.to_string_lossy());
                        this.resume_untitled_office(path.clone(), format, &bytes, window, cx);
                    }
                    cx.notify();
                })))
            .into_any_element())
    }

    pub(super) fn save_untitled_office(&mut self, key: PathBuf, format: FormatKind, view: Entity<WordView>, window: &mut Window, cx: &mut Context<Self>) {
        let name = key.file_name().map(|n| n.to_string_lossy());
        let rx = cx.prompt_for_new_path(&self.default_dir(), name.as_deref());
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(path))) = rx.await else { return };
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(path) = first_save_path(path, &key, format) else {
                    window.push_notification("Choose the original file type when saving this document.", cx);
                    return;
                };
                let bytes = match view.read(cx).editor.export() {
                    Ok(bytes) => bytes,
                    Err(error) => return window.push_notification(error.to_string(), cx),
                };
                if let Err(error) = markie_core::save::atomic_write(&path, &bytes) {
                    window.push_notification(format!("Markie could not save: {error}"), cx);
                    return;
                }
                view.update(cx, |view, _| view.editor.mark_saved());
                this.keep_office_bytes(&key, format, &bytes, true);
                this.keep_office_bytes(&path, format, &bytes, true);
                if this.doc.as_ref().is_some_and(|d| d.untitled && d.path == key) {
                    this.open_path(&path, window, cx);
                }
                this.rescan(cx);
            });
        }).detach();
    }
}

#[cfg(test)]
mod first_save_tests {
    use super::*;
    use ::core::prelude::v1::test;

    #[test]
    fn unsaved_office_session_only_saves_to_its_original_format() {
        for (key, format) in [("Untitled.docx", FormatKind::Docx), ("Untitled.rtf", FormatKind::Rtf), ("Untitled.odt", FormatKind::Odt)] {
            let key = Path::new(key);
            let wanted = PathBuf::from("Chosen").with_extension(key.extension().unwrap());
            assert_eq!(first_save_path("Chosen".into(), key, format), Some(wanted));
            assert!(first_save_path("Wrong.txt".into(), key, format).is_none());
        }
    }
}

/// Legacy separators to text whitespace, control markers dropped (Electron's
/// `importSession` for DOC).
fn doc_text(raw: &str) -> String {
    raw.replace('\u{7}', "\t")
        .replace('\u{b}', "\n")
        .replace('\u{c}', "\n\n")
        .chars()
        .filter(|c| !matches!(*c as u32, 0x00..=0x08 | 0x0e..=0x1f))
        .collect()
}

fn view_for(editor: WordEditor, window: &mut Window, cx: &mut Context<Workspace>) -> (Entity<WordView>, Subscription) {
    let view = cx.new(|cx| WordView::new(editor, window, cx));
    let subscription = cx.subscribe_in(&view, window, |this: &mut Workspace, view, event: &WordViewEvent, window, cx| match event {
        WordViewEvent::RenderFailed(detail) => this.show_document_failure(detail, cx),
        WordViewEvent::Changed => {
            this.on_office_changed(cx);
            cx.notify();
        }
        WordViewEvent::ZoomReset => {
            this.zoom = 1.0;
            view.update(cx, |v, _| v.set_zoom(1.0));
            cx.notify();
        }
        WordViewEvent::History => this.on_show_history(&crate::actions::ShowHistory, window, cx),
        WordViewEvent::Zoom(zoom) => {
            // Electron's presets (0.75, 1.25) are finer than the shared
            // setting's tenths; the Word view keeps the exact preset.
            this.set_zoom(*zoom, cx);
            this.zoom = *zoom;
            cx.notify();
        }
    });
    (view, subscription)
}

/// Open an Office file. An error leaves the caller's placeholder in place.
pub(super) fn open(path: &Path, format: FormatKind, window: &mut Window, cx: &mut Context<Workspace>) -> Result<OfficeDoc, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Markie could not read this file: {e}"))?;
    if let Some(engine) = engine_format(format) {
        let document = open_rich_document(engine, &bytes).map_err(|e| format!("This document could not be opened. {}", e.message))?;
        let (view, subscription) = view_for(WordEditor::new(document), window, cx);
        return Ok(OfficeDoc { view, source: Source::Rich, _subscription: subscription });
    }
    if format != FormatKind::Doc {
        return Err("This format is not handled by the Office engine.".into());
    }
    let placeholder = create_rich_document(Format::Docx, "Reading the Word 97 document…").map_err(|e| e.message)?;
    let mut editor = WordEditor::new(placeholder);
    editor.host_read_only = true;
    let (view, subscription) = view_for(editor, window, cx);
    let reader = cx.background_spawn(async move { extract_legacy_doc_text_off_thread(&bytes, DocImportOptions::default()) });
    let target = view.clone();
    let opened = path.to_path_buf();
    cx.spawn(async move |this, cx| {
        let result = reader.await;
        this.update(cx, |this, cx| {
            let Some(OpenDoc { path, kind: DocKind::Office(office), .. }) = this.doc.as_mut() else { return };
            if *path != opened {
                return;
            }
            let (shown, text, warnings) = match result {
                Ok(extracted) => {
                    let text = doc_text(&extracted.text);
                    let mut warnings = vec!["Converted a text-only copy. The original DOC was not modified. Formatting and non-text content are not carried into this copy.".to_string()];
                    if text != extracted.text {
                        warnings.push("Legacy cell and line separators were converted to text whitespace. Unsupported field and control markers were omitted.".into());
                    }
                    warnings.extend(extracted.warnings);
                    // The page shows tabs as spaces; the TXT copy keeps them.
                    (text.replace('\t', "    "), Some(text), warnings)
                }
                Err(error) => (String::new(), None, vec![format!("This Word 97 document could not be read. {error}")]),
            };
            office.source = Source::LegacyDoc { text, warnings };
            if let Ok(document) = create_rich_document(Format::Docx, &shown) {
                target.update(cx, |view, cx| {
                    let mut editor = WordEditor::new(document);
                    editor.host_read_only = true;
                    view.editor = editor;
                    cx.notify();
                });
            }
            cx.notify();
        })
        .ok();
    })
    .detach();
    Ok(OfficeDoc { view, source: Source::LegacyDoc { text: None, warnings: vec!["Reading text from this Word 97 document…".into()] }, _subscription: subscription })
}

/// Write the document in its own format through the engine. Untouched
/// documents keep their bytes. `Ok(None)` when there was nothing to write.
fn write(office: &OfficeDoc, path: &Path, cx: &mut Context<Workspace>) -> anyhow::Result<Option<Vec<u8>>> {
    if !matches!(office.source, Source::Rich) {
        return Ok(None);
    }
    let (dirty, can_edit) = {
        let editor = &office.view.read(cx).editor;
        (editor.is_dirty(), editor.rich().can_edit)
    };
    if !dirty || !can_edit {
        return Ok(None);
    }
    let bytes = office.view.read(cx).editor.export().map_err(anyhow::Error::msg)?;
    markie_core::save::atomic_write(path, &bytes)?;
    office.view.update(cx, |view, cx| {
        view.editor.mark_saved();
        cx.notify();
    });
    Ok(Some(bytes))
}

/// Save As for a Word, RTF or ODT document: an edited one is exported by the
/// engine to `target`; an untouched one keeps its bytes. The source file is
/// not written.
pub(super) fn write_to(office: &OfficeDoc, source: &Path, target: &Path, cx: &mut Context<Workspace>) -> anyhow::Result<()> {
    let edited = matches!(office.source, Source::Rich) && {
        let editor = &office.view.read(cx).editor;
        editor.is_dirty() && editor.rich().can_edit
    };
    if edited {
        let bytes = office.view.read(cx).editor.export().map_err(anyhow::Error::msg)?;
        markie_core::save::atomic_write(target, &bytes)?;
    } else {
        let bytes = std::fs::read(source)?;
        markie_core::save::atomic_write(target, &bytes)?;
    }
    Ok(())
}

/// ⌘S. A failure says so; autosave uses `Workspace::office_autosave`, which
/// never does.
pub(super) fn save(office: &OfficeDoc, path: &Path, window: &mut Window, cx: &mut Context<Workspace>) -> Option<Vec<u8>> {
    match write(office, path, cx) {
        Ok(bytes) => bytes,
        Err(error) => {
            window.push_notification(format!("Markie could not save: {error:#}"), cx);
            None
        }
    }
}

fn format_id(format: FormatKind) -> &'static str {
    match format {
        FormatKind::Docx => "docx",
        FormatKind::Rtf => "rtf",
        FormatKind::Odt => "odt",
        FormatKind::Doc => "doc",
        _ => "other",
    }
}

impl Workspace {
    /// An edit in the Word view keeps a recovery revision 600 ms later, like
    /// Electron's document library. The file itself is written only by ⌘S or
    /// Save: an office file is never written on a timer.
    fn on_office_changed(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDoc { kind: DocKind::Office(office), .. }) = &self.doc else { return };
        if !office.is_dirty(cx) {
            return;
        }
        self._recovery_task = cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(markie_core::office_recovery::RECOVERY_DEBOUNCE_MS))
                .await;
            this.update(cx, |this, cx| this.keep_office_revision(false, cx)).ok();
        });
    }

    /// Serialize the open office document into a recovery revision. `on_disk`
    /// marks it as the bytes the file holds (an open or a save).
    pub(super) fn keep_office_revision(&mut self, on_disk: bool, cx: &mut Context<Self>) {
        let Some(OpenDoc { path, format, kind: DocKind::Office(office), .. }) = &self.doc else { return };
        if !matches!(office.source, Source::Rich) {
            return;
        }
        if self.is_untitled() && !office.is_dirty(cx) {
            return;
        }
        let Ok(bytes) = office.view.read(cx).editor.export() else { return };
        self.keep_office_bytes(&path.clone(), *format, &bytes, on_disk);
        if self.side == super::SidePanel::History {
            self.refresh_versions();
        }
    }

    pub(super) fn keep_office_bytes(&self, path: &Path, format: FormatKind, bytes: &[u8], on_disk: bool) {
        if let Ok(rev) = self.recovery.put(path, format_id(format), bytes)
            && on_disk
        {
            let _ = self.recovery.mark_exported(path, rev.revision);
        }
    }

    /// Electron's `prepareClose` for office documents: make the newest edits
    /// a durable recovery revision before the window goes. The file on disk
    /// is not written; reopening offers the revision from Recovery history.
    pub(super) fn office_flush_recovery(&mut self, cx: &mut Context<Self>) {
        self._recovery_task = Task::ready(());
        self.keep_office_revision(false, cx);
    }

    /// On open: a newer, unsaved revision from an earlier session is still in
    /// Recovery history. Say so instead of hiding it.
    pub(super) fn office_unsaved_notice(&self, path: &Path) -> Option<String> {
        let idx = self.recovery.index(path)?;
        let newest = idx.revisions.last()?;
        let on_disk = std::fs::read(path).map(|b| markie_core::clock::sha256_hex(&b)).ok();
        (idx.exported_revision != Some(newest.revision) && on_disk.as_deref() != Some(newest.sha256.as_str()))
            .then(|| "This document has unsaved changes from an earlier session. Open Recovery history to restore them.".to_string())
    }

    /// The office document's recovery revisions as history-panel rows.
    pub(super) fn office_versions(&self, path: &Path) -> Vec<markie_core::history::Version> {
        self.recovery
            .list(path)
            .into_iter()
            .map(|r| markie_core::history::Version {
                stamp: r.revision.to_string(),
                ms: Some(r.saved_at),
                bytes: r.size,
                meta: markie_core::history::VersionMeta { author: "user".into(), ..Default::default() },
            })
            .collect()
    }

    /// The words of an office revision, for the read-only preview.
    pub(super) fn office_version_text(&self, path: &Path, format: FormatKind, stamp: &str) -> Option<String> {
        let bytes = self.recovery.read(path, stamp.parse().ok()?)?;
        Some(markie_core::doc_text::text_from_bytes(&bytes, format).unwrap_or_default())
    }

    /// Restore a recovery revision, as Electron does: it becomes the newest
    /// revision and the open, unsaved document. The file is unchanged until
    /// the user saves.
    pub(super) fn restore_office_version(&mut self, stamp: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(OpenDoc { path, format, kind: DocKind::Office(_), .. }) = &self.doc else { return };
        let (path, format) = (path.clone(), *format);
        let Some(revision) = stamp.parse().ok() else { return };
        let bytes = match self.recovery.restore(&path, revision) {
            Ok((bytes, _)) => bytes,
            Err(e) => return window.push_notification(e.to_string(), cx),
        };
        let Some(engine) = engine_format(format) else { return };
        let document = match open_rich_document(engine, &bytes) {
            Ok(d) => d,
            Err(e) => return window.push_notification(format!("This revision could not be opened. {}", e.message), cx),
        };
        if let Some(OpenDoc { kind: DocKind::Office(office), .. }) = &self.doc {
            office.view.update(cx, |view, cx| {
                view.editor = WordEditor::new_unsaved(document);
                cx.notify();
            });
        }
        window.push_notification("Restored a recovery revision. The file was not changed. Save to keep it.", cx);
        self.refresh_versions();
        cx.notify();
    }
}

/// `report (converted).txt` next to the original, never over another file.
fn copy_path(original: &Path) -> PathBuf {
    let dir = original.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = original.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Document".into());
    let first = dir.join(format!("{stem} (converted).txt"));
    if !first.exists() {
        return first;
    }
    (2..).map(|n| dir.join(format!("{stem} (converted {n}).txt"))).find(|p| !p.exists()).expect("an unused name exists")
}

/// `<stem> converted.txt` next to the source, never over another file.
fn unused(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = name.strip_suffix(".txt").unwrap_or(name);
    (2..).map(|n| dir.join(format!("{stem} {n}.txt"))).find(|p| !p.exists()).expect("an unused name exists")
}

/// Electron's "Import a text copy?" for HTML, as a banner over the preview.
pub(super) fn html_banner(name: &str, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = cx.theme().clone();
    h_flex()
        .px_4()
        .py_2()
        .gap_3()
        .border_b_1()
        .border_color(theme.border)
        .bg(theme.info.opacity(0.12))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap_0p5()
                .text_xs()
                .child(format!("{name} is a HTML document. Markie can create a new, editable TXT copy of its supported text."))
                .child("This is not native HTML editing. Formatting, pictures, comments and other document features may be omitted. Nothing in the original file will be changed."),
        )
        .child(
            Button::new("html-txt-copy")
                .small()
                .primary()
                .flex_none()
                .label("Create text copy")
                .on_click(cx.listener(|this, _, window, cx| this.save_html_copy(window, cx))),
        )
        .into_any_element()
}

impl Workspace {
    /// Convert the open HTML file with the office engine's importer and open
    /// the TXT copy. The original is never written.
    fn save_html_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use markie_office::document_import::{AdditionalDocumentFormat, AdditionalDocumentInput, DocumentImportLimits, convert_additional_document};
        let Some(OpenDoc { path, kind: DocKind::Html, .. }) = &self.doc else { return };
        let path = path.clone();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let result = std::fs::read(&path).map_err(|e| e.to_string()).and_then(|bytes| {
            convert_additional_document(
                &AdditionalDocumentInput { name: &name, bytes: &bytes, format: AdditionalDocumentFormat::Html },
                DocumentImportLimits::default(),
            )
            .map_err(|e| e.message.clone())
        });
        match result {
            Ok(copy) => {
                let target = unused(path.parent().unwrap_or(Path::new(".")), &copy.name);
                match markie_core::save::atomic_write(&target, &copy.bytes) {
                    Ok(()) => self.open_path(&target, window, cx),
                    Err(e) => window.push_notification(format!("Markie could not write the TXT copy: {e}"), cx),
                }
            }
            Err(message) => window.push_notification(message, cx),
        }
    }

    fn save_doc_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(OpenDoc { path, kind: DocKind::Office(office), .. }) = &self.doc else { return };
        let Source::LegacyDoc { text: Some(text), .. } = &office.source else { return };
        let target = copy_path(path);
        match markie_core::save::atomic_write(&target, text.as_bytes()) {
            Ok(()) => self.open_path(&target, window, cx),
            Err(error) => window.push_notification(format!("Markie could not write the TXT copy: {error}"), cx),
        }
    }
}

/// Electron's `.docs-status` wording (`document-workspace.tsx`): whether
/// the file holds the latest words, and the hover detail.
pub(super) fn file_status(untitled: bool, dirty: bool) -> (&'static str, &'static str) {
    if untitled {
        ("Not saved to a file yet", "Kept safe on this Mac as you type. Save file to choose where it goes.")
    } else if dirty {
        ("Edited", "Your changes are kept safe on this Mac. Save file to write them to the file.")
    } else {
        ("Saved", "Saved")
    }
}

/// The right side of the strip: `49 words · DOCX`, and a note past the
/// first million characters (UTF-16 units, as JavaScript counts them).
pub(super) fn word_summary(text: &str, format: FormatKind) -> String {
    let words = text.split_whitespace().count();
    let format = match format {
        FormatKind::Docx => "DOCX",
        FormatKind::Rtf => "RTF",
        FormatKind::Odt => "ODT",
        _ => "DOC",
    };
    let long = text.encode_utf16().count() > 1024 * 1024;
    format!("{words} words · {format}{}", if long { " · First 1M characters searchable" } else { "" })
}

/// `color-mix(in srgb, a, b share)`.
fn mix(a: Hsla, b: Hsla, share: f32) -> Hsla {
    let (a, b) = (a.to_rgb(), b.to_rgb());
    let at = |x: f32, y: f32| x * (1. - share) + y * share;
    Rgba { r: at(a.r, b.r), g: at(a.g, b.g), b: at(a.b, b.b), a: at(a.a, b.a) }.into()
}

/// Electron's `.docs-status` footer under the page: 38 px with a top rule
/// of the border mixed 10% toward the text colour, 18 px side padding and
/// gap, 12 px muted text. It follows every edit and save.
fn status_strip(office: &OfficeDoc, untitled: bool, format: FormatKind, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = cx.theme().clone();
    let view = office.view.read(cx);
    let (label, detail) = file_status(untitled, view.editor.is_dirty());
    let summary = word_summary(&view.editor.rich().text, format);
    h_flex()
        .id("office-status")
        .flex_none()
        .h(px(38.))
        .border_t_1()
        .border_color(mix(theme.border, theme.foreground, 0.1))
        .bg(theme.background)
        .px(px(18.))
        .gap(px(18.))
        .text_size(px(12.))
        .text_color(theme.muted_foreground)
        .child(
            div()
                .id("office-status-file")
                .flex_1()
                .min_w_0()
                .truncate()
                .child(label)
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(detail).build(window, cx)),
        )
        .child(div().flex_none().child(summary))
        .into_any_element()
}

pub(super) fn render(office: &OfficeDoc, untitled: bool, format: FormatKind, zoom: f32, cx: &mut Context<Workspace>) -> AnyElement {
    let history = matches!(office.source, Source::Rich);
    office.view.update(cx, |view, _| {
        view.set_zoom(zoom);
        view.history = history;
    });
    let theme = cx.theme().clone();
    let banner = match &office.source {
        Source::Rich => None,
        Source::LegacyDoc { text, warnings } => Some(
            h_flex()
                .px_4()
                .py_2()
                .gap_3()
                .border_b_1()
                .border_color(theme.border)
                .bg(theme.info.opacity(0.12))
                .child(v_flex().flex_1().min_w_0().gap_0p5().text_xs().children(warnings.iter().map(|w| div().child(w.clone()))))
                .when(text.is_some(), |d| {
                    d.child(Button::new("doc-txt-copy").small().primary().flex_none().label("Save a TXT copy").on_click(cx.listener(|this, _, window, cx| this.save_doc_copy(window, cx))))
                }),
        ),
    };
    let status = matches!(office.source, Source::Rich).then(|| status_strip(office, untitled, format, cx));
    v_flex().size_full().children(banner).child(div().flex_1().min_h_0().child(office.view.clone())).children(status).into_any_element()
}

#[cfg(test)]
mod status_tests {
    use super::*;
    use ::core::prelude::v1::test;

    #[test]
    fn the_strip_says_whether_the_file_has_the_latest_words() {
        assert_eq!(file_status(false, false).0, "Saved");
        assert_eq!(file_status(false, true).0, "Edited");
        assert_eq!(file_status(true, false).0, "Not saved to a file yet");
        assert_eq!(file_status(true, true).0, "Not saved to a file yet");
        assert!(file_status(false, true).1.starts_with("Your changes are kept safe"));
    }

    #[test]
    fn words_count_like_electrons_whitespace_split() {
        assert_eq!(word_summary("  Two\nwords  ", FormatKind::Docx), "2 words · DOCX");
        assert_eq!(word_summary("", FormatKind::Rtf), "0 words · RTF");
        assert_eq!(word_summary("a\tb c", FormatKind::Odt), "3 words · ODT");
        let long = "x".repeat(1024 * 1024 + 1);
        assert_eq!(word_summary(&long, FormatKind::Docx), "1 words · DOCX · First 1M characters searchable");
    }
}

use gpui_kit::prelude::FluentBuilder as _;
