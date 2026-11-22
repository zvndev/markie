//! A Library row's sync state icon and its ⋯ menu, as `library.tsx` draws
//! them (`SYNC_STATUS`, `rowMenuEntries`, `FileMenu`).
//!
//! The state comes from the cloud workspace (`cloud.rs`) as it already
//! labels a row. Sync actions open the document and hand it to the cloud
//! work's own sheet (`show_text_sync`, `open_share`), which knows how to run
//! them; Electron runs some of them in place from the menu.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::chrome::menu_panel;
use super::overlay::Overlay;
use super::Workspace;
use crate::themes::{self, Palette};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SyncStatus {
    LocalOnly,
    Synced,
    Unpushed,
    Paused,
    Conflict,
    Behind,
    Shared,
}

const CLOUD: &str = r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/>"#;

fn svg_bytes(body: &str, size: u32) -> Vec<u8> {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{body}</svg>"#
    )
    .into_bytes()
}

impl SyncStatus {
    /// The cloud workspace's row label, as `cloud.rs` `badge` names it.
    pub(super) fn from_badge(badge: Option<&str>, shared: bool) -> Self {
        if shared {
            return Self::Shared;
        }
        match badge {
            Some("Synced") => Self::Synced,
            Some("Not backed up") => Self::Unpushed,
            Some("Paused") => Self::Paused,
            Some("Conflict") => Self::Conflict,
            Some("Update available") => Self::Behind,
            _ => Self::LocalOnly,
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::LocalOnly => "On this device only",
            Self::Synced => "Synced",
            Self::Unpushed => "Not backed up",
            Self::Paused => "Sync paused",
            Self::Conflict => "Conflict: review changes",
            Self::Behind => "Update available",
            Self::Shared => "Shared",
        }
    }

    fn body(self) -> String {
        match self {
            Self::LocalOnly => r#"<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2.5 19h19"/>"#.into(),
            Self::Synced => format!(r#"{CLOUD}<path d="m9.5 13 2 2 3.5-3.5"/>"#),
            Self::Unpushed => format!(r#"{CLOUD}<path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2"/>"#),
            Self::Paused => format!(r#"{CLOUD}<path d="M10.5 11v4M13.5 11v4"/>"#),
            Self::Conflict => r#"<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.2"/>"#.into(),
            Self::Behind => format!(r#"{CLOUD}<path d="M12 10v5M9.8 12.8 12 15l2.2-2.2"/>"#),
            Self::Shared => PEOPLE.into(),
        }
    }

    fn color(self, p: &Palette) -> Hsla {
        match self {
            Self::LocalOnly => p.muted.opacity(0.7),
            Self::Synced => p.green,
            Self::Unpushed | Self::Paused => p.yellow,
            Self::Conflict => p.red,
            Self::Behind => p.blue,
            Self::Shared => themes::hex("#d8b4fe"),
        }
    }
}

const PEOPLE: &str = r#"<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="10" r="2.3"/><path d="M16 14.6a4.5 4.5 0 0 1 5 4.4"/>"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Tone {
    Default,
    Accent,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RowAction {
    CopyPath,
    RetryBackup,
    SyncOn,
    Resume,
    Pull,
    Review,
    ManageSharing,
    SyncOff,
    Delete,
}

pub(super) struct Entry {
    pub action: RowAction,
    pub label: &'static str,
    pub icon: &'static str,
    pub tone: Tone,
    pub separated: bool,
}

/// Markdown and the plain-text family, which the classic cloud sync handles.
pub(super) fn classic(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".markdown", ".mdx", ".txt", ".text", ".log", ".csv"].iter().any(|e| lower.ends_with(e))
}

/// `rowMenuEntries`: copy, then the sync action this state calls for, then
/// sharing, then deletion on its own at the bottom.
pub(super) fn row_entries(status: SyncStatus, signed_in: bool, classic: bool) -> Vec<Entry> {
    let e = |action, label, icon, tone| Entry { action, label, icon, tone, separated: false };
    let mut entries = vec![e(RowAction::CopyPath, "Copy path", ICON_PATH, Tone::Default)];
    let mut sync = Vec::new();
    let in_cloud = !matches!(status, SyncStatus::LocalOnly);
    if signed_in {
        match status {
            SyncStatus::Unpushed => sync.push(e(RowAction::RetryBackup, "Retry backup", ICON_RETRY, Tone::Accent)),
            SyncStatus::LocalOnly if classic => sync.push(e(RowAction::SyncOn, "Sync to cloud", ICON_UPLOAD, Tone::Default)),
            SyncStatus::Paused if classic => sync.push(e(RowAction::Resume, "Resume sync", ICON_UPLOAD, Tone::Default)),
            SyncStatus::Behind => sync.push(e(RowAction::Pull, "Pull latest", ICON_DOWNLOAD, Tone::Accent)),
            SyncStatus::Conflict => sync.push(e(RowAction::Review, "Review changes…", ICON_REVIEW, Tone::Accent)),
            _ => {}
        }
        if in_cloud && status != SyncStatus::Shared {
            sync.push(e(RowAction::ManageSharing, "Manage sharing…", PEOPLE, Tone::Default));
        }
        if status == SyncStatus::Synced {
            sync.push(e(RowAction::SyncOff, "Stop syncing to cloud…", ICON_CLOUD_OFF, Tone::Default));
        }
    }
    if let Some(first) = sync.first_mut() {
        first.separated = true;
    }
    entries.extend(sync);
    entries.push(Entry { action: RowAction::Delete, label: "Delete file…", icon: ICON_TRASH, tone: Tone::Danger, separated: true });
    entries
}

const ICON_PATH: &str = r#"<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>"#;
const ICON_RETRY: &str = r#"<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>"#;
const ICON_UPLOAD: &str = r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2"/>"#;
const ICON_DOWNLOAD: &str = r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M12 10v5M9.8 12.8 12 15l2.2-2.2"/>"#;
const ICON_REVIEW: &str = r#"<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.2"/>"#;
const ICON_CLOUD_OFF: &str = r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M4 4l16 16"/>"#;
const ICON_TRASH: &str = r#"<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6 7l1 12.5h10L18 7"/><path d="M10 11v5M14 11v5"/>"#;

impl Workspace {
    pub(super) fn row_status(&self, path: &Path) -> SyncStatus {
        let shared = self.cloud.remote(path).is_some_and(|r| r.shared);
        SyncStatus::from_badge(self.cloud.badge(path), shared)
    }

    /// The icon after the type badge: what the sync state is, on hover too.
    pub(super) fn sync_status_icon(&self, path: &Path, p: &Palette) -> AnyElement {
        let status = self.row_status(path);
        let label = status.label();
        div()
            .id(SharedString::from(format!("sync-{}", path.display())))
            .size(px(16.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx))
            .child(svg().data(&svg_bytes(&status.body(), 13)).size(px(13.)).text_color(status.color(p)))
            .into_any_element()
    }

    pub(super) fn open_row_menu(&mut self, path: PathBuf, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.shell.row_menu = if self.shell.row_menu.as_ref().is_some_and(|(p, _)| *p == path) { None } else { Some((path, at)) };
        cx.notify();
    }

    fn run_row_action(&mut self, path: PathBuf, action: RowAction, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.row_menu = None;
        match action {
            RowAction::CopyPath => {
                cx.write_to_clipboard(ClipboardItem::new_string(path.to_string_lossy().into_owned()));
                window.push_notification("Path copied.", cx);
            }
            RowAction::Delete => self.show_dialog(Overlay::Trash { path }, window, cx),
            RowAction::Review => self.open_path(&path, window, cx),
            RowAction::ManageSharing => {
                self.open_path(&path, window, cx);
                self.open_share(window, cx);
            }
            RowAction::RetryBackup | RowAction::SyncOn | RowAction::Resume | RowAction::Pull | RowAction::SyncOff => {
                self.open_path(&path, window, cx);
                self.show_text_sync(window, cx);
            }
        }
        cx.notify();
    }

    /// `FileMenu` at the ⋯ button or the right-click point.
    pub(super) fn render_row_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (path, at) = self.shell.row_menu.clone()?;
        let p = themes::palette(cx);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let signed_in = super::account::signed_in_user(cx).is_some();
        let entries = row_entries(self.row_status(&path), signed_in, classic(&name));
        let hover = p.accent.opacity(0.85);
        let items = entries.into_iter().enumerate().map(|(i, entry)| {
            let color = match entry.tone {
                Tone::Default => (p.foreground, p.muted),
                Tone::Accent => (p.blue, p.blue),
                Tone::Danger => (p.red, p.red),
            };
            let path = path.clone();
            let action = entry.action;
            div()
                .when(entry.separated, |d| d.child(div().h(px(1.)).mx(px(6.)).my(px(4.)).bg(p.border)))
                .child(
                    div()
                        .id(("row-menu-item", i))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .w_full()
                        .rounded(px(6.))
                        .px(px(8.))
                        .py(px(5.))
                        .text_size(px(12.))
                        .text_color(color.0)
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .child(div().w(px(16.)).flex_none().flex().justify_center().child(svg().data(&svg_bytes(entry.icon, 14)).size(px(14.)).text_color(color.1)))
                        .child(div().min_w_0().truncate().child(entry.label))
                        .on_click(cx.listener(move |this, _, window, cx| this.run_row_action(path.clone(), action, window, cx))),
                )
        });
        Some(
            deferred(
                anchored().position(at).snap_to_window_with_margin(px(8.)).child(
                    menu_panel(&p)
                        .id("row-menu")
                        .occlude()
                        .rounded(px(10.))
                        .p(px(4.))
                        .min_w(px(184.))
                        .max_w(px(260.))
                        .children(items)
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.shell.row_menu = None;
                            cx.notify();
                        })),
                ),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{RowAction, SyncStatus, classic, row_entries};

    fn actions(status: SyncStatus, signed_in: bool, classic: bool) -> Vec<RowAction> {
        row_entries(status, signed_in, classic).into_iter().map(|e| e.action).collect()
    }

    #[test]
    fn states_map_from_the_cloud_badge() {
        assert_eq!(SyncStatus::from_badge(None, false), SyncStatus::LocalOnly);
        assert_eq!(SyncStatus::from_badge(Some("Update available"), false), SyncStatus::Behind);
        assert_eq!(SyncStatus::from_badge(Some("Not backed up"), false), SyncStatus::Unpushed);
        assert_eq!(SyncStatus::from_badge(Some("Synced"), true), SyncStatus::Shared);
        assert_eq!(SyncStatus::Conflict.label(), "Conflict: review changes");
    }

    #[test]
    fn signed_out_rows_copy_and_delete_only() {
        assert_eq!(actions(SyncStatus::Synced, false, true), [RowAction::CopyPath, RowAction::Delete]);
    }

    #[test]
    fn each_state_offers_electrons_sync_action() {
        assert_eq!(actions(SyncStatus::LocalOnly, true, true), [RowAction::CopyPath, RowAction::SyncOn, RowAction::Delete]);
        assert_eq!(actions(SyncStatus::LocalOnly, true, false), [RowAction::CopyPath, RowAction::Delete]);
        assert_eq!(
            actions(SyncStatus::Synced, true, true),
            [RowAction::CopyPath, RowAction::ManageSharing, RowAction::SyncOff, RowAction::Delete]
        );
        assert_eq!(actions(SyncStatus::Unpushed, true, true)[1], RowAction::RetryBackup);
        assert_eq!(actions(SyncStatus::Behind, true, true)[1], RowAction::Pull);
        assert_eq!(actions(SyncStatus::Conflict, true, true)[1], RowAction::Review);
        assert_eq!(actions(SyncStatus::Shared, true, true), [RowAction::CopyPath, RowAction::Delete]);
    }

    #[test]
    fn the_first_sync_entry_and_delete_are_separated() {
        let e = row_entries(SyncStatus::Synced, true, true);
        assert!(!e[0].separated);
        assert!(e[1].separated);
        assert!(!e[2].separated);
        assert!(e.last().unwrap().separated);
    }

    #[test]
    fn classic_files_are_text() {
        assert!(classic("a.MD"));
        assert!(classic("b.csv"));
        assert!(!classic("c.docx"));
    }
}
