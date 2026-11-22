//! A synced document that moved on in the cloud, ported from Electron:
//!
//! - `UpdateStrip` (share-banner.tsx), above the document when the server is
//!   ahead and no live session runs: "Updated on the server." with Update,
//!   or, when pulling would replace local work, the longer line with
//!   "Review changes…";
//! - `ConflictDialog` (conflict-dialog.tsx), which says in lines what each
//!   choice costs (line-diff.ts) and leads with Keep both;
//! - the Library's "Stop syncing this document to the cloud?" confirm
//!   (library.tsx), with its two ways out.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_cloud::sync::{SyncEngine, SyncState};

use super::cloud::{TextAction, name, network};
use super::dialog_chrome::{Tokens, fade, inset};
use super::overlay::Overlay;
use super::{DocKind, Workspace};

/// How far apart two versions of a document are, in lines (`LineDiff`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LineDiff {
    /// In remote but not local: what a pull brings in.
    pub added: usize,
    /// In local but not remote: what a pull replaces.
    pub removed: usize,
    pub same: usize,
}

/// `MAX_DIFF_LINES`: past this the LCS table costs more than the answer.
pub(crate) const MAX_DIFF_LINES: usize = 5000;

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    // A trailing newline ends the last line; it is not an extra empty one.
    text.strip_suffix('\n').unwrap_or(text).split('\n').collect()
}

/// Multiset intersection, for documents past `MAX_DIFF_LINES`.
fn counting_diff(a: &[&str], b: &[&str]) -> LineDiff {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for line in a {
        *counts.entry(line).or_default() += 1;
    }
    let mut same = 0;
    for line in b {
        if let Some(n) = counts.get_mut(line)
            && *n > 0
        {
            same += 1;
            *n -= 1;
        }
    }
    LineDiff { added: b.len() - same, removed: a.len() - same, same }
}

/// `lineDiff` from src/lib/line-diff.ts: the longest common subsequence over
/// lines, two rows at a time.
pub(crate) fn line_diff(local: &str, remote: &str) -> LineDiff {
    let a = split_lines(local);
    let b = split_lines(remote);
    if a.len() > MAX_DIFF_LINES || b.len() > MAX_DIFF_LINES {
        return counting_diff(&a, &b);
    }
    let mut prev = vec![0usize; b.len() + 1];
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = 0;
        for j in 1..=b.len() {
            cur[j] = if a[i - 1] == b[j - 1] { prev[j - 1] + 1 } else { prev[j].max(cur[j - 1]) };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let same = prev[b.len()];
    LineDiff { added: b.len() - same, removed: a.len() - same, same }
}

/// `describeDiff`: what you lose first, then what you gain.
pub(crate) fn describe_diff(d: LineDiff) -> String {
    let lines = |n: usize| format!("{n} line{}", if n == 1 { "" } else { "s" });
    if d.added == 0 && d.removed == 0 {
        return "The two copies are identical.".into();
    }
    if d.removed == 0 {
        return format!("Pulling brings in {} from the server.", lines(d.added));
    }
    if d.added == 0 {
        return format!("Pulling replaces {} of yours.", lines(d.removed));
    }
    format!("Pulling replaces {} of yours and brings in {} from the server.", lines(d.removed), lines(d.added))
}

/// The strip's two kinds (`UpdateStrip` `kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StripKind {
    /// Nothing local is at risk: one button finishes it.
    Clean,
    /// Pulling would replace local work: the button opens the dialog.
    Dirty,
}

/// `kind` in page.tsx: an unsaved buffer, a rejected push ("conflict") and a
/// push that never landed ("unpushed") all hold work a pull would destroy.
/// Markie RS also counts a file whose text is not the last synced text,
/// which its pull refuses to overwrite without asking.
pub(crate) fn strip_kind(dirty: bool, state: SyncState, disk_matches_sync: bool) -> StripKind {
    if dirty || matches!(state, SyncState::Conflict | SyncState::Unpushed) || !disk_matches_sync {
        StripKind::Dirty
    } else {
        StripKind::Clean
    }
}

/// `UpdateStrip`'s line.
pub(crate) fn strip_line(kind: StripKind) -> &'static str {
    match kind {
        StripKind::Clean => "Updated on the server.",
        StripKind::Dirty => "Updated on the server, and this copy has changes of its own.",
    }
}

/// `UpdateStrip`'s button.
pub(crate) fn strip_button(kind: StripKind, busy: bool) -> &'static str {
    match (busy, kind) {
        (true, _) => "Updating…",
        (false, StripKind::Clean) => "Update",
        (false, StripKind::Dirty) => "Review changes…",
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ConflictStage {
    Loading,
    Ready { summary: String, identical: bool },
    Error(String),
}

/// The open `ConflictDialog`. The counts are taken once, from the buffer as
/// it stood when the dialog opened, so typing behind it never changes them.
pub(crate) struct ConflictState {
    pub path: PathBuf,
    pub name: String,
    pub stage: ConflictStage,
    pub busy: bool,
}

/// The per-document strip state Electron keeps in page.tsx
/// (`updateBusy`, `updateError`), dropped when another document opens.
#[derive(Default)]
pub(crate) struct UpdateState {
    pub path: Option<PathBuf>,
    pub busy: bool,
    pub error: Option<String>,
}

impl Workspace {
    /// `updateWaiting` for the open document: a synced text file the server
    /// has a newer version of, while no live session runs.
    pub(super) fn update_waiting(&self) -> Option<(PathBuf, StripKind)> {
        let doc = self.doc.as_ref()?;
        let DocKind::Text { saved, .. } = &doc.kind else { return None };
        if self.live_running() {
            return None;
        }
        let binding = self.cloud.bindings.get(&doc.path)?;
        binding.record.cloud_doc_id.as_ref()?;
        let remote = self.cloud.remote(&doc.path)?;
        if remote.version <= binding.record.cloud_version {
            return None;
        }
        let disk_matches = binding.record.content_hash.as_deref() == Some(markie_cloud::sync::hash_content(saved).as_str());
        Some((doc.path.clone(), strip_kind(self.dirty, binding.record.state, disk_matches)))
    }

    pub(super) fn render_update_strip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (path, kind) = self.update_waiting()?;
        let t = self.tokens(cx);
        let mine = self.cloud.update.path.as_deref() == Some(path.as_path());
        let busy = mine && self.cloud.update.busy;
        let error = if mine { self.cloud.update.error.clone() } else { None };
        let fg = t.foreground;
        Some(
            div()
                .id("update-strip")
                .flex_none()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .py(px(6.))
                .bg(t.surface)
                .shadow(vec![inset(t.border, -1.)])
                .child(div().text_size(px(12.)).line_height(px(12.)).child("↓"))
                .child(
                    div()
                        .min_w_0()
                        .text_size(px(11.))
                        .text_color(if error.is_some() { t.red } else { t.muted })
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(error.unwrap_or_else(|| strip_line(kind).to_string())),
                )
                .child(
                    div()
                        .id("update-strip-action")
                        .ml_auto()
                        .flex_none()
                        .rounded(px(4.))
                        .border_1()
                        .border_color(t.border)
                        .px(px(8.))
                        .py(px(2.))
                        .text_size(px(11.))
                        .text_color(t.muted)
                        .when(busy, |el| el.opacity(0.5))
                        .when(!busy, |el| el.cursor_pointer().hover(move |s| s.text_color(fg)))
                        .child(strip_button(kind, busy))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if busy {
                                return;
                            }
                            match kind {
                                StripKind::Clean => this.pull_update(cx),
                                StripKind::Dirty => this.show_cloud_conflict(window, cx),
                            }
                        })),
                )
                .into_any_element(),
        )
    }

    /// `handlePullUpdate`: the clean case, finished in one click.
    fn pull_update(&mut self, cx: &mut Context<Self>) {
        let Some((path, _)) = self.update_waiting() else { return };
        self.cloud.update = UpdateState { path: Some(path.clone()), busy: true, error: None };
        self.cloud_text(path.clone(), TextAction::Pull, None, cx);
        self.settle_if_refused(&path, TextAction::Pull, cx);
        cx.notify();
    }

    /// `cloud_text` returned before starting (no session for that server, a
    /// sync already running): say so instead of waiting forever.
    fn settle_if_refused(&mut self, path: &Path, action: TextAction, cx: &mut Context<Self>) {
        if !self.cloud.busy.contains(path) {
            let message = self.cloud.notice.clone().unwrap_or_else(|| "Couldn't finish that.".into());
            self.cloud_resolution_done(path, action, Some(message), None, cx);
        }
    }

    /// A pull or keep-both finished (`cloud_text`): settle the strip and the
    /// dialog the way page.tsx and conflict-dialog.tsx do.
    pub(super) fn cloud_resolution_done(&mut self, path: &Path, action: TextAction, error: Option<String>, window: Option<&mut Window>, cx: &mut Context<Self>) {
        // "Pull and overwrite" applies to the one pull it was chosen for.
        self.cloud.overwrite_buffer.remove(path);
        if self.cloud.update.path.as_deref() == Some(path) {
            self.cloud.update.busy = false;
            if action == TextAction::Pull {
                self.cloud.update.error = error.clone();
            } else if error.is_none() {
                self.cloud.update.error = None;
            }
        }
        if let Overlay::CloudConflict(state) = &mut self.dialogs.open
            && state.path == path
            && state.busy
        {
            match error {
                Some(e) => {
                    state.busy = false;
                    state.stage = ConflictStage::Error(e);
                }
                None => {
                    self.dialogs.open = Overlay::None;
                    if let Some(window) = window {
                        self.focus_handle.focus(window, cx);
                    }
                }
            }
        }
        cx.notify();
    }

    /// Open `ConflictDialog` for the open document and compare it with the
    /// server's copy once.
    pub(super) fn show_cloud_conflict(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
        let local = self.current_text(cx);
        let state = ConflictState { path: path.clone(), name: name(&path), stage: ConflictStage::Loading, busy: false };
        self.show_dialog(Overlay::CloudConflict(state), window, cx);
        let Some(binding) = self.cloud.bindings.get(&path).cloned() else {
            self.set_conflict_stage(&path, ConflictStage::Error("Syncing isn't available here.".into()), cx);
            return;
        };
        let Some(scope) = self.cloud.scope(binding.origin()).filter(|s| s.matches(&binding)) else {
            self.set_conflict_stage(&path, ConflictStage::Error("Syncing isn't available here.".into()), cx);
            return;
        };
        let target = name(&path);
        let primary = scope.origin() == markie_cloud::DEFAULT_SERVER;
        let request = scope.clone();
        let record = binding.record.clone();
        cx.spawn(async move |this, cx| {
            let cloud = network(async move { SyncEngine::new(&request.client, primary).remote_content(&record, &target).await }).await;
            let _ = this.update(cx, |this, cx| {
                let stage = match cloud {
                    Ok(Ok(doc)) => {
                        let d = line_diff(&local, &doc.content);
                        ConflictStage::Ready { summary: describe_diff(d), identical: d.added == 0 && d.removed == 0 }
                    }
                    Ok(Err(e)) if !e.is_empty() => ConflictStage::Error(e),
                    Ok(Err(_)) => ConflictStage::Error("Couldn't read the server's copy.".into()),
                    Err(_) => ConflictStage::Error("Couldn't reach the server.".into()),
                };
                this.set_conflict_stage(&path, stage, cx);
            });
        })
        .detach();
    }

    fn set_conflict_stage(&mut self, path: &Path, stage: ConflictStage, cx: &mut Context<Self>) {
        if let Overlay::CloudConflict(state) = &mut self.dialogs.open
            && state.path == path
        {
            state.stage = stage;
            cx.notify();
        }
    }

    /// Keep both or "Pull and overwrite" (`act` in conflict-dialog.tsx).
    pub(super) fn cloud_conflict_act(&mut self, keep_both: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Overlay::CloudConflict(state) = &mut self.dialogs.open else { return };
        if state.busy || !matches!(state.stage, ConflictStage::Ready { .. }) {
            return;
        }
        let path = state.path.clone();
        state.busy = true;
        if self.cloud.update.path.as_deref() != Some(path.as_path()) {
            self.cloud.update = UpdateState { path: Some(path.clone()), busy: false, error: None };
        }
        if keep_both {
            // docKeepBoth takes the buffer as the copy; the buffer goes to
            // the file first (without a push), so the copy is exactly it.
            if !self.persist_cloud_choice(&path, window, cx) {
                self.cloud_resolution_done(&path, TextAction::KeepBoth, Some("Couldn't finish that.".into()), Some(window), cx);
                return;
            }
            self.cloud_text(path.clone(), TextAction::KeepBoth, None, cx);
            self.settle_if_refused(&path, TextAction::KeepBoth, cx);
        } else {
            // "Pull and overwrite": the person was told what it replaces,
            // unsaved typing included.
            self.cloud.overwrite_buffer.insert(path.clone());
            self.cloud_text(path.clone(), TextAction::TakeCloud, None, cx);
            self.settle_if_refused(&path, TextAction::TakeCloud, cx);
        }
        cx.notify();
    }

    pub(super) fn render_cloud_conflict(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::CloudConflict(state) = &self.dialogs.open else { return div().into_any_element() };
        let (name, stage, busy) = (state.name.clone(), state.stage.clone(), state.busy);
        let (fg, hover) = (t.foreground, t.hover_soft());
        let button = |id: &'static str, primary: bool| {
            div()
                .id(id)
                .text_size(px(12.5))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(6.))
                .text_color(if primary { fg } else { t.muted })
                .when(primary, |el| el.bg(t.accent))
                .when(busy, |el| el.opacity(0.6))
                .when(!busy, |el| el.cursor_pointer().hover(move |s| s.text_color(fg).bg(hover)))
        };
        let body: AnyElement = match stage {
            ConflictStage::Loading => div().mt(px(8.)).text_size(px(12.5)).line_height(relative(1.625)).text_color(t.muted).child("Comparing with the server…").into_any_element(),
            ConflictStage::Error(message) => div().mt(px(8.)).text_size(px(12.5)).line_height(relative(1.625)).text_color(t.red).child(message).into_any_element(),
            ConflictStage::Ready { summary, identical } => div()
                .child(div().mt(px(8.)).text_size(px(12.5)).line_height(relative(1.625)).text_color(t.foreground).child(summary))
                .child(div().mt(px(12.)).text_size(px(12.)).line_height(relative(1.625)).text_color(t.muted).child(if identical {
                    "Nothing of yours would be lost.".to_string()
                } else {
                    format!("Keep both saves your version alongside the original and then pulls the server's copy into {name}.")
                }))
                .child(
                    div()
                        .mt(px(16.))
                        .flex()
                        .flex_wrap()
                        .justify_end()
                        .gap(px(8.))
                        .child(button("cloud-conflict-cancel", false).child("Cancel").on_click(cx.listener(move |this, _, window, cx| {
                            if !busy {
                                this.close_dialog(window, cx);
                            }
                        })))
                        .child(button("cloud-conflict-overwrite", false).child("Pull and overwrite").on_click(cx.listener(|this, _, window, cx| this.cloud_conflict_act(false, window, cx))))
                        .child(button("cloud-conflict-keep", true).child(if busy { "Working…" } else { "Keep both" }).on_click(cx.listener(|this, _, window, cx| this.cloud_conflict_act(true, window, cx)))),
                )
                .into_any_element(),
        };
        self.panel(t, 12.)
            .w(px(460.))
            .max_w(relative(0.92))
            .p(px(20.))
            .child(
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(12.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(format!("Both copies of {name} changed")))
                    .child(self.close_button("cloud-conflict-close", t, cx)),
            )
            .child(body)
            .into_any_element()
    }

    /// "Stop syncing to cloud…" in a Library row's menu.
    pub(super) fn render_stop_sync(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::StopSync { path } = &self.dialogs.open else { return div().into_any_element() };
        let path = path.clone();
        let (fg, hover) = (t.foreground, t.hover_soft());
        let option = |id: &'static str, title: &'static str, detail: &'static str, danger: bool| {
            div()
                .id(id)
                .w_full()
                .rounded(px(6.))
                .px(px(12.))
                .py(px(8.))
                .text_size(px(12.))
                .cursor_pointer()
                .when(!danger, |el| el.bg(t.accent).text_color(fg))
                .when(danger, |el| el.border_1().border_color(t.red).text_color(t.red).hover(move |s| s.bg(hover)))
                .child(div().child(title))
                .child(div().text_size(px(11.)).text_color(t.muted).child(detail))
        };
        let (pause_path, delete_path) = (path.clone(), path);
        self.panel(t, 12.)
            .w(px(380.))
            .p(px(16.))
            .bg(t.surface2)
            .border_color(t.border)
            .shadow(vec![BoxShadow { color: fade(super::dialog_chrome::black(), 0.25), offset: point(px(0.), px(25.)), blur_radius: px(50.), spread_radius: px(-12.), inset: false }])
            .child(div().text_size(px(13.)).text_color(t.foreground).mb(px(4.)).child("Stop syncing this document to the cloud?"))
            .child(div().text_size(px(12.)).text_color(t.muted).mb(px(16.)).child("The file on this device stays as it is. Choose what happens to the copy in your cloud."))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(option("stop-sync-pause", "Pause syncing, keep the cloud copy", "People you shared it with can still open the last synced version.", false).on_click(cx.listener(move |this, _, window, cx| {
                        this.close_dialog(window, cx);
                        this.cloud_text(pause_path.clone(), TextAction::Pause, None, cx);
                    })))
                    .child(option("stop-sync-delete", "Remove from cloud", "Deletes the cloud copy. Everyone you shared it with loses access.", true).on_click(cx.listener(move |this, _, window, cx| {
                        this.close_dialog(window, cx);
                        this.cloud_text(delete_path.clone(), TextAction::Delete, None, cx);
                    })))
                    .child(
                        div()
                            .id("stop-sync-cancel")
                            .w_full()
                            .flex()
                            .justify_center()
                            .py(px(6.))
                            .text_size(px(12.))
                            .text_color(t.muted)
                            .cursor_pointer()
                            .hover(move |s| s.text_color(fg))
                            .child("Cancel")
                            .on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx))),
                    ),
            )
            .into_any_element()
    }
}

/// Where a document shared with this account opens (`downloadsUniquePath`):
/// the Downloads folder, or the scratch data folder's own in a test run.
pub(super) fn downloads_dir() -> PathBuf {
    if std::env::var_os("MARKIE_RS_DATA_DIR").is_some() {
        markie_core::paths::data_dir().join("Downloads")
    } else {
        markie_core::paths::home_dir().join("Downloads")
    }
}

/// `downloadsUniquePath`: a plain document name, "Shared document" when the
/// server sent none, then "name (2).md" when the first is taken.
pub(super) fn shared_download_path(dir: &Path, name: &str, occupied: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let cleaned: String = name.replace(['\\', '/', ':'], "_");
    let base = if cleaned.trim().is_empty() { "Shared document.md".to_string() } else { markie_cloud::sync::landing_name(cleaned.trim()) };
    markie_cloud::sync::free_path(dir, &base, occupied)
}

impl Workspace {
    /// "Download…" on a row whose file is gone (`docPull`): ask where, then
    /// write the cloud copy there and bind it.
    pub(super) fn download_cloud_copy(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Some((scope, id)) = self.cloud.binding_key(&path).and_then(|key| self.cloud.bound_scope(&key)) else { return };
        let suggested = name(&path);
        let dir = path.parent().filter(|d| d.is_dir()).map(PathBuf::from).unwrap_or_else(downloads_dir);
        self.save_cloud_copy_as(scope, id, suggested, dir, window, cx);
    }

    /// The save dialog, then the pull into the chosen file.
    pub(super) fn save_cloud_copy_as(&mut self, scope: super::cloud::Scope, id: String, suggested: String, dir: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_new_path(&dir, Some(&suggested));
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(target))) = rx.await else { return };
            if !super::library_rows::classic(&name(&target)) && markie_core::formats::classify(&name(&target)) != markie_core::formats::FormatKind::Darkmown {
                let _ = this.update_in(cx, |_, window, cx| window.push_notification("Unsupported file type", cx));
                return;
            }
            let request = scope.clone();
            let fallback = suggested.clone();
            let pull = network(async move { request.engine().pull(&id, &fallback).await }).await.and_then(|r| r);
            let _ = this.update_in(cx, |this, window, cx| {
                if !scope.active() || this.cloud.scope(scope.origin()).is_none_or(|s| s.user != scope.user) {
                    return;
                }
                let done = pull.and_then(|(doc, mut record)| {
                    std::fs::write(&target, doc.content.as_bytes()).map_err(|e| e.to_string())?;
                    record.share_role = doc.role;
                    record.share_role_user = Some(scope.user.clone());
                    this.store_binding(&target, super::cloud::Binding::new(&scope.user, record))?;
                    if let Some(registry) = &this.registry {
                        let _ = registry.track_opened(&target);
                    }
                    Ok(())
                });
                match done {
                    Ok(()) => this.refresh_lists(),
                    Err(e) => window.push_notification(e, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::{LineDiff, MAX_DIFF_LINES, StripKind, describe_diff, line_diff, shared_download_path, strip_button, strip_kind, strip_line};
    use markie_cloud::sync::SyncState;
    use std::path::{Path, PathBuf};

    #[test]
    fn shared_documents_open_under_a_free_name_in_downloads() {
        let dir = Path::new("/d");
        let taken = [PathBuf::from("/d/Plan.md")];
        let occupied = |p: &Path| taken.iter().any(|t| t == p);
        assert_eq!(shared_download_path(dir, "Plan.md", occupied).unwrap(), PathBuf::from("/d/Plan (2).md"));
        assert_eq!(shared_download_path(dir, "", |_| false).unwrap(), PathBuf::from("/d/Shared document.md"));
        assert_eq!(shared_download_path(dir, "a/b:c.md", |_| false).unwrap(), PathBuf::from("/d/a_b_c.md"));
    }

    #[test]
    fn line_counts_match_line_diff_ts() {
        assert_eq!(line_diff("", ""), LineDiff { added: 0, removed: 0, same: 0 });
        // A trailing newline is not a phantom line.
        assert_eq!(line_diff("a\nb\n", "a\nb"), LineDiff { added: 0, removed: 0, same: 2 });
        assert_eq!(line_diff("a\nb\nc\n", "a\nB\nc\nd\n"), LineDiff { added: 2, removed: 1, same: 2 });
        // Order matters under LCS: a moved line is a removal and an addition.
        assert_eq!(line_diff("a\nb", "b\na"), LineDiff { added: 1, removed: 1, same: 1 });
    }

    #[test]
    fn huge_documents_fall_back_to_counting() {
        let a: String = (0..=MAX_DIFF_LINES).map(|i| format!("{i}\n")).collect();
        let b: String = (0..=MAX_DIFF_LINES).rev().map(|i| format!("{i}\n")).collect();
        // Counting ignores order, so a reversed file reads as unchanged.
        assert_eq!(line_diff(&a, &b), LineDiff { added: 0, removed: 0, same: MAX_DIFF_LINES + 1 });
    }

    #[test]
    fn the_sentence_says_what_you_lose_first() {
        let d = |added, removed| LineDiff { added, removed, same: 0 };
        assert_eq!(describe_diff(d(0, 0)), "The two copies are identical.");
        assert_eq!(describe_diff(d(1, 0)), "Pulling brings in 1 line from the server.");
        assert_eq!(describe_diff(d(0, 8)), "Pulling replaces 8 lines of yours.");
        assert_eq!(describe_diff(d(3, 1)), "Pulling replaces 1 line of yours and brings in 3 lines from the server.");
    }

    #[test]
    fn the_strip_offers_one_click_only_when_nothing_is_at_risk() {
        assert_eq!(strip_kind(false, SyncState::Synced, true), StripKind::Clean);
        assert_eq!(strip_kind(true, SyncState::Synced, true), StripKind::Dirty);
        assert_eq!(strip_kind(false, SyncState::Conflict, true), StripKind::Dirty);
        assert_eq!(strip_kind(false, SyncState::Unpushed, true), StripKind::Dirty);
        assert_eq!(strip_kind(false, SyncState::Synced, false), StripKind::Dirty);
        assert_eq!(strip_line(StripKind::Clean), "Updated on the server.");
        assert_eq!(strip_line(StripKind::Dirty), "Updated on the server, and this copy has changes of its own.");
        assert_eq!(strip_button(StripKind::Clean, false), "Update");
        assert_eq!(strip_button(StripKind::Dirty, false), "Review changes…");
        assert_eq!(strip_button(StripKind::Dirty, true), "Updating…");
    }
}
