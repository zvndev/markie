//! The Share button's sheet: `src/components/share-gate.tsx` (which
//! prerequisite is missing, and the action that clears it) and, once the
//! document has a cloud copy, `share-dialog.tsx`, shaped like Google Docs':
//! add people at the top, who has access in the middle, general access below,
//! the link in the footer. Also the recipient's side (`share-people.tsx`):
//! share requests and accepted or blocked people, which the Cloud page and
//! the account sheet embed with [`Workspace::render_share_requests`] and
//! [`Workspace::render_people_settings`].
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_cloud::collab::{color_for_name, runtime};
use markie_cloud::docs::Role;
use markie_cloud::error::CloudError;
use markie_cloud::sharing::view::{self as sv, is_email};
use markie_cloud::sharing::{AddStatus, People, PeopleClient, ShareAccess, ShareContact, ShareMember, ShareRequest, SharesClient};
use markie_cloud::CloudClient;
use markie_core::theme::Tone;
use markie_core::theme::pinned_look::{self, LookState, OwnLook};
use serde_json::Value;

use super::collab::{CloudDoc, avatar};
use super::{DocKind, Workspace};
use crate::themes::{self, Palette, hex, mix};

#[derive(Clone, PartialEq)]
enum Gate {
    /// The cloud copy is known; the server has not said who we are yet.
    Loading,
    Unsaved,
    SignedOut,
    Local,
    Ready,
    /// The document's server has no session here, or syncing failed.
    Error(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Menu {
    Suggestions,
    InviteRole,
    General,
    Row(usize),
}

pub(super) struct ShareSheet {
    gate: Gate,
    doc: Option<CloudDoc>,
    file_name: String,
    body: String,
    access: Option<ShareAccess>,
    members: Option<Vec<ShareMember>>,
    public_url: Option<String>,
    rotated: Option<String>,
    loaded: bool,
    contacts: Vec<ShareContact>,
    pending: Vec<String>,
    query: Entity<InputState>,
    /// Whether the field shows its placeholder (only with no chips).
    placeholder_on: bool,
    role: Role,
    menu: Option<Menu>,
    highlight: usize,
    error: Option<String>,
    flash: Option<String>,
    busy: bool,
    link_busy: bool,
    copied: bool,
    row_busy: Option<String>,
    /// "Readers see my look": what the server says is pinned (None until it
    /// has answered, and no row is shown), a change in flight, and whether
    /// the last one failed.
    look: Option<Value>,
    look_busy: bool,
    look_failed: bool,
    /// The sign-in form the gate shows in place when signed out.
    sign_in: Option<Entity<super::account::SignInForm>>,
    /// "Upload destination" for Sync and share, and whether its menu is open.
    upload_area: Option<String>,
    area_open: bool,
    /// Sync and share is running for this file.
    syncing: Option<std::path::PathBuf>,
    _subs: Vec<Subscription>,
    _task: Option<Task<()>>,
}

/// `GET /api/docs/:id/theme`: the pinned look as the server holds it, or
/// None when it could not be asked.
async fn read_look(client: &CloudClient, id: &str) -> Option<Value> {
    let path = format!("/api/docs/{}/theme", markie_cloud::client::seg(id));
    client.get(&path).await.ok().filter(|a| a.ok()).and_then(|a| a.json().ok())
}

impl ShareSheet {
    /// A new area made in the gate's picker becomes the upload destination.
    pub(super) fn set_upload_area(&mut self, area: Option<String>) {
        self.upload_area = area;
        self.area_open = false;
    }
}

/// The outer widths Chromium gives the two selects in 0.9.7: each is as wide
/// as its longest option ("Remove access" at 12.5 pt; "Anyone with the link"
/// at 13.5 pt medium) plus its padding.
const ROLE_SELECT_W: f32 = 157.;
const GENERAL_SELECT_W: f32 = 160.;

fn error_text(e: &CloudError, fallback: &str) -> String {
    match e {
        CloudError::Status { message: Some(m), .. } if !m.is_empty() => m.clone(),
        _ => fallback.to_string(),
    }
}

impl Workspace {
    /// The Share button (title bar): always opens, and says what is missing.
    pub(crate) fn open_share(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Add people by email"));
        let subs = vec![cx.subscribe_in(&query, window, |w, state, ev: &InputEvent, window, cx| w.share_field_event(state, ev, window, cx))];
        let file_name = self.doc.as_ref().and_then(|d| d.path.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into());
        let body = self.current_text(cx);
        // An Office file shares through its own snapshot dialog, as the
        // document workspace's share does (document-workspace-host.tsx).
        if let Some(open) = self.doc.as_ref()
            && !matches!(open.kind, DocKind::Text { .. })
            && !self.has_cloud_copy()
            && markie_cloud::platform::supported_name(&super::cloud::name(&open.path)).is_some()
        {
            self.show_office_upload(window, cx);
            return;
        }
        let gate = self.share_gate(cx);
        let doc = self.collab.cloud.clone();
        self.collab.share = Some(ShareSheet {
            gate: gate.clone(),
            doc,
            file_name,
            body,
            access: None,
            members: None,
            public_url: None,
            rotated: None,
            loaded: false,
            contacts: Vec::new(),
            pending: Vec::new(),
            query: query.clone(),
            placeholder_on: true,
            role: Role::Viewer,
            menu: None,
            highlight: 0,
            error: None,
            flash: None,
            busy: false,
            link_busy: false,
            copied: false,
            row_busy: None,
            look: None,
            look_busy: false,
            look_failed: false,
            sign_in: None,
            upload_area: None,
            area_open: false,
            syncing: None,
            _subs: subs,
            _task: None,
        });
        self.share_enter_gate(gate, Some(window), cx);
        cx.notify();
    }

    /// share-gate.tsx `resolve`: which prerequisite is missing.
    fn share_gate(&self, cx: &App) -> Gate {
        let Some(open) = self.doc.as_ref() else { return Gate::Unsaved };
        let saved = matches!(open.kind, DocKind::Text { .. } | DocKind::Office(_) | DocKind::Html);
        if !saved {
            return Gate::Unsaved;
        }
        let primary_in = super::account::signed_in_user(cx).is_some();
        let binding = self.cloud.binding_key(&open.path).and_then(|k| self.cloud.bindings.get(&k)).filter(|b| b.record.cloud_doc_id.is_some());
        let Some(binding) = binding else {
            if self.has_cloud_copy() {
                return if self.collab.cloud.is_some() { Gate::Ready } else { Gate::Loading };
            }
            return if primary_in { Gate::Local } else { Gate::SignedOut };
        };
        let origin = binding.origin().to_string();
        let primary = origin == self.cloud.primary_origin();
        let session = self.cloud.scope(&origin).is_some_and(|s| s.matches(binding));
        // Signed out of the primary server says nothing about a document on
        // another server this person is signed in to.
        if !primary_in && (primary || !session) {
            return Gate::SignedOut;
        }
        if !primary && !session {
            return Gate::Error(sv::server_sign_in_line(&origin));
        }
        if self.collab.cloud.is_some() { Gate::Ready } else { Gate::Loading }
    }

    fn share_enter_gate(&mut self, gate: Gate, window: Option<&mut Window>, cx: &mut Context<Self>) {
        let Some(s) = self.collab.share.as_mut() else { return };
        s.gate = gate.clone();
        match gate {
            Gate::Ready => {
                s.doc = self.collab.cloud.clone();
                let query = s.query.clone();
                self.share_load(cx);
                if let Some(window) = window {
                    query.update(cx, |q, cx| q.focus(window, cx));
                }
            }
            Gate::Loading => self.collab_recheck(cx),
            Gate::SignedOut => {
                if s.sign_in.is_none()
                    && let (Some(window), Some(store)) = (window, super::account::AccountStore::global(cx))
                {
                    let form = cx.new(|cx| super::account::SignInForm::new(store, markie_cloud::auth_errors::SignInReason::Share, window, cx));
                    if let Some(s) = self.collab.share.as_mut() {
                        s.sign_in = Some(form);
                    }
                }
            }
            _ => {}
        }
    }

    /// The session changed under the sheet: resolve the gate again in place,
    /// as share-gate.tsx does from its `status` subscription.
    pub(super) fn share_account_changed(&mut self, cx: &mut Context<Self>) {
        let Some(s) = self.collab.share.as_ref() else { return };
        if s.gate == Gate::Ready || s.syncing.is_some() {
            return;
        }
        let gate = self.share_gate(cx);
        self.share_enter_gate(gate, None, cx);
        cx.notify();
    }

    /// "Try again" on the gate's error.
    fn share_retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let gate = self.share_gate(cx);
        self.share_enter_gate(gate, Some(window), cx);
        cx.notify();
    }

    /// `syncThenShare`: turn sync on with the chosen destination, then show
    /// the dialog once the server says who this person is.
    fn share_sync_then_share(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
        let Some(s) = self.collab.share.as_mut() else { return };
        if s.syncing.is_some() {
            return;
        }
        let area = s.upload_area.clone();
        s.area_open = false;
        if !self.persist_cloud_choice(&path, window, cx) {
            if let Some(s) = self.collab.share.as_mut() {
                s.gate = Gate::Error("Couldn't sync this file. Check your connection and try again.".into());
            }
            cx.notify();
            return;
        }
        if let Some(s) = self.collab.share.as_mut() {
            s.syncing = Some(path.clone());
        }
        self.cloud.enable_area = Some(area);
        self.cloud_text(path.clone(), super::cloud::TextAction::Enable, None, cx);
        // Refused before any request (no session for that server, a sync
        // already running): say so on the gate instead of waiting forever.
        if !self.cloud.busy.contains(&path) {
            self.cloud.enable_area = None;
            let message = self.cloud.notice.clone().unwrap_or_else(|| "Couldn't sync this file. Check your connection and try again.".into());
            self.share_sync_done(&path, Some(message), cx);
        }
        cx.notify();
    }

    /// Sync on finished (`cloud_text`): an error stays on the gate; success
    /// waits for the server's answer about access, then shows the dialog.
    pub(super) fn share_sync_done(&mut self, path: &std::path::Path, error: Option<String>, cx: &mut Context<Self>) {
        let Some(s) = self.collab.share.as_mut() else { return };
        if s.syncing.as_deref() != Some(path) {
            return;
        }
        s.syncing = None;
        match error {
            Some(e) => s.gate = Gate::Error(e),
            None => {
                let gate = self.share_gate(cx);
                self.share_enter_gate(gate, None, cx);
            }
        }
        cx.notify();
    }

    /// "Manage" on a Cloud page row: the share dialog for that cloud
    /// document, whether or not it is the open one (handleManageShare).
    pub(super) fn manage_cloud_share(&mut self, doc_id: String, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let open_is_it = self.collab.cloud.as_ref().is_some_and(|c| c.doc_id == doc_id);
        if open_is_it {
            self.open_share(window, cx);
            return;
        }
        let Some(scope) = self.cloud.selected_scope() else { return };
        let user = super::account::signed_in_user(cx)
            .filter(|u| u.id == scope.user)
            .unwrap_or_else(|| markie_cloud::auth::MarkieUser { id: scope.user.clone(), email: String::new(), name: None });
        let account = Arc::new(super::collab::CloudAccount { client: Arc::new(scope.client.clone()), user });
        let doc = super::collab::CloudDoc { account, doc_id, name: name.clone() };
        self.share_open_ready(doc, name, String::new(), window, cx);
    }

    /// The dialog for a cloud document whose access is already known.
    pub(super) fn share_open_ready(&mut self, doc: super::collab::CloudDoc, name: String, body: String, window: &mut Window, cx: &mut Context<Self>) {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Add people by email"));
        let subs = vec![cx.subscribe_in(&query, window, |w, state, ev: &InputEvent, window, cx| w.share_field_event(state, ev, window, cx))];
        self.collab.share = Some(ShareSheet {
            gate: Gate::Ready,
            doc: Some(doc),
            file_name: name,
            body,
            access: None,
            members: None,
            public_url: None,
            rotated: None,
            loaded: false,
            contacts: Vec::new(),
            pending: Vec::new(),
            query: query.clone(),
            placeholder_on: true,
            role: Role::Viewer,
            menu: None,
            highlight: 0,
            error: None,
            flash: None,
            busy: false,
            link_busy: false,
            copied: false,
            row_busy: None,
            look: None,
            look_busy: false,
            look_failed: false,
            sign_in: None,
            upload_area: None,
            area_open: false,
            syncing: None,
            _subs: subs,
            _task: None,
        });
        self.share_load(cx);
        query.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    /// Scene mode: the dialog has its people and link.
    #[cfg(feature = "scene")]
    pub(super) fn scene_share_loaded(&self) -> bool {
        self.collab.share.as_ref().is_some_and(|s| s.loaded)
    }

    /// Scene mode: chips, typed text, the invite role and an open menu, set
    /// the way the field's own handlers set them.
    #[cfg(feature = "scene")]
    pub(super) fn scene_share_fill(&mut self, pending: &[String], query: &str, editor: bool, menu: &str, window: &mut Window, cx: &mut Context<Self>) {
        for address in pending {
            self.share_add_pending(address, window, cx);
        }
        let Some(s) = self.collab.share.as_mut() else { return };
        s.role = if editor { Role::Editor } else { Role::Viewer };
        let q = s.query.clone();
        if !query.is_empty() {
            q.update(cx, |st, cx| st.set_value(query, window, cx));
        }
        if let Some(s) = self.collab.share.as_mut() {
            s.menu = match menu {
                "role" => Some(Menu::InviteRole),
                "general" => Some(Menu::General),
                "suggestions" => Some(Menu::Suggestions),
                "row0" => Some(Menu::Row(0)),
                "row1" => Some(Menu::Row(1)),
                _ => s.menu,
            };
        }
        cx.notify();
    }

    /// The server answered while the sheet waited: show the dialog.
    pub(super) fn share_cloud_ready(&mut self, cx: &mut Context<Self>) {
        let cloud = self.collab.cloud.clone();
        let Some(s) = self.collab.share.as_mut() else { return };
        if s.gate != Gate::Loading || cloud.is_none() {
            return;
        }
        s.gate = Gate::Ready;
        s.doc = cloud;
        self.share_load(cx);
    }

    fn close_share(&mut self, cx: &mut Context<Self>) {
        self.collab.share = None;
        cx.notify();
    }

    fn share_client(&self) -> Option<(Arc<CloudClient>, String)> {
        let d = self.collab.share.as_ref()?.doc.as_ref()?;
        Some((d.account.client.clone(), d.doc_id.clone()))
    }

    /// Access first; the public link only once access says this person
    /// manages the document (the server answers anyone else 403).
    fn share_load(&mut self, cx: &mut Context<Self>) {
        let Some((client, id)) = self.share_client() else { return };
        let task = runtime::handle().spawn(async move {
            let shares = SharesClient::new(&client);
            let access = shares.access(&id).await.ok();
            let members = shares.list(&id).await.ok();
            let manage = access.as_ref().is_some_and(|a| a.can_manage);
            let url = if manage { shares.public_link(&id).await.ok().flatten() } else { None };
            let contacts = if manage { shares.contacts().await.unwrap_or_default() } else { vec![] };
            // What look is pinned, for the owner's switch (`docLookState`).
            let look = if manage { read_look(&client, &id).await } else { None };
            (access, members, url, contacts, look)
        });
        let t = cx.spawn(async move |this, cx| {
            let Ok((access, members, url, contacts, look)) = task.await else { return };
            this.update(cx, |w, cx| {
                if let Some(s) = w.collab.share.as_mut() {
                    s.look = look;
                    s.access = access;
                    s.members = Some(members.unwrap_or_default());
                    s.public_url = url;
                    s.contacts = contacts;
                    s.loaded = true;
                }
                cx.notify();
            })
            .ok();
        });
        if let Some(s) = self.collab.share.as_mut() {
            s._task = Some(t);
        }
    }

    fn share_taken(&self, cx: &App) -> HashSet<String> {
        let Some(s) = self.collab.share.as_ref() else { return HashSet::new() };
        let mut set: HashSet<String> = s.pending.iter().cloned().collect();
        for m in s.members.iter().flatten() {
            set.insert(m.email.to_lowercase());
        }
        if let Some(d) = &s.doc {
            set.insert(d.account.user.email.to_lowercase());
        }
        let _ = cx;
        set
    }

    fn share_suggestions(&self, cx: &App) -> Vec<ShareContact> {
        let Some(s) = self.collab.share.as_ref() else { return vec![] };
        let q = s.query.read(cx).value().to_string();
        let taken = self.share_taken(cx);
        sv::suggestions(&s.contacts, &q, &taken).into_iter().cloned().collect()
    }

    fn share_add_pending(&mut self, address: &str, window: &mut Window, cx: &mut Context<Self>) {
        let clean = address.trim().to_lowercase();
        if clean.is_empty() {
            return;
        }
        let taken = self.share_taken(cx);
        let Some(s) = self.collab.share.as_mut() else { return };
        if !is_email(&clean) {
            s.error = Some(format!("\"{}\" is not an email address.", address.trim()));
            cx.notify();
            return;
        }
        s.error = None;
        s.flash = None;
        if !taken.contains(&clean) {
            s.pending.push(clean);
        }
        s.menu = None;
        s.highlight = 0;
        let q = s.query.clone();
        q.update(cx, |st, cx| {
            st.set_value("", window, cx);
            st.focus(window, cx);
        });
        cx.notify();
    }

    fn share_field_event(&mut self, state: &Entity<InputState>, ev: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        let value = state.read(cx).value().to_string();
        match ev {
            InputEvent::Change => {
                // `,` and `;` finish an address, as in the dialog.
                if let Some(cut) = value.find([',', ';']) {
                    let head = value[..cut].to_string();
                    if !head.trim().is_empty() {
                        self.share_add_pending(&head, window, cx);
                    } else {
                        state.update(cx, |s, cx| s.set_value("", window, cx));
                    }
                    return;
                }
                if let Some(s) = self.collab.share.as_mut() {
                    s.menu = Some(Menu::Suggestions);
                    s.highlight = 0;
                }
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {
                let sugg = self.share_suggestions(cx);
                let menu = self.collab.share.as_ref().and_then(|s| s.menu);
                let hl = self.collab.share.as_ref().map(|s| s.highlight).unwrap_or(0);
                if menu == Some(Menu::Suggestions) && !sugg.is_empty() {
                    let email = sugg[hl.min(sugg.len() - 1)].email.clone();
                    self.share_add_pending(&email, window, cx);
                } else if !value.trim().is_empty() {
                    self.share_add_pending(&value, window, cx);
                } else if self.collab.share.as_ref().is_some_and(|s| !s.pending.is_empty()) {
                    self.share_send(cx);
                }
            }
            InputEvent::Focus => {
                if let Some(s) = self.collab.share.as_mut() {
                    s.menu = Some(Menu::Suggestions);
                }
                cx.notify();
            }
            InputEvent::Blur => {}
        }
    }

    fn share_cancel_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = self.collab.share.as_mut() else { return };
        s.pending.clear();
        s.menu = None;
        s.error = None;
        let q = s.query.clone();
        q.update(cx, |st, cx| st.set_value("", window, cx));
        cx.notify();
    }

    fn share_send(&mut self, cx: &mut Context<Self>) {
        let Some((client, id)) = self.share_client() else { return };
        let Some(s) = self.collab.share.as_mut() else { return };
        if !s.access.as_ref().is_some_and(|a| a.can_manage) {
            s.error = Some("Only the owner can invite people.".into());
            cx.notify();
            return;
        }
        let to_send = sv::to_send(&s.pending, &s.query.read(cx).value());
        if to_send.is_empty() {
            return;
        }
        s.busy = true;
        s.error = None;
        s.flash = None;
        let role = s.role;
        let sent = to_send.len();
        let task = runtime::handle().spawn(async move {
            let shares = SharesClient::new(&client);
            let mut out = Vec::new();
            for target in to_send {
                out.push((target.clone(), shares.add(&id, &target, role).await));
            }
            out
        });
        cx.spawn(async move |this, cx| {
            let Ok(results) = task.await else { return };
            this.update(cx, |w, cx| {
                let (mut failed, mut shared, mut requested, mut invited) = (vec![], vec![], vec![], vec![]);
                for (email, r) in results {
                    match r {
                        Ok(AddStatus::Member) => shared.push(email),
                        Ok(AddStatus::Requested) => requested.push(email),
                        Ok(AddStatus::Invited) => invited.push(email),
                        Err(e) => {
                            let m = error_text(&e, "Couldn't share the doc");
                            failed.push((email, m));
                        }
                    }
                }
                let any = !(shared.is_empty() && requested.is_empty() && invited.is_empty());
                if let Some(s) = w.collab.share.as_mut() {
                    s.busy = false;
                    // Whatever failed stays as a chip, to fix and send again.
                    s.pending = failed.iter().map(|(e, _)| e.clone()).collect();
                    s.error = sv::send_failures(&failed, sent);
                    s.flash = sv::send_summary(&shared, &requested, &invited);
                }
                if any {
                    w.share_load(cx);
                    w.collab_recheck(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn share_member_call(&mut self, key: String, remove: bool, target: String, role: Role, cx: &mut Context<Self>) {
        let Some((client, id)) = self.share_client() else { return };
        let Some(s) = self.collab.share.as_mut() else { return };
        if !s.access.as_ref().is_some_and(|a| a.can_manage) {
            s.error = Some(if remove { "Only the owner can remove access." } else { "Only the owner can change what people can do." }.into());
            cx.notify();
            return;
        }
        s.row_busy = Some(key);
        s.error = None;
        s.menu = None;
        let task = runtime::handle().spawn(async move {
            let shares = SharesClient::new(&client);
            if remove {
                shares.remove(&id, &target).await.map(|rotated| (true, rotated))
            } else {
                // Changing a role reuses the invite call, which upserts.
                shares.add(&id, &target, role).await.map(|_| (false, None))
            }
        });
        cx.spawn(async move |this, cx| {
            let Ok(r) = task.await else { return };
            this.update(cx, |w, cx| {
                if let Some(s) = w.collab.share.as_mut() {
                    s.row_busy = None;
                    match &r {
                        Ok((_, Some(url))) => {
                            s.public_url = Some(url.clone());
                            s.rotated = Some(url.clone());
                        }
                        Ok(_) => {}
                        Err(e) => s.error = Some(if remove { "Couldn't remove their access.".into() } else { error_text(e, "Couldn't change their access") }),
                    }
                }
                if r.is_ok() {
                    w.share_load(cx);
                    w.collab_recheck(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// "Anyone with the link" publishes at once; Restricted takes it back.
    /// The look this account is using right now (`ownLook`): the person's
    /// own, even while an owner's pinned one is on screen.
    fn share_own_look(&self, cx: &App) -> OwnLook {
        let store = self.own_theme.clone().unwrap_or_else(|| themes::store(cx));
        let tone = if gpui_kit::component::Theme::global(cx).mode.is_dark() { Tone::Dark } else { Tone::Light };
        pinned_look::own_look(&store, tone)
    }

    /// Pin this account's look to the document, or unpin it (`setDocLook`),
    /// then ask the server again what is pinned.
    fn share_set_look(&mut self, pin: bool, cx: &mut Context<Self>) {
        let Some((client, id)) = self.share_client() else { return };
        let body = pinned_look::pin_body(pin.then(|| self.share_own_look(cx)).as_ref());
        let Some(s) = self.collab.share.as_mut() else { return };
        if s.look_busy {
            return;
        }
        s.look_busy = true;
        s.look_failed = false;
        let task = runtime::handle().spawn(async move {
            let path = format!("/api/docs/{}/theme", markie_cloud::client::seg(&id));
            let ok = client.put(&path, body).await.is_ok_and(|a| a.ok());
            (ok, read_look(&client, &id).await)
        });
        cx.spawn(async move |this, cx| {
            let Ok((ok, look)) = task.await else { return };
            this.update(cx, |w, cx| {
                if let Some(s) = w.collab.share.as_mut() {
                    s.look_busy = false;
                    s.look_failed = !ok;
                    s.look = look;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn share_set_general(&mut self, public: bool, cx: &mut Context<Self>) {
        let Some((client, id)) = self.share_client() else { return };
        let Some(s) = self.collab.share.as_mut() else { return };
        s.menu = None;
        if !s.access.as_ref().is_some_and(|a| a.can_manage) {
            s.error = Some("Only the owner can change general access.".into());
            cx.notify();
            return;
        }
        if public && sv::is_live_doc_name(&s.file_name) {
            s.error = Some(sv::LIVE_DOC_PRIVATE_LINE.into());
            cx.notify();
            return;
        }
        s.link_busy = true;
        s.error = None;
        s.rotated = None;
        let task = runtime::handle().spawn(async move {
            let shares = SharesClient::new(&client);
            if public { shares.create_public_link(&id).await.map(Some) } else { shares.revoke_public_link(&id).await.map(|_| None) }
        });
        cx.spawn(async move |this, cx| {
            let Ok(r) = task.await else { return };
            this.update(cx, |w, cx| {
                if let Some(s) = w.collab.share.as_mut() {
                    s.link_busy = false;
                    match r {
                        Ok(url) => s.public_url = url,
                        Err(_) => {
                            s.error = Some(if public { "Couldn't turn on the link. Check your connection and try again." } else { "Couldn't turn off the link. Check your connection and try again." }.into())
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn share_copy(&mut self, cx: &mut Context<Self>) {
        let Some(s) = self.collab.share.as_mut() else { return };
        let Some(d) = &s.doc else { return };
        let link = sv::link_to_copy(d.account.client.origin(), &d.doc_id, &s.file_name, s.public_url.as_deref());
        cx.write_to_clipboard(ClipboardItem::new_string(link));
        s.copied = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            this.update(cx, |w, cx| {
                if let Some(s) = w.collab.share.as_mut() {
                    s.copied = false;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    // ------------------------------------------------------------ render

    pub(super) fn render_share(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let gate = self.collab.share.as_ref()?.gate.clone();
        let p = themes::palette(cx);
        let panel = if gate == Gate::Ready { self.render_share_dialog(&p, window, cx) } else { self.render_share_gate(&gate, &p, cx) };
        Some(
            div()
                .id("share-scrim")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                // `.markie-scrim` is 58% under a blur; without a backdrop blur
                // the app's dialogs use 72% (dialog_chrome `scrim`).
                .bg(p.background.opacity(0.72))
                .occlude()
                .on_mouse_down(MouseButton::Left, cx.listener(|w, _, _, cx| w.close_share(cx)))
                .on_key_down(cx.listener(|w, ev: &KeyDownEvent, _, cx| {
                    if ev.keystroke.key == "escape" {
                        w.close_share(cx);
                    }
                }))
                .child(panel)
                .into_any_element(),
        )
    }

    fn share_panel(p: &Palette) -> Div {
        let (bg, border) = if p.dark { (p.surface2, p.border) } else { (mix(p.background, p.surface2, 0.58), p.border.opacity(0.6)) };
        div()
            .bg(bg)
            .border_1()
            .border_color(border)
            .shadow(vec![BoxShadow { color: hsla(0., 0., 0., if p.dark { 0.26 } else { 0.10 }), offset: point(px(0.), px(if p.dark { 18. } else { 12. })), blur_radius: px(if p.dark { 44. } else { 32. }), spread_radius: px(0.), inset: false }])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
    }

    fn share_close_x(id: &'static str, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id(id)
            .size(px(24.))
            .rounded(px(6.))
            .flex()
            .items_center()
            .justify_center()
            .text_color(p.muted)
            .hover(|s| s.text_color(p.foreground).bg(p.accent.opacity(0.58)))
            .cursor_pointer()
            .child("×")
            .on_click(cx.listener(|w, _, _, cx| w.close_share(cx)))
    }

    fn render_share_gate(&mut self, gate: &Gate, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let (name, sign_in, syncing, area_open, upload_area) = match self.collab.share.as_ref() {
            Some(s) => (s.file_name.clone(), s.sign_in.clone(), s.syncing.is_some(), s.area_open, s.upload_area.clone()),
            None => return div().into_any_element(),
        };
        // Signed out: the sign-in form in place (share-gate.tsx), which the
        // session subscription resolves into the next stage.
        if let (Gate::SignedOut, Some(form)) = (gate, sign_in) {
            return Self::share_panel(&p)
                .w(px(400.))
                .rounded(px(12.))
                .p(px(20.))
                .child(h_flex().justify_end().mt(px(-4.)).mr(px(-4.)).child(Self::share_close_x("share-gate-close", &p, cx)))
                .child(form)
                .into_any_element();
        }
        let (line, action): (String, Option<&str>) = match gate {
            Gate::Loading | Gate::SignedOut => ("Checking this document…".into(), None),
            Gate::Unsaved => ("Save this document to a file before you share it.".into(), None),
            Gate::Local => (
                format!("{name} is only on this Mac. Syncing it to your account is what makes a share link possible."),
                Some(if syncing { "Syncing…" } else { "Sync and share" }),
            ),
            Gate::Error(message) => (message.clone(), Some("Try again")),
            Gate::Ready => unreachable!(),
        };
        let local = *gate == Gate::Local;
        let retry = matches!(gate, Gate::Error(_));
        let areas = self.cloud.primary_scope().and_then(|s| self.cloud.listing(&s).map(|l| l.areas.clone())).unwrap_or_default();
        let area_label = upload_area.as_ref().and_then(|id| areas.iter().find(|a| &a.id == id)).map(|a| a.label.clone()).unwrap_or_else(|| "Default cloud".into());
        Self::share_panel(&p)
            .w(px(440.))
            .rounded(px(12.))
            .p(px(20.))
            .child(
                h_flex()
                    .items_start()
                    .justify_between()
                    .gap(px(12.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child("Share this document"))
                    .child(Self::share_close_x("share-gate-close", &p, cx)),
            )
            .child(div().mt(px(8.)).text_size(px(12.5)).line_height(px(20.)).text_color(p.muted).child(line))
            .when(local, |el| {
                // CloudAreaPicker "Upload destination", default "Default cloud".
                let mut chips = vec![("share-area-default".to_string(), None::<String>, "Default cloud".to_string())];
                chips.extend(areas.iter().map(|a| (format!("share-area-{}", a.id), Some(a.id.clone()), a.label.clone())));
                el.child(
                    v_flex()
                        .mt(px(8.))
                        // `inline-block max-w-full`: the button is as wide as its words.
                        .items_start()
                        .child(
                            h_flex()
                                .id("share-upload-area")
                                .max_w_full()
                                .h(px(32.))
                                .gap(px(7.2))
                                .pl(px(10.4))
                                .pr(px(8.8))
                                .rounded(px(7.))
                                .border_1()
                                .border_color(if area_open { mix(p.blue, p.border, 0.66) } else { p.border })
                                .bg(mix(p.background, p.surface2, 0.72))
                                .text_size(px(11.5))
                                .text_color(p.muted)
                                .when(syncing, |el| el.opacity(0.4))
                                .when(!syncing, |el| el.cursor_pointer())
                                .child(div().flex_none().text_color(p.muted.opacity(0.82)).child("Upload destination"))
                                .child(div().min_w_0().truncate().text_color(p.foreground.opacity(0.85)).child(area_label))
                                .child("⌄")
                                .on_click(cx.listener(move |w, _, window, cx| {
                                    if let Some(s) = w.collab.share.as_mut()
                                        && s.syncing.is_none()
                                    {
                                        s.area_open = !s.area_open;
                                    }
                                    if w.collab.share.as_ref().is_some_and(|s| s.area_open) {
                                        w.ensure_area_input(window, cx);
                                    }
                                    cx.notify();
                                })),
                        )
                        .when(area_open, |el| {
                            let create = self.render_area_create(super::cloud_page::AreaTarget::Share, &p, cx);
                            el.child(
                                v_flex().mt(px(6.)).p(px(8.)).rounded(px(10.)).border_1().border_color(p.border).bg(p.surface2).child(h_flex().gap(px(4.)).flex_wrap().children(chips.into_iter().map(|(id, area, label)| {
                                    let on = area == upload_area;
                                    div()
                                        .id(SharedString::from(id))
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
                                            if let Some(s) = w.collab.share.as_mut() {
                                                s.upload_area = area.clone();
                                                s.area_open = false;
                                            }
                                            cx.notify();
                                        }))
                                }))).children(create),
                            )
                        }),
                )
            })
            .when_some(action, |el, label| {
                el.child(
                    h_flex().mt(px(16.)).justify_end().child(
                        div()
                            .id("share-gate-action")
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .bg(p.accent)
                            .text_size(px(12.5))
                            .text_color(p.foreground)
                            .when(syncing, |el| el.opacity(0.6))
                            .when(!syncing, |el| el.cursor_pointer())
                            .child(label.to_string())
                            .on_click(cx.listener(move |w, _, window, cx| {
                                if retry {
                                    w.share_retry(window, cx);
                                } else if local {
                                    w.share_sync_then_share(window, cx);
                                }
                            })),
                    ),
                )
            })
            .into_any_element()
    }

    fn render_share_dialog(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let suggestions = self.share_suggestions(cx);
        let s = self.collab.share.as_ref().unwrap();
        let can_manage = s.access.as_ref().is_some_and(|a| a.can_manage);
        let query = s.query.clone();
        let to_send = sv::to_send(&s.pending, &query.read(cx).value());
        let inviting = !to_send.is_empty();
        let show_menu = s.menu == Some(Menu::Suggestions) && !suggestions.is_empty();
        let live_doc = sv::is_live_doc_name(&s.file_name);
        let public = s.public_url.is_some();
        let me = s.doc.as_ref().map(|d| d.account.user.clone());
        let notice = sv::local_files_notice(sv::local_asset_count(&s.body));
        let (role, highlight, menu, busy, link_busy, copied, loaded) = (s.role, s.highlight, s.menu, s.busy, s.link_busy, s.copied, s.loaded);
        let (error, flash, rotated, row_busy) = (s.error.clone(), s.flash.clone(), s.rotated.clone(), s.row_busy.clone());
        let members = s.members.clone().unwrap_or_default();
        let access = s.access.clone();
        let pending = s.pending.clone();
        let file_name = s.file_name.clone();
        let link = s.doc.as_ref().map(|d| sv::link_to_copy(d.account.client.origin(), &d.doc_id, &s.file_name, s.public_url.as_deref())).unwrap_or_default();
        let public_url = s.public_url.clone();
        let (look_answer, look_busy, look_failed) = (s.look.clone(), s.look_busy, s.look_failed);
        // Electron shows the row for a document on the account's own server
        // (`!server`), not one opened from another server.
        let on_main_server = s.doc.as_ref().is_some_and(|d| {
            super::account::AccountStore::global(cx).and_then(|a| a.read(cx).backend()).is_some_and(|(_, client)| client.origin() == d.account.client.origin())
        });
        let blue = p.blue;
        // `.markie-share-field:focus-within`: a blue border and a 1px blue
        // ring while the field has the caret (in the active window, as
        // Chromium only shows focus there).
        let field_focus = window.is_window_active() && query.read(cx).focus_handle(cx).is_focused(window);
        // `placeholder={pending.length ? "" : "Add people by email"}`.
        if let Some(s) = self.collab.share.as_mut()
            && s.placeholder_on != pending.is_empty()
        {
            s.placeholder_on = pending.is_empty();
            let text = if pending.is_empty() { "Add people by email" } else { "" };
            query.update(cx, |q, cx| q.set_placeholder(text, window, cx));
        }

        let field = div()
            .id("share-field")
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(5.6))
            .min_h(px(41.6))
            .px(px(9.6))
            .py(px(3.8))
            .bg(p.background)
            .border_1()
            .border_color(if field_focus { blue } else { p.border })
            .when(field_focus, |el| el.shadow(vec![BoxShadow { color: blue, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(1.), inset: false }]))
            .rounded(px(10.))
            .children(pending.iter().map(|addr| {
                let a = addr.clone();
                h_flex()
                    .gap(px(5.6))
                    .pl(px(3.2))
                    .pr(px(4.))
                    .py(px(2.4))
                    .rounded_full()
                    .border_1()
                    .border_color(p.border)
                    .bg(p.surface2)
                    .text_size(px(12.5))
                    .text_color(p.foreground)
                    .child(avatar(addr, hex(color_for_name(addr)), transparent_black(), 21.6, 9.).border_0())
                    .child(div().truncate().child(addr.clone()))
                    .child(
                        div()
                            .id(SharedString::from(format!("chip-x-{addr}")))
                            .size(px(17.6))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(p.muted)
                            .hover(|s| s.text_color(p.foreground).bg(p.fg(0.10)))
                            .cursor_pointer()
                            .child("×")
                            .on_click(cx.listener(move |w, _, window, cx| {
                                if let Some(s) = w.collab.share.as_mut() {
                                    s.pending.retain(|x| *x != a);
                                    let q = s.query.clone();
                                    q.update(cx, |st, cx| st.focus(window, cx));
                                }
                                cx.notify();
                            })),
                    )
            }))
            // GPUI Kit's input pads its text 10 pt; `.markie-share-input` pads
            // it 2.4 pt, so the text starts 13 pt in from the border.
            .child(div().flex_1().min_w(px(128.)).ml(px(-7.6)).mr(px(-9.6)).child(Input::new(&query).appearance(false).text_size(px(13.5))));

        let suggestions_menu = show_menu.then(|| {
            Self::share_menu_list(p)
                .absolute()
                .left_0()
                .right_0()
                .top(px(46.))
                .children(suggestions.iter().enumerate().map(|(i, c)| {
                    let email = c.email.clone();
                    let name = sv::who(c.name.as_deref(), &c.email);
                    h_flex()
                        .id(SharedString::from(format!("sugg-{i}")))
                        .gap(px(10.4))
                        .px(px(12.8))
                        .py(px(7.2))
                        .cursor_pointer()
                        .when(i == highlight, |el| el.bg(blue.opacity(0.14)))
                        .child(avatar(&name, hex(color_for_name(&name)), transparent_black(), 32., 11.5).border_0())
                        .child(
                            v_flex()
                                .min_w_0()
                                .flex_1()
                                .child(div().truncate().text_size(px(13.5)).text_color(p.foreground).child(name.clone()))
                                .when(c.name.is_some(), |el| el.child(div().truncate().text_size(px(12.)).text_color(p.muted).child(c.email.clone()))),
                        )
                        .on_mouse_down(MouseButton::Left, cx.listener(move |w, _, window, cx| {
                            cx.stop_propagation();
                            w.share_add_pending(&email, window, cx);
                        }))
                }))
        });

        let invite_row = inviting.then(|| {
            h_flex()
                .gap(px(8.))
                .mt(px(9.6))
                .child(Self::share_invite_role(sv::role_label(role), menu == Some(Menu::InviteRole), p).on_click(cx.listener(|w, _, _, cx| {
                    if let Some(s) = w.collab.share.as_mut() {
                        s.menu = if s.menu == Some(Menu::InviteRole) { None } else { Some(Menu::InviteRole) };
                    }
                    cx.notify();
                })))
                .child(div().flex_1().text_size(px(12.)).text_color(p.muted).child(sv::invite_role_line(role)))
                .child(self.share_pill_button("invite-cancel", "Cancel", false, false, p).on_click(cx.listener(|w, _, window, cx| w.share_cancel_invite(window, cx))))
                .child(self.share_pill_button("invite-send", if busy { "Sending…" } else { "Send" }, true, busy, p).on_click(cx.listener(|w, _, _, cx| w.share_send(cx))))
        });

        let mut rows: Vec<AnyElement> = Vec::new();
        if can_manage {
            if let Some(me) = &me {
                let name = me.name.as_ref().filter(|n| !n.is_empty()).map(|n| format!("{n} (you)")).unwrap_or_else(|| me.email.clone());
                let av = sv::who(me.name.as_deref(), &me.email);
                rows.push(Self::share_member_row(&av, &name, &me.email, false, p).child(div().flex_none().text_size(px(12.)).text_color(p.muted).child("Owner")).into_any_element());
            }
        }
        for (i, m) in members.iter().enumerate() {
            let key = if m.pending { m.email.clone() } else { m.user_id.clone().unwrap_or_else(|| m.email.clone()) };
            let name = sv::who(m.name.as_deref(), &m.email);
            let sub = sv::member_sub_line(m);
            let r = if m.role == Role::Editor { Role::Editor } else { Role::Viewer };
            let row = Self::share_member_row(&name, &name, &sub, m.pending || m.waiting, p);
            let row = if can_manage {
                let busy_row = row_busy.as_deref() == Some(key.as_str());
                row.child(self.share_select_button(format!("role-{i}"), sv::role_label(r), ROLE_SELECT_W, menu == Some(Menu::Row(i)), !busy_row, p, cx.listener(move |w, _, _, cx| {
                    if let Some(s) = w.collab.share.as_mut() {
                        s.menu = if s.menu == Some(Menu::Row(i)) { None } else { Some(Menu::Row(i)) };
                    }
                    cx.notify();
                })))
                .when(menu == Some(Menu::Row(i)), |el| {
                    let (k1, k2, k3) = (key.clone(), key.clone(), key.clone());
                    let (e1, e2) = (m.email.clone(), m.email.clone());
                    el.child(
                        Self::share_menu_list(p)
                            .absolute()
                            .right_0()
                            .top(px(40.))
                            .w(px(160.))
                            .child(Self::share_menu_item("role-viewer", "Viewer", r == Role::Viewer, p).on_click(cx.listener(move |w, _, _, cx| w.share_member_call(k1.clone(), false, e1.clone(), Role::Viewer, cx))))
                            .child(Self::share_menu_item("role-editor", "Editor", r == Role::Editor, p).on_click(cx.listener(move |w, _, _, cx| w.share_member_call(k2.clone(), false, e2.clone(), Role::Editor, cx))))
                            .child(div().h(px(1.)).my(px(4.)).bg(p.border))
                            .child(Self::share_menu_item("role-remove", "Remove access", false, p).on_click(cx.listener(move |w, _, _, cx| w.share_member_call(k3.clone(), true, k3.clone(), Role::Viewer, cx)))),
                    )
                })
            } else {
                row.child(div().flex_none().text_size(px(12.)).text_color(p.muted).child(sv::role_label(r)))
            };
            rows.push(row.into_any_element());
        }

        let general = can_manage.then(|| {
            let icon_bg = if public { p.green.opacity(0.16) } else { p.fg(0.08) };
            let icon_fg = if public { p.green } else { p.muted };
            let icon_box = div().size(px(32.)).flex_none().rounded_full().flex().items_center().justify_center().bg(icon_bg).child(svg().path(if public { "markie/globe.svg" } else { "markie/lock.svg" }).size(px(16.)).text_color(icon_fg));
            let body: AnyElement = if live_doc && public {
                h_flex()
                    .gap(px(11.2))
                    .py(px(4.))
                    .child(icon_box)
                    .child(v_flex().min_w_0().flex_1().child(div().text_size(px(13.5)).child("Anyone with the link")).child(div().text_size(px(12.)).text_color(p.muted).child(if link_busy { "Updating…" } else { sv::LIVE_DOC_PUBLIC_LEFTOVER_LINE })))
                    .child(self.share_pill_button("general-off", "Turn off", false, link_busy, p).border_1().border_color(p.border).on_click(cx.listener(|w, _, _, cx| w.share_set_general(false, cx))))
                    .into_any_element()
            } else if live_doc {
                h_flex()
                    .gap(px(11.2))
                    .py(px(4.))
                    .child(icon_box)
                    .child(v_flex().min_w_0().flex_1().child(div().text_size(px(13.5)).child("Restricted")).child(div().text_size(px(12.)).text_color(p.muted).child(sv::LIVE_DOC_PRIVATE_LINE)))
                    .into_any_element()
            } else {
                let url = public_url.clone();
                h_flex()
                    .gap(px(11.2))
                    .py(px(4.))
                    .relative()
                    .child(icon_box)
                    .child(
                        v_flex()
                            .min_w_0()
                            .flex_1()
                            .child(h_flex().ml(px(-8.)).child(self.share_select_button("general-access", if public { "Anyone with the link" } else { "Restricted" }, GENERAL_SELECT_W, menu == Some(Menu::General), !link_busy && loaded, p, cx.listener(|w, _, _, cx| {
                                if let Some(s) = w.collab.share.as_mut() {
                                    s.menu = if s.menu == Some(Menu::General) { None } else { Some(Menu::General) };
                                }
                                cx.notify();
                            })).text_size(px(13.5)).font_weight(FontWeight::MEDIUM)))
                            .child(
                                h_flex()
                                    .flex_wrap()
                                    .text_size(px(12.))
                                    .text_color(p.muted)
                                    .child(sv::general_access_line(public, link_busy))
                                    .when(public && !link_busy, |el| {
                                        el.child(" · ").child(
                                            div()
                                                .id("see-public")
                                                .text_color(blue)
                                                .hover(|s| s.underline())
                                                .cursor_pointer()
                                                .child("See what a stranger sees")
                                                .on_click(move |_, _, cx| {
                                                    if let Some(u) = &url {
                                                        cx.open_url(u);
                                                    }
                                                }),
                                        )
                                    }),
                            ),
                    )
                    .when(public, |el| el.child(div().flex_none().text_size(px(12.)).text_color(p.muted).child("Viewer")))
                    .when(menu == Some(Menu::General), |el| {
                        el.child(
                            Self::share_menu_list(p)
                                .absolute()
                                .left(px(36.))
                                .top(px(36.))
                                .w(px(220.))
                                .child(Self::share_menu_item("general-restricted", "Restricted", !public, p).on_click(cx.listener(|w, _, _, cx| w.share_set_general(false, cx))))
                                .child(Self::share_menu_item("general-link", "Anyone with the link", public, p).on_click(cx.listener(|w, _, _, cx| w.share_set_general(true, cx)))),
                        )
                    })
                    .into_any_element()
            };
            v_flex()
                .mt(px(17.6))
                .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).mb(px(5.6)).child("General access"))
                .child(body)
                .when_some(rotated.clone(), |el, url| {
                    el.child(Self::share_note(p).child(div().child(sv::LINK_ROTATED_LINE)).child(div().text_color(p.foreground).truncate().child(url)))
                })
        });

        // share-look.tsx: "Appearance", for the owner of a document on the
        // main server that is not a Live Doc, once the server has said what
        // is pinned. A switch in the wrong position is worse than no switch.
        let look_row = (can_manage && on_main_server && !sv::is_live_doc_name(&file_name)).then_some(()).and(look_answer.as_ref()).map(|answer| {
            let own = self.share_own_look(cx);
            let state = pinned_look::look_state(Some(answer), &own);
            let on = matches!(state, LookState::On { .. });
            let drifted = state == (LookState::On { drifted: true });
            let line = pinned_look::look_line(&state, look_busy, &own);
            v_flex()
                .mt(px(17.6))
                .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).mb(px(5.6)).child("Appearance"))
                .child(
                    h_flex()
                        .gap(px(12.))
                        .py(px(4.))
                        .items_center()
                        .child(
                            div()
                                .size(px(32.))
                                .flex_none()
                                .rounded_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(if on { blue.opacity(0.16) } else { p.fg(0.08) })
                                .child(super::dialog_chrome::stroke_icon("M4 7V5h16v2M9 19h6M12 5v14", if on { blue } else { p.muted }, 15., 1.8)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(div().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child("Readers see my look"))
                                .child(div().text_size(px(12.)).text_color(p.muted).child(line)),
                        )
                        .when(drifted, |el| {
                            el.child(self.share_pill_button("share-look-update", "Update", false, look_busy, p).on_click(cx.listener(|w, _, _, cx| w.share_set_look(true, cx))))
                        })
                        .child(
                            self.share_pill_button("share-look-switch", if on { "Turn off" } else { "Turn on" }, false, look_busy, p)
                                .on_click(cx.listener(move |w, _, _, cx| w.share_set_look(!on, cx))),
                        ),
                )
                .when(look_failed, |el| el.child(Self::share_note(p).child(pinned_look::LOOK_FAILED_LINE)))
        });

        let invite_menu = (menu == Some(Menu::InviteRole)).then(|| {
            Self::share_menu_list(p)
                .absolute()
                .left_0()
                .top(px(84.))
                .w(px(140.))
                .child(Self::share_menu_item("invite-viewer", "Viewer", role == Role::Viewer, p).on_click(cx.listener(|w, _, _, cx| {
                    if let Some(s) = w.collab.share.as_mut() {
                        s.role = Role::Viewer;
                        s.menu = None;
                    }
                    cx.notify();
                })))
                .child(Self::share_menu_item("invite-editor", "Editor", role == Role::Editor, p).on_click(cx.listener(|w, _, _, cx| {
                    if let Some(s) = w.collab.share.as_mut() {
                        s.role = Role::Editor;
                        s.menu = None;
                    }
                    cx.notify();
                })))
        });

        Self::share_panel(p)
            .id("share-dialog")
            .w(px(480.))
            .max_h(px(720.))
            .overflow_y_scroll()
            .rounded(px(16.))
            // `.markie-share` paints the surface; in light the overlay
            // panel's own fill wins (a more specific rule), so keep it.
            .when(p.dark, |el| el.bg(p.surface))
            .when(field_focus && p.dark, |el| el.shadow(vec![
                BoxShadow { color: hsla(0., 0., 0., 0.26), offset: point(px(0.), px(18.)), blur_radius: px(44.), spread_radius: px(0.), inset: false },
                BoxShadow { color: blue.opacity(0.45), offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(1.), inset: false },
            ]))
            // Tailwind's preflight: every line is 1.5 times its text.
            .line_height(relative(1.5))
            .pt(px(20.))
            .px(px(22.))
            .pb(px(18.))
            .child(
                h_flex()
                    .justify_between()
                    .gap(px(12.))
                    .mb(px(14.4))
                    .child(div().min_w_0().truncate().text_size(px(17.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(format!("Share \"{file_name}\"")))
                    .child(Self::share_close_x("share-close", p, cx)),
            )
            .when(can_manage, |el| {
                el.child(div().relative().child(field).children(suggestions_menu).children(invite_row).children(invite_menu))
            })
            .when_some(error, |el, e| el.child(Self::share_status_row(false, e, p)))
            .when_some(flash, |el, f| el.child(Self::share_status_row(true, f, p)))
            .when_some(notice, |el, (lead, rest)| el.child(Self::share_note(p).child(div().child(div().text_color(p.foreground).font_weight(FontWeight::MEDIUM).child(lead)).child(rest))))
            .child(
                v_flex()
                    .mt(px(17.6))
                    .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).mb(px(5.6)).child("People with access"))
                    .when(!loaded, |el| el.child(div().py(px(4.)).text_size(px(12.)).text_color(p.muted).child("Loading…")))
                    .when(loaded, |el| {
                        el.children(rows)
                            .when(members.is_empty() && !can_manage, |el| el.child(div().py(px(4.)).text_size(px(12.)).text_color(p.muted).child(sv::share_members_empty_line(access.as_ref()))))
                            .when(access.is_none(), |el| el.child(div().py(px(4.)).text_size(px(12.)).text_color(p.muted).child(sv::ACCESS_UNLOADED_LINE)))
                    }),
            )
            .children(general)
            .children(look_row)
            .child(
                h_flex()
                    .justify_between()
                    .gap(px(12.))
                    .mt(px(20.))
                    .child(
                        h_flex()
                            .id("share-copy")
                            .gap(px(7.2))
                            .h(px(36.))
                            .px(px(17.6))
                            .rounded_full()
                            .border_1()
                            .border_color(if copied { mix(p.green, p.border, 0.5) } else { p.border })
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if copied { p.green } else { blue })
                            .hover(|s| s.bg(blue.opacity(0.09)))
                            .cursor_pointer()
                            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(link.clone()).build(window, cx))
                            .child(svg().path(if copied { "markie/check.svg" } else { "markie/link.svg" }).size(px(if copied { 14. } else { 15. })).text_color(if copied { p.green } else { blue }))
                            .child(if copied { "Link copied" } else { "Copy link" })
                            .on_click(cx.listener(|w, _, _, cx| w.share_copy(cx))),
                    )
                    .child(self.share_pill_button("share-done", "Done", true, false, p).on_click(cx.listener(|w, _, _, cx| w.close_share(cx)))),
            )
            .into_any_element()
    }

    fn share_member_row(avatar_name: &str, name: &str, sub: &str, pending: bool, p: &Palette) -> Div {
        let av = if pending {
            div().size(px(32.)).flex_none().rounded_full().border_1().border_dashed().border_color(p.border).flex().items_center().justify_center().text_size(px(11.5)).font_weight(FontWeight::SEMIBOLD).text_color(p.muted).child(markie_cloud::collab::initials(avatar_name))
        } else {
            avatar(avatar_name, hex(color_for_name(avatar_name)), transparent_black(), 32., 11.5).border_0()
        };
        h_flex()
            .relative()
            .gap(px(11.2))
            .py(px(6.4))
            .child(av)
            .child(v_flex().min_w_0().flex_1().child(div().truncate().text_size(px(13.5)).text_color(p.foreground).child(name.to_string())).child(div().truncate().text_size(px(12.)).text_color(p.muted).child(sub.to_string())))
    }

    fn share_status_row(ok: bool, text: String, p: &Palette) -> Div {
        let tone = if ok { p.green } else { p.red };
        h_flex()
            .items_start()
            .gap(px(8.))
            .mt(px(8.))
            .rounded(px(8.))
            .px(px(10.))
            .py(px(8.))
            .bg(tone.opacity(0.12))
            .text_size(px(12.))
            .text_color(p.foreground)
            .child(svg().path(if ok { "markie/check.svg" } else { "markie/alert.svg" }).size(px(14.)).text_color(tone).mt(px(1.)))
            .child(div().flex_1().child(text))
    }

    fn share_note(p: &Palette) -> Div {
        v_flex().mt(px(12.)).px(px(12.)).py(px(8.)).rounded(px(8.)).border_1().border_color(p.border).bg(p.surface2).text_size(px(11.5)).line_height(px(17.)).text_color(p.muted)
    }

    fn share_menu_list(p: &Palette) -> Div {
        super::chrome::menu_panel(p).py(px(4.8)).rounded(px(10.)).occlude()
    }

    fn share_menu_item(id: &'static str, label: &'static str, on: bool, p: &Palette) -> Stateful<Div> {
        div()
            .id(id)
            .px(px(12.))
            .py(px(6.))
            .text_size(px(12.5))
            .text_color(if on { p.foreground } else { p.muted })
            .hover(|s| s.text_color(p.foreground).bg(super::chrome::hover_fill(p)))
            .cursor_pointer()
            .child(label)
    }

    /// The invite row's role control: a native `<select>` styled
    /// `markie-overlay-field markie-share-select`. Chromium draws it as a
    /// bordered field (30 pt tall, 7 pt corners) with the text 12.5 pt in
    /// from the border and its own small chevron in full ink 4 pt from the
    /// right, 13.5 pt after the text (measured from 0.9.7).
    fn share_invite_role(label: &'static str, open: bool, p: &Palette) -> Stateful<Div> {
        let (bg, border, ring) = if p.dark {
            (mix(p.background, p.surface, 0.82), p.border, p.blue.opacity(0.52))
        } else {
            (p.background, mix(p.foreground, p.border, 0.14), p.blue.opacity(0.45))
        };
        h_flex()
            .id("invite-role")
            .flex_none()
            // As wide as "Viewer", the longer option (76.75 pt in 0.9.7).
            .w(px(76.75))
            .justify_between()
            .h(px(30.))
            .pl(px(12.5))
            .pr(px(4.))
            .rounded(px(7.))
            .border_1()
            .border_color(if open { mix(p.blue, p.border, 0.72) } else { border })
            .bg(bg)
            .when(p.dark, |el| el.shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.08), offset: point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: true }]))
            .when(open, |el| el.shadow(vec![BoxShadow { color: ring, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(2.), inset: false }]))
            .text_size(px(12.5))
            .text_color(p.foreground)
            .cursor_pointer()
            .child(label)
            .child(super::dialog_chrome::stroke_icon(super::dialog_chrome::PATH_CHEVRON_DOWN, p.foreground, 15., 1.9))
    }

    /// `.markie-share-role-select` and `-general-select`: a native select
    /// with `appearance: none`, so as wide as its longest option (measured
    /// from 0.9.7 in headless Chromium), text 8 pt in, transparent until
    /// hovered, and a small filled caret whose tip is 12 pt from the right.
    #[allow(clippy::too_many_arguments)]
    fn share_select_button(&self, id: impl Into<SharedString>, label: &'static str, width: f32, open: bool, enabled: bool, p: &Palette, on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Stateful<Div> {
        h_flex()
            .id(id.into())
            .relative()
            .flex_none()
            .w(px(width))
            .pl(px(8.))
            .pr(px(22.4))
            .py(px(4.8))
            .rounded(px(6.))
            .border_1()
            .border_color(if open { p.blue } else { transparent_black() })
            .text_size(px(12.5))
            .text_color(p.foreground)
            .when(!enabled, |el| el.opacity(0.55))
            .when(enabled, |el| el.hover(|s| s.bg(p.fg(0.07))).cursor_pointer().on_click(on_click))
            .child(div().truncate().child(label))
            .child(svg().path("markie/select-caret.svg").absolute().right(px(7.2)).top(relative(0.55)).mt(px(-2.64)).w(px(9.6)).h(px(4.8)).text_color(p.muted))
    }

    fn share_pill_button(&self, id: &'static str, label: &'static str, primary: bool, disabled: bool, p: &Palette) -> Stateful<Div> {
        h_flex()
            .id(id)
            .flex_none()
            .gap(px(7.2))
            .h(px(36.))
            .px(px(if primary { 17.6 } else { 12. }))
            .rounded_full()
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .when(primary, |el| el.bg(p.blue).text_color(p.background).hover(|s| s.opacity(0.9)))
            .when(!primary, |el| el.text_color(p.muted).hover(|s| s.text_color(p.foreground)))
            .when(disabled, |el| el.opacity(0.55))
            .cursor_pointer()
            .child(label)
    }
}

// ------------------------------------------------------------ people

/// The recipient's side of sharing: the requests on the Cloud page
/// (`ShareRequestsPanel`), for the account the Cloud page shows.
#[derive(Default)]
pub struct PeopleState {
    /// Whose requests these are (origin and user). A change drops them.
    pub account: Option<(String, String)>,
    pub requests: Vec<ShareRequest>,
    pub count: usize,
    pub people: Option<People>,
    pub busy: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
    /// The Cloud page's strip is open, showing each request.
    pub open: bool,
}

/// The strip's one line: how many requests are waiting.
pub(super) fn requests_line(count: usize) -> String {
    if count == 1 { "1 share request is waiting".into() } else { format!("{count} share requests are waiting") }
}

impl Workspace {
    /// The account the Cloud page shows, and a client for it.
    fn people_account(&self) -> Option<((String, String), Arc<CloudClient>)> {
        let scope = self.cloud.selected_scope()?;
        Some(((scope.origin().to_string(), scope.user.clone()), Arc::new(scope.client)))
    }

    /// Load the requests waiting for the Cloud page's account. A failed
    /// request keeps what is on screen rather than calling it empty.
    pub fn people_refresh(&mut self, cx: &mut Context<Self>) {
        let Some((account, client)) = self.people_account() else {
            self.collab.people = None;
            return;
        };
        if self.collab.people.as_ref().is_some_and(|st| st.account.as_ref() != Some(&account)) {
            self.collab.people = None;
        }
        let task = runtime::handle().spawn(async move {
            let people = PeopleClient::new(&client);
            (people.requests().await.ok(), people.people().await.ok())
        });
        cx.spawn(async move |this, cx| {
            let Ok((requests, people)) = task.await else { return };
            this.update(cx, |w, cx| {
                if w.people_account().map(|(a, _)| a) != Some(account.clone()) {
                    return;
                }
                let st = w.collab.people.get_or_insert_with(PeopleState::default);
                st.account = Some(account);
                if let Some((list, count)) = requests {
                    st.count = count.max(list.len());
                    st.requests = list;
                    if std::env::var("MARKIE_RS_COLLAB_DEBUG").is_ok_and(|v| v == "1") {
                        eprintln!("markie-rs cloud: {} share requests waiting for this account", st.count);
                    }
                }
                if people.is_some() {
                    st.people = people;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn people_act(&mut self, kind: &'static str, id: String, done: String, failed: &'static str, cx: &mut Context<Self>) {
        let Some((_, client)) = self.people_account() else { return };
        let st = self.collab.people.get_or_insert_with(PeopleState::default);
        st.busy = true;
        st.error = None;
        st.notice = None;
        let task = runtime::handle().spawn(async move {
            let people = PeopleClient::new(&client);
            match kind {
                "accept" => people.accept(&id).await,
                "decline" => people.decline(&id).await,
                "block" => people.block(&id).await,
                "unblock" => people.unblock(&id).await,
                _ => people.remove(&id).await,
            }
        });
        cx.spawn(async move |this, cx| {
            let ok = matches!(task.await, Ok(Ok(())));
            this.update(cx, |w, cx| {
                if let Some(st) = w.collab.people.as_mut() {
                    st.busy = false;
                    if ok {
                        st.notice = Some(done);
                    } else {
                        st.error = Some(failed.into());
                    }
                }
                w.people_refresh(cx);
                // Accepting or blocking someone lands or removes their
                // documents: list the cloud again (onPeopleChanged).
                if ok && matches!(kind, "accept" | "block") {
                    w.refresh_cloud(false, cx);
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Requests waiting for this account: one line that says how many, which
    /// opens to each request with Accept, Decline and Block. Nothing while
    /// there are none.
    pub fn render_share_requests(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        use super::ui::{self, Kind, Tone};
        let p = themes::palette(cx);
        let account = self.people_account().map(|(a, _)| a);
        let st = self.collab.people.as_ref().filter(|st| account.is_some() && st.account == account)?;
        if st.requests.is_empty() {
            return st.notice.clone().map(|n| ui::banner(Kind::Success, n, &p).into_any_element());
        }
        let busy = st.busy;
        let open = st.open;
        let head = h_flex()
            .id("cloud-requests-head")
            .min_h(px(44.))
            .gap(px(10.))
            .pl(px(12.))
            .pr(px(6.))
            .cursor_pointer()
            .child(super::chrome::icon("markie/people.svg", 15., p.blue))
            .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(requests_line(st.count)))
            .children(st.notice.clone().filter(|_| !open).map(|n| div().min_w_0().truncate().text_size(px(12.)).text_color(p.muted).child(n)))
            .child(div().flex_1())
            .child(ui::button("cloud-requests-toggle", if open { "Hide" } else { "Review" }, None, Tone::Secondary, false, &p).h(px(28.)))
            .on_click(cx.listener(|w, _, _, cx| {
                if let Some(st) = w.collab.people.as_mut() {
                    st.open = !st.open;
                }
                cx.notify();
            }));
        let rows = st.requests.iter().enumerate().map(|(i, r)| {
            let who = sv::who(r.sender.name.as_deref(), &r.sender.email);
            let (sid1, sid2, doc) = (r.sender.id.clone(), r.sender.id.clone(), r.doc_id.clone());
            let (w1, w2, n) = (who.clone(), who.clone(), r.name.clone());
            h_flex()
                .flex_wrap()
                .gap(px(8.))
                .py(px(8.))
                .border_t_1()
                .border_color(p.border.opacity(0.7))
                .child(
                    v_flex()
                        .min_w_0()
                        .flex_1()
                        .child({
                            // One line of text, the two names medium.
                            let line = format!("{who} wants to share {}", r.name);
                            let medium = HighlightStyle { font_weight: Some(FontWeight::MEDIUM), ..Default::default() };
                            let name_at = line.len() - r.name.len();
                            div().truncate().text_size(px(13.)).text_color(p.foreground).child(StyledText::new(line.clone()).with_highlights([(0..who.len(), medium), (name_at..line.len(), medium)]))
                        })
                        .child(div().truncate().text_size(px(11.5)).text_color(p.muted).child(r.sender.email.clone())),
                )
                .child(
                    h_flex()
                        .gap(px(4.))
                        .child(ui::button(SharedString::from(format!("req-accept-{i}")), "Accept", None, Tone::Secondary, busy, &p).h(px(28.)).when(!busy, |b| {
                            b.on_click(cx.listener(move |w, _, _, cx| w.people_act("accept", sid1.clone(), format!("Accepted {w1}. What they share lands in your Markie."), "Couldn't accept. Try again.", cx)))
                        }))
                        .child(ui::button(SharedString::from(format!("req-decline-{i}")), "Decline", None, Tone::Quiet, busy, &p).h(px(28.)).when(!busy, |b| {
                            b.on_click(cx.listener(move |w, _, _, cx| w.people_act("decline", doc.clone(), format!("Declined {n}."), "Couldn't decline. Try again.", cx)))
                        }))
                        .child(ui::button(SharedString::from(format!("req-block-{i}")), "Block", None, Tone::Danger, busy, &p).h(px(28.)).when(!busy, |b| {
                            b.on_click(cx.listener(move |w, _, _, cx| w.people_act("block", sid2.clone(), format!("Blocked {w2}. You won't see their requests."), "Couldn't block. Try again.", cx)))
                        })),
                )
        });
        Some(
            v_flex()
                .rounded(px(8.))
                .border_1()
                .border_color(p.blue.opacity(0.28))
                .bg(p.blue.opacity(0.06))
                .child(head)
                .when(open, |el| {
                    el.child(
                        v_flex()
                            .px(px(12.))
                            .pb(px(6.))
                            .child(div().pb(px(8.)).text_size(px(12.)).line_height(px(17.)).text_color(p.muted).child(sv::REQUESTS_INTRO))
                            .children(rows)
                            .when(st.count > st.requests.len(), |el| {
                                el.child(div().py(px(6.)).text_size(px(12.)).text_color(p.muted).child(format!("Showing the newest {} of {}. Answer these to see the rest.", st.requests.len(), st.count)))
                            })
                            .children(st.notice.clone().map(|n| div().py(px(6.)).text_size(px(12.)).text_color(p.muted).child(n))),
                    )
                })
                .when_some(st.error.clone(), |el, e| el.child(div().px(px(12.)).pb(px(8.)).text_size(px(12.)).text_color(p.red).child(e)))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod request_strip_tests {
    use super::requests_line;

    #[test]
    fn the_strip_says_how_many_requests_are_waiting() {
        assert_eq!(requests_line(1), "1 share request is waiting");
        assert_eq!(requests_line(2), "2 share requests are waiting");
        assert_eq!(requests_line(12), "12 share requests are waiting");
    }
}
