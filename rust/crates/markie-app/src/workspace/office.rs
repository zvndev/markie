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

    pub fn status(&self, cx: &App) -> &'static str {
        let editor = &self.view.read(cx).editor;
        if !editor.can_mutate() && !editor.original_view {
            "Read only"
        } else if editor.is_dirty() {
            "Edited"
        } else {
            "Saved"
        }
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
        WordViewEvent::Changed => cx.notify(),
        WordViewEvent::ZoomReset => {
            this.zoom = 1.0;
            view.update(cx, |v, _| v.set_zoom(1.0));
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

/// Write the document in its own format. Untouched documents keep their bytes.
pub(super) fn save(office: &OfficeDoc, path: &Path, window: &mut Window, cx: &mut Context<Workspace>) {
    if !matches!(office.source, Source::Rich) {
        return;
    }
    let (dirty, can_edit) = {
        let editor = &office.view.read(cx).editor;
        (editor.is_dirty(), editor.rich().can_edit)
    };
    if !dirty || !can_edit {
        return;
    }
    let bytes = office.view.read(cx).editor.export();
    match bytes.map_err(anyhow::Error::msg).and_then(|bytes| markie_core::save::atomic_write(path, &bytes).map_err(Into::into)) {
        Ok(()) => office.view.update(cx, |view, cx| {
            view.editor.mark_saved();
            cx.notify();
        }),
        Err(error) => window.push_notification(format!("Markie could not save: {error:#}"), cx),
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

impl Workspace {
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
