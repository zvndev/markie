//! Old Word (`.doc`) and HTML files open as Electron's document workspace
//! opens them (`use-document-workspace.ts`):
//!
//! - A `.doc` becomes a new, unsaved text copy named `<name> (converted).txt`
//!   with its warnings above it (`importSession`). The original is never
//!   written.
//! - An HTML file first asks "Import a text copy?"
//!   (`confirm-document-conversion.tsx`). Create text copy opens an unsaved
//!   `<stem> converted.txt` (`convertAdditionalDocument`); Cancel import
//!   leaves the open document as it was.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::*;

use markie_office::document_import::{AdditionalDocumentFormat, AdditionalDocumentInput, DocumentImportLimits, convert_additional_document};
use markie_office::legacy_doc::{DocImportOptions, extract_legacy_doc_text_off_thread};

use super::dialog_chrome::{Tokens, fade, shadow};
use super::overlay::Overlay;
use super::Workspace;

pub(super) const DOC_WARNING: &str =
    "Converted a text-only copy. The original DOC was not modified. Formatting and non-text content are not carried into this copy.";
pub(super) const DOC_SEPARATORS: &str =
    "Legacy cell and line separators were converted to text whitespace. Unsupported field/control markers were omitted.";
pub(super) const HTML_WARNING: &str = "Imported a new text-only copy. The source document was not changed.";
pub(super) const HTML_NOTICE: &str = "Imported a new text-only copy. The original file remains unchanged.";

/// `name.replace(/\.doc$/i, " (converted).txt")`.
pub(super) fn doc_copy_name(name: &str) -> String {
    if name.len() >= 4 && name[name.len() - 4..].eq_ignore_ascii_case(".doc") {
        format!("{} (converted).txt", &name[..name.len() - 4])
    } else {
        name.to_string()
    }
}

/// Legacy separators to text whitespace, control markers dropped.
pub(super) fn doc_text(raw: &str) -> String {
    raw.replace('\u{7}', "\t")
        .replace('\u{b}', "\n")
        .replace('\u{c}', "\n\n")
        .chars()
        .filter(|c| !matches!(*c as u32, 0x00..=0x08 | 0x0e..=0x1f))
        .collect()
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

impl Workspace {
    /// Called by `open_path` before it opens anything. True when the file is
    /// one of these and was taken care of here.
    pub(super) fn intercept_import(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        match ext.as_str() {
            "doc" => {
                self.open_doc_copy(path.to_path_buf(), window, cx);
                true
            }
            "html" | "htm" => {
                self.show_dialog(Overlay::ConvertDocument { path: path.to_path_buf() }, window, cx);
                true
            }
            _ => false,
        }
    }

    fn open_doc_copy(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => return window.push_notification(format!("Markie could not read this file: {e}"), cx),
        };
        let name = doc_copy_name(&file_name(&path));
        let reader = cx.background_spawn(async move { extract_legacy_doc_text_off_thread(&bytes, DocImportOptions::default()) });
        cx.spawn_in(window, async move |this, cx| {
            let result = reader.await;
            this.update_in(cx, |this, window, cx| match result {
                Ok(extracted) => {
                    let text = doc_text(&extracted.text);
                    let mut notes = vec![DOC_WARNING.to_string()];
                    if text != extracted.text {
                        notes.push(DOC_SEPARATORS.into());
                    }
                    notes.extend(extracted.warnings);
                    this.open_untitled(name, text, window, cx);
                    this.doc_notes = notes;
                    cx.notify();
                }
                Err(e) => window.push_notification(e.to_string(), cx),
            })
            .ok();
        })
        .detach();
    }

    /// Create text copy.
    pub(super) fn confirm_conversion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Overlay::ConvertDocument { path } = &self.dialogs.open else { return };
        let path = path.clone();
        self.close_dialog(window, cx);
        let name = file_name(&path);
        let result = std::fs::read(&path).map_err(|e| e.to_string()).and_then(|bytes| {
            convert_additional_document(
                &AdditionalDocumentInput { name: &name, bytes: &bytes, format: AdditionalDocumentFormat::Html },
                DocumentImportLimits::default(),
            )
            .map_err(|e| e.message.clone())
        });
        match result {
            Ok(copy) => {
                let mut notes = vec![HTML_WARNING.to_string()];
                notes.extend(copy.warnings);
                self.open_untitled(copy.name, copy.text, window, cx);
                self.doc_notes = notes;
                window.push_notification(HTML_NOTICE, cx);
            }
            Err(message) => window.push_notification(message, cx),
        }
    }

    /// `.docs-dialog` over `.docs-modal-scrim`.
    pub(super) fn render_convert_dialog(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::ConvertDocument { path } = &self.dialogs.open else { return div().into_any_element() };
        let name = file_name(path);
        let format = path.extension().map(|e| e.to_string_lossy().to_ascii_uppercase()).unwrap_or_default();
        let format = if format == "HTM" { "HTML".to_string() } else { format };
        let button = |id: &'static str, label: &'static str, t: &Tokens| {
            let hover = t.accent;
            div()
                .id(id)
                .mt(px(10.))
                .mr(px(7.))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(6.))
                .border_1()
                .border_color(t.border)
                .bg(t.surface)
                .text_size(px(13.))
                .text_color(t.foreground)
                .cursor_pointer()
                .hover(move |el| el.bg(hover))
                .child(label)
        };
        let para = |t: &Tokens| div().mt(px(13.)).text_size(px(14.)).line_height(relative(1.7)).text_color(t.muted);
        div()
            .max_w(px(460.))
            .bg(t.surface2)
            .border_1()
            .border_color(t.border)
            .rounded(px(12.))
            .p(px(25.))
            .shadow(vec![shadow(fade(super::dialog_chrome::black(), 0.31), 0., 18., 50.)])
            .text_color(t.foreground)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(div().text_size(px(18.)).font_weight(FontWeight::BOLD).mb(px(10.)).child("Import a text copy?"))
            .child(para(t).child(
                div()
                    .child(StyledText::new(format!("{name} is a {format} document. Markie can create a new, editable TXT copy of its supported text.")).with_highlights([(
                        0..name.len(),
                        HighlightStyle { font_weight: Some(FontWeight::BOLD), color: Some(t.foreground), ..Default::default() },
                    )])),
            ))
            .child(para(t).child(format!(
                "This is not native {format} editing. Formatting, pictures, comments and other document features may be omitted. Nothing in the original file will be changed."
            )))
            .child(
                div()
                    .flex()
                    .child(button("convert-cancel", "Cancel import", t).on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx))))
                    .child(button("convert-confirm", "Create text copy", t).on_click(cx.listener(|this, _, window, cx| this.confirm_conversion(window, cx)))),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{doc_copy_name, doc_text};

    #[test]
    fn doc_copies_are_named_like_electron() {
        assert_eq!(doc_copy_name("Report.doc"), "Report (converted).txt");
        assert_eq!(doc_copy_name("OLD.DOC"), "OLD (converted).txt");
        assert_eq!(doc_copy_name("a.docx"), "a.docx");
    }

    #[test]
    fn legacy_separators_become_whitespace() {
        assert_eq!(doc_text("a\u{7}b\u{b}c\u{c}d\u{1}e"), "a\tb\nc\n\nde");
    }
}
