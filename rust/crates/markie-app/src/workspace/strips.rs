//! The notices above the document, and the dialog behind one of them,
//! ported from `src/components/draft-strip.tsx` and `disk-change.tsx`:
//!
//! - the recovered-draft strip, for the open document only;
//! - the outside-edit strip: "name changed on disk." with Reload. With no
//!   unsaved edits Reload just reloads; with unsaved edits it opens
//!   DiskConflictDialog, which leads with the answer that loses nothing;
//! - Markie RS's own strip for a file that was moved or deleted.

use std::path::PathBuf;
use std::time::Instant;

use gpui_kit::component::WindowExt as _;
use gpui_kit::*;

use markie_core::drafts::Drafts;

use super::dialog_chrome::{Tokens, inset};
use super::history_dialog::{Line, line_diff};
use super::overlay::Overlay;
use super::{DocKind, OpenDoc, Workspace};

/// The destructive choice in the conflict dialog awaiting its second click.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Destructive {
    Overwrite,
    Discard,
}

/// `relativeTime` from `src/lib/relative-time.ts`.
pub(crate) fn relative_time(ms_ago: i64) -> String {
    let min = (ms_ago as f64 / 60_000.).round() as i64;
    if min < 1 {
        return "moments ago".into();
    }
    if min < 60 {
        return format!("{min} minute{} ago", if min == 1 { "" } else { "s" });
    }
    let h = (min as f64 / 60.).round() as i64;
    if h < 24 {
        return format!("{h} hour{} ago", if h == 1 { "" } else { "s" });
    }
    let d = (h as f64 / 24.).round() as i64;
    format!("{d} day{} ago", if d == 1 { "" } else { "s" })
}

/// `describeDiskChange` from `src/lib/disk-change.ts`.
pub(crate) fn describe_disk_change(local: &str, disk: &str) -> String {
    let (added, removed) = match line_diff(local, disk) {
        Some(lines) => (
            lines.iter().filter(|l| matches!(l, Line::Added(_))).count(),
            lines.iter().filter(|l| matches!(l, Line::Removed(_))).count(),
        ),
        None => (disk.lines().count(), local.lines().count()),
    };
    let lines = |n: usize| format!("{n} line{}", if n == 1 { "" } else { "s" });
    if added == 0 && removed == 0 {
        return "The two copies are identical.".into();
    }
    if removed == 0 {
        return format!("The file on disk has {} yours does not.", lines(added));
    }
    if added == 0 {
        return format!("The file on disk is missing {} of yours.", lines(removed));
    }
    format!("The file on disk has {} yours does not, and is missing {} of yours.", lines(added), lines(removed))
}

/// `copyNameFor`: `notes (copy).md`, then `notes (copy 2).md`.
pub(crate) fn copy_name_for(file_name: &str) -> String {
    if file_name.is_empty() {
        return "untitled (copy).md".into();
    }
    let (stem, ext) = match file_name.rfind('.') {
        Some(dot) if dot > 0 => (&file_name[..dot], &file_name[dot..]),
        _ => (file_name, ""),
    };
    if let Some(open) = stem.rfind(" (copy") {
        let inner = &stem[open + 6..];
        if let Some(num) = inner.strip_suffix(')') {
            let next = if num.is_empty() {
                Some(2)
            } else {
                num.strip_prefix(' ').and_then(|n| n.parse::<u32>().ok()).map(|n| n + 1)
            };
            if let Some(next) = next {
                return format!("{} (copy {next}){ext}", &stem[..open]);
            }
        }
    }
    format!("{stem} (copy){ext}")
}

impl Workspace {
    /// The watcher saw someone else's write. Electron never reloads on its
    /// own: it raises the strip and lets the person choose.
    pub(super) fn note_disk_change(&mut self, theirs: String, cx: &mut Context<Self>) {
        if self.disk_conflict.as_deref() == Some(theirs.as_str()) {
            return;
        }
        self.disk_conflict = Some(theirs);
        if self.dirty {
            self.autosave.cancel();
        }
        cx.notify();
    }

    fn open_name(&self) -> String {
        self.doc
            .as_ref()
            .and_then(|d| d.path.file_name())
            .map_or_else(|| "This document".into(), |n| n.to_string_lossy().into_owned())
    }

    fn disk_reload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dirty {
            self.show_dialog(Overlay::DiskConflict { confirming: None }, window, cx);
        } else {
            self.take_theirs(cx);
        }
    }

    /// The recovered draft for the open document, if Markie kept one.
    fn open_draft(&self) -> Option<usize> {
        let path = self.doc.as_ref()?.path.to_string_lossy().into_owned();
        self.recovered.iter().position(|d| d.meta.path.as_deref() == Some(path.as_str()))
    }

    /// Load the draft into the editor as unsaved, like Electron.
    fn restore_open_draft(&mut self, cx: &mut Context<Self>) {
        let Some(i) = self.open_draft() else { return };
        let draft = self.recovered.remove(i);
        let Some(text) = self.drafts.read(&draft.key) else {
            cx.notify();
            return;
        };
        if let Some(OpenDoc { kind: DocKind::Text { .. }, .. }) = &self.doc {
            self.pending_editor_text = Some(text.clone());
            if self.rich_active() {
                self.load_rich(&text, cx);
            }
            self.update_stats(&text);
            self.dirty = true;
            self.autosave.note_change(Instant::now());
            self.schedule_autosave(cx);
        }
        cx.notify();
    }

    fn discard_open_draft(&mut self, cx: &mut Context<Self>) {
        if let Some(i) = self.open_draft() {
            let draft = self.recovered.remove(i);
            let _ = self.drafts.discard(&draft.key);
        }
        cx.notify();
    }

    pub(super) fn render_strips(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = self.tokens(cx);
        let mut strips: Vec<AnyElement> = Vec::new();

        if let Some(i) = self.open_draft() {
            let saved = &self.recovered[i].meta.saved_at;
            let ago = chrono::DateTime::parse_from_rfc3339(saved)
                .map(|d| relative_time(chrono::Utc::now().timestamp_millis() - d.timestamp_millis()))
                .unwrap_or_default();
            let hover = t.hover_soft();
            let fg = t.foreground;
            strips.push(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .border_b_1()
                    .border_color(t.border)
                    .bg(t.surface)
                    .px(px(12.))
                    .py(px(8.))
                    .text_size(px(12.))
                    .text_color(t.foreground)
                    .child(div().flex_1().min_w_0().child(format!("Markie recovered unsaved changes from {ago}.")))
                    .child(
                        div()
                            .id("draft-restore")
                            .h(px(24.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .rounded(px(6.))
                            .border_1()
                            .border_color(t.border)
                            .text_size(px(11.5))
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover))
                            .child("Restore")
                            .on_click(cx.listener(|this, _, _, cx| this.restore_open_draft(cx))),
                    )
                    .child(
                        div()
                            .id("draft-discard")
                            .h(px(24.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .rounded(px(6.))
                            .text_size(px(11.5))
                            .text_color(t.muted)
                            .cursor_pointer()
                            .hover(move |el| el.text_color(fg))
                            .child("Discard")
                            .on_click(cx.listener(|this, _, _, cx| this.discard_open_draft(cx))),
                    )
                    .into_any_element(),
            );
        }

        let banner = |t: &Tokens| {
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .py(px(6.))
                .bg(t.surface)
                .shadow(vec![inset(t.border, -1.)])
        };

        if self.disk_conflict.is_some() {
            let hover = t.hover_soft();
            strips.push(
                banner(&t)
                    .child(div().text_size(px(12.)).line_height(px(12.)).child("↻"))
                    .child(
                        div()
                            .min_w_0()
                            .text_size(px(11.))
                            .text_color(t.muted)
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(format!("{} changed on disk.", self.open_name())),
                    )
                    .child(
                        div()
                            .id("disk-reload")
                            .ml_auto()
                            .flex_none()
                            .rounded(px(4.))
                            .px(px(8.))
                            .py(px(2.))
                            .text_size(px(11.))
                            .text_color(t.foreground)
                            .cursor_pointer()
                            .hover(move |el| el.bg(hover))
                            .child("Reload")
                            .on_click(cx.listener(|this, _, window, cx| this.disk_reload(window, cx))),
                    )
                    .into_any_element(),
            );
        } else if self.disk_missing {
            strips.push(
                banner(&t)
                    .child(
                        div()
                            .min_w_0()
                            .text_size(px(11.))
                            .text_color(t.muted)
                            .child(format!("{} was moved or deleted. Saving will create it again.", self.open_name())),
                    )
                    .into_any_element(),
            );
        }

        if strips.is_empty() {
            None
        } else {
            Some(div().flex().flex_col().children(strips).into_any_element())
        }
    }

    // ------------------------------------------------------ the dialog

    fn disk_confirm(&mut self, which: Destructive, window: &mut Window, cx: &mut Context<Self>) {
        let Overlay::DiskConflict { confirming } = &mut self.dialogs.open else { return };
        if *confirming != Some(which) {
            *confirming = Some(which);
            cx.notify();
            return;
        }
        self.close_dialog(window, cx);
        match which {
            Destructive::Overwrite => self.keep_mine(cx),
            Destructive::Discard => self.take_theirs(cx),
        }
    }

    /// Keep both: save the buffer under a new name and leave the file alone.
    /// The copy then opens, so the person keeps working on their version.
    fn disk_save_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_dialog(window, cx);
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
        let dir = path.parent().map(PathBuf::from).unwrap_or_default();
        let suggested = copy_name_for(&self.open_name());
        let mine = self.current_text(cx);
        let rx = cx.prompt_for_new_path(&dir, Some(&suggested));
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(target))) = rx.await else { return };
            this.update_in(cx, |this, window, cx| match std::fs::write(&target, &mine) {
                Ok(()) => {
                    // The original is now whatever is on disk.
                    this.disk_conflict = None;
                    this.dirty = false;
                    this.autosave.cancel();
                    let _ = this.drafts.discard(&Drafts::key_for(Some(&path)));
                    this.open_path(&target, window, cx);
                    this.rescan(cx);
                }
                Err(e) => window.push_notification(format!("Markie could not save the copy: {e}"), cx),
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn render_disk_conflict(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::DiskConflict { confirming } = self.dialogs.open else { return div().into_any_element() };
        let name = self.open_name();
        let mine = self.current_text(cx);
        let summary = describe_disk_change(&mine, self.disk_conflict.as_deref().unwrap_or(""));
        let choice = |id: &'static str, label: &str, detail: &str, primary: bool, destructive: bool| {
            let hover = t.hover_soft();
            div()
                .id(id)
                .w_full()
                .rounded(px(6.))
                .border_1()
                .px(px(12.))
                .py(px(8.))
                .cursor_pointer()
                .when_else_choice(primary, t, hover)
                .child(div().text_size(px(12.5)).text_color(if destructive { t.red } else { t.foreground }).child(label.to_string()))
                .child(div().mt(px(2.)).text_size(px(11.)).line_height(px(18.)).text_color(t.muted).child(detail.to_string()))
        };
        let (ow_label, ow_detail) = if confirming == Some(Destructive::Overwrite) {
            ("Yes, overwrite the file", "The changes made on disk will be gone.")
        } else {
            ("Overwrite the file", "Writes your version over the file, discarding what changed it.")
        };
        let (dc_label, dc_detail) = if confirming == Some(Destructive::Discard) {
            ("Yes, discard my changes", "Your unsaved edits will be gone.")
        } else {
            ("Discard my changes", "Loads the file from disk and throws away what you have typed.")
        };
        let fg = t.foreground;
        self.panel(t, 12.)
            .w(px(480.))
            .max_w(relative(0.92))
            .p(px(20.))
            .child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).child(format!("{name} changed on disk")))
            .child(
                div()
                    .mt(px(8.))
                    .text_size(px(12.5))
                    .line_height(px(20.))
                    .text_color(t.muted)
                    .child(format!(
                        "Something else edited this file while you had unsaved changes, most likely an agent, another editor, or a sync client. {summary}"
                    )),
            )
            .child(
                div()
                    .mt(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        choice(
                            "disk-copy",
                            "Save a copy…",
                            "Keeps both. Your version is saved under a new name and the file on disk is left alone.",
                            true,
                            false,
                        )
                        .on_click(cx.listener(|this, _, window, cx| this.disk_save_copy(window, cx))),
                    )
                    .child(
                        choice("disk-overwrite", ow_label, ow_detail, false, true)
                            .on_click(cx.listener(|this, _, window, cx| this.disk_confirm(Destructive::Overwrite, window, cx))),
                    )
                    .child(
                        choice("disk-discard", dc_label, dc_detail, false, true)
                            .on_click(cx.listener(|this, _, window, cx| this.disk_confirm(Destructive::Discard, window, cx))),
                    ),
            )
            .child(
                div().mt(px(16.)).flex().justify_end().child(
                    div()
                        .id("disk-later")
                        .text_size(px(11.))
                        .text_color(t.muted)
                        .cursor_pointer()
                        .hover(move |el| el.text_color(fg))
                        .child("Decide later")
                        .on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx))),
                ),
            )
            .into_any_element()
    }
}

trait ChoiceStyle {
    fn when_else_choice(self, primary: bool, t: &Tokens, hover: Hsla) -> Self;
}

impl ChoiceStyle for Stateful<Div> {
    fn when_else_choice(self, primary: bool, t: &Tokens, hover: Hsla) -> Self {
        if primary {
            self.border_color(super::dialog_chrome::fade(t.foreground, 0.3)).bg(t.accent)
        } else {
            self.border_color(t.border).hover(move |el| el.bg(hover))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{copy_name_for, describe_disk_change, relative_time};

    #[test]
    fn names_copies_like_electron() {
        assert_eq!(copy_name_for("notes.md"), "notes (copy).md");
        assert_eq!(copy_name_for("notes (copy).md"), "notes (copy 2).md");
        assert_eq!(copy_name_for("notes (copy 2).md"), "notes (copy 3).md");
        assert_eq!(copy_name_for(".env"), ".env (copy)");
        assert_eq!(copy_name_for(""), "untitled (copy).md");
    }

    #[test]
    fn describes_changes_in_lines() {
        assert_eq!(describe_disk_change("a\nb", "a\nb"), "The two copies are identical.");
        assert_eq!(describe_disk_change("a", "a\nb"), "The file on disk has 1 line yours does not.");
        assert_eq!(describe_disk_change("a\nb\nc", "a"), "The file on disk is missing 2 lines of yours.");
        assert_eq!(
            describe_disk_change("a\nb", "a\nc"),
            "The file on disk has 1 line yours does not, and is missing 1 line of yours."
        );
    }

    #[test]
    fn says_how_long_ago() {
        assert_eq!(relative_time(10_000), "moments ago");
        assert_eq!(relative_time(60_000), "1 minute ago");
        assert_eq!(relative_time(5 * 3_600_000), "5 hours ago");
        assert_eq!(relative_time(2 * 86_400_000), "2 days ago");
    }
}
