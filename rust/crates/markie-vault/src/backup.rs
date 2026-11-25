//! The vault backup file.
//!
//! Version 1 is `src/lib/vault/backup.ts`: one JSON file holding the header
//! and every record exactly as stored. Electron reads and writes it, and
//! Markie RS still writes it when there are no private files.
//!
//! Version 2 adds the private files, still encrypted, and is streamed to disk:
//!
//! ```text
//! MARKIE-VAULT-BACKUP 2\n
//! {"kind":"markie-vault-backup","version":2,"vaultBytes":N,"vaultSha256":"…",
//!  "privateKey":{…key.json…},"files":[{"id":"…","bytes":N,"sha256":"…"},…]}\n
//! <the version 1 backup, exactly vaultBytes bytes>
//! <each private file's .mkpf bytes, in the manifest's order>
//! <SHA-256 of every byte before it, 32 raw bytes>
//! ```
//!
//! `privateKey` is the private-files key wrapped under the passphrase, as
//! `key.json` stores it; the key itself is never written. The `.mkpf` bytes
//! are copied as stored, so their names, folders and contents stay under
//! AES-256-GCM. The manifest holds only random IDs, sizes and digests.
//!
//! Neither version carries the device slot, so both open with the passphrase only.
use crate::envelope::{exact_object, JsObject};
use crate::error::{StorageErrorCode, VaultError, VaultErrorCode};
use crate::private::{open_slot, valid_private_id, write_atomic, PrivateStore, MAX_SLOT_BYTES, MAX_STORED_BYTES};
use crate::repository::VaultRepository;
use crate::storage::{StoredVault, VaultStorage, MAX_ENCRYPTED_CHARACTERS};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

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

/// The newest backup format this build reads and writes.
pub const VAULT_BACKUP_VERSION: u64 = 2;
/// The most private files one backup holds.
pub const MAX_BACKUP_PRIVATE_FILES: usize = 65_536;
const MAGIC: &[u8] = b"MARKIE-VAULT-BACKUP ";
const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
/// The version 1 part's limit in bytes: `vault_backup_text`'s.
const MAX_VAULT_BYTES: usize = VAULT_BACKUP_MAX_CHARACTERS * 4;
const DIGEST: usize = 32;
const CHUNK: usize = 1024 * 1024;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex32(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// One private file inside a version 2 backup: a random ID, its size and digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupPrivateFile {
    pub id: String,
    pub bytes: u64,
    sha256: [u8; 32],
    offset: u64,
}

/// A backup file that passed every check that needs no passphrase: its
/// format, its length and its digests. Holds no plaintext.
#[derive(Debug, Clone)]
pub struct BackupFile {
    pub path: PathBuf,
    pub version: u64,
    vault_text: String,
    private_slot: Option<Vec<u8>>,
    pub files: Vec<BackupPrivateFile>,
}

impl BackupFile {
    /// The vault part, as a version 1 backup.
    pub fn vault_text(&self) -> &str {
        &self.vault_text
    }
    pub fn private_count(&self) -> usize {
        self.files.len()
    }

    /// One private file's stored bytes, checked against its digest again:
    /// the file on disk may have changed since it was read.
    fn read_private(&self, file: &BackupPrivateFile) -> Result<Vec<u8>, VaultError> {
        let mut handle = std::fs::File::open(&self.path).map_err(|_| VaultError::Backup)?;
        handle.seek(SeekFrom::Start(file.offset)).map_err(|_| VaultError::Backup)?;
        let mut bytes = vec![0u8; file.bytes as usize];
        handle.read_exact(&mut bytes).map_err(|_| VaultError::Backup)?;
        if Sha256::digest(&bytes).as_slice() != file.sha256 {
            return Err(VaultError::Backup);
        }
        Ok(bytes)
    }
}

/// What a saved backup holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupSummary {
    pub version: u64,
    pub private_files: usize,
}

/// Streams `fs::File` reads into a digest, chunk by chunk.
fn hash_file(path: &Path) -> Result<(u64, [u8; 32]), VaultError> {
    let mut file = std::fs::File::open(path).map_err(|_| VaultError::from(StorageErrorCode::Unavailable))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|_| VaultError::from(StorageErrorCode::StorageFailed))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((total, hasher.finalize().into()))
}

/// Writes the backup to `dest`: version 1 when there are no private files,
/// else version 2 with every private file streamed in, still encrypted. The
/// file is written to a 0600 temporary file beside `dest`, read back and
/// checked in full, and only then renamed over `dest`.
///
/// The caller holds the private store's lock, so no private file changes
/// meanwhile. The store may be locked: its files are copied, never opened.
pub fn write_vault_backup_file(vault_text: &str, store: &PrivateStore, dest: &Path) -> Result<BackupSummary, VaultError> {
    parse_vault_backup(vault_text)?;
    let ids = store.ids();
    if ids.is_empty() {
        write_atomic(dest, vault_text.as_bytes())?;
        return Ok(BackupSummary { version: 1, private_files: 0 });
    }
    if ids.len() > MAX_BACKUP_PRIVATE_FILES {
        return Err(VaultErrorCode::LimitExceeded.into());
    }
    let slot: Value = serde_json::from_slice(&store.slot_bytes()?).map_err(|_| VaultError::from(StorageErrorCode::Corrupt))?;
    let mut files = Vec::with_capacity(ids.len());
    for id in &ids {
        let (bytes, digest) = hash_file(&store.path_for(id))?;
        if bytes == 0 || bytes as usize > MAX_STORED_BYTES {
            return Err(VaultErrorCode::LimitExceeded.into());
        }
        files.push(json!({ "id": id, "bytes": bytes, "sha256": hex(&digest) }));
    }
    let manifest = json!({
        "kind": "markie-vault-backup",
        "version": VAULT_BACKUP_VERSION,
        "vaultBytes": vault_text.len(),
        "vaultSha256": hex(&Sha256::digest(vault_text.as_bytes())),
        "privateKey": slot,
        "files": files,
    })
    .to_string();

    let dir = dest.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut suffix = [0u8; 8];
    getrandom::fill(&mut suffix).map_err(|_| VaultError::from(VaultErrorCode::Unavailable))?;
    let temp = dir.join(format!(".markie-vault-backup.{}.tmp", hex(&suffix)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = (|| {
        let file = options.open(&temp).map_err(|_| VaultError::from(StorageErrorCode::StorageFailed))?;
        let mut out = std::io::BufWriter::with_capacity(CHUNK, file);
        let mut hasher = Sha256::new();
        let failed = |_| VaultError::from(StorageErrorCode::StorageFailed);
        let mut put = |out: &mut std::io::BufWriter<std::fs::File>, bytes: &[u8]| {
            hasher.update(bytes);
            out.write_all(bytes).map_err(failed)
        };
        put(&mut out, MAGIC)?;
        put(&mut out, format!("{VAULT_BACKUP_VERSION}\n").as_bytes())?;
        put(&mut out, manifest.as_bytes())?;
        put(&mut out, b"\n")?;
        put(&mut out, vault_text.as_bytes())?;
        let mut buf = vec![0u8; CHUNK];
        for (id, entry) in ids.iter().zip(&files) {
            let mut source = std::fs::File::open(store.path_for(id)).map_err(|_| VaultError::from(StorageErrorCode::Conflict))?;
            let mut each = Sha256::new();
            let mut total = 0u64;
            loop {
                let n = source.read(&mut buf).map_err(failed)?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                each.update(&buf[..n]);
                put(&mut out, &buf[..n])?;
            }
            // A private file that changed between the two reads is not copied half-old.
            if Some(total) != entry["bytes"].as_u64() || Some(hex(&each.finalize())) != entry["sha256"].as_str().map(str::to_string) {
                return Err(VaultError::from(StorageErrorCode::Conflict));
            }
        }
        let digest: [u8; 32] = hasher.finalize().into();
        out.write_all(&digest).map_err(failed)?;
        let file = out.into_inner().map_err(|_| VaultError::from(StorageErrorCode::StorageFailed))?;
        file.sync_all().map_err(failed)?;
        drop(file);
        // Read it back in full before it replaces anything at `dest`.
        let check = read_vault_backup_file(&temp)?;
        if check.version != VAULT_BACKUP_VERSION || check.files.len() != ids.len() || check.vault_text != vault_text {
            return Err(VaultError::from(StorageErrorCode::Corrupt));
        }
        std::fs::rename(&temp, dest).map_err(failed)?;
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written?;
    Ok(BackupSummary { version: VAULT_BACKUP_VERSION, private_files: ids.len() })
}

/// Reads and checks a backup of any version without the passphrase. Version
/// 2 is read in one streamed pass: its length must match the manifest and
/// every digest must match, so a truncated or altered file is refused here.
pub fn read_vault_backup_file(path: &Path) -> Result<BackupFile, VaultError> {
    let file = std::fs::File::open(path).map_err(|_| VaultError::Backup)?;
    let len = file.metadata().map_err(|_| VaultError::Backup)?.len();
    let mut reader = BufReader::with_capacity(CHUNK, file);
    let starts_with_magic = reader.fill_buf().map_err(|_| VaultError::Backup)?.starts_with(MAGIC);
    if !starts_with_magic {
        // Version 1, exactly as before: one JSON document within the old limit.
        if len as usize > VAULT_BACKUP_MAX_CHARACTERS {
            return Err(VaultError::Backup);
        }
        let mut bytes = Vec::with_capacity(len as usize);
        reader.read_to_end(&mut bytes).map_err(|_| VaultError::Backup)?;
        let text = vault_backup_text(&bytes)?;
        return match parse_vault_backup(text) {
            Ok(_) => Ok(BackupFile { path: path.to_path_buf(), version: 1, vault_text: text.to_string(), private_slot: None, files: Vec::new() }),
            Err(_) if declares_newer_version(text) => Err(VaultError::BackupTooNew),
            Err(e) => Err(e),
        };
    }
    let mut hasher = Sha256::new();
    let mut line = Vec::new();
    (&mut reader).take(MAGIC.len() as u64 + 21).read_until(b'\n', &mut line).map_err(|_| VaultError::Backup)?;
    hasher.update(&line);
    let version = line
        .strip_prefix(MAGIC)
        .and_then(|rest| rest.strip_suffix(b"\n"))
        .filter(|digits| !digits.is_empty() && digits.iter().all(u8::is_ascii_digit))
        .and_then(|digits| std::str::from_utf8(digits).ok()?.parse::<u64>().ok())
        .ok_or(VaultError::Backup)?;
    if version > VAULT_BACKUP_VERSION {
        return Err(VaultError::BackupTooNew);
    }
    if version != VAULT_BACKUP_VERSION {
        return Err(VaultError::Backup);
    }
    let mut manifest_line = Vec::new();
    (&mut reader).take(MAX_MANIFEST_BYTES as u64 + 1).read_until(b'\n', &mut manifest_line).map_err(|_| VaultError::Backup)?;
    if manifest_line.pop() != Some(b'\n') {
        return Err(VaultError::Backup);
    }
    hasher.update(&manifest_line);
    hasher.update(b"\n");
    let manifest = parse_manifest(&manifest_line).ok_or(VaultError::Backup)?;
    let mut offset = (line.len() + manifest_line.len() + 1) as u64;
    let expected = manifest.files.iter().try_fold(offset + manifest.vault_bytes as u64 + DIGEST as u64, |sum, f| sum.checked_add(f.bytes));
    if expected != Some(len) {
        return Err(VaultError::Backup);
    }
    let mut vault_bytes = vec![0u8; manifest.vault_bytes];
    reader.read_exact(&mut vault_bytes).map_err(|_| VaultError::Backup)?;
    hasher.update(&vault_bytes);
    if Sha256::digest(&vault_bytes).as_slice() != manifest.vault_sha256 {
        return Err(VaultError::Backup);
    }
    offset += manifest.vault_bytes as u64;
    let mut files = Vec::with_capacity(manifest.files.len());
    let mut buf = vec![0u8; CHUNK];
    for mut file in manifest.files {
        file.offset = offset;
        let mut each = Sha256::new();
        let mut left = file.bytes;
        while left > 0 {
            let n = left.min(CHUNK as u64) as usize;
            reader.read_exact(&mut buf[..n]).map_err(|_| VaultError::Backup)?;
            hasher.update(&buf[..n]);
            each.update(&buf[..n]);
            left -= n as u64;
        }
        if each.finalize().as_slice() != file.sha256 {
            return Err(VaultError::Backup);
        }
        offset += file.bytes;
        files.push(file);
    }
    let mut trailer = [0u8; DIGEST];
    reader.read_exact(&mut trailer).map_err(|_| VaultError::Backup)?;
    if hasher.finalize().as_slice() != trailer {
        return Err(VaultError::Backup);
    }
    let vault_text = vault_backup_text(&vault_bytes)?.to_string();
    parse_vault_backup(&vault_text)?;
    Ok(BackupFile { path: path.to_path_buf(), version, vault_text, private_slot: manifest.private_slot, files })
}

/// A JSON backup that names itself a Markie vault backup of a later version.
fn declares_newer_version(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return false };
    value.get("kind").and_then(Value::as_str) == Some("markie-vault-backup") && value.get("version").and_then(Value::as_u64).is_some_and(|v| v > 1)
}

struct Manifest {
    vault_bytes: usize,
    vault_sha256: [u8; 32],
    private_slot: Option<Vec<u8>>,
    /// Each file, with a placeholder offset filled in as the body is read.
    files: Vec<BackupPrivateFile>,
}

fn parse_manifest(bytes: &[u8]) -> Option<Manifest> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let map = exact_object(&value, &["kind", "version", "vaultBytes", "vaultSha256", "privateKey", "files"])?;
    if map["kind"].as_str() != Some("markie-vault-backup") || map["version"].as_u64() != Some(VAULT_BACKUP_VERSION) {
        return None;
    }
    let vault_bytes = usize::try_from(map["vaultBytes"].as_u64()?).ok().filter(|n| (1..=MAX_VAULT_BYTES).contains(n))?;
    let vault_sha256 = unhex32(map["vaultSha256"].as_str()?)?;
    let list = map["files"].as_array()?;
    if list.len() > MAX_BACKUP_PRIVATE_FILES {
        return None;
    }
    let private_slot = match &map["privateKey"] {
        Value::Null if list.is_empty() => None,
        slot @ Value::Object(_) => Some(slot.to_string().into_bytes()).filter(|s| s.len() <= MAX_SLOT_BYTES),
        _ => return None,
    };
    if private_slot.is_none() && !list.is_empty() {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut files = Vec::with_capacity(list.len());
    for entry in list {
        let entry = exact_object(entry, &["id", "bytes", "sha256"])?;
        let id = entry["id"].as_str().filter(|id| valid_private_id(id))?.to_string();
        let bytes = entry["bytes"].as_u64().filter(|n| (1..=MAX_STORED_BYTES as u64).contains(n))?;
        let sha256 = unhex32(entry["sha256"].as_str()?)?;
        if !seen.insert(id.clone()) {
            return None;
        }
        files.push(BackupPrivateFile { id, bytes, sha256, offset: 0 });
    }
    Some(Manifest { vault_bytes, vault_sha256, private_slot, files })
}

/// What a restore did with the backup's private files.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreReport {
    /// The vault this restore replaced, so its Touch ID secret can go.
    pub replaced_vault_id: Option<String>,
    /// Private files that were not on this Mac and now are.
    pub private_restored: usize,
    /// Private files already here with the same ID, name and bytes: left as they are.
    pub private_already_here: usize,
    /// Private files whose ID was taken here by a different file: both kept,
    /// the backup's copy under a new ID.
    pub private_kept_both: usize,
}

impl RestoreReport {
    /// Private files the restore added to this Mac.
    pub fn private_came_back(&self) -> usize {
        self.private_restored + self.private_kept_both
    }
}

/// Restores a checked backup: the vault, and for version 2 its private files.
///
/// Nothing is written until the passphrase opens the vault and the
/// private-files key, every record authenticates, and every private file
/// decrypts under the backup's key. Private files are merged into this Mac's
/// store, never overwritten: one with the same ID and the same content is
/// skipped, one with the same ID and other content is kept beside it. Any
/// failure removes what the restore added and puts `key.json` back.
pub fn restore_vault_backup_file<S: VaultStorage>(
    repo: &mut VaultRepository<S>,
    store: &mut PrivateStore,
    backup: &BackupFile,
    passphrase: &str,
    replace: bool,
) -> Result<RestoreReport, VaultError> {
    let vault = parse_vault_backup(&backup.vault_text)?;
    let plan = repo.plan_restore(&vault, passphrase, replace)?;
    if backup.files.is_empty() {
        return Ok(RestoreReport { replaced_vault_id: repo.commit_restore(plan)?, ..RestoreReport::default() });
    }
    let slot = backup.private_slot.as_deref().ok_or(VaultError::Backup)?;
    let backup_key = open_slot(slot, passphrase)?;
    let source = PrivateStore::with_key(store.dir(), backup_key.clone());
    // Every file must open before anything is written.
    for file in &backup.files {
        source.open(&file.id, &backup.read_private(file)?)?;
    }

    // The key the merged store ends up under, and the key.json that wraps it
    // under this passphrase, when the one here does not already.
    let previous_slot = if store.has_key() { Some(store.slot_bytes()?) } else { None };
    let local_count = store.count();
    let (target_key, new_slot): (Zeroizing<[u8; 32]>, Option<Vec<u8>>) = match &previous_slot {
        None if local_count > 0 => return Err(StorageErrorCode::Corrupt.into()),
        None => (backup_key.clone(), Some(slot.to_vec())),
        Some(old) => match open_slot(old, passphrase) {
            Ok(key) => (key, None),
            Err(VaultError::Vault(VaultErrorCode::AuthenticationFailed)) => match store.key() {
                // Open in memory under an earlier passphrase: wrap it under this one.
                Ok(key) => {
                    let key = Zeroizing::new(*key);
                    let wrapped = store.wrap_slot(&key, passphrase)?;
                    (key, Some(wrapped))
                }
                Err(_) if local_count == 0 => (backup_key.clone(), Some(slot.to_vec())),
                Err(_) => return Err(VaultError::PrivateFilesLocked),
            },
            Err(e) => return Err(e),
        },
    };

    let target = PrivateStore::with_key(store.dir(), target_key.clone());
    let mut added = Vec::new();
    let mut report = RestoreReport::default();
    let applied = merge_private(&target, &source, backup, new_slot.as_deref(), &mut added, &mut report);
    let rollback = |added: &[String]| {
        for id in added {
            let _ = std::fs::remove_file(target.path_for(id));
        }
        if new_slot.is_some() {
            let _ = store.put_slot_bytes(previous_slot.as_deref());
        }
    };
    if let Err(e) = applied {
        rollback(&added);
        return Err(e);
    }
    match repo.commit_restore(plan) {
        Ok(replaced) => {
            store.adopt_key(target_key);
            report.replaced_vault_id = replaced;
            Ok(report)
        }
        Err(e) => {
            rollback(&added);
            Err(e)
        }
    }
}

fn merge_private(
    target: &PrivateStore,
    source: &PrivateStore,
    backup: &BackupFile,
    new_slot: Option<&[u8]>,
    added: &mut Vec<String>,
    report: &mut RestoreReport,
) -> Result<(), VaultError> {
    if let Some(slot) = new_slot {
        target.put_slot_bytes(Some(slot))?;
    }
    // What is here already, by metadata and size: only those are decrypted to compare.
    let here = if target.ids().is_empty() { Vec::new() } else { target.list()? };
    let identical = |id: &str, doc: &crate::private::PrivateDocument| {
        target.read(id).is_ok_and(|d| d.bytes.as_slice() == doc.bytes.as_slice() && d.metadata == doc.metadata)
    };
    for file in &backup.files {
        let doc = source.open(&file.id, &backup.read_private(file)?)?;
        if target.path_for(&file.id).exists() {
            // The same ID: never overwritten. A copy from an earlier restore counts as here.
            let copy_here = identical(&file.id, &doc)
                || here.iter().any(|e| e.id != file.id && e.metadata == doc.metadata && e.bytes == doc.bytes.len() && identical(&e.id, &doc));
            if copy_here {
                report.private_already_here += 1;
            } else {
                added.push(target.add(&doc.bytes, &doc.metadata)?);
                report.private_kept_both += 1;
            }
        } else {
            target.write_verified(&file.id, &doc.bytes, &doc.metadata, true)?;
            added.push(file.id.clone());
            report.private_restored += 1;
        }
    }
    Ok(())
}
