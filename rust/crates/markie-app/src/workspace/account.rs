//! Markie Cloud sign-in, the account sheet and the Cloud workspace.
//!
//! Mirrors the Electron app: `src/components/sign-in.tsx` (the form, its views
//! and wording), the Account tab of `settings.tsx` (who is signed in, sign
//! out, linked sign-ins), `linked-identities.tsx` (read only here) and the
//! Cloud destination of `library.tsx` and `cloud-view.tsx`.
//!
//! The session is Markie RS's own: one Keychain item under the service
//! "Markie RS", never the Electron app's sign-in. Google and Apple go through
//! the system browser and come back on `markie-rs://auth`, which only this app
//! registers. Network work runs on a small tokio runtime; GPUI awaits it.

use std::future::Future;
use std::sync::{Arc, OnceLock, RwLock};

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::text::{TextView, TextViewState};
use gpui_kit::component::{ActiveTheme, Icon, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_cloud::account::{self as identities_api, AccountIdentity, AccountProvider, Identities, IdentitiesError, LinkProvider, LinkStatus, StepUp};
use markie_cloud::auth::{AuthClient, AuthStates, CodeFlow, DeepLinkRefusal, MarkieUser, Provider, SignInOutcome, resolve_auth_deep_link};
use markie_cloud::auth_errors::{self, AuthContext, SignInReason};
use markie_cloud::client::Call;
use markie_cloud::docs::{DocMeta, DocsClient};
use markie_cloud::http::{Method, Transport};
use markie_cloud::origin::Trust;
use markie_cloud::registry::{SignIn, parse_server_info};
use markie_cloud::sharing::{People, PeopleClient, Person};
use markie_cloud::tokens::{KeyringTokenStore, MemoryTokenStore, TokenStore};
use markie_cloud::{CloudClient, CloudError, DEFAULT_SERVER};
use markie_core::registry::Registry;

use super::Workspace;
use crate::actions::{Open, OpenAccount, OpenSettings, ShowCloud};

/// The Keychain service Markie RS keeps its session under. Never "Markie".
pub const KEYCHAIN_SERVICE: &str = "Markie RS";
/// The service used while the app talks to a local test server, so test
/// sessions can never be mistaken for Kirby's real one.
pub const TEST_KEYCHAIN_SERVICE: &str = "Markie RS Test";
/// The registry setting that turns on Google and Apple. Off until Markie Cloud
/// answers `app=markie-rs` with a `markie-rs://` link (zvndev/markie#136).
pub const BROWSER_SIGN_IN_SETTING: &str = "cloud_browser_sign_in";

// ------------------------------------------------------------------ server

/// The server this build signs in to: Markie Cloud, or a localhost server
/// named by `MARKIE_RS_CLOUD_SERVER` for testing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub origin: String,
    pub dev: bool,
}

/// Only an http(s) address on this computer is honoured as a test server.
pub fn dev_server(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    let bare = u.username().is_empty() && u.password().is_none() && u.query().is_none() && u.fragment().is_none() && u.path() == "/";
    (local && bare && matches!(u.scheme(), "http" | "https")).then(|| u.origin().ascii_serialization())
}

pub fn server_config() -> ServerConfig {
    if let Ok(raw) = std::env::var("MARKIE_RS_CLOUD_SERVER") {
        if let Some(origin) = dev_server(&raw) {
            return ServerConfig { origin, dev: true };
        }
        eprintln!("markie-rs: MARKIE_RS_CLOUD_SERVER must be a localhost address; using Markie Cloud");
    }
    ServerConfig { origin: DEFAULT_SERVER.to_string(), dev: false }
}

// ------------------------------------------------------------------ tokens

/// Where Markie RS keeps its sign-ins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenHome {
    /// A scratch data folder (`MARKIE_RS_DATA_DIR`): memory, for this run
    /// only. Scratch copies never touch the Keychain, so parallel test runs
    /// cannot read each other's sessions or raise a Keychain prompt.
    Memory,
    /// The login Keychain under this service.
    Keychain(&'static str),
}

/// The token home for a run: memory with a scratch data folder, else the
/// Keychain, under the test service while a local test server is named.
pub fn token_home(scratch: bool, dev: bool) -> TokenHome {
    match (scratch, dev) {
        (true, _) => TokenHome::Memory,
        (false, true) => TokenHome::Keychain(TEST_KEYCHAIN_SERVICE),
        (false, false) => TokenHome::Keychain(KEYCHAIN_SERVICE),
    }
}

/// The one token store of this process. The sign-in sheet, the Cloud sync
/// workspace, the agent bridge and deep links all read and write it, so a
/// session made in any of them is the session of all of them.
pub fn shared_tokens() -> Arc<dyn TokenStore> {
    static STORE: OnceLock<Arc<dyn TokenStore>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let scratch = std::env::var_os("MARKIE_RS_DATA_DIR").is_some();
            match token_home(scratch, server_config().dev) {
                TokenHome::Memory => Arc::new(MemoryTokenStore::new()),
                TokenHome::Keychain(service) => Arc::new(KeyringTokenStore::new(service)),
            }
        })
        .clone()
}

// ------------------------------------------------------------------ store

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStatus {
    Checking,
    In(MarkieUser),
    Out,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Load<T> {
    Loading,
    Ready(T),
    /// `muted` is the server-has-no-such-feature case Electron shows in grey.
    Failed { message: String, muted: bool },
}

/// What the hand-back did, for the window to react to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountEvent {
    /// A Google or Apple sign-in came back and signed in.
    BrowserSignedIn,
}

/// The one Markie Cloud session of this app, shared by every view.
pub struct AccountStore {
    rt: Option<Arc<tokio::runtime::Runtime>>,
    client: Option<CloudClient>,
    config: ServerConfig,
    states: Arc<AuthStates>,
    registry: Option<Registry>,
    browser_sign_in: bool,
    pub status: AuthStatus,
    /// What `/api/server-info` says the server offers. None until it answers.
    pub sign_in: Option<SignIn>,
    ticket: u64,
    identities: Option<(String, Load<Identities>)>,
    docs: Option<(String, Load<Vec<DocMeta>>)>,
    people: Option<(String, Load<People>)>,
    /// Remove, Block and Unblock in the account sheet (`SharePeopleSettings`).
    pub people_busy: bool,
    pub people_error: Option<String>,
    pub people_notice: Option<String>,
    /// The last hand-back problem, shown on the sign-in form.
    pub hand_back_error: Option<String>,
}

/// The registry setting behind "Sync my documents to the cloud"
/// (Electron's `markie.sync.v1`). Off unless switched on.
pub const SYNC_SETTING: &str = "cloud_sync_enabled";

impl EventEmitter<AccountEvent> for AccountStore {}

struct GlobalAccount(Entity<AccountStore>);
impl Global for GlobalAccount {}

/// Run `fut` on the cloud runtime and hand its output to `done` on the UI thread.
pub(super) fn run_bg<E: 'static, T: Send + 'static>(
    rt: &Arc<tokio::runtime::Runtime>,
    cx: &mut Context<E>,
    fut: impl Future<Output = T> + Send + 'static,
    done: impl FnOnce(&mut E, T, &mut Context<E>) + 'static,
) {
    let handle = rt.spawn(fut);
    cx.spawn(async move |this, cx| {
        if let Ok(value) = handle.await {
            this.update(cx, |this, cx| {
                done(this, value, cx);
                cx.notify();
            })
            .ok();
        }
    })
    .detach();
}

impl AccountStore {
    /// Create the session at launch and restore it from the Keychain.
    pub fn init(cx: &mut App) {
        let store = cx.new(|cx| {
            let mut this = Self::new(server_config());
            this.restore(cx);
            this.load_server_info(cx);
            this
        });
        cx.set_global(GlobalAccount(store));
    }

    pub fn global(cx: &App) -> Option<Entity<AccountStore>> {
        cx.try_global::<GlobalAccount>().map(|g| g.0.clone())
    }

    fn new(config: ServerConfig) -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("markie-cloud")
            .enable_all()
            .build()
            .map(Arc::new)
            .map_err(|e| eprintln!("markie-rs: cloud runtime unavailable: {e}"))
            .ok();
        let trust = Arc::new(RwLock::new(Trust::new([], config.dev)));
        let client = CloudClient::new(&config.origin, trust, shared_tokens(), Transport::new())
            .map_err(|e| eprintln!("markie-rs: cloud client unavailable: {e}"))
            .ok();
        let registry = Registry::open(&markie_core::paths::data_dir().join("registry.db")).ok();
        let browser_sign_in = registry.as_ref().and_then(|r| r.setting(BROWSER_SIGN_IN_SETTING).ok().flatten()).is_some_and(|v| v == "on");
        Self {
            rt,
            client,
            config,
            states: Arc::new(AuthStates::new()),
            registry,
            browser_sign_in,
            status: AuthStatus::Checking,
            sign_in: None,
            ticket: 0,
            identities: None,
            docs: None,
            people: None,
            people_busy: false,
            people_error: None,
            people_notice: None,
            hand_back_error: None,
        }
    }

    /// "Sync my documents to the cloud", as stored (`getSyncEnabled`).
    pub fn sync_enabled(&self) -> bool {
        self.registry.as_ref().and_then(|r| r.setting(SYNC_SETTING).ok().flatten()).as_deref() == Some("true")
    }

    pub fn set_sync_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(r) = &self.registry {
            let _ = r.set_setting(SYNC_SETTING, if on { "true" } else { "false" });
        }
        cx.notify();
    }

    /// Remove, Block or Unblock someone, then read the lists again.
    pub fn people_act(&mut self, kind: &'static str, person: String, done: String, failed: &'static str, cx: &mut Context<Self>) {
        let Some((rt, client)) = self.backend() else { return };
        self.people_busy = true;
        self.people_error = None;
        self.people_notice = None;
        cx.notify();
        run_bg(
            &rt,
            cx,
            async move {
                let people = PeopleClient::new(&client);
                match kind {
                    "block" => people.block(&person).await,
                    "unblock" => people.unblock(&person).await,
                    _ => people.remove(&person).await,
                }
            },
            move |this: &mut Self, result, cx| {
                this.people_busy = false;
                match result {
                    Ok(()) => this.people_notice = Some(done),
                    Err(_) => this.people_error = Some(failed.into()),
                }
                this.load_people(cx);
            },
        );
    }

    pub(crate) fn backend(&self) -> Option<(Arc<tokio::runtime::Runtime>, CloudClient)> {
        Some((self.rt.clone()?, self.client.clone()?))
    }

    pub fn user(&self) -> Option<&MarkieUser> {
        match &self.status {
            AuthStatus::In(u) => Some(u),
            _ => None,
        }
    }

    /// Whether Google and Apple may start. Off by default until the server
    /// change that answers on `markie-rs://` is live.
    pub fn browser_sign_in(&self) -> bool {
        self.browser_sign_in
    }

    pub fn set_browser_sign_in(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(r) = &self.registry {
            let _ = r.set_setting(BROWSER_SIGN_IN_SETTING, if on { "on" } else { "off" });
        }
        self.browser_sign_in = on;
        cx.notify();
    }

    /// Ask the server whether this session is alive, the way the Electron
    /// auth store's boot probe does. Offline reads as signed out.
    pub fn restore(&mut self, cx: &mut Context<Self>) {
        self.ticket += 1;
        let mine = self.ticket;
        self.status = AuthStatus::Checking;
        let Some((rt, client)) = self.backend() else {
            self.status = AuthStatus::Out;
            return;
        };
        run_bg(
            &rt,
            cx,
            async move {
                if client.session().is_none() {
                    return Ok(None);
                }
                let me = AuthClient::new(&client).me().await;
                // A token the server refuses is no session; forget it.
                if matches!(me, Err(CloudError::Status { status: 401, .. })) {
                    let _ = client.set_token(None);
                }
                me
            },
            move |this: &mut Self, me, cx| {
                if mine != this.ticket {
                    return;
                }
                this.status = match me {
                    Ok(Some(user)) => AuthStatus::In(user),
                    _ => AuthStatus::Out,
                };
                this.load_people(cx);
            },
        );
    }

    fn load_server_info(&mut self, cx: &mut Context<Self>) {
        let Some((rt, client)) = self.backend() else { return };
        let origin = self.config.origin.clone();
        run_bg(
            &rt,
            cx,
            async move {
                let answer = client.call(Call::new(Method::Get, "/api/server-info").anonymous().max_bytes(64 * 1024)).await.ok()?;
                parse_server_info(answer.data.as_ref()?, &origin).ok().map(|i| i.sign_in)
            },
            |this: &mut Self, sign_in, _| this.sign_in = sign_in,
        );
    }

    /// A sign-in finished with an account `/api/me` confirmed.
    pub fn set_signed_in(&mut self, user: MarkieUser, cx: &mut Context<Self>) {
        self.ticket += 1;
        self.status = AuthStatus::In(user);
        self.identities = None;
        self.docs = None;
        self.people = None;
        self.hand_back_error = None;
        self.load_people(cx);
        cx.notify();
    }

    /// The sheet's email-code route, with the code read from a console-mail
    /// server's log instead of typed. Only `cloud_drive.rs` calls this, and
    /// only for a test server on this computer and a scratch data folder.
    pub(super) fn sign_in_with_logged_code(&mut self, email: String, server_log: std::path::PathBuf, cx: &mut Context<Self>) {
        if !self.config.dev {
            return;
        }
        let Some((rt, client)) = self.backend() else { return };
        run_bg(
            &rt,
            cx,
            async move {
                let auth = AuthClient::new(&client);
                let flow = auth.send_code(&email).await.map_err(|e| e.to_string())?;
                let needle = format!("to={email} subject=\"");
                for _ in 0..200 {
                    let text = std::fs::read_to_string(&server_log).unwrap_or_default();
                    let code = text
                        .lines()
                        .filter(|l| l.contains(&needle))
                        .filter_map(|l| l.split(&needle).nth(1)?.split(' ').next().map(str::to_string))
                        .last();
                    if let Some(code) = code {
                        return auth.verify_code(&flow, &code).await.map_err(|e| e.to_string());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                Err("no code in the server log".to_string())
            },
            |this: &mut Self, result, cx| match result {
                Ok(user) => this.set_signed_in(user, cx),
                Err(e) => eprintln!("markie-rs drive: sign-in failed: {e}"),
            },
        );
    }

    /// Sign out here at once, and end the session at the server too.
    pub fn sign_out(&mut self, cx: &mut Context<Self>) {
        self.ticket += 1;
        use markie_cloud::asset_cache::{AssetCache, CACHE_DIRECTORY};
        let _ = AssetCache::clear(&markie_core::paths::data_dir().join(CACHE_DIRECTORY));
        self.status = AuthStatus::Out;
        self.identities = None;
        self.docs = None;
        self.people = None;
        cx.notify();
        let Some((rt, client)) = self.backend() else { return };
        run_bg(&rt, cx, async move { AuthClient::new(&client).sign_out().await }, |_: &mut Self, result, _| {
            if let Err(e) = result {
                eprintln!("markie-rs: sign-out did not reach the server: {e}");
            }
        });
    }

    /// Sign-out hides cached assets immediately, even while the server is
    /// still ending the session and holds the token for that final request.
    pub(super) fn cache_excluded_origin(&self) -> Option<&str> {
        matches!(self.status, AuthStatus::Out).then_some(self.config.origin.as_str())
    }

    /// The browser start URL with a fresh single-use nonce, or None.
    pub fn browser_start_url(&self, provider: Provider) -> Option<String> {
        AuthClient::new(self.client.as_ref()?).browser_start_url(provider, &self.states)
    }

    /// A `markie-rs://` URL macOS handed the app. Anything but a hand-back for
    /// a sign-in this app started is refused and logged, as Electron does.
    pub fn handle_link(&mut self, link: &str, cx: &mut Context<Self>) {
        let adopted = match resolve_auth_deep_link(link, &self.config.origin, &self.states) {
            Ok(t) if t.origin.is_none() => t,
            Ok(_) | Err(DeepLinkRefusal::IssuerMismatch) => {
                eprintln!("markie-rs://auth rejected: the token is not from the server the sign-in was started on");
                return;
            }
            Err(DeepLinkRefusal::NoPending) => {
                eprintln!("markie-rs://auth rejected: no matching sign-in was pending");
                return;
            }
            Err(DeepLinkRefusal::NotAuth) => {
                eprintln!("markie-rs: ignored a link that is not a sign-in hand-back");
                return;
            }
        };
        let Some((rt, client)) = self.backend() else { return };
        self.ticket += 1;
        let mine = self.ticket;
        run_bg(
            &rt,
            cx,
            async move { AuthClient::new(&client).adopt_token(&adopted.token).await },
            move |this: &mut Self, result, cx| {
                if mine != this.ticket {
                    return;
                }
                match result {
                    Ok(Some(user)) => {
                        this.set_signed_in(user, cx);
                        cx.emit(AccountEvent::BrowserSignedIn);
                    }
                    Ok(None) | Err(_) => {
                        this.hand_back_error = Some("Sign-in didn't complete. Try again, or use an email code.".into());
                    }
                }
            },
        );
    }

    // ---------------------------------------------------- linked sign-ins

    pub fn identities(&self) -> Option<&Load<Identities>> {
        let user = self.user()?;
        self.identities.as_ref().filter(|(id, _)| *id == user.id).map(|(_, l)| l)
    }

    pub fn load_identities(&mut self, cx: &mut Context<Self>) {
        let Some(user_id) = self.user().map(|u| u.id.clone()) else { return };
        let Some((rt, client)) = self.backend() else { return };
        self.identities = Some((user_id.clone(), Load::Loading));
        run_bg(
            &rt,
            cx,
            async move { markie_cloud::account::identities(&client).await },
            move |this: &mut Self, result, _| {
                let load = match result {
                    Ok(list) => Load::Ready(list),
                    Err(e @ IdentitiesError::Unsupported) => Load::Failed { message: e.message().into(), muted: true },
                    Err(e) => Load::Failed { message: e.message().into(), muted: false },
                };
                if this.user().is_some_and(|u| u.id == user_id) {
                    this.identities = Some((user_id, load));
                }
            },
        );
    }

    // ---------------------------------------------------- accepted people

    pub fn people(&self) -> Option<&Load<People>> {
        let user = self.user()?;
        self.people.as_ref().filter(|(id, _)| *id == user.id).map(|(_, l)| l)
    }

    fn load_people(&mut self, cx: &mut Context<Self>) {
        let Some(user_id) = self.user().map(|u| u.id.clone()) else { return };
        let Some((rt, client)) = self.backend() else { return };
        self.people = Some((user_id.clone(), Load::Loading));
        run_bg(
            &rt,
            cx,
            async move { PeopleClient::new(&client).people().await },
            move |this: &mut Self, result, _| {
                let load = match result {
                    Ok(people) => Load::Ready(people),
                    Err(_) => Load::Failed { message: "Couldn't load the people you accepted.".into(), muted: true },
                };
                if this.user().is_some_and(|u| u.id == user_id) {
                    this.people = Some((user_id, load));
                }
            },
        );
    }

    // ---------------------------------------------------- cloud documents

    pub fn docs(&self) -> Option<&Load<Vec<DocMeta>>> {
        let user = self.user()?;
        self.docs.as_ref().filter(|(id, _)| *id == user.id).map(|(_, l)| l)
    }

    pub fn load_docs(&mut self, cx: &mut Context<Self>) {
        let Some(user_id) = self.user().map(|u| u.id.clone()) else { return };
        let Some((rt, client)) = self.backend() else { return };
        self.docs = Some((user_id.clone(), Load::Loading));
        run_bg(
            &rt,
            cx,
            async move { DocsClient::new(&client).list().await },
            move |this: &mut Self, result, _| {
                let load = match result {
                    Ok(mut docs) => {
                        // Newest first, like the Cloud page.
                        docs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                        Load::Ready(docs)
                    }
                    Err(CloudError::Offline) => Load::Failed { message: "Can't reach Markie's server. Check your connection.".into(), muted: false },
                    Err(_) => Load::Failed { message: "Couldn't load your cloud documents. Try again.".into(), muted: false },
                };
                if this.user().is_some_and(|u| u.id == user_id) {
                    this.docs = Some((user_id, load));
                }
            },
        );
    }
}

/// The signed-in account, for surfaces outside this module (the rail).
pub fn signed_in_user(cx: &App) -> Option<MarkieUser> {
    AccountStore::global(cx).and_then(|s| s.read(cx).user().cloned())
}

/// The account button's avatar: `colorForName` and `initials` from collab.ts.
pub fn avatar_for(user: &MarkieUser) -> (Hsla, String) {
    let shown = user.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| user.email.clone());
    let hex = markie_cloud::collab::color_for_name(&shown).trim_start_matches('#');
    let color = u32::from_str_radix(hex, 16).map(rgb).map(Hsla::from).unwrap_or_else(|_| Hsla::white());
    (color, markie_cloud::collab::initials(&shown))
}

/// Hand the `markie-rs://` URLs macOS passed to the session.
pub fn handle_open_urls(links: Vec<String>, cx: &mut App) {
    let Some(store) = AccountStore::global(cx) else { return };
    store.update(cx, |store, cx| {
        for link in links {
            store.handle_link(&link, cx);
        }
    });
}

// ------------------------------------------------------------------ look

/// Markie's overlay colours, from `globals.css` (`.markie-overlay-*`).
#[derive(Clone, Copy)]
struct Look {
    dark: bool,
    fg: Hsla,
    muted: Hsla,
    border: Hsla,
    accent: Hsla,
    surface2: Hsla,
    panel_bg: Hsla,
    panel_border: Hsla,
    field_bg: Hsla,
    field_border: Hsla,
    focus: Hsla,
    red: Hsla,
    blue: Hsla,
    green: Hsla,
    yellow: Hsla,
    background: Hsla,
}

/// `color-mix(in srgb, a w%, b)`.
fn mix(a: Hsla, b: Hsla, wa: f32) -> Hsla {
    let a: Rgba = a.into();
    let b: Rgba = b.into();
    let wb = 1.0 - wa;
    Rgba { r: a.r * wa + b.r * wb, g: a.g * wa + b.g * wb, b: a.b * wa + b.b * wb, a: a.a * wa + b.a * wb }.into()
}

fn look(cx: &App) -> Look {
    let t = cx.theme();
    let dark = t.mode.is_dark();
    let background = t.background;
    let surface = t.muted;
    let surface2 = t.secondary;
    let border = t.border;
    let fg = t.foreground;
    let blue = t.info;
    Look {
        dark,
        fg,
        muted: t.muted_foreground,
        border,
        accent: t.accent,
        surface2,
        panel_bg: if dark { surface2 } else { mix(background, surface2, 0.58) },
        panel_border: if dark { border } else { border.opacity(0.6) },
        field_bg: if dark { mix(background, surface, 0.82) } else { background },
        field_border: if dark { border } else { mix(fg, border, 0.14) },
        focus: if dark { mix(blue, border, 0.72) } else { blue.opacity(0.45) },
        red: t.danger,
        blue,
        green: t.success,
        yellow: t.warning,
        background,
    }
}

/// The full-width filled button (`PRIMARY` in sign-in.tsx).
fn primary_button(id: impl Into<ElementId>, label: impl Into<SharedString>, disabled: bool, l: Look) -> Stateful<Div> {
    div()
        .id(id.into())
        .w_full()
        .h(px(35.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .bg(l.accent)
        .text_size(px(13.))
        .text_color(l.fg)
        .child(label.into())
        .when(disabled, |el| el.opacity(0.5))
        .when(!disabled, |el| el.cursor_pointer().hover(|s| s.opacity(0.9)))
}

/// The full-width outlined button (`SECONDARY`).
fn secondary_button(id: impl Into<ElementId>, label: impl Into<SharedString>, disabled: bool, l: Look) -> Stateful<Div> {
    div()
        .id(id.into())
        .w_full()
        .h(px(35.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .border_1()
        .border_color(l.border)
        .text_size(px(13.))
        .text_color(l.fg.opacity(0.9))
        .child(label.into())
        .when(disabled, |el| el.opacity(0.5))
        .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.bg(l.accent.opacity(0.4))))
}

/// The small text link (`LINK`).
fn link_button(id: impl Into<ElementId>, label: impl Into<SharedString>, disabled: bool, l: Look) -> Stateful<Div> {
    div()
        .id(id.into())
        .text_size(px(11.))
        .line_height(px(16.5))
        .text_color(l.muted)
        .child(label.into())
        .when(disabled, |el| el.opacity(0.5))
        .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.text_color(l.fg)))
}

/// A small bordered button (`BUTTON` in settings.tsx and linked-identities.tsx).
fn small_button(id: impl Into<ElementId>, label: impl Into<SharedString>, px_x: f32, px_y: f32, size: f32, l: Look) -> Stateful<Div> {
    div()
        .id(id.into())
        .flex_none()
        .px(px(px_x))
        .py(px(px_y))
        .rounded(px(6.))
        .border_1()
        .border_color(l.border)
        .text_size(px(size))
        .text_color(l.muted)
        .cursor_pointer()
        .child(label.into())
        .hover(move |s| s.text_color(l.fg))
}

/// A text field styled like `.markie-overlay-field`.
fn field(state: &Entity<InputState>, focused: bool, l: Look) -> Div {
    div()
        .w_full()
        .h(px(36.))
        // The input adds its own inset; together they make Electron's 12 px.
        .px(px(4.))
        .flex()
        .items_center()
        .rounded(px(7.))
        .border_1()
        .border_color(if focused { l.focus } else { l.field_border })
        .bg(l.field_bg)
        .text_size(px(13.))
        .text_color(l.fg)
        .child(Input::new(state).appearance(false).with_size(gpui_kit::component::Size::Small).text_size(px(13.)).w_full())
}

fn muted_line(text: impl Into<SharedString>, size: f32, l: Look) -> Div {
    div().text_size(px(size)).text_color(l.muted).child(text.into())
}

// ------------------------------------------------------------------ form

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum View {
    Choose,
    OtpCode,
    Password,
    ResetRequest,
    ResetVerify,
}

/// The sign-in form. A port of `SignInForm` in sign-in.tsx: Google and Apple
/// through the browser, an emailed code, or a password, with sign-up, address
/// proof and password reset.
pub struct SignInForm {
    store: Entity<AccountStore>,
    reason: SignInReason,
    view: View,
    email: Entity<InputState>,
    password: Entity<InputState>,
    new_password: Entity<InputState>,
    name: Entity<InputState>,
    otp: Entity<InputState>,
    is_sign_up: bool,
    proving: bool,
    flow: Option<CodeFlow>,
    error: Option<String>,
    notice: Option<String>,
    busy: bool,
    /// Inputs to empty at the next render, which has the window.
    clear: Vec<Entity<InputState>>,
    /// Text to put in the password field at the next render.
    fill_password: Option<String>,
    /// Put the caret in the code field at the next render, once the code
    /// view is up, so the code can be typed or pasted straight away.
    focus_otp: bool,
    _subs: Vec<Subscription>,
}

impl SignInForm {
    pub fn new(store: Entity<AccountStore>, reason: SignInReason, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let email = cx.new(|cx| InputState::new(window, cx).placeholder("you@work.com"));
        let password = cx.new(|cx| InputState::new(window, cx).placeholder("Password").masked(true));
        let new_password = cx.new(|cx| InputState::new(window, cx).placeholder("New password (8+ characters)").masked(true));
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Name"));
        let otp = cx.new(|cx| InputState::new(window, cx).placeholder("6-digit code"));
        let mut subs = vec![cx.observe(&store, |_, _, cx| cx.notify())];
        for (input, which) in [(&email, 0u8), (&password, 1), (&new_password, 2), (&name, 3), (&otp, 4)] {
            subs.push(cx.subscribe_in(input, window, move |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => this.on_enter(which, window, cx),
                InputEvent::Change | InputEvent::Focus | InputEvent::Blur => cx.notify(),
            }));
        }
        Self {
            store,
            reason,
            view: View::Choose,
            email,
            password,
            new_password,
            name,
            otp,
            is_sign_up: false,
            proving: false,
            flow: None,
            error: None,
            notice: None,
            busy: false,
            clear: Vec::new(),
            fill_password: None,
            focus_otp: false,
            _subs: subs,
        }
    }

    fn value(input: &Entity<InputState>, cx: &App) -> String {
        input.read(cx).value().to_string()
    }

    fn email(&self, cx: &App) -> String {
        Self::value(&self.email, cx)
    }

    /// The code as Electron keeps it: trimmed on every change.
    fn otp(&self, cx: &App) -> String {
        Self::value(&self.otp, cx).trim().to_string()
    }

    fn set_view(&mut self, view: View, cx: &mut Context<Self>) {
        self.view = view;
        cx.notify();
    }

    fn on_enter(&mut self, which: u8, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let email = !self.email(cx).is_empty();
        match (self.view, which) {
            (View::Choose, 0) if email => self.send_code(cx),
            (View::Password, 1) if email && !Self::value(&self.password, cx).is_empty() => self.submit_password(cx),
            (View::OtpCode, 4) if self.otp(cx).len() >= 6 => self.verify_code(cx),
            (View::ResetRequest, 0) if email => self.request_reset(cx),
            (View::ResetVerify, 2) if self.otp(cx).len() >= 6 && Self::value(&self.new_password, cx).len() >= 8 => self.submit_reset(cx),
            _ => {}
        }
        let _ = window;
    }

    /// Every request goes through here so none can forget to clear the last
    /// error or invent its own wording.
    fn run<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(CloudClient) -> std::pin::Pin<Box<dyn Future<Output = T> + Send>>,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        let Some((rt, client)) = self.store.read(cx).backend() else {
            self.error = Some(auth_errors::GENERIC.into());
            return;
        };
        self.busy = true;
        self.error = None;
        self.notice = None;
        cx.notify();
        run_bg(&rt, cx, work(client), move |this: &mut Self, value, cx| {
            this.busy = false;
            done(this, value, cx);
        });
    }

    /// A session now exists: tell the store, so every surface updates.
    fn landed(&mut self, user: MarkieUser, cx: &mut Context<Self>) {
        self.store.update(cx, |s, cx| s.set_signed_in(user, cx));
        self.proving = false;
        self.is_sign_up = false;
        self.flow = None;
        self.view = View::Choose;
        self.clear = vec![self.password.clone(), self.new_password.clone(), self.otp.clone(), self.name.clone()];
    }

    fn start_provider(&mut self, provider: Provider, cx: &mut Context<Self>) {
        self.error = None;
        let label = if provider == Provider::Apple { "Apple" } else { "Google" };
        let store = self.store.read(cx);
        // Against a local test server, MARKIE_RS_NO_BROWSER keeps the browser
        // closed and logs the start URL instead, for scripted tests.
        let quiet = store.config.dev && std::env::var_os("MARKIE_RS_NO_BROWSER").is_some();
        match store.browser_start_url(provider) {
            Some(url) if quiet => eprintln!("markie-rs: browser sign-in start (not opened): {url}"),
            Some(url) => cx.open_url(&url),
            None => self.error = Some(format!("Couldn't start {label} sign-in on this machine. Use an email code instead.")),
        }
        cx.notify();
    }

    fn send_code(&mut self, cx: &mut Context<Self>) {
        let email = self.email(cx);
        self.run(cx, move |c| Box::pin(async move { AuthClient::new(&c).send_code(&email).await }), |this, r, cx| match r {
            Ok(flow) => {
                this.flow = Some(flow);
                this.clear.push(this.otp.clone());
                this.focus_otp = true;
                this.set_view(View::OtpCode, cx);
            }
            Err(e) => this.error = Some(auth_errors::auth_error_message(&e, AuthContext::OtpSend).into()),
        });
    }

    /// The account exists but its address was never proven: send a proof
    /// code and say so on the code view.
    fn prove_address(&mut self, cx: &mut Context<Self>) {
        self.proving = true;
        self.clear.push(self.otp.clone());
        self.focus_otp = true;
        self.view = View::OtpCode;
        let email = self.email(cx);
        self.run(cx, move |c| Box::pin(async move { AuthClient::new(&c).send_verification_code(&email).await }), |this, r, _| {
            if let Err(e) = r {
                this.error = Some(auth_errors::auth_error_message(&e, AuthContext::OtpSend).into());
            }
        });
    }

    /// Resending stays on whichever route brought the user here.
    fn resend_code(&mut self, cx: &mut Context<Self>) {
        let email = self.email(cx);
        if self.proving {
            self.run(cx, move |c| Box::pin(async move { AuthClient::new(&c).send_verification_code(&email).await }), |this, r, _| {
                if let Err(e) = r {
                    this.error = Some(auth_errors::auth_error_message(&e, AuthContext::OtpSend).into());
                }
            });
        } else {
            self.run(cx, move |c| Box::pin(async move { AuthClient::new(&c).send_code(&email).await }), |this, r, _| match r {
                Ok(flow) => this.flow = Some(flow),
                Err(e) => this.error = Some(auth_errors::auth_error_message(&e, AuthContext::OtpSend).into()),
            });
        }
    }

    fn verify_code(&mut self, cx: &mut Context<Self>) {
        let email = self.email(cx);
        let otp = self.otp(cx);
        if self.proving {
            self.run(cx, move |c| Box::pin(async move { AuthClient::new(&c).verify_email(&email, &otp).await }), |this, r, cx| match r {
                Ok(Some(user)) => this.landed(user, cx),
                // Proven, but the server handed back no session: refresh like Electron does.
                Ok(None) => {
                    this.proving = false;
                    this.store.update(cx, |s, cx| s.restore(cx));
                }
                Err(e) => this.error = Some(auth_errors::auth_error_message(&e, AuthContext::OtpVerify).into()),
            });
            return;
        }
        let Some(flow) = self.flow.clone() else {
            self.send_code(cx);
            return;
        };
        self.run(cx, move |c| Box::pin(async move { AuthClient::new(&c).verify_code(&flow, &otp).await }), |this, r, cx| match r {
            Ok(user) => this.landed(user, cx),
            Err(e) => this.error = Some(auth_errors::auth_error_message(&e, AuthContext::OtpVerify).into()),
        });
    }

    fn submit_password(&mut self, cx: &mut Context<Self>) {
        let email = self.email(cx);
        let password = Self::value(&self.password, cx);
        let sign_up = self.is_sign_up;
        let name = Self::value(&self.name, cx);
        let name = if name.is_empty() { email.split('@').next().unwrap_or_default().to_string() } else { name };
        self.run(
            cx,
            move |c| {
                Box::pin(async move {
                    let auth = AuthClient::new(&c);
                    if sign_up { auth.sign_up_email(&email, &password, &name).await } else { auth.sign_in_email(&email, &password).await }
                })
            },
            move |this, r, cx| match r {
                Ok(SignInOutcome::SignedIn(user)) => this.landed(user, cx),
                // Two answers, one situation: the address is not proven yet.
                Ok(SignInOutcome::NeedsVerification) => this.prove_address(cx),
                Err(e) => {
                    let context = if sign_up { AuthContext::PasswordSignUp } else { AuthContext::PasswordSignIn };
                    let msg = auth_errors::signup_refusal(&e).unwrap_or_else(|| auth_errors::auth_error_message(&e, context));
                    this.error = Some(msg.into());
                }
            },
        );
    }

    fn request_reset(&mut self, cx: &mut Context<Self>) {
        let email = self.email(cx);
        self.run(cx, move |c| Box::pin(async move { AuthClient::new(&c).request_password_reset(&email).await }), |this, r, cx| match r {
            Ok(()) => {
                this.clear.extend([this.otp.clone(), this.new_password.clone()]);
                this.set_view(View::ResetVerify, cx);
            }
            Err(e) => this.error = Some(auth_errors::auth_error_message(&e, AuthContext::ResetRequest).into()),
        });
    }

    fn submit_reset(&mut self, cx: &mut Context<Self>) {
        let email = self.email(cx);
        let otp = self.otp(cx);
        let password = Self::value(&self.new_password, cx);
        let kept = password.clone();
        self.run(
            cx,
            move |c| {
                Box::pin(async move {
                    let auth = AuthClient::new(&c);
                    auth.reset_password(&email, &otp, &password).await?;
                    // better-auth resets the credential without a session, so
                    // finish with the password just set.
                    Ok::<_, CloudError>(auth.sign_in_email(&email, &password).await)
                })
            },
            move |this, r, cx| match r {
                Ok(Ok(SignInOutcome::SignedIn(user))) => this.landed(user, cx),
                Ok(signed_in) => {
                    if let Err(e) = signed_in {
                        this.error = Some(auth_errors::auth_error_message(&e, AuthContext::PasswordSignIn).into());
                    }
                    this.fill_password = Some(kept);
                    this.view = View::Password;
                    this.notice = Some("Password updated. Sign in with your new password.".into());
                }
                Err(e) => this.error = Some(auth_errors::auth_error_message(&e, AuthContext::ResetVerify).into()),
            },
        );
    }

    fn focused(input: &Entity<InputState>, window: &Window, cx: &App) -> bool {
        input.read(cx).focus_handle(cx).is_focused(window)
    }
}

impl Render for SignInForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for input in std::mem::take(&mut self.clear) {
            input.update(cx, |s, cx| s.set_value("", window, cx));
        }
        if let Some(text) = self.fill_password.take() {
            self.password.update(cx, |s, cx| s.set_value(text, window, cx));
        }
        if std::mem::take(&mut self.focus_otp) && self.view == View::OtpCode {
            self.otp.update(cx, |s, cx| s.focus(window, cx));
        }
        let l = look(cx);
        let (title, body) = auth_errors::reason_copy(self.reason);
        let store = self.store.read(cx);
        let browser = store.browser_sign_in();
        let allow_apple = store.sign_in.as_ref().is_some_and(|s| s.apple);
        let hand_back_error = store.hand_back_error.clone();
        let busy = self.busy;
        let email = self.email(cx);
        let otp = self.otp(cx);
        let password = Self::value(&self.password, cx);
        let new_password = Self::value(&self.new_password, cx);
        let f = |input: &Entity<InputState>| field(input, Self::focused(input, window, cx), l);

        let mut col = v_flex().w_full().gap(px(12.)).child(
            v_flex()
                .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(l.fg).child(title))
                .child(div().mt(px(4.)).text_size(px(12.)).line_height(relative(1.625)).text_color(l.muted).child(body)),
        );

        match self.view {
            View::Choose => {
                let provider_disabled = busy || !browser;
                col = col
                    .child(primary_button("google", "Continue with Google", provider_disabled, l).when(!provider_disabled, |el| {
                        el.on_click(cx.listener(|this, _, _, cx| this.start_provider(Provider::Google, cx)))
                    }))
                    .when(allow_apple, |col| {
                        col.child(primary_button("apple", "Continue with Apple", provider_disabled, l).when(!provider_disabled, |el| {
                            el.on_click(cx.listener(|this, _, _, cx| this.start_provider(Provider::Apple, cx)))
                        }))
                    })
                    // Markie RS's own note: the line wraps inside the
                    // panel, with the switch on its own line under it.
                    .when(!browser, |col| {
                        col.child(
                            v_flex()
                                .w_full()
                                .gap(px(4.))
                                .child(muted_line("Google and Apple sign-in in Markie RS wait for a Markie Cloud update. Use an email code for now.", 11., l).w_full().line_height(relative(1.5)))
                                .child(h_flex().child(link_button("browser-on", "Server updated? Turn them on", false, l).on_click(cx.listener(|this, _, _, cx| {
                                    this.store.update(cx, |s, cx| s.set_browser_sign_in(true, cx));
                                })))),
                        )
                    })
                    .child(
                        h_flex()
                            .gap(px(12.))
                            .py(px(4.))
                            .child(div().h(px(1.)).flex_1().bg(l.border))
                            .child(muted_line("or", 11., l))
                            .child(div().h(px(1.)).flex_1().bg(l.border)),
                    )
                    .child(f(&self.email))
                    .child(
                        secondary_button("send-code", if busy { "Sending…" } else { "Email me a code" }, busy || email.is_empty(), l)
                            .when(!busy && !email.is_empty(), |el| el.on_click(cx.listener(|this, _, _, cx| this.send_code(cx)))),
                    )
                    .child(muted_line("Use an email verified on your account. New here? Use a password to create an account.", 11., l))
                    .child(h_flex().child(
                        link_button("use-password", "Use a password instead", false, l)
                            .on_click(cx.listener(|this, _, _, cx| this.set_view(View::Password, cx))),
                    ));
            }
            View::OtpCode => {
                let intro = if self.proving {
                    div()
                        .text_size(px(12.))
                        .line_height(relative(1.625))
                        .text_color(l.muted)
                        .child(
                            div().child(
                                StyledText::new(format!(
                                    "Prove this address is yours. We sent a code to {email}. Enter it to finish signing in. Your password still works, and this is a one-time check that the address reaches you."
                                ))
                                .with_highlights([
                                    (0.."Prove this address is yours.".len(), HighlightStyle { color: Some(l.fg), ..Default::default() }),
                                    {
                                        let start = "Prove this address is yours. We sent a code to ".len();
                                        (start..start + email.len(), HighlightStyle { color: Some(l.fg), ..Default::default() })
                                    },
                                ]),
                            ),
                        )
                } else {
                    div().text_size(px(12.)).text_color(l.muted).child(
                        StyledText::new(format!("Code sent to {email}"))
                            .with_highlights([("Code sent to ".len().."Code sent to ".len() + email.len(), HighlightStyle { color: Some(l.fg), ..Default::default() })]),
                    )
                };
                let can_verify = !busy && otp.len() >= 6;
                col = col
                    .child(intro)
                    .child(f(&self.otp))
                    .child(
                        primary_button("verify", if busy { "Verifying…" } else { "Verify" }, !can_verify, l)
                            .when(can_verify, |el| el.on_click(cx.listener(|this, _, _, cx| this.verify_code(cx)))),
                    )
                    .child(
                        h_flex()
                            .justify_between()
                            .child(link_button("resend", "Resend code", busy, l).when(!busy, |el| el.on_click(cx.listener(|this, _, _, cx| this.resend_code(cx)))))
                            .child(link_button("other-email", "Use a different email", false, l).on_click(cx.listener(|this, _, _, cx| {
                                this.proving = false;
                                this.set_view(View::Choose, cx);
                            }))),
                    );
            }
            View::Password => {
                let can_submit = !busy && !email.is_empty() && !password.is_empty();
                col = col
                    .when(self.is_sign_up, |col| col.child(f(&self.name)))
                    .child(f(&self.email))
                    .child(f(&self.password))
                    .child(
                        primary_button("submit-password", if self.is_sign_up { "Create account" } else { "Sign in" }, !can_submit, l)
                            .when(can_submit, |el| el.on_click(cx.listener(|this, _, _, cx| this.submit_password(cx)))),
                    )
                    .child(
                        h_flex()
                            .justify_between()
                            .child(
                                link_button("toggle-signup", if self.is_sign_up { "Have an account? Sign in" } else { "New here? Create account" }, false, l)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.is_sign_up = !this.is_sign_up;
                                        cx.notify();
                                    })),
                            )
                            .when(!self.is_sign_up, |row| {
                                row.child(link_button("forgot", "Forgot?", false, l).on_click(cx.listener(|this, _, _, cx| this.set_view(View::ResetRequest, cx))))
                            }),
                    )
                    .child(h_flex().child(
                        link_button("back-choose", if allow_apple { "Back to Google, Apple and email codes" } else { "Back to Google and email codes" }, false, l)
                            .on_click(cx.listener(|this, _, _, cx| this.set_view(View::Choose, cx))),
                    ));
            }
            View::ResetRequest => {
                let can_send = !busy && !email.is_empty();
                col = col
                    .child(div().text_size(px(12.)).line_height(relative(1.625)).text_color(l.muted).child("We'll email you a code to set a new password."))
                    .child(div().text_size(px(11.)).line_height(relative(1.625)).text_color(l.muted).child("This also works if you do not have a password yet."))
                    .child(f(&self.email))
                    .child(
                        primary_button("send-reset", if busy { "Sending…" } else { "Send reset code" }, !can_send, l)
                            .when(can_send, |el| el.on_click(cx.listener(|this, _, _, cx| this.request_reset(cx)))),
                    )
                    .child(h_flex().child(
                        link_button("back-password", "Back to sign in", false, l).on_click(cx.listener(|this, _, _, cx| this.set_view(View::Password, cx))),
                    ));
            }
            View::ResetVerify => {
                let can_reset = !busy && otp.len() >= 6 && new_password.len() >= 8;
                col = col
                    .child(div().text_size(px(12.)).text_color(l.muted).child(
                        StyledText::new(format!("Code sent to {email}"))
                            .with_highlights([("Code sent to ".len().."Code sent to ".len() + email.len(), HighlightStyle { color: Some(l.fg), ..Default::default() })]),
                    ))
                    .child(f(&self.otp))
                    .child(f(&self.new_password))
                    .child(
                        primary_button("submit-reset", if busy { "Updating…" } else { "Set password and sign in" }, !can_reset, l)
                            .when(can_reset, |el| el.on_click(cx.listener(|this, _, _, cx| this.submit_reset(cx)))),
                    )
                    .child(h_flex().child(link_button("resend-reset", "Resend code", busy, l).when(!busy, |el| el.on_click(cx.listener(|this, _, _, cx| this.request_reset(cx))))));
            }
        }

        col.when_some(self.notice.clone(), |col, n| col.child(muted_line(n, 12., l)))
            .when_some(self.error.clone().or(if self.view == View::Choose { hand_back_error } else { None }), |col, e| {
                col.child(div().text_size(px(12.)).text_color(l.red).child(e))
            })
    }
}

// ------------------------------------------------------------------ account

/// The steps of a linked sign-in change (`IdentityPanel`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Idle,
    PrimaryCode,
    Email,
    EmailCode,
    ProviderWait,
}

/// One change to the account's linked sign-ins, in progress.
struct IdentityFlow {
    step: Step,
    linking: Option<LinkProvider>,
    intent: Option<String>,
    browser_url: Option<String>,
    challenge: Option<String>,
    proof: Option<String>,
    remove: Option<AccountIdentity>,
    remove_provider: Option<(LinkProvider, AccountProvider)>,
    busy: bool,
    /// The message, and whether it is the muted "not on this server" one.
    error: Option<(String, bool)>,
    notice: Option<String>,
    generation: u64,
    _poll: Option<Task<()>>,
}

impl IdentityFlow {
    fn new() -> Self {
        Self {
            step: Step::Idle,
            linking: None,
            intent: None,
            browser_url: None,
            challenge: None,
            proof: None,
            remove: None,
            remove_provider: None,
            busy: false,
            error: None,
            notice: None,
            generation: 0,
            _poll: None,
        }
    }
}

/// What confirming the primary email led to.
enum Confirmed {
    SignedOut,
    Unlinked,
    Linking(identities_api::ProviderLink),
    Proof(String),
}

/// The Account tab of Settings: who is signed in, or the sign-in form.
pub struct AccountSection {
    store: Entity<AccountStore>,
    form: Entity<SignInForm>,
    identities_open: bool,
    flow: IdentityFlow,
    code: Entity<InputState>,
    new_email: Entity<InputState>,
    /// Fields to empty at the next render, which has the window.
    clear: Vec<Entity<InputState>>,
    _subs: Vec<Subscription>,
}

impl AccountSection {
    /// The section for Settings' Account tab. Settings can host this entity
    /// directly instead of opening the sheet.
    pub fn new(store: Entity<AccountStore>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let form = cx.new(|cx| SignInForm::new(store.clone(), SignInReason::Account, window, cx));
        let code = cx.new(|cx| InputState::new(window, cx));
        let new_email = cx.new(|cx| InputState::new(window, cx));
        let subs = vec![
            cx.observe(&store, |_, _, cx| cx.notify()),
            cx.subscribe(&code, |_, _, _: &InputEvent, cx| cx.notify()),
            cx.subscribe(&new_email, |_, _, _: &InputEvent, cx| cx.notify()),
        ];
        Self { store, form, identities_open: false, flow: IdentityFlow::new(), code, new_email, clear: Vec::new(), _subs: subs }
    }

    fn input_value(input: &Entity<InputState>, cx: &App) -> String {
        input.read(cx).value().trim().to_string()
    }

    /// Every change goes through here: one at a time, the last error cleared,
    /// and an answer for an account no longer signed in dropped.
    fn identity_run<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(CloudClient) -> std::pin::Pin<Box<dyn Future<Output = Result<T, identities_api::AccountError>> + Send>>,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        let Some((rt, client)) = self.store.read(cx).backend() else { return };
        let user = self.store.read(cx).user().map(|u| u.id.clone());
        self.flow.generation += 1;
        let ticket = self.flow.generation;
        self.flow.busy = true;
        self.flow.error = None;
        self.flow.notice = None;
        cx.notify();
        run_bg(&rt, cx, work(client), move |this: &mut Self, result, cx| {
            if ticket != this.flow.generation || this.store.read(cx).user().map(|u| u.id.clone()) != user {
                return;
            }
            this.flow.busy = false;
            match result {
                Ok(value) => done(this, value, cx),
                Err(e) => this.flow.error = Some((e.message.clone(), e.unsupported())),
            }
        });
    }

    /// Ask the primary email for a code, for this one change (`begin`).
    fn identity_begin(&mut self, remove: Option<AccountIdentity>, link: Option<LinkProvider>, provider: Option<(LinkProvider, AccountProvider)>, cx: &mut Context<Self>) {
        let scope = match (&provider, link, &remove) {
            (Some((p, _)), _, _) => StepUp::Remove(*p),
            (None, Some(p), _) => StepUp::Link(p),
            (None, None, Some(_)) => StepUp::EmailRemove,
            (None, None, None) => StepUp::EmailAdd,
        };
        self.identity_run(cx, move |c| Box::pin(async move { identities_api::start_step_up(&c, scope).await }), move |this, challenge, cx| {
            this.flow.linking = link;
            this.flow.remove = remove;
            this.flow.remove_provider = provider;
            this.flow.challenge = Some(challenge.challenge_id);
            this.flow.step = Step::PrimaryCode;
            this.flow.notice = Some("A code was sent to your primary email. Confirm it before changing linked sign-ins.".into());
            this.clear_code(cx);
        });
    }

    fn clear_code(&mut self, cx: &mut Context<Self>) {
        self.clear.push(self.code.clone());
        cx.notify();
    }

    /// `confirmPrimary`: the proof, then the change it was asked for.
    fn identity_confirm(&mut self, cx: &mut Context<Self>) {
        let Some(challenge) = self.flow.challenge.clone() else { return };
        let code = Self::input_value(&self.code, cx);
        let remove = self.flow.remove.clone();
        let remove_provider = self.flow.remove_provider.clone();
        let linking = self.flow.linking;
        self.identity_run(
            cx,
            move |c| {
                Box::pin(async move {
                    let proof = identities_api::verify_step_up(&c, &challenge, &code).await?;
                    if let Some((p, row)) = remove_provider {
                        identities_api::unlink_provider(&c, p, &row.id, &proof).await?;
                        return Ok(Confirmed::SignedOut);
                    }
                    if let Some(identity) = remove {
                        identities_api::unlink(&c, &identity.id, &proof).await?;
                        return Ok(Confirmed::Unlinked);
                    }
                    if let Some(p) = linking {
                        return Ok(Confirmed::Linking(identities_api::start_provider_link(&c, p, &proof).await?));
                    }
                    Ok(Confirmed::Proof(proof))
                })
            },
            |this, outcome, cx| {
                this.clear_code(cx);
                match outcome {
                    Confirmed::SignedOut => {
                        this.flow = IdentityFlow::new();
                        this.identities_open = false;
                        this.store.update(cx, |s, cx| s.sign_out(cx));
                    }
                    Confirmed::Unlinked => {
                        this.flow.step = Step::Idle;
                        this.flow.remove = None;
                        this.flow.notice = Some("Sign-in unlinked. Existing documents and cloud areas were kept.".into());
                        this.store.update(cx, |s, cx| s.load_identities(cx));
                    }
                    Confirmed::Linking(link) => {
                        this.flow.intent = Some(link.intent_id);
                        this.flow.browser_url = Some(link.browser_url);
                        this.flow.step = Step::ProviderWait;
                        this.flow.notice = Some("Complete the explicit link in your browser. This does not replace your current Markie sign-in.".into());
                        this.open_link_page(cx);
                        this.watch_link(cx);
                    }
                    Confirmed::Proof(proof) => {
                        this.flow.proof = Some(proof);
                        this.flow.step = Step::Email;
                    }
                }
            },
        );
    }

    /// Open the server's linking page in the browser. Against a local test
    /// server, MARKIE_RS_NO_BROWSER logs it instead, for scripted tests.
    fn open_link_page(&mut self, cx: &mut Context<Self>) {
        let Some(url) = self.flow.browser_url.clone() else { return };
        let quiet = self.store.read(cx).config.dev && std::env::var_os("MARKIE_RS_NO_BROWSER").is_some();
        if quiet {
            eprintln!("markie-rs: linking page (not opened): {}", url.split('#').next().unwrap_or_default());
        } else {
            cx.open_url(&url);
        }
    }

    /// Check the browser link every 5 s until it completes or expires.
    fn watch_link(&mut self, cx: &mut Context<Self>) {
        let (Some(provider), Some(intent)) = (self.flow.linking, self.flow.intent.clone()) else { return };
        let Some((rt, client)) = self.store.read(cx).backend() else { return };
        let generation = self.flow.generation;
        self.flow._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                let (c, i) = (client.clone(), intent.clone());
                let status = rt.spawn(async move { identities_api::provider_link_status(&c, provider, &i).await }).await;
                let keep = this
                    .update(cx, |this, cx| {
                        if this.flow.generation != generation || this.flow.step != Step::ProviderWait {
                            return false;
                        }
                        let label = provider.label();
                        match status {
                            Ok(Ok(LinkStatus::Complete)) => {
                                this.flow = IdentityFlow::new();
                                this.flow.notice = Some(format!("{label} sign-in linked to this account. Your primary account and document access are unchanged."));
                                this.store.update(cx, |s, cx| s.load_identities(cx));
                                cx.notify();
                                false
                            }
                            Ok(Ok(LinkStatus::Expired)) => {
                                this.flow = IdentityFlow::new();
                                this.flow.error = Some((format!("The {label} linking request expired. Confirm your primary email to start again."), false));
                                cx.notify();
                                false
                            }
                            Ok(Ok(LinkStatus::Pending)) => true,
                            _ => {
                                this.flow.error = Some((format!("{label} linking status could not be checked. Your current sign-in has not changed."), false));
                                cx.notify();
                                true
                            }
                        }
                    })
                    .unwrap_or(false);
                if !keep {
                    return;
                }
                cx.background_executor().timer(std::time::Duration::from_secs(5)).await;
            }
        }));
    }

    fn identity_send_email(&mut self, cx: &mut Context<Self>) {
        let Some(proof) = self.flow.proof.clone() else { return };
        let email = Self::input_value(&self.new_email, cx);
        self.identity_run(cx, move |c| Box::pin(async move { identities_api::start_email(&c, &email, &proof).await }), |this, challenge, cx| {
            this.flow.challenge = Some(challenge.challenge_id);
            this.flow.step = Step::EmailCode;
            this.flow.notice = Some("Enter the code sent to the new email. It is not linked until verified.".into());
            this.clear_code(cx);
        });
    }

    fn identity_verify_email(&mut self, cx: &mut Context<Self>) {
        let Some(challenge) = self.flow.challenge.clone() else { return };
        let code = Self::input_value(&self.code, cx);
        self.identity_run(cx, move |c| Box::pin(async move { identities_api::verify_email(&c, &challenge, &code).await }), |this, _, cx| {
            this.flow.step = Step::Idle;
            this.flow.proof = None;
            this.flow.notice = Some("Verified email linked to this account. No accounts were merged.".into());
            this.clear_code(cx);
            this.clear.push(this.new_email.clone());
            this.store.update(cx, |s, cx| s.load_identities(cx));
        });
    }

    fn identity_cancel(&mut self, cx: &mut Context<Self>) {
        let waiting = self.flow.step == Step::ProviderWait && self.flow.linking.is_some();
        self.flow = IdentityFlow { generation: self.flow.generation + 1, ..IdentityFlow::new() };
        self.flow.notice = waiting.then(|| "Stopped checking. A browser flow already started may still complete before it expires.".into());
        self.clear_code(cx);
        cx.notify();
    }

    /// `IdentityPanel` in linked-identities.tsx.
    fn render_identities(&self, l: Look, window: &Window, cx: &mut Context<Self>) -> Div {
        let store = self.store.read(cx);
        let flow = &self.flow;
        let busy = flow.busy;
        let button = |id: &'static str, label: String, disabled: bool| {
            small_button(id, label, 8., 4., 12., l).when(disabled, |el| el.opacity(0.4).cursor_default())
        };
        let mut panel = v_flex().mt(px(8.)).gap(px(8.)).text_size(px(12.)).text_color(l.fg).child(
            div().text_color(l.muted).child("Verified sign-ins reach this same account. Linking never merges another account or changes document access."),
        );
        let (identities, providers, available, listing_error) = match store.identities() {
            Some(Load::Ready(list)) => (list.identities.clone(), list.providers.clone(), (list.google_available, list.apple_available), None),
            Some(Load::Failed { message, muted }) => (Vec::new(), Vec::new(), (false, false), Some((message.clone(), *muted))),
            _ => (Vec::new(), Vec::new(), (false, false), None),
        };
        let loading = matches!(store.identities(), None | Some(Load::Loading));
        let unsupported = listing_error.as_ref().is_some_and(|(_, muted)| *muted) || flow.error.as_ref().is_some_and(|(_, muted)| *muted);
        for (i, identity) in identities.iter().enumerate() {
            let target = identity.clone();
            panel = panel.child(
                h_flex()
                    .flex_wrap()
                    .justify_between()
                    .gap(px(8.))
                    .child(div().child(format!("{} · {}", identity.email, if identity.primary { "Primary" } else { "Verified" })))
                    .when(!identity.primary, |row| {
                        row.child(
                            small_button(SharedString::from(format!("unlink-email-{i}")), "Unlink", 8., 4., 12., l)
                                .when(busy, |el| el.opacity(0.4))
                                .when(!busy, |el| el.on_click(cx.listener(move |this, _, _, cx| this.identity_begin(Some(target.clone()), None, None, cx)))),
                        )
                    }),
            );
        }
        for provider in [LinkProvider::Google, LinkProvider::Apple] {
            for (index, row) in providers.iter().filter(|p| p.provider_id == provider.id()).enumerate() {
                let name = match &row.email {
                    Some(email) => format!("{}: {email}", provider.label()),
                    None => format!("{} sign-in {}", provider.label(), index + 1),
                };
                let target = (provider, row.clone());
                panel = panel.child(
                    h_flex()
                        .flex_wrap()
                        .justify_between()
                        .gap(px(8.))
                        .child(div().child(name))
                        .child(
                            small_button(SharedString::from(format!("unlink-{}-{index}", provider.id())), "Unlink", 8., 4., 12., l)
                                .when(busy, |el| el.opacity(0.4))
                                .when(!busy, |el| el.on_click(cx.listener(move |this, _, _, cx| this.identity_begin(None, None, Some(target.clone()), cx)))),
                        ),
                );
            }
        }
        if let Some((p, _)) = &flow.remove_provider {
            panel = panel.child(div().child(format!(
                "Removing this {} sign-in signs out every active session, including this one. Documents and your primary account are kept. Confirm with the code sent to your primary email.",
                p.label()
            )));
        }
        let no_identities = identities.is_empty();
        if flow.step == Step::Idle && !unsupported && !loading {
            let disabled = busy || no_identities;
            let mut row = h_flex().flex_wrap().gap(px(8.)).child(
                button("link-email", "Link another email".into(), disabled)
                    .when(!disabled, |el| el.on_click(cx.listener(|this, _, _, cx| this.identity_begin(None, None, None, cx)))),
            );
            for (provider, on) in [(LinkProvider::Google, available.0), (LinkProvider::Apple, available.1)] {
                if on {
                    let id = if provider == LinkProvider::Google { "link-google" } else { "link-apple" };
                    row = row.child(
                        button(id, format!("Link {} sign-in", provider.label()), disabled)
                            .when(!disabled, |el| el.on_click(cx.listener(move |this, _, _, cx| this.identity_begin(None, Some(provider), None, cx)))),
                    );
                }
            }
            panel = panel.child(row);
        }
        let code_value = Self::input_value(&self.code, cx);
        let focused = |input: &Entity<InputState>| input.read(cx).focus_handle(cx).is_focused(window);
        match flow.step {
            Step::PrimaryCode => {
                let label = if flow.remove_provider.is_some() {
                    "Confirm unlink and sign out"
                } else if flow.remove.is_some() {
                    "Confirm and unlink"
                } else {
                    "Confirm primary email"
                };
                let disabled = busy || code_value.is_empty();
                let (remove, linking, provider) = (flow.remove.clone(), flow.linking, flow.remove_provider.clone());
                panel = panel
                    .child(v_flex().gap(px(4.)).child("Primary email confirmation code").child(field(&self.code, focused(&self.code), l)))
                    .child(
                        h_flex()
                            .gap(px(8.))
                            .child(button("confirm-primary", label.into(), disabled).when(!disabled, |el| el.on_click(cx.listener(|this, _, _, cx| this.identity_confirm(cx)))))
                            .child(
                                button("resend-primary", "Send a new primary code".into(), busy)
                                    .when(!busy, |el| el.on_click(cx.listener(move |this, _, _, cx| this.identity_begin(remove.clone(), linking, provider.clone(), cx)))),
                            ),
                    );
            }
            Step::Email => {
                let disabled = busy || Self::input_value(&self.new_email, cx).is_empty();
                panel = panel
                    .child(v_flex().gap(px(4.)).child("New sign-in email").child(field(&self.new_email, focused(&self.new_email), l)))
                    .child(h_flex().child(
                        button("send-new-email", "Send verification code".into(), disabled).when(!disabled, |el| el.on_click(cx.listener(|this, _, _, cx| this.identity_send_email(cx)))),
                    ));
            }
            Step::EmailCode => {
                let disabled = busy || code_value.is_empty();
                panel = panel
                    .child(v_flex().gap(px(4.)).child("New email verification code").child(field(&self.code, focused(&self.code), l)))
                    .child(h_flex().child(
                        button("verify-new-email", "Verify and link email".into(), disabled).when(!disabled, |el| el.on_click(cx.listener(|this, _, _, cx| this.identity_verify_email(cx)))),
                    ));
            }
            Step::ProviderWait => {
                if let Some(p) = flow.linking {
                    panel = panel.child(h_flex().child(
                        button("open-link-page", format!("Open {} linking page", p.label()), false).on_click(cx.listener(|this, _, _, cx| this.open_link_page(cx))),
                    ));
                }
            }
            Step::Idle => {}
        }
        if flow.step != Step::Idle {
            let label = match (flow.step, flow.linking) {
                (Step::ProviderWait, Some(p)) => format!("Stop checking {} link", p.label()),
                _ => "Cancel linking change".into(),
            };
            panel = panel.child(h_flex().child(button("cancel-linking", label, busy).when(!busy, |el| el.on_click(cx.listener(|this, _, _, cx| this.identity_cancel(cx))))));
        }
        if busy || loading {
            panel = panel.child(muted_line("Checking account…", 12., l));
        } else if let Some(n) = &flow.notice {
            panel = panel.child(muted_line(n.clone(), 12., l));
        }
        if let Some((message, muted)) = flow.error.clone().or(listing_error) {
            panel = panel.child(div().text_color(if muted { l.muted } else { l.red }).child(message));
        }
        panel
    }

    /// `SharePeopleSettings`: the people whose shares land (Remove, Block)
    /// and the people this account blocked (Unblock).
    fn render_people(&self, l: Look, cx: &mut Context<Self>) -> Div {
        let store = self.store.read(cx);
        let busy = store.people_busy;
        // `.markie-overlay-section`, its 0.08em tracking included.
        let heading = |text: &'static str| {
            div().text_size(px(10.)).font_weight(FontWeight::SEMIBOLD).text_color(l.muted).child(super::dialog_chrome::spaced_caps(text))
        };
        let who = |p: &Person| p.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| p.email.clone());
        let row = |p: &Person| {
            h_flex().gap(px(8.)).py(px(2.)).child(
                v_flex()
                    .min_w_0()
                    .flex_1()
                    .child(div().truncate().text_size(px(12.)).text_color(l.fg).child(who(p)))
                    .when(p.name.as_deref().is_some_and(|n| !n.is_empty()), |el| el.child(div().truncate().text_size(px(10.5)).text_color(l.muted).child(p.email.clone()))),
            )
        };
        let button = |id: String, label: &'static str| {
            small_button(SharedString::from(id), label, 8., 4., 11.5, l).when(busy, |el| el.opacity(0.4).cursor_default())
        };
        let mut section = v_flex()
            .mt(px(16.))
            .pt(px(12.))
            .border_t_1()
            .border_color(l.border)
            .child(heading("ACCEPTED PEOPLE").mb(px(4.)))
            .child(
                div()
                    .mb(px(8.))
                    .text_size(px(11.))
                    .text_color(l.muted)
                    .child("What these people share lands in your Markie. Removing someone takes everything they shared out of your Markie at once."),
            );
        match store.people() {
            Some(Load::Failed { message, .. }) => section = section.child(muted_line(message.clone(), 11.5, l)),
            Some(Load::Ready(people)) => {
                if people.accepted.is_empty() {
                    section = section.child(muted_line("Nobody yet. When someone shares with you, accept them in Requests.", 11.5, l));
                }
                for person in &people.accepted {
                    let name = who(person);
                    let (id1, id2) = (person.id.clone(), person.id.clone());
                    let (n1, n2) = (name.clone(), name.clone());
                    section = section.child(
                        // PersonRow: the buttons sit in their own `gap-1` group.
                        row(person).child(h_flex().flex_none().gap(px(4.))
                            .child(button(format!("ppl-remove-{}", person.id), "Remove").when(!busy, |el| {
                                el.on_click(cx.listener(move |this, _, window, cx| {
                                    this.confirm_people(
                                        "remove",
                                        id1.clone(),
                                        format!("Remove {n1}? Everything they shared leaves your Markie now."),
                                        format!("Removed {n1}."),
                                        "Couldn't remove them. Try again.",
                                        window,
                                        cx,
                                    )
                                }))
                            }))
                            .child(button(format!("ppl-block-{}", person.id), "Block").when(!busy, |el| {
                                el.tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Remove them and hide anything they share later. They are not told.").build(window, cx))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.confirm_people(
                                            "block",
                                            id2.clone(),
                                            format!("Block {n2}? Everything they shared leaves your Markie now, and you won't see their requests."),
                                            format!("Blocked {n2}."),
                                            "Couldn't block them. Try again.",
                                            window,
                                            cx,
                                        )
                                    }))
                            }))),
                    );
                }
                if !people.blocked.is_empty() {
                    section = section.child(heading("BLOCKED").mt(px(12.)).mb(px(4.)));
                    for person in &people.blocked {
                        let name = who(person);
                        let id = person.id.clone();
                        section = section.child(row(person).child(button(format!("ppl-unblock-{}", person.id), "Unblock").when(!busy, |el| {
                            el.on_click(cx.listener(move |this, _, _, cx| {
                                let done = format!("Unblocked {name}. What they share shows up in Requests.");
                                this.store.update(cx, |s, cx| s.people_act("unblock", id.clone(), done, "Couldn't unblock them. Try again.", cx));
                            }))
                        })));
                    }
                }
            }
            _ => {}
        }
        section
            .when_some(store.people_error.clone(), |el, e| el.child(div().mt(px(6.)).text_size(px(11.)).text_color(l.red).child(e)))
            .when_some(store.people_notice.clone(), |el, n| el.child(div().mt(px(6.)).text_size(px(11.)).text_color(l.muted).child(n)))
    }

    /// `window.confirm` before Remove and Block, then the change.
    #[allow(clippy::too_many_arguments)]
    fn confirm_people(&mut self, kind: &'static str, id: String, question: String, done: String, failed: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let answer = window.prompt(PromptLevel::Warning, &question, None, &["OK", "Cancel"], cx);
        let store = self.store.clone();
        cx.spawn(async move |_, cx| {
            if answer.await.ok() == Some(0) {
                store.update(cx, |s, cx| s.people_act(kind, id, done, failed, cx));
            }
        })
        .detach();
    }
}

impl Render for AccountSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for input in std::mem::take(&mut self.clear) {
            input.update(cx, |s, cx| s.set_value("", window, cx));
        }
        let l = look(cx);
        let status = self.store.read(cx).status.clone();
        match status {
            AuthStatus::Checking => v_flex().w_full().child(muted_line("Checking session…", 12., l)),
            AuthStatus::Out => v_flex().w_full().child(self.form.clone()),
            AuthStatus::In(user) => {
                let shown = user.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| user.email.clone());
                v_flex()
                    .w_full()
                    .child(
                        h_flex()
                            .mb(px(12.))
                            .justify_between()
                            .items_center()
                            .child(
                                v_flex()
                                    .child(div().text_size(px(13.)).text_color(l.fg).child(shown))
                                    .child(div().text_size(px(11.)).text_color(l.muted).child(user.email.clone())),
                            )
                            .child(small_button("sign-out", "Sign out", 12., 6., 12., l).on_click(cx.listener(|this, _, _, cx| {
                                this.identities_open = false;
                                this.flow = IdentityFlow { generation: this.flow.generation + 1, ..IdentityFlow::new() };
                                this.store.update(cx, |s, cx| s.sign_out(cx));
                            }))),
                    )
                    .child({
                        // A stored preference, as Electron's `markie.sync.v1` is.
                        let on = self.store.read(cx).sync_enabled();
                        h_flex()
                            .id("sync-switch")
                            .py(px(4.))
                            .justify_between()
                            .items_center()
                            .text_size(px(12.))
                            .text_color(l.muted)
                            .cursor_pointer()
                            .child("Sync my documents to the cloud")
                            .child(native_checkbox(on))
                            .on_click(cx.listener(move |this, _, _, cx| this.store.update(cx, |s, cx| s.set_sync_enabled(!on, cx))))
                    })
                    .child(self.render_people(l, cx))
                    .child(
                        v_flex()
                            .mt(px(16.))
                            .pt(px(12.))
                            .border_t_1()
                            .border_color(l.border)
                            .child(h_flex().child(small_button("linked", "Manage linked sign-ins", 8., 4., 12., l).on_click(cx.listener(|this, _, _, cx| {
                                this.identities_open = !this.identities_open;
                                this.flow = IdentityFlow { generation: this.flow.generation + 1, ..IdentityFlow::new() };
                                if this.identities_open {
                                    this.store.update(cx, |s, cx| s.load_identities(cx));
                                }
                                cx.notify();
                            }))))
                            .when(self.identities_open, |el| el.child(self.render_identities(l, window, cx))),
                    )
            }
        }
    }
}

/// The account sheet: Electron's Settings dialog opened on its Account tab,
/// which is where the account button takes you.
pub struct AccountSheet {
    section: Entity<AccountSection>,
    workspace: WeakEntity<Workspace>,
}

const TABS: [&str; 4] = ["Account", "Appearance", "Files", "Advanced"];

impl Render for AccountSheet {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = look(cx);
        let workspace = self.workspace.clone();
        v_flex()
            .w_full()
            .child(
                h_flex()
                    .mb(px(16.))
                    .justify_between()
                    .items_center()
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(l.fg).child("Settings"))
                    .child(
                        div()
                            .id("close-account")
                            .size(px(24.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .text_color(l.muted)
                            .cursor_pointer()
                            .hover(move |s| s.text_color(l.fg).bg(if l.dark { l.accent.opacity(0.58) } else { l.fg.opacity(0.06) }))
                            .child(Icon::new(gpui_kit::component::IconName::Close).with_size(px(14.)))
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    ),
            )
            .child(
                h_flex().mb(px(20.)).gap(px(4.)).border_b_1().border_color(l.border).children(TABS.iter().map(|tab| {
                    let selected = *tab == "Account";
                    let workspace = workspace.clone();
                    div()
                        .id(SharedString::from(format!("tab-{tab}")))
                        .mb(px(-1.))
                        .px(px(12.))
                        .py(px(8.))
                        .text_size(px(12.))
                        .border_b_2()
                        .border_color(if selected { l.fg } else { transparent_black() })
                        .text_color(if selected { l.fg } else { l.muted })
                        .when(!selected, |el| {
                            el.cursor_pointer().hover(move |s| s.text_color(l.fg)).on_click(move |_, window, cx| {
                                // The other sections live in Settings.
                                window.close_dialog(cx);
                                workspace
                                    .update(cx, |ws, cx| {
                                        ws.focus_handle.focus(window, cx);
                                        window.dispatch_action(Box::new(OpenSettings), cx);
                                    })
                                    .ok();
                            })
                        })
                        .child(*tab)
                })),
            )
            .child(self.section.clone())
    }
}

impl Workspace {
    /// Open the account sheet: the sign-in form when signed out, the account
    /// when signed in. The activity bar's account button calls this.
    pub fn open_account(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(store) = AccountStore::global(cx) else { return };
        store.update(cx, |s, _| s.hand_back_error = None);
        let section = cx.new(|cx| AccountSection::new(store, window, cx));
        let workspace = cx.weak_entity();
        let sheet = cx.new(|_| AccountSheet { section, workspace });
        window.open_dialog(cx, move |dialog, _, cx| {
            let l = look(cx);
            dialog
                .w(px(680.))
                .centered()
                .close_button(false)
                .bg(l.panel_bg)
                .border_color(l.panel_border)
                .rounded(px(12.))
                .p(px(20.))
                .child(sheet.clone())
        });
    }

    pub(super) fn on_open_account(&mut self, _: &OpenAccount, window: &mut Window, cx: &mut Context<Self>) {
        self.open_account(window, cx);
    }

    /// A Google or Apple sign-in that comes back closes the sheet, as
    /// Electron dismisses its sign-in modal.
    pub(super) fn watch_account(window: &mut Window, cx: &mut Context<Self>) -> Vec<Subscription> {
        let Some(store) = AccountStore::global(cx) else { return Vec::new() };
        vec![
            // The sheet and the sync workspace share one session store, so a
            // sign-in or sign-out here changes the Cloud library at once.
            cx.observe(&store, |this, store, cx| {
                let store = store.read(cx);
                if store.status != AuthStatus::Checking {
                    let who = store.user().map(|u| u.id.clone());
                    if this.cloud.account_seen.as_ref() != Some(&who) {
                        this.cloud.account_seen = Some(who);
                        this.on_account_changed(cx);
                    }
                }
                cx.notify();
            }),
            cx.subscribe_in(&store, window, |_, _, event: &AccountEvent, window, cx| {
                if *event == AccountEvent::BrowserSignedIn && window.has_active_dialog(cx) {
                    window.close_dialog(cx);
                }
            }),
        ]
    }

    /// View › Cloud and the palette's "Cloud…": the rail's Cloud destination.
    pub(super) fn on_show_cloud(&mut self, _: &ShowCloud, _: &mut Window, cx: &mut Context<Self>) {
        self.select_view(super::rail::LeftView::Cloud, cx);
    }

    /// The Cloud page, for the rail's workspace page.
    pub(super) fn render_cloud_page(&self) -> AnyElement {
        div().size_full().child(self.cloud_panel.clone()).into_any_element()
    }
}

// ------------------------------------------------------------------ cloud

/// The Cloud destination: Electron's `library.tsx` cloud workspace header,
/// with the account's documents listed and one open read only. No sync.
pub struct CloudPanel {
    store: Option<Entity<AccountStore>>,
    search: Entity<InputState>,
    reading: Option<(DocMeta, Load<Entity<TextViewState>>)>,
    loaded_for: Option<String>,
    _subs: Vec<Subscription>,
}

impl CloudPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = AccountStore::global(cx);
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by name or folder"));
        let mut subs = vec![cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        })];
        if let Some(store) = &store {
            subs.push(cx.observe(store, |this, _, cx| {
                this.sync_load(cx);
                cx.notify();
            }));
        }
        let mut this = Self { store, search, reading: None, loaded_for: None, _subs: subs };
        this.sync_load(cx);
        this
    }

    /// Load the list once per signed-in account.
    fn sync_load(&mut self, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else { return };
        let user = store.read(cx).user().map(|u| u.id.clone());
        if user == self.loaded_for {
            return;
        }
        self.loaded_for = user.clone();
        self.reading = None;
        if user.is_some() {
            store.update(cx, |s, cx| s.load_docs(cx));
        }
    }

    fn open_doc(&mut self, meta: DocMeta, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else { return };
        let Some((rt, client)) = store.read(cx).backend() else { return };
        let id = meta.id.clone();
        self.reading = Some((meta, Load::Loading));
        cx.notify();
        let wanted = id.clone();
        run_bg(&rt, cx, async move { DocsClient::new(&client).get(&id).await }, move |this: &mut Self, result, cx| {
            // Only the document still on screen takes the answer.
            if this.reading.as_ref().is_none_or(|(m, _)| m.id != wanted) {
                return;
            }
            let Some((meta, _)) = this.reading.take() else { return };
            let load = match result {
                Ok(doc) => Load::Ready(cx.new(|cx| TextViewState::markdown(&doc.content, cx).selectable(true))),
                Err(e) => Load::Failed { message: format!("Couldn't open this document. {e}"), muted: false },
            };
            this.reading = Some((meta, load));
        });
    }

    fn render_header(&self, signed_in: bool, l: Look) -> impl IntoElement {
        h_flex()
            .min_h(px(64.))
            .flex_none()
            .justify_between()
            .items_center()
            .gap(px(16.))
            .border_b_1()
            .border_color(l.border.opacity(0.7))
            .px(px(28.))
            .py(px(12.))
            .child(
                h_flex()
                    .gap(px(12.))
                    .items_center()
                    .child(
                        div()
                            .size(px(40.))
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .rounded(px(11.))
                            .border_1()
                            .border_color(l.border.opacity(0.8))
                            .bg(l.surface2.opacity(0.8))
                            .text_color(l.blue)
                            .child(Icon::new(gpui_kit::assets::IconName::Cloud).with_size(px(20.))),
                    )
                    .child(
                        v_flex()
                            .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).line_height(px(21.)).text_color(l.fg).child("Cloud"))
                            .child(if signed_in {
                                h_flex()
                                    .id("cloud-status")
                                    .mt(px(2.))
                                    .gap(px(6.))
                                    .items_center()
                                    .text_size(px(11.))
                                    .text_color(l.muted)
                                    .child(div().size(px(6.)).rounded_full().bg(l.green))
                                    .child("Connected")
                            } else {
                                h_flex()
                                    .id("cloud-status")
                                    .mt(px(2.))
                                    .gap(px(6.))
                                    .items_center()
                                    .text_size(px(11.))
                                    .text_color(l.muted)
                                    .cursor_pointer()
                                    .hover(move |s| s.text_color(l.fg))
                                    .child(div().size(px(6.)).rounded_full().bg(l.yellow))
                                    .child("Sign in")
                                    .on_click(|_, window, cx| window.dispatch_action(Box::new(OpenAccount), cx))
                            }),
                    ),
            )
            .child(
                h_flex()
                    .id("cloud-open-file")
                    .h(px(32.))
                    .px(px(10.))
                    .gap(px(6.))
                    .items_center()
                    .rounded(px(6.))
                    .text_size(px(11.5))
                    .text_color(l.muted)
                    .cursor_pointer()
                    .hover(move |s| s.bg(l.accent.opacity(0.4)).text_color(l.fg))
                    .child(div().text_size(px(14.)).child("+"))
                    .child("Open file")
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(Open), cx)),
            )
    }

    fn render_card(icon_title: &str, l: Look) -> Div {
        h_flex()
            .w_full()
            .gap(px(10.))
            .items_center()
            .px(px(14.))
            .py(px(12.))
            .rounded(px(8.))
            .border_1()
            .border_color(l.border.opacity(0.75))
            .child(div().text_color(l.muted).child(Icon::new(gpui_kit::assets::IconName::Cloud).with_size(px(16.))))
            .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(l.fg).child(icon_title.to_string()))
    }
}

/// "3m", "2h", "5d", "2w", like `shortAgo` in relative-time.ts, from an ISO time.
pub(super) fn short_ago(iso: &str) -> Option<String> {
    let then = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    Some(short_ago_ms(then.timestamp_millis()))
}

/// `shortAgo` from milliseconds since the epoch.
pub(super) fn short_ago_ms(ms: i64) -> String {
    let secs = (chrono::Utc::now().timestamp_millis() - ms).max(0) / 1000;
    let days = secs / 86_400;
    match secs {
        s if s < 60 => "now".into(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        _ if days < 7 => format!("{days}d"),
        _ if days < 30 => format!("{}w", days / 7),
        _ if days < 365 => format!("{}mo", days / 30),
        _ => format!("{}y", days / 365),
    }
}

impl Render for CloudPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = look(cx);
        let signed_in = self.store.as_ref().is_some_and(|s| s.read(cx).user().is_some());
        let checking = self.store.as_ref().is_some_and(|s| s.read(cx).status == AuthStatus::Checking);
        let header = self.render_header(signed_in, l);
        let root = v_flex().size_full().min_w_0().bg(l.background).child(header);

        if let Some((meta, load)) = &self.reading {
            let body: AnyElement = match load {
                Load::Loading => muted_line("Opening…", 12., l).into_any_element(),
                Load::Failed { message, .. } => div().text_size(px(12.)).text_color(l.red).child(message.clone()).into_any_element(),
                Load::Ready(state) => TextView::new(state).scrollable(true).selectable(true).size_full().max_w(px(768.)).into_any_element(),
            };
            return root.child(
                h_flex()
                    .flex_none()
                    .px(px(28.))
                    .py(px(10.))
                    .gap(px(10.))
                    .items_center()
                    .border_b_1()
                    .border_color(l.border.opacity(0.6))
                    .child(link_button("cloud-back", "← Cloud", false, l).text_size(px(12.)).on_click(cx.listener(|this, _, _, cx| {
                        this.reading = None;
                        cx.notify();
                    })))
                    .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(l.fg).child(meta.name.clone()))
                    .child(
                        div()
                            .px(px(6.))
                            .py(px(1.))
                            .rounded(px(4.))
                            .border_1()
                            .border_color(l.border)
                            .text_size(px(10.))
                            .text_color(l.muted)
                            .child("Read only"),
                    ),
            )
            .child(h_flex().flex_1().min_h_0().justify_center().px(px(40.)).py(px(24.)).child(body));
        }

        let filter = self.search.read(cx).value().to_lowercase();
        let focused = self.search.read(cx).focus_handle(cx).is_focused(window);
        let filters = h_flex().flex_none().justify_center().border_b_1().border_color(l.border.opacity(0.6)).px(px(28.)).py(px(16.)).child(
            h_flex()
                .w_full()
                .max_w(px(1180.))
                .h(px(32.))
                .px(px(10.))
                .gap(px(8.))
                .items_center()
                .rounded(px(7.))
                .border_1()
                .border_color(if focused { l.focus } else { l.field_border })
                .bg(l.field_bg)
                .child(div().text_color(l.muted).child(Icon::new(gpui_kit::component::IconName::Search).with_size(px(14.))))
                .child(Input::new(&self.search).appearance(false).with_size(gpui_kit::component::Size::Small).text_size(px(12.5)).w_full()),
        );

        let mut list = v_flex().w_full().max_w(px(1180.)).gap(px(2.));
        if checking {
            list = list.child(muted_line("Loading your cloud documents", 12., l));
        } else if !signed_in {
            list = list.child(Self::render_card("Sign in to see synced and shared files", l));
        } else {
            let docs = self.store.as_ref().and_then(|s| s.read(cx).docs().cloned());
            match docs {
                None | Some(Load::Loading) => list = list.child(muted_line("Loading your cloud documents", 12., l)),
                Some(Load::Failed { message, .. }) => list = list.child(div().text_size(px(12.)).text_color(l.red).child(message)),
                Some(Load::Ready(docs)) => {
                    let shown: Vec<DocMeta> = docs.into_iter().filter(|d| filter.is_empty() || d.name.to_lowercase().contains(&filter)).collect();
                    let mine = shown.iter().filter(|d| !d.shared).count();
                    let band = if shown.is_empty() {
                        if filter.is_empty() { "No synced or shared files yet.".to_string() } else { "No synced or shared files match these filters.".to_string() }
                    } else {
                        format!("{} {} · {} yours · {} shared with you", shown.len(), if shown.len() == 1 { "document" } else { "documents" }, mine, shown.len() - mine)
                    };
                    list = list.child(
                        div()
                            .mb(px(12.))
                            .px(px(12.))
                            .py(px(8.))
                            .rounded(px(10.))
                            .border_1()
                            .border_color(l.border.opacity(0.7))
                            .bg(l.background.opacity(0.35))
                            .text_size(px(11.))
                            .text_color(l.muted)
                            .child(band),
                    );
                    for (ix, doc) in shown.into_iter().enumerate() {
                        let badge = if doc.shared {
                            doc.shared_by.clone().map(|by| format!("Shared by {by}")).unwrap_or_else(|| "Shared with you".into())
                        } else if doc.shared_out == Some(true) {
                            "Shared by you".into()
                        } else {
                            "Only you".into()
                        };
                        let ago = doc.updated_at.as_deref().and_then(short_ago).unwrap_or_default();
                        let meta = doc.clone();
                        list = list.child(
                            h_flex()
                                .id(("cloud-doc", ix))
                                .w_full()
                                .gap(px(8.))
                                .items_center()
                                .px(px(8.))
                                .py(px(6.))
                                .rounded(px(6.))
                                .cursor_pointer()
                                .hover(move |s| s.bg(l.accent.opacity(0.4)))
                                .child(div().text_color(l.muted).child(Icon::new(gpui_kit::component::IconName::File).with_size(px(14.))))
                                .child(div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(l.fg).child(doc.name.clone()))
                                .child(div().text_size(px(10.)).text_color(l.muted).child(badge))
                                .child(div().w(px(36.)).text_size(px(10.)).text_color(l.muted).text_right().child(ago))
                                .on_click(cx.listener(move |this, _, _, cx| this.open_doc(meta.clone(), cx))),
                        );
                    }
                }
            }
        }

        root.child(filters).child(
            div()
                .id("cloud-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px(px(28.))
                .py(px(20.))
                .child(h_flex().w_full().justify_center().child(list)),
        )
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: that brings in GPUI's own `test` macro.
    use super::{KEYCHAIN_SERVICE, TEST_KEYCHAIN_SERVICE, TokenHome, dev_server, mix, shared_tokens, short_ago, token_home};
    use gpui_kit::{Hsla, Rgba};
    use std::sync::Arc;

    #[test]
    fn scratch_runs_keep_sessions_in_memory_and_real_runs_in_the_keychain() {
        assert_eq!(token_home(true, false), TokenHome::Memory);
        assert_eq!(token_home(true, true), TokenHome::Memory);
        assert_eq!(token_home(false, true), TokenHome::Keychain(TEST_KEYCHAIN_SERVICE));
        assert_eq!(token_home(false, false), TokenHome::Keychain(KEYCHAIN_SERVICE));
        // One store for the whole process.
        assert!(Arc::ptr_eq(&shared_tokens(), &shared_tokens()));
    }

    #[test]
    fn only_a_bare_localhost_address_is_a_test_server() {
        assert_eq!(dev_server("http://localhost:18787").as_deref(), Some("http://localhost:18787"));
        assert_eq!(dev_server(" http://127.0.0.1:9/ ").as_deref(), Some("http://127.0.0.1:9"));
        for bad in ["https://api.markiedocs.com", "http://evil.example", "http://localhost.evil.example", "http://user@localhost:1", "http://localhost:1/x", "file:///tmp", "localhost:1"] {
            assert_eq!(dev_server(bad), None, "{bad}");
        }
    }

    #[test]
    fn mixing_matches_color_mix() {
        let black = Hsla::black();
        let white = Hsla::white();
        let mid: Rgba = mix(black, white, 0.5).into();
        assert!((mid.r - 0.5).abs() < 0.01 && (mid.a - 1.0).abs() < 0.01);
    }

    #[test]
    fn ages_read_short() {
        let now = chrono::Utc::now();
        assert_eq!(short_ago(&(now - chrono::Duration::minutes(5)).to_rfc3339()).as_deref(), Some("5m"));
        assert_eq!(short_ago(&(now - chrono::Duration::hours(3)).to_rfc3339()).as_deref(), Some("3h"));
        assert_eq!(short_ago(&(now - chrono::Duration::days(3)).to_rfc3339()).as_deref(), Some("3d"));
        assert_eq!(short_ago(&(now - chrono::Duration::days(15)).to_rfc3339()).as_deref(), Some("2w"));
        assert_eq!(short_ago(&(now - chrono::Duration::days(65)).to_rfc3339()).as_deref(), Some("2mo"));
        assert_eq!(short_ago("not a time"), None);
    }
}

/// The sync switch is a bare `<input type="checkbox">` in settings.tsx, which
/// Chromium draws in its own light colours whatever the theme: 13 px, white
/// with a #767676 border unchecked, #0075ff with a white tick checked.
fn native_checkbox(on: bool) -> Div {
    div()
        .size(px(13.))
        .flex_none()
        .rounded(px(2.5))
        .flex()
        .items_center()
        .justify_center()
        .when_else(
            on,
            |el| el.bg(rgb(0x0075ff)).child(super::chrome::icon("markie/check.svg", 10., gpui_kit::white())),
            |el| el.bg(gpui_kit::white()).border_1().border_color(rgb(0x767676)),
        )
}
