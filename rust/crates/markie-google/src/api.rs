//! The few Google calls import needs, all read-only.
//!
//! - Docs `documents.get` with `includeTabsContent=true`, so every tab comes back.
//! - Drive `files.get` for the name, type, `version` and `modifiedTime`.
//! - Drive `files.list` for the Docs in a picked folder (whether `drive.file`
//!   covers them is unverified; the spike tool checks).
//! - Drive `files.export` for Save as Word.
//! - Drive `about.get` for the account's email, shown in Settings.
//! - Drive `changes.getStartPageToken` and `changes.list`, polled by two-way sync.
//! - Docs `documents.batchUpdate`, the only write two-way sync makes to a Doc.
//!   Never `files.update` with content.
//! - For the spike tool's opt-in write test only: `documents.create` and a
//!   metadata-only trash of the one Doc it made.
use crate::config::ClientConfig;
use crate::error::{GoogleError, Result};
use crate::tokens::Grant;
use markie_vault::device::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub mime_type: String,
    /// Drive's monotonically increasing version, as a decimal string.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub trashed: bool,
    #[serde(default)]
    pub owned_by_me: Option<bool>,
    #[serde(default)]
    pub capabilities: Option<Capabilities>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    #[serde(default)]
    pub can_edit: Option<bool>,
    #[serde(default)]
    pub can_comment: Option<bool>,
}

impl DriveFile {
    /// What this account may do. Missing fields mean an owner with full rights,
    /// which is what a Doc the person picked from their own Drive is.
    pub fn access(&self) -> crate::store::Access {
        let caps = self.capabilities.unwrap_or_default();
        let can_edit = caps.can_edit.unwrap_or(true);
        crate::store::Access { owned: self.owned_by_me.unwrap_or(true), can_edit, can_comment: caps.can_comment.unwrap_or(can_edit) }
    }
    pub fn is_doc(&self) -> bool {
        self.mime_type == crate::DOC_MIME
    }
    pub fn is_folder(&self) -> bool {
        self.mime_type == crate::FOLDER_MIME
    }
}

const FILE_FIELDS: &str = "id,name,mimeType,version,modifiedTime,trashed,ownedByMe,capabilities(canEdit,canComment)";

/// What import reads from Google. `GoogleApi` over HTTP; tests may use a double.
pub trait DocsSource: Send + Sync {
    fn file(&self, id: &str) -> Result<DriveFile>;
    /// `documents.get` with every tab, suggestions inline: the only view
    /// whose indices a write may use.
    fn document(&self, id: &str) -> Result<Value>;
    fn export(&self, id: &str, mime: &str) -> Result<Vec<u8>>;
    /// The Google Docs directly inside a folder that Markie can see.
    fn folder_docs(&self, folder_id: &str) -> Result<Vec<DriveFile>>;
}

/// What two-way sync adds: writing, and watching for changes.
pub trait SyncSource: DocsSource {
    /// Docs `documents.batchUpdate`: `requests` in order, as one write,
    /// merged with collaborator changes since `target_revision`. With
    /// `suggest`, every change is a suggestion. The body is
    /// `{"requests": [...], "writeControl": {"targetRevisionId": "...", "writeMode": "SUGGEST"}}`,
    /// as <https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate>
    /// documents `WriteControl` (`writeMode` `SUGGEST`: "Apply all updates as
    /// suggestions"), and the suggestions guide,
    /// <https://developers.google.com/workspace/docs/api/how-tos/suggestions>,
    /// shows. `targetRevisionId` and `requiredRevisionId` exclude each other.
    fn batch_update(&self, id: &str, requests: &[Value], target_revision: &str, suggest: bool) -> Result<Value>;
    /// Drive `changes.getStartPageToken`.
    fn start_page_token(&self) -> Result<String>;
    /// Drive `changes.list` from `token`, every page: the changed file IDs and the next token.
    fn changed_since(&self, token: &str) -> Result<(Vec<String>, String)>;
}

/// The `batchUpdate` body Markie sends.
pub fn batch_body(requests: &[Value], target_revision: &str, suggest: bool) -> Value {
    let mut write_control = serde_json::json!({"targetRevisionId": target_revision});
    if suggest {
        write_control["writeMode"] = serde_json::json!("SUGGEST");
    }
    serde_json::json!({"requests": requests, "writeControl": write_control})
}

pub struct GoogleApi<'a, S: SecretStore> {
    pub http: reqwest::blocking::Client,
    pub cfg: &'a ClientConfig,
    pub grant: &'a Grant<S>,
}

impl<'a, S: SecretStore> GoogleApi<'a, S> {
    pub fn new(cfg: &'a ClientConfig, grant: &'a Grant<S>) -> Self {
        Self { http: crate::oauth::http_client(), cfg, grant }
    }

    /// One GET with a bearer token. A 401 refreshes the token once and retries.
    fn get(&self, url: &str, query: &[(&str, &str)]) -> Result<reqwest::blocking::Response> {
        self.send(reqwest::Method::GET, url, query, None)
    }

    /// One call with a bearer token and an optional JSON body.
    fn send(&self, method: reqwest::Method, url: &str, query: &[(&str, &str)], body: Option<&Value>) -> Result<reqwest::blocking::Response> {
        let mut url = url::Url::parse(url).map_err(|e| GoogleError::Parse(e.to_string()))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        for attempt in 0..2 {
            let token = self.grant.access_token(&self.http, self.cfg)?;
            let mut req = self.http.request(method.clone(), url.clone()).bearer_auth(token.as_str());
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send()?;
            let status = resp.status().as_u16();
            if status == 401 && attempt == 0 {
                self.grant.expire();
                continue;
            }
            if resp.status().is_success() {
                return Ok(resp);
            }
            let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
            let message = resp.text().ok().and_then(|b| error_message(&b)).unwrap_or_default();
            return Err(match status {
                401 => GoogleError::Reconnect,
                429 => GoogleError::RateLimited { retry_after_secs: retry_after },
                // Drive reports its rate limits as 403 with these reasons.
                403 if message.contains("Rate Limit") || message.contains("rateLimitExceeded") || message.contains("userRateLimitExceeded") => GoogleError::RateLimited { retry_after_secs: retry_after },
                403 | 404 => GoogleError::NoAccess(message),
                _ => GoogleError::Http { status, message },
            });
        }
        Err(GoogleError::Reconnect)
    }

    fn json(&self, url: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.get(url, query)?.json().map_err(|e| GoogleError::Parse(e.to_string()))
    }

    /// The signed-in account's email, if Google tells a `drive.file` grant.
    pub fn account_email(&self) -> Result<Option<String>> {
        let v = self.json(&format!("{}/drive/v3/about", self.cfg.endpoints.drive), &[("fields", "user(displayName,emailAddress)")])?;
        Ok(v.pointer("/user/emailAddress").and_then(Value::as_str).map(str::to_string))
    }

    /// Docs `documents.create`: a new, empty Doc this app made (so
    /// `drive.file` covers it). Only the spike tool's write test calls it.
    pub fn create_document(&self, title: &str) -> Result<Value> {
        let resp = self.send(reqwest::Method::POST, &format!("{}/v1/documents", self.cfg.endpoints.docs), &[], Some(&serde_json::json!({"title": title})))?;
        resp.json().map_err(|e| GoogleError::Parse(e.to_string()))
    }

    /// Drive `files.update` with `{"trashed": true}`: metadata only, never
    /// content. Only the spike tool's write test calls it, on the Doc it made.
    pub fn trash_own_test_doc(&self, id: &str) -> Result<()> {
        check_id(id)?;
        self.send(reqwest::Method::PATCH, &format!("{}/drive/v3/files/{id}", self.cfg.endpoints.drive), &[], Some(&serde_json::json!({"trashed": true})))?;
        Ok(())
    }

    /// One page of changes since `token`: the file IDs Drive reports.
    pub fn changes(&self, token: &str) -> Result<Value> {
        self.json(
            &format!("{}/drive/v3/changes", self.cfg.endpoints.drive),
            &[("pageToken", token), ("fields", "newStartPageToken,nextPageToken,changes(fileId,removed,file(name,mimeType))"), ("pageSize", "100")],
        )
    }
}

fn error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.pointer("/error/message").and_then(Value::as_str).map(str::to_string)
}

impl<S: SecretStore> DocsSource for GoogleApi<'_, S> {
    fn file(&self, id: &str) -> Result<DriveFile> {
        check_id(id)?;
        let v = self.json(&format!("{}/drive/v3/files/{id}", self.cfg.endpoints.drive), &[("fields", FILE_FIELDS), ("supportsAllDrives", "true")])?;
        serde_json::from_value(v).map_err(|e| GoogleError::Parse(e.to_string()))
    }

    fn document(&self, id: &str) -> Result<Value> {
        check_id(id)?;
        self.json(&format!("{}/v1/documents/{id}", self.cfg.endpoints.docs), &[("includeTabsContent", "true"), ("suggestionsViewMode", "SUGGESTIONS_INLINE")])
    }

    fn export(&self, id: &str, mime: &str) -> Result<Vec<u8>> {
        check_id(id)?;
        let resp = self.get(&format!("{}/drive/v3/files/{id}/export", self.cfg.endpoints.drive), &[("mimeType", mime)])?;
        Ok(resp.bytes()?.to_vec())
    }

    fn folder_docs(&self, folder_id: &str) -> Result<Vec<DriveFile>> {
        check_id(folder_id)?;
        let q = format!("'{folder_id}' in parents and mimeType = '{}' and trashed = false", crate::DOC_MIME);
        let fields = format!("nextPageToken,files({FILE_FIELDS})");
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        for _ in 0..20 {
            let mut query = vec![("q", q.as_str()), ("fields", fields.as_str()), ("pageSize", "200"), ("supportsAllDrives", "true"), ("includeItemsFromAllDrives", "true")];
            if let Some(p) = page.as_deref() {
                query.push(("pageToken", p));
            }
            let v = self.json(&format!("{}/drive/v3/files", self.cfg.endpoints.drive), &query)?;
            if let Some(files) = v.get("files").and_then(Value::as_array) {
                out.extend(files.iter().filter_map(|f| serde_json::from_value::<DriveFile>(f.clone()).ok()));
            }
            page = v.get("nextPageToken").and_then(Value::as_str).map(str::to_string);
            if page.is_none() {
                break;
            }
        }
        Ok(out)
    }
}

impl<S: SecretStore> SyncSource for GoogleApi<'_, S> {
    fn batch_update(&self, id: &str, requests: &[Value], target_revision: &str, suggest: bool) -> Result<Value> {
        check_id(id)?;
        let body = batch_body(requests, target_revision, suggest);
        let resp = self.send(reqwest::Method::POST, &format!("{}/v1/documents/{id}:batchUpdate", self.cfg.endpoints.docs), &[], Some(&body))?;
        resp.json().map_err(|e| GoogleError::Parse(e.to_string()))
    }

    fn start_page_token(&self) -> Result<String> {
        let v = self.json(&format!("{}/drive/v3/changes/startPageToken", self.cfg.endpoints.drive), &[])?;
        v.get("startPageToken").and_then(Value::as_str).map(str::to_string).ok_or_else(|| GoogleError::Parse("startPageToken".into()))
    }

    fn changed_since(&self, token: &str) -> Result<(Vec<String>, String)> {
        let mut ids = Vec::new();
        let mut token = token.to_string();
        for _ in 0..50 {
            let v = self.changes(&token)?;
            if let Some(list) = v.get("changes").and_then(Value::as_array) {
                ids.extend(list.iter().filter_map(|c| c.get("fileId").and_then(Value::as_str).map(str::to_string)));
            }
            if let Some(next) = v.get("nextPageToken").and_then(Value::as_str) {
                token = next.to_string();
                continue;
            }
            let fresh = v.get("newStartPageToken").and_then(Value::as_str).ok_or_else(|| GoogleError::Parse("newStartPageToken".into()))?;
            return Ok((ids, fresh.to_string()));
        }
        Err(GoogleError::Parse("changes.list did not end".into()))
    }
}

fn check_id(id: &str) -> Result<()> {
    if crate::oauth::valid_file_id(id) { Ok(()) } else { Err(GoogleError::NoAccess(String::new())) }
}
