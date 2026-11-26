//! Google Docs in Markie RS: connect, pick in Google's Picker, import as
//! Markdown, and keep picked Docs in sync both ways while Markie is open
//! (docs/rust-port/GOOGLE-DOCS.md). The work is in `markie-google`; this is
//! the app around it:
//!
//! - Settings › Files › Google Docs: connect and disconnect, the account, the
//!   import folder, "Keep these Docs in sync both ways" for the next import,
//!   progress, and every synced Doc with its state in plain words, Sync both
//!   ways and Send my edits as suggestions, Compare after a conflict, Sync
//!   Now or Refresh, and Save as Word;
//! - the sync thread (`markie_google::worker`), told about saves, focus and
//!   unsaved edits, whose rewrites reload an open, unedited file quietly;
//! - a quiet Google status beside the file name in the title bar;
//! - File › Import from Google Docs… and the palette's Google commands;
//! - the small Google mark on synced files in Recents (`mark`).
//!
//! Hidden unless this build carries a Desktop OAuth client
//! (`MARKIE_GOOGLE_DESKTOP_CLIENT_ID`, see markie-google config.rs). The
//! refresh token lives in the Keychain service "<profile> Google"; scenes use
//! memory. Google data never goes to Markie Cloud.
use std::collections::{HashMap, HashSet};
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
use markie_google::api::{GoogleApi, SyncSource};
use markie_google::config::ClientConfig;
use markie_google::import::{self, Outcome, Progress, Report};
use markie_google::store::{self, Stopped, SyncRecord};
use markie_google::sync::{Detect, read_only_reason, stopped_line};
use markie_google::worker::{self, Cmd, Live, Worker};
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
/// "Keep these Docs in sync both ways" for the next import: on unless turned off.
const TWO_WAY_SETTING: &str = "google_docs.two_way";
/// How remote changes are found, once decided: `changes` or `versions`.
const DETECT_SETTING: &str = "google_docs.detect";
pub(crate) const MENU_LABEL: &str = "Import from Google Docs…";

fn scene_mode() -> bool {
    cfg!(feature = "scene") && std::env::var_os("MARKIE_RS_SCENE").is_some()
}

fn client() -> Option<ClientConfig> {
    ClientConfig::built_in()
}

/// The built-in client, for the sync thread, which needs it for as long as it runs.
fn static_client() -> Option<&'static ClientConfig> {
    static CLIENT: OnceLock<Option<ClientConfig>> = OnceLock::new();
    CLIENT.get_or_init(client).as_ref()
}

/// Whether Google Docs shows at all: a Desktop OAuth client was compiled in.
pub(crate) fn available() -> bool {
    client().is_some() || scene_mode()
}

/// `~/Documents/Markie/Google Docs`, unless Settings chose another folder.
/// The most characters of the import folder's path Settings shows.
const FOLDER_CHARS: usize = 72;

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

/// What the sync thread works with: the Google client, its own registry
/// connection and the history store.
struct AppEnv {
    api: GoogleApi<'static, Secrets>,
    reg: Registry,
    history: markie_core::history::History,
}

impl worker::Env for AppEnv {
    fn src(&self) -> &dyn SyncSource {
        &self.api
    }
    fn db(&self) -> &rusqlite::Connection {
        self.reg.conn()
    }
    fn history(&self) -> Option<&markie_core::history::History> {
        Some(&self.history)
    }
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
    /// The next import turns two-way sync on (the import choice).
    two_way_default: bool,
    /// The sync thread, while connected and some Doc syncs both ways.
    worker: Option<Worker>,
    seen_generation: u64,
    /// What each Doc is doing right now (from the sync thread, or a scene).
    live: HashMap<PathBuf, Live>,
    offline: bool,
    /// The open file and whether it had unsaved edits, as last told to the thread.
    told_hold: Option<(PathBuf, bool)>,
    /// Scenes only: Settings › Files shows the Google section alone.
    pub(super) scene_only: bool,
}

impl Global for GoogleDocs {}

impl GoogleDocs {
    fn folder(&self) -> PathBuf {
        self.folder.clone().unwrap_or_else(default_folder)
    }
}

/// How a row's line reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Quiet,
    Busy,
    Warn,
}

fn ago(rec: &SyncRecord, now: chrono::DateTime<chrono::Local>) -> String {
    chrono::DateTime::parse_from_rfc3339(&rec.synced_at)
        .map(|t| super::strips::relative_time((now.timestamp_millis() - t.timestamp_millis()).max(0)))
        .unwrap_or_else(|_| "at an unknown time".into())
}

/// The held reasons as one phrase: "tables and images".
fn held_phrase(held: &[String]) -> String {
    match held {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// A synced Doc's state in plain words, for its row in Settings.
pub(crate) fn row_state(path: &Path, rec: &SyncRecord, live: Option<Live>, offline: bool, now: chrono::DateTime<chrono::Local>) -> (String, Tone) {
    if let Some(s) = rec.stopped {
        return (stopped_line(s).to_string(), if s == Stopped::FileDeleted { Tone::Quiet } else { Tone::Warn });
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !rec.two_way {
        if let Some(error) = &rec.error {
            return (error.clone(), Tone::Warn);
        }
        return (format!("Refresh only \u{b7} {name} \u{b7} Synced {}", ago(rec, now)), Tone::Quiet);
    }
    match live {
        Some(Live::Sending) => return ("Sending\u{2026}".into(), Tone::Busy),
        Some(Live::Waiting) => return ("Waiting for connection. Your edits are kept and will be sent.".into(), Tone::Quiet),
        Some(Live::Pending) => return ("Edited here \u{b7} sending in a moment".into(), Tone::Busy),
        None => {}
    }
    if offline {
        return ("Waiting for connection. Your edits are kept and will be sent.".into(), Tone::Quiet);
    }
    if rec.conflict.is_some() {
        return ("Conflict: Google\u{2019}s text is in the file, and yours is kept beside it.".into(), Tone::Warn);
    }
    if let Some(error) = &rec.error {
        return (error.clone(), Tone::Warn);
    }
    let synced = format!("Synced {}", ago(rec, now));
    if let Some(why) = read_only_reason(rec) {
        return (format!("Read only: {why} \u{b7} {synced}"), Tone::Quiet);
    }
    let mut line = if rec.suggest { format!("Suggesting \u{b7} {synced}") } else { format!("{name} \u{b7} {synced}") };
    if !rec.held.is_empty() {
        line.push_str(&format!(" \u{b7} Kept here, not sent: {}", held_phrase(&rec.held)));
    }
    (line, Tone::Quiet)
}

/// The few words beside the file name in the title bar.
pub(crate) fn title_state(rec: &SyncRecord, live: Option<Live>, offline: bool) -> &'static str {
    if rec.stopped.is_some() {
        return "Not syncing";
    }
    if !rec.two_way {
        return "Refresh only";
    }
    match live {
        Some(Live::Sending) => return "Sending\u{2026}",
        Some(Live::Waiting) => return "Waiting for connection",
        Some(Live::Pending) => return "Edited",
        None => {}
    }
    if offline {
        "Waiting for connection"
    } else if rec.conflict.is_some() {
        "Conflict"
    } else if read_only_reason(rec).is_some() {
        "Read only"
    } else if rec.suggest {
        "Suggesting"
    } else {
        "Synced"
    }
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
    let pushed = results.iter().filter(|(_, r)| matches!(r, Ok(Outcome::Pushed))).count();
    let mut parts = vec![match (updated, pushed) {
        (0, 0) => "Everything is up to date with Google.".to_string(),
        (0, 1) => "Your edits went to 1 Doc in Google.".to_string(),
        (0, n) => format!("Your edits went to {n} Docs in Google."),
        (1, _) => "1 Doc was updated from Google.".to_string(),
        (n, _) => format!("{n} Docs were updated from Google."),
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
            let (folder, account, records, two_way) = match &self.registry {
                Some(reg) => (
                    reg.setting(FOLDER_SETTING).ok().flatten().filter(|s| !s.is_empty()).map(PathBuf::from),
                    reg.setting(ACCOUNT_SETTING).ok().flatten().filter(|s| !s.is_empty()),
                    store::all(reg.conn()).unwrap_or_default(),
                    reg.setting(TWO_WAY_SETTING).ok().flatten().as_deref() != Some("off"),
                ),
                None => (None, None, Vec::new(), true),
            };
            set_synced(&records);
            // One Keychain read, here, never at launch.
            let connected = available() && grant().connected();
            let g = cx.global_mut::<GoogleDocs>();
            *g = GoogleDocs { loaded: true, connected, account, folder, records, two_way_default: two_way, ..Default::default() };
        }
        cx.global_mut::<GoogleDocs>()
    }

    fn google_reload_records(&mut self, cx: &mut Context<Self>) {
        let records = self.registry.as_ref().and_then(|r| store::all(r.conn()).ok()).unwrap_or_default();
        set_synced(&records);
        self.google(cx).records = records;
    }

    /// PROJECTS HOOK: the import folder (a Library root, which the caller
    /// registers) becomes one "Google Docs" Projects folder, made once, the
    /// way "Bring your documents" makes one (`markie_core::bring_docs`). A
    /// Doc already in a folder, because an earlier import placed it or the
    /// person moved it, stays where it is. One ⌘Z in Projects undoes it.
    fn google_import_becomes_projects_folder(&mut self, folder: &Path, files: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        let folder = folder.to_path_buf();
        self.organize("Import from Google Docs", window, cx, move |db| markie_core::bring_docs::bring_folder(db, &folder, "Google Docs", &files));
    }

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
        let (folder, hint, two_way) = (g.folder(), g.account.clone(), g.two_way_default);
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
            let report = import::import_picked(&api, reg.conn(), &folder, &picked.file_ids, chrono::Local::now(), two_way, &mut |p| shared.lock().unwrap().progress = p.clone(), cancel)?;
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
                let rec = store::get(reg.conn(), &path).ok().flatten();
                let title = rec.as_ref().map(|r| r.title.clone()).unwrap_or_default();
                shared.lock().unwrap().progress = Progress { done, total, current: title };
                // A Doc that syncs both ways syncs; a Refresh-only Doc refreshes.
                let result = if rec.is_some_and(|r| r.two_way && r.stopped.is_none()) {
                    let history = markie_core::history::History::new(&paths::data_dir());
                    markie_google::sync::sync_doc(&api, reg.conn(), &path, chrono::Local::now(), Some(&history)).map(|r| match r.outcome {
                        markie_google::sync::Synced::Conflict { copy, .. } => Outcome::ConflictCopy(copy),
                        markie_google::sync::Synced::Pulled | markie_google::sync::Synced::Pushed { pulled: true } => Outcome::Updated,
                        markie_google::sync::Synced::Pushed { .. } => Outcome::Pushed,
                        _ => Outcome::Unchanged,
                    })
                } else {
                    import::refresh(&api, reg.conn(), &path, chrono::Local::now())
                };
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
        // Disconnect stops all sync first; the files stay.
        self.google_stop_sync(cx);
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
                    let files = report.imported.iter().map(|i| i.path.clone()).collect();
                    self.google_import_becomes_projects_folder(&folder, files, window, cx);
                    self.rescan(cx);
                }
                self.google_reload_records(cx);
                self.google_start_sync(window, cx);
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
                    self.google_stop_sync(cx);
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

    // -------------------------------------------------------------- sync

    /// Start the sync thread when connected and some Doc syncs both ways,
    /// and the window's watch on it. Never in a scene: scenes have no network.
    pub(super) fn google_start_sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !available() || scene_mode() || static_client().is_none() {
            return;
        }
        let g = self.google(cx);
        if g.worker.is_some() || !g.connected || !g.records.iter().any(|(_, r)| r.two_way && r.stopped.is_none()) {
            return;
        }
        let detect = self.registry.as_ref().and_then(|r| r.setting(DETECT_SETTING).ok().flatten()).and_then(|s| Detect::parse(&s));
        let worker = Worker::spawn(
            || {
                let cfg = static_client()?;
                let reg = Registry::open(&paths::data_dir().join("registry.db")).ok()?;
                Some(Box::new(AppEnv { api: GoogleApi::new(cfg, grant()), reg, history: markie_core::history::History::new(&paths::data_dir()) }) as Box<dyn worker::Env>)
            },
            worker::Timing::default(),
            detect,
        );
        let status = worker.status.clone();
        self.google(cx).worker = Some(worker);
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(500)).await;
                let running = status.lock().map(|s| s.running).unwrap_or(false);
                if this.update_in(cx, |this, window, cx| this.google_pump(window, cx)).is_err() || !running {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn google_stop_sync(&mut self, cx: &mut Context<Self>) {
        let g = self.google(cx);
        if let Some(w) = g.worker.take() {
            w.send(Cmd::Stop);
        }
        g.live.clear();
        g.offline = false;
        g.told_hold = None;
    }

    fn google_send(&mut self, cmd: Cmd, cx: &mut Context<Self>) {
        if let Some(w) = &self.google(cx).worker {
            w.send(cmd);
        }
    }

    /// Read what the sync thread did since the last look.
    fn google_pump(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Unsaved edits in the open synced file hold it.
        let open = self.doc.as_ref().filter(|d| !d.untitled).map(|d| d.path.clone());
        let dirty = self.dirty;
        let hold = open.clone().map(|p| (p, dirty));
        if self.google(cx).told_hold != hold {
            if let Some((old, true)) = self.google(cx).told_hold.clone() {
                self.google_send(Cmd::Hold(old, false), cx);
            }
            if let Some((p, d)) = hold.clone() {
                self.google_send(Cmd::Hold(p, d), cx);
            }
            self.google(cx).told_hold = hold;
        }
        let Some(status) = self.google(cx).worker.as_ref().map(|w| w.status.clone()) else { return };
        let (generation, live, offline, notices, wrote, reconnect, detect) = {
            let Ok(mut s) = status.lock() else { return };
            (s.generation, s.live.clone(), s.offline, std::mem::take(&mut s.notices), std::mem::take(&mut s.wrote), s.reconnect, s.detect)
        };
        if generation == self.google(cx).seen_generation && notices.is_empty() && wrote.is_empty() {
            return;
        }
        if let (Some(d), Some(reg)) = (detect, &self.registry) {
            let _ = reg.set_setting(DETECT_SETTING, d.as_str());
        }
        {
            let g = self.google(cx);
            g.seen_generation = generation;
            g.live = live;
            g.offline = offline;
        }
        // The open file, rewritten by sync and not edited here: reload it quietly.
        for (path, text) in wrote {
            if open.as_ref() == Some(&path) && !self.dirty {
                self.load_text(&path, text, cx);
                self.disk_conflict = None;
            }
        }
        for n in notices {
            window.push_notification(n.text.clone(), cx);
            self.google(cx).notice = Some(Notice { text: n.text, warn: n.warn });
        }
        if reconnect {
            self.google(cx).connected = false;
            self.google_stop_sync(cx);
            let text = GoogleError::Reconnect.to_string();
            window.push_notification(text.clone(), cx);
            self.google(cx).notice = Some(Notice { text, warn: true });
        }
        self.google_reload_records(cx);
        cx.notify();
    }

    /// Markie saved a file: if it syncs with Google, send it after the pause.
    pub(super) fn google_after_save(&mut self, path: &Path, cx: &mut Context<Self>) {
        if cx.try_global::<GoogleDocs>().is_some_and(|g| g.worker.is_some()) {
            self.google_send(Cmd::Saved(path.to_path_buf()), cx);
        }
    }

    /// The window came to the front: look at Google now.
    pub(super) fn google_on_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !available() {
            return;
        }
        if cx.try_global::<GoogleDocs>().is_none_or(|g| g.worker.is_none()) {
            self.google_start_sync(window, cx);
        }
        self.google_send(Cmd::Focus, cx);
    }

    /// A synced file or a folder holding some was renamed or moved in Markie.
    pub(super) fn google_follow_move(&mut self, from: &Path, to: &Path, cx: &mut Context<Self>) {
        let Some(reg) = &self.registry else { return };
        let _ = if to.is_dir() { store::move_folder(reg.conn(), from, to) } else { store::move_path(reg.conn(), from, to) };
        if cx.try_global::<GoogleDocs>().is_some_and(|g| g.loaded) {
            self.google_reload_records(cx);
        }
    }

    /// The file sync just wrote, if `theirs` is that text: reload it quietly.
    pub(super) fn google_wrote(&mut self, path: &Path, theirs: &str, cx: &mut Context<Self>) -> bool {
        let Some(status) = cx.try_global::<GoogleDocs>().and_then(|g| g.worker.as_ref()).map(|w| w.status.clone()) else { return false };
        let Ok(mut s) = status.lock() else { return false };
        match s.wrote.iter().position(|(p, t)| p == path && t == theirs) {
            Some(i) => {
                s.wrote.remove(i);
                true
            }
            None => false,
        }
    }

    fn google_set_two_way(&mut self, path: PathBuf, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(reg) = &self.registry else { return };
        if let Ok(Some(mut rec)) = store::get(reg.conn(), &path) {
            rec.two_way = on;
            let _ = store::put(reg.conn(), &path, &rec);
        }
        self.google_reload_records(cx);
        if on {
            self.google_start_sync(window, cx);
            self.google_send(Cmd::SyncNow(vec![path]), cx);
        }
        cx.notify();
    }

    fn google_set_suggest(&mut self, path: PathBuf, on: bool, cx: &mut Context<Self>) {
        let Some(reg) = &self.registry else { return };
        if let Ok(Some(mut rec)) = store::get(reg.conn(), &path) {
            rec.suggest = on;
            rec.suggest_chosen = true;
            let _ = store::put(reg.conn(), &path, &rec);
        }
        self.google_reload_records(cx);
        cx.notify();
    }

    fn google_set_import_two_way(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting(TWO_WAY_SETTING, if on { "on" } else { "off" });
        }
        self.google(cx).two_way_default = on;
        cx.notify();
    }

    /// "Compare": the file and its History, where Markie's version before
    /// sync replaced it sits beside Google's text, highlighted.
    fn google_compare(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.close_dialog(window, cx);
        if self.doc.as_ref().map(|d| &d.path) != Some(&path) {
            self.open_path(&path, window, cx);
        }
        self.open_history_page(window, cx);
    }

    /// Done comparing: the row goes back to its usual line. The copy stays on disk.
    fn google_dismiss_conflict(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let Some(reg) = &self.registry else { return };
        if let Ok(Some(mut rec)) = store::get(reg.conn(), &path) {
            rec.conflict = None;
            let _ = store::put(reg.conn(), &path, &rec);
        }
        self.google_reload_records(cx);
        cx.notify();
    }

    /// An unlinked or stopped Doc's row, removed. Its file stays.
    fn google_forget(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = store::remove(reg.conn(), &path);
        }
        self.google_reload_records(cx);
        cx.notify();
    }

    /// The title bar's quiet status for the open file, when it syncs with Google.
    pub(super) fn google_title_status(&self, cx: &App) -> Option<(&'static str, String)> {
        let g = cx.try_global::<GoogleDocs>()?;
        let path = self.doc.as_ref().filter(|d| !d.untitled).map(|d| &d.path)?;
        let (_, rec) = g.records.iter().find(|(p, _)| p == path)?;
        let short = title_state(rec, g.live.get(path).copied(), g.offline);
        let (long, _) = row_state(path, rec, g.live.get(path).copied(), g.offline, chrono::Local::now());
        Some((short, format!("Google Docs: {long}")))
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
        let (two_way_default, live, offline) = (g.two_way_default, g.live.clone(), g.offline);
        let job = g.job.as_ref().map(|j| {
            let shared = j.shared.lock().unwrap();
            (j.kind, progress_line(j.kind, &shared), shared.progress.clone())
        });
        let notice = g.notice.clone();
        let records = g.records.clone();
        let busy = job.is_some();
        let home = paths::home_dir();
        // `~` for home and the middle cut when still long; the whole path is
        // in the tooltip. 72 Menlo characters fill the row beside Change….
        let folder_shown = markie_core::path_display::fit_path(&folder, &home, FOLDER_CHARS);
        let folder_full: SharedString = folder.to_string_lossy().into_owned().into();

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

        // The import choice: applies to the Docs picked next.
        let choice = div()
            .id("google-two-way-default")
            .mt(px(12.))
            .flex()
            .items_start()
            .gap(px(10.))
            .cursor_pointer()
            .role(Role::CheckBox)
            .aria_label("Keep these Docs in sync both ways")
            .aria_toggled(if two_way_default { Toggled::True } else { Toggled::False })
            .child(super::settings::checkbox(two_way_default, false, t))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(12.)).text_color(t.foreground).child("Keep these Docs in sync both ways"))
                    .child(muted("Your edits here go back to the Doc in Google, and Google\u{2019}s changes come here, while Markie is open. Off: Refresh brings Google\u{2019}s changes in only.".into())),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.google_set_import_two_way(!two_way_default, cx)));

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
                    .child(
                        div()
                            .id("google-folder-path")
                            .text_size(px(11.))
                            .font_family("Menlo")
                            .text_color(t.muted)
                            .truncate()
                            .child(folder_shown)
                            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(folder_full.clone()).build(window, cx)),
                    ),
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
            let rows: Vec<AnyElement> = records.iter().enumerate().map(|(i, (path, rec))| self.render_google_row(i, path, rec, live.get(path).copied(), offline, busy, now, t, cx)).collect();
            let any_two_way = records.iter().any(|(_, r)| r.two_way);
            div()
                .mt(px(16.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .mb(px(8.))
                        .child(div().text_size(px(12.)).text_color(t.foreground).child(format!("Synced Docs ({})", records.len())))
                        .child(button("google-refresh-all", if any_two_way { "Sync All Now" } else { "Refresh All" }).on_click(cx.listener(|this, _, window, cx| this.on_refresh_all_google(&RefreshAllFromGoogle, window, cx)))),
                )
                .child(div().rounded(px(8.)).border_1().border_color(fade(t.border, 0.7)).children(rows))
                .child(
                    muted(if any_two_way {
                        "Docs that sync both ways send your saved edits to Google a few seconds after you save, and check Google every minute while Markie is open. Only the paragraphs you change are sent, so comments and anything Markdown can\u{2019}t show stay in the Doc. If the same paragraph changed in both places, Google\u{2019}s text wins and yours is kept as a dated copy beside the file. Tables, images, footnotes and rules are read only here.".into()
                    } else {
                        "Refresh brings Google\u{2019}s newer text into the file. If you edited the file here since the last sync, your text is kept as a dated conflict copy beside it.".into()
                    })
                    .mt(px(8.)),
                )
        });

        div()
            .id("google-docs-setting")
            .mb(px(24.))
            .child(section_label("Google Docs", t).mb(px(8.)))
            .child(header)
            .child(choice)
            .child(folder_row)
            .children(progress)
            .children(notice_el)
            .children(list)
            .into_any_element()
    }

    /// One synced Doc: its title (opens the file), its state in plain words,
    /// its actions and its sync choices.
    #[allow(clippy::too_many_arguments)]
    fn render_google_row(&mut self, i: usize, path: &Path, rec: &SyncRecord, live: Option<Live>, offline: bool, busy: bool, now: chrono::DateTime<chrono::Local>, t: &Tokens, cx: &mut Context<Self>) -> AnyElement {
        let (line, tone) = row_state(path, rec, live, offline, now);
        let fg = t.foreground;
        let tone_color = match tone {
            Tone::Warn => t.red,
            Tone::Busy => t.blue,
            Tone::Quiet => t.muted,
        };
        let (open, refresh, word, compare, dismiss, forget, sw, sg) = (path.to_path_buf(), path.to_path_buf(), path.to_path_buf(), path.to_path_buf(), path.to_path_buf(), path.to_path_buf(), path.to_path_buf(), path.to_path_buf());
        let stopped = rec.stopped.is_some();
        let access = rec.access.unwrap_or(store::Access { owned: true, can_edit: true, can_comment: true });
        let can_suggest = rec.two_way && !stopped && rec.tabs <= 1 && !access.owned && (access.can_edit || access.can_comment);
        let (two_way, suggest) = (rec.two_way, rec.suggest);
        let title: SharedString = rec.title.clone().into();
        let actions = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .when(rec.conflict.is_some() && !stopped, |el| {
                el.child(
                    overlay_button_owned(format!("google-compare-{i}"), "Compare", t)
                        .role(Role::Button)
                        .aria_label(format!("Compare your version of {title} with Google\u{2019}s"))
                        .on_click(cx.listener(move |this, _, window, cx| this.google_compare(compare.clone(), window, cx))),
                )
                .child(
                    overlay_button_owned(format!("google-dismiss-{i}"), "Dismiss", t)
                        .role(Role::Button)
                        .aria_label(format!("Dismiss the conflict for {title}"))
                        .on_click(cx.listener(move |this, _, _, cx| this.google_dismiss_conflict(dismiss.clone(), cx))),
                )
            })
            .when(stopped, |el| {
                el.child(
                    overlay_button_owned(format!("google-forget-{i}"), "Remove from List", t)
                        .role(Role::Button)
                        .aria_label(format!("Remove {title} from the list. The file stays."))
                        .on_click(cx.listener(move |this, _, _, cx| this.google_forget(forget.clone(), cx))),
                )
            })
            .when(!stopped, |el| {
                el.child(
                    overlay_button_owned(format!("google-refresh-{i}"), if two_way { "Sync Now" } else { "Refresh" }, t)
                        .when(busy, |b| b.opacity(0.5))
                        .role(Role::Button)
                        .aria_label(if two_way { format!("Sync {title} now") } else { format!("Refresh {title} from Google") })
                        .on_click(cx.listener(move |this, _, window, cx| this.google_refresh(vec![refresh.clone()], window, cx))),
                )
                .child(
                    overlay_button_owned(format!("google-word-{i}"), "Save as Word", t)
                        .when(busy, |b| b.opacity(0.5))
                        .role(Role::Button)
                        .aria_label(format!("Save {title} as a Word copy"))
                        .on_click(cx.listener(move |this, _, window, cx| this.google_save_word(word.clone(), window, cx))),
                )
            });
        let choices = (!stopped).then(|| {
            div()
                .mt(px(6.))
                .flex()
                .items_center()
                .gap(px(16.))
                .child(
                    div()
                        .id(SharedString::from(format!("google-two-way-{i}")))
                        .flex()
                        .items_center()
                        .gap(px(7.))
                        .cursor_pointer()
                        .role(Role::Switch)
                        .aria_label(format!("Sync {title} both ways"))
                        .aria_toggled(if two_way { Toggled::True } else { Toggled::False })
                        .child(small_switch(two_way, t))
                        .child(div().text_size(px(11.5)).text_color(t.muted).child("Sync both ways"))
                        .on_click(cx.listener(move |this, _, window, cx| this.google_set_two_way(sw.clone(), !two_way, window, cx))),
                )
                .when(can_suggest, |el| {
                    el.child(
                        div()
                            .id(SharedString::from(format!("google-suggest-{i}")))
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .cursor_pointer()
                            .role(Role::CheckBox)
                            .aria_label(format!("Send my edits to {title} as suggestions"))
                            .aria_toggled(if suggest { Toggled::True } else { Toggled::False })
                            .child(super::settings::checkbox(suggest, !access.can_edit, t).mt(px(0.)))
                            .child(div().text_size(px(11.5)).text_color(t.muted).child(if access.can_edit { "Send my edits as suggestions" } else { "Send my edits as suggestions (you can comment, not edit)" }))
                            .when(access.can_edit, |el| el.on_click(cx.listener(move |this, _, _, cx| this.google_set_suggest(sg.clone(), !suggest, cx)))),
                    )
                })
        });
        div()
            .id(SharedString::from(format!("google-row-{i}")))
            .px(px(12.))
            .py(px(9.))
            .when(i > 0, |el| el.border_t_1().border_color(fade(t.border, 0.6)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(
                        div()
                            .id(SharedString::from(format!("google-doc-{i}")))
                            .flex_1()
                            .min_w_0()
                            .cursor_pointer()
                            .role(Role::Link)
                            .aria_label(format!("Open {title}. {line}"))
                            .child(div().flex().items_center().gap(px(6.)).child(svg().path("markie/google-doc.svg").size(px(12.)).flex_none().text_color(t.blue)).child(div().text_size(px(12.5)).text_color(t.foreground).truncate().hover(move |el| el.text_color(fg)).child(title.clone())))
                            .child(div().mt(px(1.)).text_size(px(11.)).line_height(px(16.)).text_color(tone_color).child(line))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.close_dialog(window, cx);
                                this.open_path(&open, window, cx)
                            })),
                    )
                    .child(actions),
            )
            .children(choices)
            .into_any_element()
    }

    // ---------------------------------------------------------------- scene

    /// Scene `google`: Settings › Files with the Google Docs row.
    /// `{connected?: true, importing?: false, waiting?: false, notice?: "…", empty?: false,
    ///   states?: false, rows?: n, skip?: n, two_way?: true, only?: false, title?: "synced"}`.
    /// `states` shows one made-up Doc in each sync state; `two_way: false`
    /// unticks the import choice; `only` hides the rest of the Files tab so
    /// the Google section fills the frame; `title` (synced, sending,
    /// waiting, conflict, suggesting, refresh) marks the file on the command
    /// line as synced and leaves Settings closed, for the title bar.
    #[cfg(feature = "scene")]
    pub(super) fn scene_google(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let flag = |k: &str, d: bool| args.get(k).and_then(serde_json::Value::as_bool).unwrap_or(d);
        if *step == 0 {
            let folder = default_folder();
            let now = chrono::Local::now();
            let ago = |mins: i64| (now - chrono::Duration::minutes(mins)).to_rfc3339();
            let owner = Some(store::Access { owned: true, can_edit: true, can_comment: true });
            let rec = |id: &str, title: &str, mins: i64, error: Option<&str>| SyncRecord {
                doc_id: id.into(),
                title: title.into(),
                synced_at: ago(mins),
                error: error.map(str::to_string),
                two_way: true,
                access: owner,
                ..Default::default()
            };
            let mut live = HashMap::new();
            let title_state = args.get("title").and_then(serde_json::Value::as_str).map(str::to_string);
            let records = if let Some(state) = &title_state {
                let path = self.doc.as_ref().map(|d| d.path.clone()).unwrap_or_else(|| folder.join("Field notes.md"));
                let mut r = rec("d1", "Field notes", 2, None);
                match state.as_str() {
                    "sending" => {
                        live.insert(path.clone(), Live::Sending);
                    }
                    "waiting" => {
                        live.insert(path.clone(), Live::Waiting);
                    }
                    "conflict" => r.conflict = Some(folder.join("Field notes (conflict 2026-11-26 10.15).md")),
                    "suggesting" => {
                        r.suggest = true;
                        r.access = Some(store::Access { owned: false, can_edit: true, can_comment: true });
                    }
                    "refresh" => r.two_way = false,
                    _ => {}
                }
                vec![(path, r)]
            } else if flag("empty", false) || !flag("connected", true) {
                Vec::new()
            } else if flag("states", false) {
                let p = |n: &str| folder.join(format!("{n}.md"));
                let mut v = vec![
                    (p("Field notes"), rec("d1", "Field notes", 2, None)),
                    (p("Trip plan"), rec("d2", "Trip plan", 0, None)),
                    (p("Budget draft"), rec("d3", "Budget draft", 14, None)),
                    (p("Team handbook"), SyncRecord { conflict: Some(p("Team handbook (conflict 2026-11-26 10.15)")), ..rec("d4", "Team handbook", 1, None) }),
                    (p("Course notes"), SyncRecord { tabs: 3, ..rec("d5", "Course notes", 30, None) }),
                    (p("Shared proposal"), SyncRecord { suggest: true, access: Some(store::Access { owned: false, can_edit: true, can_comment: true }), ..rec("d6", "Shared proposal", 5, None) }),
                    (p("Recipes"), SyncRecord { held: vec!["tables".into(), "images".into()], ..rec("d7", "Recipes", 8, None) }),
                    (p("Reading list"), SyncRecord { two_way: false, ..rec("d8", "Reading list", 60 * 3, None) }),
                    (p("Old agenda"), SyncRecord { stopped: Some(Stopped::Trashed), ..rec("d9", "Old agenda", 60 * 26, None) }),
                ];
                live.insert(v[1].0.clone(), Live::Sending);
                live.insert(v[2].0.clone(), Live::Waiting);
                v.truncate(args.get("rows").and_then(serde_json::Value::as_u64).map_or(v.len(), |n| n as usize));
                let skip = args.get("skip").and_then(serde_json::Value::as_u64).unwrap_or(0) as usize;
                v.into_iter().skip(skip).collect()
            } else {
                vec![
                    (folder.join("Field notes.md"), rec("d1", "Field notes", 3, None)),
                    (folder.join("Trip plan.md"), rec("d2", "Trip plan", 95, None)),
                    (folder.join("Reading list.md"), SyncRecord { stopped: Some(Stopped::Trashed), ..rec("d3", "Reading list", 60 * 26, None) }),
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
                records,
                job,
                notice,
                two_way_default: flag("two_way", true),
                live,
                scene_only: flag("only", false),
                ..Default::default()
            };
            if title_state.is_none() {
                self.open_settings(SettingsSection::Files, window, cx);
            }
            *step = 1;
            return false;
        }
        *step += 1;
        *step > 4
    }
}

/// A small on/off switch, the shape Settings › Agents uses, sized for a row.
fn small_switch(on: bool, t: &Tokens) -> Div {
    let track_off = fade(t.muted, 0.35);
    div()
        .flex_none()
        .w(px(26.))
        .h(px(15.))
        .rounded_full()
        .p(px(2.))
        .bg(if on { t.blue } else { track_off })
        .flex()
        .when(on, |el| el.justify_end())
        .child(div().size(px(11.)).rounded_full().bg(gpui_kit::white()))
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
    use super::{GoogleError, JobKind, Live, Outcome, Path, PathBuf, Progress, Shared, Stopped, SyncRecord, Tone, available, client, held_phrase, mark, palette_commands, progress_line, refresh_summary, row_state, title_state};
    use markie_google::store::Access;

    #[test]
    fn a_synced_doc_says_when_or_why() {
        let now = chrono::Local::now();
        let rec = SyncRecord { synced_at: (now - chrono::Duration::minutes(5)).to_rfc3339(), two_way: true, ..Default::default() };
        let p = Path::new("/g/Plan.md");
        assert_eq!(row_state(p, &rec, None, false, now), ("Plan.md \u{b7} Synced 5 minutes ago".to_string(), Tone::Quiet));
        let broken = SyncRecord { error: Some("Google answered with an error (500).".into()), ..rec.clone() };
        assert_eq!(row_state(p, &broken, None, false, now).1, Tone::Warn);
        let refresh_only = SyncRecord { two_way: false, ..rec.clone() };
        assert!(row_state(p, &refresh_only, None, false, now).0.starts_with("Refresh only"));
    }

    #[test]
    fn every_sync_state_reads_in_plain_words() {
        let now = chrono::Local::now();
        let rec = SyncRecord { synced_at: (now - chrono::Duration::minutes(2)).to_rfc3339(), two_way: true, ..Default::default() };
        let p = Path::new("/g/Plan.md");
        let line = |r: &SyncRecord, live: Option<Live>, offline: bool| row_state(p, r, live, offline, now).0;
        assert_eq!(line(&rec, Some(Live::Sending), false), "Sending\u{2026}");
        assert!(line(&rec, None, true).starts_with("Waiting for connection"));
        assert!(line(&rec, Some(Live::Waiting), false).starts_with("Waiting for connection"));
        assert!(line(&SyncRecord { conflict: Some("/g/Plan (conflict).md".into()), ..rec.clone() }, None, false).starts_with("Conflict:"));
        assert_eq!(line(&SyncRecord { tabs: 3, ..rec.clone() }, None, false), "Read only: has tabs \u{b7} Synced 2 minutes ago");
        assert_eq!(line(&SyncRecord { suggest: true, access: Some(Access { owned: false, can_edit: true, can_comment: true }), ..rec.clone() }, None, false), "Suggesting \u{b7} Synced 2 minutes ago");
        assert!(line(&SyncRecord { held: vec!["tables".into(), "images".into()], ..rec.clone() }, None, false).ends_with("Kept here, not sent: tables and images"));
        assert!(line(&SyncRecord { stopped: Some(Stopped::Trashed), ..rec.clone() }, None, false).contains("trash"));
        assert_eq!(held_phrase(&["a".into(), "b".into(), "c".into()]), "a, b and c");
        assert_eq!(title_state(&rec, None, false), "Synced");
        assert_eq!(title_state(&rec, Some(Live::Sending), false), "Sending\u{2026}");
        assert_eq!(title_state(&SyncRecord { two_way: false, ..rec.clone() }, None, false), "Refresh only");
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
