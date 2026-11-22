//! Remote agent tokens use the account session, never the socket credential.
use markie_cloud::client::seg;
use markie_cloud::http::Answer;
use markie_cloud::{CloudClient, CloudError};
use serde_json::{Value, json};

const ROUTE: &str = "/api/agent-tokens";
pub const NAME_MAX: usize = 64;
/// remote-agents-panel.tsx: stands in for the token until one is made.
pub const TOKEN_PLACEHOLDER: &str = "<token>";

#[derive(Clone)]
pub struct Token {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub created_at: Option<Value>,
    pub last_used_at: Option<Value>,
}

// Intentionally neither Debug nor Serialize; only the dialog receives it.
pub struct Created {
    pub id: String,
    pub token: String,
    pub name: String,
    pub prefix: String,
    pub created_at: Option<Value>,
}

/// A refusal in agent-tokens.ts's words, with the status it came with (none
/// when the server was not reached).
#[derive(Debug, Clone, PartialEq)]
pub struct TokenError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

const UNREADABLE: &str = "Markie Cloud sent an answer Markie could not read.";

/// `offersNoAgentTokens`: the list or create route itself is missing.
pub fn offers_no_agent_tokens(status: u16) -> bool {
    matches!(status, 404 | 405 | 501)
}

fn str_field(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// agent-tokens.ts `when`: a string or a number, else nothing.
fn when(v: &Value) -> Option<Value> {
    (v.is_string() || v.is_number()).then(|| v.clone())
}

pub fn url(origin: &str) -> String {
    format!("{}/mcp", origin.trim_end_matches('/'))
}

pub fn claude(url: &str, token: &str) -> String {
    format!(
        "claude mcp add --transport http markie-cloud {url} --header \"Authorization: Bearer {token}\""
    )
}

pub fn config(url: &str, token: &str) -> String {
    serde_json::to_string_pretty(&json!({"mcpServers":{"markie-cloud":{
        "type":"http","url":url,"headers":{"Authorization":format!("Bearer {token}")}
    }}}))
    .expect("JSON value")
}

fn transport(error: CloudError) -> TokenError {
    TokenError {
        status: None,
        message: match error {
            CloudError::Offline => "Markie Cloud could not be reached. Check your connection and try again.".into(),
            other => other.to_string(),
        },
    }
}

/// agent-tokens.ts `refusal`.
fn read(answer: Answer) -> Result<Value, TokenError> {
    let status = answer.status;
    if (200..=299).contains(&status) {
        return Ok(answer.data.unwrap_or_default());
    }
    let body = answer.data.unwrap_or_default();
    let message = match status {
        401 => "Your Markie Cloud sign-in has expired. Sign in again to manage agent tokens.".into(),
        s if offers_no_agent_tokens(s) => "This server does not offer agent tokens.".into(),
        429 => "Too many requests. Wait a moment and try again.".into(),
        // The server's own words for a rule the user can act on, never a
        // body that might echo a secret.
        400 | 409 | 422 => {
            let said = body["message"].as_str().or_else(|| body["error"].as_str()).unwrap_or_default();
            if !said.is_empty() && said.encode_utf16().count() <= 160 && !said.contains("mk_agent_") {
                said.to_owned()
            } else {
                format!("Markie Cloud refused ({status}).")
            }
        }
        _ => format!("Markie Cloud refused ({status})."),
    };
    Err(TokenError { status: Some(status), message })
}

fn unreadable(status: u16) -> TokenError {
    TokenError { status: Some(status), message: UNREADABLE.into() }
}

pub async fn list(client: &CloudClient) -> Result<Vec<Token>, TokenError> {
    let data = read(client.get(ROUTE).await.map_err(transport)?)?;
    let rows = data["tokens"].as_array().ok_or_else(|| unreadable(200))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(Token {
                id: str_field(row, "id")?,
                name: str_field(row, "name")?,
                prefix: row["prefix"].as_str().unwrap_or_default().to_owned(),
                created_at: when(&row["createdAt"]),
                last_used_at: when(&row["lastUsedAt"]),
            })
        })
        .collect())
}

pub async fn create(client: &CloudClient, name: &str) -> Result<Created, TokenError> {
    let name = name.trim();
    if name.is_empty() || name.encode_utf16().count() > NAME_MAX {
        return Err(TokenError { status: None, message: "Give the token a name of up to 64 characters.".into() });
    }
    let data = read(client.post(ROUTE, json!({"name":name})).await.map_err(transport)?)?;
    Ok(Created {
        id: str_field(&data, "id").ok_or_else(|| unreadable(200))?,
        token: str_field(&data, "token").ok_or_else(|| unreadable(200))?,
        name: data["name"].as_str().map_or_else(|| name.to_owned(), str::to_owned),
        prefix: data["prefix"].as_str().unwrap_or_default().to_owned(),
        created_at: when(&data["createdAt"]),
    })
}

/// A 404 on DELETE means the token is already gone, never "no such route".
pub async fn revoke(client: &CloudClient, id: &str) -> Result<(), String> {
    let answer = client.delete(&format!("{ROUTE}/{}", seg(id))).await.map_err(|e| transport(e).message)?;
    if answer.status == 404 {
        Ok(())
    } else {
        read(answer).map(|_| ()).map_err(|e| e.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(status: u16, data: Value) -> Answer {
        Answer { status, data: Some(data), bytes: Vec::new(), set_auth_token: None, etag: None, content_type: None }
    }

    #[test]
    fn refusals_say_what_agent_tokens_ts_says() {
        let said = |status, body| read(answer(status, body)).unwrap_err().message;
        assert_eq!(said(409, json!({"error": "You already have 20 active tokens."})), "You already have 20 active tokens.");
        assert_eq!(said(400, json!({"message": "Name too long", "error": "x"})), "Name too long");
        assert_eq!(said(422, json!({"error": "has mk_agent_abc in it"})), "Markie Cloud refused (422).");
        assert_eq!(said(400, json!({"error": "y".repeat(161)})), "Markie Cloud refused (400).");
        assert_eq!(said(500, json!({"error": "internal"})), "Markie Cloud refused (500).");
        assert_eq!(said(405, json!({})), "This server does not offer agent tokens.");
        assert_eq!(read(answer(404, json!({}))).unwrap_err().status, Some(404));
        assert_eq!(TOKEN_PLACEHOLDER, "<token>");
    }
}
