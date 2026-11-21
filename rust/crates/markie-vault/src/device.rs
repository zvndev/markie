//! Touch ID unlock for the vault: `electron/vault-touch-id.js` in Rust.
//!
//! The passphrase stays the master key. Turning on Touch ID writes a device
//! slot (the vault key under a random 32-byte secret) and puts that secret in
//! a `SecretStore`, the Keychain in the app. The secret is released only after
//! a `Biometric` check passes. Nothing here sees the vault key, a passphrase or
//! a document.
//!
//! Both halves are traits, so the rules are tested with doubles and tests
//! never touch the real Keychain or put a Touch ID sheet on screen.
use crate::error::DeviceFailure;
use crate::vault::VAULT_DEVICE_SECRET_BYTES;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use zeroize::Zeroizing;

pub const ENROLL_REASON: &str = "turn on Touch ID for your vault";
pub const UNLOCK_REASON: &str = "unlock your vault";
const MAX_LABEL: usize = 60;

/// Where a device secret lives between unlocks. `repository.ts` VaultDeviceKeeper.
pub trait DeviceKeeper: Send + Sync {
    /// Returns only after the user passed the biometric check.
    fn release(&self, vault_id: &str) -> Result<Zeroizing<[u8; VAULT_DEVICE_SECRET_BYTES]>, DeviceFailure>;
    fn store(&self, vault_id: &str, secret: &[u8]) -> Result<(), DeviceFailure>;
    fn remove(&self, vault_id: &str) -> Result<(), DeviceFailure>;
}

/// The biometric prompt. `MacTouchId` in the app, a double in tests.
pub trait Biometric: Send + Sync {
    fn can_prompt(&self) -> bool;
    /// The sheet reads "Markie RS is trying to <reason>." Err means cancelled or failed.
    fn prompt(&self, reason: &str) -> Result<(), ()>;
}

/// The secret's home. `KeychainSecretStore` in the app, `MemorySecretStore` in tests.
pub trait SecretStore: Send + Sync {
    fn available(&self) -> bool;
    fn has(&self, vault_id: &str) -> bool;
    fn get(&self, vault_id: &str) -> Option<Zeroizing<Vec<u8>>>;
    fn put(&self, vault_id: &str, secret: &[u8]) -> Result<(), ()>;
    fn delete(&self, vault_id: &str) -> Result<(), ()>;
}

/// A canonical 16-byte base64url vault ID: the only thing allowed into a Keychain account name.
pub fn valid_vault_id(value: &str) -> bool {
    crate::envelope::validate_vault_id(value).is_ok()
}

/// The reason for a fresh check before one item is opened, revealed or copied.
/// The verb comes from a fixed list and the name is flattened to one short
/// printable line, so a crafted filename cannot reword the sheet.
pub fn reveal_reason(action: &str, label: &str) -> Option<String> {
    if !matches!(action, "open" | "reveal" | "copy") {
        return None;
    }
    static STRIP: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let strip = STRIP.get_or_init(|| regex::Regex::new(r#"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"“”]+"#).unwrap());
    let flat = strip.replace_all(label, " ");
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    // JavaScript's Array.from(string) counts code points, like chars() here.
    let chars: Vec<char> = flat.chars().collect();
    let name = if chars.len() > MAX_LABEL { format!("{}…", chars[..MAX_LABEL - 1].iter().collect::<String>()) } else { flat };
    Some(format!("{action} “{name}” from your vault"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TouchIdStatus {
    pub available: bool,
    pub enrolled: bool,
}

/// `createVaultTouchId`: the rules, over any biometric and secret store.
pub struct TouchIdKeeper<B: Biometric, S: SecretStore> {
    pub biometric: B,
    pub secrets: S,
    prompting: AtomicBool,
}

impl<B: Biometric, S: SecretStore> TouchIdKeeper<B, S> {
    pub fn new(biometric: B, secrets: S) -> Self {
        Self { biometric, secrets, prompting: AtomicBool::new(false) }
    }

    fn available(&self) -> bool {
        self.biometric.can_prompt() && self.secrets.available()
    }

    /// One prompt at a time; a second request while the sheet is up is refused, not queued.
    fn prompt(&self, reason: &str) -> Result<(), DeviceFailure> {
        if self.prompting.swap(true, Ordering::SeqCst) {
            return Err(DeviceFailure::Busy);
        }
        let result = if !self.biometric.can_prompt() {
            Err(DeviceFailure::Unavailable)
        } else {
            self.biometric.prompt(reason).map_err(|_| DeviceFailure::Cancelled)
        };
        self.prompting.store(false, Ordering::SeqCst);
        result
    }

    /// Answers without reading the secret, so opening the vault never raises a Keychain sheet.
    pub fn status(&self, vault_id: &str) -> TouchIdStatus {
        let ready = self.biometric.can_prompt();
        TouchIdStatus { available: ready, enrolled: ready && valid_vault_id(vault_id) && self.secrets.has(vault_id) }
    }

    /// A fresh Touch ID check before one item is opened, revealed or copied. Releases nothing.
    pub fn confirm(&self, vault_id: &str, action: &str, label: &str) -> Result<(), DeviceFailure> {
        let reason = reveal_reason(action, label);
        let Some(reason) = reason.filter(|_| valid_vault_id(vault_id) && self.biometric.can_prompt()) else {
            return Err(DeviceFailure::Unavailable);
        };
        if !self.secrets.has(vault_id) {
            return Err(DeviceFailure::Missing);
        }
        self.prompt(&reason)
    }
}

impl<B: Biometric, S: SecretStore> DeviceKeeper for TouchIdKeeper<B, S> {
    fn store(&self, vault_id: &str, secret: &[u8]) -> Result<(), DeviceFailure> {
        if !valid_vault_id(vault_id) || secret.len() != VAULT_DEVICE_SECRET_BYTES || !self.available() {
            return Err(DeviceFailure::Unavailable);
        }
        self.prompt(ENROLL_REASON)?;
        self.secrets.put(vault_id, secret).map_err(|_| DeviceFailure::Unavailable)
    }

    fn release(&self, vault_id: &str) -> Result<Zeroizing<[u8; VAULT_DEVICE_SECRET_BYTES]>, DeviceFailure> {
        if !valid_vault_id(vault_id) {
            return Err(DeviceFailure::Missing);
        }
        if !self.available() {
            return Err(DeviceFailure::Unavailable);
        }
        // No prompt for a secret that is not there: the caller falls back to the passphrase.
        if !self.secrets.has(vault_id) {
            return Err(DeviceFailure::Missing);
        }
        self.prompt(UNLOCK_REASON)?;
        let secret = self.secrets.get(vault_id).ok_or(DeviceFailure::Missing)?;
        let array: [u8; VAULT_DEVICE_SECRET_BYTES] = secret.as_slice().try_into().map_err(|_| DeviceFailure::Missing)?;
        Ok(Zeroizing::new(array))
    }

    fn remove(&self, vault_id: &str) -> Result<(), DeviceFailure> {
        if !valid_vault_id(vault_id) {
            return Err(DeviceFailure::Unavailable);
        }
        self.secrets.delete(vault_id).map_err(|_| DeviceFailure::Unavailable)
    }
}

/// Test double and headless fallback.
#[derive(Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
}

impl SecretStore for MemorySecretStore {
    fn available(&self) -> bool {
        true
    }
    fn has(&self, vault_id: &str) -> bool {
        self.map.lock().unwrap().contains_key(vault_id)
    }
    fn get(&self, vault_id: &str) -> Option<Zeroizing<Vec<u8>>> {
        self.map.lock().unwrap().get(vault_id).cloned()
    }
    fn put(&self, vault_id: &str, secret: &[u8]) -> Result<(), ()> {
        self.map.lock().unwrap().insert(vault_id.to_string(), Zeroizing::new(secret.to_vec()));
        Ok(())
    }
    fn delete(&self, vault_id: &str) -> Result<(), ()> {
        self.map.lock().unwrap().remove(vault_id);
        Ok(())
    }
}

/// A scripted biometric for tests: answers from a queue, records each reason.
#[derive(Default)]
pub struct FakeBiometric {
    pub unavailable: AtomicBool,
    pub answers: Mutex<Vec<bool>>,
    pub reasons: Mutex<Vec<String>>,
}

impl Biometric for FakeBiometric {
    fn can_prompt(&self) -> bool {
        !self.unavailable.load(Ordering::SeqCst)
    }
    fn prompt(&self, reason: &str) -> Result<(), ()> {
        self.reasons.lock().unwrap().push(reason.to_string());
        let mut answers = self.answers.lock().unwrap();
        let ok = if answers.is_empty() { true } else { answers.remove(0) };
        if ok { Ok(()) } else { Err(()) }
    }
}

/// The device secret as a generic password: service is the app's own name
/// plus " Vault" (for example "Markie RS Vault"), account is the vault ID. It
/// never reads the Electron app's "Markie Safe Storage" item.
///
/// `has` reads the item too, because the Keychain cannot answer "exists"
/// without a read. The secret is only used after the biometric check.
pub struct KeychainSecretStore {
    service: String,
}

impl KeychainSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }
    fn entry(&self, vault_id: &str) -> Option<keyring::Entry> {
        valid_vault_id(vault_id).then(|| keyring::Entry::new(&self.service, vault_id).ok()).flatten()
    }
}

impl SecretStore for KeychainSecretStore {
    fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }
    fn has(&self, vault_id: &str) -> bool {
        self.get(vault_id).is_some()
    }
    fn get(&self, vault_id: &str) -> Option<Zeroizing<Vec<u8>>> {
        let secret = self.entry(vault_id)?.get_secret().ok().map(Zeroizing::new)?;
        (secret.len() == VAULT_DEVICE_SECRET_BYTES).then_some(secret)
    }
    fn put(&self, vault_id: &str, secret: &[u8]) -> Result<(), ()> {
        self.entry(vault_id).ok_or(())?.set_secret(secret).map_err(|_| ())
    }
    fn delete(&self, vault_id: &str) -> Result<(), ()> {
        match self.entry(vault_id).ok_or(())?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

/// Touch ID through LocalAuthentication, biometrics only, like Electron's
/// `systemPreferences.promptTouchID`.
#[cfg(target_os = "macos")]
pub struct MacTouchId;

#[cfg(target_os = "macos")]
impl Biometric for MacTouchId {
    fn can_prompt(&self) -> bool {
        use objc2_local_authentication::{LAContext, LAPolicy};
        unsafe {
            let context = LAContext::new();
            context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics).is_ok()
        }
    }

    fn prompt(&self, reason: &str) -> Result<(), ()> {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_foundation::{NSError, NSString};
        use objc2_local_authentication::{LAContext, LAPolicy};
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let block = RcBlock::new(move |success: Bool, _error: *mut NSError| {
            let _ = tx.send(success.as_bool());
        });
        unsafe {
            let context = LAContext::new();
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                &NSString::from_str(reason),
                &block,
            );
        }
        // The reply runs on a private queue; this thread waits for it.
        if rx.recv().unwrap_or(false) { Ok(()) } else { Err(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> String {
        crate::envelope::encode_base64(&[7; 16])
    }

    #[test]
    fn reveal_reason_flattens_labels() {
        assert_eq!(reveal_reason("copy", "API key").unwrap(), "copy “API key” from your vault");
        assert_eq!(reveal_reason("open", "a\n\u{202e}b \"c\"").unwrap(), "open “a b c” from your vault");
        assert!(reveal_reason("delete", "x").is_none());
        assert!(reveal_reason("copy", " \n ").is_none());
        let long = reveal_reason("reveal", &"é".repeat(80)).unwrap();
        assert!(long.contains(&format!("{}…", "é".repeat(59))));
    }

    #[test]
    fn enroll_release_remove() {
        let keeper = TouchIdKeeper::new(FakeBiometric::default(), MemorySecretStore::default());
        assert!(!keeper.status(&id()).enrolled);
        assert_eq!(keeper.release(&id()).unwrap_err(), DeviceFailure::Missing);
        assert!(keeper.biometric.reasons.lock().unwrap().is_empty(), "no prompt for a missing secret");
        keeper.store(&id(), &[9; 32]).unwrap();
        assert!(keeper.status(&id()).enrolled);
        assert_eq!(*keeper.release(&id()).unwrap(), [9; 32]);
        keeper.biometric.answers.lock().unwrap().push(false);
        assert_eq!(keeper.release(&id()).unwrap_err(), DeviceFailure::Cancelled);
        assert_eq!(*keeper.biometric.reasons.lock().unwrap(), vec![ENROLL_REASON, UNLOCK_REASON, UNLOCK_REASON]);
        keeper.confirm(&id(), "copy", "KEY").unwrap();
        keeper.remove(&id()).unwrap();
        assert_eq!(keeper.confirm(&id(), "copy", "KEY").unwrap_err(), DeviceFailure::Missing);
        assert_eq!(keeper.store("not-an-id", &[0; 32]).unwrap_err(), DeviceFailure::Unavailable);
        assert_eq!(keeper.store(&id(), &[0; 31]).unwrap_err(), DeviceFailure::Unavailable);
        keeper.biometric.unavailable.store(true, Ordering::SeqCst);
        assert_eq!(keeper.store(&id(), &[0; 32]).unwrap_err(), DeviceFailure::Unavailable);
    }

    #[test]
    fn a_second_prompt_while_one_is_up_is_busy() {
        struct Reentrant(std::sync::OnceLock<std::sync::Weak<TouchIdKeeper<Reentrant, MemorySecretStore>>>, Mutex<Option<DeviceFailure>>);
        impl Biometric for Reentrant {
            fn can_prompt(&self) -> bool {
                true
            }
            fn prompt(&self, _: &str) -> Result<(), ()> {
                if let Some(k) = self.0.get().and_then(|w| w.upgrade()) {
                    *self.1.lock().unwrap() = k.confirm(&id(), "open", "x").err();
                }
                Ok(())
            }
        }
        let keeper = std::sync::Arc::new(TouchIdKeeper::new(Reentrant(Default::default(), Mutex::new(None)), MemorySecretStore::default()));
        keeper.biometric.0.set(std::sync::Arc::downgrade(&keeper)).ok();
        keeper.secrets.put(&id(), &[1; 32]).unwrap();
        keeper.release(&id()).unwrap();
        assert_eq!(*keeper.biometric.1.lock().unwrap(), Some(DeviceFailure::Busy));
    }
}
