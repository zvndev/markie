//! The Desktop OAuth client and Google's addresses.
//!
//! The client ID comes from the build: `MARKIE_GOOGLE_DESKTOP_CLIENT_ID`, read
//! by `option_env!` when this crate compiles (build.rs reruns when it changes).
//! `rust/scripts/bundle-mac.sh` and `nightly-release.sh` pass it through.
//! Google's Desktop clients also carry a secret that Google documents as not
//! confidential; when the client has one it comes from
//! `MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET` the same way. Neither value is ever
//! in the repo or a log. Without a client ID, `ClientConfig::built_in()` is
//! None and the app hides Google Docs.

/// Where each Google call goes. Tests and scenes point these at the fake server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// The consent and Picker page, opened in the system browser.
    pub auth: String,
    pub token: String,
    pub revoke: String,
    /// `https://docs.googleapis.com`: `/v1/documents/{id}`.
    pub docs: String,
    /// `https://www.googleapis.com`: `/drive/v3/...`.
    pub drive: String,
}

impl Endpoints {
    pub fn google() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            docs: "https://docs.googleapis.com".into(),
            drive: "https://www.googleapis.com".into(),
        }
    }

    /// Every endpoint on one local base URL, the fake server's layout.
    pub fn local(base: &str) -> Self {
        let base = base.trim_end_matches('/');
        Self {
            auth: format!("{base}/o/oauth2/v2/auth"),
            token: format!("{base}/token"),
            revoke: format!("{base}/revoke"),
            docs: base.to_string(),
            drive: base.to_string(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ClientConfig {
    pub client_id: String,
    /// The Desktop client's non-confidential secret, when Google issued one.
    pub client_secret: Option<String>,
    pub endpoints: Endpoints,
}

// Never print the client in a log line by accident.
impl std::fmt::Debug for ClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientConfig").field("client_id", &"<set>").field("endpoints", &self.endpoints).finish()
    }
}

const BUILT_IN_ID: Option<&str> = option_env!("MARKIE_GOOGLE_DESKTOP_CLIENT_ID");
const BUILT_IN_SECRET: Option<&str> = option_env!("MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET");

impl ClientConfig {
    /// The client this build was compiled with, or None: the feature is hidden.
    pub fn built_in() -> Option<Self> {
        Self::from_parts(BUILT_IN_ID, BUILT_IN_SECRET, Endpoints::google())
    }

    pub fn from_parts(id: Option<&str>, secret: Option<&str>, endpoints: Endpoints) -> Option<Self> {
        let id = id.map(str::trim).filter(|s| !s.is_empty())?;
        let secret = secret.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        Some(Self { client_id: id.to_string(), client_secret: secret, endpoints })
    }

    /// For tests and scenes: a made-up client against the fake server.
    pub fn fake(base: &str) -> Self {
        Self { client_id: "fake-client.apps.example".into(), client_secret: None, endpoints: Endpoints::local(base) }
    }
}

/// Whether this build carries a Desktop OAuth client.
pub fn built_in_available() -> bool {
    ClientConfig::built_in().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_client_id_means_the_feature_is_hidden() {
        assert!(ClientConfig::from_parts(None, None, Endpoints::google()).is_none());
        assert!(ClientConfig::from_parts(Some("  "), Some("s"), Endpoints::google()).is_none());
        let c = ClientConfig::from_parts(Some("id"), Some(""), Endpoints::google()).unwrap();
        assert_eq!(c.client_secret, None);
    }

    #[test]
    fn debug_output_never_shows_the_client() {
        let c = ClientConfig::from_parts(Some("very-private-id"), Some("very-private-secret"), Endpoints::google()).unwrap();
        let shown = format!("{c:?}");
        assert!(!shown.contains("very-private"));
    }
}
