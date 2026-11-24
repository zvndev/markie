//! Sign-in against one server. Port of src/lib/auth-client.ts and auth-state.ts.
//!
//! The token arrives in the `set-auth-token` header (better-auth's bearer
//! plugin), or in the body of the identity code flow. It is stored for this
//! client's origin only, and the account it belongs to is confirmed by
//! `/api/me` before anything treats it as known.
use crate::client::{Call, CloudClient};
use crate::error::{CloudError, Result};
use crate::http::{Answer, Method};
use crate::origin::{canonical_cloud_origin, origin_of};
use crate::tokens;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkieUser {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// The outcome of a sign-in or sign-up call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInOutcome {
    /// A session was stored and `/api/me` confirmed the account.
    SignedIn(MarkieUser),
    /// The account exists but its email is not proven yet (sign-up, or a
    /// sign-in before verification). A code was sent; call `verify_email`.
    NeedsVerification,
}

/// The code sign-in flow a `send_code` started, handed back to `verify_code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeFlow {
    /// Older servers: better-auth's own email-otp sign-in.
    Legacy { email: String },
    /// Servers with verified identities: a challenge bound to this flow id.
    Identity { email: String, challenge_id: String, flow_id: String },
}

/// The better-auth error code in a failure body, for choosing a message.
pub fn failure_code(data: Option<&Value>) -> &str {
    data.and_then(|d| d.get("code")).and_then(Value::as_str).unwrap_or("")
}

fn valid_challenge(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn valid_flow(s: &str) -> bool {
    s.len() == 43 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Sign-in calls for one server.
pub struct AuthClient<'a> {
    client: &'a CloudClient,
}

impl<'a> AuthClient<'a> {
    pub fn new(client: &'a CloudClient) -> Self {
        Self { client }
    }

    async fn anon(&self, path: &str, body: Value) -> Result<Answer> {
        self.client.call(Call::new(Method::Post, path).json(body).anonymous()).await
    }

    /// Adopt the token an answer carries, then confirm whose it is.
    async fn adopt(&self, answer: &Answer, body_token: Option<&str>) -> Result<Option<MarkieUser>> {
        let token = answer.set_auth_token.as_deref().or(body_token);
        let Some(token) = token else { return Ok(None) };
        self.client.set_token(Some(token))?;
        self.me().await
    }

    /// `GET /api/me`. Confirms the stored token's account when the server names one.
    pub async fn me(&self) -> Result<Option<MarkieUser>> {
        let Some(asked) = self.client.token() else { return Ok(None) };
        let answer = self.client.get("/api/me").await?.into_ok()?;
        let user = answer.data.as_ref().and_then(|d| d.get("user")).filter(|u| !u.is_null()).cloned();
        let Some(user) = user else { return Ok(None) };
        let user: MarkieUser = serde_json::from_value(user).map_err(|_| CloudError::Unreadable)?;
        tokens::confirm(self.client.tokens().as_ref(), self.client.origin(), &asked, &user.id)?;
        Ok(Some(user))
    }

    pub async fn sign_in_email(&self, email: &str, password: &str) -> Result<SignInOutcome> {
        let answer = self.anon("/api/auth/sign-in/email", json!({ "email": email, "password": password })).await?;
        if answer.status == 403 && failure_code(answer.data.as_ref()) == "EMAIL_NOT_VERIFIED" {
            return Ok(SignInOutcome::NeedsVerification);
        }
        let answer = answer.into_ok()?;
        match self.adopt(&answer, None).await? {
            Some(user) => Ok(SignInOutcome::SignedIn(user)),
            None => Err(CloudError::Unreadable),
        }
    }

    pub async fn sign_up_email(&self, email: &str, password: &str, name: &str) -> Result<SignInOutcome> {
        let answer = self
            .anon("/api/auth/sign-up/email", json!({ "email": email, "password": password, "name": name }))
            .await?
            .into_ok()?;
        match self.adopt(&answer, None).await? {
            Some(user) => Ok(SignInOutcome::SignedIn(user)),
            None => Ok(SignInOutcome::NeedsVerification),
        }
    }

    /// Start a sign-in by emailed code. Uses the verified-identity flow when the
    /// server advertises it, and better-auth's legacy route when it has no
    /// capabilities route at all.
    pub async fn send_code(&self, email: &str) -> Result<CodeFlow> {
        let email = email.trim().to_lowercase();
        let caps = self.client.call(Call::new(Method::Get, "/api/account/capabilities").anonymous().max_bytes(8192)).await?;
        if caps.status == 404 {
            self.anon("/api/auth/email-otp/send-verification-otp", json!({ "email": email, "type": "sign-in" })).await?.into_ok()?;
            return Ok(CodeFlow::Legacy { email });
        }
        let advertised = caps.data.as_ref().and_then(|d| d.get("verifiedIdentities")).and_then(Value::as_bool) == Some(true);
        if !caps.ok() || !advertised {
            return Err(CloudError::Status { status: if caps.ok() { 503 } else { caps.status }, message: None, code: None });
        }
        let started = self
            .client
            .call(Call::new(Method::Post, "/api/account/identities/sign-in/start").json(json!({ "email": email })).anonymous().max_bytes(8192))
            .await?
            .json()?;
        let challenge = started.get("challengeId").and_then(Value::as_str).filter(|s| valid_challenge(s));
        let flow = started.get("flowId").and_then(Value::as_str).filter(|s| valid_flow(s));
        match (challenge, flow) {
            (Some(c), Some(f)) => Ok(CodeFlow::Identity { email, challenge_id: c.into(), flow_id: f.into() }),
            _ => Err(CloudError::Unreadable),
        }
    }

    /// Finish a code sign-in.
    pub async fn verify_code(&self, flow: &CodeFlow, code: &str) -> Result<MarkieUser> {
        match flow {
            CodeFlow::Legacy { email } => {
                let answer = self.anon("/api/auth/sign-in/email-otp", json!({ "email": email, "otp": code })).await?.into_ok()?;
                self.adopt(&answer, None).await?.ok_or(CloudError::Unreadable)
            }
            CodeFlow::Identity { challenge_id, flow_id, .. } => {
                let answer = self
                    .client
                    .call(
                        Call::new(Method::Post, "/api/account/identities/sign-in/verify")
                            .json(json!({ "challengeId": challenge_id, "flowId": flow_id, "code": code }))
                            .anonymous()
                            .max_bytes(8192),
                    )
                    .await?
                    .into_ok()?;
                let token = answer.data.as_ref().and_then(|d| d.get("token")).and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() <= 4096).map(str::to_string);
                let Some(token) = token else { return Err(CloudError::Unreadable) };
                self.adopt(&Answer { set_auth_token: None, ..answer }, Some(&token)).await?.ok_or(CloudError::Unreadable)
            }
        }
    }

    /// Send the code that proves an address (after sign-up).
    pub async fn send_verification_code(&self, email: &str) -> Result<()> {
        self.anon("/api/auth/email-otp/send-verification-otp", json!({ "email": email, "type": "email-verification" })).await?.into_ok()?;
        Ok(())
    }

    /// Prove the address. The server signs the account in on success.
    pub async fn verify_email(&self, email: &str, otp: &str) -> Result<Option<MarkieUser>> {
        let answer = self.anon("/api/auth/email-otp/verify-email", json!({ "email": email, "otp": otp })).await?.into_ok()?;
        let body_token = answer.data.as_ref().and_then(|d| d.get("token")).and_then(Value::as_str).map(str::to_string);
        self.adopt(&answer, body_token.as_deref()).await
    }

    pub async fn request_password_reset(&self, email: &str) -> Result<()> {
        self.anon("/api/auth/forget-password/email-otp", json!({ "email": email })).await?.into_ok()?;
        Ok(())
    }

    pub async fn reset_password(&self, email: &str, otp: &str, password: &str) -> Result<()> {
        self.anon("/api/auth/email-otp/reset-password", json!({ "email": email, "otp": otp, "password": password })).await?.into_ok()?;
        Ok(())
    }

    /// End the session at the server and forget the token, if it is still the one asked with.
    pub async fn sign_out(&self) -> Result<()> {
        let Some(asked) = self.client.token() else { return Ok(()) };
        let res = self.client.post("/api/auth/sign-out", json!({})).await;
        if self.client.token().as_deref() == Some(asked.as_str()) {
            self.client.set_token(None)?;
        }
        res.map(|_| ())
    }

    /// The browser start URL for Google or Apple, with a fresh single-use nonce
    /// tied to this server. Open it in the system browser. `app=markie-rs`
    /// asks the server's bridge to answer on Markie RS's own scheme, so the
    /// answer comes back as a `markie-rs://auth` link checked by
    /// `resolve_auth_deep_link`. A server that predates that parameter answers
    /// `markie://auth`, which this app never claims and always refuses.
    pub fn browser_start_url(&self, provider: Provider, states: &AuthStates) -> Option<String> {
        let state = states.create(self.client.origin())?;
        Some(format!("{}/auth/{}-start?state={}&app={}", self.client.origin(), provider.slug(), state, HAND_BACK_APP))
    }

    /// Adopt the token a checked hand-back link carried, and confirm whose it
    /// is. None when the server does not recognise it.
    pub async fn adopt_token(&self, token: &str) -> Result<Option<MarkieUser>> {
        self.client.set_token(Some(token))?;
        match self.me().await {
            Ok(Some(user)) => Ok(Some(user)),
            other => {
                // A token the server will not name is no session; do not keep it.
                if self.client.token().as_deref() == Some(token) {
                    self.client.set_token(None)?;
                }
                other
            }
        }
    }
}

/// The URL scheme Markie RS registers for the Google and Apple hand-back. It is
/// never `markie`: that scheme belongs to the Electron app.
pub const HAND_BACK_SCHEME: &str = markie_core::paths::URL_SCHEME;

/// The `app` value that asks the server's desktop bridge for `markie-rs://`.
pub const HAND_BACK_APP: &str = markie_core::paths::URL_SCHEME;

/// Whether a URL macOS handed the app is a sign-in hand-back for it.
pub fn is_hand_back_link(link: &str) -> bool {
    url::Url::parse(link).is_ok_and(|u| u.scheme() == HAND_BACK_SCHEME)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Google,
    Apple,
}

impl Provider {
    fn slug(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Apple => "apple",
        }
    }
}

/// How long a pending browser sign-in stays answerable.
pub const AUTH_STATE_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone)]
struct Pending {
    value: String,
    created_at: u64,
    origin: Option<String>,
}

/// The one pending browser sign-in. Minting replaces it; checking consumes it.
pub struct AuthStates {
    pending: Mutex<Option<Pending>>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for AuthStates {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthStates {
    pub fn new() -> Self {
        Self::with_clock(Box::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)))
    }

    pub fn with_clock(now: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self { pending: Mutex::new(None), now }
    }

    /// A fresh 16-byte hex nonce for a sign-in against `origin`.
    pub fn create(&self, origin: &str) -> Option<String> {
        let mut b = [0u8; 16];
        getrandom::fill(&mut b).ok()?;
        let value = hex::encode(b);
        *self.pending.lock().unwrap() = Some(Pending { value: value.clone(), created_at: (self.now)(), origin: Some(origin.to_string()) });
        Some(value)
    }

    fn consume(&self, candidate: Option<&str>) -> Option<Option<String>> {
        let pending = self.pending.lock().unwrap().take()?;
        let candidate = candidate?;
        if (self.now)().saturating_sub(pending.created_at) > AUTH_STATE_TTL_MS || pending.value != candidate {
            return None;
        }
        Some(pending.origin)
    }

    pub fn clear(&self) {
        *self.pending.lock().unwrap() = None;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkRefusal {
    NotAuth,
    NoPending,
    IssuerMismatch,
}

/// A token a deep link may adopt, and the server it belongs to (None = primary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLinkToken {
    pub token: String,
    pub origin: Option<String>,
}

fn normalize_origin(v: &str) -> Option<String> {
    let u = url::Url::parse(v).ok()?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return None;
    }
    origin_of(v).map(|o| canonical_cloud_origin(&o))
}

/// Decide what a `markie-rs://auth?token=…&state=…&iss=…` link may do. Only
/// Markie RS's own scheme is accepted; `markie://` belongs to the Electron app
/// and is refused like any other URL. The nonce
/// says which server the sign-in started against; `iss` says which server
/// minted the token. They must agree. The pending nonce is consumed whatever
/// the answer, so a refused link cannot be replayed.
pub fn resolve_auth_deep_link(link: &str, primary_origin: &str, states: &AuthStates) -> std::result::Result<DeepLinkToken, DeepLinkRefusal> {
    let Ok(u) = url::Url::parse(link) else { return Err(DeepLinkRefusal::NotAuth) };
    let q = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    let token = q("token").filter(|t| !t.is_empty());
    if u.scheme() != HAND_BACK_SCHEME || u.host_str() != Some("auth") || token.is_none() {
        return Err(DeepLinkRefusal::NotAuth);
    }
    let Some(pending_origin) = states.consume(q("state").as_deref()) else { return Err(DeepLinkRefusal::NoPending) };
    let primary = normalize_origin(primary_origin);
    let started = match pending_origin {
        None => primary.clone(),
        Some(o) => normalize_origin(&o),
    };
    let Some(started) = started else { return Err(DeepLinkRefusal::IssuerMismatch) };
    let raw_iss = q("iss");
    let iss = raw_iss.as_deref().and_then(normalize_origin);
    if raw_iss.is_some() && iss.is_none() {
        return Err(DeepLinkRefusal::IssuerMismatch);
    }
    let token = token.unwrap();
    if Some(&started) == primary.as_ref() {
        if iss.is_some() && iss != primary {
            return Err(DeepLinkRefusal::IssuerMismatch);
        }
        return Ok(DeepLinkToken { token, origin: None });
    }
    if iss.as_deref() != Some(started.as_str()) {
        return Err(DeepLinkRefusal::IssuerMismatch);
    }
    Ok(DeepLinkToken { token, origin: Some(started) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_SERVER;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    const SELF: &str = "https://docs.example.com";

    fn states() -> (AuthStates, Arc<AtomicU64>) {
        let t = Arc::new(AtomicU64::new(1_000_000));
        let c = t.clone();
        (AuthStates::with_clock(Box::new(move || c.load(Ordering::SeqCst))), t)
    }

    #[test]
    fn a_primary_sign_in_takes_its_own_issuer_or_none() {
        let (s, _) = states();
        let n = s.create(DEFAULT_SERVER).unwrap();
        assert_eq!(n.len(), 32);
        let link = format!("markie-rs://auth?token=tok&state={n}");
        assert_eq!(resolve_auth_deep_link(&link, DEFAULT_SERVER, &s), Ok(DeepLinkToken { token: "tok".into(), origin: None }));
        // Single use.
        assert_eq!(resolve_auth_deep_link(&link, DEFAULT_SERVER, &s), Err(DeepLinkRefusal::NoPending));
        let n = s.create(DEFAULT_SERVER).unwrap();
        let link = format!("markie-rs://auth?token=tok&state={n}&iss={}", urlenc("https://api-production-602f.up.railway.app"));
        assert!(resolve_auth_deep_link(&link, DEFAULT_SERVER, &s).is_ok());
        let n = s.create(DEFAULT_SERVER).unwrap();
        let link = format!("markie-rs://auth?token=tok&state={n}&iss={}", urlenc(SELF));
        assert_eq!(resolve_auth_deep_link(&link, DEFAULT_SERVER, &s), Err(DeepLinkRefusal::IssuerMismatch));
    }

    #[test]
    fn another_server_needs_its_issuer() {
        let (s, _) = states();
        let n = s.create(SELF).unwrap();
        assert_eq!(resolve_auth_deep_link(&format!("markie-rs://auth?token=t&state={n}"), DEFAULT_SERVER, &s), Err(DeepLinkRefusal::IssuerMismatch));
        let n = s.create(SELF).unwrap();
        let ok = resolve_auth_deep_link(&format!("markie-rs://auth?token=t&state={n}&iss={}", urlenc(SELF)), DEFAULT_SERVER, &s);
        assert_eq!(ok, Ok(DeepLinkToken { token: "t".into(), origin: Some(SELF.into()) }));
        let n = s.create(SELF).unwrap();
        let bounced = resolve_auth_deep_link(&format!("markie-rs://auth?token=t&state={n}&iss={}", urlenc(DEFAULT_SERVER)), DEFAULT_SERVER, &s);
        assert_eq!(bounced, Err(DeepLinkRefusal::IssuerMismatch));
    }

    #[test]
    fn stale_wrong_or_foreign_links_are_refused() {
        let (s, t) = states();
        let n = s.create(DEFAULT_SERVER).unwrap();
        t.fetch_add(AUTH_STATE_TTL_MS + 1, Ordering::SeqCst);
        assert_eq!(resolve_auth_deep_link(&format!("markie-rs://auth?token=t&state={n}"), DEFAULT_SERVER, &s), Err(DeepLinkRefusal::NoPending));
        s.create(DEFAULT_SERVER).unwrap();
        assert_eq!(resolve_auth_deep_link("markie-rs://auth?token=t&state=beef", DEFAULT_SERVER, &s), Err(DeepLinkRefusal::NoPending));
        assert_eq!(resolve_auth_deep_link("markie-rs://open?token=t", DEFAULT_SERVER, &s), Err(DeepLinkRefusal::NotAuth));
        assert_eq!(resolve_auth_deep_link("markie-rs://auth?state=x", DEFAULT_SERVER, &s), Err(DeepLinkRefusal::NotAuth));
        assert_eq!(resolve_auth_deep_link("https://auth?token=t", DEFAULT_SERVER, &s), Err(DeepLinkRefusal::NotAuth));
    }

    #[test]
    fn the_electron_scheme_is_refused_and_keeps_the_pending_sign_in() {
        let (s, _) = states();
        let n = s.create(DEFAULT_SERVER).unwrap();
        // Electron's scheme, a lookalike and a different host are all refused
        // before the nonce is touched, so the real answer still lands.
        for link in [
            format!("markie://auth?token=t&state={n}"),
            format!("markie-rs2://auth?token=t&state={n}"),
            format!("MARKIE://auth?token=t&state={n}"),
            format!("markie-rs://doc?token=t&state={n}"),
            format!("markie-rs:auth?token=t&state={n}"),
        ] {
            assert_eq!(resolve_auth_deep_link(&link, DEFAULT_SERVER, &s), Err(DeepLinkRefusal::NotAuth), "{link}");
        }
        assert!(resolve_auth_deep_link(&format!("markie-rs://auth?token=t&state={n}"), DEFAULT_SERVER, &s).is_ok());
    }

    #[test]
    fn start_urls_ask_for_the_markie_rs_hand_back() {
        use crate::http::Transport;
        use crate::origin::Trust;
        use crate::tokens::MemoryTokenStore;
        let trust = Arc::new(std::sync::RwLock::new(Trust::cloud_only()));
        let client = CloudClient::new(DEFAULT_SERVER, trust, Arc::new(MemoryTokenStore::new()), Transport::new()).unwrap();
        let (s, _) = states();
        for (provider, slug) in [(Provider::Google, "google"), (Provider::Apple, "apple")] {
            let url = AuthClient::new(&client).browser_start_url(provider, &s).unwrap();
            let u = url::Url::parse(&url).unwrap();
            assert_eq!(u.path(), format!("/auth/{slug}-start"));
            let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
            assert_eq!(q.get("app").map(String::as_str), Some("markie-rs"));
            assert_eq!(q.get("state").map(String::len), Some(32));
        }
        assert!(is_hand_back_link("markie-rs://auth?token=t"));
        assert!(!is_hand_back_link("markie://auth?token=t"));
        assert!(!is_hand_back_link("file:///tmp/a.md"));
    }

    fn urlenc(s: &str) -> String {
        crate::client::seg(s)
    }
}
