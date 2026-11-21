//! The stored vault snapshot, `StoredVault` in `src/lib/vault/storage.ts`.
//!
//! Electron keeps it as one structured-clone value under the key "snapshot" in
//! the IndexedDB database `markie-encrypted-vault`. Markie RS keeps the same
//! fields as one JSON file, replaced atomically.
use crate::envelope::{exact_object, JsObject, VaultDeviceSlot, VaultDocumentEnvelope, VaultHeader};
use crate::error::{StorageErrorCode, VaultError};
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const VAULT_DATABASE_NAME: &str = "markie-encrypted-vault";
pub const MAX_RECORDS: usize = 128;
pub const MAX_ENCRYPTED_CHARACTERS: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRecord {
    pub id: String,
    pub envelope: String,
}

/// Only ciphertext and non-secret, opaque IDs and revisions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredVault {
    pub revision: u64,
    pub header: String,
    pub records: Vec<StoredRecord>,
    /// Absent from vaults written before Touch ID.
    pub device_slot: Option<String>,
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

impl StoredVault {
    /// `validateStoredVault`: any failure is `corrupt`.
    pub fn validate(self) -> Result<Self, VaultError> {
        self.check().map_err(|_| VaultError::from(StorageErrorCode::Corrupt))?;
        Ok(self)
    }

    fn check(&self) -> Result<(), ()> {
        if self.revision < 1 || self.revision > MAX_SAFE_INTEGER || self.records.len() > MAX_RECORDS {
            return Err(());
        }
        let header = VaultHeader::parse(&self.header).map_err(|_| ())?;
        let mut ids = HashSet::new();
        let mut size = self.header.len();
        for record in &self.records {
            size += record.envelope.len();
            if size > MAX_ENCRYPTED_CHARACTERS {
                return Err(());
            }
            let envelope = VaultDocumentEnvelope::parse(&record.envelope).map_err(|_| ())?;
            if envelope.vault_id != header.vault_id || envelope.document_id != record.id || !ids.insert(record.id.clone()) {
                return Err(());
            }
        }
        if let Some(slot) = &self.device_slot
            && VaultDeviceSlot::parse(slot).map_err(|_| ())?.vault_id != header.vault_id
        {
            return Err(());
        }
        Ok(())
    }

    /// Reads the structured-clone shape (as JSON) with the exact keys storage.ts allows.
    pub fn from_value(value: &Value) -> Result<Self, VaultError> {
        Self::from_value_inner(value).ok_or(VaultError::from(StorageErrorCode::Corrupt))?.validate()
    }

    fn from_value_inner(value: &Value) -> Option<Self> {
        let with_slot = value.as_object()?.contains_key("deviceSlot");
        let keys: &[&str] = if with_slot {
            &["version", "revision", "header", "records", "deviceSlot"]
        } else {
            &["version", "revision", "header", "records"]
        };
        let map = exact_object(value, keys)?;
        if map["version"].as_u64() != Some(1) {
            return None;
        }
        let records = map["records"].as_array()?;
        if records.len() > MAX_RECORDS {
            return None;
        }
        let records = records
            .iter()
            .map(|r| {
                let r = exact_object(r, &["id", "envelope"])?;
                Some(StoredRecord { id: r["id"].as_str()?.to_string(), envelope: r["envelope"].as_str()?.to_string() })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(StoredVault {
            revision: map["revision"].as_u64()?,
            header: map["header"].as_str()?.to_string(),
            records,
            device_slot: if with_slot { Some(map["deviceSlot"].as_str()?.to_string()) } else { None },
        })
    }

    pub(crate) fn records_json(&self) -> String {
        let mut out = String::from("[");
        for (i, r) in self.records.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&JsObject::new().str("id", &r.id).str("envelope", &r.envelope).finish());
        }
        out.push(']');
        out
    }

    /// The on-disk JSON for Markie RS, in storage.ts's key order.
    pub fn to_json(&self) -> String {
        let mut o = JsObject::new()
            .num("version", 1)
            .num("revision", self.revision)
            .str("header", &self.header)
            .raw("records", &self.records_json());
        if let Some(slot) = &self.device_slot {
            o = o.str("deviceSlot", slot);
        }
        o.finish()
    }

    pub fn from_json(text: &str) -> Result<Self, VaultError> {
        let value: Value = serde_json::from_str(text).map_err(|_| VaultError::from(StorageErrorCode::Corrupt))?;
        Self::from_value(&value)
    }

    pub fn vault_id(&self) -> Option<String> {
        VaultHeader::parse(&self.header).ok().map(|h| h.vault_id)
    }

    pub fn without_device_slot(&self) -> Self {
        StoredVault { device_slot: None, ..self.clone() }
    }
}

pub trait VaultStorage: Send + Sync {
    fn load(&self) -> Result<Option<StoredVault>, VaultError>;
    /// Atomic. A revision mismatch, or a header swap without `replace_header`, changes nothing.
    fn commit(&self, expected_revision: Option<u64>, next: &StoredVault, replace_header: bool) -> Result<(), VaultError>;
}

fn check_commit(previous: Option<&StoredVault>, expected: Option<u64>, next: &StoredVault, replace_header: bool) -> Result<(), VaultError> {
    if next.revision != expected.unwrap_or(0) + 1
        || previous.map(|p| p.revision) != expected
        || previous.is_some_and(|p| p.header != next.header && !replace_header)
    {
        return Err(StorageErrorCode::Conflict.into());
    }
    Ok(())
}

#[derive(Default)]
pub struct MemoryVaultStorage {
    value: Mutex<Option<StoredVault>>,
}

impl MemoryVaultStorage {
    pub fn new(initial: Option<StoredVault>) -> Self {
        Self { value: Mutex::new(initial) }
    }
}

impl VaultStorage for MemoryVaultStorage {
    fn load(&self) -> Result<Option<StoredVault>, VaultError> {
        Ok(self.value.lock().unwrap().clone())
    }
    fn commit(&self, expected: Option<u64>, next: &StoredVault, replace_header: bool) -> Result<(), VaultError> {
        let next = next.clone().validate()?;
        let mut guard = self.value.lock().unwrap();
        check_commit(guard.as_ref(), expected, &next, replace_header)?;
        *guard = Some(next);
        Ok(())
    }
}

/// One JSON file, written to a temporary file, synced, then renamed over the old one.
pub struct FileVaultStorage {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileVaultStorage {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), lock: Mutex::new(()) }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Result<Option<StoredVault>, VaultError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => StoredVault::from_json(&text).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(StorageErrorCode::StorageFailed.into()),
        }
    }
}

impl VaultStorage for FileVaultStorage {
    fn load(&self) -> Result<Option<StoredVault>, VaultError> {
        let _guard = self.lock.lock().unwrap();
        self.read()
    }

    fn commit(&self, expected: Option<u64>, next: &StoredVault, replace_header: bool) -> Result<(), VaultError> {
        let next = next.clone().validate()?;
        let _guard = self.lock.lock().unwrap();
        check_commit(self.read()?.as_ref(), expected, &next, replace_header)?;
        let failed = |_| VaultError::from(StorageErrorCode::StorageFailed);
        let dir = self.path.parent().ok_or(VaultError::from(StorageErrorCode::Unavailable))?;
        std::fs::create_dir_all(dir).map_err(failed)?;
        let mut temp = tempfile_in(dir).map_err(failed)?;
        temp.1.write_all(next.to_json().as_bytes()).map_err(failed)?;
        temp.1.sync_all().map_err(failed)?;
        drop(temp.1);
        std::fs::rename(&temp.0, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(&temp.0);
            failed(e)
        })?;
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }
}

fn tempfile_in(dir: &Path) -> std::io::Result<(PathBuf, std::fs::File)> {
    let suffix = crate::envelope::encode_base64(&crate::vault::random::<9>().map_err(|_| std::io::Error::other("random"))?);
    let path = dir.join(format!(".vault.{suffix}.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok((path.clone(), options.open(path)?))
}
