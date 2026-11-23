//! The office cloud dialog: `document-cloud-dialog.tsx`. Explicit byte
//! snapshots for Word, RTF, ODT and the other formats the document platform
//! takes. Local Save never publishes a snapshot.
//!
//! Drawn like Electron's: a centred panel (`max-w-xl`, `p-6`, `space-y-4`)
//! on a dimmed page, with the header and its Close button, the Server line,
//! "Signed in as …", the area picker, the bordered buttons, the cloud
//! section once there is a cloud copy, and "Download a local copy instead"
//! under a rule. Signed out, the sign-in form stands in for the middle.
use super::Workspace;
use super::cloud::{Scope, name, network};
use super::cloud_page::AreaTarget;
use crate::themes::{self, Palette, mix};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use markie_cloud::CloudError;
use markie_cloud::docs::Role;
use markie_cloud::platform::{DownloadLink, MAX_FILE_BYTES, Member, PlatformClient, SnapshotMeta};
use std::collections::HashMap;
use std::future::Future;
use std::io::Read as _;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(super) struct Target {
    scope: Scope,
    meta: SnapshotMeta,
}

/// A cloud snapshot open for editing in the dialog (cloud-document-editor
/// .tsx): no local file, and nothing saved until "Save this snapshot to
/// cloud".
pub(super) enum CloudEditBody {
    Office(Entity<markie_office_view::WordView>),
    Text(Entity<gpui_kit::component::input::EditorState>),
    /// A format this dialog can download but not edit.
    Binary,
}

pub(super) struct CloudEdit {
    id: String,
    body: CloudEditBody,
    dirty: bool,
    _sub: Option<Subscription>,
}

/// Which `CloudAreaPicker` is open: "Upload destination" before the first
/// upload, "Organize snapshot in" once there is a cloud copy.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AreaMenu {
    Upload,
    Organize,
}

/// One open dialog: `DocumentCloudDialog`'s state.
pub(super) struct OfficeDialog {
    /// `file`: the local document this dialog shares.
    file: Option<PathBuf>,
    /// `cloudDocumentId`: the cloud document it was opened for.
    requested: Option<String>,
    /// The session a cloud document was opened from; None follows the
    /// primary server, as Electron's `getServerURL()` does.
    bound: Option<Scope>,
    cloud: Option<Target>,
    list: Option<Vec<SnapshotMeta>>,
    /// `areaId`, shared by both pickers.
    area: Option<String>,
    area_menu: Option<AreaMenu>,
    email: Entity<InputState>,
    role: Role,
    members: Vec<Member>,
    link: Option<DownloadLink>,
    notice: Option<String>,
    error: Option<String>,
    sign_in: Option<Entity<super::account::SignInForm>>,
    editing: Option<CloudEdit>,
    focus: FocusHandle,
}

#[derive(Default)]
pub(super) struct OfficeCloud {
    /// The cloud copy each local file made, so reopening shows it.
    pub targets: HashMap<PathBuf, Target>,
    dialog: Option<OfficeDialog>,
    busy: bool,
}

#[derive(Clone)]
enum Manage {
    Invite(String, Role),
    Revoke(String),
    CreateLink,
    RevokeLink(String),
    Place(String),
}

enum ManageResult {
    Members(Vec<Member>),
    Link(Option<DownloadLink>),
    Placed,
}

/// The server's own word for a role, as Electron prints `entry.role`.
fn role_word(role: Role) -> &'static str {
    match role {
        Role::Owner => "owner",
        Role::Editor => "editor",
        Role::Viewer => "viewer",
    }
}

/// `run`'s catch: the server's sentence, or Electron's fallback when the
/// request never arrived.
fn job_error(e: &CloudError) -> String {
    match e {
        CloudError::Status { status: 409, .. } => {
            "Another editor saved a newer cloud version. Your local edits were kept.".into()
        }
        CloudError::Status { message: Some(m), .. } if !m.is_empty() => m.clone(),
        CloudError::Offline => {
            "Cloud documents could not be reached. Your edits were kept; check your connection and retry.".into()
        }
        other => other.to_string(),
    }
}

impl Workspace {
    /// Share for an Office document: the dialog with the file.
    pub(super) fn show_office_upload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else {
            return;
        };
        let cloud = self.cloud_office.targets.get(&path).cloned().filter(|t| t.scope.active());
        self.open_office_dialog(Some(path), None, cloud, window, cx);
    }

    /// A snapshot on the Cloud page: the dialog opens it for editing at once,
    /// as `cloudDocumentId` does.
    pub(super) fn show_snapshot(&mut self, scope: Scope, meta: SnapshotMeta, window: &mut Window, cx: &mut Context<Self>) {
        let target = Target { scope: scope.clone(), meta };
        self.open_office_dialog(None, Some(scope), None, window, cx);
        if let Some(d) = self.cloud_office.dialog.as_mut() {
            d.requested = Some(target.meta.id.clone());
        }
        self.open_cloud_edit(target, window, cx);
    }

    fn open_office_dialog(&mut self, file: Option<PathBuf>, bound: Option<Scope>, cloud: Option<Target>, window: &mut Window, cx: &mut Context<Self>) {
        let email = cx.new(|cx| InputState::new(window, cx));
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        self.cloud_office.dialog = Some(OfficeDialog {
            file,
            requested: None,
            bound,
            cloud,
            list: None,
            area: None,
            area_menu: None,
            email,
            role: Role::Viewer,
            members: Vec::new(),
            link: None,
            notice: None,
            error: None,
            sign_in: None,
            editing: None,
            focus,
        });
        cx.notify();
    }

    /// The session this dialog talks to: the one it was opened from, or the
    /// primary server's.
    pub(super) fn office_scope(&self) -> Option<Scope> {
        let d = self.cloud_office.dialog.as_ref()?;
        match &d.bound {
            Some(scope) => Some(scope.clone()).filter(Scope::active),
            None => self.cloud.primary_scope().filter(Scope::active),
        }
    }

    /// `identityMatches`: the cloud content still belongs to the session.
    fn office_identity_matches(&self) -> bool {
        let Some(d) = self.cloud_office.dialog.as_ref() else { return false };
        let Some(cloud) = d.cloud.as_ref() else { return true };
        self.office_scope().is_some_and(|s| s.user == cloud.scope.user && s.origin() == cloud.scope.origin())
    }

    /// `mayClose`, then close.
    fn office_try_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.cloud_office.busy {
            return;
        }
        let dirty = self.cloud_office.dialog.as_ref().and_then(|d| d.editing.as_ref()).is_some_and(|e| e.dirty);
        if !dirty {
            self.office_close(window, cx);
            return;
        }
        let answer = window.prompt(PromptLevel::Warning, "Discard unsaved cloud edits? Download a copy first to keep them.", None, &["Discard", "Cancel"], cx);
        cx.spawn_in(window, async move |this, cx| {
            if answer.await == Ok(0) {
                let _ = this.update_in(cx, |this, window, cx| this.office_close(window, cx));
            }
        })
        .detach();
    }

    fn office_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cloud_office.dialog = None;
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    /// ⌘S while a cloud copy is open for editing saves that version. True
    /// when the dialog took the shortcut.
    pub(super) fn office_save_shortcut(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(d) = self.cloud_office.dialog.as_ref() else { return false };
        let (Some(cloud), true) = (d.cloud.clone(), d.editing.is_some()) else { return false };
        if !self.cloud_office.busy && cloud.meta.role != Role::Viewer && self.office_identity_matches() {
            self.save_cloud_edit(cloud, window, cx);
        }
        true
    }

    fn office_notice(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        if let Some(d) = self.cloud_office.dialog.as_mut() {
            d.notice = Some(text.into());
        }
        cx.notify();
    }

    fn office_fail(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        if let Some(d) = self.cloud_office.dialog.as_mut() {
            d.error = Some(text.into());
        }
        cx.notify();
    }

    /// `run`: one request at a time, bound to the session it started in.
    fn snapshot_job<T: Send + 'static>(
        &mut self,
        scope: Scope,
        work: impl Future<Output = Result<T, CloudError>> + Send + 'static,
        finish: impl FnOnce(&mut Workspace, T, &mut Window, &mut Context<Workspace>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.cloud_office.busy || self.cloud_office.dialog.is_none() {
            return;
        }
        if !scope.active() {
            self.office_fail("Sign in again to confirm your account on this server before opening or sharing cloud documents.", cx);
            return;
        }
        self.cloud_office.busy = true;
        if let Some(d) = self.cloud_office.dialog.as_mut() {
            d.error = None;
        }
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = network(work).await.and_then(|out| out.map_err(|e| job_error(&e)));
            let _ = this.update_in(cx, |this, window, cx| {
                this.cloud_office.busy = false;
                if this.cloud_office.dialog.is_none() {
                    return;
                }
                let same = scope.active() && this.cloud.scope(scope.origin()).is_some_and(|s| s.user == scope.user);
                match result {
                    _ if !same => this.office_fail("The account or document changed. The result was not applied.", cx),
                    Ok(value) => finish(this, value, window, cx),
                    Err(error) => this.office_fail(error, cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// `publish` for the local file: a new cloud copy, or a new version of
    /// the one this dialog made.
    fn upload_snapshot(&mut self, scope: Scope, path: PathBuf, existing: Option<SnapshotMeta>, area: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.persist_cloud_choice(&path, window, cx) {
            self.office_fail("The copy could not be exported. Your edits were kept.", cx);
            return;
        }
        let source = path.clone();
        let request = scope.clone();
        self.snapshot_job(
            scope.clone(),
            async move {
                let bytes = read_bytes(&source)?;
                let target = existing.as_ref().map(|m| (m.id.as_str(), m.version));
                PlatformClient(&request.client).upload(&name(&source), &bytes, target, area.as_deref()).await
            },
            move |this, saved, _, cx| {
                let target = Target { scope, meta: saved.meta };
                this.cloud_office.targets.insert(path.clone(), target.clone());
                if let Some(d) = this.cloud_office.dialog.as_mut() {
                    d.cloud = Some(target);
                    d.area = None;
                    d.area_menu = None;
                    d.notice = Some("Cloud copy saved. It is separate from your local recovery copy.".into());
                }
                this.refresh_cloud(false, cx);
            },
            window,
            cx,
        );
    }

    /// "Browse cloud documents": the list, in the dialog.
    fn browse_snapshots(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(scope) = self.office_scope() else { return };
        let request = scope.clone();
        self.snapshot_job(
            scope,
            async move { PlatformClient(&request.client).list().await },
            |this, rows, _, _| {
                if let Some(d) = this.cloud_office.dialog.as_mut() {
                    d.list = Some(rows);
                }
            },
            window,
            cx,
        );
    }

    /// `loadCloud`: the current version, opened in the dialog for editing.
    fn open_cloud_edit(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        let dirty = self.cloud_office.dialog.as_ref().and_then(|d| d.editing.as_ref()).is_some_and(|e| e.dirty);
        if dirty {
            let answer = window.prompt(PromptLevel::Warning, "Discard the unsaved cloud edits before opening another version?", None, &["Discard", "Cancel"], cx);
            cx.spawn_in(window, async move |this, cx| {
                if answer.await == Ok(0) {
                    let _ = this.update_in(cx, |this, window, cx| {
                        if let Some(e) = this.cloud_office.dialog.as_mut().and_then(|d| d.editing.as_mut()) {
                            e.dirty = false;
                        }
                        this.open_cloud_edit(target, window, cx);
                    });
                }
            })
            .detach();
            return;
        }
        let request = target.clone();
        self.snapshot_job(
            target.scope.clone(),
            async move { PlatformClient(&request.scope.client).snapshot(&request.meta.id, None).await },
            move |this, snapshot, window, cx| {
                if snapshot.meta.id != target.meta.id {
                    this.office_fail("The server returned a different cloud document.", cx);
                    return;
                }
                let read_only = snapshot.meta.role == Role::Viewer;
                let format = markie_core::formats::classify(&snapshot.meta.name);
                let (body, sub) = match super::office::engine_format(format)
                    .and_then(|engine| markie_office::rich_document::open_rich_document(engine, &snapshot.bytes).ok())
                {
                    Some(document) => {
                        let mut editor = markie_office_view::editor::WordEditor::new(document);
                        editor.host_read_only = read_only;
                        let view = cx.new(|cx| markie_office_view::WordView::new(editor, window, cx));
                        let sub = cx.subscribe(&view, |this: &mut Workspace, _, event: &markie_office_view::WordViewEvent, cx| {
                            if matches!(event, markie_office_view::WordViewEvent::Changed)
                                && let Some(e) = this.cloud_office.dialog.as_mut().and_then(|d| d.editing.as_mut())
                            {
                                e.dirty = true;
                                cx.notify();
                            }
                        });
                        (CloudEditBody::Office(view), Some(sub))
                    }
                    None => match String::from_utf8(snapshot.bytes.clone()).ok().filter(|_| {
                        markie_cloud::platform::supported_name(&snapshot.meta.name).is_some_and(|f| {
                            !matches!(
                                f,
                                markie_core::formats::FormatKind::Docx
                                    | markie_core::formats::FormatKind::Rtf
                                    | markie_core::formats::FormatKind::Odt
                                    | markie_core::formats::FormatKind::Doc
                                    | markie_core::formats::FormatKind::Html
                            )
                        })
                    }) {
                        Some(text) => {
                            let state = cx.new(|cx| gpui_kit::component::input::EditorState::new(window, cx).soft_wrap(true));
                            state.update(cx, |s, cx| s.set_value(text, window, cx));
                            let sub = cx.subscribe(&state, |this: &mut Workspace, _, event: &gpui_kit::component::input::InputEvent, cx| {
                                if matches!(event, gpui_kit::component::input::InputEvent::Change)
                                    && let Some(e) = this.cloud_office.dialog.as_mut().and_then(|d| d.editing.as_mut())
                                {
                                    e.dirty = true;
                                    cx.notify();
                                }
                            });
                            (CloudEditBody::Text(state), Some(sub))
                        }
                        None => (CloudEditBody::Binary, None),
                    },
                };
                if let Some(d) = this.cloud_office.dialog.as_mut() {
                    d.notice = Some(format!("Opened cloud version {}. Edits are not saved until you save this version.", snapshot.meta.version));
                    d.cloud = Some(Target { scope: target.scope.clone(), meta: snapshot.meta.clone() });
                    d.area = None;
                    d.area_menu = None;
                    d.members.clear();
                    d.link = None;
                    d.editing = Some(CloudEdit { id: snapshot.meta.id, body, dirty: false, _sub: sub });
                }
            },
            window,
            cx,
        );
    }

    /// The edited copy's bytes, or None when nothing is open for editing.
    fn cloud_edit_bytes(&self, cx: &App) -> Option<Result<Vec<u8>, String>> {
        let e = self.cloud_office.dialog.as_ref()?.editing.as_ref()?;
        match &e.body {
            CloudEditBody::Office(view) => Some(view.read(cx).editor.export().map_err(|e| e.to_string())),
            CloudEditBody::Text(state) => Some(Ok(state.read(cx).value().to_string().into_bytes())),
            CloudEditBody::Binary => None,
        }
    }

    /// `publish` for an edited cloud copy: a new version over the one opened.
    fn save_cloud_edit(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bytes) = self.cloud_edit_bytes(cx) else { return };
        let Ok(bytes) = bytes else {
            self.office_fail("The copy could not be exported. Your edits were kept.", cx);
            return;
        };
        let request = target.clone();
        self.snapshot_job(
            target.scope.clone(),
            async move {
                PlatformClient(&request.scope.client)
                    .upload(&request.meta.name, &bytes, Some((request.meta.id.as_str(), request.meta.version)), None)
                    .await
            },
            move |this, saved, _, cx| {
                if let Some(d) = this.cloud_office.dialog.as_mut() {
                    if let Some(e) = d.editing.as_mut().filter(|e| e.id == saved.meta.id) {
                        e.dirty = false;
                    }
                    d.cloud = Some(Target { scope: target.scope.clone(), meta: saved.meta });
                    d.area = None;
                    d.notice = Some("Cloud copy saved. It is separate from your local recovery copy.".into());
                }
                this.refresh_cloud(false, cx);
            },
            window,
            cx,
        );
    }

    /// "Save this snapshot to cloud" or "Create a cloud copy".
    fn office_publish(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = self.cloud_office.dialog.as_ref() else { return };
        let (file, cloud, area) = (d.file.clone(), d.cloud.clone(), d.area.clone());
        let editable = d.editing.as_ref().is_some_and(|e| !matches!(e.body, CloudEditBody::Binary));
        match (cloud, file) {
            (Some(cloud), _) if editable => self.save_cloud_edit(cloud, window, cx),
            (Some(cloud), Some(path)) => self.upload_snapshot(cloud.scope.clone(), path, Some(cloud.meta), None, window, cx),
            (None, Some(path)) => {
                if let Some(scope) = self.office_scope() {
                    self.upload_snapshot(scope, path, None, area, window, cx);
                }
            }
            (Some(_), None) => self.office_fail("Open a cloud document before downloading or saving it.", cx),
            (None, None) => {}
        }
    }

    /// "Download a local copy instead" or "Download edited copy": the bytes
    /// into Downloads; nothing is saved to the cloud.
    fn office_download(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        const DONE: &str = "Download started for this snapshot. This action did not save a cloud version.";
        const FAILED: &str = "The copy could not be exported. Your edits were kept.";
        let Some(d) = self.cloud_office.dialog.as_ref() else { return };
        let (file, cloud) = (d.file.clone(), d.cloud.clone());
        let download_name = cloud.as_ref().map(|c| c.meta.name.clone()).or_else(|| file.as_deref().map(name));
        if let (Some(bytes), Some(n)) = (self.cloud_edit_bytes(cx), download_name.clone()) {
            match bytes.and_then(|b| save_download(&n, &b)) {
                Ok(_) => self.office_notice(DONE, cx),
                Err(_) => self.office_fail(FAILED, cx),
            }
            return;
        }
        // `cloudSource ?? file.bytes`: the opened cloud version, else the
        // local file.
        let opened = d.editing.is_some();
        match (cloud, file) {
            (Some(cloud), _) if opened => {
                let request = cloud.clone();
                self.snapshot_job(
                    cloud.scope.clone(),
                    async move { PlatformClient(&request.scope.client).snapshot(&request.meta.id, None).await },
                    |this, snapshot, _, cx| match save_download(&snapshot.meta.name, &snapshot.bytes) {
                        Ok(_) => this.office_notice(DONE, cx),
                        Err(_) => this.office_fail(FAILED, cx),
                    },
                    window,
                    cx,
                );
            }
            (_, Some(path)) => {
                if !self.persist_cloud_choice(&path, window, cx) {
                    self.office_fail(FAILED, cx);
                    return;
                }
                match read_bytes(&path).map_err(|e| e.to_string()).and_then(|b| save_download(&name(&path), &b)) {
                    Ok(_) => self.office_notice(DONE, cx),
                    Err(_) => self.office_fail(FAILED, cx),
                }
            }
            _ => self.office_fail("Open a cloud document before downloading or saving it.", cx),
        }
    }

    fn manage_snapshot(&mut self, action: Manage, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.cloud_office.dialog.as_ref().and_then(|d| d.cloud.clone()) else { return };
        let request = target.clone();
        self.snapshot_job(
            target.scope.clone(),
            async move {
                let client = PlatformClient(&request.scope.client);
                let id = &request.meta.id;
                Ok(match action {
                    Manage::Invite(address, role) => {
                        client.add_member(id, &address, role).await?;
                        (ManageResult::Members(client.members(id).await?), "Access added to the verified account. No invitation email was sent.")
                    }
                    Manage::Revoke(user) => {
                        client.revoke_member(id, &user).await?;
                        (ManageResult::Members(client.members(id).await?), "Future access revoked. Existing downloaded copies cannot be recalled.")
                    }
                    Manage::CreateLink => (
                        ManageResult::Link(Some(client.create_link(id).await?)),
                        "Read-only download link created, valid for 24 hours. Anyone with it can download a copy.",
                    ),
                    Manage::RevokeLink(link) => {
                        client.revoke_link(id, &link).await?;
                        (ManageResult::Link(None), "Link revoked for future downloads.")
                    }
                    Manage::Place(area) => {
                        client.place(id, &area).await?;
                        (ManageResult::Placed, "Snapshot organized in the selected area. Document permissions and unsaved edits are unchanged.")
                    }
                })
            },
            move |this, (result, line), window, cx| {
                let Some(d) = this.cloud_office.dialog.as_mut().filter(|d| d.cloud.as_ref().is_some_and(|c| same_target(c, &target))) else {
                    return;
                };
                d.notice = Some(line.into());
                match result {
                    ManageResult::Members(m) => {
                        d.members = m;
                        let email = d.email.clone();
                        email.update(cx, |s, cx| s.set_value("", window, cx));
                    }
                    ManageResult::Link(l) => d.link = l,
                    ManageResult::Placed => {
                        d.area = None;
                        this.refresh_cloud(false, cx);
                    }
                }
            },
            window,
            cx,
        );
    }

    /// A new area made in this dialog's picker is selected in it.
    /// Scene mode: the dialog is open and nothing is in flight. With
    /// `upload`, presses Upload once first, as the button does.
    #[cfg(feature = "scene")]
    pub(super) fn scene_office_settled(&mut self, upload: bool, uploaded: &mut bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.cloud_office.dialog.is_none() || self.cloud_office.busy {
            return false;
        }
        if upload && !*uploaded {
            *uploaded = true;
            self.office_publish(window, cx);
            return false;
        }
        !upload || self.cloud_office.dialog.as_ref().is_some_and(|d| d.cloud.is_some())
    }

    pub(super) fn office_area_created(&mut self, area: String) {
        if let Some(d) = self.cloud_office.dialog.as_mut() {
            d.area = Some(area);
            d.area_menu = None;
        }
    }

    // ------------------------------------------------------------ render

    /// The dialog over the dimmed window (`fixed inset-0 bg-black/60 … p-4`).
    pub(super) fn render_office_cloud(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.cloud_office.dialog.as_ref()?;
        let scope = self.office_scope();
        // Signed out: the sign-in form in place, without Google and Apple.
        if scope.is_none()
            && self.cloud_office.dialog.as_ref().is_some_and(|d| d.sign_in.is_none())
            && let Some(store) = super::account::AccountStore::global(cx)
        {
            let form = cx.new(|cx| super::account::SignInForm::new(store, markie_cloud::auth_errors::SignInReason::Share, window, cx).without_providers());
            if let Some(d) = self.cloud_office.dialog.as_mut() {
                d.sign_in = Some(form);
            }
        }
        let p = themes::palette(cx);
        let viewport = window.viewport_size();
        let panel = self.render_office_panel(scope, viewport, &p, window, cx);
        Some(
            div()
                .id("office-cloud-scrim")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .p(px(16.))
                // `bg-black/60`; Chromium also blurs the page, which GPUI
                // cannot, so the page shows through a little more.
                .bg(hsla(0., 0., 0., 0.6))
                .occlude()
                // No click-outside: Electron's scrim has no handler.
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .capture_key_down(cx.listener(|w, ev: &KeyDownEvent, window, cx| {
                    let k = &ev.keystroke;
                    if k.key == "escape" && !k.modifiers.platform {
                        cx.stop_propagation();
                        w.office_try_close(window, cx);
                    } else if k.key == "s" && k.modifiers.platform && !k.modifiers.shift {
                        if w.cloud_office.dialog.as_ref().is_some_and(|d| d.editing.is_some()) {
                            cx.stop_propagation();
                            w.office_save_shortcut(window, cx);
                        }
                    }
                }))
                .child(panel)
                .into_any_element(),
        )
    }

    fn render_office_panel(&mut self, scope: Option<Scope>, viewport: Size<Pixels>, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let busy = self.cloud_office.busy;
        let identity = self.office_identity_matches();
        let primary = self.cloud.primary_origin();
        let origin = scope.as_ref().map(|s| s.origin().to_string()).or_else(|| self.cloud_office.dialog.as_ref().and_then(|d| d.bound.as_ref().map(|s| s.origin().to_string()))).unwrap_or_else(|| primary.clone());
        let email = if origin == primary {
            super::account::signed_in_user(cx).map(|u| u.email)
        } else {
            self.cloud.servers_ui.emails.get(&origin).cloned().flatten()
        };
        let edit_bytes_ready = self.cloud_office.dialog.as_ref().and_then(|d| d.editing.as_ref()).is_some_and(|e| !matches!(e.body, CloudEditBody::Binary));
        let upload_picker = self.office_area_picker(AreaMenu::Upload, &p, cx);
        let organize_picker = self.office_area_picker(AreaMenu::Organize, &p, cx);
        let d = self.cloud_office.dialog.as_ref().expect("checked by the caller");
        let editing = d.editing.is_some();
        let dirty = d.editing.as_ref().is_some_and(|e| e.dirty);
        let file_name = d.file.as_deref().map(name);
        let (title, subtitle) = match &file_name {
            Some(n) => (format!("Share {n}"), "Nothing is uploaded until you choose to create a cloud copy."),
            None => ("Cloud document".to_string(), "Cloud snapshots are separate from local files. Opening does not create a local recovery copy."),
        };
        let has_content = d.cloud.is_some() || d.list.is_some() || editing || d.link.is_some();
        let signed_in = scope.is_some() && email.is_some();
        let cloud = d.cloud.clone();

        let mut body: Vec<AnyElement> = Vec::new();
        body.push(
            h_flex()
                .items_start()
                .justify_between()
                .gap(px(16.))
                .child(
                    v_flex()
                        .min_w_0()
                        .child(div().text_size(px(18.)).line_height(px(28.)).font_weight(FontWeight::SEMIBOLD).child(title))
                        .child(div().mt(px(4.)).text_size(px(14.)).line_height(px(20.)).text_color(p.muted).child(subtitle)),
                )
                .child(office_button("office-close", "Close", busy, &p).when(!busy, |el| el.on_click(cx.listener(|w, _, window, cx| w.office_try_close(window, cx)))))
                .into_any_element(),
        );
        body.push(div().text_size(px(12.)).line_height(px(16.)).text_color(p.muted).child(format!("Server: {origin}")).into_any_element());

        if !identity && has_content {
            body.push(div().text_size(px(16.)).line_height(px(24.)).child("The account changed. Close this panel before sharing again.").into_any_element());
        } else if !signed_in {
            if let Some(form) = d.sign_in.clone() {
                body.push(div().child(form).into_any_element());
            }
        } else {
            let email = email.clone().unwrap_or_default();
            body.push(div().text_size(px(14.)).line_height(px(20.)).child(format!("Signed in as {email}. Cloud access is independent of your local library.")).into_any_element());
            if d.file.is_some() && cloud.is_none() {
                body.push(upload_picker);
            }
            let mut row = h_flex().flex_wrap().gap(px(8.));
            if d.file.is_some() || cloud.is_some() {
                let off = busy || cloud.as_ref().is_some_and(|c| c.meta.role == Role::Viewer);
                row = row.child(
                    office_button("office-publish", if cloud.is_some() { "Save this snapshot to cloud" } else { "Create a cloud copy" }, off, &p)
                        .when(!off, |el| el.on_click(cx.listener(|w, _, window, cx| w.office_publish(window, cx)))),
                );
            }
            row = row.child(office_button("office-browse", "Browse cloud documents", busy, &p).when(!busy, |el| el.on_click(cx.listener(|w, _, window, cx| w.browse_snapshots(window, cx)))));
            if let (Some(id), None) = (d.requested.clone(), cloud.as_ref()) {
                let bound = d.bound.clone();
                row = row.child(office_button("office-retry", "Retry opening cloud document", busy, &p).when(!busy, |el| {
                    el.on_click(cx.listener(move |w, _, window, cx| {
                        let meta = bound.as_ref().and_then(|s| w.cloud.listing(s)).and_then(|l| l.snapshots.iter().find(|m| m.id == id).cloned());
                        if let (Some(scope), Some(meta)) = (bound.clone(), meta) {
                            w.open_cloud_edit(Target { scope, meta }, window, cx);
                        }
                    }))
                }));
            }
            body.push(row.into_any_element());
            if let Some(rows) = d.list.clone() {
                let list_scope = scope.clone();
                body.push(
                    v_flex()
                        .id("office-cloud-list")
                        .gap(px(4.))
                        .max_h(px(160.))
                        .overflow_y_scroll()
                        .children(rows.into_iter().enumerate().map(|(i, entry)| {
                            let label = format!("{} · {} · version {}", entry.name, role_word(entry.role), entry.version);
                            let scope = list_scope.clone();
                            office_button(SharedString::from(format!("office-list-{i}")), label, busy, &p).w_full().when(!busy, |el| {
                                el.on_click(cx.listener(move |w, _, window, cx| {
                                    if let Some(scope) = scope.clone() {
                                        w.open_cloud_edit(Target { scope, meta: entry.clone() }, window, cx);
                                    }
                                }))
                            })
                        }))
                        .into_any_element(),
                );
            }
            if let Some(cloud) = cloud.clone() {
                body.push(self.render_office_cloud_section(&cloud, organize_picker, edit_bytes_ready, viewport, &p, cx));
            }
        }

        let d = self.cloud_office.dialog.as_ref().expect("checked by the caller");
        let download_off = busy || (d.file.is_none() && d.cloud.is_none()) || (d.cloud.is_some() && !identity);
        body.push(
            div()
                .border_t_1()
                .border_color(p.border)
                .pt(px(12.))
                .child(
                    h_flex().child(
                        office_button("office-download", if edit_bytes_ready { "Download edited copy" } else { "Download a local copy instead" }, download_off, &p)
                            .when(!download_off, |el| el.on_click(cx.listener(|w, _, window, cx| w.office_download(window, cx)))),
                    ),
                )
                .into_any_element(),
        );
        if busy {
            body.push(div().text_size(px(14.)).line_height(px(20.)).text_color(p.muted).child("Updating cloud access…").into_any_element());
        } else if let Some(n) = d.notice.clone() {
            body.push(div().text_size(px(14.)).line_height(px(20.)).text_color(p.muted).child(n).into_any_element());
        }
        if let Some(e) = d.error.clone() {
            body.push(div().text_size(px(14.)).line_height(px(20.)).child(e).into_any_element());
        }
        let _ = (dirty, window);
        let max_w = if editing { 1024. } else { 576. };
        let width = (viewport.width - px(32.)).min(px(max_w));
        div()
            .id("office-cloud")
            .track_focus(&d.focus)
            .w(width)
            .max_h(viewport.height * 0.9)
            .overflow_y_scroll()
            .rounded(px(12.))
            .bg(p.surface)
            .border_1()
            .border_color(p.border)
            .p(px(24.))
            .text_color(p.foreground)
            .flex()
            .flex_col()
            .gap(px(16.))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .children(body)
            .into_any_element()
    }

    /// The part under the rule once there is a cloud copy.
    fn render_office_cloud_section(&self, cloud: &Target, organize: AnyElement, editable: bool, viewport: Size<Pixels>, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let busy = self.cloud_office.busy;
        let d = self.cloud_office.dialog.as_ref().expect("an open dialog");
        let owner = cloud.meta.role == Role::Owner;
        let mut col = v_flex().gap(px(16.)).border_t_1().border_color(p.border).pt(px(16.));
        let move_off = busy || d.area.is_none();
        col = col.child(
            h_flex()
                .flex_wrap()
                .items_start()
                .gap(px(8.))
                .child(organize)
                .child(office_button("office-move", "Move to area", move_off, &p).when(!move_off, |el| {
                    el.on_click(cx.listener(|w, _, window, cx| {
                        if let Some(area) = w.cloud_office.dialog.as_ref().and_then(|d| d.area.clone()) {
                            w.manage_snapshot(Manage::Place(area), window, cx);
                        }
                    }))
                })),
        );
        col = col
            .child(div().text_size(px(12.)).line_height(px(16.)).text_color(p.muted).child(format!("Cloud version {}. Version conflicts preserve your local edits; this is not live Word co-editing.", cloud.meta.version)))
            .child(div().text_size(px(14.)).line_height(px(20.)).font_weight(FontWeight::MEDIUM).child(cloud.meta.name.clone()));
        {
            let target = cloud.clone();
            col = col.child(h_flex().child(office_button("office-open-edit", "Open current cloud version for editing", busy, &p).when(!busy, |el| {
                el.on_click(cx.listener(move |w, _, window, cx| w.open_cloud_edit(target.clone(), window, cx)))
            })));
        }
        if let Some(e) = d.editing.as_ref() {
            let editor_h = (viewport.height * 0.55).max(px(288.));
            let view: AnyElement = match &e.body {
                CloudEditBody::Office(view) => div().h(editor_h).overflow_hidden().rounded(px(6.)).border_1().border_color(p.border).child(view.clone()).into_any_element(),
                CloudEditBody::Text(state) => v_flex()
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .child("Cloud document text")
                    .child(
                        div()
                            .mt(px(8.))
                            .h(px(240.))
                            .rounded(px(6.))
                            .border_1()
                            .border_color(p.border)
                            .bg(p.background)
                            .child(gpui_kit::component::input::Editor::new(state).bordered(false).h(relative(1.))),
                    )
                    .into_any_element(),
                CloudEditBody::Binary => div().text_size(px(14.)).line_height(px(20.)).text_color(p.muted).child("This format can be downloaded, but not edited here.").into_any_element(),
            };
            col = col.child(view);
            if editable {
                col = col.child(div().text_size(px(12.)).line_height(px(16.)).text_color(p.muted).child(if e.dirty { "Cloud edits are not saved yet." } else { "No unsaved cloud edits." }));
            }
        }
        if owner {
            let email = d.email.clone();
            let empty = email.read(cx).value().trim().is_empty();
            let add_off = busy || empty;
            let role_button = |role: Role, label: &'static str, id: &'static str| {
                office_button(id, label, false, &p).on_click(cx.listener(move |w, _, _, cx| {
                    if let Some(d) = w.cloud_office.dialog.as_mut() {
                        d.role = role;
                    }
                    cx.notify();
                }))
            };
            col = col.child(
                v_flex()
                    .gap(px(8.))
                    .child(div().text_size(px(14.)).line_height(px(20.)).font_weight(FontWeight::MEDIUM).child("Verified account access"))
                    .child(
                        v_flex().text_size(px(14.)).line_height(px(20.)).child("Email").child(
                            div()
                                .mt(px(4.))
                                .h(px(38.))
                                .flex()
                                .items_center()
                                .rounded(px(6.))
                                .border_1()
                                .border_color(p.border)
                                .bg(p.background)
                                .child(Input::new(&email).appearance(false).text_size(px(14.)).w_full()),
                        ),
                    )
                    .child(
                        h_flex()
                            .gap(px(8.))
                            .child(role_button(Role::Viewer, "Can view", "office-role-viewer"))
                            .child(role_button(Role::Editor, "Can save versions", "office-role-editor"))
                            .child(office_button("office-add-access", "Add access", add_off, &p).when(!add_off, |el| {
                                el.on_click(cx.listener(move |w, _, window, cx| {
                                    let Some(d) = w.cloud_office.dialog.as_ref() else { return };
                                    let address = d.email.read(cx).value().trim().to_owned();
                                    let role = d.role;
                                    if !address.is_empty() {
                                        w.manage_snapshot(Manage::Invite(address, role), window, cx);
                                    }
                                }))
                            })),
                    ),
            );
        }
        for m in &d.members {
            let user = m.user_id.clone();
            let line = format!("{} · {}", m.email.as_deref().unwrap_or(&m.user_id), if m.waiting { "Waiting for them to accept" } else { role_word(m.role) });
            col = col.child(
                h_flex()
                    .justify_between()
                    .gap(px(8.))
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .child(div().min_w_0().child(line))
                    .child(office_button(SharedString::from(format!("office-revoke-{user}")), "Revoke access", busy, &p).when(!busy, |el| {
                        el.on_click(cx.listener(move |w, _, window, cx| w.manage_snapshot(Manage::Revoke(user.clone()), window, cx)))
                    })),
            );
        }
        let live = cloud.meta.format == markie_core::formats::FormatKind::Darkmown || markie_cloud::sharing::view::is_live_doc_name(&cloud.meta.name);
        if owner && live {
            col = col.child(div().text_size(px(14.)).line_height(px(20.)).text_color(p.muted).child(markie_cloud::sharing::view::LIVE_DOC_PRIVATE_LINE));
        } else if owner {
            col = col.child(h_flex().child(office_button("office-create-link", "Create 24-hour read-only link", busy, &p).when(!busy, |el| {
                el.on_click(cx.listener(|w, _, window, cx| w.manage_snapshot(Manage::CreateLink, window, cx)))
            })));
        }
        if let Some(link) = d.link.clone() {
            let url = PlatformClient(&cloud.scope.client).download_url(&link).unwrap_or_default();
            let copy = url.clone();
            let id = link.id.clone();
            col = col.child(
                v_flex()
                    .gap(px(8.))
                    .child(
                        v_flex().text_size(px(14.)).line_height(px(20.)).child("Read-only download link").child(
                            div()
                                .mt(px(4.))
                                .h(px(34.))
                                .px(px(8.))
                                .flex()
                                .items_center()
                                .rounded(px(6.))
                                .border_1()
                                .border_color(p.border)
                                .bg(p.background)
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .child(div().min_w_0().truncate().child(url)),
                        ),
                    )
                    // The two buttons touch, as Electron's inline pair does.
                    .child(
                        h_flex()
                            .child(office_button("office-copy-link", "Copy link", false, &p).on_click(cx.listener(move |w, _, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                                w.office_notice("Link copied.", cx);
                            })))
                            .child(office_button("office-revoke-link", "Revoke link", busy, &p).when(!busy, |el| {
                                el.on_click(cx.listener(move |w, _, window, cx| w.manage_snapshot(Manage::RevokeLink(id.clone()), window, cx)))
                            })),
                    ),
            );
        }
        col.into_any_element()
    }

    /// `CloudAreaPicker`: "Upload destination" (default "Default cloud") or
    /// "Organize snapshot in" (default "Choose an area"), as wide as its
    /// words, with the chips and "New area" under it when open.
    fn office_area_picker(&self, which: AreaMenu, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let busy = self.cloud_office.busy;
        let Some(d) = self.cloud_office.dialog.as_ref() else { return div().into_any_element() };
        let (kicker, default) = match which {
            AreaMenu::Upload => ("Upload destination", "Default cloud"),
            AreaMenu::Organize => ("Organize snapshot in", "Choose an area"),
        };
        let areas = self.office_scope().and_then(|s| self.cloud.listing(&s).map(|l| l.areas.clone())).unwrap_or_default();
        let selected = d.area.clone();
        let label = selected.as_ref().and_then(|id| areas.iter().find(|a| &a.id == id)).map(|a| a.label.clone()).unwrap_or_else(|| default.into());
        let open = d.area_menu == Some(which);
        let id = match which {
            AreaMenu::Upload => "office-upload-area",
            AreaMenu::Organize => "office-organize-area",
        };
        let mut chips = vec![(None::<String>, default.to_string())];
        chips.extend(areas.iter().map(|a| (Some(a.id.clone()), a.label.clone())));
        v_flex()
            .items_start()
            .child(
                h_flex()
                    .id(id)
                    .max_w_full()
                    .h(px(32.))
                    .gap(px(7.2))
                    .pl(px(10.4))
                    .pr(px(8.8))
                    .rounded(px(7.))
                    .border_1()
                    .border_color(if open { mix(p.blue, p.border, 0.66) } else { p.border })
                    .bg(mix(p.background, p.surface2, 0.72))
                    .text_size(px(11.5))
                    .text_color(p.muted)
                    .when(busy, |el| el.opacity(0.42))
                    .when(!busy, |el| el.cursor_pointer())
                    .child(div().flex_none().text_color(p.muted.opacity(0.82)).child(kicker))
                    .child(div().min_w_0().truncate().text_color(p.foreground.opacity(0.85)).child(label))
                    .child(super::dialog_chrome::stroke_icon(super::dialog_chrome::PATH_CHEVRON_DOWN, if open { p.foreground } else { p.muted }, 13., 2.))
                    .when(!busy, |el| {
                        el.on_click(cx.listener(move |w, _, window, cx| {
                            let opening = w.cloud_office.dialog.as_ref().is_some_and(|d| d.area_menu != Some(which));
                            if let Some(d) = w.cloud_office.dialog.as_mut() {
                                d.area_menu = opening.then_some(which);
                            }
                            if opening {
                                w.ensure_area_input(window, cx);
                            }
                            cx.notify();
                        }))
                    }),
            )
            .when(open, |el| {
                let create = self.render_area_create(AreaTarget::Office, &p, cx);
                el.child(
                    v_flex()
                        .mt(px(6.))
                        .w(px(300.))
                        .p(px(8.))
                        .rounded(px(10.))
                        .border_1()
                        .border_color(p.border)
                        .bg(p.surface2)
                        .child(h_flex().gap(px(4.)).flex_wrap().children(chips.into_iter().map(|(area, label)| {
                            let on = area == selected;
                            div()
                                .id(SharedString::from(format!("office-area-{}", area.as_deref().unwrap_or("default"))))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(if on { p.foreground.opacity(0.25) } else { p.border })
                                .when(on, |el| el.bg(p.accent))
                                .px(px(8.))
                                .py(px(4.))
                                .text_size(px(11.))
                                .text_color(if on { p.foreground } else { p.muted })
                                .cursor_pointer()
                                .child(label)
                                .on_click(cx.listener(move |w, _, _, cx| {
                                    if let Some(d) = w.cloud_office.dialog.as_mut() {
                                        d.area = area.clone();
                                        d.area_menu = None;
                                    }
                                    cx.notify();
                                }))
                        })))
                        .children(create),
                )
            })
            .into_any_element()
    }
}

/// `BUTTON`: `px-3 py-2 rounded-md border border-border text-sm
/// hover:bg-accent disabled:opacity-40`.
fn office_button(id: impl Into<ElementId>, label: impl Into<SharedString>, disabled: bool, p: &Palette) -> Stateful<Div> {
    let p = *p;
    div()
        .id(id)
        .flex_none()
        .px(px(12.))
        .py(px(8.))
        .rounded(px(6.))
        .border_1()
        .border_color(p.border)
        .text_size(px(14.))
        .line_height(px(20.))
        .text_color(p.foreground)
        .when(disabled, |el| el.opacity(0.4))
        .when(!disabled, |el| el.cursor_pointer().hover(|s| s.bg(p.accent)))
        .child(label.into())
}

fn same_target(a: &Target, b: &Target) -> bool {
    a.meta.id == b.meta.id && a.scope.origin() == b.scope.origin() && a.scope.user == b.scope.user
}

/// `downloadWebDocument`: a copy in Downloads under a free name.
fn save_download(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = super::cloud_strip::downloads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = markie_cloud::sync::free_path(&dir, std::path::Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("Cloud document"), |p| std::fs::symlink_metadata(p).is_ok())
        .ok_or("No unused filename for the download.")?;
    markie_cloud::assets::create_copy(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, CloudError> {
    if !markie_cloud::platform::supported_name(&name(path)).is_some()
        || !std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES as u64)
    {
        return Err(CloudError::Invalid(
            "This document format or size cannot be shared yet.".into(),
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| CloudError::Invalid("The local document could not be read.".into()))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(CloudError::TooLarge);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{job_error, role_word};
    use markie_cloud::CloudError;
    use markie_cloud::docs::Role;

    #[test]
    fn rows_print_the_servers_role_word() {
        // document-cloud-dialog.tsx prints `entry.role` and `member.role` as sent.
        assert_eq!(role_word(Role::Owner), "owner");
        assert_eq!(role_word(Role::Editor), "editor");
        assert_eq!(role_word(Role::Viewer), "viewer");
    }

    #[test]
    fn job_errors_read_like_run() {
        let offline = job_error(&CloudError::Offline);
        assert_eq!(offline, "Cloud documents could not be reached. Your edits were kept; check your connection and retry.");
        let said = CloudError::Status { status: 403, message: Some("Only the owner can share.".into()), code: None };
        assert_eq!(job_error(&said), "Only the owner can share.");
        let stale = CloudError::Status { status: 409, message: Some("stale".into()), code: None };
        assert_eq!(job_error(&stale), "Another editor saved a newer cloud version. Your local edits were kept.");
    }
}
