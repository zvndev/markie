//! The Google grant on this Mac.
//!
//! The refresh token lives in Markie RS's own Keychain service,
//! "<profile> Google" (for example "Markie RS Google"), account
//! `drive.file`, through `markie_vault::device::SecretStore`: the same pattern
//! as the vault's Touch ID secret. Tests use `MemorySecretStore`. The access
//! token is only ever held in memory. Markie Cloud never sees either.
use crate::config::ClientConfig;
use crate::error::{GoogleError, Result};
use crate::oauth::{self, TokenResponse};
use markie_vault::device::{SecretStore, SecretStoreError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// The Keychain account name for the one grant Markie holds.
pub const ACCOUNT: &str = "drive.file";

/// The Keychain service for a profile: never the vault's or Markie Cloud's.
pub fn keychain_service(profile: &str) -> String {
    format!("{profile} Google")
}

/// A generic password per account under `service`. Unlike the vault's store,
/// it holds any short secret, not only 32-byte device keys.
pub struct GoogleKeychainStore {
    service: String,
}

impl GoogleKeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    fn entry(&self, account: &str) -> Option<keyring::Entry> {
        (account == ACCOUNT).then(|| keyring::Entry::new(&self.service, account).ok()).flatten()
    }
}

impl SecretStore for GoogleKeychainStore {
    fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }
    fn has(&self, account: &str) -> bool {
        self.get(account).is_some()
    }
    fn get(&self, account: &str) -> Option<Zeroizing<Vec<u8>>> {
        self.entry(account)?.get_secret().ok().map(Zeroizing::new).filter(|s| !s.is_empty())
    }
    fn put(&self, account: &str, secret: &[u8]) -> std::result::Result<(), SecretStoreError> {
        self.entry(account).ok_or(SecretStoreError)?.set_secret(secret).map_err(|_| SecretStoreError)
    }
    fn delete(&self, account: &str) -> std::result::Result<(), SecretStoreError> {
        match self.entry(account).ok_or(SecretStoreError)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecretStoreError),
        }
    }
}

struct Access {
    token: Zeroizing<String>,
    until: Instant,
}

/// The grant: refresh token in a `SecretStore`, access token in memory.
pub struct Grant<S: SecretStore> {
    secrets: S,
    access: Mutex<Option<Access>>,
}

impl<S: SecretStore> Grant<S> {
    pub fn new(secrets: S) -> Self {
        Self { secrets, access: Mutex::new(None) }
    }

    pub fn secrets(&self) -> &S {
        &self.secrets
    }

    /// Connected means a refresh token is stored. Reads the Keychain once.
    pub fn connected(&self) -> bool {
        self.secrets.has(ACCOUNT)
    }

    /// Keep what a code exchange or a refresh returned. A refresh that brings
    /// no new refresh token keeps the old one.
    pub fn accept(&self, tokens: &TokenResponse) -> Result<()> {
        if let Some(refresh) = tokens.refresh_token.as_deref().filter(|t| !t.is_empty()) {
            self.secrets.put(ACCOUNT, refresh.as_bytes()).map_err(|_| GoogleError::Keychain)?;
        }
        // A minute early, so a call never starts with a token about to lapse.
        let life = tokens.expires_in.unwrap_or(3600).saturating_sub(60).max(1);
        *self.access.lock().unwrap() = Some(Access { token: Zeroizing::new(tokens.access_token.clone()), until: Instant::now() + Duration::from_secs(life) });
        Ok(())
    }

    fn refresh_token(&self) -> Option<Zeroizing<String>> {
        let bytes = self.secrets.get(ACCOUNT)?;
        String::from_utf8(bytes.to_vec()).ok().map(Zeroizing::new)
    }

    /// A live access token, refreshed with the stored refresh token when needed.
    /// A revoked grant clears the Keychain item and asks the person to connect again.
    pub fn access_token(&self, http: &reqwest::blocking::Client, cfg: &ClientConfig) -> Result<Zeroizing<String>> {
        if let Some(a) = self.access.lock().unwrap().as_ref().filter(|a| Instant::now() < a.until) {
            return Ok(a.token.clone());
        }
        let refresh = self.refresh_token().ok_or(GoogleError::Reconnect)?;
        match oauth::refresh_access(http, cfg, &refresh) {
            Ok(tokens) => {
                self.accept(&tokens)?;
                Ok(Zeroizing::new(tokens.access_token))
            }
            Err(GoogleError::Reconnect) => {
                let _ = self.forget_local();
                Err(GoogleError::Reconnect)
            }
            Err(e) => Err(e),
        }
    }

    /// Drop the cached access token, so the next call refreshes (after a 401).
    pub fn expire(&self) {
        *self.access.lock().unwrap() = None;
    }

    fn forget_local(&self) -> Result<()> {
        *self.access.lock().unwrap() = None;
        self.secrets.delete(ACCOUNT).map_err(|_| GoogleError::Keychain)
    }

    /// Disconnect: revoke at Google (best effort) and remove the Keychain item.
    pub fn disconnect(&self, http: &reqwest::blocking::Client, cfg: &ClientConfig) -> Result<()> {
        if let Some(refresh) = self.refresh_token() {
            let _ = oauth::revoke(http, cfg, &refresh);
        }
        self.forget_local()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use markie_vault::device::MemorySecretStore;

    fn tokens(access: &str, refresh: Option<&str>) -> TokenResponse {
        serde_json::from_value(serde_json::json!({"access_token": access, "expires_in": 3600, "refresh_token": refresh})).unwrap()
    }

    #[test]
    fn the_refresh_token_goes_to_the_secret_store_and_survives_a_refresh_without_one() {
        let grant = Grant::new(MemorySecretStore::default());
        assert!(!grant.connected());
        grant.accept(&tokens("a1", Some("r1"))).unwrap();
        assert!(grant.connected());
        assert_eq!(grant.secrets().get(ACCOUNT).unwrap().as_slice(), b"r1");
        grant.accept(&tokens("a2", None)).unwrap();
        assert_eq!(grant.secrets().get(ACCOUNT).unwrap().as_slice(), b"r1");
        // The cached access token is used without a network call.
        let cfg = ClientConfig::fake("http://127.0.0.1:9");
        assert_eq!(grant.access_token(&oauth::http_client(), &cfg).unwrap().as_str(), "a2");
    }

    #[test]
    fn with_no_refresh_token_the_person_must_connect() {
        let grant = Grant::new(MemorySecretStore::default());
        let cfg = ClientConfig::fake("http://127.0.0.1:9");
        assert_eq!(grant.access_token(&oauth::http_client(), &cfg).unwrap_err(), GoogleError::Reconnect);
    }

    #[test]
    fn the_keychain_service_is_markies_own() {
        assert_eq!(keychain_service("Markie RS"), "Markie RS Google");
        assert_eq!(keychain_service("Markie Nightly"), "Markie Nightly Google");
        // The store answers only for the one account it holds.
        let store = GoogleKeychainStore::new("Markie RS Google TEST (never written)");
        assert!(store.entry("someone-else").is_none());
    }
}
