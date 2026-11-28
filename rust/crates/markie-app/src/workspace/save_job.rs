//! Saves of large text documents, written on their own thread (editors 7.9,
//! docs/rust-port/PERF.md). Copying 100 MB out of the editor, keeping the old
//! file as a History version, the write and its hash took most of a second of
//! main thread. Here the main thread only checks for an outside edit and takes
//! the editor's rope, which costs nothing to clone; the thread does the rest
//! (`document::write_text_document`) and the main thread then records what was
//! written.
//!
//! The rules that keep a save exact:
//! - One save at a time. A save asked for while one runs waits for it and then
//!   writes the newest text.
//! - Typing during the save keeps the edited marker: the save wrote the text
//!   as it was when it started (`edit_generation`).
//! - Quitting, closing the window, opening another document, a reload and any
//!   save on the main thread wait for the running save first (`wait_for_save`).
//! - The disk poll skips while a save runs, so Markie's own write is never
//!   taken for someone else's.

use markie_core::document::TextWrite;

use super::*;

/// A save of a large text document running on its own thread.
pub(super) struct SaveJob {
    path: PathBuf,
    /// [`Workspace::edit_generation`] when the text was taken.
    generation: u64,
    write: TextWrite,
    /// Show a failure (⌘S) or stay quiet (autosave, which keeps a draft).
    report: bool,
    /// Another save asked for while this one ran: `Some(report)`.
    again: Option<bool>,
    _done: Task<()>,
}

impl Workspace {
    /// A large text document in Source saves on its own thread. Rich text,
    /// CSV tables and untitled buffers keep the main-thread save.
    pub(super) fn saves_in_background(&self) -> bool {
        matches!(
            &self.doc,
            Some(OpenDoc { large: true, untitled: false, format, kind: DocKind::Text { .. }, .. }) if *format != FormatKind::Csv
        ) && !self.rich_active()
    }

    pub(super) fn save_in_flight(&self) -> bool {
        self.save_job.is_some()
    }

    /// Write the editor's text on a background thread. `report` shows a
    /// failure (needs the window); `autosave` keeps the text in the crash
    /// journal until the write lands, as `autosave_now` does.
    pub(super) fn start_background_save(&mut self, report: bool, autosave: bool, window: Option<&mut Window>, cx: &mut Context<Self>) {
        if let Some(job) = &mut self.save_job {
            job.again = Some(job.again.unwrap_or(false) || report);
            return;
        }
        let Some(OpenDoc { path, kind: DocKind::Text { encoding, bom, .. }, .. }) = &self.doc else { return };
        let (path, encoding, bom) = (path.clone(), *encoding, *bom);
        let rope = self.editor.read(cx).text().clone();
        let history = self.history.clone();
        let drafts = autosave.then(|| self.drafts.clone());
        let (done_tx, done_rx) = futures::channel::oneshot::channel::<()>();
        // The one copy of the text, made on the save thread: it becomes the
        // saved text afterwards.
        let text = move || {
            let mut text = String::with_capacity(rope.len());
            for chunk in rope.chunks() {
                text.push_str(chunk);
            }
            text
        };
        let write = TextWrite::start(history, path.clone(), text, encoding, bom, drafts, move || {
            let _ = done_tx.send(());
        });
        let write = match write {
            Ok(write) => write,
            Err(err) => {
                if let (true, Some(window)) = (report, window) {
                    window.push_notification(format!("Markie could not save: {err}"), cx);
                }
                return;
            }
        };
        let done = match window {
            Some(window) => cx.spawn_in(window, async move |this, cx| {
                let _ = done_rx.await;
                this.update_in(cx, |this, window, cx| this.finish_background_save(Some(window), cx)).ok();
            }),
            None => cx.spawn(async move |this, cx| {
                let _ = done_rx.await;
                this.update(cx, |this, cx| this.finish_background_save(None, cx)).ok();
            }),
        };
        self.save_job = Some(SaveJob {
            path,
            generation: self.edit_generation,
            write,
            report,
            again: None,
            _done: done,
        });
        cx.notify();
    }

    /// Let a running save finish before anything that needs the file or the
    /// saved text settled: quitting, closing, opening, reloading, or a save on
    /// the main thread. A save asked for meanwhile runs too, also waited for.
    pub(super) fn wait_for_save(&mut self, cx: &mut Context<Self>) {
        while self.save_job.is_some() {
            self.finish_background_save(None, cx);
        }
    }

    fn finish_background_save(&mut self, window: Option<&mut Window>, cx: &mut Context<Self>) {
        let Some(SaveJob { path, generation, write, report, mut again, _done: done }) = self.save_job.take() else { return };
        // This can run inside that task; detached, it is not cancelled from
        // within, and run later it finds no job and returns.
        done.detach();
        // Waits only when quitting or opening caught the save mid-write.
        let outcome = write.finish();
        let unchanged = self.edit_generation == generation;
        match outcome {
            Ok(written) => {
                let current = self.doc.as_ref().is_some_and(|d| d.path == path);
                if current {
                    if let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = self.doc.as_mut() {
                        *saved = written.text;
                    }
                    self.disk.remember_hashed(&path, written.hash, true);
                    if unchanged {
                        self.dirty = false;
                    }
                }
                if unchanged {
                    let _ = self.drafts.discard(&Drafts::key_for(Some(&path)));
                }
                if current && self.side == SidePanel::History {
                    self.refresh_versions();
                }
                self.cloud_after_save(&path, cx);
                self.google_after_save(&path, cx);
            }
            Err(err) => {
                let message = format!("Markie could not save: {err:#}");
                if report {
                    match window {
                        Some(window) => window.push_notification(message, cx),
                        None => eprintln!("markie-rs: {message}"),
                    }
                }
                // Nothing was saved: the edited marker stays as it was and the
                // next save tries again.
                again = None;
            }
        }
        if let Some(report) = again {
            if self.dirty && self.saves_in_background() {
                self.start_background_save(report, !report, None, cx);
            }
        }
        cx.notify();
    }
}
