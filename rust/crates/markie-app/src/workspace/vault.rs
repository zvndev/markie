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

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Editor, EditorState, Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{ActiveTheme, Disableable as _, Icon, Selectable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::formats::{self, Newline, Representation, TextEncoding};
use markie_vault::backup::{VAULT_BACKUP_FILE_NAME, VAULT_BACKUP_MAX_CHARACTERS, parse_vault_backup, vault_backup_text};
use markie_vault::clipboard::{CLEAR_AFTER, SecretClipboard, ThreadScheduler};
use markie_vault::device::{Biometric, DeviceKeeper, KeychainSecretStore, PromptDeclined, TouchIdKeeper, TouchIdStatus};
use markie_vault::dotenv::{self, DotenvDocument, LineKind};
use markie_vault::envelope::{VaultDocumentMetadata, limits};
use markie_vault::passphrase::{StrengthLevel, passphrase_strength, suggest_passphrase, SUGGESTED_PASSPHRASE_WORDS};
use markie_vault::{DeviceFailure, FileVaultStorage, StorageErrorCode, VaultEntry, VaultError, VaultErrorCode, VaultRepository};

use super::Workspace;

pub const IDLE_LOCK: Duration = Duration::from_secs(5 * 60);
pub const CHECKPOINT: Duration = Duration::from_secs(2);
/// Revealed values mask themselves again this long after the last reveal.
pub const REVEAL_REMASK: Duration = Duration::from_secs(60);
const MASK: &str = "••••••••••••";
const ENV_MEDIA_TYPE: &str = "text/plain";
const COPY_NOTE: &str = "It is now on the clipboard, outside the vault. Markie clears it after 30 seconds if it is still there.";
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

type Keeper = TouchIdKeeper<Bio, KeychainSecretStore>;

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
    format!("{} Vault", markie_core::paths::APP_NAME)
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
}

impl SecureDoc {
    fn from_read(id: Option<String>, name: String, media_type: String, bytes: zeroize::Zeroizing<Vec<u8>>, recovery: bool) -> Self {
        let body = match representation_of(&name).0 {
            Representation::Text => match formats::decode_text(&bytes) {
                Ok(d) => Body::Text { text: d.text, encoding: d.encoding, bom: d.bom, newline: d.newline },
                Err(_) => Body::Opaque,
            },
            Representation::Bytes => Body::Opaque,
        };
        Self { id, original_name: name.clone(), name, media_type, bytes, dirty: recovery, body }
    }

    fn is_env(&self) -> bool {
        matches!(self.body, Body::Text { .. }) && dotenv::is_env_file_name(&self.original_name)
    }

    fn text(&self) -> Option<&str> {
        match &self.body {
            Body::Text { text, .. } => Some(text),
            Body::Opaque => None,
        }
    }

    /// `documentBytes`.
    fn current_bytes(&self) -> zeroize::Zeroizing<Vec<u8>> {
        match &self.body {
            Body::Text { text, encoding, bom, .. } => zeroize::Zeroizing::new(formats::encode_text(text, *encoding, *bom).unwrap_or_else(|_| text.as_bytes().to_vec())),
            Body::Opaque => self.bytes.clone(),
        }
    }
}

/// What waits for a fresh Touch ID or passphrase check.
enum Pending {
    Open(VaultEntry),
    Reveal(Vec<usize>),
    RevealRaw,
    Copy { value: zeroize::Zeroizing<String>, message: String },
}

struct EnvRow {
    key: Entity<InputState>,
    value: Entity<InputState>,
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

pub struct VaultPage {
    repo: Arc<Mutex<Repo>>,
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
    touch_id: TouchIdStatus,
    settings_open: bool,
    enrolling: bool,
    restore_file: Option<(String, String)>,
    suggested: Option<zeroize::Zeroizing<String>>,
    offer_touch_id: bool,
    gate: Option<(String, Pending)>,
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
        let keeper = Arc::new(TouchIdKeeper::new(biometric(), KeychainSecretStore::new(keychain_service())));
        let clipboard = SecretClipboard::new(secret_pasteboard(), Arc::new(ThreadScheduler), CLEAR_AFTER);
        let passphrase = masked_input(window, cx);
        let confirmation = masked_input(window, cx);
        let enroll_passphrase = masked_input(window, cx);
        let restore_passphrase = masked_input(window, cx);
        let gate_passphrase = masked_input(window, cx);
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by name"));
        let filename = cx.new(|cx| InputState::new(window, cx));
        let text_editor = cx.new(|cx| EditorState::new(window, cx).language("text").line_number(false).soft_wrap(true));
        let raw_editor = cx.new(|cx| EditorState::new(window, cx).language("text").line_number(false).soft_wrap(true));

        let subscriptions = vec![
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

        let mut this = Self {
            repo,
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
            touch_id: TouchIdStatus { available: false, enrolled: false },
            settings_open: false,
            enrolling: false,
            restore_file: None,
            suggested: None,
            offer_touch_id: false,
            gate: None,
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
}

#[cfg(target_os = "macos")]
fn secret_pasteboard() -> Box<dyn markie_vault::clipboard::Clipboard> {
    Box::new(markie_vault::clipboard::MacPasteboard)
}

/// Windows and Linux need their own concealed clipboard writer; until then a
/// copy goes nowhere rather than into a clipboard history.
#[cfg(not(target_os = "macos"))]
fn secret_pasteboard() -> Box<dyn markie_vault::clipboard::Clipboard> {
    struct Nowhere;
    impl markie_vault::clipboard::Clipboard for Nowhere {
        fn read_text(&self) -> Option<String> {
            None
        }
        fn write_secret(&self, _text: &str) {}
        fn clear(&self) {}
    }
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
        self.operation += 1;
        let ticket = self.operation;
        self.busy = true;
        self.error = None;
        cx.notify();
        let repo = self.repo.clone();
        let keeper = self.keeper.clone();
        let work = cx.background_executor().spawn(async move {
            let mut guard = repo.lock().unwrap_or_else(|p| p.into_inner());
            job(&mut guard, &keeper)
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
                this.notice = if exists { "Your vault is locked.".into() } else { "Create an encrypted vault on this device.".into() };
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
        self.repo.lock().unwrap_or_else(|p| p.into_inner()).lock();
        self.gate = None;
        self.gate_busy = false;
        self.pending_confirm = None;
        // A key copied out a moment ago should not outlive the vault it came from.
        self.clipboard.clear_now();
        self.opened = None;
        self.env = EnvView::default();
        self.entries.clear();
        self.suggested = None;
        self.enrolling = false;
        self.restore_file = None;
        self.settings_open = false;
        self.offer_touch_id = false;
        self.error = None;
        self.locked = true;
        self.shielded = false;
        self.busy = false;
        self.notice = message.into();
        self.clear_secret_inputs(window, cx);
        self.set_editor_text(&self.text_editor.clone(), "", window, cx);
        self.set_editor_text(&self.raw_editor.clone(), "", window, cx);
        self.clear_input(&self.query.clone(), window, cx);
        cx.notify();
    }

    /// Whether leaving the page would lose edits. The caller asks first.
    pub fn has_unsaved(&self) -> bool {
        self.opened.as_ref().is_some_and(|d| d.dirty) || self.repo.lock().map(|r| r.has_volatile_recovery()).unwrap_or(false)
    }

    /// The shared tail of every way in.
    fn enter_vault(&mut self, message: &str, window: &mut Window, cx: &mut Context<Self>) {
        let listed = self.repo.lock().unwrap_or_else(|p| p.into_inner()).list("");
        match listed {
            Ok(entries) => {
                self.has_vault = Some(true);
                self.locked = false;
                self.entries = entries;
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
        self.run(
            window,
            cx,
            move |repo, _| {
                let result = if has_vault { repo.unlock(&secret) } else { repo.create(&secret) };
                if result.is_err() {
                    // A valid header with a tampered record must not leave unlocked keys behind.
                    repo.lock();
                }
                result
            },
            |this, result, window, cx| match result {
                Ok(()) => {
                    this.enter_vault("Unlocked.", window, cx);
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
                Ok(()) => this.enter_vault("Unlocked.", window, cx),
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
                    this.notice = "Touch ID unlock is on. Opening or copying an item asks for Touch ID too.".into();
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
            Ok(_) => self.notice = "Copied. Paste it into your password manager now; Markie clears the clipboard in 30 seconds.".into(),
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
                        this.notice = "Enter the passphrase for this backup.".into();
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
            Pending::Copy { value, message } => match self.clipboard.copy(&value) {
                Ok(_) => self.notice = format!("{message} {COPY_NOTE}"),
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
                repo.read(&id).map(|r| (id, r))
            },
            |this, result, window, cx| match result {
                Ok((id, read)) => {
                    let doc = SecureDoc::from_read(Some(id), read.document.metadata.name.clone(), read.document.metadata.media_type.clone(), read.document.bytes, read.recovery);
                    let dirty = doc.dirty;
                    this.show_doc(doc, window, cx);
                    this.settings_open = false;
                    this.notice = if dirty {
                        "Recovered unsaved encrypted edits. Save encrypted changes to make them durable.".into()
                    } else {
                        "Decrypted only inside this vault page.".into()
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
        self.env.rows.clear();
        self.env.revealed.clear();
        self.writing = true;
        for line in &parsed.lines {
            if let LineKind::Entry(e) = &line.kind {
                let id = line.id;
                let key = cx.new(|cx| InputState::new(window, cx).default_value(e.key.clone()));
                let value = cx.new(|cx| InputState::new(window, cx).masked(true).default_value(e.value.clone()));
                let subs = [
                    cx.subscribe(&key, move |this, state, ev: &InputEvent, cx| {
                        if matches!(ev, InputEvent::Change) && !this.writing {
                            let k = state.read(cx).value().to_string();
                            this.commit_env(|doc| dotenv::update_dotenv_entry(doc, id, Some(&k), None), cx);
                        }
                    }),
                    cx.subscribe(&value, move |this, state, ev: &InputEvent, cx| {
                        if matches!(ev, InputEvent::Change) && !this.writing {
                            let v = state.read(cx).value().to_string();
                            this.commit_env(|doc| dotenv::update_dotenv_entry(doc, id, None, Some(&v)), cx);
                        }
                    }),
                ];
                self._subscriptions.extend(subs);
                self.env.rows.insert(id, EnvRow { key, value });
            }
        }
        self.writing = false;
        self.env.text = text;
        self.env.parsed = Some(parsed);
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
        for (id, row) in &self.env.rows {
            let shown = self.env.revealed.contains(id);
            row.value.update(cx, |s, cx| s.set_masked(!shown, window, cx));
        }
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
        let bytes = doc.current_bytes();
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
        let bytes = doc.current_bytes();
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
        let Some(id) = self.opened.as_ref().and_then(|d| d.id.clone()) else { return };
        cx.spawn_in(window, async move |this, cx| {
            if !confirm(&this, cx, "Delete this encrypted copy and any unsaved edits? The original imported file is not deleted.").await {
                return;
            }
            this.update_in(cx, move |this, window, cx| {
                this.run(window, cx, move |repo, _| repo.remove(&id), |this, result, _, _| match result {
                    Ok(()) => {
                        this.opened = None;
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
                    if !this.locked && !this.shielded && this.last_activity.elapsed() >= IDLE_LOCK {
                        this.automatic_lock(window, cx);
                    }
                }) else {
                    break;
                };
            }
        });
    }

    fn automatic_lock(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shielded = true;
        self.operation += 1;
        let ticket = self.operation;
        self.busy = true;
        self.clear_secret_inputs(window, cx);
        let checkpoint = self.opened.as_ref().filter(|d| d.dirty).map(|d| {
            let name = if valid_filename(&d.original_name, &d.name) { d.name.clone() } else { d.original_name.clone() };
            (d.id.clone(), d.current_bytes(), VaultDocumentMetadata { name, media_type: d.media_type.clone() })
        });
        let repo = self.repo.clone();
        let save = cx.background_executor().spawn(async move {
            match checkpoint {
                Some((id, bytes, meta)) => repo.lock().unwrap_or_else(|p| p.into_inner()).save(id.as_deref(), &bytes, &meta).map(|_| ()),
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
                let recovery = this.repo.lock().map(|r| r.has_volatile_recovery()).unwrap_or(false);
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

// ── Rendering ──

fn strength_color(level: StrengthLevel) -> Hsla {
    match level {
        StrengthLevel::TooShort | StrengthLevel::Weak => rgb(0xef4444).into(),
        StrengthLevel::Fair => rgb(0xf59e0b).into(),
        StrengthLevel::Strong => rgb(0x10b981).into(),
        StrengthLevel::VeryStrong => rgb(0x059669).into(),
    }
}

fn group_title(text: &'static str, cx: &App) -> Div {
    div().px_2().pt_1().pb_1().text_size(px(11.)).font_weight(FontWeight::MEDIUM).text_color(cx.theme().muted_foreground).child(text.to_uppercase())
}

impl VaultPage {
    fn field_label(&self, label: &'static str, input: &Entity<InputState>, disabled: bool) -> Div {
        v_flex().gap_2().text_sm().child(label).child(Input::new(input).disabled(disabled))
    }

    fn render_locked(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let busy = self.busy;
        let creating = self.has_vault == Some(false);
        let touch_ready = self.has_vault == Some(true) && self.touch_id.available && self.touch_id.enrolled;
        let pass = self.passphrase.read(cx).value().to_string();
        let conf_empty = self.confirmation.read(cx).value().is_empty();
        let strength = (creating && !pass.is_empty()).then(|| passphrase_strength(&pass));
        let suggested_shown = creating && self.suggested.as_ref().is_some_and(|s| **s == pass);
        let mut card = v_flex()
            .w_full()
            .max_w(px(448.))
            .gap_4()
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .bg(theme.secondary)
            .p_6()
            .child(div().text_xs().text_color(theme.muted_foreground).child("PRIVATE ON THIS DEVICE"));

        let restoring_first = creating && self.restore_file.is_some();
        if !self.shielded && restoring_first {
            card = card.child(self.render_restore_form(cx));
        }
        if !self.shielded && self.has_vault.is_some() && !restoring_first {
            if touch_ready {
                card = card.child(
                    v_flex()
                        .gap_2()
                        .child(
                            Button::new("vault-touch-id")
                                .primary()
                                .w_full()
                                .label("Unlock with Touch ID")
                                .disabled(busy)
                                .on_click(cx.listener(|this, _, window, cx| this.unlock_with_touch_id(window, cx))),
                        )
                        .child(div().text_center().text_xs().text_color(theme.muted_foreground).child("or use your passphrase")),
                );
            }
            card = card.child(self.field_label("Vault passphrase", &self.passphrase, busy));
            if let Some(s) = &strength {
                let pct = s.bits.clamp(6, 100) as f32 / 100.0;
                card = card.child(
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .h(px(6.))
                                .w_full()
                                .rounded_full()
                                .overflow_hidden()
                                .bg(theme.border)
                                .child(div().h_full().w(relative(pct)).bg(strength_color(s.level))),
                        )
                        .child(div().text_xs().text_color(theme.muted_foreground).child(format!("{} · about {} bits", s.label, s.bits))),
                );
            }
            if creating {
                card = card.child(self.field_label("Confirm passphrase", &self.confirmation, busy));
            }
            if suggested_shown {
                let words = self.suggested.as_ref().map(|s| s.to_string()).unwrap_or_default();
                card = card.child(
                    h_flex()
                        .gap_2()
                        .rounded_md()
                        .border_1()
                        .border_color(theme.border)
                        .p_2()
                        .child(div().flex_1().min_w_0().text_sm().font_family("Menlo").child(words))
                        .child(Button::new("vault-copy-suggestion").outline().small().label("Copy").on_click(cx.listener(|this, _, _, cx| this.copy_suggestion(cx)))),
                );
            }
            let submit_label = if busy {
                "Working locally…"
            } else if creating {
                "Create encrypted vault"
            } else {
                "Unlock vault"
            };
            let mut submit = Button::new("vault-submit")
                .label(submit_label)
                .disabled(busy || pass.is_empty() || (creating && conf_empty))
                .on_click(cx.listener(|this, _, window, cx| this.authenticate(window, cx)));
            submit = if touch_ready { submit.outline() } else { submit.primary() };
            card = card.child(h_flex().gap_3().items_center().child(submit).when(creating, |el| {
                el.child(Button::new("vault-suggest").link().label("Suggest a passphrase").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.suggest(window, cx))))
            }));
            if creating {
                card = card
                    .child(div().text_xs().text_color(theme.muted_foreground).child("Only you can unlock this vault. Save the passphrase in your password manager; there is no reset."))
                    .child(
                        Button::new("vault-restore-first")
                            .link()
                            .label("Restore from backup…")
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, window, cx| this.choose_backup(window, cx))),
                    );
            }
        }
        div().flex_1().min_h_0().p_7().child(h_flex().justify_center().pt(px(48.)).child(card)).into_any_element()
    }

    fn render_restore_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let name = self.restore_file.as_ref().map(|(_, n)| n.clone()).unwrap_or_default();
        let busy = self.busy;
        let empty = self.restore_passphrase.read(cx).value().is_empty();
        v_flex()
            .gap_3()
            .child(div().text_sm().child(format!("Restore from {name}")))
            .child(self.field_label("Backup passphrase", &self.restore_passphrase, busy))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("vault-restore")
                            .primary()
                            .label(if busy { "Checking backup…" } else { "Restore vault" })
                            .disabled(busy || empty)
                            .on_click(cx.listener(|this, _, window, cx| this.restore_backup(window, cx))),
                    )
                    .child(Button::new("vault-restore-cancel").outline().label("Cancel").disabled(busy).on_click(cx.listener(|this, _, window, cx| {
                        this.restore_file = None;
                        this.clear_input(&this.restore_passphrase.clone(), window, cx);
                        cx.notify();
                    }))),
            )
            .into_any_element()
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let busy = self.busy;
        let query = self.query.read(cx).value().to_lowercase();
        let visible: Vec<&VaultEntry> = self.entries.iter().filter(|e| e.name.to_lowercase().contains(&query)).collect();
        let opened_id = self.opened.as_ref().and_then(|d| d.id.clone());
        let mut nav = v_flex().flex_1().min_h_0().overflow_y_scrollbar().p_2();
        if visible.is_empty() {
            nav = nav.child(
                div()
                    .px_2()
                    .py_3()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(if self.entries.is_empty() { "No encrypted files yet." } else { "No matching files." }),
            );
        }
        for (label, env) in [("Environment keys", true), ("Files", false)] {
            let items: Vec<&&VaultEntry> = visible.iter().filter(|e| dotenv::is_env_file_name(&e.name) == env).collect();
            if items.is_empty() {
                continue;
            }
            let mut group = v_flex().mb_3().child(group_title(label, cx));
            for entry in items {
                let entry = (*entry).clone();
                let selected = opened_id.as_deref() == Some(entry.id.as_str());
                let icon = if env { gpui_kit::assets::IconName::Key } else { gpui_kit::assets::IconName::File };
                let sub = format!("{} bytes{}", group_digits(entry.bytes), if entry.recovery { " · unsaved encrypted recovery" } else { "" });
                let id = SharedString::from(format!("vault-entry-{}", entry.id));
                group = group.child(
                    h_flex()
                        .id(id)
                        .items_start()
                        .gap_2()
                        .rounded_md()
                        .px_2()
                        .py(px(6.))
                        .text_sm()
                        .when(selected, |el| el.bg(theme.accent))
                        .when(!selected, |el| el.hover(|s| s.bg(theme.accent)))
                        .when(!busy, |el| el.cursor_pointer())
                        .child(div().mt(px(2.)).text_color(theme.muted_foreground).child(Icon::new(icon).small()))
                        .child(v_flex().min_w_0().child(div().child(entry.name.clone())).child(div().text_xs().text_color(theme.muted_foreground).child(sub)))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if !this.busy {
                                this.choose(entry.clone(), window, cx);
                            }
                        })),
                );
            }
            nav = nav.child(group);
        }
        v_flex()
            .w(px(256.))
            .flex_none()
            .h_full()
            .border_r_1()
            .border_color(theme.border)
            .bg(theme.secondary)
            .child(
                v_flex()
                    .gap_2()
                    .p_3()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        v_flex()
                            .gap(px(6.))
                            .child(Button::new("vault-new-env").outline().w_full().label("New environment keys").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.create_untitled("Untitled.env", window, cx))))
                            .child(Button::new("vault-new-note").outline().w_full().label("New private note").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.create_untitled("Untitled.txt", window, cx))))
                            .child(Button::new("vault-import").outline().w_full().label("Import encrypted copy").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.import_file(window, cx)))),
                    )
                    .child(Input::new(&self.query).small().disabled(busy)),
            )
            .child(nav)
            .into_any_element()
    }

    fn render_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let busy = self.busy;
        let muted = theme.muted_foreground;
        let mut section = v_flex().w_full().max_w(px(576.)).gap_6().child(div().text_base().font_weight(FontWeight::SEMIBOLD).child("Settings"));
        if self.touch_id.available {
            let mut block = v_flex().gap_2().child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Touch ID"));
            block = if self.touch_id.enrolled {
                block.child(
                    h_flex()
                        .flex_wrap()
                        .gap_3()
                        .child(div().text_sm().text_color(muted).child("Touch ID unlocks this vault on this Mac and is asked again before an item is opened, shown or copied."))
                        .child(Button::new("vault-touch-off").outline().label("Turn off Touch ID").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.disable_touch_id(window, cx)))),
                )
            } else if self.enrolling {
                let empty = self.enroll_passphrase.read(cx).value().is_empty();
                block.child(self.field_label("Confirm with your passphrase", &self.enroll_passphrase, busy)).child(
                    h_flex()
                        .gap_2()
                        .child(Button::new("vault-touch-on").primary().label("Turn on Touch ID").disabled(busy || empty).on_click(cx.listener(|this, _, window, cx| this.enroll_touch_id(window, cx))))
                        .child(Button::new("vault-touch-cancel").outline().label("Cancel").disabled(busy).on_click(cx.listener(|this, _, window, cx| {
                            this.enrolling = false;
                            this.clear_input(&this.enroll_passphrase.clone(), window, cx);
                            cx.notify();
                        }))),
                )
            } else {
                block.child(
                    h_flex()
                        .flex_wrap()
                        .gap_3()
                        .child(div().text_sm().text_color(muted).child("Unlock with your fingerprint, and confirm with it before an item is opened, shown or copied. Your passphrase still works."))
                        .child(Button::new("vault-touch-start").outline().label("Turn on Touch ID…").disabled(busy).on_click(cx.listener(|this, _, _, cx| {
                            this.enrolling = true;
                            cx.notify();
                        }))),
                )
            };
            section = section.child(block);
        }
        let mut backup = v_flex()
            .gap_2()
            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Backup"))
            .child(div().text_sm().text_color(muted).child("One encrypted file. It opens only with your passphrase."));
        backup = if self.restore_file.is_some() {
            backup.child(self.render_restore_form(cx))
        } else {
            backup.child(
                h_flex()
                    .gap_2()
                    .child(Button::new("vault-backup").outline().label("Back up vault…").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.back_up(window, cx))))
                    .child(Button::new("vault-restore-choose").outline().label("Restore from backup…").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.choose_backup(window, cx)))),
            )
        };
        section.child(backup).child(div().text_xs().text_color(muted).child("Locks after 5 minutes idle.")).into_any_element()
    }

    fn render_env(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let muted = theme.muted_foreground;
        let busy = self.busy;
        let Some(doc) = self.opened.as_ref() else { return div().into_any_element() };
        let text = doc.text().unwrap_or("").to_string();
        let mixed = matches!(doc.body, Body::Text { newline: Newline::Mixed, .. });
        // Any outside change (the Raw view) re-parses and masks everything again.
        if self.env.text != text || self.env.parsed.is_none() {
            self.rebuild_env(window, cx);
        }
        let parsed = self.env.parsed.clone().unwrap_or_else(|| dotenv::parse_dotenv(""));
        let duplicates = dotenv::duplicate_dotenv_keys(&parsed);
        let parked: HashMap<usize, String> = parsed
            .lines
            .iter()
            .filter_map(|l| match &l.kind {
                LineKind::Comment { .. } => parked_key(&l.raw).map(|k| (l.id, k)),
                _ => None,
            })
            .collect();
        let maskable: Vec<usize> = parsed
            .lines
            .iter()
            .filter(|l| matches!(l.kind, LineKind::Entry(_) | LineKind::Malformed { .. }) || parked.contains_key(&l.id))
            .map(|l| l.id)
            .collect();
        let key_count = parsed.lines.iter().filter(|l| matches!(l.kind, LineKind::Entry(_))).count();
        let all_revealed = !maskable.is_empty() && maskable.iter().all(|id| self.env.revealed.contains(id));
        let raw = self.env.raw;
        let quiet = |id: SharedString, label: &str| Button::new(id).ghost().xsmall().label(label.to_string());

        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .child(
                h_flex()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .p(px(2.))
                    .child(Button::new("env-keys").ghost().xsmall().label("Keys").selected(!raw).on_click(cx.listener(|this, _, _, cx| {
                        this.env.raw = false;
                        cx.notify();
                    })))
                    .child(Button::new("env-raw").ghost().xsmall().label("Raw").selected(raw).on_click(cx.listener(move |this, _, window, cx| {
                        if !this.env.raw {
                            let label = this.opened.as_ref().map(|d| d.name.clone()).unwrap_or_default();
                            this.confirm_item("reveal", label, Pending::RevealRaw, window, cx);
                        }
                    }))),
            )
            .child(div().text_xs().text_color(muted).child(if key_count == 1 { "1 key".to_string() } else { format!("{key_count} keys") }))
            .child(div().flex_1())
            .when(!raw, |el| {
                let ids = maskable.clone();
                el.child(Button::new("env-reveal-all").outline().xsmall().label(if all_revealed { "Hide all" } else { "Reveal all" }).disabled(maskable.is_empty()).on_click(cx.listener(
                    move |this, _, window, cx| {
                        if all_revealed {
                            this.env.revealed.clear();
                            this.sync_env_masks(window, cx);
                            cx.notify();
                        } else {
                            let label = this.opened.as_ref().map(|d| d.name.clone()).unwrap_or_default();
                            this.confirm_item("reveal", label, Pending::Reveal(ids.clone()), window, cx);
                        }
                    },
                )))
            })
            .child(Button::new("env-copy-all").outline().xsmall().label("Copy as .env").disabled(busy || text.is_empty()).on_click(cx.listener(move |this, _, window, cx| {
                let Some(doc) = this.opened.as_ref() else { return };
                let value = zeroize::Zeroizing::new(doc.text().unwrap_or("").to_string());
                let label = doc.name.clone();
                this.confirm_item("copy", label, Pending::Copy { value, message: "Copied the whole file as .env text.".into() }, window, cx);
            })));

        let mut body = v_flex().gap_3().child(toolbar);
        if raw {
            body = body.child(div().h(px(320.)).rounded_md().border_1().border_color(theme.border).child(Editor::new(&self.raw_editor).h_full()));
            if mixed {
                body = body.child(div().text_xs().text_color(muted).child("Mixed line endings are preserved read-only here. Switch to Keys to edit values."));
            }
            return body.into_any_element();
        }
        if parsed.lines.is_empty() {
            body = body.child(div().py_4().text_sm().text_color(muted).child("No keys yet. Add one, or paste a .env file into Raw."));
        }
        let mut table = v_flex().gap_1();
        if !parsed.lines.is_empty() {
            table = table.child(
                h_flex()
                    .text_xs()
                    .text_color(muted)
                    .child(div().w(relative(0.36)).px_1().child("Key"))
                    .child(div().flex_1().px_1().child("Value"))
                    .child(div().w(px(120.))),
            );
        }
        for (index, line) in parsed.lines.iter().enumerate() {
            let row = index + 1;
            let shown = self.env.revealed.contains(&line.id);
            let id = line.id;
            match &line.kind {
                LineKind::Blank => {}
                LineKind::Comment { .. } => {
                    let key = parked.get(&id).cloned();
                    let text = match &key {
                        Some(k) if !shown => format!("# {k}={MASK}"),
                        _ => line.raw.trim().to_string(),
                    };
                    table = table.child(
                        h_flex()
                            .pt_2()
                            .child(div().flex_1().px_1().text_xs().italic().font_family("Menlo").text_color(muted).child(text))
                            .when_some(key, |el, k| {
                                el.child(div().w(px(120.)).child(quiet(SharedString::from(format!("env-park-{id}")), if shown { "Hide" } else { "Show" }).on_click(cx.listener(
                                    move |this, _, window, cx| this.toggle_row(id, format!("commented {k}"), window, cx),
                                ))))
                            }),
                    );
                }
                LineKind::Malformed { reason } => {
                    let reason = *reason;
                    table = table.child(
                        h_flex()
                            .items_start()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .px_1()
                                    .child(div().rounded_md().border_1().border_dashed().border_color(theme.border).px(px(10.)).py(px(6.)).font_family("Menlo").text_size(px(13.)).text_color(muted).child(if shown { line.raw.clone() } else { MASK.to_string() }))
                                    .child(div().mt_1().text_xs().text_color(muted).child(format!("{reason} Kept exactly as written. Edit it in Raw."))),
                            )
                            .child(div().w(px(120.)).child(quiet(SharedString::from(format!("env-bad-{id}")), if shown { "Hide" } else { "Show" }).on_click(cx.listener(
                                move |this, _, window, cx| this.toggle_row(id, format!("line {row}"), window, cx),
                            )))),
                    );
                }
                LineKind::Entry(entry) => {
                    let Some(inputs) = self.env.rows.get(&id) else { continue };
                    let label = if entry.key.is_empty() { format!("row {row}") } else { entry.key.clone() };
                    let problem = key_problem(&entry.key, &duplicates);
                    let multiline = entry.value.contains(['\r', '\n']);
                    let value_cell = if multiline {
                        let lines = entry.value.split(['\n']).count();
                        div()
                            .rounded_md()
                            .border_1()
                            .border_color(theme.border)
                            .px(px(10.))
                            .py(px(6.))
                            .font_family("Menlo")
                            .text_size(px(13.))
                            .text_color(if shown { theme.foreground } else { muted })
                            .child(if shown { entry.value.clone() } else { format!("{MASK} {lines} lines") })
                            .into_any_element()
                    } else {
                        Input::new(&inputs.value).small().disabled(busy).into_any_element()
                    };
                    let copy_label = label.clone();
                    let toggle_label = label.clone();
                    let value = entry.value.clone();
                    table = table.child(
                        h_flex()
                            .items_start()
                            .child(
                                v_flex()
                                    .w(relative(0.36))
                                    .px_1()
                                    .child(h_flex().gap(px(6.)).child(div().text_color(muted).child(Icon::new(gpui_kit::assets::IconName::Key).small())).child(Input::new(&inputs.key).small().disabled(busy)))
                                    .children(problem.map(|p| div().mt_1().pl_5().text_xs().text_color(theme.danger).child(p))),
                            )
                            .child(div().flex_1().px_1().child(value_cell))
                            .child(
                                h_flex()
                                    .w(px(120.))
                                    .px_1()
                                    .child(quiet(SharedString::from(format!("env-show-{id}")), if shown { "Hide" } else { "Show" }).on_click(cx.listener(move |this, _, window, cx| {
                                        this.toggle_row(id, toggle_label.clone(), window, cx)
                                    })))
                                    .child(quiet(SharedString::from(format!("env-copy-{id}")), "Copy").disabled(busy).on_click(cx.listener(move |this, _, window, cx| {
                                        let message = format!("Copied the value of {copy_label}.");
                                        this.confirm_item("copy", copy_label.clone(), Pending::Copy { value: zeroize::Zeroizing::new(value.clone()), message }, window, cx);
                                    })))
                                    .child(quiet(SharedString::from(format!("env-remove-{id}")), "×").disabled(busy).on_click(cx.listener(move |this, _, _, cx| {
                                        this.commit_env(|doc| dotenv::remove_dotenv_line(doc, id), cx);
                                    }))),
                            ),
                    );
                }
            }
        }
        body.child(table)
            .child(Button::new("env-add").outline().xsmall().label("Add key").disabled(busy).on_click(cx.listener(|this, _, window, cx| {
                this.commit_env(|doc| dotenv::add_dotenv_entry(doc, "", ""), cx);
                this.rebuild_env(window, cx);
            })))
            .into_any_element()
    }

    fn toggle_row(&mut self, id: usize, label: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.env.revealed.remove(&id) {
            self.sync_env_masks(window, cx);
            cx.notify();
            return;
        }
        let file = self.opened.as_ref().map(|d| d.name.clone()).unwrap_or_default();
        self.confirm_item("reveal", format!("{label} in {file}"), Pending::Reveal(vec![id]), window, cx);
    }

    fn render_opened(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let muted = theme.muted_foreground;
        let busy = self.busy;
        let Some(doc) = self.opened.as_ref() else { return div().into_any_element() };
        let dirty = doc.dirty;
        let has_id = doc.id.is_some();
        let is_env = doc.is_env();
        let is_text = matches!(doc.body, Body::Text { .. });
        let mixed = matches!(doc.body, Body::Text { newline: Newline::Mixed, .. });
        let head = h_flex()
            .flex_wrap()
            .items_end()
            .gap_3()
            .child(v_flex().min_w(px(224.)).flex_1().gap_2().text_sm().child("Private filename").child(Input::new(&self.filename).disabled(busy)))
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(Button::new("vault-save").outline().label("Save encrypted changes").disabled(busy || !dirty).on_click(cx.listener(|this, _, window, cx| this.save(window, cx))))
                    .child(Button::new("vault-export").outline().label("Save unencrypted copy…").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.export_decrypted(window, cx))))
                    .when(has_id, |el| {
                        el.child(Button::new("vault-delete").outline().label("Delete encrypted copy").disabled(busy).on_click(cx.listener(|this, _, window, cx| this.delete_opened(window, cx))))
                    }),
            );
        let body = if is_env {
            self.render_env(window, cx)
        } else if is_text {
            v_flex()
                .gap_2()
                .text_sm()
                .child("Private text")
                .child(div().h(px(320.)).rounded_md().border_1().border_color(theme.border).child(Editor::new(&self.text_editor).h_full()))
                .when(mixed, |el| el.child(div().text_sm().text_color(muted).child("Mixed line endings are preserved read-only.")))
                .into_any_element()
        } else {
            div()
                .text_sm()
                .text_color(muted)
                .child("This file is stored encrypted. Editing and preview are unavailable; an explicitly decrypted copy keeps its original bytes.")
                .into_any_element()
        };
        v_flex()
            .w_full()
            .max_w(px(896.))
            .gap_4()
            .child(head)
            .child(body)
            .child(div().text_xs().text_color(muted).child(if dirty { "Unsaved private edits" } else { "Encrypted saved copy" }))
            .into_any_element()
    }
}

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
            }
        }
        if self.pending_text.take().is_some() && self.opened.as_ref().is_some_and(|d| d.is_env()) && !self.env.raw {
            self.rebuild_env(window, cx);
        }
        let theme = cx.theme().clone();
        let muted = theme.muted_foreground;
        let unlocked = !self.locked && !self.shielded;
        let busy = self.busy;
        let header = h_flex()
            .items_start()
            .gap_3()
            .border_b_1()
            .border_color(theme.border)
            .px_7()
            .py_4()
            .child(
                div()
                    .mt(px(2.))
                    .size(px(32.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .text_color(muted)
                    .child(Icon::new(gpui_kit::assets::IconName::Lock).small()),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child("Vault"))
                    .child(div().mt(px(2.)).text_sm().text_color(muted).child(if self.shielded { "Securing last edits and locking…".to_string() } else { self.notice.clone() })),
            )
            .when(unlocked, |el| {
                el.child(Button::new("vault-settings").outline().label("Settings").selected(self.settings_open).on_click(cx.listener(|this, _, window, cx| {
                    this.settings_open = !this.settings_open;
                    this.enrolling = false;
                    this.clear_input(&this.enroll_passphrase.clone(), window, cx);
                    cx.notify();
                })))
                .child(Button::new("vault-lock").outline().label("Lock vault").on_click(cx.listener(|this, _, window, cx| {
                    let dirty = this.opened.as_ref().is_some_and(|d| d.dirty);
                    cx.spawn_in(window, async move |this, cx| {
                        if dirty && !confirm(&this, cx, "Discard unsaved private edits? Save encrypted changes first to keep them.").await {
                            return;
                        }
                        this.update_in(cx, |this, window, cx| this.lock_now("Vault locked.", window, cx)).ok();
                    })
                    .detach();
                })))
            });

        let mut page = v_flex()
            .id("vault-page")
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, _| this.touched()))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.touched();
                let k = &event.keystroke;
                if k.modifiers.platform && k.key == "s" && !this.locked {
                    this.save(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(header);
        if let Some(error) = &self.error {
            page = page.child(div().mx_7().mt_4().rounded_md().border_1().border_color(theme.border).p_3().text_sm().child(error.clone()));
        }
        if unlocked && let Some((prompt, _)) = &self.gate {
            let empty = self.gate_passphrase.read(cx).value().is_empty();
            let gate_busy = self.gate_busy;
            page = page.child(
                v_flex()
                    .mx_7()
                    .mt_4()
                    .gap_3()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.secondary)
                    .p_3()
                    .child(div().text_sm().child(prompt.clone()))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().min_w(px(224.)).child(Input::new(&self.gate_passphrase).disabled(gate_busy)))
                            .child(Button::new("vault-gate-ok").primary().label(if gate_busy { "Checking…" } else { "Confirm" }).disabled(gate_busy || empty).on_click(cx.listener(|this, _, window, cx| this.submit_gate(window, cx))))
                            .child(Button::new("vault-gate-cancel").outline().label("Cancel").disabled(gate_busy).on_click(cx.listener(|this, _, _, cx| {
                                this.gate = None;
                                cx.notify();
                            }))),
                    ),
            );
        }
        if self.offer_touch_id && self.touch_id.available && !self.touch_id.enrolled && unlocked && !self.settings_open {
            page = page.child(
                h_flex()
                    .mx_7()
                    .mt_4()
                    .gap_3()
                    .flex_wrap()
                    .items_center()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.secondary)
                    .p_3()
                    .child(div().flex_1().min_w_0().text_sm().child("Use Touch ID to unlock this vault and to open or copy its items. Your passphrase still works."))
                    .child(Button::new("vault-offer-yes").primary().label("Use Touch ID…").disabled(busy).on_click(cx.listener(|this, _, _, cx| {
                        this.offer_touch_id = false;
                        this.settings_open = true;
                        this.enrolling = true;
                        cx.notify();
                    })))
                    .child(Button::new("vault-offer-no").link().label("Not now").on_click(cx.listener(|this, _, _, cx| this.dismiss_touch_id_offer(cx)))),
            );
        }
        if !unlocked {
            return page.child(self.render_locked(cx));
        }
        let content = if self.settings_open {
            self.render_settings(cx)
        } else if self.opened.is_some() {
            self.render_opened(window, cx)
        } else {
            div().max_w(px(448.)).py_16().text_center().text_sm().text_color(muted).child("Choose an item, or create environment keys or a private note.").into_any_element()
        };
        page.child(
            h_flex()
                .flex_1()
                .min_h_0()
                .child(self.render_sidebar(cx))
                .child(div().id("vault-content").flex_1().min_w_0().h_full().overflow_y_scroll().p_7().child(h_flex().justify_center().child(content))),
        )
    }
}

// ── Workspace hooks ──

impl Workspace {
    /// Show the vault page in the document area. The activity bar's vault
    /// button calls this.
    pub fn open_vault(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.vault.is_none() {
            self.vault = Some(cx.new(|cx| VaultPage::new(window, cx)));
        }
        self.vault_visible = true;
        cx.notify();
    }

    pub fn vault_open(&self) -> bool {
        self.vault_visible
    }

    /// Leave the vault page. Unsaved edits ask first; leaving locks the vault,
    /// as Electron's close guard does.
    pub fn close_vault(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(page) = self.vault.clone() else {
            self.vault_visible = false;
            return;
        };
        let unsaved = page.read(cx).has_unsaved();
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
                page.update(cx, |p, cx| p.lock_now("Vault locked.", window, cx));
                this.vault_visible = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn on_toggle_vault(&mut self, _: &ToggleVault, window: &mut Window, cx: &mut Context<Self>) {
        if self.vault_visible { self.close_vault(window, cx) } else { self.open_vault(window, cx) }
    }

    /// The vault page when it is showing, for the document area.
    pub(super) fn render_vault(&self) -> Option<AnyElement> {
        self.vault_visible.then(|| self.vault.clone().map(|v| v.into_any_element())).flatten()
    }
}

actions!(markie_vault_page, [ToggleVault]);

#[cfg(test)]
mod tests {
    use super::*;
    // `gpui_kit::*` brings GPUI's own `test` attribute; tests here are plain.
    use ::core::prelude::v1::test;

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
