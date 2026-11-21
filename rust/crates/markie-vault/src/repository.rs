//! `VaultRepository` from `src/lib/vault/repository.ts`, synchronous.
//!
//! The TypeScript serializes work through a promise queue and an epoch; here
//! the caller holds the repository behind one lock, which gives the same
//! one-operation-at-a-time rule. Failed saves keep their encrypted envelope in
//! memory as recovery, and a later save or remove carries it, as in Electron.
use crate::backup::{parse_vault_backup, serialize_vault_backup};
use crate::device::DeviceKeeper;
use crate::envelope::{limits, VaultDocumentEnvelope, VaultDocumentMetadata, VaultHeader};
use crate::error::{DeviceFailure, StorageErrorCode, VaultError, VaultErrorCode};
use crate::storage::{StoredRecord, StoredVault, VaultStorage};
use crate::vault::{create_vault_document_id, DecryptedVaultDocument, Vault};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultEntry {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub bytes: usize,
    pub recovery: bool,
}

pub struct VaultReadResult {
    pub document: DecryptedVaultDocument,
    pub recovery: bool,
}

pub struct VaultRepository<S: VaultStorage> {
    pub storage: S,
    vault: Vault,
    snapshot: Option<StoredVault>,
    /// Insertion-ordered like a JavaScript Map.
    recovery: Vec<(String, String)>,
}

fn header_id(header: &str) -> Result<String, VaultError> {
    Ok(VaultHeader::parse(header)?.vault_id)
}

impl<S: VaultStorage> VaultRepository<S> {
    pub fn new(storage: S) -> Self {
        Self { storage, vault: Vault::new(), snapshot: None, recovery: Vec::new() }
    }
    pub fn unlocked(&self) -> bool {
        self.vault.is_unlocked()
    }
    pub fn has_volatile_recovery(&self) -> bool {
        !self.recovery.is_empty()
    }
    pub fn vault_id(&self) -> Option<String> {
        self.snapshot.as_ref().and_then(StoredVault::vault_id)
    }
    pub fn has_device_slot(&self) -> bool {
        self.snapshot.as_ref().is_some_and(|s| s.device_slot.is_some())
    }
    pub fn lock(&mut self) {
        self.vault.lock();
    }

    fn current(&self) -> Result<&StoredVault, VaultError> {
        match (&self.snapshot, self.vault.is_unlocked()) {
            (Some(s), true) => Ok(s),
            _ => Err(VaultErrorCode::Locked.into()),
        }
    }

    fn recovery_get(&self, id: &str) -> Option<&String> {
        self.recovery.iter().find(|(k, _)| k == id).map(|(_, v)| v)
    }

    fn recovery_set(&mut self, id: &str, envelope: String) {
        match self.recovery.iter_mut().find(|(k, _)| k == id) {
            Some(slot) => slot.1 = envelope,
            None => self.recovery.push((id.to_string(), envelope)),
        }
    }

    /// Loads the stored vault without unlocking. True when one exists.
    pub fn inspect(&mut self) -> Result<bool, VaultError> {
        self.snapshot = self.storage.load()?.map(StoredVault::validate).transpose()?;
        Ok(self.snapshot.is_some())
    }

    pub fn create(&mut self, passphrase: &str) -> Result<(), VaultError> {
        if self.unlocked() {
            return Err(VaultErrorCode::Busy.into());
        }
        if self.storage.load()?.is_some() {
            return Err(StorageErrorCode::Conflict.into());
        }
        let result = (|| {
            let header = self.vault.create(passphrase)?;
            let next = StoredVault { revision: 1, header, records: Vec::new(), device_slot: None };
            self.storage.commit(None, &next, false)?;
            self.snapshot = Some(next.validate()?);
            Ok(())
        })();
        if result.is_err() {
            self.vault.lock();
        }
        result
    }

    pub fn unlock(&mut self, passphrase: &str) -> Result<(), VaultError> {
        if self.unlocked() {
            return Err(VaultErrorCode::Busy.into());
        }
        let snapshot = self.storage.load()?.ok_or(VaultError::from(StorageErrorCode::Unavailable))?.validate()?;
        self.vault.unlock(&snapshot.header, passphrase)?;
        self.adopt(snapshot);
        Ok(())
    }

    /// Touch ID path. A missing, declined or stale keychain secret leaves the vault locked.
    pub fn unlock_with_device(&mut self, keeper: &dyn DeviceKeeper) -> Result<(), VaultError> {
        if self.unlocked() {
            return Err(VaultErrorCode::Busy.into());
        }
        let snapshot = self.storage.load()?.ok_or(VaultError::from(StorageErrorCode::Unavailable))?.validate()?;
        self.snapshot = Some(snapshot.clone());
        let slot = snapshot.device_slot.clone().ok_or(VaultError::from(DeviceFailure::Missing))?;
        let secret = keeper.release(&header_id(&snapshot.header)?).map_err(VaultError::from)?;
        match self.vault.unlock_with_device_secret(&snapshot.header, &slot, secret.as_ref()) {
            Ok(()) => {
                self.adopt(snapshot);
                Ok(())
            }
            Err(VaultError::Vault(VaultErrorCode::AuthenticationFailed)) => Err(DeviceFailure::Stale.into()),
            Err(e) => Err(e),
        }
    }

    /// Turns on Touch ID. Needs the passphrase again; the vault must be unlocked.
    pub fn enroll_device(&mut self, passphrase: &str, keeper: &dyn DeviceKeeper) -> Result<(), VaultError> {
        let snapshot = self.current()?.clone();
        let vault_id = header_id(&snapshot.header)?;
        let enrollment = self.vault.enroll_device(&snapshot.header, passphrase)?;
        keeper.store(&vault_id, enrollment.secret.as_ref()).map_err(VaultError::from)?;
        drop(enrollment.secret);
        let next = StoredVault { revision: snapshot.revision + 1, device_slot: Some(enrollment.slot), ..snapshot.without_device_slot() };
        if let Err(e) = self.commit(next) {
            // A keychain secret with no slot opens nothing, but do not leave it behind.
            let _ = keeper.remove(&vault_id);
            return Err(e);
        }
        Ok(())
    }

    pub fn verify_passphrase(&self, passphrase: &str) -> Result<(), VaultError> {
        self.vault.verify_passphrase(&self.current()?.header, passphrase)
    }

    /// Turns off Touch ID: deletes the keychain secret and the stored device slot.
    pub fn remove_device(&mut self, keeper: &dyn DeviceKeeper) -> Result<(), VaultError> {
        let snapshot = self.current()?.clone();
        let removed = keeper.remove(&header_id(&snapshot.header)?);
        if snapshot.device_slot.is_some() {
            self.commit(StoredVault { revision: snapshot.revision + 1, ..snapshot.without_device_slot() })?;
        }
        removed.map_err(VaultError::from)
    }

    /// The stored ciphertext as one backup file. Never the device slot or memory-only recovery.
    pub fn backup(&self) -> Result<String, VaultError> {
        let current = self.current()?;
        let stored = self.storage.load()?.ok_or(VaultError::from(StorageErrorCode::Conflict))?;
        if stored.header != current.header {
            return Err(StorageErrorCode::Conflict.into());
        }
        serialize_vault_backup(&stored.validate()?.without_device_slot())
    }

    /// Replaces storage with a backup, only after its passphrase unlocks it and every
    /// record authenticates. Returns the replaced vault's ID so its keychain secret can go.
    pub fn restore(&mut self, serialized_backup: &str, passphrase: &str, replace: bool) -> Result<Option<String>, VaultError> {
        let backup = parse_vault_backup(serialized_backup)?;
        let current = self.storage.load()?;
        if current.is_some() && !replace {
            return Err(StorageErrorCode::Conflict.into());
        }
        let mut candidate = Vault::new();
        candidate.unlock(&backup.header, passphrase)?;
        for record in &backup.records {
            candidate.decrypt_document(&record.envelope, &record.id)?;
        }
        let next = StoredVault {
            revision: current.as_ref().map_or(0, |c| c.revision) + 1,
            header: backup.header.clone(),
            records: backup.records.clone(),
            device_slot: None,
        }
        .validate()?;
        self.storage.commit(current.as_ref().map(|c| c.revision), &next, true)?;
        self.vault.lock();
        self.vault = candidate;
        self.adopt(next);
        current.map(|c| header_id(&c.header)).transpose()
    }

    fn adopt(&mut self, validated: StoredVault) {
        // An externally replaced vault must never receive another vault's draft.
        if let Some(vault_id) = validated.vault_id() {
            self.recovery.retain(|(_, envelope)| VaultDocumentEnvelope::parse(envelope).is_ok_and(|e| e.vault_id == vault_id));
        }
        self.snapshot = Some(validated);
    }

    fn commit(&mut self, next: StoredVault) -> Result<(), VaultError> {
        let next = next.validate()?;
        let previous = self.current()?.revision;
        self.storage.commit(Some(previous), &next, false)?;
        self.snapshot = Some(next);
        Ok(())
    }

    /// Saves a new document (`id: None`) or replaces one. Returns its ID.
    pub fn save(&mut self, id: Option<&str>, bytes: &[u8], metadata: &VaultDocumentMetadata) -> Result<String, VaultError> {
        if bytes.len() > limits::CONTENT_BYTES {
            return Err(VaultErrorCode::LimitExceeded.into());
        }
        let snapshot = self.current()?.clone();
        let document_id = match id {
            Some(id) => id.to_string(),
            None => create_vault_document_id()?,
        };
        if id.is_some() && !snapshot.records.iter().any(|r| r.id == document_id) && self.recovery_get(&document_id).is_none() {
            return Err(StorageErrorCode::Conflict.into());
        }
        let envelope = self.vault.encrypt_document(&document_id, bytes, metadata)?;
        let mut merged: Vec<StoredRecord> = snapshot.records.clone();
        let mut put = |rid: &str, env: &str| match merged.iter_mut().find(|r| r.id == rid) {
            Some(r) => r.envelope = env.to_string(),
            None => merged.push(StoredRecord { id: rid.to_string(), envelope: env.to_string() }),
        };
        for (rid, env) in &self.recovery {
            put(rid, env);
        }
        put(&document_id, &envelope);
        let next = StoredVault { revision: snapshot.revision + 1, records: merged, ..snapshot }.validate()?;
        self.recovery_set(&document_id, envelope);
        if let Err(failure) = self.commit(next) {
            return Err(VaultError::Save { document_id, failure: Box::new(failure) });
        }
        self.recovery.clear();
        Ok(document_id)
    }

    pub fn read(&self, id: &str) -> Result<VaultReadResult, VaultError> {
        let snapshot = self.current()?;
        let recovery = self.recovery_get(id);
        let envelope = recovery
            .or_else(|| snapshot.records.iter().find(|r| r.id == id).map(|r| &r.envelope))
            .ok_or(VaultError::from(StorageErrorCode::Conflict))?;
        Ok(VaultReadResult { document: self.vault.decrypt_document(envelope, id)?, recovery: recovery.is_some() })
    }

    /// Entries whose name contains `query`, sorted by name.
    pub fn list(&self, query: &str) -> Result<Vec<VaultEntry>, VaultError> {
        let snapshot = self.current()?;
        let mut records: Vec<(String, String)> = snapshot.records.iter().map(|r| (r.id.clone(), r.envelope.clone())).collect();
        for (id, env) in &self.recovery {
            match records.iter_mut().find(|(k, _)| k == id) {
                Some(r) => r.1 = env.clone(),
                None => records.push((id.clone(), env.clone())),
            }
        }
        let query = query.to_lowercase();
        let mut entries = Vec::new();
        for (id, envelope) in records {
            let document = self.vault.decrypt_document(&envelope, &id)?;
            if document.metadata.name.to_lowercase().contains(&query) {
                entries.push(VaultEntry {
                    recovery: self.recovery_get(&id).is_some(),
                    id,
                    name: document.metadata.name,
                    media_type: document.metadata.media_type,
                    bytes: document.bytes.len(),
                });
            }
        }
        // localeCompare differs from byte order for some names; the UI sorts again for display.
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    pub fn remove(&mut self, id: &str) -> Result<(), VaultError> {
        let snapshot = self.current()?.clone();
        if !snapshot.records.iter().any(|r| r.id == id) && self.recovery_get(id).is_none() {
            return Err(StorageErrorCode::Conflict.into());
        }
        let records = snapshot.records.iter().filter(|r| r.id != id).cloned().collect();
        self.commit(StoredVault { revision: snapshot.revision + 1, records, ..snapshot })?;
        self.recovery.retain(|(k, _)| k != id);
        Ok(())
    }

    pub fn discard_recovery(&mut self, id: &str) -> Result<(), VaultError> {
        self.current()?;
        self.recovery.retain(|(k, _)| k != id);
        Ok(())
    }
}
