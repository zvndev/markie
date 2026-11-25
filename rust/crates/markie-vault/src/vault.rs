//! The unlocked-key owner, `Vault` in `src/lib/vault/index.ts`.
//!
//! - Passphrase slot: PBKDF2-HMAC-SHA256 (600k iterations, 16-byte salt) gives
//!   an AES-256-GCM key, which encrypts the 32-byte vault key with the header
//!   context as additional data.
//! - Documents: a fresh AES-256-GCM content key per encryption, wrapped under
//!   the vault key with AES-KW (RFC 3394). The plaintext frame is a big-endian
//!   u32 metadata length, the metadata JSON, then the content bytes.
//! - Device slot: the vault key under AES-256-GCM with a random 32-byte device
//!   secret, bound to the vault ID and slot version.
//!
//! Key material lives in `Zeroizing` buffers and is wiped on drop and lock.
use crate::envelope::{
    decode_base64_checked, encode_base64, js_length, limits, validate_vault_id, VaultDeviceSlot, VaultDocumentEnvelope,
    VaultDocumentMetadata, VaultHeader,
};
use crate::error::{VaultError, VaultErrorCode};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use zeroize::Zeroizing;

/// Length of the device secret the OS keychain holds for a device slot.
pub const VAULT_DEVICE_SECRET_BYTES: usize = 32;

pub(crate) fn random<const N: usize>() -> Result<[u8; N], VaultError> {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).map_err(|_| VaultErrorCode::Unavailable)?;
    Ok(out)
}

/// Opaque ID only: never a filename, title or path.
pub fn create_vault_document_id() -> Result<String, VaultError> {
    Ok(encode_base64(&random::<16>()?))
}

/// `passphraseBytes` in index.ts. Rust strings cannot hold lone surrogates, so that check is implicit.
fn passphrase_bytes(passphrase: &str) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if js_length(passphrase) > limits::PASSPHRASE_BYTES
        || passphrase.chars().count() < limits::MINIMUM_PASSPHRASE_CODE_POINTS
        || passphrase.len() > limits::PASSPHRASE_BYTES
    {
        return Err(VaultErrorCode::InvalidPassphrase.into());
    }
    Ok(Zeroizing::new(passphrase.as_bytes().to_vec()))
}

/// Checks a passphrase against the vault's rules without deriving anything.
pub fn validate_passphrase(passphrase: &str) -> Result<(), VaultError> {
    passphrase_bytes(passphrase).map(|_| ())
}

fn wrapping_key(passphrase: &str, header: &VaultHeader) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let bytes = passphrase_bytes(passphrase)?;
    let salt = decode_base64_checked(&header.kdf_salt, 16, 16)?;
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(&bytes, &salt, header.kdf_iterations, key.as_mut());
    Ok(key)
}

pub(crate) fn gcm_encrypt(key: &[u8; 32], iv: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
    Aes256Gcm::new(key.into())
        .encrypt(Nonce::from_slice(iv), Payload { msg: plaintext, aad })
        .map_err(|_| VaultErrorCode::Unavailable.into())
}

pub(crate) fn gcm_decrypt(key: &[u8; 32], iv: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(iv), Payload { msg: ciphertext, aad })
        .map(Zeroizing::new)
        .map_err(|_| VaultErrorCode::AuthenticationFailed.into())
}

fn raw_key(bytes: &[u8]) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let array: [u8; 32] = bytes.try_into().map_err(|_| VaultError::from(VaultErrorCode::AuthenticationFailed))?;
    Ok(Zeroizing::new(array))
}

/// The caller owns `secret`: hand it to the keychain, then drop it.
pub struct VaultDeviceEnrollment {
    pub slot: String,
    pub secret: Zeroizing<[u8; VAULT_DEVICE_SECRET_BYTES]>,
}

pub struct DecryptedVaultDocument {
    pub bytes: Zeroizing<Vec<u8>>,
    pub metadata: VaultDocumentMetadata,
}

/// Never prints plaintext: only its length.
impl std::fmt::Debug for DecryptedVaultDocument {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DecryptedVaultDocument").field("bytes", &self.bytes.len()).field("metadata", &self.metadata).finish()
    }
}

/// One unlocked vault key. No persistence, UI, network, logging or plaintext cache.
#[derive(Default)]
pub struct Vault {
    key: Option<Zeroizing<[u8; 32]>>,
    vault_id: Option<String>,
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }
    pub fn vault_id(&self) -> Option<&str> {
        self.vault_id.as_deref()
    }
    pub fn lock(&mut self) {
        self.key = None;
        self.vault_id = None;
    }

    fn unlocked(&self) -> Result<(&[u8; 32], &str), VaultError> {
        match (&self.key, &self.vault_id) {
            (Some(k), Some(id)) => Ok((k, id)),
            _ => Err(VaultErrorCode::Locked.into()),
        }
    }

    /// Creates a vault and leaves it unlocked. Returns the header to persist.
    pub fn create(&mut self, passphrase: &str) -> Result<String, VaultError> {
        self.create_with_iterations(passphrase, limits::KDF_ITERATIONS)
    }

    pub(crate) fn create_with_iterations(&mut self, passphrase: &str, iterations: u32) -> Result<String, VaultError> {
        passphrase_bytes(passphrase)?;
        if self.key.is_some() {
            return Err(VaultErrorCode::Busy.into());
        }
        let raw = Zeroizing::new(random::<32>()?);
        let mut header = VaultHeader {
            vault_id: create_vault_document_id()?,
            kdf_iterations: iterations,
            kdf_salt: encode_base64(&random::<16>()?),
            wrap_iv: encode_base64(&random::<12>()?),
            wrap_ciphertext: String::new(),
        };
        let wrapper = wrapping_key(passphrase, &header)?;
        let iv = decode_base64_checked(&header.wrap_iv, 12, 12)?;
        header.wrap_ciphertext = encode_base64(&gcm_encrypt(&wrapper, &iv, &header.context(), raw.as_ref())?);
        self.key = Some(raw);
        self.vault_id = Some(header.vault_id.clone());
        Ok(header.serialize())
    }

    fn passphrase_key(header: &VaultHeader, passphrase: &str) -> Result<Zeroizing<[u8; 32]>, VaultError> {
        let wrapper = wrapping_key(passphrase, header)?;
        let iv = decode_base64_checked(&header.wrap_iv, 12, 12)?;
        let ciphertext = decode_base64_checked(&header.wrap_ciphertext, 48, 48)?;
        raw_key(&gcm_decrypt(&wrapper, &iv, &header.context(), &ciphertext)?)
    }

    pub fn unlock(&mut self, serialized_header: &str, passphrase: &str) -> Result<(), VaultError> {
        let header = VaultHeader::parse(serialized_header)?;
        if self.key.is_some() {
            return Err(VaultErrorCode::Busy.into());
        }
        let key = Self::passphrase_key(&header, passphrase)?;
        self.key = Some(key);
        self.vault_id = Some(header.vault_id);
        Ok(())
    }

    /// Checks the passphrase against the header while unlocked, without changing the held key.
    pub fn verify_passphrase(&self, serialized_header: &str, passphrase: &str) -> Result<(), VaultError> {
        let header = VaultHeader::parse(serialized_header)?;
        let (_, vault_id) = self.unlocked()?;
        if header.vault_id != vault_id {
            return Err(VaultErrorCode::Locked.into());
        }
        Self::passphrase_key(&header, passphrase).map(|_| ())
    }

    /// Unlocks through the device slot with the secret the keychain released.
    pub fn unlock_with_device_secret(&mut self, serialized_header: &str, serialized_slot: &str, secret: &[u8]) -> Result<(), VaultError> {
        let header = VaultHeader::parse(serialized_header)?;
        let slot = VaultDeviceSlot::parse(serialized_slot)?;
        if slot.vault_id != header.vault_id || secret.len() != VAULT_DEVICE_SECRET_BYTES {
            return Err(VaultErrorCode::AuthenticationFailed.into());
        }
        if self.key.is_some() {
            return Err(VaultErrorCode::Busy.into());
        }
        let device_key = raw_key(secret)?;
        let iv = decode_base64_checked(&slot.iv, 12, 12)?;
        let ciphertext = decode_base64_checked(&slot.ciphertext, 48, 48)?;
        let key = raw_key(&gcm_decrypt(&device_key, &iv, &VaultDeviceSlot::context(&slot.vault_id, &slot.iv), &ciphertext)?)?;
        self.key = Some(key);
        self.vault_id = Some(header.vault_id);
        Ok(())
    }

    /// Creates a device slot for the unlocked vault. Needs the passphrase again.
    pub fn enroll_device(&self, serialized_header: &str, passphrase: &str) -> Result<VaultDeviceEnrollment, VaultError> {
        let header = VaultHeader::parse(serialized_header)?;
        let (_, vault_id) = self.unlocked()?;
        if header.vault_id != vault_id {
            return Err(VaultErrorCode::AuthenticationFailed.into());
        }
        let raw = Self::passphrase_key(&header, passphrase)?;
        let secret = Zeroizing::new(random::<VAULT_DEVICE_SECRET_BYTES>()?);
        let iv = encode_base64(&random::<12>()?);
        let ciphertext = gcm_encrypt(
            &secret,
            &decode_base64_checked(&iv, 12, 12)?,
            &VaultDeviceSlot::context(vault_id, &iv),
            raw.as_ref(),
        )?;
        let slot = VaultDeviceSlot { vault_id: vault_id.to_string(), iv, ciphertext: encode_base64(&ciphertext) };
        Ok(VaultDeviceEnrollment { slot: slot.serialize(), secret })
    }

    pub fn encrypt_document(&self, document_id: &str, bytes: &[u8], metadata: &VaultDocumentMetadata) -> Result<String, VaultError> {
        let (key, vault_id) = self.unlocked()?;
        validate_vault_id(document_id)?;
        if bytes.len() > limits::CONTENT_BYTES {
            return Err(VaultErrorCode::LimitExceeded.into());
        }
        let encoded = Zeroizing::new(metadata.to_bytes()?);
        let mut frame = Zeroizing::new(Vec::with_capacity(4 + encoded.len() + bytes.len()));
        frame.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
        frame.extend_from_slice(&encoded);
        frame.extend_from_slice(bytes);
        // A fresh content key for every encryption; never reused after an edit or retry.
        let content_key = Zeroizing::new(random::<32>()?);
        let wrapped = aes_kw::KekAes256::from(*key)
            .wrap_vec(content_key.as_ref())
            .map_err(|_| VaultError::from(VaultErrorCode::Unavailable))?;
        let mut envelope = VaultDocumentEnvelope {
            vault_id: vault_id.to_string(),
            document_id: document_id.to_string(),
            wrapped_key: encode_base64(&wrapped),
            iv: encode_base64(&random::<12>()?),
            ciphertext: String::new(),
        };
        let iv = decode_base64_checked(&envelope.iv, 12, 12)?;
        envelope.ciphertext = encode_base64(&gcm_encrypt(&content_key, &iv, &envelope.context(), &frame)?);
        Ok(envelope.serialize())
    }

    pub fn decrypt_document(&self, serialized: &str, expected_document_id: &str) -> Result<DecryptedVaultDocument, VaultError> {
        let (key, vault_id) = self.unlocked()?;
        validate_vault_id(expected_document_id)?;
        let envelope = VaultDocumentEnvelope::parse(serialized)?;
        if envelope.vault_id != vault_id || envelope.document_id != expected_document_id {
            return Err(VaultErrorCode::AuthenticationFailed.into());
        }
        let wrapped = decode_base64_checked(&envelope.wrapped_key, 40, 40)?;
        let content_key = aes_kw::KekAes256::from(*key)
            .unwrap_vec(&wrapped)
            .map_err(|_| VaultError::from(VaultErrorCode::AuthenticationFailed))
            .map(Zeroizing::new)
            .and_then(|k| raw_key(&k))?;
        let iv = decode_base64_checked(&envelope.iv, 12, 12)?;
        let ciphertext = decode_base64_checked(&envelope.ciphertext, 20, limits::CONTENT_BYTES + limits::METADATA_BYTES + 20)?;
        let frame = gcm_decrypt(&content_key, &iv, &envelope.context(), &ciphertext)?;
        let invalid = || VaultError::from(VaultErrorCode::InvalidEnvelope);
        if frame.len() < 4 {
            return Err(invalid());
        }
        let metadata_len = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        if metadata_len > limits::METADATA_BYTES || metadata_len > frame.len() - 4 || frame.len() - 4 - metadata_len > limits::CONTENT_BYTES {
            return Err(invalid());
        }
        let metadata = VaultDocumentMetadata::from_bytes(&frame[4..4 + metadata_len])?;
        Ok(DecryptedVaultDocument { bytes: Zeroizing::new(frame[4 + metadata_len..].to_vec()), metadata })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "unit test passphrase only";

    fn meta(name: &str) -> VaultDocumentMetadata {
        VaultDocumentMetadata { name: name.into(), media_type: "text/markdown".into() }
    }

    #[test]
    fn create_unlock_encrypt_decrypt() {
        let mut vault = Vault::new();
        let header = vault.create(PASS).unwrap();
        let id = create_vault_document_id().unwrap();
        let envelope = vault.encrypt_document(&id, b"hello", &meta("a.md")).unwrap();
        vault.lock();
        assert_eq!(vault.decrypt_document(&envelope, &id).unwrap_err().code(), Some(VaultErrorCode::Locked));
        assert_eq!(vault.unlock(&header, "wrong passphrase, long enough").unwrap_err().code(), Some(VaultErrorCode::AuthenticationFailed));
        vault.unlock(&header, PASS).unwrap();
        let doc = vault.decrypt_document(&envelope, &id).unwrap();
        assert_eq!(&doc.bytes[..], b"hello");
        assert_eq!(doc.metadata, meta("a.md"));
        // An envelope cannot be replayed under another document ID.
        let other = create_vault_document_id().unwrap();
        assert_eq!(vault.decrypt_document(&envelope, &other).unwrap_err().code(), Some(VaultErrorCode::AuthenticationFailed));
        vault.verify_passphrase(&header, PASS).unwrap();
    }

    #[test]
    fn passphrase_rules() {
        assert_eq!(Vault::new().create("short").unwrap_err().code(), Some(VaultErrorCode::InvalidPassphrase));
        // 16 code points, even when they are 4-byte characters.
        validate_passphrase(&"🔐".repeat(16)).unwrap();
        assert!(validate_passphrase(&"🔐".repeat(15)).is_err());
        assert!(validate_passphrase(&"é".repeat(600)).is_err());
    }

    #[test]
    fn device_slot_round_trip_and_binding() {
        let mut vault = Vault::new();
        let header = vault.create(PASS).unwrap();
        let enrollment = vault.enroll_device(&header, PASS).unwrap();
        vault.lock();
        vault.unlock_with_device_secret(&header, &enrollment.slot, enrollment.secret.as_ref()).unwrap();
        vault.lock();
        let mut wrong = *enrollment.secret;
        wrong[0] ^= 1;
        assert_eq!(
            vault.unlock_with_device_secret(&header, &enrollment.slot, &wrong).unwrap_err().code(),
            Some(VaultErrorCode::AuthenticationFailed)
        );
        // A slot moved to another vault does not open it.
        let other_header = Vault::new().create(PASS).unwrap();
        assert!(vault.unlock_with_device_secret(&other_header, &enrollment.slot, enrollment.secret.as_ref()).is_err());
    }

    #[test]
    fn content_limit() {
        let mut vault = Vault::new();
        vault.create_with_iterations(PASS, 600_000).unwrap();
        let id = create_vault_document_id().unwrap();
        let big = vec![0u8; limits::CONTENT_BYTES + 1];
        assert_eq!(vault.encrypt_document(&id, &big, &meta("x")).unwrap_err().code(), Some(VaultErrorCode::LimitExceeded));
    }
}
