//! A Library row's sync state icon and its ⋯ menu, as `library.tsx` draws
//! them (`SYNC_STATUS`, `rowMenuEntries`, `FileMenu`).
//!
//! The state comes from the cloud workspace (`cloud.rs`) as it already
//! labels a row. Sync actions run in place from the menu, as Electron's do:
//! Retry backup pushes, Sync to cloud and Resume sync turn sync on, Pull
//! latest takes the cloud copy, Stop syncing asks first (`cloud_strip.rs`),
//! and Manage sharing opens the share dialog for the cloud document.

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
    CopyLink,
    CopyLiveDoc,
    OpenLiveDoc,
    CopyPath,
    RetryBackup,
    SyncOn,
    Resume,
    Pull,
    Review,
    ManageSharing,
    SyncOff,
    Download,
    Delete,
    /// The file is gone: "Remove from Library".
    Forget,
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

/// What a row's cloud copy allows beyond its sync state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct CloudLinks {
    /// The file has a cloud copy (`item.cloudId`, not local-only): Copy link.
    pub private_link: bool,
    /// A cloud `.wd` on a server this row is signed in to, with super-nightly
    /// on: Copy Live Doc address and Open Live Doc.
    pub live_doc: bool,
    /// The cloud has the document and this device no longer has its file
    /// (`cloudCopyOnly`): Download….
    pub cloud_only: bool,
}

/// `rowMenuEntries`: the links, copy path, then the sync action this state
/// calls for, then sharing, then deletion on its own at the bottom.
/// For a file on disk (the tests' shorthand).
#[cfg(test)]
pub(super) fn row_entries(status: SyncStatus, signed_in: bool, classic: bool, links: CloudLinks) -> Vec<Entry> {
    row_entries_for(status, signed_in, classic, links, true)
}

/// `rowMenuEntries` with `item.exists`: a file that is gone offers no backup
/// or sync-on, and "Remove from Library" in place of "Delete file…".
pub(super) fn row_entries_for(status: SyncStatus, signed_in: bool, classic: bool, links: CloudLinks, exists: bool) -> Vec<Entry> {
    let e = |action, label, icon, tone| Entry { action, label, icon, tone, separated: false };
    let mut entries = Vec::new();
    if links.private_link {
        entries.push(e(RowAction::CopyLink, "Copy link", ICON_LINK, Tone::Default));
    }
    if links.live_doc {
        entries.push(e(RowAction::CopyLiveDoc, "Copy Live Doc address", ICON_LINK, Tone::Default));
        entries.push(e(RowAction::OpenLiveDoc, "Open Live Doc", ICON_LINK, Tone::Default));
    }
    entries.push(e(RowAction::CopyPath, "Copy path", ICON_PATH, Tone::Default));
    let mut sync = Vec::new();
    let in_cloud = !matches!(status, SyncStatus::LocalOnly);
    if signed_in {
        match status {
            SyncStatus::Unpushed if exists => sync.push(e(RowAction::RetryBackup, "Retry backup", ICON_RETRY, Tone::Accent)),
            SyncStatus::LocalOnly if classic && exists => sync.push(e(RowAction::SyncOn, "Sync to cloud", ICON_UPLOAD, Tone::Default)),
            SyncStatus::Paused if classic && exists => sync.push(e(RowAction::Resume, "Resume sync", ICON_UPLOAD, Tone::Default)),
            SyncStatus::Behind => sync.push(e(RowAction::Pull, "Pull latest", ICON_DOWNLOAD, Tone::Accent)),
            SyncStatus::Conflict => sync.push(e(RowAction::Review, "Review changes…", ICON_REVIEW, Tone::Accent)),
            _ => {}
        }
        if links.cloud_only {
            sync.push(e(RowAction::Download, "Download…", ICON_DOWNLOAD, Tone::Accent));
        }
        if in_cloud && status != SyncStatus::Shared && !links.cloud_only {
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
    entries.push(if exists {
        Entry { action: RowAction::Delete, label: "Delete file…", icon: ICON_TRASH, tone: Tone::Danger, separated: true }
    } else {
        Entry { action: RowAction::Forget, label: "Remove from Library", icon: ICON_REMOVE, tone: Tone::Default, separated: true }
    });
    entries
}

const ICON_LINK: &str = r#"<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>"#;
const ICON_PATH: &str = r#"<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>"#;
const ICON_RETRY: &str = r#"<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>"#;
const ICON_UPLOAD: &str = r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2"/>"#;
const ICON_DOWNLOAD: &str = r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M12 10v5M9.8 12.8 12 15l2.2-2.2"/>"#;
const ICON_REVIEW: &str = r#"<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.2"/>"#;
const ICON_CLOUD_OFF: &str = r#"<path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z"/><path d="M4 4l16 16"/>"#;
const ICON_REMOVE: &str = r#"<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>"#;
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

    /// Copy link and the Live Doc entries for a row (`rowMenuEntries`).
    fn row_links(&self, path: &Path, name: &str) -> CloudLinks {
        let private_link = self.cloud.private_link(path).is_some();
        let row_signed_in = self.cloud.binding_key(path).is_some_and(|key| self.cloud.bound_scope(&key).is_some());
        let live_doc = private_link
            && row_signed_in
            && markie_core::formats::classify(name) == markie_core::formats::FormatKind::Darkmown
            && super::comments::nightly(self.registry.as_deref());
        let cloud_only = private_link && row_signed_in && !path.exists();
        CloudLinks { private_link, live_doc, cloud_only }
    }

    /// `signedInFor(item)`: signed in to the server this row's actions would
    /// reach, its cloud copy's server, or the primary one for a local file.
    fn row_signed_in(&self, path: &Path) -> bool {
        match self.cloud.binding_key(path).filter(|key| self.cloud.bindings.get(key).is_some_and(|b| b.record.cloud_doc_id.is_some())) {
            Some(key) => self.cloud.bound_scope(&key).is_some(),
            None => self.cloud.primary_scope().is_some(),
        }
    }

    pub(super) fn open_row_menu(&mut self, path: PathBuf, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.shell.row_menu = if self.shell.row_menu.as_ref().is_some_and(|(p, _)| *p == path) { None } else { Some((path, at)) };
        cx.notify();
    }

    fn run_row_action(&mut self, path: PathBuf, action: RowAction, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.row_menu = None;
        match action {
            RowAction::CopyLink => match self.cloud.private_link(&path) {
                Some(link) => {
                    cx.write_to_clipboard(ClipboardItem::new_string(link));
                    window.push_notification("Private link copied. It opens for you after signing in, on any device.", cx);
                }
                None => window.push_notification("Couldn't copy the link.", cx),
            },
            RowAction::CopyLiveDoc => self.live_doc_address(&path, false, window, cx),
            RowAction::OpenLiveDoc => self.live_doc_address(&path, true, window, cx),
            RowAction::CopyPath => {
                cx.write_to_clipboard(ClipboardItem::new_string(path.to_string_lossy().into_owned()));
                window.push_notification("Path copied. Paste it anywhere.", cx);
            }
            RowAction::Delete => self.show_dialog(Overlay::Trash { path }, window, cx),
            RowAction::Forget => {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                match self.registry.as_ref().map(|r| r.forget(&path)) {
                    Some(Ok(())) => window.push_notification(format!("Removed {name} from your library."), cx),
                    _ => window.push_notification("Couldn't delete the file.", cx),
                }
                self.refresh_lists();
            }
            RowAction::Review => self.open_path(&path, window, cx),
            RowAction::ManageSharing => {
                let id = self.cloud.bindings.get(&path).and_then(|b| b.record.cloud_doc_id.clone());
                match id {
                    Some(id) => self.manage_cloud_share(id, super::cloud::name(&path), window, cx),
                    None => {
                        self.open_path(&path, window, cx);
                        self.open_share(window, cx);
                    }
                }
            }
            // docRetryPush, docSyncOn and docResolve("cloud"), in place.
            RowAction::RetryBackup => self.cloud_text(path, super::cloud::TextAction::Push, None, cx),
            RowAction::SyncOn | RowAction::Resume => {
                let has_id = self.cloud.bindings.get(&path).is_some_and(|b| b.record.cloud_doc_id.is_some());
                if self.shell.upload_area.is_some() && has_id {
                    self.cloud.notice = Some("Existing cloud files keep their area. Move the cloud document separately before changing its destination.".into());
                } else {
                    // The Library's "Upload destination" (library.tsx `areaId`).
                    self.cloud.enable_area = Some(self.shell.upload_area.clone());
                    self.cloud_text(path, super::cloud::TextAction::Enable, None, cx);
                }
            }
            RowAction::Pull => self.cloud_text(path, super::cloud::TextAction::Pull, None, cx),
            RowAction::SyncOff => self.show_dialog(Overlay::StopSync { path }, window, cx),
            RowAction::Download => self.download_cloud_copy(path, window, cx),
        }
        cx.notify();
    }

    /// `FileMenu` at the ⋯ button or the right-click point.
    pub(super) fn render_row_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (path, at) = self.shell.row_menu.clone()?;
        let p = themes::palette(cx);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let signed_in = self.row_signed_in(&path);
        let exists = !self.shell.recent.is_missing(&path);
        let entries = row_entries_for(self.row_status(&path), signed_in, classic(&name), self.row_links(&path, &name), exists);
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
    use super::{CloudLinks, RowAction, SyncStatus, classic, row_entries, row_entries_for};

    fn actions(status: SyncStatus, signed_in: bool, classic: bool) -> Vec<RowAction> {
        row_entries(status, signed_in, classic, CloudLinks::default()).into_iter().map(|e| e.action).collect()
    }

    #[test]
    fn cloud_rows_offer_the_link_first_and_live_docs_the_two_addresses() {
        let links = |private_link, live_doc| CloudLinks { private_link, live_doc, cloud_only: false };
        let got = |status, signed_in, l| row_entries(status, signed_in, true, l).into_iter().map(|e| (e.action, e.label)).collect::<Vec<_>>();
        // Copy link shows for any row with a cloud copy, signed in or not.
        assert_eq!(
            got(SyncStatus::Synced, false, links(true, false)),
            [(RowAction::CopyLink, "Copy link"), (RowAction::CopyPath, "Copy path"), (RowAction::Delete, "Delete file…")]
        );
        // A cloud Live Doc: the two addresses after Copy link, before Copy path.
        let live = got(SyncStatus::Synced, true, links(true, true));
        assert_eq!(
            &live[..4],
            [
                (RowAction::CopyLink, "Copy link"),
                (RowAction::CopyLiveDoc, "Copy Live Doc address"),
                (RowAction::OpenLiveDoc, "Open Live Doc"),
                (RowAction::CopyPath, "Copy path"),
            ]
        );
        // The first sync entry is still the separated one.
        let e = row_entries(SyncStatus::Synced, true, true, links(true, true));
        assert!(e.iter().take(4).all(|e| !e.separated));
        assert!(e[4].separated);
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
        let e = row_entries(SyncStatus::Synced, true, true, CloudLinks::default());
        assert!(!e[0].separated);
        assert!(e[1].separated);
        assert!(!e[2].separated);
        assert!(e.last().unwrap().separated);
    }

    #[test]
    fn a_file_that_is_gone_is_removed_from_the_library_not_deleted() {
        let got = row_entries_for(SyncStatus::LocalOnly, true, true, CloudLinks::default(), false);
        let actions: Vec<_> = got.iter().map(|e| e.action).collect();
        assert_eq!(actions, [RowAction::CopyPath, RowAction::Forget]);
        assert_eq!(got[1].label, "Remove from Library");
        let unpushed: Vec<_> = row_entries_for(SyncStatus::Unpushed, true, true, CloudLinks::default(), false).iter().map(|e| e.action).collect();
        assert!(!unpushed.contains(&RowAction::RetryBackup));
    }

    #[test]
    fn a_cloud_copy_without_its_file_offers_download() {
        let only = CloudLinks { private_link: true, live_doc: false, cloud_only: true };
        let got: Vec<RowAction> = row_entries(SyncStatus::Synced, true, true, only).into_iter().map(|e| e.action).collect();
        assert_eq!(got, [RowAction::CopyLink, RowAction::CopyPath, RowAction::Download, RowAction::SyncOff, RowAction::Delete]);
    }

    #[test]
    fn classic_files_are_text() {
        assert!(classic("a.MD"));
        assert!(classic("b.csv"));
        assert!(!classic("c.docx"));
    }
}
