//! The few Google calls import needs, all read-only.
//!
//! - Docs `documents.get` with `includeTabsContent=true`, so every tab comes back.
//! - Drive `files.get` for the name, type, `version` and `modifiedTime`.
//! - Drive `files.list` for the Docs in a picked folder (whether `drive.file`
//!   covers them is unverified; the spike tool checks).
//! - Drive `files.export` for Save as Word.
//! - Drive `about.get` for the account's email, shown in Settings.
//! - Drive `changes.getStartPageToken` and `changes.list`, for the spike tool only.
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
}

impl DriveFile {
    pub fn is_doc(&self) -> bool {
        self.mime_type == crate::DOC_MIME
    }
    pub fn is_folder(&self) -> bool {
        self.mime_type == crate::FOLDER_MIME
    }
}

const FILE_FIELDS: &str = "id,name,mimeType,version,modifiedTime,trashed";

/// What import reads from Google. `GoogleApi` over HTTP; tests may use a double.
pub trait DocsSource: Send + Sync {
    fn file(&self, id: &str) -> Result<DriveFile>;
    fn document(&self, id: &str) -> Result<Value>;
    fn export(&self, id: &str, mime: &str) -> Result<Vec<u8>>;
    /// The Google Docs directly inside a folder that Markie can see.
    fn folder_docs(&self, folder_id: &str) -> Result<Vec<DriveFile>>;
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
        let mut url = url::Url::parse(url).map_err(|e| GoogleError::Parse(e.to_string()))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        for attempt in 0..2 {
            let token = self.grant.access_token(&self.http, self.cfg)?;
            let resp = self.http.get(url.clone()).bearer_auth(token.as_str()).send()?;
            let status = resp.status().as_u16();
            if status == 401 && attempt == 0 {
                self.grant.expire();
                continue;
            }
            if resp.status().is_success() {
                return Ok(resp);
            }
            let message = resp.text().ok().and_then(|b| error_message(&b)).unwrap_or_default();
            return Err(match status {
                401 => GoogleError::Reconnect,
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

    pub fn start_page_token(&self) -> Result<String> {
        let v = self.json(&format!("{}/drive/v3/changes/startPageToken", self.cfg.endpoints.drive), &[])?;
        v.get("startPageToken").and_then(Value::as_str).map(str::to_string).ok_or_else(|| GoogleError::Parse("startPageToken".into()))
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
        self.json(&format!("{}/v1/documents/{id}", self.cfg.endpoints.docs), &[("includeTabsContent", "true")])
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

fn check_id(id: &str) -> Result<()> {
    if crate::oauth::valid_file_id(id) { Ok(()) } else { Err(GoogleError::NoAccess(String::new())) }
}
