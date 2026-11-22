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

use super::{DocKind, OpenDoc, Workspace};

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

fn engine_format(format: FormatKind) -> Option<Format> {
    match format {
        FormatKind::Docx => Some(Format::Docx),
        FormatKind::Rtf => Some(Format::Rtf),
        FormatKind::Odt => Some(Format::Odt),
        _ => None,
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
    let subscription = cx.subscribe(&view, |this: &mut Workspace, view, event: &WordViewEvent, cx| match event {
        WordViewEvent::Changed => {
            this.on_office_changed(cx);
            cx.notify();
        }
        WordViewEvent::ZoomReset => {
            this.zoom = 1.0;
            view.update(cx, |v, _| v.set_zoom(1.0));
            cx.notify();
        }
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

pub(super) fn render(office: &OfficeDoc, zoom: f32, cx: &mut Context<Workspace>) -> AnyElement {
    office.view.update(cx, |view, _| view.set_zoom(zoom));
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
    v_flex().size_full().children(banner).child(div().flex_1().min_h_0().child(office.view.clone())).into_any_element()
}

use gpui_kit::prelude::FluentBuilder as _;
