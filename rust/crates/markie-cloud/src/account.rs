//! The signed-in account's linked sign-ins. A port of
//! src/lib/account-identities.ts: the listing with its checks, and the
//! changes, each behind a step-up proof from the primary email: link another
//! email, link Google or Apple through the browser, and unlink either.
use crate::client::{Call, CloudClient};
use crate::error::CloudError;
use crate::http::Method;
use serde_json::Value;

/// A verified email that reaches the account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountIdentity {
    pub id: String,
    pub email: String,
    pub primary: bool,
}

/// A Google or Apple sign-in linked to the account. `email` names which one
/// when the server recorded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountProvider {
    pub id: String,
    pub provider_id: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Identities {
    pub identities: Vec<AccountIdentity>,
    pub providers: Vec<AccountProvider>,
    pub google_available: bool,
    pub apple_available: bool,
}

/// Why the listing is not on screen, with the sentence Electron shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentitiesError {
    /// The server has no linked sign-ins (404 or 501). Shown muted, not red.
    Unsupported,
    Failed(String),
}

impl IdentitiesError {
    pub fn message(&self) -> &str {
        match self {
            IdentitiesError::Unsupported => {
                "This server does not support linked sign-ins or cloud areas yet. Your account and documents are unchanged."
            }
            IdentitiesError::Failed(m) => m,
        }
    }
}

const INVALID: &str = "The server returned invalid account information.";
const MAX_BYTES: usize = 65_536;

fn valid_id(v: &str) -> bool {
    (1..=128).contains(&v.len()) && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn identity(v: &Value) -> Option<AccountIdentity> {
    let id = v.get("id")?.as_str().filter(|s| valid_id(s))?;
    let email = v.get("email")?.as_str().filter(|s| s.len() <= 320)?;
    let primary = v.get("primary")?.as_bool()?;
    match v.get("verifiedAt") {
        Some(Value::Null | Value::String(_) | Value::Number(_)) => {}
        _ => return None,
    }
    Some(AccountIdentity { id: id.into(), email: email.into(), primary })
}

fn provider(v: &Value) -> Option<AccountProvider> {
    let id = v.get("id")?.as_str().filter(|s| valid_id(s))?;
    let provider_id = v.get("providerId")?.as_str().filter(|s| s.len() <= 80)?;
    // A label only. One that is not a short printable line is left off.
    let email = v
        .get("email")
        .and_then(Value::as_str)
        .filter(|e| e.len() <= 320 && !e.chars().any(|c| c.is_control()))
        .map(str::to_string);
    Some(AccountProvider { id: id.into(), provider_id: provider_id.into(), email })
}

/// Read a listing body. None when it is not the shape Electron accepts.
pub fn parse_identities(data: &Value) -> Option<Identities> {
    let list = data.get("identities")?.as_array().filter(|a| a.len() <= 100)?;
    let identities = list.iter().map(identity).collect::<Option<Vec<_>>>()?;
    let providers = match data.get("providers") {
        None => Vec::new(),
        Some(p) => p.as_array().filter(|a| a.len() <= 100)?.iter().map(provider).collect::<Option<Vec<_>>>()?,
    };
    Some(Identities {
        identities,
        providers,
        google_available: data.get("googleAvailable").and_then(Value::as_bool) == Some(true),
        apple_available: data.get("appleAvailable").and_then(Value::as_bool) == Some(true),
    })
}

/// `failure(status, code)` from account-identities.ts, word for word.
pub fn failure_message(status: u16, code: &str) -> String {
    let lower = code.to_ascii_lowercase();
    let step_up = regex_like(&lower, &["proof", "step-up", "stepup", "step up", "step_up"]);
    let code_word = regex_like(&lower, &["code", "otp", "expired", "verification"]);
    let msg = if status == 404 || status == 501 {
        "This server does not support linked sign-ins or cloud areas yet. Your account and documents are unchanged."
    } else if status == 401 {
        "Sign in again to confirm this account."
    } else if code == "identity-not-removable" {
        "The primary sign-in cannot be removed."
    } else if code == "identity-limit" {
        "This account already has the most linked emails it can hold. Unlink one first."
    } else if status == 409 {
        "That email already belongs to another account. Accounts were not merged."
    } else if lower.contains("primary") {
        "The primary sign-in cannot be removed."
    } else if step_up {
        "Confirm your primary email again before making this change."
    } else if code_word {
        "That code is incorrect or expired. Request a new code."
    } else if status == 429 {
        "Too many attempts. Wait before requesting another code."
    } else if status == 403 {
        "This account is not allowed to make that change."
    } else {
        "The account change could not be completed. Nothing was merged."
    };
    msg.to_string()
}

/// `/proof|step.?up/i` and `/code|otp|expired|verification/i`, without a regex.
fn regex_like(lower: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| lower.contains(n))
}

/// A refused or failed account change, with the sentence Electron shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl AccountError {
    fn new(status: u16, code: &str) -> Self {
        Self { status, code: code.into(), message: failure_message(status, code) }
    }
    fn invalid() -> Self {
        Self { status: 0, code: "invalid-response".into(), message: INVALID.into() }
    }
    /// The server has no linked sign-ins: shown muted.
    pub fn unsupported(&self) -> bool {
        self.code == "unsupported"
    }
}

/// What a change is for. Each asks for its own proof, so one confirmed code
/// never does another change's job (`IdentityScope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepUp {
    EmailAdd,
    EmailRemove,
    Link(LinkProvider),
    Remove(LinkProvider),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkProvider {
    Google,
    Apple,
}

impl LinkProvider {
    pub fn id(self) -> &'static str {
        match self {
            LinkProvider::Google => "google",
            LinkProvider::Apple => "apple",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            LinkProvider::Google => "Google",
            LinkProvider::Apple => "Apple",
        }
    }
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "google" => Some(LinkProvider::Google),
            "apple" => Some(LinkProvider::Apple),
            _ => None,
        }
    }
}

impl StepUp {
    pub fn scope(self) -> String {
        match self {
            StepUp::EmailAdd => "email-add".into(),
            StepUp::EmailRemove => "email-remove".into(),
            StepUp::Link(p) => format!("{}-link", p.id()),
            StepUp::Remove(p) => format!("{}-remove", p.id()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub challenge_id: String,
    pub expires_in_seconds: u64,
}

/// A browser link in progress (`startProviderLink`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderLink {
    pub intent_id: String,
    pub browser_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStatus {
    Pending,
    Complete,
    Expired,
}

/// One `/api/account` call, bound to this client's session (`call`).
async fn account_call(client: &CloudClient, path: &str, method: Method, body: Option<Value>) -> Result<serde_json::Map<String, Value>, AccountError> {
    let full = format!("/api/account{path}");
    let mut call = Call::new(method, &full).max_bytes(MAX_BYTES);
    if let Some(b) = body {
        call = call.json(b);
    }
    let answer = client.call(call).await.map_err(|e| match e {
        CloudError::NotSignedIn | CloudError::StaleSession => AccountError::new(401, "session"),
        CloudError::TooLarge | CloudError::Unreadable => AccountError::invalid(),
        _ => AccountError::new(0, "request-failed"),
    })?;
    if answer.status == 404 || answer.status == 501 {
        return Err(AccountError::new(answer.status, "unsupported"));
    }
    let data = match answer.data.clone() {
        Some(Value::Object(m)) => m,
        _ if !answer.ok() => serde_json::Map::new(),
        _ => return Err(AccountError::invalid()),
    };
    if !answer.ok() {
        let code = data.get("code").or_else(|| data.get("error")).and_then(Value::as_str).unwrap_or("request-failed");
        return Err(AccountError::new(answer.status, code));
    }
    Ok(data)
}

fn challenge(data: &serde_json::Map<String, Value>) -> Result<Challenge, AccountError> {
    let id = data.get("challengeId").and_then(Value::as_str).filter(|s| valid_id(s)).ok_or_else(AccountError::invalid)?;
    let secs = data.get("expiresInSeconds").and_then(Value::as_u64).filter(|n| *n >= 1).ok_or_else(AccountError::invalid)?;
    Ok(Challenge { challenge_id: id.into(), expires_in_seconds: secs })
}

/// `startStepUp`: a code to the primary email, for one change.
pub async fn start_step_up(client: &CloudClient, scope: StepUp) -> Result<Challenge, AccountError> {
    challenge(&account_call(client, "/identities/step-up/start", Method::Post, Some(serde_json::json!({ "scope": scope.scope() }))).await?)
}

/// `verifyStepUp`: the proof id the change takes.
pub async fn verify_step_up(client: &CloudClient, challenge_id: &str, code: &str) -> Result<String, AccountError> {
    let data = account_call(client, "/identities/step-up/verify", Method::Post, Some(serde_json::json!({ "challengeId": challenge_id, "code": code }))).await?;
    data.get("proofId").and_then(Value::as_str).filter(|s| valid_id(s)).map(str::to_string).ok_or_else(AccountError::invalid)
}

/// `startEmail`: a code to the new address.
pub async fn start_email(client: &CloudClient, email: &str, proof_id: &str) -> Result<Challenge, AccountError> {
    challenge(&account_call(client, "/identities/email/start", Method::Post, Some(serde_json::json!({ "email": email.trim(), "proofId": proof_id }))).await?)
}

/// `verifyEmail`: the new address, now linked.
pub async fn verify_email(client: &CloudClient, challenge_id: &str, code: &str) -> Result<AccountIdentity, AccountError> {
    let data = account_call(client, "/identities/email/verify", Method::Post, Some(serde_json::json!({ "challengeId": challenge_id, "code": code }))).await?;
    data.get("identity").and_then(identity).ok_or_else(AccountError::invalid)
}

/// `unlink`: remove a linked email.
pub async fn unlink(client: &CloudClient, identity_id: &str, proof_id: &str) -> Result<(), AccountError> {
    if !valid_id(identity_id) {
        return Err(AccountError::invalid());
    }
    account_call(client, &format!("/identities/{identity_id}"), Method::Delete, Some(serde_json::json!({ "proofId": proof_id }))).await.map(|_| ())
}

/// Whether a browser handoff is this server's own linking page for this
/// intent: `/account/link-<provider>#<intent>.<43-char secret>`, nothing else.
pub fn check_link_url(browser_url: &str, server: &str, provider: LinkProvider, intent_id: &str) -> Option<String> {
    let target = url::Url::parse(browser_url).ok()?;
    let base = url::Url::parse(server).ok()?;
    let hash = target.fragment()?;
    let (intent, secret) = hash.split_once('.')?;
    let ok = target.origin() == base.origin()
        && target.path() == format!("/account/link-{}", provider.id())
        && target.username().is_empty()
        && target.password().is_none()
        && target.query().is_none()
        && intent == intent_id
        && !intent.is_empty()
        && intent.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && secret.len() == 43
        && secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    ok.then(|| target.to_string())
}

/// `startProviderLink`: the browser page that links Google or Apple.
pub async fn start_provider_link(client: &CloudClient, provider: LinkProvider, proof_id: &str) -> Result<ProviderLink, AccountError> {
    let data = account_call(client, &format!("/identities/{}/start", provider.id()), Method::Post, Some(serde_json::json!({ "proofId": proof_id }))).await?;
    let intent = data.get("intentId").and_then(Value::as_str).filter(|s| valid_id(s)).ok_or_else(AccountError::invalid)?;
    let url = data.get("browserUrl").and_then(Value::as_str).ok_or_else(AccountError::invalid)?;
    let browser_url = check_link_url(url, client.origin(), provider, intent).ok_or_else(AccountError::invalid)?;
    Ok(ProviderLink { intent_id: intent.into(), browser_url })
}

/// `providerLinkStatus`.
pub async fn provider_link_status(client: &CloudClient, provider: LinkProvider, intent_id: &str) -> Result<LinkStatus, AccountError> {
    if !valid_id(intent_id) {
        return Err(AccountError::invalid());
    }
    let data = account_call(client, &format!("/identities/{}/{intent_id}", provider.id()), Method::Get, None).await?;
    if data.get("intentId").and_then(Value::as_str) != Some(intent_id) {
        return Err(AccountError::invalid());
    }
    match data.get("status").and_then(Value::as_str) {
        Some("pending") => Ok(LinkStatus::Pending),
        Some("complete") => Ok(LinkStatus::Complete),
        Some("expired") => Ok(LinkStatus::Expired),
        _ => Err(AccountError::invalid()),
    }
}

/// `unlinkProvider`: remove a Google or Apple sign-in. The server signs out
/// every session of the account, this one too.
pub async fn unlink_provider(client: &CloudClient, provider: LinkProvider, provider_row: &str, proof_id: &str) -> Result<(), AccountError> {
    if !valid_id(provider_row) {
        return Err(AccountError::invalid());
    }
    let data = account_call(client, &format!("/identities/{}-provider/{provider_row}", provider.id()), Method::Delete, Some(serde_json::json!({ "proofId": proof_id }))).await?;
    if data.get("ok") != Some(&Value::Bool(true)) || data.get("signedOut") != Some(&Value::Bool(true)) {
        return Err(AccountError::invalid());
    }
    Ok(())
}

/// `GET /api/account/identities` with this client's session.
pub async fn identities(client: &CloudClient) -> Result<Identities, IdentitiesError> {
    let answer = client
        .call(Call::new(Method::Get, "/api/account/identities").max_bytes(MAX_BYTES))
        .await
        .map_err(|e| match e {
            CloudError::TooLarge => IdentitiesError::Failed(INVALID.into()),
            CloudError::NotSignedIn => IdentitiesError::Failed("Sign in again to confirm this account on the current server.".into()),
            _ => IdentitiesError::Failed("Linked sign-ins could not be loaded.".into()),
        })?;
    if answer.status == 404 || answer.status == 501 {
        return Err(IdentitiesError::Unsupported);
    }
    if !answer.ok() {
        let code = answer
            .data
            .as_ref()
            .and_then(|d| d.get("code").or_else(|| d.get("error")))
            .and_then(Value::as_str)
            .unwrap_or("request-failed");
        return Err(IdentitiesError::Failed(failure_message(answer.status, code)));
    }
    answer.data.as_ref().and_then(parse_identities).ok_or_else(|| IdentitiesError::Failed(INVALID.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_identities_and_providers() {
        let body = json!({
            "identities": [
                { "id": "id_1", "email": "a@example.com", "primary": true, "verifiedAt": "2026-01-01" },
                { "id": "id-2", "email": "b@example.com", "primary": false, "verifiedAt": null }
            ],
            "providers": [
                { "id": "p1", "providerId": "google", "email": "a@gmail.com" },
                { "id": "p2", "providerId": "apple", "email": "bad\u{0007}line" }
            ],
            "googleAvailable": true
        });
        let got = parse_identities(&body).unwrap();
        assert_eq!(got.identities.len(), 2);
        assert!(got.identities[0].primary);
        assert_eq!(got.providers[0].email.as_deref(), Some("a@gmail.com"));
        // A label with a control character is dropped, the row is kept.
        assert_eq!(got.providers[1].email, None);
        assert!(got.google_available);
        assert!(!got.apple_available);
    }

    #[test]
    fn refuses_bodies_electron_refuses() {
        assert!(parse_identities(&json!({})).is_none());
        assert!(parse_identities(&json!({ "identities": [{ "id": "a b", "email": "x", "primary": true, "verifiedAt": null }] })).is_none());
        assert!(parse_identities(&json!({ "identities": [{ "id": "a", "email": "x", "primary": true }] })).is_none());
        assert!(parse_identities(&json!({ "identities": [], "providers": "google" })).is_none());
        assert!(parse_identities(&json!({ "identities": [] })).is_some());
    }

    #[test]
    fn every_failure_reads_like_account_identities_ts() {
        assert_eq!(failure_message(404, "unsupported"), IdentitiesError::Unsupported.message());
        assert_eq!(failure_message(400, "identity-not-removable"), "The primary sign-in cannot be removed.");
        assert_eq!(failure_message(400, "identity-limit"), "This account already has the most linked emails it can hold. Unlink one first.");
        assert_eq!(failure_message(409, "email-taken"), "That email already belongs to another account. Accounts were not merged.");
        assert_eq!(failure_message(400, "step-up-required"), "Confirm your primary email again before making this change.");
        assert_eq!(failure_message(400, "invalid-proof"), "Confirm your primary email again before making this change.");
        assert_eq!(failure_message(400, "otp-invalid"), "That code is incorrect or expired. Request a new code.");
        assert_eq!(failure_message(429, "rate"), "Too many attempts. Wait before requesting another code.");
        assert_eq!(failure_message(403, "nope"), "This account is not allowed to make that change.");
        assert_eq!(failure_message(500, "boom"), "The account change could not be completed. Nothing was merged.");
        assert_eq!(StepUp::Link(LinkProvider::Apple).scope(), "apple-link");
        assert_eq!(StepUp::Remove(LinkProvider::Google).scope(), "google-remove");
        assert_eq!(StepUp::EmailAdd.scope(), "email-add");
    }

    #[test]
    fn a_link_page_must_be_this_servers_own() {
        let secret = "a".repeat(43);
        let good = format!("https://docs.example.com/account/link-google#int_1.{secret}");
        assert!(check_link_url(&good, "https://docs.example.com", LinkProvider::Google, "int_1").is_some());
        for bad in [
            format!("https://evil.example.com/account/link-google#int_1.{secret}"),
            format!("https://docs.example.com/account/link-apple#int_1.{secret}"),
            format!("https://docs.example.com/account/link-google?x=1#int_1.{secret}"),
            format!("https://docs.example.com/account/link-google#int_2.{secret}"),
            "https://docs.example.com/account/link-google#int_1.short".to_string(),
            format!("https://u:p@docs.example.com/account/link-google#int_1.{secret}"),
        ] {
            assert!(check_link_url(&bad, "https://docs.example.com", LinkProvider::Google, "int_1").is_none(), "{bad}");
        }
    }

    #[test]
    fn unsupported_reads_muted() {
        assert!(IdentitiesError::Unsupported.message().starts_with("This server does not support linked sign-ins"));
        assert_eq!(failure_message(401, ""), "Sign in again to confirm this account.");
    }
}
