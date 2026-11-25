//! Google Docs in Markie RS, step one: connect, pick in Google's Picker, and
//! import one way as Markdown (docs/rust-port/GOOGLE-DOCS.md). The work is in
//! `markie-google`; this is the app around it:
//!
//! - Settings › Files › Google Docs: connect and disconnect, the account, the
//!   import folder, progress, and every synced Doc with its last sync, its
//!   error, Refresh and Save as Word;
//! - File › Import from Google Docs… and the palette's Google commands;
//! - the small Google mark on synced files in Recents (`mark`).
//!
//! Hidden unless this build carries a Desktop OAuth client
//! (`MARKIE_GOOGLE_DESKTOP_CLIENT_ID`, see markie-google config.rs). The
//! refresh token lives in the Keychain service "<profile> Google"; scenes use
//! memory. Google data never goes to Markie Cloud.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use gpui_kit::component::WindowExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::paths;
use markie_core::registry::Registry;
use markie_google::api::GoogleApi;
use markie_google::config::ClientConfig;
use markie_google::import::{self, Outcome, Progress, Report};
use markie_google::store::{self, SyncRecord};
use markie_google::tokens::{self, GoogleKeychainStore, Grant};
use markie_google::GoogleError;
use markie_vault::device::{MemorySecretStore, SecretStore, SecretStoreError};
use zeroize::Zeroizing;

use super::Workspace;
use super::dialog_chrome::{Tokens, fade, section_label};
use super::doc_grid::{Mark, MarkTone};
use super::overlay::SettingsSection;
use super::palette::PaletteCommand;
use super::settings::overlay_button;

actions!(markie_google_docs, [ImportFromGoogleDocs, RefreshAllFromGoogle, RefreshFromGoogle, SaveGoogleDocAsWord]);

const FOLDER_SETTING: &str = "google_docs.folder";
const ACCOUNT_SETTING: &str = "google_docs.account";
pub(crate) const MENU_LABEL: &str = "Import from Google Docs…";

fn scene_mode() -> bool {
    cfg!(feature = "scene") && std::env::var_os("MARKIE_RS_SCENE").is_some()
}

fn client() -> Option<ClientConfig> {
    ClientConfig::built_in()
}

/// Whether Google Docs shows at all: a Desktop OAuth client was compiled in.
pub(crate) fn available() -> bool {
    client().is_some() || scene_mode()
}

/// `~/Documents/Markie/Google Docs`, unless Settings chose another folder.
pub(crate) fn default_folder() -> PathBuf {
    paths::default_root().join("Google Docs")
}

// ------------------------------------------------------------------ grant

/// The Keychain in the app, memory in scenes.
enum Secrets {
    Keychain(GoogleKeychainStore),
    Memory(MemorySecretStore),
}

impl SecretStore for Secrets {
    fn available(&self) -> bool {
        match self {
            Secrets::Keychain(s) => s.available(),
            Secrets::Memory(s) => s.available(),
        }
    }
    fn has(&self, account: &str) -> bool {
        match self {
            Secrets::Keychain(s) => s.has(account),
            Secrets::Memory(s) => s.has(account),
        }
    }
    fn get(&self, account: &str) -> Option<Zeroizing<Vec<u8>>> {
        match self {
            Secrets::Keychain(s) => s.get(account),
            Secrets::Memory(s) => s.get(account),
        }
    }
    fn put(&self, account: &str, secret: &[u8]) -> Result<(), SecretStoreError> {
        match self {
            Secrets::Keychain(s) => s.put(account, secret),
            Secrets::Memory(s) => s.put(account, secret),
        }
    }
    fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
        match self {
            Secrets::Keychain(s) => s.delete(account),
            Secrets::Memory(s) => s.delete(account),
        }
    }
}

fn grant() -> &'static Grant<Secrets> {
    static GRANT: OnceLock<Grant<Secrets>> = OnceLock::new();
    GRANT.get_or_init(|| {
        if scene_mode() {
            Grant::new(Secrets::Memory(MemorySecretStore::default()))
        } else {
            Grant::new(Secrets::Keychain(GoogleKeychainStore::new(tokens::keychain_service(paths::PROFILE_NAME))))
        }
    })
}

// ------------------------------------------------------------------ badge

static SYNCED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn set_synced(records: &[(PathBuf, SyncRecord)]) {
    if let Ok(mut s) = SYNCED.lock() {
        *s = Some(records.iter().map(|(p, _)| p.clone()).collect());
    }
}

/// The Google mark for a Recents card, when the file came from Google Docs.
pub(crate) fn mark(path: &Path) -> Option<Mark> {
    if !available() {
        return None;
    }
    let mut synced = SYNCED.lock().ok()?;
    if synced.is_none() {
        let records = Registry::open(&paths::data_dir().join("registry.db")).ok().and_then(|r| store::all(r.conn()).ok()).unwrap_or_default();
        *synced = Some(records.into_iter().map(|(p, _)| p).collect());
    }
    synced.as_ref()?.contains(path).then(|| Mark::new("markie/google-doc.svg", MarkTone::Blue, "From Google Docs"))
}

// ------------------------------------------------------------------ state

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JobKind {
    Import,
    Refresh,
    Word,
    Disconnect,
}

/// What a background job shares with the window while it runs.
#[derive(Default)]
struct Shared {
    /// The Picker address for the system browser, opened by the window.
    open_url: Option<String>,
    /// The browser is open and Markie waits for the pick.
    waiting: bool,
    progress: Progress,
}

struct Job {
    kind: JobKind,
    shared: Arc<Mutex<Shared>>,
    cancel: Arc<AtomicBool>,
}

enum Done {
    Imported { report: Report, email: Option<String> },
    Refreshed(Vec<(PathBuf, Result<Outcome, GoogleError>)>),
    Word(PathBuf),
    Disconnected,
    Failed(GoogleError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Notice {
    text: String,
    warn: bool,
}

#[derive(Default)]
pub(crate) struct GoogleDocs {
    loaded: bool,
    connected: bool,
    account: Option<String>,
    folder: Option<PathBuf>,
    records: Vec<(PathBuf, SyncRecord)>,
    job: Option<Job>,
    notice: Option<Notice>,
}

impl Global for GoogleDocs {}

impl GoogleDocs {
    fn folder(&self) -> PathBuf {
        self.folder.clone().unwrap_or_else(default_folder)
    }
}

/// The line under a synced Doc: its file and when it last synced, or its error.
pub(crate) fn record_line(path: &Path, rec: &SyncRecord, now: chrono::DateTime<chrono::Local>) -> (String, bool) {
    if let Some(error) = &rec.error {
        return (error.clone(), true);
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let when = chrono::DateTime::parse_from_rfc3339(&rec.synced_at)
        .map(|t| super::strips::relative_time((now.timestamp_millis() - t.timestamp_millis()).max(0)))
        .unwrap_or_else(|_| "at an unknown time".into());
    (format!("{name} \u{b7} Synced {when}"), false)
}

/// The progress line while a job runs.
fn progress_line(kind: JobKind, shared: &Shared) -> String {
    let p = &shared.progress;
    match kind {
        JobKind::Import if shared.waiting && p.total == 0 => "Pick your Docs in the browser window Markie opened\u{2026}".into(),
        JobKind::Import | JobKind::Refresh if p.total > 0 && p.done < p.total => {
            let verb = if kind == JobKind::Import { "Importing" } else { "Refreshing" };
            format!("{verb} {} of {}: {}\u{2026}", p.done + 1, p.total, p.current)
        }
        JobKind::Import => "Connecting to Google\u{2026}".into(),
        JobKind::Refresh => "Checking Google for changes\u{2026}".into(),
        JobKind::Word => "Saving a Word copy\u{2026}".into(),
        JobKind::Disconnect => "Disconnecting\u{2026}".into(),
    }
}

/// The sentence after a refresh.
pub(crate) fn refresh_summary(results: &[(PathBuf, Result<Outcome, GoogleError>)]) -> (String, bool) {
    let updated = results.iter().filter(|(_, r)| matches!(r, Ok(Outcome::Updated) | Ok(Outcome::ConflictCopy(_)))).count();
    let copies = results.iter().filter(|(_, r)| matches!(r, Ok(Outcome::ConflictCopy(_)))).count();
    let failed = results.iter().filter(|(_, r)| r.is_err()).count();
    let mut parts = vec![match updated {
        0 => "Everything is up to date with Google.".to_string(),
        1 => "1 Doc was updated from Google.".to_string(),
        n => format!("{n} Docs were updated from Google."),
    }];
    if copies > 0 {
        parts.push(format!("Your edits were kept as {copies} conflict {} beside the file.", if copies == 1 { "copy" } else { "copies" }));
    }
    if failed > 0 {
        parts.push(format!("{failed} couldn't be refreshed."));
    }
    (parts.join(" "), failed > 0 || copies > 0)
}

// ------------------------------------------------------------------ behaviour

impl Workspace {
    fn google<'a>(&mut self, cx: &'a mut Context<Self>) -> &'a mut GoogleDocs {
        if !cx.default_global::<GoogleDocs>().loaded {
            let (folder, account, records) = match &self.registry {
                Some(reg) => (
                    reg.setting(FOLDER_SETTING).ok().flatten().filter(|s| !s.is_empty()).map(PathBuf::from),
                    reg.setting(ACCOUNT_SETTING).ok().flatten().filter(|s| !s.is_empty()),
                    store::all(reg.conn()).unwrap_or_default(),
                ),
                None => (None, None, Vec::new()),
            };
            set_synced(&records);
            // One Keychain read, here, never at launch.
            let connected = available() && grant().connected();
            let g = cx.global_mut::<GoogleDocs>();
            *g = GoogleDocs { loaded: true, connected, account, folder, records, ..Default::default() };
        }
        cx.global_mut::<GoogleDocs>()
    }

    fn google_reload_records(&mut self, cx: &mut Context<Self>) {
        let records = self.registry.as_ref().and_then(|r| store::all(r.conn()).ok()).unwrap_or_default();
        set_synced(&records);
        self.google(cx).records = records;
    }

    /// PROJECTS HOOK: an import folder becomes a Projects folder here. Today
    /// it is registered as a Library root (the caller does that); when the
    /// Projects-as-folders work lands, add the folder to Projects in this one
    /// function and nowhere else.
    fn google_import_becomes_projects_folder(&mut self, _folder: &Path, _cx: &mut Context<Self>) {}

    pub(super) fn on_import_google(&mut self, _: &ImportFromGoogleDocs, window: &mut Window, cx: &mut Context<Self>) {
        if !available() {
            return;
        }
        self.open_settings(SettingsSection::Files, window, cx);
        let g = self.google(cx);
        if g.job.is_some() {
            return;
        }
        let Some(cfg) = client() else { return };
        let (folder, hint) = (g.folder(), g.account.clone());
        self.google_job(JobKind::Import, window, cx, move |shared, cancel| {
            let picked = markie_google::connect::connect_and_pick(
                &cfg,
                grant(),
                hint.as_deref(),
                &|url| {
                    let mut s = shared.lock().unwrap();
                    s.open_url = Some(url.to_string());
                    s.waiting = true;
                },
                cancel,
                markie_google::oauth::PICK_TIMEOUT,
            )?;
            shared.lock().unwrap().waiting = false;
            let reg = Registry::open(&paths::data_dir().join("registry.db")).map_err(|e| GoogleError::Store(e.to_string()))?;
            let api = GoogleApi::new(&cfg, grant());
            let report = import::import_picked(&api, reg.conn(), &folder, &picked.file_ids, chrono::Local::now(), &mut |p| shared.lock().unwrap().progress = p.clone(), cancel)?;
            Ok(Done::Imported { report, email: picked.email })
        });
    }

    fn google_refresh(&mut self, paths: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cfg) = client() else { return };
        if self.google(cx).job.is_some() || paths.is_empty() {
            return;
        }
        self.google_job(JobKind::Refresh, window, cx, move |shared, cancel| {
            let reg = Registry::open(&paths::data_dir().join("registry.db")).map_err(|e| GoogleError::Store(e.to_string()))?;
            let api = GoogleApi::new(&cfg, grant());
            let total = paths.len();
            let mut out = Vec::new();
            for (done, path) in paths.into_iter().enumerate() {
                if cancel.load(Ordering::SeqCst) {
                    return Err(GoogleError::Cancelled);
                }
                let title = store::get(reg.conn(), &path).ok().flatten().map(|r| r.title).unwrap_or_default();
                shared.lock().unwrap().progress = Progress { done, total, current: title };
                let result = import::refresh(&api, reg.conn(), &path, chrono::Local::now());
                if result == Err(GoogleError::Reconnect) {
                    return Err(GoogleError::Reconnect);
                }
                out.push((path, result));
            }
            Ok(Done::Refreshed(out))
        });
    }

    fn google_save_word(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cfg) = client() else { return };
        if self.google(cx).job.is_some() {
            return;
        }
        self.google_job(JobKind::Word, window, cx, move |_, _| {
            let reg = Registry::open(&paths::data_dir().join("registry.db")).map_err(|e| GoogleError::Store(e.to_string()))?;
            let api = GoogleApi::new(&cfg, grant());
            import::save_as_word(&api, reg.conn(), &path).map(Done::Word)
        });
    }

    fn google_disconnect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cfg) = client() else { return };
        if self.google(cx).job.is_some() {
            return;
        }
        self.google_job(JobKind::Disconnect, window, cx, move |_, _| {
            grant().disconnect(&markie_google::oauth::http_client(), &cfg)?;
            Ok(Done::Disconnected)
        });
    }

    /// Run `work` on its own thread; the window polls it, opens the browser
    /// when asked, redraws progress, and takes the result.
    fn google_job(
        &mut self,
        kind: JobKind,
        window: &mut Window,
        cx: &mut Context<Self>,
        work: impl FnOnce(&Mutex<Shared>, &AtomicBool) -> Result<Done, GoogleError> + Send + 'static,
    ) {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::channel::<Done>();
        {
            let (shared, cancel) = (shared.clone(), cancel.clone());
            std::thread::Builder::new()
                .name("markie-google".into())
                .spawn(move || {
                    let done = work(&shared, &cancel).unwrap_or_else(Done::Failed);
                    let _ = tx.send(done);
                })
                .ok();
        }
        let g = self.google(cx);
        g.notice = None;
        g.job = Some(Job { kind, shared: shared.clone(), cancel });
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(120)).await;
                let url = shared.lock().unwrap().open_url.take();
                if let Some(url) = url {
                    let _ = cx.update(|_, cx| cx.open_url(&url));
                }
                match rx.try_recv() {
                    Ok(done) => {
                        let _ = this.update_in(cx, |this, window, cx| this.google_done(done, window, cx));
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        if this.update(cx, |_, cx| cx.notify()).is_err() {
                            break;
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        let _ = this.update_in(cx, |this, window, cx| this.google_done(Done::Failed(GoogleError::Cancelled), window, cx));
                        break;
                    }
                }
            }
        })
        .detach();
    }

    fn google_done(&mut self, done: Done, window: &mut Window, cx: &mut Context<Self>) {
        self.google(cx).job = None;
        let notice = match done {
            Done::Imported { report, email } => {
                let folder = self.google(cx).folder();
                if let Some(reg) = &self.registry {
                    if let Some(email) = &email {
                        let _ = reg.set_setting(ACCOUNT_SETTING, email);
                    }
                    if !report.imported.is_empty() {
                        let _ = reg.add_root(&folder);
                    }
                }
                {
                    let g = self.google(cx);
                    g.connected = true;
                    if email.is_some() {
                        g.account = email;
                    }
                }
                if !report.imported.is_empty() {
                    self.google_import_becomes_projects_folder(&folder, cx);
                    self.rescan(cx);
                }
                let warn = !report.folders_without_access.is_empty() || !report.errors.is_empty();
                Notice { text: report.summary(), warn }
            }
            Done::Refreshed(results) => {
                let (text, warn) = refresh_summary(&results);
                Notice { text, warn }
            }
            Done::Word(path) => Notice { text: format!("Saved {} beside the Markdown file.", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()), warn: false },
            Done::Disconnected => {
                if let Some(reg) = &self.registry {
                    let _ = reg.set_setting(ACCOUNT_SETTING, "");
                }
                let g = self.google(cx);
                g.connected = false;
                g.account = None;
                Notice { text: "Disconnected from Google. Your imported files stay on this Mac.".into(), warn: false }
            }
            Done::Failed(GoogleError::Cancelled) => Notice { text: GoogleError::Cancelled.to_string(), warn: false },
            Done::Failed(e) => {
                if e == GoogleError::Reconnect {
                    self.google(cx).connected = false;
                }
                Notice { text: e.to_string(), warn: true }
            }
        };
        self.google_reload_records(cx);
        self.refresh_lists(cx);
        window.push_notification(notice.text.clone(), cx);
        self.google(cx).notice = Some(notice);
        cx.notify();
    }

    fn google_change_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Import Here".into()) });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await
                && let Some(folder) = paths.into_iter().next()
            {
                let _ = this.update(cx, |this, cx| {
                    if let Some(reg) = &this.registry {
                        let _ = reg.set_setting(FOLDER_SETTING, &folder.to_string_lossy());
                    }
                    this.google(cx).folder = Some(folder);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// The open file, when it came from Google Docs.
    fn google_current(&mut self, cx: &mut Context<Self>) -> Option<PathBuf> {
        let path = self.doc.as_ref().filter(|d| !d.untitled).map(|d| d.path.clone())?;
        self.google(cx).records.iter().any(|(p, _)| *p == path).then_some(path)
    }

    pub(super) fn on_refresh_all_google(&mut self, _: &RefreshAllFromGoogle, window: &mut Window, cx: &mut Context<Self>) {
        if !available() {
            return;
        }
        let paths: Vec<PathBuf> = self.google(cx).records.iter().map(|(p, _)| p.clone()).collect();
        self.google_refresh(paths, window, cx);
    }

    pub(super) fn on_refresh_google(&mut self, _: &RefreshFromGoogle, window: &mut Window, cx: &mut Context<Self>) {
        if !available() {
            return;
        }
        match self.google_current(cx) {
            Some(path) => self.google_refresh(vec![path], window, cx),
            None => window.push_notification("This file didn\u{2019}t come from Google Docs.", cx),
        }
    }

    pub(super) fn on_save_google_word(&mut self, _: &SaveGoogleDocAsWord, window: &mut Window, cx: &mut Context<Self>) {
        if !available() {
            return;
        }
        match self.google_current(cx) {
            Some(path) => self.google_save_word(path, window, cx),
            None => window.push_notification("This file didn\u{2019}t come from Google Docs.", cx),
        }
    }

    // -------------------------------------------------------------- settings

    /// Settings › Files › Google Docs. Nothing at all when the build has no client.
    pub(super) fn render_google_docs_setting(&mut self, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        if !available() {
            return div().into_any_element();
        }
        let now = chrono::Local::now();
        let g = self.google(cx);
        let (connected, account, folder) = (g.connected, g.account.clone(), g.folder());
        let job = g.job.as_ref().map(|j| {
            let shared = j.shared.lock().unwrap();
            (j.kind, progress_line(j.kind, &shared), shared.progress.clone())
        });
        let notice = g.notice.clone();
        let records = g.records.clone();
        let busy = job.is_some();
        let home = paths::home_dir();
        let folder_shown = markie_core::path_display::compact_home_path(&folder.to_string_lossy(), &home.to_string_lossy());

        let muted = |text: String| div().text_size(px(11.)).line_height(px(17.)).text_color(t.muted).child(text);
        let button = |id: &'static str, label: &str| overlay_button(id, label, t).when(busy, |b| b.opacity(0.5));

        let header = div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(12.5)).text_color(t.foreground).child(match (connected, &account) {
                        (true, Some(email)) => format!("Connected as {email}"),
                        (true, None) => "Connected to Google".to_string(),
                        _ => "Not connected".to_string(),
                    }))
                    .child(muted(
                        "Import Google Docs as Markdown files on this Mac. Markie sees only the Docs you pick, and nothing passes through Markie Cloud.".into(),
                    )),
            )
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(button("google-import", if connected { "Import from Google Docs\u{2026}" } else { "Connect Google Docs" }).on_click(cx.listener(|this, _, window, cx| {
                        this.on_import_google(&ImportFromGoogleDocs, window, cx)
                    })))
                    .when(connected, |el| {
                        el.child(button("google-disconnect", "Disconnect").on_click(cx.listener(|this, _, window, cx| this.google_disconnect(window, cx))))
                    }),
            );

        let folder_row = div()
            .mt(px(12.))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(12.)).text_color(t.foreground).child("Import folder"))
                    .child(div().text_size(px(11.)).font_family("Menlo").text_color(t.muted).truncate().child(folder_shown)),
            )
            .child(button("google-folder", "Change\u{2026}").on_click(cx.listener(|this, _, window, cx| this.google_change_folder(window, cx))));

        let progress = job.map(|(kind, line, p)| {
            let fraction = if p.total > 0 { p.done as f32 / p.total as f32 } else { 0. };
            div()
                .id("google-progress")
                .mt(px(12.))
                .rounded(px(8.))
                .bg(fade(t.blue, 0.10))
                .px(px(12.))
                .py(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(div().flex_1().min_w_0().text_size(px(12.)).text_color(t.foreground).child(line))
                        .when(kind == JobKind::Import || kind == JobKind::Refresh, |el| {
                            el.child(overlay_button("google-cancel", "Cancel", t).on_click(cx.listener(|this, _, _, cx| {
                                if let Some(job) = &this.google(cx).job {
                                    job.cancel.store(true, Ordering::SeqCst);
                                }
                            })))
                        }),
                )
                .child(
                    div()
                        .mt(px(8.))
                        .h(px(4.))
                        .rounded(px(2.))
                        .bg(fade(t.foreground, 0.10))
                        .child(div().h_full().rounded(px(2.)).bg(t.blue).w(relative(if p.total > 0 { fraction.max(0.04) } else { 0.04 }))),
                )
        });

        let notice_el = notice.map(|n| {
            div().mt(px(10.)).text_size(px(11.5)).line_height(px(17.)).text_color(if n.warn { t.red } else { t.muted }).child(n.text)
        });

        let list = (!records.is_empty()).then(|| {
            let rows: Vec<AnyElement> = records
                .iter()
                .enumerate()
                .map(|(i, (path, rec))| {
                    let (line, is_error) = record_line(path, rec, now);
                    let (open, refresh, word) = (path.clone(), path.clone(), path.clone());
                    let fg = t.foreground;
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(12.))
                        .py(px(8.))
                        .when(i > 0, |el| el.border_t_1().border_color(fade(t.border, 0.6)))
                        .child(
                            div()
                                .id(SharedString::from(format!("google-doc-{i}")))
                                .flex_1()
                                .min_w_0()
                                .cursor_pointer()
                                .child(div().text_size(px(12.5)).text_color(t.foreground).truncate().hover(move |el| el.text_color(fg)).child(rec.title.clone()))
                                .child(div().text_size(px(11.)).text_color(if is_error { t.red } else { t.muted }).truncate().child(line))
                                .on_click(cx.listener(move |this, _, window, cx| this.open_path(&open, window, cx))),
                        )
                        .child(
                            overlay_button_owned(format!("google-refresh-{i}"), "Refresh", t)
                                .when(busy, |b| b.opacity(0.5))
                                .on_click(cx.listener(move |this, _, window, cx| this.google_refresh(vec![refresh.clone()], window, cx))),
                        )
                        .child(
                            overlay_button_owned(format!("google-word-{i}"), "Save as Word", t)
                                .when(busy, |b| b.opacity(0.5))
                                .on_click(cx.listener(move |this, _, window, cx| this.google_save_word(word.clone(), window, cx))),
                        )
                        .into_any_element()
                })
                .collect();
            div()
                .mt(px(16.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .mb(px(8.))
                        .child(div().text_size(px(12.)).text_color(t.foreground).child(format!("Synced Docs ({})", records.len())))
                        .child(button("google-refresh-all", "Refresh All").on_click(cx.listener(|this, _, window, cx| this.on_refresh_all_google(&RefreshAllFromGoogle, window, cx)))),
                )
                .child(div().rounded(px(8.)).border_1().border_color(fade(t.border, 0.7)).children(rows))
                .child(muted("Refresh brings Google\u{2019}s newer text into the file. If you edited the file here since the last sync, your text is kept as a dated conflict copy beside it.".into()).mt(px(8.)))
        });

        div()
            .id("google-docs-setting")
            .mb(px(24.))
            .child(section_label("Google Docs", t).mb(px(8.)))
            .child(header)
            .child(folder_row)
            .children(progress)
            .children(notice_el)
            .children(list)
            .into_any_element()
    }

    // ---------------------------------------------------------------- scene

    /// Scene `google`: Settings › Files with the Google Docs row.
    /// `{connected?: true, importing?: false, waiting?: false, notice?: "…", empty?: false}`.
    #[cfg(feature = "scene")]
    pub(super) fn scene_google(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let flag = |k: &str, d: bool| args.get(k).and_then(serde_json::Value::as_bool).unwrap_or(d);
        if *step == 0 {
            let folder = default_folder();
            let now = chrono::Local::now();
            let ago = |mins: i64| (now - chrono::Duration::minutes(mins)).to_rfc3339();
            let rec = |id: &str, title: &str, mins: i64, error: Option<&str>| SyncRecord {
                doc_id: id.into(),
                title: title.into(),
                synced_at: ago(mins),
                error: error.map(str::to_string),
                ..Default::default()
            };
            let records = if flag("empty", false) || !flag("connected", true) {
                Vec::new()
            } else {
                vec![
                    (folder.join("Field notes.md"), rec("d1", "Field notes", 3, None)),
                    (folder.join("Trip plan.md"), rec("d2", "Trip plan", 95, None)),
                    (folder.join("Reading list.md"), rec("d3", "Reading list", 60 * 26, Some("This Doc is in the trash in Google."))),
                ]
            };
            let job = (flag("importing", false) || flag("waiting", false)).then(|| {
                let waiting = flag("waiting", false);
                let progress = if waiting { Progress::default() } else { Progress { done: 1, total: 4, current: "Trip plan".into() } };
                Job { kind: JobKind::Import, shared: Arc::new(Mutex::new(Shared { open_url: None, waiting, progress })), cancel: Arc::new(AtomicBool::new(false)) }
            });
            let notice = args.get("notice").and_then(serde_json::Value::as_str).map(|s| Notice { text: s.to_string(), warn: true });
            set_synced(&records);
            let connected = flag("connected", true);
            *cx.default_global::<GoogleDocs>() = GoogleDocs {
                loaded: true,
                connected,
                account: connected.then(|| "sample.person@example.com".to_string()),
                folder: None,
                records,
                job,
                notice,
            };
            self.open_settings(SettingsSection::Files, window, cx);
            *step = 1;
            return false;
        }
        *step += 1;
        *step > 4
    }
}

/// `overlay_button` with an id made at runtime, for list rows.
fn overlay_button_owned(id: String, label: &str, t: &Tokens) -> Stateful<Div> {
    let (fg, hover) = (t.foreground, t.hover_soft());
    div()
        .id(SharedString::from(id))
        .flex_none()
        .rounded(px(6.))
        .border_1()
        .border_color(t.border)
        .px(px(10.))
        .py(px(4.))
        .text_size(px(11.5))
        .text_color(t.muted)
        .cursor_pointer()
        .hover(move |el| el.text_color(fg).bg(hover))
        .child(label.to_string())
}

/// File › Import from Google Docs…, or nothing when Google Docs is hidden.
pub(crate) fn menu_items() -> Vec<MenuItem> {
    if available() { vec![MenuItem::action(MENU_LABEL, ImportFromGoogleDocs)] } else { Vec::new() }
}

/// The palette's Google commands, when Google Docs is available.
pub(super) fn palette_commands() -> Vec<PaletteCommand> {
    if !available() {
        return Vec::new();
    }
    let run = |a: Box<dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)>| -> Rc<dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)> { Rc::from(a) };
    vec![
        PaletteCommand {
            title: "Import from Google Docs…".into(),
            group: "File",
            shortcut: None,
            keywords: "google docs drive import picker connect gdocs".into(),
            run: run(Box::new(|ws, w, cx| ws.on_import_google(&ImportFromGoogleDocs, w, cx))),
        },
        PaletteCommand {
            title: "Refresh from Google".into(),
            group: "File",
            shortcut: None,
            keywords: "google docs drive sync update pull".into(),
            run: run(Box::new(|ws, w, cx| ws.on_refresh_google(&RefreshFromGoogle, w, cx))),
        },
        PaletteCommand {
            title: "Refresh All from Google".into(),
            group: "File",
            shortcut: None,
            keywords: "google docs drive sync update pull every".into(),
            run: run(Box::new(|ws, w, cx| ws.on_refresh_all_google(&RefreshAllFromGoogle, w, cx))),
        },
        PaletteCommand {
            title: "Save Google Doc as Word".into(),
            group: "File",
            shortcut: None,
            keywords: "google docs docx word export download".into(),
            run: run(Box::new(|ws, w, cx| ws.on_save_google_word(&SaveGoogleDocAsWord, w, cx))),
        },
    ]
}

#[cfg(test)]
mod tests {
    // Not `super::*`: GPUI's own `test` attribute would shadow the standard one.
    use super::{GoogleError, JobKind, Outcome, Path, PathBuf, Progress, Shared, SyncRecord, available, client, mark, palette_commands, progress_line, record_line, refresh_summary};

    #[test]
    fn a_synced_doc_says_when_or_why() {
        let now = chrono::Local::now();
        let rec = SyncRecord { synced_at: (now - chrono::Duration::minutes(5)).to_rfc3339(), ..Default::default() };
        assert_eq!(record_line(Path::new("/g/Plan.md"), &rec, now), ("Plan.md \u{b7} Synced 5 minutes ago".to_string(), false));
        let broken = SyncRecord { error: Some("This Doc is in the trash in Google.".into()), ..rec };
        assert_eq!(record_line(Path::new("/g/Plan.md"), &broken, now).1, true);
    }

    #[test]
    fn progress_reads_as_a_sentence() {
        let mut s = Shared { waiting: true, ..Default::default() };
        assert_eq!(progress_line(JobKind::Import, &s), "Pick your Docs in the browser window Markie opened\u{2026}");
        s.waiting = false;
        s.progress = Progress { done: 1, total: 4, current: "Trip plan".into() };
        assert_eq!(progress_line(JobKind::Import, &s), "Importing 2 of 4: Trip plan\u{2026}");
    }

    #[test]
    fn refresh_summaries() {
        let ok = |o| (PathBuf::from("/a.md"), Ok(o));
        assert_eq!(refresh_summary(&[ok(Outcome::Unchanged)]).0, "Everything is up to date with Google.");
        let (text, warn) = refresh_summary(&[ok(Outcome::Updated), ok(Outcome::ConflictCopy(PathBuf::from("/c.md"))), (PathBuf::from("/b.md"), Err(GoogleError::Timeout))]);
        assert_eq!(text, "2 Docs were updated from Google. Your edits were kept as 1 conflict copy beside the file. 1 couldn't be refreshed.");
        assert!(warn);
    }

    #[test]
    fn the_feature_is_hidden_without_a_client_in_tests() {
        // Tests build without MARKIE_GOOGLE_DESKTOP_CLIENT_ID and outside a scene.
        if client().is_none() {
            assert!(!available());
            assert!(palette_commands().is_empty());
            assert!(mark(Path::new("/anything.md")).is_none());
        }
    }

    #[test]
    fn user_visible_copy_has_no_em_dashes() {
        let code = include_str!("google_docs.rs");
        let prose: String = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect();
        assert!(!prose.contains('\u{2014}'));
    }
}
