//! The vault backup file, `src/lib/vault/backup.ts`.
//!
//! One JSON file holding the header and every record exactly as stored. It
//! carries no device slot, so it opens with the passphrase only, anywhere.
use crate::envelope::{exact_object, JsObject};
use crate::error::VaultError;
use crate::storage::{StoredVault, MAX_ENCRYPTED_CHARACTERS};
use serde_json::Value;

pub const VAULT_BACKUP_FILE_NAME: &str = "Markie Vault.markievault";
pub const VAULT_BACKUP_MEDIA_TYPE: &str = "application/octet-stream";
pub const VAULT_BACKUP_MAX_CHARACTERS: usize = MAX_ENCRYPTED_CHARACTERS + 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultBackup {
    pub header: String,
    pub records: Vec<crate::storage::StoredRecord>,
}

impl VaultBackup {
    /// Revision 1, no device slot: what a restore commits.
    pub fn to_stored(&self) -> StoredVault {
        StoredVault { revision: 1, header: self.header.clone(), records: self.records.clone(), device_slot: None }
    }
}

/// `serializeVaultBackup`.
pub fn serialize_vault_backup(stored: &StoredVault) -> Result<String, VaultError> {
    let valid = stored.clone().validate()?;
    Ok(JsObject::new()
        .str("kind", "markie-vault-backup")
        .num("version", 1)
        .str("header", &valid.header)
        .raw("records", &valid.records_json())
        .finish())
}

/// `parseVaultBackup`: exact keys, canonical encoding, every header and record validated.
pub fn parse_vault_backup(serialized: &str) -> Result<VaultBackup, VaultError> {
    parse(serialized).ok_or(VaultError::Backup)
}

fn parse(serialized: &str) -> Option<VaultBackup> {
    if serialized.len() > VAULT_BACKUP_MAX_CHARACTERS && crate::envelope::js_length(serialized) > VAULT_BACKUP_MAX_CHARACTERS {
        return None;
    }
    let value: Value = serde_json::from_str(serialized).ok()?;
    let map = exact_object(&value, &["kind", "version", "header", "records"])?;
    if map["kind"].as_str() != Some("markie-vault-backup") || map["version"].as_u64() != Some(1) {
        return None;
    }
    let as_stored = serde_json::json!({ "version": 1, "revision": 1, "header": map["header"], "records": map["records"] });
    let stored = StoredVault::from_value(&as_stored).ok()?;
    if serialize_vault_backup(&stored).ok()? != serialized {
        return None;
    }
    Some(VaultBackup { header: stored.header, records: stored.records })
}

/// `vaultBackupText`: strict UTF-8; one leading byte-order mark is dropped, as TextDecoder does.
pub fn vault_backup_text(bytes: &[u8]) -> Result<&str, VaultError> {
    if bytes.len() > VAULT_BACKUP_MAX_CHARACTERS * 4 {
        return Err(VaultError::Backup);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| VaultError::Backup)?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(text))
}
