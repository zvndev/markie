//! Export, print and converted copies (PARITY.md section 23), the port of
//! `src/lib/use-export.ts` and the main-process halves in `export-pdf.js`
//! and `export-document.js`. The bytes come from markie-export; this file
//! asks where they go, guards against two exports at once, and reports
//! failures the way Electron words them. Backing out of a sheet is not a
//! failure.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use gpui_kit::component::WindowExt as _;
use gpui_kit::*;
use markie_core::formats::FormatKind;
use markie_export::Theme;
use markie_export::assets::{Grants, inline_local_images};
use markie_export::convert::{ExportFormat, SourceKind, convert_for_export, export_file_name};
use markie_export::pdf::{PdfOptions, ensure_extension, export_pdf};

use super::{DocKind, Workspace};

/// What the title bar's Export menu, the File menu and the palette ask for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportKind {
    PdfDark,
    PdfLight,
    Html,
    Docx,
    Rtf,
    Odt,
    Txt,
    Md,
    /// The system print sheet, in the app's current tone.
    Print,
    /// A Word, RTF or ODT document's own PDF (the document-mode menu item).
    OfficePdf,
}

/// One export at a time: a second click while one runs says so.
static EXPORTING: AtomicBool = AtomicBool::new(false);
pub const EXPORT_BUSY: &str = "Markie is already exporting. Wait for that one to finish.";
/// document-output-policy.ts.
pub const COMMENT_OUTPUT_CONFIRMATION: &str = "This output does not include review comments. Continue with the document text only?";

/// What use-document-output.ts reads off the open Word, RTF or ODT document.
pub(super) struct OfficeOutput {
    /// `canPrintDocx`.
    pub printable: bool,
    pub has_comments: bool,
}
/// Electron's deadline for laying out an export.
const DEADLINE: Duration = Duration::from_secs(30);

struct Guard;
impl Guard {
    fn take() -> Option<Guard> {
        EXPORTING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| Guard)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        EXPORTING.store(false, Ordering::SeqCst);
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn is_exporting() -> bool {
    EXPORTING.load(Ordering::SeqCst)
}

/// Remote pictures for a PDF: http(s), Electron's 8 s image deadline, 10 MB.
fn fetch(url: &str) -> Option<Vec<u8>> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(8)).build().ok()?;
    let response = client.get(url).send().ok()?.error_for_status().ok()?;
    let bytes = response.bytes().ok()?;
    (bytes.len() <= markie_export::assets::MAX_IMAGE_BYTES).then(|| bytes.to_vec())
}

fn pdf_bytes(markdown: &str, theme: Theme, doc_dir: Option<&Path>) -> Result<Vec<u8>, String> {
    let opts = PdfOptions { theme, doc_dir, grants: Grants::default(), fetch: Some(&fetch) };
    export_pdf(markdown, &opts)
}

/// Runs `job` off the main thread with the export deadline.
async fn with_deadline<T: Send + 'static>(cx: &mut AsyncWindowContext, job: impl FnOnce() -> Result<T, String> + Send + 'static, late: &'static str) -> Result<T, String> {
    let (tx, rx) = futures::channel::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(job());
    });
    let timer = cx.background_executor().timer(DEADLINE);
    futures::pin_mut!(rx);
    futures::pin_mut!(timer);
    match futures::future::select(rx, timer).await {
        futures::future::Either::Left((Ok(result), _)) => result,
        futures::future::Either::Left((Err(_), _)) => Err(late.to_string()),
        futures::future::Either::Right(_) => Err(late.to_string()),
    }
}

impl Workspace {
    /// `Workspace::export(kind)` for the shell's menus: every export Electron offers.
    pub(super) fn export_document(&mut self, kind: ExportKind, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.menu = None;
        let Some(doc) = &self.doc else { return };
        let Some(guard) = Guard::take() else {
            window.push_notification(EXPORT_BUSY, cx);
            return;
        };
        let path = doc.path.clone();
        let dir = self.default_dir();
        let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let source = if doc.format == FormatKind::Markdown { SourceKind::Markdown } else { SourceKind::Text };
        let dark = crate::themes::palette(cx).dark;

        if matches!(kind, ExportKind::OfficePdf) || (kind == ExportKind::Print && matches!(doc.kind, DocKind::Office(_))) {
            // use-document-output.ts: only a document `canPrintDocx` accepts
            // has a print or PDF path; the menu item is not offered otherwise.
            let Some(eligible) = self.office_output_for(cx) else { return };
            if !eligible.printable {
                return;
            }
            let DocKind::Office(office) = &doc.kind else { return };
            let bytes = office.view.read(cx).editor.export();
            let format = match doc.format {
                FormatKind::Rtf => markie_office::model::Format::Rtf,
                FormatKind::Odt => markie_office::model::Format::Odt,
                _ => markie_office::model::Format::Docx,
            };
            let unchanged = if format == markie_office::model::Format::Docx { "The Word file was not changed." } else { "The source file was not changed." };
            let printing = kind == ExportKind::Print;
            let confirm = eligible.has_comments.then(|| {
                window.prompt(PromptLevel::Info, COMMENT_OUTPUT_CONFIRMATION, None, &[PromptButton::ok("OK"), PromptButton::cancel("Cancel")], cx)
            });
            cx.spawn_in(window, async move |_, cx| {
                let _guard = guard;
                if let Some(answer) = confirm
                    && answer.await.ok() != Some(0)
                {
                    return;
                }
                // export-pdf's own save sheet: "document.pdf", whatever the file is called.
                let target = if printing {
                    None
                } else {
                    let Ok(rx) = cx.update(|_, cx| cx.prompt_for_new_path(&dir, Some("document.pdf"))) else { return };
                    match rx.await {
                        Ok(Ok(Some(t))) => Some(t),
                        _ => return,
                    }
                };
                let result = with_deadline(
                    cx,
                    move || {
                        let bytes = bytes.map_err(|e| e.to_string())?;
                        let doc = markie_office::rich_document::open_rich_document(format, &bytes).map_err(|e| e.to_string())?;
                        markie_export::office_pdf::office_pdf(&doc)
                    },
                    "The PDF export took too long and was stopped.",
                )
                .await;
                let written = target.as_ref().map(|t| ensure_extension(t, ".pdf"));
                let ok = finish(result, target, printing, "Could not print or export the supported document view.", cx);
                if ok {
                    notify(
                        match (printing, written) {
                            (true, _) => "Sent the supported document view to the printer.".to_string(),
                            (false, Some(path)) => format!("Exported PDF to {}. {unchanged}", path.display()),
                            (false, None) => format!("PDF exported. {unchanged}"),
                        },
                        cx,
                    );
                }
            })
            .detach();
            return;
        }

        let text = self.current_text(cx);
        match kind {
            ExportKind::PdfDark | ExportKind::PdfLight | ExportKind::Print => {
                let printing = kind == ExportKind::Print;
                let theme = match kind {
                    ExportKind::PdfDark => Theme::Dark,
                    ExportKind::PdfLight => Theme::Light,
                    _ if dark => Theme::Dark,
                    _ => Theme::Light,
                };
                // Electron's save sheet suggests "document.pdf".
                let target = (!printing).then(|| cx.prompt_for_new_path(&dir, Some("document.pdf")));
                let failure = if printing { "Couldn't print this document." } else { "Couldn't export this document as a PDF." };
                let late = if printing { "The document took too long to lay out and the print was stopped." } else { "The PDF export took too long and was stopped." };
                let doc_dir = path.parent().map(PathBuf::from);
                cx.spawn_in(window, async move |_, cx| {
                    let _guard = guard;
                    let target = match target {
                        Some(rx) => match rx.await {
                            Ok(Ok(Some(t))) => Some(t),
                            _ => return,
                        },
                        None => None,
                    };
                    let result = with_deadline(cx, move || pdf_bytes(&text, theme, doc_dir.as_deref()), late).await;
                    finish(result, target, printing, failure, cx);
                })
                .detach();
            }
            ExportKind::Html => {
                let base = file_name.as_deref().map(|n| n.rsplit_once('.').map(|(b, _)| b).unwrap_or(n)).unwrap_or("document").to_string();
                let html = markie_export::build_pdf_html(&markie_export::render_markdown_html(&text), Theme::Light);
                let html = inline_local_images(&html, path.parent(), &Grants::default());
                let rx = cx.prompt_for_new_path(&dir, Some(&format!("{base}.html")));
                cx.spawn_in(window, async move |_, cx| {
                    let _guard = guard;
                    if let Ok(Ok(Some(t))) = rx.await
                        && let Err(e) = std::fs::write(ensure_extension(&t, ".html"), html)
                    {
                        notify(format!("Couldn't export this document as HTML: {e}"), cx);
                    }
                })
                .detach();
            }
            ExportKind::Docx | ExportKind::Rtf | ExportKind::Odt | ExportKind::Txt | ExportKind::Md => {
                let format = match kind {
                    ExportKind::Docx => ExportFormat::Docx,
                    ExportKind::Rtf => ExportFormat::Rtf,
                    ExportKind::Odt => ExportFormat::Odt,
                    ExportKind::Txt => ExportFormat::Txt,
                    _ => ExportFormat::Md,
                };
                let name = export_file_name(file_name.as_deref(), format);
                let rx = cx.prompt_for_new_path(&dir, Some(&name));
                cx.spawn_in(window, async move |_, cx| {
                    let _guard = guard;
                    let Ok(Ok(Some(t))) = rx.await else { return };
                    let failure = format!("Couldn't export this document as {}.", format.info().label);
                    let result = with_deadline(cx, move || convert_for_export(&text, source, format), "The export took too long and was stopped.").await;
                    match result {
                        Ok(bytes) if bytes.len() <= 64 * 1024 * 1024 => {
                            let target = ensure_extension(&t, &format!(".{}", format.info().extension));
                            if let Err(e) = std::fs::write(target, bytes) {
                                notify(format!("{}: {e}", failure.trim_end_matches('.')), cx);
                            }
                        }
                        Ok(_) => notify("This document is too large to export in that format.".into(), cx),
                        Err(e) => notify(format!("{}: {e}", failure.trim_end_matches('.')), cx),
                    }
                })
                .detach();
            }
            ExportKind::OfficePdf => {}
        }
    }
}

impl Workspace {
    /// The open office document's output state, or none for other documents.
    pub(super) fn office_output_for(&self, cx: &App) -> Option<OfficeOutput> {
        let DocKind::Office(office) = &self.doc.as_ref()?.kind else { return None };
        let view = office.view.read(cx);
        let rich = view.editor.rich();
        Some(OfficeOutput { printable: markie_export::office_pdf::can_print(rich), has_comments: !rich.comments.is_empty() })
    }

    pub(super) fn on_print(&mut self, _: &crate::actions::Print, window: &mut Window, cx: &mut Context<Self>) {
        self.export_document(ExportKind::Print, window, cx);
    }
    pub(super) fn on_export_pdf_dark(&mut self, _: &crate::actions::ExportPdfDark, window: &mut Window, cx: &mut Context<Self>) {
        self.export_document(ExportKind::PdfDark, window, cx);
    }
    pub(super) fn on_export_pdf_light(&mut self, _: &crate::actions::ExportPdfLight, window: &mut Window, cx: &mut Context<Self>) {
        self.export_document(ExportKind::PdfLight, window, cx);
    }
    pub(super) fn on_export_html(&mut self, _: &crate::actions::ExportHtml, window: &mut Window, cx: &mut Context<Self>) {
        self.export_document(ExportKind::Html, window, cx);
    }
}

fn notify(message: String, cx: &mut AsyncWindowContext) {
    cx.update(|window, cx| window.push_notification(message, cx)).ok();
}

/// Writes or prints the PDF. True when it was written or sent to a printer.
fn finish(result: Result<Vec<u8>, String>, target: Option<PathBuf>, printing: bool, failure: &str, cx: &mut AsyncWindowContext) -> bool {
    match result {
        Err(e) => {
            notify(if e.is_empty() { failure.to_string() } else { e }, cx);
            false
        }
        Ok(pdf) if printing => cx
            .update(|_, _| match print_pdf(&pdf) {
                Ok(printed) => printed,
                Err(e) => {
                    eprintln!("markie-rs: print failed: {e}");
                    false
                }
            })
            .unwrap_or(false),
        Ok(pdf) => match target {
            Some(t) => match std::fs::write(ensure_extension(&t, ".pdf"), pdf) {
                Ok(()) => true,
                Err(e) => {
                    notify(format!("{}: {e}", failure.trim_end_matches('.')), cx);
                    false
                }
            },
            None => false,
        },
    }
}

/// The system print sheet for a PDF (Electron's `webContents.print` with
/// `silent: false`). Returns false when the person cancelled, which is not
/// an error.
#[cfg(target_os = "macos")]
pub fn print_pdf(bytes: &[u8]) -> Result<bool, String> {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::NSPrintInfo;
    use objc2_foundation::NSData;
    use objc2_pdf_kit::{PDFDocument, PDFPrintScalingMode};
    let mtm = MainThreadMarker::new().ok_or("Printing must start on the main thread.")?;
    let data = NSData::with_bytes(bytes);
    let doc = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }.ok_or("The print document could not be read.")?;
    let info = NSPrintInfo::sharedPrintInfo();
    let op = unsafe { doc.printOperationForPrintInfo_scalingMode_autoRotate(Some(&info), PDFPrintScalingMode::PageScaleNone, true, mtm) }.ok_or("The print job could not start.")?;
    op.setShowsPrintPanel(true);
    op.setShowsProgressPanel(true);
    Ok(op.runOperation())
}

#[cfg(not(target_os = "macos"))]
pub fn print_pdf(_bytes: &[u8]) -> Result<bool, String> {
    Err("Printing is not available on this platform yet.".into())
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's glob export brings its own `test` attribute.
    use super::{Guard, is_exporting};

    #[test]
    fn one_export_at_a_time() {
        let first = Guard::take().unwrap();
        assert!(Guard::take().is_none());
        assert!(is_exporting());
        drop(first);
        assert!(Guard::take().is_some());
    }
}
