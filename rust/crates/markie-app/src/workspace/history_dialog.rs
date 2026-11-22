//! Version history, drawn like Electron's `src/components/history-dialog.tsx`
//! (the dialog the stable 0.9.7 build shows): a 520pt panel titled
//! "History: name", one row per version with its time, author, line counts
//! and Restore.
//!
//! Markie RS adds the diff view Electron keeps for its nightly history mode:
//! click a row and it opens underneath, showing what that save changed
//! against the version before it, in the same green and red Electron's
//! `version-history.css` uses.
//!
//! Restoring never writes, as in Electron: the version is loaded into the
//! editor as unsaved, so looking through history cannot cost anything.

use std::collections::HashMap;
use std::time::Instant;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::history::Version;

use super::dialog_chrome::{self as chrome, Tokens, fade, shadow};
use super::overlay::Overlay;
use super::{DocKind, OpenDoc, Workspace};
use crate::actions::ShowHistory;

const INITIAL_ROWS: usize = 30;
/// Above this many cells the line diff is skipped, like Electron's
/// "too long to highlight changes".
const DIFF_CELL_LIMIT: usize = 4_000_000;

pub(super) struct HistoryState {
    name: String,
    /// Newest first.
    entries: Vec<Version>,
    contents: HashMap<String, Option<String>>,
    shown: usize,
    open_row: Option<String>,
}

/// One line of a diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Line {
    Same(String),
    Added(String),
    Removed(String),
}

/// A line diff from `old` to `new`: common ends trimmed, then a longest
/// common subsequence on the middle. `None` when the middle is too large.
pub(crate) fn line_diff(old: &str, new: &str) -> Option<Vec<Line>> {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let (am, bm) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    if am.len().saturating_mul(bm.len()) > DIFF_CELL_LIMIT {
        return None;
    }
    // lcs[i][j] = LCS length of am[i..] and bm[j..].
    let (n, m) = (am.len(), bm.len());
    let mut lcs = vec![0u32; (n + 1) * (m + 1)];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * (m + 1) + j] = if am[i] == bm[j] {
                lcs[(i + 1) * (m + 1) + j + 1] + 1
            } else {
                lcs[(i + 1) * (m + 1) + j].max(lcs[i * (m + 1) + j + 1])
            };
        }
    }
    let mut out: Vec<Line> = a[..pre].iter().map(|l| Line::Same(l.to_string())).collect();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && am[i] == bm[j] {
            out.push(Line::Same(am[i].to_string()));
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
            out.push(Line::Removed(am[i].to_string()));
            i += 1;
        } else {
            out.push(Line::Added(bm[j].to_string()));
            j += 1;
        }
    }
    out.extend(a[a.len() - suf..].iter().map(|l| Line::Same(l.to_string())));
    Some(out)
}

/// `+N  -M`, or nothing when the texts match: the row's line counts.
pub(crate) fn diff_counts(old: &str, new: &str) -> String {
    let Some(lines) = line_diff(old, new) else { return String::new() };
    let added = lines.iter().filter(|l| matches!(l, Line::Added(_))).count();
    let removed = lines.iter().filter(|l| matches!(l, Line::Removed(_))).count();
    if added == 0 && removed == 0 { String::new() } else { format!("+{added}  -{removed}") }
}

/// Who wrote a version, as Electron names them.
fn author_label(v: &Version) -> String {
    match v.meta.author.as_str() {
        "user" => "You".into(),
        "external" => "External edit".into(),
        "agent" => agent_name(v.meta.agent.as_deref()),
        "" | "unknown" => "Unknown".into(),
        other => other.into(),
    }
}

/// `agentDisplayName` from `src/lib/version-history.ts`.
fn agent_name(raw: Option<&str>) -> String {
    let name = raw.unwrap_or("").trim();
    if name.is_empty() || name == "an agent" {
        return "An agent".into();
    }
    match name.to_lowercase().as_str() {
        "claude-code" => "Claude Code",
        "claude-ai" | "claude desktop" => "Claude",
        "codex-mcp-client" | "codex" => "Codex",
        "cursor-vscode" | "cursor" => "Cursor",
        "windsurf" => "Windsurf",
        "visual studio code" => "VS Code",
        "zed" => "Zed",
        "gemini-cli-mcp-client" => "Gemini CLI",
        "opencode" => "OpenCode",
        "t3code" | "t3-code" => "T3 Code",
        _ => return name.to_string(),
    }
    .into()
}

/// `new Date(iso).toLocaleString()` in en-US: `11/21/2026, 3:04:05 PM`.
fn when(v: &Version) -> String {
    v.ms.and_then(chrono::DateTime::from_timestamp_millis)
        .map(|d| d.with_timezone(&chrono::Local).format("%-m/%-d/%Y, %-I:%M:%S %p").to_string())
        .unwrap_or_else(|| v.stamp.clone())
}

impl HistoryState {
    fn content(&mut self, ws_read: impl Fn(&str) -> Option<String>, stamp: &str) -> Option<String> {
        self.contents.entry(stamp.to_string()).or_insert_with(|| ws_read(stamp)).clone()
    }
}

impl Workspace {
    pub(super) fn on_show_history(&mut self, _: &ShowHistory, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.dialogs.open, Overlay::History(_)) {
            self.close_dialog(window, cx);
            return;
        }
        let Some(doc) = &self.doc else { return };
        // Office documents keep recovery revisions (office.rs), newest first.
        let entries = if matches!(doc.kind, DocKind::Office(_)) {
            self.office_versions(&doc.path)
        } else {
            let mut entries = self.history.list(&doc.path);
            entries.reverse();
            entries
        };
        let name = doc.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut state = HistoryState { name, entries, contents: HashMap::new(), shown: INITIAL_ROWS, open_row: None };
        self.fill_history(&mut state);
        self.show_dialog(Overlay::History(state), window, cx);
    }

    /// Read the versions the visible rows need: each shown row and the one
    /// after it, which its line counts compare against.
    fn fill_history(&self, state: &mut HistoryState) {
        let Some(doc) = self.doc.as_ref() else { return };
        let (path, format, office) = (doc.path.clone(), doc.format, matches!(doc.kind, DocKind::Office(_)));
        let stamps: Vec<String> = state.entries.iter().take(state.shown + 1).map(|v| v.stamp.clone()).collect();
        for stamp in stamps {
            if office {
                state.content(|s| self.office_version_text(&path, format, s), &stamp);
            } else {
                state.content(|s| self.history.read(&path, s), &stamp);
            }
        }
    }

    fn history_toggle_row(&mut self, stamp: String, cx: &mut Context<Self>) {
        if let Overlay::History(h) = &mut self.dialogs.open {
            h.open_row = if h.open_row.as_deref() == Some(stamp.as_str()) { None } else { Some(stamp) };
        }
        cx.notify();
    }

    fn history_show_older(&mut self, cx: &mut Context<Self>) {
        let mut open = std::mem::replace(&mut self.dialogs.open, Overlay::None);
        if let Overlay::History(h) = &mut open {
            h.shown += 50;
            self.fill_history(h);
        }
        self.dialogs.open = open;
        cx.notify();
    }

    /// Load a version into the editor as unsaved, like Electron's restore.
    fn history_restore(&mut self, stamp: String, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.close_dialog(window, cx);
        if matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(_))) {
            self.restore_office_version(&stamp, window, cx);
            return;
        }
        let Some(OpenDoc { kind: DocKind::Text { .. }, .. }) = &self.doc else { return };
        self.pending_editor_text = Some(text.clone());
        if self.rich_active() {
            self.load_rich(&text, cx);
        }
        self.update_stats(&text);
        self.dirty = true;
        if self.disk_conflict.is_none() {
            self.autosave.note_change(Instant::now());
            self.schedule_autosave(cx);
        }
        cx.notify();
    }

    pub(super) fn render_history_dialog(&mut self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Overlay::History(h) = &self.dialogs.open else { return div().into_any_element() };
        let hover = t.hover_soft();
        let fg = t.foreground;
        let open_row = h.open_row.clone();
        let rows: Vec<_> = h
            .entries
            .iter()
            .take(h.shown)
            .enumerate()
            .map(|(i, v)| {
                let mine = h.contents.get(&v.stamp).cloned().flatten();
                let older = match h.entries.get(i + 1) {
                    Some(o) => h.contents.get(&o.stamp).cloned().flatten(),
                    None => Some(String::new()),
                };
                (v.clone(), mine, older)
            })
            .collect();
        let more = h.shown < h.entries.len();
        let empty = h.entries.is_empty();
        let title = format!("History: {}", h.name);

        self.panel(t, 12.)
            .w(px(520.))
            .max_h(window.viewport_size().height * 0.7)
            .flex()
            .flex_col()
            .bg(t.surface2)
            .border_color(t.border)
            .shadow(vec![shadow(fade(chrome::black(), 0.25), 0., 25., 50.)])
            .child(
                div()
                    .px(px(16.))
                    .py(px(12.))
                    .border_b_1()
                    .border_color(t.border)
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(px(13.)).child(title))
                    .child(
                        div()
                            .id("history-close")
                            .cursor_pointer()
                            .child(chrome::stroke_icon(chrome::PATH_CLOSE, t.muted, 14., 2.))
                            .on_click(cx.listener(|this, _, window, cx| this.close_dialog(window, cx))),
                    ),
            )
            .child(
                div()
                    .id("history-rows")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(8.))
                    .when(empty, |el| {
                        el.child(
                            div()
                                .p(px(16.))
                                .text_size(px(12.))
                                .text_color(t.muted)
                                .child("No versions yet. Markie records one every time this document is saved."),
                        )
                    })
                    .children(rows.into_iter().map(|(v, mine, older)| {
                        let counts = match (&mine, &older) {
                            (Some(m), Some(o)) => diff_counts(o, m),
                            _ => String::new(),
                        };
                        let is_open = open_row.as_deref() == Some(v.stamp.as_str());
                        let stamp = v.stamp.clone();
                        let restore_text = mine.clone();
                        let restore_stamp = v.stamp.clone();
                        let can_restore = mine.is_some();
                        div()
                            .child(
                                div()
                                    .id(SharedString::from(format!("hv-{}", v.stamp)))
                                    .rounded(px(6.))
                                    .px(px(8.))
                                    .py(px(6.))
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .cursor_pointer()
                                    .when(is_open, |el| el.bg(hover))
                                    .hover(move |el| el.bg(hover))
                                    .on_click(cx.listener(move |this, _, _, cx| this.history_toggle_row(stamp.clone(), cx)))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .child(div().text_size(px(12.5)).child(v.meta.name.clone().unwrap_or_else(|| when(&v))))
                                            .child(
                                                div()
                                                    .flex()
                                                    .text_size(px(10.5))
                                                    .text_color(t.muted)
                                                    .child(author_label(&v))
                                                    .when(!counts.is_empty(), |el| el.child(div().ml(px(8.)).child(counts))),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .id(SharedString::from(format!("hv-restore-{}", v.stamp)))
                                            .flex_none()
                                            .h(px(24.))
                                            .px(px(8.))
                                            .flex()
                                            .items_center()
                                            .rounded(px(6.))
                                            .border_1()
                                            .border_color(t.border)
                                            .text_size(px(11.))
                                            .when_else(
                                                can_restore,
                                                |el| el.cursor_pointer().hover(move |el| el.bg(hover).text_color(fg)),
                                                |el| el.opacity(0.4),
                                            )
                                            .child("Restore")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                cx.stop_propagation();
                                                if let Some(text) = restore_text.clone() {
                                                    this.history_restore(restore_stamp.clone(), text, window, cx);
                                                }
                                            })),
                                    ),
                            )
                            .when(is_open, |el| el.child(render_diff(older.as_deref(), mine.as_deref(), t)))
                    }))
                    .when(more, |el| {
                        el.child(
                            div()
                                .id("history-older")
                                .w_full()
                                .py(px(6.))
                                .flex()
                                .justify_center()
                                .text_size(px(11.))
                                .text_color(t.muted)
                                .cursor_pointer()
                                .hover(move |el| el.text_color(fg))
                                .child("Show older")
                                .on_click(cx.listener(|this, _, _, cx| this.history_show_older(cx))),
                        )
                    }),
            )
            .into_any_element()
    }
}

/// What one save changed: the diff view under an opened row.
fn render_diff(older: Option<&str>, mine: Option<&str>, t: &Tokens) -> AnyElement {
    let (ins_bg, ins_edge, del_fg, del_bg) = if t.dark {
        (fade(chrome::hex("#4ade80"), 0.24), chrome::hex("#4ade80"), chrome::hex("#fca5a5"), fade(chrome::hex("#f87171"), 0.14))
    } else {
        (fade(chrome::hex("#16a34a"), 0.18), chrome::hex("#16a34a"), chrome::hex("#b91c1c"), fade(chrome::hex("#dc2626"), 0.09))
    };
    let shell = div()
        .mx(px(8.))
        .mt(px(2.))
        .mb(px(8.))
        .rounded(px(8.))
        .border_1()
        .border_color(fade(t.border, 0.85))
        .bg(t.background);
    let (Some(old), Some(new)) = (older, mine) else {
        return shell
            .p(px(12.))
            .text_size(px(12.))
            .text_color(t.muted)
            .child("This version could not be read.")
            .into_any_element();
    };
    let Some(lines) = line_diff(old, new) else {
        return shell
            .p(px(12.))
            .text_size(px(12.))
            .text_color(t.muted)
            .child("This document is too long to highlight changes.")
            .into_any_element();
    };
    // Changed lines with two lines of context, gaps folded.
    let changed: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| !matches!(l, Line::Same(_))).map(|(i, _)| i).collect();
    let keep = |i: usize| changed.iter().any(|&c| c.abs_diff(i) <= 2);
    let mut body: Vec<AnyElement> = Vec::new();
    let mut skipped = false;
    for (i, line) in lines.iter().enumerate() {
        if !keep(i) {
            skipped = true;
            continue;
        }
        if skipped && !body.is_empty() {
            body.push(div().px(px(10.)).text_color(t.muted).child("⋯").into_any_element());
        }
        skipped = false;
        let row = div().px(px(10.)).border_l_2().min_h(px(19.)).whitespace_normal();
        body.push(
            match line {
                Line::Same(s) => row.border_color(transparent_black()).text_color(t.muted).child(s.clone()),
                Line::Added(s) => row.border_color(ins_edge).bg(ins_bg).text_color(t.foreground).child(s.clone()),
                Line::Removed(s) => row.border_color(del_fg).bg(del_bg).text_color(del_fg).line_through().child(s.clone()),
            }
            .into_any_element(),
        );
    }
    let caption = if changed.is_empty() { "Same text as the version before it." } else { "Changes since the version before it." };
    shell
        .child(
            div()
                .px(px(10.))
                .py(px(6.))
                .border_b_1()
                .border_color(fade(t.border, 0.85))
                .text_size(px(11.))
                .text_color(t.muted)
                .child(caption),
        )
        .child(
            div()
                .id("history-diff")
                .max_h(px(260.))
                .overflow_y_scroll()
                .py(px(6.))
                .font_family("Menlo")
                .text_size(px(12.))
                .line_height(px(19.))
                .children(body),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{Line, diff_counts, line_diff};

    #[test]
    fn diffs_lines() {
        let d = line_diff("a\nb\nc\n", "a\nB\nc\nd\n").unwrap();
        assert_eq!(
            d,
            vec![
                Line::Same("a".into()),
                Line::Removed("b".into()),
                Line::Added("B".into()),
                Line::Same("c".into()),
                Line::Added("d".into()),
            ]
        );
        assert_eq!(diff_counts("a\nb", "a\nb"), "");
        assert_eq!(diff_counts("", "one\ntwo"), "+2  -0");
        assert_eq!(diff_counts("x\ny\nz", "x\nz"), "+0  -1");
    }
}
