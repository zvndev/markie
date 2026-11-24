//! The first-run import: what Electron Markie knew, brought into this app.
//!
//! The Mac app replaces Electron Markie in place (docs/rust-port/NIGHTLY.md),
//! but it keeps its own data folder. On its first launch it reads the Electron
//! profile of the same channel (`paths::ELECTRON_PROFILE`) and carries over
//! what it can use, so the person finds their library, their look, their
//! sign-in and their vault where they left them.
//!
//! Two rules hold for every line of this file:
//!
//! - **Electron's profile is only read.** Its Chromium stores (localStorage
//!   and IndexedDB) are copied to a scratch folder inside this app's own data
//!   folder and decoded there by `markie-migrate`; its SQLite registry is
//!   copied before it is opened; every other file is read once and written
//!   under this app's data folder. Nothing is created, changed or deleted in
//!   the Electron profile.
//! - **Nothing this app already has is replaced.** A setting is written only
//!   if it is not set, a sign-in only for a server with no session, the vault
//!   only if there is no vault, a file only if it is not there. Running the
//!   import twice changes nothing the second time.
//!
//! What is carried and what is not is `Summary` and `NOT_CARRIED`, and the
//! runbook's "First-run import".

use std::path::{Path, PathBuf};

use markie_cloud::tokens::{self, TokenStore};
use markie_core::paths;
use markie_core::registry::Registry;
use markie_migrate::markie::{ColorMode, ElectronData, LibraryRecord};
use markie_vault::{FileVaultStorage, VaultStorage as _};

/// The registry setting that records the import ran, with its summary.
pub const MARKER: &str = "electron_import.v1";

/// Files and folders Electron Markie and this app keep in one format, by the
/// same name, in their data folders. Copied when this app does not have them.
///
/// - `snapshots`: version history (`markie-core` history.rs, `electron/history.js`)
/// - `drafts`: unsaved text kept against a crash (drafts.rs, `electron/drafts.js`)
/// - `doc-meta`: comments and notes kept beside documents
/// - `servers.json`: the servers added in Settings (`markie-cloud` registry.rs)
/// - `agent-permissions.json`: what agents were allowed (`markie-agent`)
/// - `live-docs-projects.json`: Live Docs projects
pub const SHARED_FILES: &[&str] = &["snapshots", "drafts", "doc-meta", "servers.json", "agent-permissions.json", "live-docs-projects.json"];

/// localStorage keys carried as they are, and the registry setting each
/// becomes. Both apps store the same text under them.
const RAW_SETTINGS: &[(&str, &str)] = &[
    ("markie.fonts.v1", "fonts.v1"),
    ("markie.linkPreviews.v1", "markie.linkPreviews.v1"),
    ("markie.cloud.sources.v1", "cloud_sources"),
];

/// What the import leaves behind, and why. Shown in the runbook; kept here so
/// the list changes with the code.
#[cfg_attr(not(test), allow(dead_code))]
pub const NOT_CARRIED: &[(&str, &str)] = &[
    ("Touch ID for the vault", "its secret sits under Electron's own Keychain item; the first unlock takes the passphrase, then Touch ID can be turned on again"),
    ("the cloud sync switch", "sync starts off, so the first sync is one the person asks for"),
    ("the private-build unlock", "this app has no lock; updates ask the gateway with the Markie Cloud sign-in"),
    ("window and panel layout", "Library tab, Browse sort and filters, panel widths: this app keeps its own"),
    ("document zoom", "Electron's per-document zoom has no counterpart setting here"),
    ("rich-mode consents", "this app asks again when it would change a file's formatting"),
    ("the media cache", "re-fetched on demand"),
    ("recovery copies of in-app documents", "the documents themselves are carried; their older revisions are not"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VaultOutcome {
    /// Electron had no vault.
    #[default]
    None,
    /// Brought over. `touch_id`: Electron had Touch ID on, which is not carried.
    Imported { touch_id: bool },
    /// This app already had a vault; Electron's was left alone.
    AlreadyHere,
}

/// What one import did, by count and name only. Safe to log and to store.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Summary {
    /// The Electron profile folder was not there.
    pub source_missing: bool,
    pub recents: usize,
    pub folders: usize,
    pub stars: usize,
    /// Registry settings written, by this app's key.
    pub settings: Vec<String>,
    /// Sign-ins written: one per server that had no session here.
    pub sign_ins: usize,
    pub vault: VaultOutcome,
    /// In-app documents written to `Imported Documents`.
    pub documents: usize,
    /// `SHARED_FILES` entries copied.
    pub copied: Vec<String>,
    /// What went wrong, in words that carry no secret and no document text.
    pub problems: Vec<String>,
}

impl Summary {
    pub fn brought_anything(&self) -> bool {
        self.recents + self.folders + self.stars + self.sign_ins + self.documents > 0
            || !self.settings.is_empty()
            || !self.copied.is_empty()
            || matches!(self.vault, VaultOutcome::Imported { .. })
    }

    fn to_json(&self) -> String {
        serde_json::json!({
            "sourceMissing": self.source_missing, "recents": self.recents, "folders": self.folders, "stars": self.stars,
            "settings": self.settings, "signIns": self.sign_ins, "documents": self.documents, "copied": self.copied,
            "vault": match self.vault { VaultOutcome::None => "none", VaultOutcome::Imported { .. } => "imported", VaultOutcome::AlreadyHere => "already-here" },
            "problems": self.problems,
        })
        .to_string()
    }

    /// One or two sentences for the person, or None when nothing came over.
    pub fn notice(&self) -> Option<String> {
        if !self.brought_anything() {
            return None;
        }
        let mut parts: Vec<String> = Vec::new();
        let count = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        if self.recents > 0 {
            parts.push(count(self.recents, "recent file", "recent files"));
        }
        if self.folders > 0 {
            parts.push(count(self.folders, "folder", "folders"));
        }
        if self.stars > 0 {
            parts.push(count(self.stars, "star", "stars"));
        }
        if self.settings.iter().any(|s| s == "themes.v1") {
            parts.push("your theme and styles".into());
        }
        if self.sign_ins > 0 {
            parts.push("your Markie Cloud sign-in".into());
        }
        if self.copied.iter().any(|c| c == "snapshots") {
            parts.push("version history".into());
        }
        if self.documents > 0 {
            parts.push(count(self.documents, "in-app document", "in-app documents"));
        }
        let mut text = match parts.as_slice() {
            [] => "Your Markie settings came over.".to_string(),
            parts => format!("Brought over from Markie: {}.", parts.join(", ")),
        };
        if let VaultOutcome::Imported { touch_id } = self.vault {
            text.push_str(" Your vault is here: unlock it once with its passphrase.");
            if touch_id {
                text.push_str(" Touch ID can be turned on again after that.");
            }
        }
        Some(text)
    }
}

/// Where the import writes. All of it is this app's own.
pub struct Targets<'a> {
    pub registry: &'a Registry,
    pub tokens: &'a dyn TokenStore,
    pub data_dir: &'a Path,
}

/// Compared the way the Mac's disk compares names.
fn is_electron_profile(dir: &Path) -> bool {
    dir.file_name().and_then(|n| n.to_str()).is_some_and(|name| paths::ELECTRON_PROFILES.iter().any(|e| e.eq_ignore_ascii_case(name)))
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Copy a file or a folder of plain files, never following or copying a link,
/// never replacing what is at `to`. The source is opened for reading only.
fn copy_missing(from: &Path, to: &Path) -> std::io::Result<bool> {
    let kind = std::fs::symlink_metadata(from)?.file_type();
    if std::fs::symlink_metadata(to).is_ok() {
        return Ok(false);
    }
    if kind.is_file() {
        std::fs::copy(from, to)?;
        return Ok(true);
    }
    if !kind.is_dir() {
        return Ok(false);
    }
    // Into a temporary name first, so a copy cut short never looks whole.
    let partial = to.with_extension(format!("importing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&partial);
    let result = copy_tree(from, &partial).and_then(|()| std::fs::rename(&partial, to));
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&partial);
    }
    result.map(|()| true)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn set_if_unset(registry: &Registry, key: &str, value: &str, summary: &mut Summary) {
    match registry.setting(key) {
        Ok(None) => match registry.set_setting(key, value) {
            Ok(()) => summary.settings.push(key.to_string()),
            Err(_) => summary.problems.push(format!("the setting {key} could not be saved")),
        },
        Ok(Some(_)) => {}
        Err(_) => summary.problems.push(format!("the setting {key} could not be read")),
    }
}

fn settings(data: &ElectronData, to: &Targets, summary: &mut Summary) {
    let s = &data.settings;
    // The theme store: themes, the chosen one, and the Markdown style.
    if let Some(themes) = &s.themes {
        set_if_unset(to.registry, "themes.v1", &themes.to_string(), summary);
    }
    if let Some(mode) = s.color_mode {
        let value = match mode {
            ColorMode::System => "system",
            ColorMode::Light => "light",
            ColorMode::Dark => "dark",
        };
        set_if_unset(to.registry, "color_mode", value, summary);
    }
    for (electron, ours) in RAW_SETTINGS {
        let Some(value) = s.other.get(*electron) else { continue };
        // Each is a short switch or a small JSON value; anything else is not theirs.
        let sane = value.len() <= 16 * 1024 && (*ours != "fonts.v1" && *ours != "cloud_sources" || serde_json::from_str::<serde_json::Value>(value).is_ok());
        if sane {
            set_if_unset(to.registry, ours, value, summary);
        }
    }
}

fn sign_ins(data: &ElectronData, to: &Targets, summary: &mut Summary) {
    for session in &data.settings.sessions {
        // A server this app is already signed in to keeps its own session.
        if tokens::session_for(to.tokens, &session.origin).is_some() {
            continue;
        }
        if tokens::set_token(to.tokens, &session.origin, Some(&session.token)).is_err() {
            summary.problems.push("a sign-in could not be saved to the Keychain".into());
            continue;
        }
        // Only the account the server had confirmed for exactly this token.
        if let Some(user) = &session.user_id {
            let _ = tokens::confirm(to.tokens, &session.origin, &session.token, user);
        }
        summary.sign_ins += 1;
    }
}

fn vault(data: &ElectronData, to: &Targets, summary: &mut Summary) {
    let Some(stored) = &data.vault else { return };
    let path = to.data_dir.join("vault.json");
    if std::fs::symlink_metadata(&path).is_ok() {
        summary.vault = VaultOutcome::AlreadyHere;
        return;
    }
    // Without the device slot: its other half is under Electron's Keychain
    // item, which this app does not read. The passphrase opens the vault.
    let touch_id = stored.device_slot.is_some();
    // The snapshot as it is, revision and all: a commit would restart the
    // revision at 1, and this is the same vault, not a new one. Validated as
    // every load validates it, then written whole or not at all.
    let saved = stored.without_device_slot().validate().map_err(|_| ()).and_then(|vault| write_private(&path, vault.to_json().as_bytes()).map_err(|_| ()));
    // And it must read back as the vault storage reads it.
    match saved.and_then(|()| FileVaultStorage::new(&path).load().map_err(|_| ())) {
        Ok(Some(_)) => summary.vault = VaultOutcome::Imported { touch_id },
        _ => {
            let _ = std::fs::remove_file(&path);
            summary.problems.push("the vault could not be saved".into());
        }
    }
}

/// Write a new file readable by this account only: to a temporary name, then
/// renamed, so the file is whole or absent. Never replaces a file.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let temp = path.with_extension(format!("importing-{}", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if std::fs::symlink_metadata(path).is_ok() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn extension(format: &str) -> &'static str {
    match format {
        "markdown" => "md",
        "darkmown" => "wd",
        "text" => "txt",
        "csv" => "csv",
        "json" => "json",
        "yaml" => "yaml",
        "xml" => "xml",
        "docx" => "docx",
        "doc" => "doc",
        "rtf" => "rtf",
        "odt" => "odt",
        _ => "bin",
    }
}

/// A file name from a document's own name: no folders, no dots at the ends.
fn file_name(record: &LibraryRecord) -> String {
    let ext = extension(&record.format);
    let cleaned: String = record.name.chars().map(|c| if c == '/' || c == '\\' || c == ':' || c.is_control() { ' ' } else { c }).collect();
    let edge = |c: char| c == '.' || c.is_whitespace();
    let stem = cleaned.trim_start_matches(edge).trim_end_matches(edge);
    let stem = stem.strip_suffix(&format!(".{ext}")).unwrap_or(stem);
    let stem: String = stem.chars().take(120).collect();
    format!("{}.{ext}", if stem.is_empty() { "Untitled" } else { stem.as_str() })
}

/// Documents Electron kept inside the app (its IndexedDB library) have no
/// store here. They become ordinary files in this app's data folder, where
/// nothing is lost and nothing lands in the person's own folders unasked.
fn documents(data: &ElectronData, to: &Targets, summary: &mut Summary) {
    let Some(library) = &data.library else { return };
    if library.documents.is_empty() {
        return;
    }
    let dir = to.data_dir.join(DOCUMENTS_FOLDER);
    if std::fs::symlink_metadata(&dir).is_ok() {
        return;
    }
    let partial = to.data_dir.join(format!(".{DOCUMENTS_FOLDER}.importing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&partial);
    let written = (|| -> std::io::Result<usize> {
        std::fs::create_dir_all(&partial)?;
        let mut taken = std::collections::HashSet::new();
        for record in &library.documents {
            let name = file_name(record);
            let mut candidate = name.clone();
            let mut n = 2;
            while !taken.insert(candidate.to_lowercase()) {
                let (stem, ext) = name.rsplit_once('.').unwrap_or((&name, ""));
                candidate = format!("{stem} ({n}).{ext}");
                n += 1;
            }
            std::fs::write(partial.join(&candidate), &record.bytes)?;
        }
        std::fs::rename(&partial, &dir)?;
        Ok(library.documents.len())
    })();
    match written {
        Ok(n) => summary.documents = n,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&partial);
            summary.problems.push("the in-app documents could not be saved".into());
        }
    }
}

/// Where `documents` puts them, under the data folder.
pub const DOCUMENTS_FOLDER: &str = "Imported Documents";

/// Read the Electron profile at `profile` and carry it into `to`.
pub fn import(profile: &Path, to: &Targets) -> Summary {
    let mut summary = Summary::default();
    if !profile.is_dir() {
        summary.source_missing = true;
        return summary;
    }
    // This app's folder is never Electron's, and neither is inside the other.
    let (source, data) = (canonical(profile), canonical(to.data_dir));
    if is_electron_profile(&data) || data.starts_with(&source) || source.starts_with(&data) {
        summary.problems.push("the import was refused: this app's data folder and the Markie profile overlap".into());
        return summary;
    }

    // The library: recent files, folders and stars, from a copy of the registry.
    let registry = profile.join("registry.db");
    if registry.is_file() {
        match markie_core::import::import_from_electron(&registry, to.registry) {
            Ok(found) => (summary.recents, summary.folders, summary.stars) = (found.recents, found.roots, found.stars),
            Err(_) => summary.problems.push("the library (recent files, folders, stars) could not be read".into()),
        }
    }

    // Files both apps keep in one format.
    for name in SHARED_FILES {
        match copy_missing(&profile.join(name), &to.data_dir.join(name)) {
            Ok(true) => summary.copied.push((*name).to_string()),
            Ok(false) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => summary.problems.push(format!("{name} could not be copied")),
        }
    }

    // Chromium's stores, decoded from a private copy that is deleted afterwards.
    let scratch = to.data_dir.join(format!(".electron-import-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())));
    let decoded = (|| {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&scratch).map_err(|_| "the scratch folder could not be made")?;
        markie_migrate::copy_profile(profile, &scratch.join("copy")).map_err(|_| "the Markie profile could not be copied")?;
        markie_migrate::read_copy(&scratch.join("copy")).map_err(|_| "the Markie profile could not be read")
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    match decoded {
        Ok(data) => {
            settings(&data, to, &mut summary);
            sign_ins(&data, to, &mut summary);
            vault(&data, to, &mut summary);
            documents(&data, to, &mut summary);
        }
        Err(what) => summary.problems.push(format!("settings, sign-in and vault were not imported: {what}")),
    }
    summary
}

/// What the first launch found, for the window to say once it is up.
static FIRST_LAUNCH: std::sync::Mutex<Option<Summary>> = std::sync::Mutex::new(None);

/// The Electron profile this build imports from, if it imports at all.
pub fn source() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join(paths::ELECTRON_PROFILE?))
}

/// Whether this run may import: the Mac app with its real data folder. Never a
/// scratch data folder or a test server, and never the dev build.
pub fn applies(scratch: bool, dev_server: bool) -> bool {
    paths::ELECTRON_PROFILE.is_some() && !scratch && !dev_server
}

/// Run the import if this is the first launch that can. Called before any
/// window exists, so the first frame already has the imported look. A failure
/// is recorded and never stops the launch, and the import is tried once.
pub fn at_first_launch() {
    if !applies(std::env::var_os("MARKIE_RS_DATA_DIR").is_some(), crate::workspace::account::server_config().dev) {
        return;
    }
    let Some(profile) = source() else { return };
    let data_dir = paths::data_dir();
    if std::fs::create_dir_all(&data_dir).is_err() {
        return;
    }
    let Ok(registry) = Registry::open(&data_dir.join("registry.db")) else { return };
    if !matches!(registry.setting(MARKER), Ok(None)) {
        return;
    }
    // Marked before the work: an import that crashes is not run again on every launch.
    let _ = registry.set_setting(MARKER, "{\"started\":true}");
    let tokens = crate::workspace::account::shared_tokens();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| import(&profile, &Targets { registry: &registry, tokens: &*tokens, data_dir: &data_dir })));
    let summary = outcome.unwrap_or_else(|_| Summary { problems: vec!["the import stopped unexpectedly".into()], ..Summary::default() });
    record(&registry, &summary);
    *FIRST_LAUNCH.lock().unwrap_or_else(|e| e.into_inner()) = Some(summary);
}

/// Keep what an import did, by count and name, and log what went wrong.
pub fn record(registry: &Registry, summary: &Summary) {
    let _ = registry.set_setting(MARKER, &summary.to_json());
    for problem in &summary.problems {
        eprintln!("markie-rs: import from Markie: {problem}");
    }
}

/// The sentence to show once after the first launch's import, if it brought anything.
pub fn take_notice() -> Option<String> {
    FIRST_LAUNCH.lock().unwrap_or_else(|e| e.into_inner()).take().and_then(|summary| summary.notice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use markie_cloud::tokens::MemoryTokenStore;
    use markie_vault::StoredVault;

    /// The profile Electron 42 wrote from made-up data (markie-migrate's
    /// fixture): settings, two sign-ins, a vault and in-app documents.
    fn chromium_fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../markie-migrate/tests/fixtures/electron-userdata")
    }

    fn fixture_data() -> serde_json::Value {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../markie-migrate/tests/fixtures/fixture-data.json");
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    }

    /// Every file under a folder with its bytes, to show a folder did not change.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(d) = pending.pop() {
            for entry in std::fs::read_dir(&d).unwrap() {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    pending.push(entry.path());
                } else if kind.is_symlink() {
                    out.push((entry.path(), std::fs::read_link(entry.path()).unwrap().to_string_lossy().into_owned().into_bytes()));
                } else {
                    out.push((entry.path(), std::fs::read(entry.path()).unwrap()));
                }
            }
        }
        out.sort();
        out
    }

    struct Scene {
        dir: tempfile::TempDir,
        profile: PathBuf,
        data_dir: PathBuf,
        registry: Registry,
        tokens: MemoryTokenStore,
    }

    /// A synthetic Electron profile, "Markie Super-nightly", beside an empty
    /// data folder of this app's.
    fn scene() -> Scene {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("Markie Super-nightly");
        copy_tree(&chromium_fixture(), &profile).unwrap();
        // The registry Electron keeps beside its Chromium stores.
        let docs = dir.path().join("Documents");
        std::fs::create_dir_all(&docs).unwrap();
        let note = docs.join("note.md");
        std::fs::write(&note, "# A note").unwrap();
        let db = rusqlite::Connection::open(profile.join("registry.db")).unwrap();
        db.execute_batch(&format!(
            "CREATE TABLE files (path TEXT PRIMARY KEY, name TEXT, last_opened_at TEXT);
             CREATE TABLE workspace_roots (path TEXT PRIMARY KEY, added_at TEXT);
             CREATE TABLE md_stars (path TEXT PRIMARY KEY, kind TEXT, added_at TEXT);
             INSERT INTO files VALUES ('{n}', 'note.md', '2026-11-20T10:00:00.000Z');
             INSERT INTO files VALUES ('/gone/old.md', 'old.md', '2026-01-01T00:00:00.000Z');
             INSERT INTO workspace_roots VALUES ('{d}', '2026-11-01T00:00:00.000Z');
             INSERT INTO md_stars VALUES ('{n}', 'file', '2026-11-02T00:00:00.000Z');",
            n = note.display(),
            d = docs.display()
        ))
        .unwrap();
        drop(db);
        // Files both apps keep in one format.
        std::fs::create_dir_all(profile.join("snapshots/abc123")).unwrap();
        std::fs::write(profile.join("snapshots/abc123/2026-11-20T10-00-00-000Z.md"), "an older version").unwrap();
        std::fs::write(profile.join("snapshots/abc123/meta.json"), "{}").unwrap();
        std::fs::create_dir_all(profile.join("drafts")).unwrap();
        std::fs::write(profile.join("drafts/index.json"), "{}").unwrap();
        std::fs::write(profile.join("servers.json"), r#"{"version":1,"servers":[]}"#).unwrap();
        std::fs::write(profile.join("agent-permissions.json"), "{}").unwrap();
        // Things that must never come along.
        std::fs::write(profile.join("private-release-credential"), "synthetic-credential").unwrap();
        std::fs::create_dir_all(profile.join("vault-touch-id")).unwrap();
        std::fs::write(profile.join("vault-touch-id/secret"), "synthetic-device-secret").unwrap();
        std::os::unix::fs::symlink(&docs, profile.join("doc-meta")).unwrap();

        let data_dir = dir.path().join("Markie Nightly");
        std::fs::create_dir_all(&data_dir).unwrap();
        let registry = Registry::open(&data_dir.join("registry.db")).unwrap();
        Scene { dir, profile, data_dir, registry, tokens: MemoryTokenStore::new() }
    }

    impl Scene {
        fn import(&self) -> Summary {
            import(&self.profile, &Targets { registry: &self.registry, tokens: &self.tokens, data_dir: &self.data_dir })
        }
    }

    #[test]
    fn carries_library_look_sign_in_vault_and_history_and_changes_nothing_in_electrons_profile() {
        let s = scene();
        let before = snapshot(&s.profile);
        let summary = s.import();
        assert_eq!(snapshot(&s.profile), before, "the Electron profile is only read");
        assert_eq!(summary.problems, Vec::<String>::new());

        // The library.
        assert_eq!((summary.recents, summary.folders, summary.stars), (1, 1, 1));
        assert_eq!(s.registry.recent(10).unwrap()[0].last_opened_at, "2026-11-20T10:00:00.000Z");
        assert_eq!(s.registry.roots().unwrap().len(), 1);

        // Settings and styles: the theme store as Electron kept it, and the color mode.
        let fixture = fixture_data();
        let expected_themes: serde_json::Value = serde_json::from_str(fixture["localStorage2"]["set"]["markie.themes.v1"].as_str().or(fixture["localStorage1"]["markie.themes.v1"].as_str()).unwrap()).unwrap();
        let stored: serde_json::Value = serde_json::from_str(&s.registry.setting("themes.v1").unwrap().unwrap()).unwrap();
        assert_eq!(stored, expected_themes);
        assert_eq!(s.registry.setting("color_mode").unwrap().as_deref(), Some("dark"));
        assert!(summary.settings.contains(&"themes.v1".to_string()) && summary.settings.contains(&"color_mode".to_string()));
        // The stored theme store is one this app reads.
        let _ = markie_core::theme::ThemeStore::parse(&s.registry.setting("themes.v1").unwrap().unwrap());

        // Sign-ins: both servers, the confirmed account only where the server confirmed this token.
        assert_eq!(summary.sign_ins, 2);
        let cloud = tokens::session_for(&s.tokens, markie_cloud::DEFAULT_SERVER).unwrap();
        assert_eq!((cloud.token.as_str(), cloud.user_id), ("fixture-token-primary-rotated", None));
        let other = tokens::session_for(&s.tokens, "https://docs.example.test").unwrap();
        assert_eq!((other.token.as_str(), other.user_id.as_deref()), ("fixture-token-selfhosted", Some("fixture-user-2")));

        // The vault: the same records, without the device slot, and it opens with the passphrase.
        assert!(matches!(summary.vault, VaultOutcome::Imported { .. }));
        let vault = StoredVault::from_json(&std::fs::read_to_string(s.data_dir.join("vault.json")).unwrap()).unwrap();
        assert_eq!(vault.device_slot, None);
        let source = markie_migrate::read_copy(&chromium_fixture()).unwrap().vault.unwrap();
        assert_eq!(vault.header, source.header);
        assert_eq!(vault.records.len(), source.records.len());
        assert_eq!(vault.revision, source.revision, "the same vault, at the revision Electron left it");
        assert!(source.device_slot.is_some(), "the fixture has Touch ID on, which is not carried");
        assert_eq!(summary.vault, VaultOutcome::Imported { touch_id: true });
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(s.data_dir.join("vault.json")).unwrap().permissions()) & 0o777, 0o600);
        // It opens with the fixture's passphrase, through this app's own vault code.
        let mut repo = markie_vault::VaultRepository::new(FileVaultStorage::new(s.data_dir.join("vault.json")));
        repo.unlock(fixture["passphrase"].as_str().unwrap()).unwrap();
        assert_eq!(repo.list("").unwrap().len(), source.records.len());

        // In-app documents, as files in this app's own folder.
        let expected_documents = markie_migrate::read_copy(&chromium_fixture()).unwrap().library.map_or(0, |l| l.documents.len());
        assert!(expected_documents > 0, "the fixture has in-app documents");
        assert_eq!(summary.documents, expected_documents);
        assert_eq!(std::fs::read_dir(s.data_dir.join(DOCUMENTS_FOLDER)).unwrap().count(), expected_documents);

        // Shared files: copied, and the link was not followed.
        assert_eq!(summary.copied, ["snapshots", "drafts", "servers.json", "agent-permissions.json"]);
        assert_eq!(std::fs::read_to_string(s.data_dir.join("snapshots/abc123/2026-11-20T10-00-00-000Z.md")).unwrap(), "an older version");
        assert!(!s.data_dir.join("doc-meta").exists(), "a symlink in the profile is not followed or copied");

        // Never carried: Electron's private-build credential and Touch ID secret.
        for name in ["private-release-credential", "vault-touch-id", "Local Storage", "IndexedDB"] {
            assert!(!s.data_dir.join(name).exists(), "{name}");
        }
        // Nothing of the scratch copy is left, and no token is on disk in this app's folder.
        for (path, bytes) in snapshot(&s.data_dir) {
            assert!(!path.to_string_lossy().contains(".electron-import-"), "{}", path.display());
            if path.file_name().is_some_and(|n| n == "registry.db") {
                assert!(!bytes.windows(13).any(|w| w == b"fixture-token"), "tokens belong in the Keychain, not the registry");
            }
        }
        assert!(summary.notice().unwrap().starts_with("Brought over from Markie: 1 recent file, 1 folder, 1 star, your theme and styles, your Markie Cloud sign-in, version history"));
        assert!(summary.notice().unwrap().contains("unlock it once with its passphrase"));
        let logged = format!("{summary:?}{}", summary.to_json());
        assert!(!logged.contains("fixture-token") && !logged.contains("fixture-user"), "the summary holds counts and names only");
    }

    #[test]
    fn never_replaces_what_this_app_already_has() {
        let s = scene();
        // This app was used first: its own look, session, vault and history.
        s.registry.set_setting("themes.v1", "{\"mine\":true}").unwrap();
        s.registry.set_setting("color_mode", "light").unwrap();
        tokens::set_token(&s.tokens, markie_cloud::DEFAULT_SERVER, Some("my-own-token")).unwrap();
        std::fs::write(s.data_dir.join("vault.json"), "my own vault").unwrap();
        std::fs::create_dir_all(s.data_dir.join("snapshots")).unwrap();
        std::fs::write(s.data_dir.join("snapshots/mine.md"), "mine").unwrap();
        std::fs::write(s.data_dir.join("servers.json"), "mine").unwrap();

        let summary = s.import();
        assert_eq!(s.registry.setting("themes.v1").unwrap().as_deref(), Some("{\"mine\":true}"));
        assert_eq!(s.registry.setting("color_mode").unwrap().as_deref(), Some("light"));
        assert_eq!(tokens::session_for(&s.tokens, markie_cloud::DEFAULT_SERVER).unwrap().token, "my-own-token");
        assert_eq!(std::fs::read_to_string(s.data_dir.join("vault.json")).unwrap(), "my own vault");
        assert_eq!(summary.vault, VaultOutcome::AlreadyHere);
        assert_eq!(std::fs::read_dir(s.data_dir.join("snapshots")).unwrap().count(), 1);
        assert_eq!(std::fs::read_to_string(s.data_dir.join("servers.json")).unwrap(), "mine");
        assert!(!summary.settings.contains(&"themes.v1".to_string()));
        // The other server had no session here, so its sign-in still comes over.
        assert_eq!(summary.sign_ins, 1);
        assert_eq!(summary.copied, ["drafts", "agent-permissions.json"]);
    }

    #[test]
    fn a_second_import_changes_nothing() {
        let s = scene();
        let first = s.import();
        assert!(first.brought_anything());
        let after_first = snapshot(&s.data_dir).into_iter().filter(|(p, _)| !p.to_string_lossy().contains("registry.db")).collect::<Vec<_>>();
        let second = s.import();
        assert_eq!(second.problems, Vec::<String>::new());
        assert_eq!((second.settings.len(), second.sign_ins, second.documents, second.copied.len()), (0, 0, 0, 0));
        assert_eq!(second.vault, VaultOutcome::AlreadyHere);
        assert_eq!(snapshot(&s.data_dir).into_iter().filter(|(p, _)| !p.to_string_lossy().contains("registry.db")).collect::<Vec<_>>(), after_first);
        assert_eq!(s.registry.recent(10).unwrap().len(), 1);
    }

    #[test]
    fn no_profile_a_broken_profile_and_an_overlapping_folder_are_harmless() {
        let s = scene();
        // No Electron profile at all: a clean install.
        let missing = import(&s.dir.path().join("Nobody Home"), &Targets { registry: &s.registry, tokens: &s.tokens, data_dir: &s.data_dir });
        assert!(missing.source_missing && !missing.brought_anything() && missing.notice().is_none());

        // A profile whose Chromium store is damaged: the library and the shared
        // files still come over, and the rest is reported, not guessed at.
        let table = std::fs::read_dir(s.profile.join("Local Storage/leveldb")).unwrap().filter_map(Result::ok).find(|e| e.path().extension().is_some_and(|x| x == "ldb")).map(|e| e.path());
        if let Some(table) = table {
            let mut bytes = std::fs::read(&table).unwrap();
            let middle = bytes.len() / 2;
            let end = middle + 64.min(bytes.len() - middle);
            for b in &mut bytes[middle..end] {
                *b ^= 0xff;
            }
            std::fs::write(&table, bytes).unwrap();
            let summary = s.import();
            assert_eq!((summary.recents, summary.folders, summary.stars), (1, 1, 1));
            assert!(summary.copied.contains(&"snapshots".to_string()));
            assert_eq!(summary.sign_ins, 0);
            assert_eq!(summary.vault, VaultOutcome::None);
            assert!(summary.problems.iter().any(|p| p.contains("could not be read")), "{:?}", summary.problems);
            assert!(std::fs::read_dir(&s.data_dir).unwrap().filter_map(Result::ok).all(|e| !e.file_name().to_string_lossy().starts_with(".electron-import-")));
        }

        // This app's data folder may never be an Electron profile (by any
        // spelling the disk takes for one), or inside one.
        let stable = s.dir.path().join("markie");
        let inside = s.profile.join("inside");
        std::fs::create_dir_all(&stable).unwrap();
        std::fs::create_dir_all(&inside).unwrap();
        let before = snapshot(&s.profile);
        for bad in [stable, s.dir.path().join("MARKIE SUPER-NIGHTLY"), s.dir.path().join("Markie Super-nightly"), inside] {
            let registry = Registry::in_memory().unwrap();
            let tokens = MemoryTokenStore::new();
            let refused = import(&s.profile, &Targets { registry: &registry, tokens: &tokens, data_dir: &bad });
            assert!(refused.problems.iter().any(|p| p.contains("refused")), "{}", bad.display());
            assert!(!refused.brought_anything());
            assert!(tokens::session_for(&tokens, markie_cloud::DEFAULT_SERVER).is_none());
            assert_eq!(snapshot(&s.profile), before, "nothing was written at {}", bad.display());
        }
        assert!(std::fs::read_dir(s.dir.path().join("markie")).unwrap().next().is_none());
    }

    #[test]
    fn in_app_documents_get_safe_distinct_file_names() {
        let record = |name: &str, format: &str| LibraryRecord {
            id: "id".into(), name: name.into(), format: format.into(), bytes: Vec::new(), created_at: 0, updated_at: 0, revision: 1,
            exported_revision: None, tags: Vec::new(), collection: None, extracted_text: None,
        };
        assert_eq!(file_name(&record("Quarterly plan", "docx")), "Quarterly plan.docx");
        assert_eq!(file_name(&record("notes.md", "markdown")), "notes.md");
        assert_eq!(file_name(&record("../../etc/passwd", "text")), "etc passwd.txt");
        assert_eq!(file_name(&record("a/b\\c:d", "csv")), "a b c d.csv");
        assert_eq!(file_name(&record("...", "markdown")), "Untitled.md");
        assert_eq!(file_name(&record("", "darkmown")), "Untitled.wd");
        assert_eq!(file_name(&record("x", "something-new")), "x.bin");
        assert!(file_name(&record(&"n".repeat(500), "markdown")).len() <= 124);
    }

    #[test]
    fn only_the_mac_app_with_its_real_data_folder_imports() {
        // This test binary is the dev build: no Electron profile is ever its source.
        assert_eq!(paths::ELECTRON_PROFILE, None);
        assert!(!applies(false, false));
        assert_eq!(source(), None);
        assert!(take_notice().is_none());
        // Whatever the build, a scratch folder or a test server never imports.
        assert!(!applies(true, false) && !applies(false, true));
    }

    /// The runbook's two tables are this file's two lists. A change to what the
    /// import carries or leaves is a change to what the runbook promises.
    #[test]
    fn the_runbook_lists_what_is_carried_and_what_is_not() {
        let runbook = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/rust-port/NIGHTLY.md")).unwrap();
        let (_, import_section) = runbook.split_once("## First-run import").unwrap();
        let (import_section, _) = import_section.split_once("\n## ").unwrap();
        for (what, _) in NOT_CARRIED {
            let title = format!("{}{}", what[..1].to_uppercase(), &what[1..]);
            assert!(import_section.contains(&format!("| {title} |")), "the runbook's Not carried table lacks: {title}");
        }
        for name in SHARED_FILES {
            assert!(import_section.contains(&format!("`{name}{}`", if name.contains('.') { "" } else { "/" })), "the runbook's Carried table lacks: {name}");
        }
        for (electron, _) in RAW_SETTINGS {
            assert!(import_section.contains(electron), "the runbook's Carried table lacks: {electron}");
        }
        for key in ["markie.themes.v1", "markie.colormode.v1", "markie.token.v1", "markie-encrypted-vault", "markie-document-library", "registry.db", DOCUMENTS_FOLDER] {
            assert!(import_section.contains(key), "the runbook's Carried table lacks: {key}");
        }
    }

    #[test]
    fn the_notice_says_what_came_and_nothing_when_nothing_did() {
        assert_eq!(Summary::default().notice(), None);
        assert_eq!(Summary { problems: vec!["x".into()], ..Summary::default() }.notice(), None);
        let vault_only = Summary { vault: VaultOutcome::Imported { touch_id: true }, ..Summary::default() };
        assert_eq!(vault_only.notice().unwrap(), "Your Markie settings came over. Your vault is here: unlock it once with its passphrase. Touch ID can be turned on again after that.");
        let some = Summary { recents: 12, folders: 3, stars: 1, documents: 2, ..Summary::default() };
        assert_eq!(some.notice().unwrap(), "Brought over from Markie: 12 recent files, 3 folders, 1 star, 2 in-app documents.");
    }
}
