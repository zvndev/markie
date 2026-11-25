//! The vault page: `src/components/documents/vault-panel.tsx` and
//! `vault-env-editor.tsx`, on top of `markie-vault`.
//!
//! The vault lives in Markie RS's own data folder (`vault.json`) and its
//! Touch ID secret in Markie RS's own Keychain service ("Markie RS Vault").
//! It never opens the Electron app's vault or Keychain items.
//!
//! Plaintext stays inside this page: it is never handed to the Library, the
//! editor, history or drafts. Every repository call runs off the UI thread,
//! because the key derivation takes a moment and a Touch ID sheet blocks the
//! thread that asked for it.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui_kit::component::input::{EditorState, InputEvent, InputState};
use gpui_kit::*;
use gpui_kit::component::WindowExt as _;

use markie_core::formats::{self, Newline, Representation, TextEncoding};
use markie_office::model::{Format, TextEdit};
use markie_office::rich_document::{OfficeDocument, export_rich_document, open_rich_document, replace_rich_text};
use markie_vault::backup::{VAULT_BACKUP_FILE_NAME, VAULT_BACKUP_MAX_CHARACTERS, parse_vault_backup, vault_backup_text};
use markie_vault::clipboard::{CLEAR_AFTER, SecretClipboard, ThreadScheduler};
use markie_vault::device::{Biometric, DeviceKeeper, KeychainSecretStore, PromptDeclined, SecretStore, TouchIdKeeper, TouchIdStatus};
use markie_vault::dotenv::{self, DotenvDocument, LineKind};
use markie_vault::envelope::{VaultDocumentMetadata, limits};
use markie_vault::passphrase::{suggest_passphrase, SUGGESTED_PASSPHRASE_WORDS};
use markie_vault::private::{PrivateEntry, PrivateMetadata, PrivateStore};
use markie_vault::{DeviceFailure, FileVaultStorage, StorageErrorCode, VaultEntry, VaultError, VaultErrorCode, VaultRepository};

use super::Workspace;

pub(super) mod ui;
pub(crate) mod private_files;
mod private_ui;
use ui::{CopyFeedback, Escape, EscapeState, Shortcut, escape_target, shows_search};

pub const IDLE_LOCK: Duration = Duration::from_secs(5 * 60);
pub const CHECKPOINT: Duration = Duration::from_secs(2);
/// Revealed values mask themselves again this long after the last reveal.
pub const REVEAL_REMASK: Duration = Duration::from_secs(60);

fn should_auto_lock(locked: bool, shielded: bool, hidden: bool, idle: Duration) -> bool {
    !locked && !shielded && (hidden || idle >= IDLE_LOCK)
}
const MASK: &str = "••••••••••••";
const ENV_MEDIA_TYPE: &str = "text/plain";
/// Where "Not now" on the Touch ID offer is remembered. Electron keeps it in localStorage.
const TOUCH_ID_OFFER_FILE: &str = "vault-touch-id-offer";

type Repo = VaultRepository<FileVaultStorage>;

#[cfg(target_os = "macos")]
type Bio = markie_vault::device::MacTouchId;
#[cfg(target_os = "macos")]
fn biometric() -> Bio {
    markie_vault::device::MacTouchId
}

/// Windows Hello and a Linux keyring prompt are not wired yet: no device unlock there.
#[cfg(not(target_os = "macos"))]
pub struct NoBiometric;
#[cfg(not(target_os = "macos"))]
impl Biometric for NoBiometric {
    fn can_prompt(&self) -> bool {
        false
    }
    fn prompt(&self, _reason: &str) -> Result<(), PromptDeclined> {
        Err(PromptDeclined)
    }
}
#[cfg(not(target_os = "macos"))]
type Bio = NoBiometric;
#[cfg(not(target_os = "macos"))]
fn biometric() -> Bio {
    NoBiometric
}

/// What the page asks of Touch ID. One trait object, so a scene build can
/// swap in an in-memory double and never touch the Keychain.
pub(crate) trait PageKeeper: DeviceKeeper {
    fn status(&self, vault_id: &str) -> TouchIdStatus;
    fn confirm(&self, vault_id: &str, action: &str, label: &str) -> Result<(), DeviceFailure>;
}

impl<B: Biometric, S: SecretStore> PageKeeper for TouchIdKeeper<B, S> {
    fn status(&self, vault_id: &str) -> TouchIdStatus {
        TouchIdKeeper::<B, S>::status(self, vault_id)
    }
    fn confirm(&self, vault_id: &str, action: &str, label: &str) -> Result<(), DeviceFailure> {
        TouchIdKeeper::<B, S>::confirm(self, vault_id, action, label)
    }
}

type Keeper = dyn PageKeeper;

/// Scene mode (`--features scene` and `MARKIE_RS_SCENE`): Touch ID and the
/// clipboard are in-memory doubles, and the hidden window counts as shown.
fn scene_mode() -> bool {
    cfg!(feature = "scene") && std::env::var_os("MARKIE_RS_SCENE").is_some()
}

fn page_keeper() -> Arc<Keeper> {
    if scene_mode() {
        return Arc::new(TouchIdKeeper::new(markie_vault::device::FakeBiometric::default(), markie_vault::device::MemorySecretStore::default()));
    }
    Arc::new(TouchIdKeeper::new(biometric(), KeychainSecretStore::new(keychain_service())))
}

/// The window is hidden, so the vault must lock. A scene's window is never shown.
fn window_hidden(window: &Window) -> bool {
    !window.is_visible() && !scene_mode()
}

#[allow(dead_code)]
fn _assert_biometric_impl(b: &Bio) -> &dyn Biometric {
    b
}
#[allow(dead_code)]
fn _unused(_: PromptDeclined) {}

pub fn vault_path() -> PathBuf {
    markie_core::paths::data_dir().join("vault.json")
}

pub fn keychain_service() -> String {
    format!("{} Vault", markie_core::paths::PROFILE_NAME)
}

/// `failureCopy` in vault-panel.tsx.
pub fn failure_copy(failure: &VaultError) -> &'static str {
    match failure {
        VaultError::Save { failure, .. } => failure_copy(failure),
        VaultError::Backup => "This file is not a Markie vault backup.",
        VaultError::Device(reason) => match reason {
            DeviceFailure::Missing | DeviceFailure::Stale => {
                "Touch ID is no longer set up for this vault on this Mac. Use your passphrase, then turn Touch ID on again in Settings."
            }
            DeviceFailure::Busy => "Touch ID is already waiting for you.",
            DeviceFailure::Cancelled => "Touch ID was cancelled.",
            DeviceFailure::Unavailable => "Touch ID is not available right now. Use your passphrase.",
        },
        VaultError::Vault(VaultErrorCode::AuthenticationFailed) => "The passphrase is incorrect or the vault was altered. Nothing was opened.",
        VaultError::Vault(VaultErrorCode::InvalidPassphrase) => "Use a strong passphrase of at least 16 characters, not a short PIN.",
        VaultError::Vault(VaultErrorCode::LimitExceeded) => "This file exceeds the vault's 8 MiB file limit.",
        VaultError::Vault(VaultErrorCode::Locked) => "The vault locked before the operation completed.",
        VaultError::Storage(StorageErrorCode::Quota) => "Disk storage is full. Edits remain unsaved; free space and retry. Encrypted recovery lasts only in this window.",
        VaultError::Storage(StorageErrorCode::Conflict) => {
            "Another window changed the vault. Your edits are still here; export a copy before locking and reopening."
        }
        VaultError::Storage(StorageErrorCode::Unavailable) => "Encrypted storage is unavailable. No fallback or plaintext copy was saved.",
        _ => "The operation could not complete. Your current edits were not cleared. No plaintext fallback was saved.",
    }
}

fn is_auth_failure(e: &VaultError) -> bool {
    matches!(e, VaultError::Vault(VaultErrorCode::AuthenticationFailed | VaultErrorCode::InvalidPassphrase))
}

/// `formatOf`: env names are text here even though the document formats do not classify them.
fn representation_of(name: &str) -> (Representation, &'static str) {
    if dotenv::is_env_file_name(name) {
        return (Representation::Text, "env");
    }
    let kind = formats::classify(name);
    (kind.representation(), kind.label())
}

/// `validFilename`: same representation, and the same kind for binary formats.
pub fn valid_filename(original: &str, next: &str) -> bool {
    let (orep, okind) = representation_of(original);
    let (nrep, nkind) = representation_of(next);
    !next.is_empty() && safe_file_name(next) == next && orep == nrep && (orep != Representation::Bytes || okind == nkind)
}

/// `safeWebFileName`: no separators, controls or reserved characters.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if (c as u32) < 0x20 || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." { "Untitled".into() } else { trimmed.to_string() }
}

/// `normalizeTypedNewlines`: text controls report bare LF; restore the source's own ending.
pub fn normalize_typed_newlines(value: &str, newline: Newline) -> String {
    let lf = value.replace("\r\n", "\n").replace('\r', "\n");
    match newline {
        Newline::Crlf => lf.replace('\n', "\r\n"),
        Newline::Cr => lf.replace('\n', "\r"),
        _ => value.to_string(),
    }
}

/// `# OLD_TOKEN=abc` is a common way to park a secret, so its value is masked like a live one.
pub fn parked_key(comment: &str) -> Option<String> {
    let stripped = comment.trim_start_matches([' ', '\t']).strip_prefix('#').unwrap_or(comment).trim_start_matches([' ', '\t']);
    let parked = dotenv::parse_dotenv(stripped);
    match parked.lines.as_slice() {
        [line] => match &line.kind {
            LineKind::Entry(e) if !e.value.is_empty() => Some(e.key.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn key_problem(key: &str, duplicates: &BTreeSet<String>) -> Option<String> {
    if key.is_empty() {
        return Some("Add a key name.".into());
    }
    if !dotenv::is_valid_dotenv_key(key) {
        return Some("Start with a letter or underscore, then use letters, numbers, underscores or dots.".into());
    }
    if duplicates.contains(key) {
        return Some(format!("{key} is set more than once. Most loaders use the last one."));
    }
    None
}

// ── State ──

enum Body {
    Text { text: String, encoding: TextEncoding, bom: bool, newline: Newline },
    Docx(Box<OfficeDocument>),
    Opaque,
}

struct SecureDoc {
    id: Option<String>,
    name: String,
    original_name: String,
    media_type: String,
    bytes: zeroize::Zeroizing<Vec<u8>>,
    dirty: bool,
    body: Body,
    /// A private file: where it came from. None for an ordinary vault item.
    private: Option<PrivateMetadata>,
}

impl SecureDoc {
    fn from_read(id: Option<String>, name: String, media_type: String, bytes: zeroize::Zeroizing<Vec<u8>>, recovery: bool) -> Self {
        let body = match representation_of(&name).0 {
            Representation::Text => match formats::decode_text(&bytes) {
                Ok(d) => Body::Text { text: d.text, encoding: d.encoding, bom: d.bom, newline: d.newline },
                Err(_) => Body::Opaque,
            },
            Representation::Bytes if formats::classify(&name) == formats::FormatKind::Docx => {
                open_rich_document(Format::Docx, &bytes).map(|doc| Body::Docx(Box::new(doc))).unwrap_or(Body::Opaque)
            }
            Representation::Bytes => Body::Opaque,
        };
        Self { id, original_name: name.clone(), name, media_type, bytes, dirty: recovery, body, private: None }
    }

    fn from_private(id: String, doc: markie_vault::private::PrivateDocument) -> Self {
        let mut opened = Self::from_read(Some(id), doc.metadata.name.clone(), doc.metadata.media_type.clone(), doc.bytes, false);
        opened.private = Some(doc.metadata);
        opened
    }

    /// The metadata a private file is saved back with: a rename keeps its folder.
    fn private_metadata(&self, name: &str) -> Option<PrivateMetadata> {
        self.private.as_ref().map(|m| PrivateMetadata { name: name.to_string(), media_type: self.media_type.clone(), ..m.clone() })
    }

    fn is_env(&self) -> bool {
        matches!(self.body, Body::Text { .. }) && dotenv::is_env_file_name(&self.original_name)
    }

    fn text(&self) -> Option<&str> {
        match &self.body {
            Body::Text { text, .. } => Some(text),
            Body::Docx(_) | Body::Opaque => None,
        }
    }

    /// `documentBytes`.
    fn current_bytes(&self) -> Result<zeroize::Zeroizing<Vec<u8>>, VaultError> {
        let bytes = match &self.body {
            Body::Text { text, encoding, bom, .. } => formats::encode_text(text, *encoding, *bom)
                .map_err(|_| VaultError::Vault(VaultErrorCode::InvalidEnvelope))?,
            Body::Docx(doc) => export_rich_document(doc).map_err(|_| VaultError::Vault(VaultErrorCode::InvalidEnvelope))?,
            Body::Opaque => return Ok(self.bytes.clone()),
        };
        Ok(zeroize::Zeroizing::new(bytes))
    }

    fn edit_docx_run(&mut self, id: &str, value: String) -> Result<(), ()> {
        let Body::Docx(doc) = &mut self.body else { return Err(()) };
        let Some(run) = doc.paragraphs.iter().flat_map(|p| &p.runs).find(|r| r.id == id) else { return Err(()) };
        if !doc.can_edit || !run.can_edit {
            return Err(());
        }
        if run.text != value {
            **doc = replace_rich_text(doc, &[TextEdit { run_id: id.into(), text: value }]).map_err(|_| ())?;
            self.dirty = true;
        }
        Ok(())
    }
}

struct PrivateRun {
    label: String,
    read_only: bool,
    input: Entity<InputState>,
    _change: Subscription,
}

/// What waits for a fresh Touch ID or passphrase check.
enum Pending {
    Open(VaultEntry),
    OpenPrivate(PrivateEntry),
    Reveal(Vec<usize>),
    RevealRaw,
    Copy { value: zeroize::Zeroizing<String>, label: String, row: Option<usize> },
}

struct EnvRow {
    key: Entity<InputState>,
    value: EnvValue,
    _subs: [Subscription; 2],
}

enum EnvValue {
    Single(Entity<InputState>),
    Multi(Entity<EditorState>),
}

#[derive(Default)]
struct EnvView {
    raw: bool,
    revealed: BTreeSet<usize>,
    revealed_at: Option<Instant>,
    /// The text the rows were built from: an outside change re-parses and masks.
    text: String,
    parsed: Option<DotenvDocument>,
    rows: HashMap<usize, EnvRow>,
}

/// A file waiting to be made private, from the menu or a row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivateRequest {
    pub path: PathBuf,
    /// The file has a Markie Cloud copy, or is shared: that copy stays.
    pub cloud: bool,
}

/// What the page tells the window.
pub enum VaultEvent {
    /// The file at this path is private now: drop every copy the window holds.
    MadePrivate(PathBuf),
    /// Make Not Private put a file back here.
    Restored(PathBuf),
}

impl EventEmitter<VaultEvent> for VaultPage {}

pub struct VaultPage {
    repo: Arc<Mutex<Repo>>,
    private: Arc<Mutex<PrivateStore>>,
    private_entries: Vec<PrivateEntry>,
    /// Private files on disk, known without the key.
    private_count: usize,
    private_unlocked: bool,
    request: Option<PrivateRequest>,
    private_passphrase: Entity<InputState>,
    keeper: Arc<Keeper>,
    clipboard: SecretClipboard,
    has_vault: Option<bool>,
    locked: bool,
    shielded: bool,
    busy: bool,
    notice: String,
    error: Option<String>,
    entries: Vec<VaultEntry>,
    opened: Option<SecureDoc>,
    private_runs: Vec<PrivateRun>,
    touch_id: TouchIdStatus,
    settings_open: bool,
    enrolling: bool,
    restore_file: Option<(String, String)>,
    suggested: Option<zeroize::Zeroizing<String>>,
    offer_touch_id: bool,
    gate: Option<(String, Pending)>,
    /// Touch ID is set up, but the passphrase field was asked for.
    use_passphrase: bool,
    /// The field to focus at the next render.
    focus_next: Option<Entity<InputState>>,
    /// The last secret copied, for the line that counts down its clearing.
    copied: Option<CopyFeedback>,
    gate_busy: bool,
    pending_confirm: Option<Pending>,
    operation: u64,
    last_activity: Instant,
    env: EnvView,
    passphrase: Entity<InputState>,
    confirmation: Entity<InputState>,
    enroll_passphrase: Entity<InputState>,
    restore_passphrase: Entity<InputState>,
    gate_passphrase: Entity<InputState>,
    query: Entity<InputState>,
    filename: Entity<InputState>,
    text_editor: Entity<EditorState>,
    raw_editor: Entity<EditorState>,
    /// Set while this page writes an input, so its change event is not an edit.
    writing: bool,
    pending_text: Option<String>,
    pending_submit: Option<Submit>,
    _subscriptions: Vec<Subscription>,
    _idle: Task<()>,
}

fn masked_input(window: &mut Window, cx: &mut App) -> Entity<InputState> {
    cx.new(|cx| InputState::new(window, cx).masked(true))
}

impl VaultPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let repo = Arc::new(Mutex::new(VaultRepository::new(FileVaultStorage::new(vault_path()))));
        let keeper = page_keeper();
        let clipboard = SecretClipboard::new(secret_pasteboard(), Arc::new(ThreadScheduler), CLEAR_AFTER);
        let passphrase = masked_input(window, cx);
        let confirmation = masked_input(window, cx);
        let enroll_passphrase = masked_input(window, cx);
        let restore_passphrase = masked_input(window, cx);
        let gate_passphrase = masked_input(window, cx);
        let private_passphrase = masked_input(window, cx);
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by name"));
        let filename = cx.new(|cx| InputState::new(window, cx));
        let text_editor = cx.new(|cx| EditorState::new(window, cx).language("text").line_number(false).soft_wrap(true));
        let raw_editor = cx.new(|cx| EditorState::new(window, cx).language("text").line_number(false).soft_wrap(true));

        let page = cx.weak_entity();
        let subscriptions = vec![
            window.observe_window_visibility(move |visibility, window, cx| {
                if !visibility.is_visible() && !scene_mode() {
                    let _ = page.update(cx, |page, cx| page.maybe_auto_lock(true, window, cx));
                }
            }),
            cx.subscribe(&passphrase, |this, _, e: &InputEvent, cx| match e {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.pending_submit = Some(Submit::Authenticate),
                _ => {}
            }),
            cx.subscribe(&confirmation, |this, _, e: &InputEvent, cx| match e {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.pending_submit = Some(Submit::Authenticate),
                _ => {}
            }),
            cx.subscribe(&enroll_passphrase, |this, _, e: &InputEvent, cx| match e {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.pending_submit = Some(Submit::Enroll),
                _ => {}
            }),
            cx.subscribe(&restore_passphrase, |this, _, e: &InputEvent, cx| match e {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.pending_submit = Some(Submit::Restore),
                _ => {}
            }),
            cx.subscribe(&gate_passphrase, |this, _, e: &InputEvent, cx| match e {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.pending_submit = Some(Submit::Gate),
                _ => {}
            }),
            cx.subscribe(&private_passphrase, |this, _, e: &InputEvent, cx| match e {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.pending_submit = Some(Submit::Private),
                _ => {}
            }),
            cx.subscribe(&query, |_, _, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.subscribe(&filename, |this, state, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) && !this.writing {
                    let name = state.read(cx).value().to_string();
                    if let Some(doc) = this.opened.as_mut()
                        && doc.name != name
                    {
                        doc.name = name;
                        doc.dirty = true;
                        this.error = None;
                    }
                    cx.notify();
                }
            }),
            cx.subscribe(&text_editor, |this, state, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) && !this.writing {
                    let value = state.read(cx).value().to_string();
                    this.set_body_text(value, cx);
                }
            }),
            cx.subscribe(&raw_editor, |this, state, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) && !this.writing {
                    let value = state.read(cx).value().to_string();
                    this.set_body_text(value, cx);
                }
            }),
        ];

        let private = Arc::new(Mutex::new(PrivateStore::new(private_files::private_dir())));
        let mut this = Self {
            repo,
            private,
            private_entries: Vec::new(),
            private_count: 0,
            private_unlocked: false,
            request: None,
            private_passphrase,
            keeper,
            clipboard,
            has_vault: None,
            locked: true,
            shielded: false,
            busy: false,
            notice: "Checking encrypted storage…".into(),
            error: None,
            entries: Vec::new(),
            opened: None,
            private_runs: Vec::new(),
            touch_id: TouchIdStatus { available: false, enrolled: false },
            settings_open: false,
            enrolling: false,
            restore_file: None,
            suggested: None,
            offer_touch_id: false,
            gate: None,
            use_passphrase: false,
            focus_next: None,
            copied: None,
            gate_busy: false,
            pending_confirm: None,
            operation: 0,
            last_activity: Instant::now(),
            env: EnvView::default(),
            passphrase,
            confirmation,
            enroll_passphrase,
            restore_passphrase,
            gate_passphrase,
            query,
            filename,
            text_editor,
            raw_editor,
            writing: false,
            pending_text: None,
            pending_submit: None,
            _subscriptions: subscriptions,
            _idle: Task::ready(()),
        };
        this.inspect(window, cx);
        this.start_idle_timer(window, cx);
        this
    }
}

#[derive(Clone, Copy)]
enum Submit {
    Authenticate,
    Enroll,
    Restore,
    Gate,
    Private,
}

/// A clipboard that keeps nothing: for platforms without a concealed writer,
/// and for scenes, which must never write Kirby's pasteboard.
#[allow(dead_code)]
struct Nowhere;
impl markie_vault::clipboard::Clipboard for Nowhere {
    fn read_text(&self) -> Option<String> {
        None
    }
    fn write_secret(&self, _text: &str) {}
    fn clear(&self) {}
}

#[cfg(target_os = "macos")]
fn secret_pasteboard() -> Box<dyn markie_vault::clipboard::Clipboard> {
    if scene_mode() {
        return Box::new(Nowhere);
    }
    Box::new(markie_vault::clipboard::MacPasteboard)
}

/// Windows and Linux need their own concealed clipboard writer; until then a
/// copy goes nowhere rather than into a clipboard history.
#[cfg(not(target_os = "macos"))]
fn secret_pasteboard() -> Box<dyn markie_vault::clipboard::Clipboard> {
    Box::new(Nowhere)
}

fn touch_id_offer_dismissed() -> bool {
    std::fs::read_to_string(markie_core::paths::data_dir().join(TOUCH_ID_OFFER_FILE)).is_ok_and(|t| t.trim() == "dismissed")
}

impl VaultPage {
    fn input_text(input: &Entity<InputState>, cx: &App) -> zeroize::Zeroizing<String> {
        zeroize::Zeroizing::new(input.read(cx).value().to_string())
    }

    fn clear_input(&mut self, input: &Entity<InputState>, window: &mut Window, cx: &mut Context<Self>) {
        self.writing = true;
        input.update(cx, |s, cx| s.set_value("", window, cx));
        self.writing = false;
    }

    fn clear_secret_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for input in [
            self.passphrase.clone(),
            self.confirmation.clone(),
            self.enroll_passphrase.clone(),
            self.restore_passphrase.clone(),
            self.gate_passphrase.clone(),
            self.private_passphrase.clone(),
        ] {
            self.clear_input(&input, window, cx);
        }
    }

    /// Run one repository operation in the background. `done` runs only if no
    /// other operation started since (Electron's operation epoch).
    fn run<T: Send + 'static>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        job: impl FnOnce(&mut Repo, &Keeper) -> Result<T, VaultError> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, VaultError>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        self.run_all(window, cx, move |repo, _, keeper| job(repo, keeper), done);
    }

    /// `run`, with the private store too. Locks are always taken repository first.
    fn run_all<T: Send + 'static>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        job: impl FnOnce(&mut Repo, &mut PrivateStore, &Keeper) -> Result<T, VaultError> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, VaultError>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        self.operation += 1;
        let ticket = self.operation;
        self.busy = true;
        self.error = None;
        self.notice.clear();
        cx.notify();
        let repo = self.repo.clone();
        let private = self.private.clone();
        let keeper = self.keeper.clone();
        let work = cx.background_executor().spawn(async move {
            let mut guard = repo.lock().unwrap_or_else(|p| p.into_inner());
            let mut store = private.lock().unwrap_or_else(|p| p.into_inner());
            job(&mut guard, &mut store, &*keeper)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = work.await;
            this.update_in(cx, |this, window, cx| {
                if ticket != this.operation {
                    return;
                }
                this.busy = false;
                done(this, result, window, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn inspect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.run(window, cx, |repo, _| repo.inspect(), |this, result, window, cx| match result {
            Ok(exists) => {
                this.has_vault = Some(exists);
                this.notice.clear();
                this.focus_next = Some(this.passphrase.clone());
                this.refresh_touch_id(window, cx);
            }
            Err(e) => this.error = Some(failure_copy(&e).into()),
        });
    }

    /// Touch ID is offered only when the stored slot and this Mac's Keychain secret both exist.
    fn refresh_touch_id(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let repo = self.repo.clone();
        let keeper = self.keeper.clone();
        let task = cx.background_executor().spawn(async move {
            let (vault_id, slot) = {
                let r = repo.lock().unwrap_or_else(|p| p.into_inner());
                (r.vault_id(), r.has_device_slot())
            };
            let status = keeper.status(vault_id.as_deref().unwrap_or(""));
            TouchIdStatus { available: status.available, enrolled: status.available && status.enrolled && slot }
        });
        cx.spawn(async move |this, cx| {
            let status = task.await;
            this.update(cx, |this, cx| {
                this.touch_id = status;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// `lockNow`.
    pub fn lock_now(&mut self, message: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.operation += 1;
        let ticket = self.operation;
        let mut deferred_lock = false;
        let private_now = match self.private.try_lock() {
            Ok(mut store) => {
                store.lock();
                true
            }
            Err(std::sync::TryLockError::Poisoned(store)) => {
                store.into_inner().lock();
                true
            }
            Err(std::sync::TryLockError::WouldBlock) => false,
        };
        match self.repo.try_lock() {
            Ok(mut repo) if private_now => repo.lock(),
            Err(std::sync::TryLockError::Poisoned(repo)) if private_now => repo.into_inner().lock(),
            _ => {
                // A save or biometric operation may still own the repository.
                // Shield the UI now, even when releasing the key has to wait.
                deferred_lock = true;
                let repo = self.repo.clone();
                let private = self.private.clone();
                let lock = cx.background_spawn(async move {
                    repo.lock().unwrap_or_else(|p| p.into_inner()).lock();
                    private.lock().unwrap_or_else(|p| p.into_inner()).lock();
                });
                cx.spawn(async move |this, cx| {
                    lock.await;
                    let _ = this.update(cx, |page, cx| {
                        if page.operation == ticket {
                            page.busy = false;
                            cx.notify();
                        }
                    });
                }).detach();
            }
        }
        self.gate = None;
        self.gate_busy = false;
        self.pending_confirm = None;
        self.copied = None;
        self.use_passphrase = false;
        self.focus_next = Some(self.passphrase.clone());
        // A key copied out a moment ago should not outlive the vault it came from.
        self.clipboard.clear_now();
        self.opened = None;
        self.private_runs.clear();
        self.env = EnvView::default();
        self.entries.clear();
        self.private_entries.clear();
        self.private_unlocked = false;
        self.suggested = None;
        self.enrolling = false;
        self.restore_file = None;
        self.settings_open = false;
        self.offer_touch_id = false;
        self.error = None;
        self.locked = true;
        self.shielded = false;
        self.busy = deferred_lock;
        self.notice = message.into();
        self.clear_secret_inputs(window, cx);
        self.set_editor_text(&self.text_editor.clone(), "", window, cx);
        self.set_editor_text(&self.raw_editor.clone(), "", window, cx);
        self.clear_input(&self.query.clone(), window, cx);
        cx.notify();
    }

    pub fn is_locked(&self) -> bool {
        self.locked
    }

    /// Whether leaving the page would lose edits. The caller asks first.
    pub fn has_unsaved(&self) -> bool {
        self.opened.as_ref().is_some_and(|d| d.dirty) || self.repo.try_lock().map(|r| r.has_volatile_recovery()).unwrap_or(true)
    }

    /// The shared tail of every way in.
    fn enter_vault(&mut self, message: &str, window: &mut Window, cx: &mut Context<Self>) {
        let listed = self.repo.lock().unwrap_or_else(|p| p.into_inner()).list("");
        match listed {
            Ok(entries) => {
                self.has_vault = Some(true);
                if window_hidden(window) {
                    self.lock_now("Vault locked because this page is hidden.", window, cx);
                    return;
                }
                self.locked = false;
                self.entries = entries;
                self.refresh_private();
                self.suggested = None;
                self.last_activity = Instant::now();
                let recovery = self.repo.lock().map(|r| r.has_volatile_recovery()).unwrap_or(false);
                self.notice = if recovery {
                    "Encrypted recovery is available only in this window. Open it and save again before closing.".into()
                } else {
                    message.into()
                };
                self.refresh_touch_id(window, cx);
            }
            Err(e) => {
                self.repo.lock().unwrap_or_else(|p| p.into_inner()).lock();
                self.error = Some(failure_copy(&e).into());
            }
        }
    }

    fn authenticate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let secret = Self::input_text(&self.passphrase, cx);
        let confirmation = Self::input_text(&self.confirmation, cx);
        let creating = self.has_vault == Some(false);
        if secret.is_empty() || (creating && confirmation.is_empty()) || self.busy {
            return;
        }
        if creating && *secret != *confirmation {
            self.error = Some("The passphrases do not match.".into());
            cx.notify();
            return;
        }
        self.clear_input(&self.passphrase.clone(), window, cx);
        self.clear_input(&self.confirmation.clone(), window, cx);
        let has_vault = self.has_vault == Some(true);
        self.run_all(
            window,
            cx,
            move |repo, private, _| {
                let result = if has_vault { repo.unlock(&secret) } else { repo.create(&secret) };
                if result.is_err() {
                    // A valid header with a tampered record must not leave unlocked keys behind.
                    repo.lock();
                } else if private.unlock_or_create(&secret).is_err() {
                    // Private files made under another passphrase stay locked.
                    private.lock();
                }
                result
            },
            |this, result, window, cx| match result {
                Ok(()) => {
                    this.enter_vault("", window, cx);
                    // After a passphrase unlock, offer Touch ID once where the Mac supports it.
                    if !this.locked && !touch_id_offer_dismissed() {
                        this.offer_touch_id = true;
                    }
                }
                Err(e) => this.error = Some(failure_copy(&e).into()),
            },
        );
    }

    fn unlock_with_touch_id(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clear_input(&self.passphrase.clone(), window, cx);
        self.run(
            window,
            cx,
            |repo, keeper| {
                let r = repo.unlock_with_device(keeper as &dyn DeviceKeeper);
                if r.is_err() {
                    repo.lock();
                }
                r
            },
            |this, result, window, cx| match result {
                Ok(()) => this.enter_vault("", window, cx),
                Err(VaultError::Device(reason)) => {
                    // Fall back to the passphrase quietly; a missing or stale secret hides the button.
                    if matches!(reason, DeviceFailure::Missing | DeviceFailure::Stale) {
                        this.touch_id.enrolled = false;
                    }
                    if reason == DeviceFailure::Cancelled {
                        this.notice = "Touch ID was cancelled. Use your passphrase, or try again.".into();
                    } else {
                        this.error = Some(failure_copy(&VaultError::Device(reason)).into());
                    }
                }
                Err(e) => this.error = Some(failure_copy(&e).into()),
            },
        );
    }

    fn enroll_touch_id(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let secret = Self::input_text(&self.enroll_passphrase, cx);
        if secret.is_empty() {
            return;
        }
        self.clear_input(&self.enroll_passphrase.clone(), window, cx);
        self.run(
            window,
            cx,
            move |repo, keeper| repo.enroll_device(&secret, keeper as &dyn DeviceKeeper),
            |this, result, window, cx| match result {
                Ok(()) => {
                    this.enrolling = false;
                    this.offer_touch_id = false;
                    this.notice = "Touch ID is on. Opening, showing or copying an item asks for it too.".into();
                    this.refresh_touch_id(window, cx);
                }
                Err(VaultError::Device(DeviceFailure::Cancelled)) => this.notice = "Touch ID was not turned on.".into(),
                Err(e) if is_auth_failure(&e) => this.error = Some("That passphrase is not correct. Touch ID was not turned on.".into()),
                Err(e) => this.error = Some(failure_copy(&e).into()),
            },
        );
    }

    fn disable_touch_id(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.run(
            window,
            cx,
            |repo, keeper| repo.remove_device(keeper as &dyn DeviceKeeper),
            |this, result, window, cx| {
                match result {
                    Ok(()) => this.notice = "Touch ID unlock is off.".into(),
                    Err(VaultError::Device(_)) => {
                        this.error = Some("Touch ID is off for this vault, but its keychain item could not be deleted. Try again.".into())
                    }
                    Err(e) => this.error = Some(failure_copy(&e).into()),
                }
                this.refresh_touch_id(window, cx);
            },
        );
    }

    fn suggest(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(next) = suggest_passphrase(SUGGESTED_PASSPHRASE_WORDS) else { return };
        self.writing = true;
        self.passphrase.update(cx, |s, cx| s.set_value(next.clone(), window, cx));
        self.confirmation.update(cx, |s, cx| s.set_value(next.clone(), window, cx));
        self.writing = false;
        self.suggested = Some(zeroize::Zeroizing::new(next));
        self.error = None;
        cx.notify();
    }

    fn copy_suggestion(&mut self, cx: &mut Context<Self>) {
        let Some(s) = &self.suggested else { return };
        match self.clipboard.copy(s) {
            Ok(_) => self.notice = "Copied. Paste it into your password manager now. Markie clears the clipboard in 30 seconds.".into(),
            Err(_) => self.error = Some("Could not copy. Select the words and copy them yourself.".into()),
        }
        cx.notify();
    }

    fn back_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.run(window, cx, |repo, _| repo.backup(), |this, result, window, cx| match result {
            Ok(text) => {
                let dir = dirs::download_dir().unwrap_or_else(markie_core::paths::home_dir);
                let rx = cx.prompt_for_new_path(&dir, Some(VAULT_BACKUP_FILE_NAME));
                cx.spawn_in(window, async move |this, cx| {
                    if let Ok(Ok(Some(path))) = rx.await {
                        let ok = std::fs::write(&path, text.as_bytes()).is_ok();
                        this.update(cx, |this, cx| {
                            if ok {
                                this.notice = "Backup saved. It opens only with your passphrase.".into();
                            } else {
                                this.error = Some("The operation could not complete. Your current edits were not cleared. No plaintext fallback was saved.".into());
                            }
                            cx.notify();
                        })
                        .ok();
                    }
                })
                .detach();
            }
            Err(e) => this.error = Some(failure_copy(&e).into()),
        });
    }

    fn choose_backup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Restore".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let read = std::fs::metadata(&path)
                .ok()
                .filter(|m| m.len() as usize <= VAULT_BACKUP_MAX_CHARACTERS)
                .and_then(|_| std::fs::read(&path).ok());
            this.update(cx, |this, cx| {
                let parsed = read.as_deref().ok_or(VaultError::Backup).and_then(|b| vault_backup_text(b).map(str::to_string)).and_then(|t| {
                    parse_vault_backup(&t)?;
                    Ok(t)
                });
                match parsed {
                    Ok(text) => {
                        this.restore_file = Some((text, name));
                    }
                    Err(e) => this.error = Some(failure_copy(&e).into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn restore_backup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((text, _)) = self.restore_file.clone() else { return };
        let secret = Self::input_text(&self.restore_passphrase, cx);
        if secret.is_empty() {
            return;
        }
        let replace = self.has_vault == Some(true);
        let dirty = self.opened.as_ref().is_some_and(|d| d.dirty);
        let ask = if replace {
            Some(("Replace the vault on this device with this backup? Anything saved here that is not in the backup will be lost.", true))
        } else {
            None
        };
        let discard = !self.locked && dirty;
        cx.spawn_in(window, async move |this, cx| {
            if let Some((message, _)) = ask
                && !confirm(&this, cx, message).await
            {
                return;
            }
            if discard && !confirm(&this, cx, "Discard unsaved private edits? Save encrypted changes first to keep them.").await {
                return;
            }
            this.update_in(cx, move |this, window, cx| {
                this.clear_input(&this.restore_passphrase.clone(), window, cx);
                let was_locked = this.locked;
                this.run(
                    window,
                    cx,
                    move |repo, keeper| {
                        let result = repo.restore(&text, &secret, replace);
                        match &result {
                            // The replaced vault's Touch ID secret opens nothing now; delete it.
                            Ok(Some(old)) => {
                                let _ = keeper.remove(old);
                            }
                            Ok(None) => {}
                            Err(_) if was_locked => repo.lock(),
                            Err(_) => {}
                        }
                        result
                    },
                    |this, result, window, cx| match result {
                        Ok(_) => {
                            this.restore_file = None;
                            this.settings_open = false;
                            this.opened = None;
                            this.private_runs.clear();
                            this.enter_vault("Backup restored.", window, cx);
                        }
                        Err(e) => this.error = Some(failure_copy(&e).into()),
                    },
                );
            })
            .ok();
        })
        .detach();
    }

    /// The private list and count, from the store as it stands.
    fn refresh_private(&mut self) {
        let store = self.private.lock().unwrap_or_else(|p| p.into_inner());
        self.private_count = store.count();
        self.private_unlocked = store.is_unlocked();
        self.private_entries = if store.is_unlocked() { store.list().unwrap_or_default() } else { Vec::new() };
    }

    fn refresh_entries(&mut self) {
        if let Ok(list) = self.repo.lock().unwrap_or_else(|p| p.into_inner()).list("") {
            self.entries = list;
        }
    }

    /// `confirmItem`: with Touch ID on, every open, reveal or copy asks for a
    /// fresh check that names the item. Without Touch ID it is allowed.
    fn confirm_item(&mut self, action: &'static str, label: String, then: Pending, window: &mut Window, cx: &mut Context<Self>) {
        if !self.touch_id.enrolled {
            self.perform(then, window, cx);
            return;
        }
        let vault_id = self.repo.lock().ok().and_then(|r| r.vault_id()).unwrap_or_default();
        let keeper = self.keeper.clone();
        let check_label = label.clone();
        let task = cx.background_executor().spawn(async move { keeper.confirm(&vault_id, action, &check_label) });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, move |this, window, cx| {
                match result {
                    Ok(()) => this.perform(then, window, cx),
                    Err(DeviceFailure::Cancelled) => this.notice = format!("Touch ID was cancelled. {label} stays hidden."),
                    Err(DeviceFailure::Busy) => this.notice = "Touch ID is already waiting for you.".into(),
                    Err(_) => {
                        // When the sensor cannot be used right now, the passphrase stands in.
                        if this.locked {
                            return;
                        }
                        this.clear_input(&this.gate_passphrase.clone(), window, cx);
                        this.gate = Some((format!("Touch ID is not available right now. Enter your passphrase to {action} {label}."), then));
                        this.focus_next = Some(this.gate_passphrase.clone());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn submit_gate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let secret = Self::input_text(&self.gate_passphrase, cx);
        if secret.is_empty() || self.gate_busy || self.gate.is_none() {
            return;
        }
        self.clear_input(&self.gate_passphrase.clone(), window, cx);
        self.gate_busy = true;
        let repo = self.repo.clone();
        let task = cx.background_executor().spawn(async move { repo.lock().unwrap_or_else(|p| p.into_inner()).verify_passphrase(&secret) });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| {
                this.gate_busy = false;
                match result {
                    Ok(()) => {
                        if let Some((_, then)) = this.gate.take() {
                            this.perform(then, window, cx);
                        }
                    }
                    Err(e) if is_auth_failure(&e) => this.error = Some("That passphrase is not correct. The item stays hidden.".into()),
                    Err(_) => this.gate = None,
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn perform(&mut self, action: Pending, window: &mut Window, cx: &mut Context<Self>) {
        if self.locked {
            return;
        }
        match action {
            Pending::Open(entry) => self.read_entry(entry, window, cx),
            Pending::OpenPrivate(entry) => self.read_private(entry, window, cx),
            Pending::Reveal(ids) => {
                self.env.revealed.extend(ids);
                self.env.revealed_at = Some(Instant::now());
                self.sync_env_masks(window, cx);
            }
            Pending::RevealRaw => {
                self.env.raw = true;
                let text = self.opened.as_ref().and_then(|d| d.text().map(str::to_string)).unwrap_or_default();
                self.set_editor_text(&self.raw_editor.clone(), &text, window, cx);
            }
            Pending::Copy { value, label, row } => match self.clipboard.copy(&value) {
                Ok(_) => {
                    self.notice.clear();
                    self.copied = Some(CopyFeedback { label, row, at: Instant::now() });
                }
                Err(_) => self.error = Some("Clipboard access is unavailable. Nothing was copied.".into()),
            },
        }
        cx.notify();
    }

    fn choose(&mut self, entry: VaultEntry, window: &mut Window, cx: &mut Context<Self>) {
        let dirty = self.opened.as_ref().is_some_and(|d| d.dirty);
        cx.spawn_in(window, async move |this, cx| {
            if dirty && !confirm(&this, cx, "Discard unsaved private edits? Save encrypted changes first to keep them.").await {
                return;
            }
            this.update_in(cx, move |this, window, cx| {
                // An env file opens masked; its editor asks again per value. Anything else asks now.
                if dotenv::is_env_file_name(&entry.name) {
                    this.read_entry(entry, window, cx);
                } else {
                    let label = entry.name.clone();
                    this.confirm_item("open", label, Pending::Open(entry), window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn read_entry(&mut self, entry: VaultEntry, window: &mut Window, cx: &mut Context<Self>) {
        let id = entry.id.clone();
        let previous = self.opened.as_ref().and_then(|d| d.id.clone()).filter(|p| *p != id);
        self.run(
            window,
            cx,
            move |repo, _| {
                if let Some(prev) = previous {
                    let _ = repo.discard_recovery(&prev);
                }
                repo.read(&id).map(|read| SecureDoc::from_read(
                    Some(id), read.document.metadata.name, read.document.metadata.media_type,
                    read.document.bytes, read.recovery,
                ))
            },
            |this, result, window, cx| match result {
                Ok(doc) => {
                    let dirty = doc.dirty;
                    this.show_doc(doc, window, cx);
                    this.settings_open = false;
                    this.notice = if dirty {
                        "Recovered unsaved encrypted edits. Save encrypted changes to make them durable.".into()
                    } else {
                        String::new()
                    };
                }
                Err(e) => this.error = Some(failure_copy(&e).into()),
            },
        );
    }

    fn set_editor_text(&mut self, editor: &Entity<EditorState>, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.writing = true;
        let text = text.to_string();
        editor.update(cx, |s, cx| s.set_value(text, window, cx));
        self.writing = false;
    }

    fn show_doc(&mut self, doc: SecureDoc, window: &mut Window, cx: &mut Context<Self>) {
        self.writing = true;
        let name = doc.name.clone();
        self.filename.update(cx, |s, cx| s.set_value(name, window, cx));
        self.writing = false;
        let text = doc.text().unwrap_or("").to_string();
        let read_only = matches!(doc.body, Body::Text { newline: Newline::Mixed, .. });
        self.text_editor.update(cx, |s, cx| s.set_readonly(read_only, cx));
        self.set_editor_text(&self.text_editor.clone(), &text, window, cx);
        self.env = EnvView::default();
        self.private_runs.clear();
        if let Body::Docx(office) = &doc.body {
            for (paragraph, p) in office.paragraphs.iter().enumerate() {
                for (run, r) in p.runs.iter().enumerate() {
                    let id = r.id.clone();
                    let read_only = !office.can_edit || !r.can_edit;
                    let input = cx.new(|cx| InputState::new(window, cx).default_value(r.text.clone()));
                    let change = cx.subscribe_in(&input, window, move |this: &mut Self, input, event: &InputEvent, window, cx| {
                        if !matches!(event, InputEvent::Change) || this.writing || this.busy || this.shielded || read_only {
                            return;
                        }
                        let Some(doc) = this.opened.as_mut() else { return };
                        let value = input.read(cx).value().to_string();
                        if doc.edit_docx_run(&id, value).is_err() {
                            this.error = Some("This document edit is unsupported. The original encrypted copy was not changed.".into());
                            if let Body::Docx(office) = &doc.body
                                && let Some(run) = office.paragraphs.iter().flat_map(|p| &p.runs).find(|run| run.id == id)
                            {
                                let saved = run.text.clone();
                                this.writing = true;
                                input.update(cx, |input, cx| input.set_value(saved, window, cx));
                                this.writing = false;
                            }
                        }
                        cx.notify();
                    });
                    self.private_runs.push(PrivateRun {
                        label: format!("Private paragraph {}, run {}", paragraph + 1, run + 1),
                        read_only,
                        input,
                        _change: change,
                    });
                }
            }
        }
        self.opened = Some(doc);
        self.rebuild_env(window, cx);
    }

    /// A typed change to the body, from the plain editor or the env Raw view.
    fn set_body_text(&mut self, value: String, cx: &mut Context<Self>) {
        let Some(doc) = self.opened.as_mut() else { return };
        let Body::Text { text, newline, .. } = &mut doc.body else { return };
        let next = normalize_typed_newlines(&value, *newline);
        if *text == next {
            return;
        }
        *text = next;
        doc.dirty = true;
        // The rows are rebuilt from the new text at the next render, masked again.
        self.pending_text = Some(String::new());
        cx.notify();
    }

    /// Parse the env text and make one key and one value input per entry.
    fn rebuild_env(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.opened.as_ref().filter(|d| d.is_env()) else { return };
        let text = doc.text().unwrap_or("").to_string();
        let parsed = dotenv::parse_dotenv(&text);
        self.env.revealed.clear();
        self.env_rows(&parsed, window, cx);
        self.env.text = text;
        self.env.parsed = Some(parsed);
    }

    /// The key and value fields for every entry of `parsed`, as it stands:
    /// vault-env-editor.tsx edits its document model and never re-reads its
    /// own text, so a row Add key makes (`=` with no name, which a fresh
    /// parse calls unreadable) stays an editable row saying "Add a key name."
    fn env_rows(&mut self, parsed: &DotenvDocument, window: &mut Window, cx: &mut Context<Self>) {
        self.env.rows.clear();
        self.writing = true;
        for line in &parsed.lines {
            if let LineKind::Entry(e) = &line.kind {
                let id = line.id;
                let key = cx.new(|cx| InputState::new(window, cx).default_value(e.key.clone()));
                let key_sub = cx.subscribe(&key, move |this, state, ev: &InputEvent, cx| {
                        if matches!(ev, InputEvent::Change) && !this.writing {
                            let k = state.read(cx).value().to_string();
                            this.commit_env(|doc| dotenv::update_dotenv_entry(doc, id, Some(&k), None), cx);
                        }
                });
                let (value, value_sub) = if e.value.contains(['\n', '\r']) {
                    let editor = cx.new(|cx| EditorState::new(window, cx).language("text").line_number(false).soft_wrap(true));
                    let sub = cx.subscribe(&editor, move |this, state, ev: &InputEvent, cx| {
                        if matches!(ev, InputEvent::Change) && !this.writing
                            && !this.busy && this.env.revealed.contains(&id)
                        {
                            let value = state.read(cx).value().to_string();
                            this.commit_env(|doc| dotenv::update_dotenv_entry(doc, id, None, Some(&value)), cx);
                        }
                    });
                    (EnvValue::Multi(editor), sub)
                } else {
                    let input = cx.new(|cx| InputState::new(window, cx).masked(true).default_value(e.value.clone()));
                    let sub = cx.subscribe(&input, move |this, state, ev: &InputEvent, cx| {
                        if matches!(ev, InputEvent::Change) && !this.writing {
                            let v = state.read(cx).value().to_string();
                            this.commit_env(|doc| dotenv::update_dotenv_entry(doc, id, None, Some(&v)), cx);
                        }
                    });
                    (EnvValue::Single(input), sub)
                };
                self.env.rows.insert(id, EnvRow { key, value, _subs: [key_sub, value_sub] });
            }
        }
        self.writing = false;
        self.sync_env_masks(window, cx);
    }

    fn commit_env(&mut self, edit: impl FnOnce(&DotenvDocument) -> DotenvDocument, cx: &mut Context<Self>) {
        let Some(parsed) = self.env.parsed.as_ref() else { return };
        let next = edit(parsed);
        let text = dotenv::serialize_dotenv(&next);
        self.env.text = text.clone();
        self.env.parsed = Some(next);
        if let Some(doc) = self.opened.as_mut()
            && let Body::Text { text: body, .. } = &mut doc.body
        {
            *body = text;
            doc.dirty = true;
        }
        cx.notify();
    }

    fn sync_env_masks(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.writing = true;
        for (id, row) in &self.env.rows {
            let shown = self.env.revealed.contains(id);
            match &row.value {
                EnvValue::Single(input) => input.update(cx, |s, cx| s.set_masked(!shown, window, cx)),
                EnvValue::Multi(editor) => {
                    let visible = shown.then(|| self.env.parsed.as_ref()?.lines.iter().find_map(|line| {
                        if line.id == *id && let LineKind::Entry(entry) = &line.kind { Some(entry.value.clone()) } else { None }
                    })).flatten().unwrap_or_default();
                    editor.update(cx, |state, cx| state.set_value(visible, window, cx));
                }
            }
        }
        self.writing = false;
    }

    fn create_untitled(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let dirty = self.opened.as_ref().is_some_and(|d| d.dirty);
        let name = name.to_string();
        cx.spawn_in(window, async move |this, cx| {
            if dirty && !confirm(&this, cx, "Discard unsaved private edits? Save encrypted changes first to keep them.").await {
                return;
            }
            this.update_in(cx, move |this, window, cx| {
                this.settings_open = false;
                let media = if dotenv::is_env_file_name(&name) { ENV_MEDIA_TYPE } else { "text/plain" };
                let doc = SecureDoc {
                    id: None,
                    original_name: name.clone(),
                    name,
                    media_type: media.into(),
                    bytes: zeroize::Zeroizing::new(Vec::new()),
                    dirty: true,
                    body: Body::Text { text: String::new(), encoding: TextEncoding::Utf8, bom: false, newline: Newline::None },
                    private: None,
                };
                this.show_doc(doc, window, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn import_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let dirty = self.opened.as_ref().is_some_and(|d| d.dirty);
        cx.spawn_in(window, async move |this, cx| {
            if dirty && !confirm(&this, cx, "Discard unsaved private edits? Save encrypted changes first to keep them.").await {
                return;
            }
            let Ok(rx) = this.update(cx, |_, cx| {
                cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Import".into()) })
            }) else {
                return;
            };
            let Ok(Ok(Some(paths))) = rx.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            this.update_in(cx, move |this, window, cx| {
                let too_big = std::fs::metadata(&path).map(|m| m.len() as usize > limits::CONTENT_BYTES).unwrap_or(false);
                if too_big {
                    this.error = Some(failure_copy(&VaultError::Vault(VaultErrorCode::LimitExceeded)).into());
                    cx.notify();
                    return;
                }
                let Ok(bytes) = std::fs::read(&path).map(zeroize::Zeroizing::new) else {
                    this.error = Some("The operation could not complete. Your current edits were not cleared. No plaintext fallback was saved.".into());
                    cx.notify();
                    return;
                };
                let media = if dotenv::is_env_file_name(&name) { ENV_MEDIA_TYPE.to_string() } else { formats::classify(&name).mime_type().to_string() };
                let meta = VaultDocumentMetadata { name: name.clone(), media_type: media };
                this.run(
                    window,
                    cx,
                    move |repo, _| {
                        let id = repo.save(None, &bytes, &meta)?;
                        repo.read(&id).map(|r| (id, r))
                    },
                    |this, result, window, cx| match result {
                        Ok((id, read)) => {
                            let doc = SecureDoc::from_read(Some(id), read.document.metadata.name.clone(), read.document.metadata.media_type.clone(), read.document.bytes, read.recovery);
                            this.show_doc(doc, window, cx);
                            this.settings_open = false;
                            this.refresh_entries();
                            this.notice = "Encrypted copy saved. The original file still exists outside the vault.".into();
                        }
                        Err(e) => this.error = Some(failure_copy(&e).into()),
                    },
                );
            })
            .ok();
        })
        .detach();
    }

    pub fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.opened.as_ref() else { return };
        if self.busy || self.shielded {
            return;
        }
        if !valid_filename(&doc.original_name, &doc.name) {
            self.error = Some("Choose a filename with the original file type. Changing extensions needs conversion.".into());
            cx.notify();
            return;
        }
        let id = doc.id.clone();
        let bytes = match doc.current_bytes() {
            Ok(bytes) => bytes,
            Err(e) => { self.error = Some(failure_copy(&e).into()); cx.notify(); return; }
        };
        if let (Some(id), Some(meta)) = (id.clone(), doc.private_metadata(&doc.name)) {
            return self.save_private(id, bytes, meta, window, cx);
        }
        let meta = VaultDocumentMetadata { name: doc.name.clone(), media_type: doc.media_type.clone() };
        self.run(
            window,
            cx,
            move |repo, _| repo.save(id.as_deref(), &bytes, &meta).map(|id| (id, bytes)),
            |this, result, _, _| match result {
                Ok((id, bytes)) => {
                    if let Some(doc) = this.opened.as_mut() {
                        doc.id = Some(id);
                        doc.original_name = doc.name.clone();
                        doc.bytes = bytes;
                        doc.dirty = false;
                    }
                    this.refresh_entries();
                    this.notice = "Encrypted changes saved.".into();
                }
                Err(e) => {
                    if let VaultError::Save { document_id, .. } = &e
                        && let Some(doc) = this.opened.as_mut()
                    {
                        doc.id = Some(document_id.clone());
                    }
                    this.error = Some(failure_copy(&e).into());
                }
            },
        );
    }

    fn export_decrypted(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.opened.as_ref() else { return };
        if !valid_filename(&doc.original_name, &doc.name) {
            self.error = Some("Choose a filename with the original file type before exporting.".into());
            cx.notify();
            return;
        }
        let bytes = match doc.current_bytes() {
            Ok(bytes) => bytes,
            Err(e) => { self.error = Some(failure_copy(&e).into()); cx.notify(); return; }
        };
        let name = safe_file_name(&doc.name);
        cx.spawn_in(window, async move |this, cx| {
            if !confirm(&this, cx, "Save an unencrypted copy? That copy is outside the vault and is not protected by its passphrase.").await {
                return;
            }
            let dir = dirs::download_dir().unwrap_or_else(markie_core::paths::home_dir);
            let Ok(rx) = this.update(cx, |_, cx| cx.prompt_for_new_path(&dir, Some(&name))) else { return };
            let Ok(Ok(Some(path))) = rx.await else { return };
            let ok = std::fs::write(&path, &*bytes).is_ok();
            this.update(cx, |this, cx| {
                if ok {
                    this.notice = "Unencrypted copy saved. Saved copies and clipboard copies are outside the vault; unsaved edits stay unsaved.".into();
                } else {
                    this.error = Some("The operation could not complete. Your current edits were not cleared. No plaintext fallback was saved.".into());
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn delete_opened(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.opened.as_ref().is_some_and(|d| d.private.is_some()) {
            return self.delete_private(window, cx);
        }
        let Some(id) = self.opened.as_ref().and_then(|d| d.id.clone()) else { return };
        cx.spawn_in(window, async move |this, cx| {
            if !confirm(&this, cx, "Delete this encrypted copy and any unsaved edits? The original imported file is not deleted.").await {
                return;
            }
            this.update_in(cx, move |this, window, cx| {
                this.run(window, cx, move |repo, _| repo.remove(&id), |this, result, _, _| match result {
                    Ok(()) => {
                        this.opened = None;
                        this.private_runs.clear();
                        this.env = EnvView::default();
                        this.refresh_entries();
                        this.notice = "Encrypted copy deleted from this vault. External copies and backups are not erased.".into();
                    }
                    Err(e) => this.error = Some(failure_copy(&e).into()),
                });
            })
            .ok();
        })
        .detach();
    }

    /// Idle lock: five minutes without a click or key in the vault. The open
    /// item is checkpointed first, for at most two seconds.
    fn start_idle_timer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._idle = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let Ok(()) = this.update_in(cx, |this, window, cx| {
                    if let Some(at) = this.env.revealed_at
                        && at.elapsed() >= REVEAL_REMASK
                    {
                        this.env.revealed.clear();
                        this.env.revealed_at = None;
                        this.sync_env_masks(window, cx);
                        cx.notify();
                    }
                    if let Some(copied) = &this.copied {
                        if copied.remaining(Instant::now(), CLEAR_AFTER).is_none() {
                            this.copied = None;
                        }
                        cx.notify();
                    }
                    this.maybe_auto_lock(false, window, cx);
                }) else {
                    break;
                };
            }
        });
    }

    fn maybe_auto_lock(&mut self, hidden: bool, window: &mut Window, cx: &mut Context<Self>) {
        if should_auto_lock(self.locked, self.shielded, hidden, self.last_activity.elapsed()) {
            self.automatic_lock(window, cx);
        }
    }

    fn automatic_lock(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shielded = true;
        self.operation += 1;
        let ticket = self.operation;
        self.busy = true;
        self.clear_secret_inputs(window, cx);
        cx.notify();
        let checkpoint = self.opened.as_ref().filter(|d| d.dirty).map(|d| {
            let name = if valid_filename(&d.original_name, &d.name) { d.name.clone() } else { d.original_name.clone() };
            (d.id.clone(), d.current_bytes(), d.private_metadata(&name), VaultDocumentMetadata { name, media_type: d.media_type.clone() })
        });
        let repo = self.repo.clone();
        let private = self.private.clone();
        let save = cx.background_executor().spawn(async move {
            match checkpoint {
                // A private file checkpoints into the private store, encrypted.
                Some((Some(id), bytes, Some(private_meta), _)) => {
                    let bytes = bytes?;
                    private.lock().unwrap_or_else(|p| p.into_inner()).replace(&id, &bytes, &private_meta)
                }
                Some((id, bytes, _, meta)) => {
                    let bytes = bytes?;
                    repo.lock().unwrap_or_else(|p| p.into_inner()).save(id.as_deref(), &bytes, &meta).map(|_| ())
                }
                None => Ok(()),
            }
        });
        let timer = cx.background_executor().timer(CHECKPOINT);
        cx.spawn_in(window, async move |this, cx| {
            use futures::FutureExt as _;
            let outcome = futures::select! {
                r = save.fuse() => Some(r),
                _ = timer.fuse() => None,
            };
            this.update_in(cx, |this, window, cx| {
                if ticket != this.operation {
                    return;
                }
                let recovery = this.repo.try_lock().map(|r| r.has_volatile_recovery()).unwrap_or(false);
                let message = match outcome {
                    None => "Locked after the checkpoint time limit. The last saved copy is retained; check encrypted recovery after unlocking.",
                    Some(Ok(())) => "Automatically locked. Encrypted changes were checkpointed before releasing the key.",
                    Some(Err(_)) if recovery => "Locked. Latest edits are encrypted in memory only; unlock and save again before closing this window.",
                    Some(Err(_)) => "Locked. The latest checkpoint failed; the last durable saved copy remains.",
                };
                this.lock_now(message, window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn cancel_restore(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.restore_file = None;
        self.notice.clear();
        self.clear_input(&self.restore_passphrase.clone(), window, cx);
        cx.notify();
    }

    fn cancel_enroll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.enrolling = false;
        self.clear_input(&self.enroll_passphrase.clone(), window, cx);
        cx.notify();
    }

    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings_open = false;
        self.notice.clear();
        self.cancel_enroll(window, cx);
    }

    fn clear_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clear_input(&self.query.clone(), window, cx);
        cx.notify();
    }

    /// ⌘S, ⌘F and Escape on the page. True when the key was used.
    fn handle_shortcut(&mut self, action: Shortcut, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let unlocked = !self.locked && !self.shielded;
        match action {
            Shortcut::Save if unlocked => {
                self.save(window, cx);
                true
            }
            Shortcut::Search if unlocked && shows_search(self.entries.len()) => {
                self.settings_open = false;
                self.query.update(cx, |s, cx| s.focus(window, cx));
                cx.notify();
                true
            }
            Shortcut::Escape if self.request.is_some() && !self.busy && !(unlocked && self.gate.is_some()) => {
                self.cancel_request(cx);
                true
            }
            Shortcut::Escape => {
                let state = EscapeState {
                    gate: unlocked && self.gate.is_some() && !self.gate_busy,
                    restore: self.restore_file.is_some() && !self.busy,
                    enrolling: unlocked && self.enrolling && !self.busy,
                    settings: unlocked && self.settings_open,
                    query: unlocked && !self.query.read(cx).value().is_empty(),
                    error: self.error.is_some(),
                };
                let Some(target) = escape_target(&state) else { return false };
                match target {
                    Escape::Gate => self.gate = None,
                    Escape::Restore => self.cancel_restore(window, cx),
                    Escape::Enroll => self.cancel_enroll(window, cx),
                    Escape::Error => self.error = None,
                    Escape::Settings => self.close_settings(window, cx),
                    Escape::Search => self.clear_search(window, cx),
                }
                cx.notify();
                true
            }
            _ => false,
        }
    }

    fn dismiss_touch_id_offer(&mut self, cx: &mut Context<Self>) {
        self.offer_touch_id = false;
        let _ = std::fs::write(markie_core::paths::data_dir().join(TOUCH_ID_OFFER_FILE), "dismissed");
        cx.notify();
    }

    fn touched(&mut self) {
        self.last_activity = Instant::now();
    }
}

/// `window.confirm`, as a native sheet.
async fn confirm(this: &WeakEntity<VaultPage>, cx: &mut AsyncWindowContext, message: &'static str) -> bool {
    let Ok(rx) = this.update_in(cx, |_, window, cx| window.prompt(PromptLevel::Warning, message, None, &["OK", "Cancel"], cx)) else {
        return false;
    };
    rx.await.ok() == Some(0)
}

#[cfg(test)]
fn group_digits(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

impl Render for VaultPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(submit) = self.pending_submit.take() {
            match submit {
                Submit::Authenticate => self.authenticate(window, cx),
                Submit::Enroll => self.enroll_touch_id(window, cx),
                Submit::Restore => self.restore_backup(window, cx),
                Submit::Gate => self.submit_gate(window, cx),
                Submit::Private => self.submit_private_passphrase(window, cx),
            }
        }
        if self.pending_text.take().is_some() && self.opened.as_ref().is_some_and(|d| d.is_env()) && !self.env.raw {
            self.rebuild_env(window, cx);
        }
        if let Some(input) = self.focus_next.take() {
            input.update(cx, |s, cx| s.focus(window, cx));
        }
        self.render_page(window, cx)
    }
}

// ── Workspace hooks ──

impl Workspace {
    /// Show the vault page in the document area: the window shell's Vault view.
    pub fn open_vault(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.vault_open() {
            self.select_view(super::rail::LeftView::Vault, cx);
        }
        self.sync_vault(window, cx);
    }

    pub fn vault_open(&self) -> bool {
        self.workspace_page_open() && self.shell.view == super::rail::LeftView::Vault
    }

    /// Make the page the first time the Vault view shows. Leaving the view
    /// locks the vault, as Electron's close guard does, unless edits are
    /// unsaved: those stay, and the idle lock still applies.
    pub(super) fn sync_vault(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.vault_open() {
            if self.vault.is_none() {
                let page = cx.new(|cx| VaultPage::new(window, cx));
                self.vault_events = Some(cx.subscribe_in(&page, window, |this, _, event: &VaultEvent, window, cx| this.on_vault_event(event, window, cx)));
                self.vault = Some(page);
            }
        } else if let Some(page) = self.vault.clone()
            && !page.read(cx).is_locked()
            && !page.read(cx).has_unsaved()
        {
            page.update(cx, |p, cx| p.lock_now("", window, cx));
        }
    }

    /// Leave the vault page. Unsaved edits ask first; leaving locks the vault.
    pub fn close_vault(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.vault_open() {
            return;
        }
        let unsaved = self.vault.as_ref().is_some_and(|p| p.read(cx).has_unsaved());
        let page = self.vault.clone();
        cx.spawn_in(window, async move |this, cx| {
            if unsaved {
                let Ok(rx) = this.update_in(cx, |_, window, cx| {
                    window.prompt(
                        PromptLevel::Warning,
                        "Leave the vault and discard unsaved edits or encrypted memory-only recovery? Save encrypted changes first to keep them.",
                        None,
                        &["Leave", "Cancel"],
                        cx,
                    )
                }) else {
                    return;
                };
                if rx.await.ok() != Some(0) {
                    return;
                }
            }
            this.update_in(cx, |this, window, cx| {
                if let Some(page) = page {
                    page.update(cx, |p, cx| p.lock_now("", window, cx));
                }
                this.select_view(super::rail::LeftView::Library, cx);
            })
            .ok();
        })
        .detach();
    }

    /// File › Make Private… and the other ways in: the open document, or `path`.
    pub(super) fn make_private_path(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if !path.is_file() {
            window.push_notification("Only a file on this Mac can be made private.", cx);
            return;
        }
        let cloud = self.cloud.bindings.get(&path).is_some_and(|b| b.record.cloud_doc_id.is_some()) || self.cloud.remote(&path).is_some_and(|r| r.shared);
        // The open document saves first, so the private copy has every edit and
        // no later autosave can write the file back.
        if self.file_path().as_deref() == Some(path.as_path()) && self.dirty {
            self.save(window, cx);
        }
        self.open_vault(window, cx);
        if let Some(page) = self.vault.clone() {
            page.update(cx, |page, cx| page.request_make_private(PrivateRequest { path, cloud }, window, cx));
        }
        cx.notify();
    }

    pub(super) fn on_make_private(&mut self, _: &crate::actions::MakePrivate, window: &mut Window, cx: &mut Context<Self>) {
        match self.file_path() {
            Some(path) => self.make_private_path(path, window, cx),
            None => window.push_notification("Open a file first, then make it private.", cx),
        }
    }

    fn on_vault_event(&mut self, event: &VaultEvent, _window: &mut Window, cx: &mut Context<Self>) {
        match event {
            VaultEvent::MadePrivate(path) => self.made_private(path, cx),
            VaultEvent::Restored(path) => {
                // A normal file again: it shows in Recents like any opened file.
                if let Some(registry) = &self.registry {
                    let _ = registry.track_opened(path);
                }
                self.refresh_lists(cx);
                self.rescan(cx);
            }
        }
    }

    /// The file is private now: every copy this window holds goes, on disk
    /// (`purge_local_copies`) and in memory (the open document, its preview,
    /// its cloud binding, a recovered draft).
    pub(super) fn made_private(&mut self, path: &std::path::Path, cx: &mut Context<Self>) {
        if self.doc.as_ref().is_some_and(|d| d.path == path) {
            self.autosave.cancel();
            self.doc = None;
            self.dirty = false;
            self.versions.clear();
        }
        self.disk.forget(path);
        private_files::purge_local_copies(&markie_core::paths::data_dir(), path, self.registry.as_deref());
        self.shell.previews.forget(&path.to_string_lossy());
        self.cloud.bindings.remove(path);
        self.recovered.retain(|d| d.meta.path.as_deref() != Some(&*path.to_string_lossy()));
        self.shell.row_menu = None;
        self.refresh_lists(cx);
        self.rescan(cx);
        cx.notify();
    }

    pub(super) fn on_toggle_vault(&mut self, _: &ToggleVault, window: &mut Window, cx: &mut Context<Self>) {
        if self.vault_open() { self.close_vault(window, cx) } else { self.open_vault(window, cx) }
    }

    /// The vault page when the Vault view shows, for the document area.
    pub(super) fn render_vault(&self) -> Option<AnyElement> {
        if !self.vault_open() {
            return None;
        }
        self.vault.clone().map(|v| v.into_any_element())
    }
}

actions!(markie_vault_page, [ToggleVault]);

// ── Scenes (`--features scene`, docs/rust-port/SCREEN.md) ──

/// The scratch passphrase every vault scene uses. Synthetic, never a real one.
#[cfg(feature = "scene")]
const SCENE_PASSPHRASE: &str = "synthetic scene passphrase only";

#[cfg(feature = "scene")]
impl VaultPage {
    /// Synthetic items: two env files, notes and an opaque file.
    fn scene_items(state: &str) -> Vec<(&'static str, &'static str, Vec<u8>)> {
        let mut items = vec![
            ("production.env", ENV_MEDIA_TYPE, b"# Payments\nSTRIPE_SECRET_KEY=sk_test_fixture_0000000000\nDATABASE_URL=postgres://app:fixture@localhost:5432/app\n# OLD_TOKEN=retired_fixture_value\nSENTRY_DSN=https://fixture@example.invalid/1\n".to_vec()),
            ("Server notes.txt", "text/plain", b"Staging box: ssh deploy@staging.example.invalid\nRotate the API keys every quarter.\nBackup codes are in Recovery codes.txt.\n".to_vec()),
            ("Recovery codes.txt", "text/plain", b"1. 4821-0093\n2. 7710-5521\n3. 0098-1123\n".to_vec()),
        ];
        if state != "few" {
            items.extend([
                ("staging.env", ENV_MEDIA_TYPE, b"API_URL=https://staging.example.invalid\nAPI_TOKEN=fixture_staging_token\n".to_vec()),
                ("local.env", ENV_MEDIA_TYPE, b"PORT=3000\nDEBUG=true\n".to_vec()),
                ("Wi-Fi.txt", "text/plain", b"Office: fixture-network / fixture-password\n".to_vec()),
                ("signed-lease.pdf", "application/pdf", b"%PDF-1.4\n% synthetic fixture, not a real document\n".to_vec()),
            ]);
        }
        items
    }

    /// Synthetic files for the private-file scenes, in the scratch home's
    /// Documents/Plans. Made up; never anyone's real file.
    fn scene_private_files() -> Vec<(&'static str, Vec<u8>)> {
        let docx = export_rich_document(&markie_office::rich_document::create_rich_document(Format::Docx, "Offer letter for a fixture candidate. Salary: 0000.").unwrap()).unwrap();
        vec![
            ("Launch plan.md", b"# Launch plan\n\nA synthetic plan for the scene. Ship the fixture on Day 0.\n\n- Draft the notes\n- Review with the fixture team\n".to_vec()),
            ("Offer letter.docx", docx),
            ("Passport scan.pdf", b"%PDF-1.4\n% synthetic fixture, not a real document\n".to_vec()),
            ("Ideas.txt", b"Fixture ideas only.\n".to_vec()),
        ]
    }

    fn scene_plans_dir() -> PathBuf {
        markie_core::paths::home_dir().join("Documents").join("Plans")
    }

    /// The file a Make Private scene asks about.
    fn scene_request(args: &serde_json::Value) -> PrivateRequest {
        let dir = Self::scene_plans_dir();
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("Board notes.md");
        let _ = std::fs::write(&path, b"# Board notes\n\nSynthetic notes for a scene.\n");
        PrivateRequest { path, cloud: args.get("cloud").and_then(serde_json::Value::as_bool).unwrap_or(false) }
    }

    /// One step of a vault scene. `stage` counts the steps already done.
    /// Args: `state` (see `scene_states`), `touch_id` (bool).
    pub fn scene_step(&mut self, args: &serde_json::Value, stage: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let state = args.get("state").and_then(serde_json::Value::as_str).unwrap_or("locked").to_string();
        let touch = args.get("touch_id").and_then(serde_json::Value::as_bool).unwrap_or(false)
            || matches!(state.as_str(), "locked-touch" | "settings-touch" | "gate" | "private-passphrase" | "private-locked-list");
        let private_scene = state.starts_with("private-");
        let with_private_files = matches!(state.as_str(), "private-items" | "private-open" | "private-locked-list" | "private-done");
        let with_request = matches!(state.as_str(), "private-create" | "private-unlock" | "private-sheet" | "private-passphrase" | "private-done");
        if *stage >= 9 {
            return true;
        }
        if self.busy && *stage != 2 {
            return false;
        }
        match *stage {
            0 => {
                if self.has_vault.is_none() {
                    return false;
                }
                let fresh = matches!(state.as_str(), "none" | "create" | "create-error" | "private-create");
                if !fresh {
                    let empty = state == "empty" || (private_scene && !with_private_files && state != "private-done");
                    let mut repo = self.repo.lock().unwrap_or_else(|p| p.into_inner());
                    repo.create(SCENE_PASSPHRASE).expect("scene vault");
                    if !empty {
                        for (name, media, bytes) in Self::scene_items(&state) {
                            repo.save(None, &bytes, &VaultDocumentMetadata { name: name.into(), media_type: media.into() }).expect("scene item");
                        }
                    }
                    if touch {
                        repo.enroll_device(SCENE_PASSPHRASE, &*self.keeper as &dyn DeviceKeeper).expect("scene Touch ID");
                    }
                    repo.lock();
                    drop(repo);
                    if with_private_files {
                        let mut store = self.private.lock().unwrap_or_else(|p| p.into_inner());
                        store.unlock_or_create(SCENE_PASSPHRASE).expect("scene private store");
                        let dir = Self::scene_plans_dir();
                        std::fs::create_dir_all(&dir).expect("scene plans folder");
                        for (name, bytes) in Self::scene_private_files() {
                            let path = dir.join(name);
                            std::fs::write(&path, bytes).expect("scene private file");
                            private_files::make_private(&store, &path, 1_764_000_000_000).map_err(|r| r.copy()).expect("scene make private");
                        }
                        store.lock();
                    }
                    self.has_vault = Some(true);
                    self.notice.clear();
                    self.refresh_touch_id(window, cx);
                }
                *stage = 1;
                false
            }
            1 => {
                let typed = |this: &mut Self, input: Entity<InputState>, text: &str, window: &mut Window, cx: &mut Context<Self>| {
                    this.writing = true;
                    input.update(cx, |s, cx| s.set_value(text.to_string(), window, cx));
                    this.writing = false;
                };
                match state.as_str() {
                    "none" | "locked" | "locked-touch" | "private-create" | "private-unlock" => {}
                    "create" => self.suggest(window, cx),
                    "create-error" => {
                        typed(self, self.passphrase.clone(), "correct horse battery", window, cx);
                        typed(self, self.confirmation.clone(), "correct horse batery", window, cx);
                        self.authenticate(window, cx);
                    }
                    "locked-error" => {
                        typed(self, self.passphrase.clone(), "not the right passphrase", window, cx);
                        self.authenticate(window, cx);
                    }
                    "unlocking" => {
                        typed(self, self.passphrase.clone(), SCENE_PASSPHRASE, window, cx);
                        // Held busy, as it is while the key is derived.
                        self.busy = true;
                        *stage = 9;
                        return false;
                    }
                    _ => {
                        typed(self, self.passphrase.clone(), SCENE_PASSPHRASE, window, cx);
                        self.authenticate(window, cx);
                    }
                }
                *stage = 2;
                false
            }
            2 => {
                if self.busy {
                    return false;
                }
                let open = |this: &mut Self, name: &str, window: &mut Window, cx: &mut Context<Self>| {
                    if let Some(entry) = this.entries.iter().find(|e| e.name == name).cloned() {
                        this.read_entry(entry, window, cx);
                    }
                };
                if with_request {
                    self.request_make_private(Self::scene_request(args), window, cx);
                }
                if matches!(state.as_str(), "private-passphrase" | "private-locked-list") {
                    // As after a Touch ID unlock: the vault is open, private files are not.
                    self.private.lock().unwrap_or_else(|p| p.into_inner()).lock();
                    self.refresh_private();
                    self.clear_input(&self.private_passphrase.clone(), window, cx);
                }
                match state.as_str() {
                    "private-done" => self.confirm_make_private(window, cx),
                    "private-open" => {
                        if let Some(entry) = self.private_entries.iter().find(|e| e.metadata.name == "Launch plan.md").cloned() {
                            self.read_private(entry, window, cx);
                        }
                    }
                    "note" => open(self, "Server notes.txt", window, cx),
                    "env" | "env-copied" | "env-revealed" | "gate" => open(self, "production.env", window, cx),
                    "file" => open(self, "signed-lease.pdf", window, cx),
                    "settings" | "settings-touch" => self.settings_open = true,
                    "restore" => {
                        let backup = self.repo.lock().unwrap_or_else(|p| p.into_inner()).backup().expect("scene backup");
                        self.settings_open = true;
                        self.restore_file = Some((backup, VAULT_BACKUP_FILE_NAME.to_string()));
                    }
                    "search" => {
                        self.writing = true;
                        self.query.update(cx, |s, cx| s.set_value("env", window, cx));
                        self.writing = false;
                    }
                    _ => {}
                }
                *stage = 3;
                false
            }
            3 => {
                if self.busy {
                    return false;
                }
                let first_key = || self.env.parsed.as_ref().and_then(|p| p.lines.iter().find(|l| matches!(l.kind, LineKind::Entry(_))).map(|l| (l.id, match &l.kind { LineKind::Entry(e) => (e.key.clone(), e.value.clone()), _ => unreachable!() })));
                match state.as_str() {
                    "env-revealed" => {
                        if let Some((id, _)) = first_key() {
                            self.perform(Pending::Reveal(vec![id]), window, cx);
                        }
                    }
                    "env-copied" => {
                        if let Some((_, (key, value))) = first_key() {
                            let row = self.env.parsed.as_ref().and_then(|p| p.lines.iter().find(|l| matches!(&l.kind, LineKind::Entry(e) if e.key == key)).map(|l| l.id));
                            self.perform(Pending::Copy { value: zeroize::Zeroizing::new(value), label: key, row }, window, cx);
                        }
                    }
                    "gate" => {
                        let label = self.opened.as_ref().map(|d| d.name.clone()).unwrap_or_default();
                        self.gate = Some((format!("Touch ID is not available right now. Enter your passphrase to reveal {label}."), Pending::RevealRaw));
                    }
                    _ => {}
                }
                *stage = 4;
                false
            }
            _ => true,
        }
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// The vault page in a named state, reached through the page's own calls.
    pub(super) fn scene_vault(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if *step == 0 {
            self.open_vault(window, cx);
            *step = 1;
            return false;
        }
        let Some(page) = self.vault.clone() else { return false };
        let mut stage = *step - 1;
        let done = page.update(cx, |p, cx| p.scene_step(args, &mut stage, window, cx));
        *step = stage + 1;
        done
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `gpui_kit::*` brings GPUI's own `test` attribute; tests here are plain.
    use ::core::prelude::v1::test;

    #[test]
    fn private_docx_preserves_original_bytes_and_edits_survive_encrypted_save() {
        let scratch = tempfile::tempdir().unwrap();
        let mut repo = VaultRepository::new(FileVaultStorage::new(scratch.path().join("vault.json")));
        let passphrase = "synthetic fixture passphrase";
        repo.create(passphrase).unwrap();
        let original = export_rich_document(&markie_office::rich_document::create_rich_document(Format::Docx, "Before").unwrap()).unwrap();
        let meta = VaultDocumentMetadata {
            name: "fixture.docx".into(),
            media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
        };
        let id = repo.save(None, &original, &meta).unwrap();
        let bytes = repo.read(&id).unwrap().document.bytes;
        let mut doc = SecureDoc::from_read(Some(id.clone()), meta.name.clone(), meta.media_type.clone(), bytes, false);
        assert!(doc.current_bytes().unwrap().as_slice() == original.as_slice());
        let Body::Docx(office) = &doc.body else { panic!("synthetic DOCX did not open") };
        let run = office.paragraphs[0].runs[0].id.clone();
        assert!(doc.edit_docx_run("missing", "ignored".into()).is_err());
        assert!(!doc.dirty);
        doc.edit_docx_run(&run, "After".into()).unwrap();
        assert!(doc.dirty);
        repo.save(Some(&id), &doc.current_bytes().unwrap(), &meta).unwrap();
        repo.lock();
        repo.unlock(passphrase).unwrap();
        let reopened = open_rich_document(Format::Docx, &repo.read(&id).unwrap().document.bytes).unwrap();
        assert_eq!(reopened.paragraphs[0].text, "After");
    }

    #[test]
    fn filenames_keep_their_type() {
        assert!(valid_filename("notes.txt", "renamed.md"));
        assert!(valid_filename("Untitled.env", ".env.local"));
        assert!(!valid_filename("photo.png", "photo.txt"));
        assert!(!valid_filename("notes.txt", ""));
        assert!(!valid_filename("notes.txt", "a/b.txt"));
        assert_eq!(safe_file_name(" a:b?.txt "), "a_b_.txt");
        assert_eq!(safe_file_name(".."), "Untitled");
    }

    #[test]
    fn typed_newlines_follow_the_source() {
        assert_eq!(normalize_typed_newlines("a\nb", Newline::Crlf), "a\r\nb");
        assert_eq!(normalize_typed_newlines("a\r\nb\nc", Newline::Cr), "a\rb\rc");
        assert_eq!(normalize_typed_newlines("a\nb", Newline::Lf), "a\nb");
    }

    #[test]
    fn parked_keys_are_masked() {
        assert_eq!(parked_key("# OLD_TOKEN=abc").as_deref(), Some("OLD_TOKEN"));
        assert_eq!(parked_key("#OLD_TOKEN=abc").as_deref(), Some("OLD_TOKEN"));
        assert_eq!(parked_key("# just a note"), None);
        assert_eq!(parked_key("# EMPTY="), None);
    }

    #[test]
    fn key_problems() {
        let dup: BTreeSet<String> = ["A".to_string()].into();
        assert_eq!(key_problem("", &dup).as_deref(), Some("Add a key name."));
        assert!(key_problem("1A", &dup).unwrap().starts_with("Start with a letter"));
        assert_eq!(key_problem("A", &dup).as_deref(), Some("A is set more than once. Most loaders use the last one."));
        assert_eq!(key_problem("B", &dup), None);
    }

    #[test]
    fn failure_copy_matches_electron() {
        assert_eq!(failure_copy(&VaultError::Vault(VaultErrorCode::AuthenticationFailed)), "The passphrase is incorrect or the vault was altered. Nothing was opened.");
        assert_eq!(failure_copy(&VaultError::Device(DeviceFailure::Busy)), "Touch ID is already waiting for you.");
        let save = VaultError::Save { document_id: "x".into(), failure: Box::new(VaultError::Vault(VaultErrorCode::LimitExceeded)) };
        assert_eq!(failure_copy(&save), "This file exceeds the vault's 8 MiB file limit.");
        assert_eq!(group_digits(1234567), "1,234,567");
        assert_eq!(group_digits(12), "12");
    }

    #[test]
    fn the_vault_lives_in_markie_rs_own_places() {
        assert!(vault_path().starts_with(markie_core::paths::data_dir()));
        assert!(!vault_path().to_string_lossy().contains("Application Support/Markie/"));
        assert_eq!(keychain_service(), "Markie RS Vault");
    }

    /// The whole flow the page drives, on a scratch file and in-memory Touch ID.
    #[test]
    fn hidden_window_triggers_the_same_lock_as_idle_without_reentering() {
        assert!(should_auto_lock(false, false, true, Duration::ZERO));
        assert!(should_auto_lock(false, false, false, IDLE_LOCK));
        assert!(!should_auto_lock(false, false, false, IDLE_LOCK - Duration::from_secs(1)));
        assert!(!should_auto_lock(false, true, true, IDLE_LOCK));
        assert!(!should_auto_lock(true, false, true, IDLE_LOCK));
    }

    #[test]
    fn create_save_lock_unlock_backup_restore() {
        use markie_vault::device::{FakeBiometric, MemorySecretStore};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        let mut repo = VaultRepository::new(FileVaultStorage::new(&path));
        assert!(!repo.inspect().unwrap());
        let pass = "correct horse battery staple";
        repo.create(pass).unwrap();
        let meta = VaultDocumentMetadata { name: "Untitled.env".into(), media_type: ENV_MEDIA_TYPE.into() };
        let id = repo.save(None, b"API_KEY=abc\n", &meta).unwrap();
        let backup = repo.backup().unwrap();
        repo.lock();
        assert!(failure_copy(&repo.unlock("wrong passphrase, long enough").unwrap_err()).starts_with("The passphrase is incorrect"));
        repo.unlock(pass).unwrap();
        let read = repo.read(&id).unwrap();
        let doc = SecureDoc::from_read(Some(id.clone()), read.document.metadata.name.clone(), read.document.metadata.media_type.clone(), read.document.bytes, read.recovery);
        assert!(doc.is_env());
        assert_eq!(doc.text(), Some("API_KEY=abc\n"));
        // Touch ID through doubles: enroll, then unlock without the passphrase.
        let keeper = TouchIdKeeper::new(FakeBiometric::default(), MemorySecretStore::default());
        repo.enroll_device(pass, &keeper).unwrap();
        repo.lock();
        repo.unlock_with_device(&keeper).unwrap();
        assert!(repo.unlocked());
        // Restore the backup over it.
        let mut fresh = VaultRepository::new(FileVaultStorage::new(&path));
        fresh.inspect().unwrap();
        fresh.restore(&backup, pass, true).unwrap();
        assert_eq!(fresh.list("").unwrap().len(), 1);
        assert!(!fresh.has_device_slot(), "a backup never carries the device slot");
    }
}
