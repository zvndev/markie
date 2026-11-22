//! The agent-facing document contract, using the same authenticated client,
//! PUT rules and public-link routes as the desktop Cloud UI.
use crate::{MAX_SYNC_BYTES, Reply, guarded_path, sanitize_agent};
use markie_cloud::client::seg;
use markie_cloud::docs::{DocsClient, PutDoc, Role};
use markie_cloud::origin::doc_link_origin;
use markie_cloud::sharing::SharesClient;
use markie_cloud::sync::{
    PushResult, SyncRecord, SyncState, after_put, hash_content, plan_push, plan_sync_on,
};
use markie_cloud::{CloudClient, CloudError, DEFAULT_SERVER};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const SIGN_IN: &str = "Sign in to Markie Cloud in the Markie app first.";
pub const LIVE_DOC_PRIVATE: &str = "Live Docs can't be public. Share it with people instead.";
pub const LIVE_DOC_PUBLIC_LEFTOVER: &str = "This Live Doc still has a public link, and anyone holding it can open it. Live Docs should be private: tell the user, and turn it off with markie_cloud_revoke_public_link if they agree. Do not share this link.";

#[derive(Clone)]
pub struct Document {
    pub path: PathBuf,
    pub name: String,
}

impl Document {
    pub fn resolve(raw: &str, home: &Path) -> Result<Self, String> {
        let path = guarded_path(raw, home, false)?;
        let name = path
            .file_name()
            .ok_or("Give the absolute path of a file.")?
            .to_string_lossy()
            .into_owned();
        if !matches!(
            extension(&path).as_str(),
            "md" | "markdown" | "mdx" | "txt" | "text" | "wd"
        ) {
            return Err("Agents can sync Markdown, Darkmown and plain text files to Markie Cloud. Open other documents in Markie to share them.".into());
        }
        Ok(Self { path, name })
    }

    pub fn check_size(&self) -> Result<(), String> {
        let size = fs::metadata(&self.path)
            .map_err(|_| format!("No such file: {}", self.path.display()))?
            .len();
        if size > MAX_SYNC_BYTES {
            Err(format!("{} is too large to sync.", self.name))
        } else {
            Ok(())
        }
    }

    fn read(&self) -> Result<String, String> {
        let f = fs::File::open(&self.path).map_err(|_| "Markie could not read this file.")?;
        let mut bytes = Vec::new();
        f.take(MAX_SYNC_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Markie could not read this file.")?;
        if bytes.len() as u64 > MAX_SYNC_BYTES {
            return Err(format!("{} is too large to sync.", self.name));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn describe(&self, record: &SyncRecord) -> Value {
        let link = record
            .cloud_doc_id
            .as_ref()
            .map(|id| format!("{}/d/{}", doc_link_origin(record_origin(record)), seg(id)));
        let remote = link.is_some();
        json!({
            "path": self.path,
            "name": self.name,
            "synced": remote && matches!(record.state, SyncState::Synced | SyncState::Unpushed),
            "syncState": if remote { json!(record.state) } else { json!("local") },
            "server": remote.then(|| record_origin(record)),
            "privateLink": link,
            "markdownLink": link.as_deref().map(|url| markdown_link(&self.name, url)),
            "role": record.share_role,
        })
    }

    pub fn linked<'a>(&self, record: &'a SyncRecord) -> Result<&'a str, String> {
        record
            .cloud_doc_id
            .as_deref()
            .ok_or_else(|| format!("{} is not in Markie Cloud yet. Sync it first.", self.name))
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn record_origin(record: &SyncRecord) -> &str {
    record.cloud_origin.as_deref().unwrap_or(DEFAULT_SERVER)
}

fn markdown_link(name: &str, url: &str) -> String {
    let mut text = String::new();
    let mut in_break = false;
    for ch in name.chars() {
        if matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !in_break {
                text.push(' ');
            }
            in_break = true;
            continue;
        }
        in_break = false;
        if matches!(ch, '\\' | '[' | ']' | '<' | '>' | '`') {
            text.push('\\');
        }
        text.push(ch);
    }
    format!("[{text}]({})", url.replace('(', "%28").replace(')', "%29"))
}

/// Call only after the app has approved the upload. The caller stores any
/// returned state (including conflict / unpushed) in its own registry.
pub async fn sync(
    client: &CloudClient,
    doc: &Document,
    record: &SyncRecord,
    agent: &str,
) -> (SyncRecord, Reply) {
    let operation = async {
        if client.token().is_none() {
            return Err(SIGN_IN.into());
        }
        let viewer = record.share_role == Some(Role::Viewer);
        let plan = if record.cloud_doc_id.is_some() {
            plan_push(record, viewer)
        } else {
            plan_sync_on(record, viewer, || uuid::Uuid::new_v4().to_string())
        };
        let (record, outcome) = match plan {
            Ok(plan) => {
                let content = doc.read()?;
                let hash = hash_content(&content);
                let body = PutDoc {
                    name: doc.name.clone(),
                    content,
                    hash: hash.clone(),
                    base_version: plan.base_version,
                    area_id: None,
                    origin: (!plan.linked)
                        .then(|| json!({"kind":"agent","agent":sanitize_agent(agent)})),
                };
                let answer = DocsClient::new(client).put(&plan.cloud_id, &body).await;
                if matches!(
                    answer,
                    markie_cloud::docs::PutOutcome::Failed { status: 401 }
                ) {
                    return Err(SIGN_IN.into());
                }
                let now = chrono::Utc::now().to_rfc3339();
                let origin = (client.origin() != DEFAULT_SERVER).then(|| client.origin());
                after_put(record, &plan, origin, &hash, &answer, &now)
            }
            Err(refused) => refused,
        };
        let reply = match outcome {
            PushResult::Ok { .. } => Ok(doc.describe(&record)),
            PushResult::Conflict { .. } => Err(format!(
                "{} changed in Markie Cloud and here. Open it in Markie to resolve it.",
                doc.name
            )),
            PushResult::Skipped("not synced") => Err(format!(
                "{} has a sync conflict. Open it in Markie to resolve it.",
                doc.name
            )),
            PushResult::Skipped(why) => Err(format!("Not synced: {why}.")),
            PushResult::Error(error) => Err(error),
        };
        Ok((record, reply))
    };
    operation.await.unwrap_or_else(|e| (record.clone(), Err(e)))
}

pub enum PublicStatus {
    Done(Value),
    Confirm,
}

fn link_result(doc: &Document, record: &SyncRecord, url: Option<String>) -> Value {
    let live_public = url.is_some() && extension(&doc.path) == "wd";
    let mut value = doc.describe(record);
    value["publicLink"] = json!(url);
    if live_public {
        value["warning"] = json!(LIVE_DOC_PUBLIC_LEFTOVER);
    }
    value
}

pub async fn public_status(
    client: &CloudClient,
    doc: &Document,
    record: &SyncRecord,
    create: bool,
) -> Result<PublicStatus, String> {
    let id = doc.linked(record)?;
    let url = SharesClient::new(client)
        .public_link(id)
        .await
        .map_err(share_error)?;
    if url.is_some() || !create {
        return Ok(PublicStatus::Done(link_result(doc, record, url)));
    }
    if extension(&doc.path) == "wd" {
        return Err(LIVE_DOC_PRIVATE.into());
    }
    Ok(PublicStatus::Confirm)
}

/// Call only after native confirmation of this particular public link.
pub async fn create_public(client: &CloudClient, doc: &Document, record: &SyncRecord) -> Reply {
    if extension(&doc.path) == "wd" {
        return Err(LIVE_DOC_PRIVATE.into());
    }
    let url = SharesClient::new(client)
        .create_public_link(doc.linked(record)?)
        .await
        .map_err(share_error)?;
    Ok(link_result(doc, record, Some(url)))
}

pub async fn revoke_public(client: &CloudClient, doc: &Document, record: &SyncRecord) -> Reply {
    SharesClient::new(client)
        .revoke_public_link(doc.linked(record)?)
        .await
        .map_err(share_error)?;
    Ok(link_result(doc, record, None))
}

fn share_error(error: CloudError) -> String {
    match error {
        CloudError::NotSignedIn | CloudError::Status { status: 401, .. } => SIGN_IN.into(),
        CloudError::Status { status: 403, .. } => {
            "Only the owner of this document can see or change its public link.".into()
        }
        CloudError::Status {
            status: 409,
            message: Some(m),
            ..
        } if m == "live-doc-private" => LIVE_DOC_PRIVATE.into(),
        CloudError::Offline => "Markie Cloud could not be reached.".into(),
        CloudError::Status { status, .. } => format!("Markie Cloud refused ({status})."),
        other => other.to_string(),
    }
}
