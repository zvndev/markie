//! Settings > Advanced > Servers, ported from `servers-setting.tsx`: Markie
//! Cloud and every server added here, each with its own account.
//!
//! Adding is two steps by design: the address is checked and the server is
//! asked who it is, the person sees that name and address, and only a "yes"
//! adds it (`ServerStore::probe_target`, `record_probe`, `add`). Signing in
//! to an added server sends the email and password to that server only, and
//! its session is kept under its own origin in the shared token store.
use std::collections::HashMap;

use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_cloud::auth::{AuthClient, SignInOutcome};
use markie_cloud::auth_errors::{self, AuthContext, INVITE_ONLY};
use markie_cloud::error::CloudError;
use markie_cloud::registry::{Probe, Server, SignupMode, probe_server_info};

use super::Workspace;
use super::cloud::network;
use super::dialog_chrome::{Tokens, section_label};
use super::settings::overlay_button;

/// `hostOf`: the URL's host (with a non-default port), or the address.
pub(crate) fn host_of(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(|h| match u.port() { Some(p) => format!("{h}:{p}"), None => h.to_string() }))
        .unwrap_or_else(|| origin.to_string())
}

/// `AccountLine`.
pub(crate) fn account_line(status: Status, email: Option<&str>) -> String {
    match (status, email) {
        (Status::Checking, _) => "Checking…".into(),
        (Status::In, Some(email)) => format!("Signed in as {email}"),
        _ => "Not signed in".into(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Checking,
    In,
    Out,
}

/// The submit button's label in `ServerSignIn`.
pub(crate) fn sign_in_button(busy: bool, creating: bool) -> &'static str {
    match (busy, creating) {
        (true, _) => "…",
        (false, true) => "Create account",
        (false, false) => "Sign in",
    }
}

/// An added server's sign-in form, one at a time.
pub(crate) struct ServerSignIn {
    origin: String,
    email: Entity<InputState>,
    password: Entity<InputState>,
    sign_up: bool,
    error: Option<String>,
    notice: Option<String>,
    busy: bool,
}

#[derive(Default)]
pub(crate) struct ServersUi {
    address: Option<Entity<InputState>>,
    adding: bool,
    probe: Option<Probe>,
    add_error: Option<String>,
    add_busy: bool,
    sign_in: Option<ServerSignIn>,
    confirm_remove: Option<String>,
    remove_busy: bool,
    row_error: Option<(String, String)>,
    /// The account `/api/me` confirmed for each added server with a session.
    pub(super) emails: HashMap<String, Option<String>>,
    asked: HashMap<String, String>,
    _subs: Vec<Subscription>,
}

impl Workspace {
    /// The section in Advanced. Markie Cloud first, then each added server,
    /// then "Add a server…".
    pub(super) fn render_servers_setting(&mut self, t: &Tokens, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if self.cloud.servers_ui.address.is_none() {
            let address = cx.new(|cx| InputState::new(window, cx).placeholder("https://docs.example.com"));
            let sub = cx.subscribe_in(&address, window, |this, _, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = ev {
                    this.server_check(window, cx);
                }
                cx.notify();
            });
            self.cloud.servers_ui.address = Some(address);
            self.cloud.servers_ui._subs.push(sub);
        }
        let servers = self.cloud.servers.list();
        self.server_accounts(&servers, cx);
        let mut rows: Vec<AnyElement> = Vec::new();
        for server in servers {
            let row = if server.is_default || server.origin == self.cloud.primary_origin() {
                self.default_server_row(&server, t, cx)
            } else {
                self.server_row(&server, t, cx)
            };
            rows.push(row);
        }
        div()
            .mb(px(20.))
            .child(section_label("Servers", t).mb(px(8.)))
            .child(div().text_size(px(11.)).text_color(t.muted).mb(px(8.)).child("To work on someone\u{2019}s document, sign in to the server it lives on."))
            .child(div().flex().flex_col().gap(px(8.)).children(rows))
            .child(self.add_server(t, cx))
            .into_any_element()
    }

    /// Ask `/api/me` once per added server whose session changed.
    fn server_accounts(&mut self, servers: &[Server], cx: &mut Context<Self>) {
        let primary = self.cloud.primary_origin();
        for server in servers.iter().filter(|s| !s.is_default && s.origin != primary) {
            let Some(client) = self.cloud.client(&server.origin) else { continue };
            let token = client.token();
            let Some(token) = token else {
                self.cloud.servers_ui.emails.remove(&server.origin);
                self.cloud.servers_ui.asked.remove(&server.origin);
                continue;
            };
            let fingerprint = markie_cloud::sync::hash_content(&token);
            if self.cloud.servers_ui.asked.get(&server.origin) == Some(&fingerprint) {
                continue;
            }
            self.cloud.servers_ui.asked.insert(server.origin.clone(), fingerprint);
            self.cloud.servers_ui.emails.insert(server.origin.clone(), None);
            let origin = server.origin.clone();
            cx.spawn(async move |this, cx| {
                let me = network(async move { AuthClient::new(&client).me().await }).await;
                let _ = this.update(cx, |this, cx| {
                    match me {
                        Ok(Ok(Some(user))) => {
                            this.cloud.servers_ui.emails.insert(origin, Some(user.email));
                        }
                        _ => {
                            this.cloud.servers_ui.emails.remove(&origin);
                        }
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }

    fn row_shell(server: &Server, t: &Tokens) -> Div {
        div()
            .rounded(px(6.))
            .border_1()
            .border_color(t.border)
            .px(px(12.))
            .py(px(8.))
            .child(div().min_w_0().child(div().text_size(px(13.)).text_color(t.foreground).truncate().child(server.name.clone())).child(div().text_size(px(11.)).text_color(t.muted).truncate().child(host_of(&server.origin))))
    }

    fn default_server_row(&mut self, server: &Server, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let store = super::account::AccountStore::global(cx);
        let status = match store.as_ref().map(|s| s.read(cx).status.clone()) {
            Some(super::account::AuthStatus::Checking) => Status::Checking,
            Some(super::account::AuthStatus::In(_)) => Status::In,
            _ => Status::Out,
        };
        let email = super::account::signed_in_user(cx).map(|u| u.email);
        Self::row_shell(server, t)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .mt(px(6.))
                    .child(div().text_size(px(11.)).text_color(t.muted).truncate().child(account_line(status, email.as_deref())))
                    .when(status == Status::In, |el| {
                        el.child(overlay_button("server-default-sign-out", "Sign out", t).on_click(cx.listener(|_, _, _, cx| {
                            if let Some(store) = super::account::AccountStore::global(cx) {
                                store.update(cx, |s, cx| s.sign_out(cx));
                            }
                        })))
                    })
                    .when(status == Status::Out, |el| {
                        // Markie Cloud's sign-in lives on the Account tab.
                        el.child(overlay_button("server-default-sign-in", "Sign in", t).on_click(cx.listener(|this, _, _, cx| this.settings_tab(super::overlay::SettingsSection::Account, cx))))
                    }),
            )
            .into_any_element()
    }

    fn server_row(&mut self, server: &Server, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let origin = server.origin.clone();
        let ui = &self.cloud.servers_ui;
        let has_session = self.cloud.client(&origin).is_some_and(|c| c.token().is_some());
        let status = match ui.emails.get(&origin) {
            _ if !has_session => Status::Out,
            Some(None) => Status::Checking,
            Some(Some(_)) => Status::In,
            None => Status::Out,
        };
        let email = ui.emails.get(&origin).cloned().flatten();
        let signing_in = ui.sign_in.as_ref().is_some_and(|s| s.origin == origin);
        let confirming = ui.confirm_remove.as_deref() == Some(origin.as_str());
        let busy = ui.remove_busy;
        let error = ui.row_error.as_ref().filter(|(o, _)| *o == origin).map(|(_, e)| e.clone());
        let id = |what: &str| SharedString::from(format!("server-{what}-{origin}"));
        let (o1, o2, o3, o4) = (origin.clone(), origin.clone(), origin.clone(), origin.clone());
        let sign_in_form = if signing_in && status != Status::In { Some(self.server_sign_in_form(server, t, cx)) } else { None };
        Self::row_shell(server, t)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .mt(px(6.))
                    .child(div().text_size(px(11.)).text_color(t.muted).truncate().child(account_line(status, email.as_deref())))
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .gap(px(8.))
                            .when(status == Status::In, |el| {
                                el.child(small_button(id("sign-out"), "Sign out", t).on_click(cx.listener(move |this, _, _, cx| this.server_sign_out(o1.clone(), cx))))
                            })
                            .when(status == Status::Out && !signing_in, |el| {
                                el.child(small_button(id("sign-in"), "Sign in", t).on_click(cx.listener(move |this, _, window, cx| this.server_open_sign_in(o2.clone(), window, cx))))
                            })
                            .when(!confirming, |el| {
                                el.child(small_button(id("remove"), "Remove", t).on_click(cx.listener(move |this, _, _, cx| {
                                    this.cloud.servers_ui.confirm_remove = Some(o3.clone());
                                    cx.notify();
                                })))
                            }),
                    ),
            )
            .when(confirming, |el| {
                el.child(
                    div()
                        .mt(px(8.))
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(div().text_size(px(11.)).text_color(t.muted).child("Remove this server? You\u{2019}ll be signed out of it."))
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .gap(px(8.))
                                .child(small_button(id("remove-cancel"), "Cancel", t).when(busy, |el| el.opacity(0.5)).on_click(cx.listener(move |this, _, _, cx| {
                                    if !this.cloud.servers_ui.remove_busy {
                                        this.cloud.servers_ui.confirm_remove = None;
                                        cx.notify();
                                    }
                                })))
                                .child(primary_button(id("remove-confirm"), "Remove", t).when(busy, |el| el.opacity(0.5)).on_click(cx.listener(move |this, _, _, cx| this.server_remove(o4.clone(), cx)))),
                        ),
                )
            })
            .children(sign_in_form)
            .when_some(error, |el, e| el.child(div().mt(px(4.)).text_size(px(11.)).text_color(t.red).child(e)))
            .into_any_element()
    }

    fn server_open_sign_in(&mut self, origin: String, window: &mut Window, cx: &mut Context<Self>) {
        let email = cx.new(|cx| InputState::new(window, cx).placeholder("Email"));
        let password = cx.new(|cx| InputState::new(window, cx).placeholder("Password").masked(true));
        for input in [&email, &password] {
            let sub = cx.subscribe_in(input, window, |this, _, ev: &InputEvent, _, cx| {
                if let InputEvent::PressEnter { .. } = ev {
                    this.server_submit(cx);
                }
                cx.notify();
            });
            self.cloud.servers_ui._subs.push(sub);
        }
        email.update(cx, |s, cx| s.focus(window, cx));
        self.cloud.servers_ui.sign_in = Some(ServerSignIn { origin, email, password, sign_up: false, error: None, notice: None, busy: false });
        cx.notify();
    }

    fn server_sign_in_form(&mut self, server: &Server, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let Some(form) = self.cloud.servers_ui.sign_in.as_ref() else { return div().into_any_element() };
        let host = host_of(&server.origin);
        let signup = server.sign_in.signup;
        let creating = form.sign_up && signup != SignupMode::Closed;
        let email_empty = form.email.read(cx).value().is_empty();
        let password_empty = form.password.read(cx).value().is_empty();
        let (busy, error, notice) = (form.busy, form.error.clone(), form.notice.clone());
        let (email, password) = (form.email.clone(), form.password.clone());
        let (google, apple) = (server.sign_in.google, server.sign_in.apple);
        let disabled = busy || email_empty || password_empty;
        let fg = t.foreground;
        div()
            .mt(px(8.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(t.foreground)
                            .child(format!("Sign in to {}", server.name))
                            .when(server.name != host, |el| el.child(div().text_color(t.muted).child(format!(" ({host})")))),
                    )
                    .child(div().text_size(px(11.)).text_color(t.muted).child(format!("Your email and password go to {host}, not to Markie Cloud."))),
            )
            .when(google, |el| el.child(small_button("server-google", "Continue with Google", t).on_click(cx.listener(|this, _, _, cx| this.server_provider("Google", cx)))))
            .when(apple, |el| el.child(small_button("server-apple", "Continue with Apple", t).on_click(cx.listener(|this, _, _, cx| this.server_provider("Apple", cx)))))
            .child(field(&email, t))
            .child(field(&password, t))
            .when(signup == SignupMode::Invite, |el| el.child(div().text_size(px(11.)).text_color(t.muted).child(INVITE_ONLY)))
            .when_some(error, |el, e| el.child(div().text_size(px(11.)).text_color(t.red).child(e)))
            .when_some(notice, |el, n| el.child(div().text_size(px(11.)).text_color(t.muted).child(n)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(if signup != SignupMode::Closed {
                        div()
                            .id("server-toggle-signup")
                            .text_size(px(11.))
                            .text_color(t.muted)
                            .cursor_pointer()
                            .hover(move |s| s.text_color(fg))
                            .child(if creating { "Have an account? Sign in" } else { "New here? Create an account" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(f) = this.cloud.servers_ui.sign_in.as_mut() {
                                    f.sign_up = !f.sign_up;
                                }
                                cx.notify();
                            }))
                            .into_any_element()
                    } else {
                        div().into_any_element()
                    })
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(small_button("server-sign-in-cancel", "Cancel", t).on_click(cx.listener(|this, _, _, cx| {
                                if this.cloud.servers_ui.sign_in.as_ref().is_some_and(|f| !f.busy) {
                                    this.cloud.servers_ui.sign_in = None;
                                }
                                cx.notify();
                            })))
                            .child(primary_button("server-sign-in-submit", sign_in_button(busy, creating), t).when(disabled, |el| el.opacity(0.5)).on_click(cx.listener(move |this, _, _, cx| {
                                if !disabled {
                                    this.server_submit(cx);
                                }
                            }))),
                    ),
            )
            .into_any_element()
    }

    /// `submit` in ServerSignIn: email and password to that server only.
    fn server_submit(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.cloud.servers_ui.sign_in.as_mut() else { return };
        let email = form.email.read(cx).value().trim().to_string();
        let password = form.password.read(cx).value().to_string();
        if form.busy || email.is_empty() || password.is_empty() {
            return;
        }
        let origin = form.origin.clone();
        let creating = form.sign_up && self.cloud.servers.get(&origin).is_none_or(|s| s.sign_in.signup != SignupMode::Closed);
        let Some(client) = self.cloud.client(&origin) else { return };
        let form = self.cloud.servers_ui.sign_in.as_mut().unwrap();
        form.busy = true;
        form.error = None;
        form.notice = None;
        cx.spawn(async move |this, cx| {
            let result = network(async move {
                let auth = AuthClient::new(&client);
                if creating {
                    let name = email.split('@').next().unwrap_or_default().to_string();
                    auth.sign_up_email(&email, &password, &name).await
                } else {
                    auth.sign_in_email(&email, &password).await
                }
            })
            .await;
            let _ = this.update(cx, |this, cx| {
                let Some(form) = this.cloud.servers_ui.sign_in.as_mut().filter(|f| f.origin == origin) else { return };
                form.busy = false;
                match result {
                    Ok(Ok(SignInOutcome::SignedIn(user))) => {
                        this.cloud.servers_ui.emails.insert(origin.clone(), Some(user.email));
                        this.cloud.servers_ui.sign_in = None;
                        this.refresh_cloud_resources(cx);
                        this.refresh_cloud(true, cx);
                    }
                    Ok(Ok(SignInOutcome::NeedsVerification)) => {
                        form.notice = Some(if creating { "Check your email to confirm your address, then sign in." } else { "Confirm your email address first, then sign in." }.into());
                    }
                    Ok(Err(e)) => {
                        let context = if creating { AuthContext::PasswordSignUp } else { AuthContext::PasswordSignIn };
                        form.error = Some(auth_errors::signup_refusal(&e).unwrap_or_else(|| auth_errors::auth_error_message(&e, context)).to_string());
                    }
                    Err(_) => form.error = Some(auth_errors::auth_error_message(&CloudError::Offline, AuthContext::PasswordSignIn).to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Google or Apple for an added server. The hand-back comes through
    /// `markie-rs://`, which servers answer only after the Markie Cloud update
    /// Google and Apple sign-in wait for.
    fn server_provider(&mut self, provider: &str, cx: &mut Context<Self>) {
        let Some(form) = self.cloud.servers_ui.sign_in.as_mut() else { return };
        form.error = Some(format!("Couldn't start {provider} sign-in on this device."));
        cx.notify();
    }

    fn server_sign_out(&mut self, origin: String, cx: &mut Context<Self>) {
        let Some(client) = self.cloud.client(&origin) else { return };
        if !self.cloud.media_signing_out.insert(origin.clone()) { return; }
        self.refresh_cloud_resources(cx);
        cx.spawn(async move |this, cx| {
            let _ = network(async move { AuthClient::new(&client).sign_out().await }).await;
            let _ = this.update(cx, |this, cx| {
                this.cloud.media_signing_out.remove(&origin);
                this.cloud.servers_ui.emails.remove(&origin);
                this.cloud.servers_ui.asked.remove(&origin);
                this.refresh_cloud_resources(cx);
                this.refresh_cloud(false, cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// `remove`: take the server off the list and forget its session.
    fn server_remove(&mut self, origin: String, cx: &mut Context<Self>) {
        if self.cloud.servers_ui.remove_busy {
            return;
        }
        self.cloud.servers_ui.row_error = None;
        match self.cloud.servers.remove(&origin) {
            Ok(_) => {
                let client = self.cloud.client(&origin);
                let _ = markie_cloud::tokens::set_token(self.cloud.tokens.as_ref(), &origin, None);
                self.refresh_cloud_resources(cx);
                self.cloud.servers_ui.confirm_remove = None;
                self.cloud.servers_ui.emails.remove(&origin);
                self.cloud.servers_ui.asked.remove(&origin);
                if self.cloud.servers_ui.sign_in.as_ref().is_some_and(|f| f.origin == origin) {
                    self.cloud.servers_ui.sign_in = None;
                }
                // Its token goes too: end that session at its server.
                if let Some(client) = client.filter(|c| c.token().is_some()) {
                    cx.spawn(async move |_, _| {
                        let _ = network(async move { AuthClient::new(&client).sign_out().await }).await;
                    })
                    .detach();
                }
                self.refresh_cloud(false, cx);
            }
            Err(e) => self.cloud.servers_ui.row_error = Some((origin, if e.is_empty() { "Couldn't remove this server.".into() } else { e })),
        }
        cx.notify();
    }

    fn add_server(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let ui = &self.cloud.servers_ui;
        if !ui.adding {
            // `mt-2` on an inline button: it is as wide as its label.
            return div()
                .mt(px(8.))
                .flex()
                .child(overlay_button("server-add-open", "Add a server…", t).on_click(cx.listener(|this, _, window, cx| {
                    this.cloud.servers_ui.adding = true;
                    if let Some(a) = this.cloud.servers_ui.address.clone() {
                        a.update(cx, |s, cx| s.focus(window, cx));
                    }
                    cx.notify();
                })))
                .into_any_element();
        }
        let (busy, error) = (ui.add_busy, ui.add_error.clone());
        let panel = div().mt(px(8.)).rounded(px(6.)).border_1().border_color(t.border).px(px(12.)).py(px(8.));
        if let Some(probe) = ui.probe.clone() {
            return panel
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(div().text_size(px(12.)).text_color(t.foreground).child("Add this server?"))
                .child(div().child(div().text_size(px(13.)).text_color(t.foreground).child(probe.info.name.clone())).child(div().text_size(px(11.)).text_color(t.muted).child(probe.origin.clone())))
                .child(div().text_size(px(11.)).text_color(t.muted).child("Only add servers you trust. Your sign-in for it is sent only to this address."))
                .when_some(error, |el, e| el.child(div().text_size(px(11.)).text_color(t.red).child(e)))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(small_button("server-add-cancel", "Cancel", t).on_click(cx.listener(|this, _, window, cx| this.server_add_reset(window, cx))))
                        .child(primary_button("server-add-confirm", "Add server", t).when(busy, |el| el.opacity(0.5)).on_click(cx.listener(|this, _, window, cx| this.server_add(window, cx)))),
                )
                .into_any_element();
        }
        let Some(address) = ui.address.clone() else { return div().into_any_element() };
        let empty = address.read(cx).value().trim().is_empty();
        panel
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(div().text_size(px(11.)).text_color(t.muted).child("Server address"))
            .child(field(&address, t))
            .when_some(error, |el, e| el.child(div().text_size(px(11.)).text_color(t.red).child(e)))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(small_button("server-check-cancel", "Cancel", t).on_click(cx.listener(|this, _, window, cx| this.server_add_reset(window, cx))))
                    .child(primary_button("server-check", if busy { "Checking…" } else { "Continue" }, t).when(busy || empty, |el| el.opacity(0.5)).on_click(cx.listener(|this, _, window, cx| this.server_check(window, cx)))),
            )
            .into_any_element()
    }

    fn server_add_reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ui = &mut self.cloud.servers_ui;
        if ui.add_busy {
            return;
        }
        ui.adding = false;
        ui.probe = None;
        ui.add_error = None;
        if let Some(a) = ui.address.clone() {
            a.update(cx, |s, cx| s.set_value("", window, cx));
        }
        cx.notify();
    }

    /// `check`: the address, then the server's own answer about itself.
    fn server_check(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let ui = &mut self.cloud.servers_ui;
        let Some(address) = ui.address.clone() else { return };
        let input = address.read(cx).value().trim().to_string();
        if ui.add_busy || input.is_empty() || ui.probe.is_some() {
            return;
        }
        ui.add_error = None;
        let (origin, host) = match self.cloud.servers.probe_target(&input) {
            Ok(target) => target,
            Err(e) => {
                self.cloud.servers_ui.add_error = Some(e);
                cx.notify();
                return;
            }
        };
        self.cloud.servers_ui.add_busy = true;
        let transport = self.cloud.transport();
        cx.spawn(async move |this, cx| {
            let probe_origin = origin.clone();
            let info = network(async move { probe_server_info(&transport, &probe_origin).await }).await;
            let _ = this.update(cx, |this, cx| {
                this.cloud.servers_ui.add_busy = false;
                match info {
                    Ok(Ok(info)) => {
                        let probe = this.cloud.servers.record_probe(&origin, &host, info);
                        if probe.already_added {
                            this.cloud.servers_ui.add_error = Some(format!("{} is already in your list.", probe.info.name));
                        } else {
                            this.cloud.servers_ui.probe = Some(probe);
                        }
                    }
                    Ok(Err(e)) => this.cloud.servers_ui.add_error = Some(e),
                    Err(_) => this.cloud.servers_ui.add_error = Some("Couldn't check that server.".into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// `add`: only what the person saw and confirmed.
    fn server_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(probe) = self.cloud.servers_ui.probe.clone() else { return };
        match self.cloud.servers.add(&probe.probe_id) {
            Ok(_) => {
                self.cloud.servers_ui.add_busy = false;
                self.server_add_reset(window, cx);
                self.refresh_cloud(false, cx);
            }
            Err(e) => self.cloud.servers_ui.add_error = Some(if e.is_empty() { "Couldn't add that server.".into() } else { e }),
        }
        cx.notify();
    }
}

/// Scene mode: Settings › Advanced, the second server checked, added and
/// signed in, through the functions its buttons call. `stop` ends early:
/// `confirm` ("Add this server?"), `added`, or `form` (sign-in form filled).
#[cfg(feature = "scene")]
impl Workspace {
    pub(super) fn scene_servers(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let get = |k: &str| args.get(k).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        let (origin, stop) = (get("second_origin"), get("stop"));
        match *step {
            0 => {
                self.open_settings(super::overlay::SettingsSection::Advanced, window, cx);
                *step = 1;
                false
            }
            1 => {
                let Some(address) = self.cloud.servers_ui.address.clone() else { return false };
                address.update(cx, |s, cx| s.set_value(origin.as_str(), window, cx));
                self.server_check(window, cx);
                *step = 2;
                false
            }
            2 => {
                if self.cloud.servers_ui.probe.is_none() {
                    return self.cloud.servers_ui.add_error.is_some();
                }
                if stop == "confirm" {
                    return true;
                }
                self.server_add(window, cx);
                *step = 3;
                false
            }
            3 => {
                if self.cloud.servers.get(&origin).is_none() {
                    return false;
                }
                if stop == "added" {
                    return true;
                }
                self.server_open_sign_in(origin.clone(), window, cx);
                if let Some(form) = self.cloud.servers_ui.sign_in.as_ref() {
                    let (email, password) = (form.email.clone(), form.password.clone());
                    email.update(cx, |s, cx| s.set_value(get("email"), window, cx));
                    password.update(cx, |s, cx| s.set_value(get("password"), window, cx));
                }
                if stop == "form" {
                    return true;
                }
                self.server_submit(cx);
                *step = 4;
                false
            }
            _ => {
                let form = self.cloud.servers_ui.sign_in.as_ref();
                form.is_some_and(|f| f.error.is_some() || f.notice.is_some())
                    || self.cloud.servers_ui.emails.get(&origin).is_some_and(|e| e.is_some())
            }
        }
    }
}

fn small_button(id: impl Into<ElementId>, label: &str, t: &Tokens) -> Stateful<Div> {
    let (fg, hover) = (t.foreground, t.hover_soft());
    div()
        .id(id)
        .flex_none()
        .rounded(px(6.))
        .border_1()
        .border_color(t.border)
        .px(px(12.))
        .py(px(6.))
        .text_size(px(12.))
        .text_color(t.muted)
        .cursor_pointer()
        .hover(move |el| el.text_color(fg).bg(hover))
        .child(label.to_string())
}

fn primary_button(id: impl Into<ElementId>, label: &str, t: &Tokens) -> Stateful<Div> {
    div()
        .id(id)
        .flex_none()
        .rounded(px(6.))
        .px(px(12.))
        .py(px(6.))
        .text_size(px(12.))
        .bg(t.accent)
        .text_color(t.foreground)
        .cursor_pointer()
        .hover(|el| el.opacity(0.9))
        .child(label.to_string())
}

/// `markie-overlay-field`: 13 px text in a bordered field.
fn field(state: &Entity<InputState>, t: &Tokens) -> Div {
    div()
        .w_full()
        .h(px(34.))
        .px(px(4.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .border_1()
        .border_color(t.border)
        .bg(t.background)
        .text_size(px(13.))
        .text_color(t.foreground)
        .child(Input::new(state).appearance(false).with_size(gpui_kit::component::Size::Small).text_size(px(13.)).w_full())
}

#[cfg(test)]
mod tests {
    use super::{Status, account_line, host_of, sign_in_button};

    #[test]
    fn rows_say_who_is_signed_in_like_account_line() {
        assert_eq!(account_line(Status::Checking, None), "Checking…");
        assert_eq!(account_line(Status::In, Some("a@b.c")), "Signed in as a@b.c");
        assert_eq!(account_line(Status::In, None), "Not signed in");
        assert_eq!(account_line(Status::Out, Some("a@b.c")), "Not signed in");
    }

    #[test]
    fn hosts_drop_default_ports() {
        assert_eq!(host_of("https://api.markiedocs.com"), "api.markiedocs.com");
        assert_eq!(host_of("http://localhost:18787"), "localhost:18787");
        assert_eq!(host_of("not a url"), "not a url");
    }

    #[test]
    fn the_submit_button_reads_like_server_sign_in() {
        assert_eq!(sign_in_button(false, false), "Sign in");
        assert_eq!(sign_in_button(false, true), "Create account");
        assert_eq!(sign_in_button(true, true), "…");
    }
}
