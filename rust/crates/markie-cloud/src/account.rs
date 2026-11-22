//! The signed-in account's linked sign-ins, read only. A port of the listing
//! half of src/lib/account-identities.ts (`identities()` and its checks).
//! Linking and unlinking stay in the Electron app for now.
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

/// `failure(status, code)` from account-identities.ts, for a listing.
fn failure_message(status: u16, code: &str) -> String {
    let lower = code.to_ascii_lowercase();
    let msg = if status == 401 {
        "Sign in again to confirm this account."
    } else if status == 429 {
        "Too many attempts. Wait before requesting another code."
    } else if status == 403 {
        "This account is not allowed to make that change."
    } else if lower.contains("primary") {
        "The primary sign-in cannot be removed."
    } else {
        "The account change could not be completed. Nothing was merged."
    };
    msg.to_string()
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
    fn unsupported_reads_muted() {
        assert!(IdentitiesError::Unsupported.message().starts_with("This server does not support linked sign-ins"));
        assert_eq!(failure_message(401, ""), "Sign in again to confirm this account.");
    }
}
