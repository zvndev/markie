//! Private files: whole files moved into the vault, encrypted, so that only
//! Markie can open them. `docs/rust-port/PRIVATE-FILES.md` has the threat model.
//!
//! A private file is not a `vault.json` record. It lives in its own encrypted
//! file under `private-files/`, under a private-files key that only the vault
//! passphrase opens:
//!
//! - `private-files/key.json` holds the private-files key (32 random bytes)
//!   under AES-256-GCM, with a key derived from the passphrase by
//!   PBKDF2-HMAC-SHA256 (600k iterations, its own 16-byte salt).
//! - Each `<id>.mkpf` holds one file: a fresh content key per write, wrapped
//!   under the private-files key with AES-KW, then the metadata (name, media
//!   type, original folder) and the bytes, each under AES-256-GCM with its own
//!   IV and additional data that binds the file ID and the wrapped key.
//!
//! The Touch ID device slot opens the vault key, never this one: on this
//! build the device secret sits in the file-based login keychain, which the
//! macOS login password alone unlocks. So a stolen Mac plus the login password
//! still cannot open a private file. A later OS-enforced slot (data protection
//! keychain, `.biometryCurrentSet`) can wrap this key too; see the doc.
//!
//! Nothing here writes plaintext to disk. Every write is checked by reading it
//! back from disk and decrypting it before the caller is told it worked.
use crate::envelope::{decode_base64_checked, encode_base64, limits};
use crate::error::{StorageErrorCode, VaultError, VaultErrorCode};
use crate::vault::{gcm_decrypt, gcm_encrypt, random, validate_passphrase};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// The folder in Markie RS's data folder that holds the private files.
pub const PRIVATE_DIR: &str = "private-files";
/// One private file's largest size. The whole file is held in memory to encrypt it.
pub const PRIVATE_FILE_BYTES: usize = 256 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 16 * 1024;
const KEY_FILE: &str = "key.json";
const EXTENSION: &str = "mkpf";
const MAGIC: &[u8] = b"MARKIE-PRIVATE-FILE 1\n";
const SLOT_CONTEXT: &str = "markie-private-files:v1:slot";
const MIN_ITERATIONS: u32 = 100_000;

/// What a private file remembers about where it came from. Encrypted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivateMetadata {
    pub name: String,
    pub media_type: String,
    /// The folder it was made private from, for Make Not Private.
    pub folder: String,
    /// When it became private, in Unix milliseconds.
    pub made_private_ms: i64,
}

impl PrivateMetadata {
    fn to_bytes(&self) -> Result<Vec<u8>, VaultError> {
        let bytes = serde_json::to_vec(&json!({
            "name": self.name,
            "mediaType": self.media_type,
            "folder": self.folder,
            "madePrivate": self.made_private_ms,
        }))
        .map_err(|_| VaultError::from(VaultErrorCode::InvalidEnvelope))?;
        if bytes.len() > MAX_METADATA_BYTES || self.name.is_empty() || self.name.contains(['/', '\0']) {
            return Err(VaultErrorCode::InvalidEnvelope.into());
        }
        Ok(bytes)
    }

    fn from_bytes(bytes: &[u8]) -> Result<Self, VaultError> {
        let invalid = || VaultError::from(VaultErrorCode::InvalidEnvelope);
        let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(invalid);
        Ok(Self {
            name: text("name")?,
            media_type: text("mediaType")?,
            folder: text("folder")?,
            made_private_ms: value.get("madePrivate").and_then(Value::as_i64).ok_or_else(invalid)?,
        })
    }
}

/// One private file as the vault list shows it. No content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivateEntry {
    pub id: String,
    pub metadata: PrivateMetadata,
    pub bytes: usize,
}

pub struct PrivateDocument {
    pub metadata: PrivateMetadata,
    pub bytes: Zeroizing<Vec<u8>>,
}

/// Never prints plaintext: only its length.
impl std::fmt::Debug for PrivateDocument {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrivateDocument").field("metadata", &self.metadata).field("bytes", &self.bytes.len()).finish()
    }
}

/// A private file ID: 16 random bytes as lowercase hex. Safe as a file name
/// on a case-insensitive volume, unlike base64.
pub fn valid_private_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn new_id() -> Result<String, VaultError> {
    Ok(random::<16>()?.iter().map(|b| format!("{b:02x}")).collect())
}

fn derive(passphrase: &str, salt: &[u8], iterations: u32) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    validate_passphrase(passphrase)?;
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, iterations, key.as_mut());
    Ok(key)
}

fn slot_aad(salt: &str, iterations: u32) -> Vec<u8> {
    format!("{SLOT_CONTEXT}:{salt}:{iterations}").into_bytes()
}

fn meta_aad(id: &str, wrapped: &str) -> Vec<u8> {
    format!("markie-private-file:v1:meta:{id}:{wrapped}").into_bytes()
}

fn content_aad(id: &str, wrapped: &str, meta_iv: &str) -> Vec<u8> {
    format!("markie-private-file:v1:content:{id}:{wrapped}:{meta_iv}").into_bytes()
}

fn storage_failed<E>(_: E) -> VaultError {
    VaultError::from(StorageErrorCode::StorageFailed)
}

/// Writes `bytes` to `path` through a 0600 temporary file, synced, then renamed.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    let dir = path.parent().ok_or(VaultError::from(StorageErrorCode::Unavailable))?;
    let temp = dir.join(format!(".{}.tmp", new_id()?));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(storage_failed)
}

/// The encrypted private-files store. Locked until a passphrase opens its key.
pub struct PrivateStore {
    dir: PathBuf,
    key: Option<Zeroizing<[u8; 32]>>,
    iterations: u32,
}

impl PrivateStore {
    /// `dir` is `<data folder>/private-files`. Nothing is created until a key is.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), key: None, iterations: limits::KDF_ITERATIONS }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }
    pub fn lock(&mut self) {
        self.key = None;
    }
    pub fn has_key(&self) -> bool {
        self.dir.join(KEY_FILE).is_file()
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.{EXTENSION}"))
    }

    fn ensure_dir(&self) -> Result<(), VaultError> {
        std::fs::create_dir_all(&self.dir).map_err(storage_failed)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }

    /// How many private files there are. Needs no key: the count is not secret.
    pub fn count(&self) -> usize {
        self.ids().len()
    }

    fn ids(&self) -> Vec<String> {
        let Ok(read) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut ids: Vec<String> = read
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let id = name.strip_suffix(&format!(".{EXTENSION}"))?.to_string();
                valid_private_id(&id).then_some(id)
            })
            .collect();
        ids.sort();
        ids
    }

    fn key(&self) -> Result<&[u8; 32], VaultError> {
        self.key.as_deref().ok_or(VaultError::from(VaultErrorCode::Locked))
    }

    /// Opens the store with the vault passphrase, making its key the first time.
    /// A store made under another passphrase stays locked: `AuthenticationFailed`.
    pub fn unlock_or_create(&mut self, passphrase: &str) -> Result<(), VaultError> {
        if self.has_key() { self.unlock(passphrase) } else { self.create_key(passphrase) }
    }

    fn create_key(&mut self, passphrase: &str) -> Result<(), VaultError> {
        let salt = random::<16>()?;
        let wrapper = derive(passphrase, &salt, self.iterations)?;
        let key = Zeroizing::new(random::<32>()?);
        let iv = random::<12>()?;
        let salt_text = encode_base64(&salt);
        let ciphertext = gcm_encrypt(&wrapper, &iv, &slot_aad(&salt_text, self.iterations), key.as_ref())?;
        let slot = json!({
            "version": 1,
            "kdf": "PBKDF2-HMAC-SHA256",
            "iterations": self.iterations,
            "salt": salt_text,
            "iv": encode_base64(&iv),
            "ciphertext": encode_base64(&ciphertext),
        });
        self.ensure_dir()?;
        let path = self.dir.join(KEY_FILE);
        if path.exists() {
            return Err(StorageErrorCode::Conflict.into());
        }
        write_atomic(&path, slot.to_string().as_bytes())?;
        self.key = Some(key);
        // Read it back: a key that does not reopen must never protect a file.
        let mut check = PrivateStore::new(&self.dir);
        check.unlock(passphrase)?;
        if check.key.as_deref() != self.key.as_deref() {
            self.key = None;
            return Err(StorageErrorCode::Corrupt.into());
        }
        Ok(())
    }

    pub fn unlock(&mut self, passphrase: &str) -> Result<(), VaultError> {
        let text = std::fs::read(self.dir.join(KEY_FILE)).map_err(|_| VaultError::from(StorageErrorCode::Unavailable))?;
        let corrupt = || VaultError::from(StorageErrorCode::Corrupt);
        let slot: Value = serde_json::from_slice(&text).map_err(|_| corrupt())?;
        if slot.get("version").and_then(Value::as_u64) != Some(1) || slot.get("kdf").and_then(Value::as_str) != Some("PBKDF2-HMAC-SHA256") {
            return Err(corrupt());
        }
        let iterations = slot.get("iterations").and_then(Value::as_u64).ok_or_else(corrupt)?;
        if !(u64::from(MIN_ITERATIONS)..=u64::from(limits::MAXIMUM_KDF_ITERATIONS)).contains(&iterations) {
            return Err(corrupt());
        }
        let iterations = iterations as u32;
        let field = |k: &str| slot.get(k).and_then(Value::as_str).ok_or_else(corrupt);
        let salt_text = field("salt")?;
        let salt = decode_base64_checked(salt_text, 16, 16)?;
        let iv = decode_base64_checked(field("iv")?, 12, 12)?;
        let ciphertext = decode_base64_checked(field("ciphertext")?, 48, 48)?;
        let wrapper = derive(passphrase, &salt, iterations)?;
        let raw = gcm_decrypt(&wrapper, &iv, &slot_aad(salt_text, iterations), &ciphertext)?;
        let key: [u8; 32] = raw.as_slice().try_into().map_err(|_| corrupt())?;
        self.key = Some(Zeroizing::new(key));
        Ok(())
    }

    fn seal(&self, id: &str, bytes: &[u8], metadata: &PrivateMetadata) -> Result<Vec<u8>, VaultError> {
        let key = self.key()?;
        if bytes.len() > PRIVATE_FILE_BYTES {
            return Err(VaultErrorCode::LimitExceeded.into());
        }
        // A fresh content key for every write; never reused after an edit.
        let content_key = Zeroizing::new(random::<32>()?);
        let wrapped = aes_kw::KekAes256::from(*key)
            .wrap_vec(content_key.as_ref())
            .map_err(|_| VaultError::from(VaultErrorCode::Unavailable))?;
        let wrapped = encode_base64(&wrapped);
        let meta_iv = encode_base64(&random::<12>()?);
        let content_iv = encode_base64(&random::<12>()?);
        let meta = gcm_encrypt(
            &content_key,
            &decode_base64_checked(&meta_iv, 12, 12)?,
            &meta_aad(id, &wrapped),
            &Zeroizing::new(metadata.to_bytes()?),
        )?;
        let content = gcm_encrypt(&content_key, &decode_base64_checked(&content_iv, 12, 12)?, &content_aad(id, &wrapped, &meta_iv), bytes)?;
        let header = json!({
            "id": id,
            "wrappedKey": wrapped,
            "metaIv": meta_iv,
            "meta": encode_base64(&meta),
            "contentIv": content_iv,
        })
        .to_string();
        let mut out = Vec::with_capacity(MAGIC.len() + header.len() + 1 + content.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(header.as_bytes());
        out.push(b'\n');
        out.extend_from_slice(&content);
        Ok(out)
    }

    /// Splits a stored file and opens its content key and metadata.
    fn open_header(&self, id: &str, stored: &[u8]) -> Result<(Zeroizing<[u8; 32]>, PrivateMetadata, Value, usize), VaultError> {
        let key = self.key()?;
        let invalid = || VaultError::from(VaultErrorCode::InvalidEnvelope);
        let rest = stored.strip_prefix(MAGIC).ok_or_else(invalid)?;
        let newline = rest.iter().take(MAX_METADATA_BYTES * 2).position(|b| *b == b'\n').ok_or_else(invalid)?;
        let header: Value = serde_json::from_slice(&rest[..newline]).map_err(|_| invalid())?;
        if header.get("id").and_then(Value::as_str) != Some(id) {
            return Err(VaultErrorCode::AuthenticationFailed.into());
        }
        let field = |k: &str| header.get(k).and_then(Value::as_str).ok_or_else(invalid);
        let wrapped_text = field("wrappedKey")?;
        let wrapped = decode_base64_checked(wrapped_text, 40, 40)?;
        let content_key: [u8; 32] = aes_kw::KekAes256::from(*key)
            .unwrap_vec(&wrapped)
            .map_err(|_| VaultError::from(VaultErrorCode::AuthenticationFailed))
            .map(Zeroizing::new)?
            .as_slice()
            .try_into()
            .map_err(|_| VaultError::from(VaultErrorCode::AuthenticationFailed))?;
        let content_key = Zeroizing::new(content_key);
        let meta_iv = field("metaIv")?;
        let meta = gcm_decrypt(
            &content_key,
            &decode_base64_checked(meta_iv, 12, 12)?,
            &meta_aad(id, wrapped_text),
            &decode_base64_checked(field("meta")?, 17, MAX_METADATA_BYTES + 16)?,
        )?;
        let metadata = PrivateMetadata::from_bytes(&meta)?;
        let body_at = MAGIC.len() + newline + 1;
        Ok((content_key, metadata, header, body_at))
    }

    fn open(&self, id: &str, stored: &[u8]) -> Result<PrivateDocument, VaultError> {
        let (content_key, metadata, header, body_at) = self.open_header(id, stored)?;
        let invalid = || VaultError::from(VaultErrorCode::InvalidEnvelope);
        let meta_iv = header.get("metaIv").and_then(Value::as_str).ok_or_else(invalid)?;
        let wrapped = header.get("wrappedKey").and_then(Value::as_str).ok_or_else(invalid)?;
        let content_iv = decode_base64_checked(header.get("contentIv").and_then(Value::as_str).ok_or_else(invalid)?, 12, 12)?;
        let bytes = gcm_decrypt(&content_key, &content_iv, &content_aad(id, wrapped, meta_iv), &stored[body_at..])?;
        Ok(PrivateDocument { metadata, bytes })
    }

    fn read_stored(&self, id: &str) -> Result<Vec<u8>, VaultError> {
        if !valid_private_id(id) {
            return Err(StorageErrorCode::Conflict.into());
        }
        let path = self.path_for(id);
        let size = std::fs::metadata(&path).map_err(|_| VaultError::from(StorageErrorCode::Conflict))?.len();
        if size as usize > PRIVATE_FILE_BYTES + 2 * MAX_METADATA_BYTES + 64 {
            return Err(VaultErrorCode::LimitExceeded.into());
        }
        std::fs::read(&path).map_err(storage_failed)
    }

    /// Writes one file and proves it: the bytes on disk are read back,
    /// decrypted and compared with `bytes` byte for byte. Any difference
    /// removes what was written, so a caller never deletes an original on
    /// the strength of a bad copy.
    fn write_verified(&self, id: &str, bytes: &[u8], metadata: &PrivateMetadata, fresh: bool) -> Result<(), VaultError> {
        let sealed = self.seal(id, bytes, metadata)?;
        self.ensure_dir()?;
        let path = self.path_for(id);
        if fresh && path.exists() {
            return Err(StorageErrorCode::Conflict.into());
        }
        let previous = if fresh { None } else { Some(self.read_stored(id)?) };
        write_atomic(&path, &sealed)?;
        let check = self.read_stored(id).and_then(|stored| self.open(id, &stored));
        let same = matches!(&check, Ok(doc) if doc.bytes.as_slice() == bytes && doc.metadata == *metadata);
        if !same {
            match previous {
                Some(old) => {
                    let _ = write_atomic(&path, &old);
                }
                None => {
                    let _ = std::fs::remove_file(&path);
                }
            }
            return Err(check.err().unwrap_or(VaultError::from(StorageErrorCode::Corrupt)));
        }
        Ok(())
    }

    /// Adds a file. Returns its ID once the encrypted copy reads back exactly.
    pub fn add(&self, bytes: &[u8], metadata: &PrivateMetadata) -> Result<String, VaultError> {
        let id = new_id()?;
        self.write_verified(&id, bytes, metadata, true)?;
        Ok(id)
    }

    /// Saves an edit. The old encrypted copy stays if the new one does not verify.
    pub fn replace(&self, id: &str, bytes: &[u8], metadata: &PrivateMetadata) -> Result<(), VaultError> {
        self.write_verified(id, bytes, metadata, false)
    }

    pub fn read(&self, id: &str) -> Result<PrivateDocument, VaultError> {
        let stored = self.read_stored(id)?;
        self.open(id, &stored)
    }

    /// Every private file's metadata, sorted by name. Reads no content.
    pub fn list(&self) -> Result<Vec<PrivateEntry>, VaultError> {
        self.key()?;
        let mut entries = Vec::new();
        for id in self.ids() {
            let stored = self.read_stored(&id)?;
            let (_, metadata, _, body_at) = self.open_header(&id, &stored)?;
            // The GCM tag is 16 bytes.
            let bytes = stored.len().saturating_sub(body_at + 16);
            entries.push(PrivateEntry { id, metadata, bytes });
        }
        entries.sort_by(|a, b| a.metadata.name.to_lowercase().cmp(&b.metadata.name.to_lowercase()).then(a.id.cmp(&b.id)));
        Ok(entries)
    }

    /// Deletes one private file's encrypted copy. Needs the key, so a locked
    /// store cannot be emptied by accident.
    pub fn remove(&self, id: &str) -> Result<(), VaultError> {
        self.read(id)?;
        std::fs::remove_file(self.path_for(id)).map_err(storage_failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "unit test passphrase only";

    fn meta(name: &str) -> PrivateMetadata {
        PrivateMetadata { name: name.into(), media_type: "text/markdown".into(), folder: "/Users/fixture/Notes".into(), made_private_ms: 1 }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn add_read_replace_list_remove() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PrivateStore::new(dir.path().join(PRIVATE_DIR));
        assert!(!store.has_key());
        assert_eq!(store.add(b"x", &meta("a.md")).unwrap_err().code(), Some(VaultErrorCode::Locked));
        store.unlock_or_create(PASS).unwrap();
        let secret = b"# Synthetic plan\nThe fixture launch code is ZEBRA-42.\n";
        let id = store.add(secret, &meta("plan.md")).unwrap();
        assert!(valid_private_id(&id));
        assert_eq!(store.read(&id).unwrap().bytes.as_slice(), secret);
        // Nothing on disk carries the plaintext, the name or the folder.
        for entry in std::fs::read_dir(store.dir()).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            for needle in [&b"ZEBRA-42"[..], b"plan.md", b"/Users/fixture"] {
                assert!(!contains(&bytes, needle));
            }
        }
        store.replace(&id, b"edited", &meta("plan.md")).unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].bytes, 6);
        assert_eq!(listed[0].metadata.folder, "/Users/fixture/Notes");
        // Locking forgets the key; the passphrase brings it back.
        store.lock();
        assert!(store.read(&id).is_err());
        assert_eq!(store.count(), 1);
        assert_eq!(store.unlock("wrong passphrase, long enough").unwrap_err().code(), Some(VaultErrorCode::AuthenticationFailed));
        store.unlock(PASS).unwrap();
        assert_eq!(store.read(&id).unwrap().bytes.as_slice(), b"edited");
        store.remove(&id).unwrap();
        assert_eq!(store.count(), 0);
    }

    #[test]
    fn tampering_and_swapping_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PrivateStore::new(dir.path());
        store.unlock_or_create(PASS).unwrap();
        let a = store.add(b"first fixture", &meta("a.txt")).unwrap();
        let b = store.add(b"second fixture", &meta("b.txt")).unwrap();
        // A file renamed onto another ID does not open as that ID.
        let a_bytes = std::fs::read(store.path_for(&a)).unwrap();
        std::fs::write(store.path_for(&b), &a_bytes).unwrap();
        assert!(store.read(&b).is_err());
        // One flipped ciphertext byte fails authentication.
        let mut bad = a_bytes.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        std::fs::write(store.path_for(&a), &bad).unwrap();
        assert_eq!(store.read(&a).unwrap_err().code(), Some(VaultErrorCode::AuthenticationFailed));
        // Another store's key opens nothing here.
        let other = tempfile::tempdir().unwrap();
        let mut stranger = PrivateStore::new(other.path());
        stranger.unlock_or_create(PASS).unwrap();
        std::fs::write(stranger.path_for(&a), &a_bytes).unwrap();
        assert!(stranger.read(&a).is_err());
    }

    #[test]
    fn a_failed_replace_keeps_the_old_copy() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PrivateStore::new(dir.path());
        store.unlock_or_create(PASS).unwrap();
        let id = store.add(b"kept", &meta("a.txt")).unwrap();
        let too_big = vec![0u8; PRIVATE_FILE_BYTES + 1];
        assert_eq!(store.replace(&id, &too_big, &meta("a.txt")).unwrap_err().code(), Some(VaultErrorCode::LimitExceeded));
        assert_eq!(store.read(&id).unwrap().bytes.as_slice(), b"kept");
        assert!(store.replace("not-an-id", b"x", &meta("a.txt")).is_err());
    }
}
