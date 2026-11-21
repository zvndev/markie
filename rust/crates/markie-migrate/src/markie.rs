//! Markie's own records, typed, from a copy of the Electron profile.
//!
//! What is read is listed in PARITY.md section 0. Secrets (tokens, vault
//! ciphertext) are carried in the returned structs only; `Report` and every
//! `Debug` here print counts and key names, never values.
use crate::error::{MigrateError, Result};
use crate::idb::{read_origin, IdbKey, IdbRecord};
use crate::local_storage;
use crate::profile::{ensure_not_live, electron_user_data, ELECTRON_ORIGIN, IDB_BLOB_DIR, IDB_LEVELDB_DIR, LOCAL_STORAGE_DIR};
use crate::v8::JsValue;
use markie_vault::StoredVault;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

const CLOUD_ORIGIN_JSON: &str = include_str!("../../../../electron/cloud-origin.json");

/// Markie Cloud's origin and its old names, from `electron/cloud-origin.json`.
fn cloud() -> (String, Vec<String>) {
    let v: Value = serde_json::from_str(CLOUD_ORIGIN_JSON).expect("electron/cloud-origin.json");
    let origin = v["origin"].as_str().unwrap().to_string();
    let aliases = v["legacyAliases"].as_array().unwrap().iter().filter_map(|a| a.as_str().map(String::from)).collect();
    (origin, aliases)
}

/// `canonicalCloudOrigin` for the values Electron stored (already origins).
pub fn canonical_origin(origin: &str) -> String {
    let (cloud, aliases) = cloud();
    let trimmed = origin.trim_end_matches('/');
    if aliases.iter().any(|a| a == trimmed) { cloud } else { origin.to_string() }
}

pub const VAULT_DATABASE: &str = "markie-encrypted-vault";
pub const LIBRARY_DATABASE: &str = "markie-document-library";

/// One server's sign-in.
#[derive(Clone, PartialEq, Eq)]
pub struct ServerSession {
    pub origin: String,
    pub token: String,
    /// The account the server confirmed for exactly this token at exactly this origin.
    pub user_id: Option<String>,
    pub primary: bool,
}

impl std::fmt::Debug for ServerSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerSession")
            .field("origin", &self.origin)
            .field("token", &"<redacted>")
            .field("confirmed", &self.user_id.is_some())
            .field("primary", &self.primary)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    System,
    Light,
    Dark,
}

/// The `markie.*` localStorage keys of the `app://markie` origin.
#[derive(Default, Clone)]
pub struct MarkieSettings {
    /// `markie.server.v1`, the primary server, canonical. None means Markie Cloud.
    pub primary_server: Option<String>,
    pub sessions: Vec<ServerSession>,
    /// `markie.themes.v1` as stored (the shape theme.ts and `PUT /api/me/themes` share).
    pub themes: Option<Value>,
    /// `markie.colormode.v1`; absent or unknown reads as system in theme code.
    pub color_mode: Option<ColorMode>,
    /// `markie.richoverride.v1:<path>` set to "1": paths whose rich-mode normalize consent was given.
    pub rich_override_paths: Vec<String>,
    /// Every other `markie.*` key, raw, for the settings port to pick up.
    pub other: BTreeMap<String, String>,
    /// Keys that failed their parse and were left out, by name.
    pub rejected_keys: Vec<String>,
}

impl std::fmt::Debug for MarkieSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MarkieSettings")
            .field("primary_server", &self.primary_server)
            .field("sessions", &self.sessions)
            .field("themes", &self.themes.is_some())
            .field("color_mode", &self.color_mode)
            .field("rich_override_paths", &self.rich_override_paths.len())
            .field("other", &self.other.keys().collect::<Vec<_>>())
            .field("rejected_keys", &self.rejected_keys)
            .finish()
    }
}

/// A document-library record (`LibraryRecord` in document-library/types.ts).
#[derive(Clone, PartialEq)]
pub struct LibraryRecord {
    pub id: String,
    pub name: String,
    pub format: String,
    pub bytes: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    pub exported_revision: Option<i64>,
    pub tags: Vec<String>,
    pub collection: Option<String>,
    pub extracted_text: Option<String>,
}

impl std::fmt::Debug for LibraryRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LibraryRecord").field("id", &self.id).field("format", &self.format).field("bytes", &self.bytes.len()).finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryRecord {
    pub document_id: String,
    pub revision: i64,
    pub saved_at: i64,
    pub record: LibraryRecord,
}

#[derive(Debug, Default, Clone)]
pub struct DocumentLibrary {
    pub documents: Vec<LibraryRecord>,
    pub recovery: Vec<RecoveryRecord>,
}

/// Everything the migration carries over, typed. `Debug` prints the report only.
#[derive(Default)]
pub struct ElectronData {
    pub settings: MarkieSettings,
    /// The vault snapshot, validated exactly as storage.ts would. The device slot is kept;
    /// its Keychain half is not migrated (see MIGRATION.md).
    pub vault: Option<StoredVault>,
    pub library: Option<DocumentLibrary>,
    pub report: Report,
}

impl std::fmt::Debug for ElectronData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ElectronData").field("report", &self.report).finish_non_exhaustive()
    }
}

/// What was found, by count and name only. Safe to log.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub local_storage_origins: Vec<String>,
    pub markie_keys: Vec<String>,
    pub foreign_keys: usize,
    pub indexeddb_databases: Vec<String>,
    pub vault_records: Option<usize>,
    pub vault_has_device_slot: bool,
    pub vault_from_blob: bool,
    pub library_documents: Option<usize>,
    pub library_recovery: Option<usize>,
    pub torn_logs: usize,
}

const LIBRARY_FORMATS: &[&str] = &["markdown", "darkmown", "text", "csv", "json", "yaml", "xml", "docx", "doc", "rtf", "odt"];
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn settings_from(keys: &BTreeMap<String, String>) -> MarkieSettings {
    let (cloud_origin, _) = cloud();
    let mut s = MarkieSettings::default();
    let primary = keys.get("markie.server.v1").map(|v| canonical_origin(v.trim_end_matches('/')));
    let primary_origin = primary.clone().unwrap_or_else(|| cloud_origin.clone());
    s.primary_server = primary.filter(|p| *p != cloud_origin);

    // A principal binding is believed only for exactly the stored token at exactly that server.
    let binding = |key: &str, token: &str, origin: &str| -> Option<String> {
        let v: Value = serde_json::from_str(keys.get(key)?).ok()?;
        let ok = v["token"].as_str() == Some(token) && v["serverURL"].as_str().map(canonical_origin).as_deref() == Some(origin);
        ok.then(|| v["userId"].as_str().map(String::from)).flatten()
    };
    if let Some(token) = keys.get("markie.token.v1").filter(|t| !t.is_empty()) {
        s.sessions.push(ServerSession {
            user_id: binding("markie.auth.principal.v1", token, &primary_origin),
            origin: primary_origin.clone(),
            token: token.clone(),
            primary: true,
        });
    }
    for (key, value) in keys {
        if let Some(origin) = key.strip_prefix("markie.token.v1@") {
            let origin = canonical_origin(origin);
            if value.is_empty() || origin == primary_origin {
                continue;
            }
            s.sessions.push(ServerSession {
                user_id: binding(&format!("markie.auth.principal.v1@{}", key.trim_start_matches("markie.token.v1@")), value, &origin),
                origin,
                token: value.clone(),
                primary: false,
            });
        }
    }
    for (key, value) in keys {
        match key.as_str() {
            "markie.token.v1" | "markie.server.v1" | "markie.auth.principal.v1" => {}
            // A sign-in nonce from an unfinished browser sign-in: single use, never carried over.
            "markie.authstate.v1" => {}
            "markie.themes.v1" => match serde_json::from_str::<Value>(value) {
                Ok(v) if v["activeId"].is_string() => s.themes = Some(v),
                _ => s.rejected_keys.push(key.clone()),
            },
            "markie.colormode.v1" => match value.as_str() {
                "system" => s.color_mode = Some(ColorMode::System),
                "light" => s.color_mode = Some(ColorMode::Light),
                "dark" => s.color_mode = Some(ColorMode::Dark),
                _ => s.rejected_keys.push(key.clone()),
            },
            k if k.starts_with("markie.token.v1@") || k.starts_with("markie.auth.principal.v1@") => {}
            k if k.starts_with("markie.richoverride.v1:") => {
                if value == "1" {
                    s.rich_override_paths.push(k["markie.richoverride.v1:".len()..].to_string());
                }
            }
            k if k.starts_with("markie.") => {
                s.other.insert(key.clone(), value.clone());
            }
            _ => {}
        }
    }
    s
}

fn bad(what: &str) -> MigrateError {
    MigrateError::Unsupported(format!("document library: {what}"))
}

fn safe_int(v: Option<&JsValue>) -> Option<i64> {
    match v {
        Some(JsValue::Number(n)) if n.fract() == 0.0 && n.abs() <= MAX_SAFE => Some(*n as i64),
        _ => None,
    }
}

fn string(v: Option<&JsValue>) -> Option<String> {
    match v {
        Some(JsValue::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn keys_of(v: &JsValue) -> Vec<&str> {
    match v {
        JsValue::Object(props) => props.iter().map(|(k, _)| k.as_str()).collect(),
        _ => Vec::new(),
    }
}

/// `validateRecord` in document-library/model.ts, minus the byte budget (a migration keeps everything).
fn library_record(v: &JsValue) -> Result<LibraryRecord> {
    const ALLOWED: &[&str] = &["schemaVersion", "id", "name", "format", "bytes", "createdAt", "updatedAt", "revision", "exportedRevision", "tags", "collection", "extractedText"];
    if !matches!(v, JsValue::Object(_)) || keys_of(v).iter().any(|k| !ALLOWED.contains(k)) {
        return Err(bad("unexpected record fields"));
    }
    if safe_int(v.get("schemaVersion")) != Some(1) {
        return Err(bad("unsupported schema"));
    }
    let id = string(v.get("id")).filter(|id| {
        let b = id.as_bytes();
        !b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(c))
    });
    let format = string(v.get("format")).filter(|f| LIBRARY_FORMATS.contains(&f.as_str()));
    let bytes = match v.get("bytes") {
        Some(JsValue::Uint8Array(b)) => Some(b.clone()),
        _ => None,
    };
    let tags = match v.get("tags") {
        Some(JsValue::Array(items)) => items.iter().map(|t| string(Some(t))).collect::<Option<Vec<_>>>(),
        _ => None,
    };
    let collection = match v.get("collection") {
        Some(JsValue::Null) => Some(None),
        Some(JsValue::String(s)) => Some(Some(s.clone())),
        _ => None,
    };
    let exported = match v.get("exportedRevision") {
        Some(JsValue::Null) => Some(None),
        other => safe_int(other).map(Some),
    };
    let extracted_text = match v.get("extractedText") {
        None => Some(None),
        Some(JsValue::String(s)) => Some(Some(s.clone())),
        _ => None,
    };
    let (Some(id), Some(name), Some(format), Some(bytes), Some(tags), Some(collection), Some(exported_revision), Some(extracted_text)) =
        (id, string(v.get("name")), format, bytes, tags, collection, exported, extracted_text)
    else {
        return Err(bad("invalid record field"));
    };
    let (Some(created_at), Some(updated_at), Some(revision)) = (safe_int(v.get("createdAt")), safe_int(v.get("updatedAt")), safe_int(v.get("revision"))) else {
        return Err(bad("invalid record number"));
    };
    if created_at < 0 || updated_at < created_at || revision < 1 || exported_revision.is_some_and(|e| e < 1 || e > revision) {
        return Err(bad("invalid revision or timestamp"));
    }
    Ok(LibraryRecord { id, name, format, bytes, created_at, updated_at, revision, exported_revision, tags, collection, extracted_text })
}

fn recovery_record(v: &JsValue) -> Result<RecoveryRecord> {
    const ALLOWED: &[&str] = &["schemaVersion", "documentId", "revision", "savedAt", "record"];
    if keys_of(v).iter().any(|k| !ALLOWED.contains(k)) || safe_int(v.get("schemaVersion")) != Some(1) {
        return Err(bad("unexpected recovery fields"));
    }
    let record = library_record(v.get("record").ok_or_else(|| bad("recovery without record"))?)?;
    let (Some(document_id), Some(revision), Some(saved_at)) = (string(v.get("documentId")), safe_int(v.get("revision")), safe_int(v.get("savedAt"))) else {
        return Err(bad("invalid recovery field"));
    };
    if document_id != record.id || revision != record.revision || saved_at != record.updated_at {
        return Err(bad("recovery metadata disagrees with its record"));
    }
    Ok(RecoveryRecord { document_id, revision, saved_at, record })
}

fn vault_from(records: &[IdbRecord]) -> Result<Option<StoredVault>> {
    let mut snapshot = None;
    for record in records {
        if record.key != IdbKey::String("snapshot".into()) {
            return Err(MigrateError::Unsupported("vault store holds a key other than \"snapshot\"".into()));
        }
        let json = record.value.to_json()?;
        snapshot = Some(StoredVault::from_value(&json).map_err(|e| MigrateError::Corrupt(format!("vault snapshot: {e}")))?);
    }
    Ok(snapshot)
}

/// Reads a copy made by `copy_profile` (or any folder laid out like userData).
pub fn read_copy(root: &Path) -> Result<ElectronData> {
    ensure_not_live(root, electron_user_data().as_deref())?;
    let mut data = ElectronData::default();

    let ls_dir = root.join(LOCAL_STORAGE_DIR);
    if ls_dir.join("CURRENT").is_file() {
        let ls = local_storage::read(&ls_dir)?;
        data.report.torn_logs += ls.stats.torn_logs;
        data.report.local_storage_origins = ls.origins.keys().cloned().collect();
        if let Some(keys) = ls.origins.get(ELECTRON_ORIGIN) {
            data.report.markie_keys = keys.keys().filter(|k| k.starts_with("markie.")).cloned().collect();
            data.report.foreign_keys = keys.len() - data.report.markie_keys.len();
            data.settings = settings_from(keys);
        }
    }

    let idb_dir = root.join(IDB_LEVELDB_DIR);
    if idb_dir.join("CURRENT").is_file() {
        let origin = read_origin(&idb_dir, &root.join(IDB_BLOB_DIR), &[VAULT_DATABASE, LIBRARY_DATABASE])?;
        data.report.torn_logs += origin.stats.torn_logs;
        data.report.indexeddb_databases = origin.all_database_names.clone();
        if let Some(db) = origin.databases.get(VAULT_DATABASE) {
            let records = db.stores.get("vault").map(Vec::as_slice).unwrap_or(&[]);
            if db.stores.keys().any(|s| s != "vault") {
                return Err(MigrateError::Unsupported("vault database has an unexpected object store".into()));
            }
            data.vault = vault_from(records)?;
            data.report.vault_from_blob = records.iter().any(|r| r.from_blob);
            data.report.vault_records = data.vault.as_ref().map(|v| v.records.len());
            data.report.vault_has_device_slot = data.vault.as_ref().is_some_and(|v| v.device_slot.is_some());
        }
        if let Some(db) = origin.databases.get(LIBRARY_DATABASE) {
            let documents = db.stores.get("documents").map(Vec::as_slice).unwrap_or(&[]);
            let recovery = db.stores.get("recovery").map(Vec::as_slice).unwrap_or(&[]);
            let library = DocumentLibrary {
                documents: documents.iter().map(|r| library_record(&r.value)).collect::<Result<_>>()?,
                recovery: recovery.iter().map(|r| recovery_record(&r.value)).collect::<Result<_>>()?,
            };
            data.report.library_documents = Some(library.documents.len());
            data.report.library_recovery = Some(library.recovery.len());
            data.library = Some(library);
        }
    }
    Ok(data)
}
