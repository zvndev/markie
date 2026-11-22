//! The document REST calls the sync engine and the Cloud page use.
use crate::client::{Call, CloudClient, seg};
use crate::error::{CloudError, Result};
use crate::http::{Answer, Body, MAX_DOC_RESPONSE_BYTES, Method, TRANSFER_TIMEOUT};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Editor,
    Viewer,
}

/// One entry of `GET /api/docs`: metadata only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocMeta {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Present on documents shared with this account.
    #[serde(default)]
    pub shared: bool,
    #[serde(default)]
    pub role: Option<Role>,
    #[serde(default, alias = "sharedBy")]
    pub shared_by: Option<String>,
    /// On owned documents: whether anybody else can read it.
    #[serde(default, rename = "sharedOut")]
    pub shared_out: Option<bool>,
    #[serde(default, rename = "areaId")]
    pub area_id: Option<String>,
}

/// `GET /api/docs/:id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: i64,
    pub content: String,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub role: Option<Role>,
}

/// `PUT /api/docs/:id`. `base_version` is 0 to create.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PutDoc {
    pub name: String,
    pub content: String,
    pub hash: String,
    #[serde(rename = "baseVersion")]
    pub base_version: i64,
    #[serde(rename = "areaId", skip_serializing_if = "Option::is_none")]
    pub area_id: Option<String>,
    /// Who made a new document: `{kind: "agent", agent}` from an agent only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Value>,
}

/// What a snapshot PUT came to. Transport failures are `Failed { status: 0 }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutOutcome {
    /// Stored. `version` is None when the 200 body was unreadable.
    Saved { version: Option<i64> },
    /// The server holds another version (409).
    Conflict { server_version: Option<i64> },
    /// Anything else, with its status (0 for no answer).
    Failed { status: u16 },
    /// The session changed while the request was in flight.
    Stale,
}

pub struct DocsClient<'a> {
    client: &'a CloudClient,
}

impl<'a> DocsClient<'a> {
    pub fn new(client: &'a CloudClient) -> Self {
        Self { client }
    }

    pub async fn list(&self) -> Result<Vec<DocMeta>> {
        let v = self.client.get("/api/docs").await?.json()?;
        serde_json::from_value(v.get("docs").cloned().ok_or(CloudError::Unreadable)?).map_err(|_| CloudError::Unreadable)
    }

    /// The document with its text. A 2xx whose body has no string `content` is Unreadable.
    pub async fn get(&self, id: &str) -> Result<Doc> {
        let path = format!("/api/docs/{}", seg(id));
        let v = self.client.call(Call::new(Method::Get, &path).max_bytes(MAX_DOC_RESPONSE_BYTES)).await?.json()?;
        let doc = v.get("doc").cloned().ok_or(CloudError::Unreadable)?;
        let doc: Doc = serde_json::from_value(doc).map_err(|_| CloudError::Unreadable)?;
        if doc.id != id || doc.version < 1 { return Err(CloudError::Unreadable); }
        Ok(doc)
    }

    pub async fn put(&self, id: &str, body: &PutDoc) -> PutOutcome {
        let path = format!("/api/docs/{}", seg(id));
        let mut call = Call::new(Method::Put, &path).json(serde_json::to_value(body).unwrap());
        call.timeout = TRANSFER_TIMEOUT;
        match self.client.call(call).await {
            Err(CloudError::StaleSession) => PutOutcome::Stale,
            Err(_) => PutOutcome::Failed { status: 0 },
            Ok(a) if a.status == 200 => PutOutcome::Saved { version: a.data.as_ref().and_then(|d| d.get("version")).and_then(Value::as_i64) },
            Ok(a) if a.status == 409 => PutOutcome::Conflict { server_version: a.data.as_ref().and_then(|d| d.get("serverVersion")).and_then(Value::as_i64) },
            Ok(a) => PutOutcome::Failed { status: a.status },
        }
    }

    /// Delete the cloud copy. Returns the status (404 means already gone).
    pub async fn delete(&self, id: &str) -> Result<u16> {
        Ok(self.client.delete(&format!("/api/docs/{}", seg(id))).await?.status)
    }

    pub async fn shared_by_me(&self) -> Result<Value> {
        self.client.get("/api/docs/shared-by-me").await?.json()
    }

    pub async fn links(&self, id: &str) -> Result<Value> {
        self.client.get(&format!("/api/docs/{}/links", seg(id))).await?.json()
    }

    pub async fn put_links(&self, id: &str, body: Value) -> Result<Answer> {
        self.client.put(&format!("/api/docs/{}/links", seg(id)), body).await
    }

    /// Upload one asset's bytes under its sha256.
    pub async fn put_asset(&self, sha256: &str, bytes: Vec<u8>, mime: &str) -> Result<Answer> {
        let path = format!("/api/assets/{}", seg(sha256));
        let mut call = Call::new(Method::Put, &path);
        call.body = Body::Raw { bytes, mime: mime.to_string() };
        call.timeout = TRANSFER_TIMEOUT;
        self.client.call(call).await
    }

    /// Which of these hashes the server still needs for a document.
    pub async fn missing_assets(&self, id: &str, hashes: &[String]) -> Result<Value> {
        self.client.post(&format!("/api/docs/{}/assets/missing", seg(id)), json!({ "hashes": hashes })).await?.json()
    }

    pub async fn link_assets(&self, id: &str, body: Value) -> Result<Answer> {
        self.client.put(&format!("/api/docs/{}/assets", seg(id)), body).await
    }

    /// One asset of a document. 304 with `if_none_match` means the cached copy stands.
    pub async fn fetch_asset(&self, id: &str, reference: &str, if_none_match: Option<&str>) -> Result<Answer> {
        let path = format!("/api/docs/{}/assets/file?ref={}", seg(id), seg(reference));
        let mut call = Call::new(Method::Get, &path).max_bytes(crate::assets::MAX_ASSET_BYTES);
        call.timeout = TRANSFER_TIMEOUT;
        call.if_none_match = if_none_match;
        self.client.call(call).await
    }

    /// A cache hit must not bypass the current origin and account checks.
    pub(crate) fn check_asset_scope(&self, account: &str, origin: &str) -> Result<()> {
        if self.client.origin() != origin || !self.client.trusted() {
            return Err(CloudError::NotTrusted);
        }
        let session = self.client.session().ok_or(CloudError::NotSignedIn)?;
        if session.user_id.as_deref() != Some(account) {
            return Err(CloudError::StaleSession);
        }
        Ok(())
    }
}
