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

use super::collab::{CloudDoc, avatar};
use super::{DocKind, Workspace};
use crate::themes::{self, Palette, hex, mix};

#[derive(Clone, PartialEq)]
enum Gate {
    Unsaved,
    SignedOut,
    Local,
    Ready,
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
    role: Role,
    menu: Option<Menu>,
    highlight: usize,
    error: Option<String>,
    flash: Option<String>,
    busy: bool,
    link_busy: bool,
    copied: bool,
    row_busy: Option<String>,
    _subs: Vec<Subscription>,
    _task: Option<Task<()>>,
}

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
        let saved = matches!(self.doc.as_ref().map(|d| &d.kind), Some(DocKind::Text { .. }) | Some(DocKind::Office(_)) | Some(DocKind::Html));
        let any_account = self.collab.cloud.is_some();
        let gate = if self.doc.is_none() || !saved {
            Gate::Unsaved
        } else if let Some(c) = &self.collab.cloud {
            let _ = c;
            Gate::Ready
        } else if any_account {
            Gate::Local
        } else {
            Gate::SignedOut
        };
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
            role: Role::Viewer,
            menu: None,
            highlight: 0,
            error: None,
            flash: None,
            busy: false,
            link_busy: false,
            copied: false,
            row_busy: None,
            _subs: subs,
            _task: None,
        });
        if gate == Gate::Ready {
            self.share_load(cx);
            query.update(cx, |s, cx| s.focus(window, cx));
        }
        cx.notify();
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
            (access, members, url, contacts)
        });
        let t = cx.spawn(async move |this, cx| {
            let Ok((access, members, url, contacts)) = task.await else { return };
            this.update(cx, |w, cx| {
                if let Some(s) = w.collab.share.as_mut() {
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
                .bg(p.background.opacity(0.58))
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
        let name = self.collab.share.as_ref().map(|s| s.file_name.clone()).unwrap_or_default();
        let (title, line, action): (&str, String, Option<(&str, bool)>) = match gate {
            Gate::Unsaved => ("Share this document", "Save this document to a file before you share it.".into(), None),
            Gate::Local => (
                "Share this document",
                format!("{name} is only on this Mac. Syncing it to your account is what makes a share link possible."),
                Some(("Sync and share", false)),
            ),
            Gate::SignedOut => ("Sign in to share", "Sign in to Markie Cloud to share this document. Sharing sends the text to the people you choose.".into(), Some(("Sign in", true))),
            Gate::Ready => unreachable!(),
        };
        Self::share_panel(p)
            .w(px(if *gate == Gate::SignedOut { 400. } else { 440. }))
            .rounded(px(12.))
            .p(px(20.))
            .child(
                h_flex()
                    .items_start()
                    .justify_between()
                    .gap(px(12.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(title))
                    .child(Self::share_close_x("share-gate-close", p, cx)),
            )
            .child(div().mt(px(8.)).text_size(px(12.5)).line_height(px(20.)).text_color(p.muted).child(line))
            .when_some(action, |el, (label, enabled)| {
                let signed_out = *gate == Gate::SignedOut;
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
                            .when(!enabled, |el| el.opacity(0.6))
                            .when(enabled, |el| el.cursor_pointer())
                            .child(label)
                            .on_click(cx.listener(move |w, _, window, cx| {
                                if !enabled {
                                    return;
                                }
                                if signed_out {
                                    w.close_share(cx);
                                    w.open_account(window, cx);
                                } else {
                                    w.close_share(cx);
                                    w.open_share(window, cx);
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
        let blue = p.blue;
        let _ = window;

        let field = div()
            .id("share-field")
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(5.6))
            .min_h(px(41.6))
            .px(px(9.6))
            .py(px(5.6))
            .bg(p.background)
            .border_1()
            .border_color(p.border)
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
            .child(div().flex_1().min_w(px(128.)).child(Input::new(&query).appearance(false).text_size(px(13.5))));

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
                .child(self.share_select_button("invite-role", sv::role_label(role), menu == Some(Menu::InviteRole), true, p, cx.listener(|w, _, _, cx| {
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
                row.child(self.share_select_button(format!("role-{i}"), sv::role_label(r), menu == Some(Menu::Row(i)), !busy_row, p, cx.listener(move |w, _, _, cx| {
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
                            .child(div().ml(px(-8.)).child(self.share_select_button("general-access", if public { "Anyone with the link" } else { "Restricted" }, menu == Some(Menu::General), !link_busy && loaded, p, cx.listener(|w, _, _, cx| {
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
            .bg(p.surface)
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

    /// `.markie-share-role-select`: transparent until hovered, with a chevron.
    fn share_select_button(&self, id: impl Into<SharedString>, label: &'static str, open: bool, enabled: bool, p: &Palette, on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Stateful<Div> {
        h_flex()
            .id(id.into())
            .flex_none()
            .gap(px(6.))
            .pl(px(8.))
            .pr(px(6.))
            .py(px(4.8))
            .rounded(px(6.))
            .border_1()
            .border_color(if open { p.blue } else { transparent_black() })
            .text_size(px(12.5))
            .text_color(p.foreground)
            .when(!enabled, |el| el.opacity(0.55))
            .when(enabled, |el| el.hover(|s| s.bg(p.fg(0.07))).cursor_pointer().on_click(on_click))
            .child(label)
            .child(svg().path("markie/select-chevron.svg").size(px(10.)).text_color(p.muted))
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

/// The recipient's side of sharing, for the Cloud page and the account sheet
/// (embedded by that work; nothing in this branch opens it yet).
#[derive(Default)]
#[allow(dead_code)]
pub struct PeopleState {
    pub requests: Vec<ShareRequest>,
    pub count: usize,
    pub people: Option<People>,
    pub busy: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
}

#[allow(dead_code)]
impl Workspace {
    /// Load requests and people for the open document's account.
    pub fn people_refresh(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.collab.cloud.as_ref().map(|c| c.account.client.clone()) else { return };
        let task = runtime::handle().spawn(async move {
            let people = PeopleClient::new(&client);
            (people.requests().await.ok(), people.people().await.ok())
        });
        cx.spawn(async move |this, cx| {
            let Ok((requests, people)) = task.await else { return };
            this.update(cx, |w, cx| {
                let st = w.collab.people.get_or_insert_with(PeopleState::default);
                if let Some((list, count)) = requests {
                    st.count = count.max(list.len());
                    st.requests = list;
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
        let Some(client) = self.collab.cloud.as_ref().map(|c| c.account.client.clone()) else { return };
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
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Requests waiting for this account, with Accept, Decline and Block.
    /// Nothing while there are none.
    pub fn render_share_requests(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = themes::palette(cx);
        let st = self.collab.people.as_ref()?;
        if st.requests.is_empty() {
            return st.notice.clone().map(|n| div().mb(px(8.)).px(px(8.)).text_size(px(11.)).text_color(p.muted).child(n).into_any_element());
        }
        let busy = st.busy;
        Some(
            v_flex()
                .mb(px(12.))
                .rounded(px(8.))
                .border_1()
                .border_color(p.border.opacity(0.8))
                .bg(p.surface2.opacity(0.4))
                .px(px(10.))
                .py(px(8.))
                .child(
                    h_flex()
                        .mb(px(6.))
                        .gap(px(6.))
                        .child(div().text_size(px(11.5)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child("Requests"))
                        .child(div().rounded_full().border_1().border_color(p.border).px(px(6.)).text_size(px(10.)).text_color(p.foreground).child(st.count.to_string())),
                )
                .child(div().mb(px(8.)).text_size(px(10.5)).text_color(p.muted).child(sv::REQUESTS_INTRO))
                .children(st.requests.iter().enumerate().map(|(i, r)| {
                    let who = sv::who(r.sender.name.as_deref(), &r.sender.email);
                    let (sid1, sid2, doc) = (r.sender.id.clone(), r.sender.id.clone(), r.doc_id.clone());
                    let (w1, w2, n) = (who.clone(), who.clone(), r.name.clone());
                    h_flex()
                        .flex_wrap()
                        .gap(px(8.))
                        .when(i > 0, |el| el.border_t_1().border_color(p.border.opacity(0.6)).pt(px(6.)))
                        .child(
                            v_flex()
                                .min_w_0()
                                .flex_1()
                                .text_size(px(11.5))
                                .child(h_flex().gap(px(4.)).child(div().font_weight(FontWeight::MEDIUM).child(who.clone())).child("wants to share").child(div().font_weight(FontWeight::MEDIUM).child(r.name.clone())))
                                .child(div().truncate().text_size(px(10.5)).text_color(p.muted).child(r.sender.email.clone())),
                        )
                        .child(
                            h_flex()
                                .gap(px(4.))
                                .child(people_button(&format!("req-accept-{i}"), "Accept", true, busy, &p).on_click(cx.listener(move |w, _, _, cx| w.people_act("accept", sid1.clone(), format!("Accepted {w1}. What they share lands in your Markie."), "Couldn't accept. Try again.", cx))))
                                .child(people_button(&format!("req-decline-{i}"), "Decline", false, busy, &p).on_click(cx.listener(move |w, _, _, cx| w.people_act("decline", doc.clone(), format!("Declined {n}."), "Couldn't decline. Try again.", cx))))
                                .child(people_button(&format!("req-block-{i}"), "Block", false, busy, &p).on_click(cx.listener(move |w, _, _, cx| w.people_act("block", sid2.clone(), format!("Blocked {w2}. You won't see their requests."), "Couldn't block. Try again.", cx)))),
                        )
                }))
                .when(st.count > st.requests.len(), |el| {
                    el.child(div().mt(px(6.)).text_size(px(10.5)).text_color(p.muted).child(format!("Showing the newest {} of {}. Answer these to see the rest.", st.requests.len(), st.count)))
                })
                .when_some(st.error.clone(), |el, e| el.child(div().mt(px(6.)).text_size(px(11.)).text_color(p.red).child(e)))
                .into_any_element(),
        )
    }

    /// Accepted people (Remove, Block) and blocked people (Unblock).
    pub fn render_people_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
        let st = self.collab.people.as_ref();
        let busy = st.is_some_and(|s| s.busy);
        let people = st.and_then(|s| s.people.clone());
        v_flex()
            .mt(px(16.))
            .border_t_1()
            .border_color(p.border)
            .pt(px(12.))
            .child(div().mb(px(4.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child("Accepted people"))
            .child(div().mb(px(8.)).text_size(px(11.)).text_color(p.muted).child(sv::PEOPLE_INTRO))
            .when(people.is_none(), |el| el.child(div().text_size(px(11.5)).text_color(p.muted).child("Couldn't load the people you accepted.")))
            .when_some(people.clone(), |el, ppl| {
                el.when(ppl.accepted.is_empty(), |el| el.child(div().text_size(px(11.5)).text_color(p.muted).child(sv::PEOPLE_EMPTY)))
                    .children(ppl.accepted.iter().enumerate().map(|(i, person)| {
                        let who = sv::who(person.name.as_deref(), &person.email);
                        let (id1, id2, w1, w2) = (person.id.clone(), person.id.clone(), who.clone(), who.clone());
                        person_row(&who, person.name.as_ref().map(|_| person.email.as_str()), &p)
                            .child(people_button(&format!("ppl-remove-{i}"), "Remove", false, busy, &p).on_click(cx.listener(move |w, _, _, cx| w.people_act("remove", id1.clone(), format!("Removed {w1}."), "Couldn't remove them. Try again.", cx))))
                            .child(people_button(&format!("ppl-block-{i}"), "Block", false, busy, &p).on_click(cx.listener(move |w, _, _, cx| w.people_act("block", id2.clone(), format!("Blocked {w2}."), "Couldn't block them. Try again.", cx))))
                    }))
                    .when(!ppl.blocked.is_empty(), |el| {
                        el.child(div().mt(px(12.)).mb(px(4.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child("Blocked")).children(ppl.blocked.iter().enumerate().map(|(i, person)| {
                            let who = sv::who(person.name.as_deref(), &person.email);
                            let (id, w1) = (person.id.clone(), who.clone());
                            person_row(&who, person.name.as_ref().map(|_| person.email.as_str()), &p).child(
                                people_button(&format!("ppl-unblock-{i}"), "Unblock", false, busy, &p)
                                    .on_click(cx.listener(move |w, _, _, cx| w.people_act("unblock", id.clone(), format!("Unblocked {w1}. What they share shows up in Requests."), "Couldn't unblock them. Try again.", cx))),
                            )
                        }))
                    })
            })
            .when_some(st.and_then(|s| s.error.clone()), |el, e| el.child(div().mt(px(6.)).text_size(px(11.)).text_color(p.red).child(e)))
            .when_some(st.and_then(|s| s.notice.clone()), |el, n| el.child(div().mt(px(6.)).text_size(px(11.)).text_color(p.muted).child(n)))
            .into_any_element()
    }
}

#[allow(dead_code)]
fn person_row(who: &str, email: Option<&str>, p: &Palette) -> Div {
    h_flex()
        .gap(px(8.))
        .py(px(2.))
        .child(v_flex().min_w_0().flex_1().child(div().truncate().text_size(px(12.)).text_color(p.foreground).child(who.to_string())).when_some(email, |el, e| el.child(div().truncate().text_size(px(10.5)).text_color(p.muted).child(e.to_string()))))
}

#[allow(dead_code)]
fn people_button(id: &str, label: &'static str, primary: bool, busy: bool, p: &Palette) -> Stateful<Div> {
    div()
        .id(SharedString::from(id.to_string()))
        .rounded(px(6.))
        .border_1()
        .border_color(p.border)
        .px(px(8.))
        .py(px(4.))
        .text_size(px(11.5))
        .when(primary, |el| el.bg(p.fg(0.10)).font_weight(FontWeight::MEDIUM).text_color(p.foreground))
        .when(!primary, |el| el.text_color(p.muted))
        .hover(|s| s.text_color(p.foreground))
        .when(busy, |el| el.opacity(0.4))
        .cursor_pointer()
        .child(label)
}
