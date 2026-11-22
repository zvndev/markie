//! Remote agent tokens use the account session, never the socket credential.
use markie_cloud::client::seg;
use markie_cloud::http::Answer;
use markie_cloud::{CloudClient, CloudError};
use serde::Deserialize;
use serde_json::{Value, json};

const ROUTE: &str = "/api/agent-tokens";
pub const NAME_MAX: usize = 64;
pub const TOKEN_PLACEHOLDER: &str = "YOUR_TOKEN";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub prefix: String,
    pub created_at: Option<Value>,
    pub last_used_at: Option<Value>,
}

// Intentionally neither Debug nor Serialize; only the dialog receives it.
#[derive(Deserialize)]
pub struct Created {
    pub id: String,
    pub token: String,
    #[serde(default)]
    pub name: String,
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

fn transport(error: CloudError) -> String {
    match error {
        CloudError::Offline => {
            "Markie Cloud could not be reached. Check your connection and try again.".into()
        }
        other => other.to_string(),
    }
}

fn read(answer: Answer) -> Result<Value, String> {
    match answer.status {
        200..=299 => Ok(answer.data.unwrap_or_default()),
        401 => Err(
            "Your Markie Cloud sign-in has expired. Sign in again to manage agent tokens.".into(),
        ),
        404 | 405 | 501 => Err("This server does not offer agent tokens.".into()),
        429 => Err("Too many requests. Wait a moment and try again.".into()),
        status => Err(format!("Markie Cloud refused ({status}).")),
    }
}

pub async fn list(client: &CloudClient) -> Result<Vec<Token>, String> {
    let data = read(client.get(ROUTE).await.map_err(transport)?)?;
    let rows = data["tokens"]
        .as_array()
        .ok_or("Markie Cloud sent an answer Markie could not read.")?;
    Ok(rows
        .iter()
        .filter_map(|row| serde_json::from_value::<Token>(row.clone()).ok())
        .filter(|row| !row.id.is_empty() && !row.name.is_empty())
        .collect())
}

pub async fn create(client: &CloudClient, name: &str) -> Result<Created, String> {
    let name = name.trim();
    if name.is_empty() || name.encode_utf16().count() > NAME_MAX {
        return Err("Give the token a name of up to 64 characters.".into());
    }
    let data = read(
        client
            .post(ROUTE, json!({"name":name}))
            .await
            .map_err(transport)?,
    )?;
    let mut created: Created = serde_json::from_value(data)
        .map_err(|_| "Markie Cloud sent an answer Markie could not read.")?;
    if created.token.is_empty() || created.id.is_empty() {
        return Err("Markie Cloud sent an answer Markie could not read.".into());
    }
    if created.name.is_empty() {
        created.name = name.into();
    }
    Ok(created)
}

pub async fn revoke(client: &CloudClient, id: &str) -> Result<(), String> {
    let answer = client
        .delete(&format!("{ROUTE}/{}", seg(id)))
        .await
        .map_err(transport)?;
    if answer.status == 404 {
        Ok(())
    } else {
        read(answer).map(|_| ())
    }
}
