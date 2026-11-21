//! One session per server origin, behind a trait. The Keychain (or the
//! platform's credential manager) in the app, memory in tests.
//!
//! A session is the token plus the account the server confirmed it belongs to.
//! A new token always starts unconfirmed: the account comes back only after
//! `/api/me` answered under that token at that server (auth-client.ts
//! confirmPrincipal). This replaces the Electron app's localStorage keys
//! `markie.token.v1@<origin>` and `markie.auth.principal.v1@<origin>`.
use crate::error::{CloudError, Result};
use crate::origin::canonical_cloud_origin;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    /// The user id `/api/me` confirmed for this token at this origin.
    #[serde(default, rename = "userId")]
    pub user_id: Option<String>,
}

pub trait TokenStore: Send + Sync {
    /// The session for a canonical origin.
    fn get(&self, origin: &str) -> Result<Option<Session>>;
    /// Replace or clear the session for a canonical origin.
    fn put(&self, origin: &str, session: Option<&Session>) -> Result<()>;
}

/// Read a session, keyed by Markie Cloud's current origin for any alias.
pub fn session_for(store: &dyn TokenStore, origin: &str) -> Option<Session> {
    store.get(&canonical_cloud_origin(origin)).ok().flatten()
}

/// Store a token. A different token than the one held drops the confirmed account.
pub fn set_token(store: &dyn TokenStore, origin: &str, token: Option<&str>) -> Result<()> {
    let origin = canonical_cloud_origin(origin);
    match token {
        None => store.put(&origin, None),
        Some(t) => {
            let prev = store.get(&origin)?;
            let user_id = prev.filter(|p| p.token == t).and_then(|p| p.user_id);
            store.put(&origin, Some(&Session { token: t.to_string(), user_id }))
        }
    }
}

/// Record that `/api/me`, asked with `token`, named `user_id`. Ignored when the
/// stored token is no longer that one.
pub fn confirm(store: &dyn TokenStore, origin: &str, token: &str, user_id: &str) -> Result<bool> {
    let origin = canonical_cloud_origin(origin);
    match store.get(&origin)? {
        Some(s) if s.token == token => {
            store.put(&origin, Some(&Session { token: s.token, user_id: Some(user_id.to_string()) }))?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[derive(Default)]
pub struct MemoryTokenStore {
    map: Mutex<HashMap<String, Session>>,
}

impl MemoryTokenStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl TokenStore for MemoryTokenStore {
    fn get(&self, origin: &str) -> Result<Option<Session>> {
        Ok(self.map.lock().unwrap().get(origin).cloned())
    }
    fn put(&self, origin: &str, session: Option<&Session>) -> Result<()> {
        let mut m = self.map.lock().unwrap();
        match session {
            Some(s) => m.insert(origin.to_string(), s.clone()),
            None => m.remove(origin),
        };
        Ok(())
    }
}

/// The platform credential store: one entry per origin under `service`.
pub struct KeyringTokenStore {
    service: String,
}

impl KeyringTokenStore {
    /// `service` should be the app's own name, for example "Markie RS", so the
    /// Rust build never reads or overwrites the Electron app's sign-in.
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    fn entry(&self, origin: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, origin).map_err(|e| CloudError::Storage(e.to_string()))
    }
}

impl TokenStore for KeyringTokenStore {
    fn get(&self, origin: &str) -> Result<Option<Session>> {
        match self.entry(origin)?.get_password() {
            Ok(json) => Ok(serde_json::from_str(&json).ok()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CloudError::Storage(e.to_string())),
        }
    }
    fn put(&self, origin: &str, session: Option<&Session>) -> Result<()> {
        let entry = self.entry(origin)?;
        match session {
            Some(s) => entry
                .set_password(&serde_json::to_string(s).unwrap_or_default())
                .map_err(|e| CloudError::Storage(e.to_string())),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(CloudError::Storage(e.to_string())),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const RAILWAY: &str = "https://api-production-602f.up.railway.app";

    #[test]
    fn a_new_token_is_unconfirmed_and_aliases_share_a_slot() {
        let s = MemoryTokenStore::new();
        set_token(&s, RAILWAY, Some("t1")).unwrap();
        assert_eq!(session_for(&s, crate::DEFAULT_SERVER).unwrap().token, "t1");
        assert!(confirm(&s, crate::DEFAULT_SERVER, "t1", "u1").unwrap());
        assert_eq!(session_for(&s, RAILWAY).unwrap().user_id.as_deref(), Some("u1"));
        // The same token keeps its account; a new one drops it.
        set_token(&s, crate::DEFAULT_SERVER, Some("t1")).unwrap();
        assert_eq!(session_for(&s, crate::DEFAULT_SERVER).unwrap().user_id.as_deref(), Some("u1"));
        set_token(&s, crate::DEFAULT_SERVER, Some("t2")).unwrap();
        assert_eq!(session_for(&s, crate::DEFAULT_SERVER).unwrap().user_id, None);
        // A confirmation for a token no longer held is ignored.
        assert!(!confirm(&s, crate::DEFAULT_SERVER, "t1", "u1").unwrap());
        set_token(&s, crate::DEFAULT_SERVER, None).unwrap();
        assert_eq!(session_for(&s, crate::DEFAULT_SERVER), None);
    }

    #[test]
    fn one_slot_per_origin() {
        let s = MemoryTokenStore::new();
        set_token(&s, "https://a.example.com", Some("a")).unwrap();
        set_token(&s, "https://b.example.com", Some("b")).unwrap();
        assert_eq!(session_for(&s, "https://a.example.com").unwrap().token, "a");
        assert_eq!(session_for(&s, "https://b.example.com").unwrap().token, "b");
    }
}
