//! Versioned byte snapshots, separate from /api/docs text synchronization.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use markie_core::formats::{FormatKind, classify};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use crate::client::{Call, CloudClient};
use crate::docs::Role;
use crate::error::{CloudError, Result};
use crate::http::{Method, TRANSFER_TIMEOUT};

pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE: usize = 24 * 1024 * 1024;
const MAX_VERSION: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub format: FormatKind,
    pub version: u64,
    pub sha256: String,
    pub role: Role,
    pub area_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub meta: SnapshotMeta,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub email: Option<String>,
    pub role: Role,
    #[serde(default)]
    pub waiting: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadLink {
    pub id: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Area {
    pub id: String,
    pub label: String,
}

pub fn supported_name(name: &str) -> Option<FormatKind> {
    let format = classify(name);
    (!name.trim().is_empty()
        && name.encode_utf16().count() <= 256
        && !name
            .chars()
            .any(|c| c.is_ascii_control() || matches!(c, '/' | '\\'))
        && !matches!(format, FormatKind::Unsupported | FormatKind::Html))
    .then_some(format)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn doc_path(id: &str) -> Result<String> {
    valid_id(id)
        .then(|| format!("/documents/{id}"))
        .ok_or(CloudError::Refused)
}

fn validate_meta(meta: &SnapshotMeta) -> Result<()> {
    if meta.schema_version != 2
        || !valid_id(&meta.id)
        || supported_name(&meta.name) != Some(meta.format)
        || !(1..=MAX_VERSION).contains(&meta.version)
        || meta.created_at > MAX_VERSION
        || meta.updated_at > MAX_VERSION
        || meta.byte_length > MAX_FILE_BYTES
        || meta.area_id.as_ref().is_some_and(|id| !valid_id(id))
        || meta.sha256.len() != 64
        || !meta
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(CloudError::Unreadable);
    }
    Ok(())
}

fn field<T: serde::de::DeserializeOwned>(mut value: Value, key: &str) -> Result<T> {
    let item = value.get_mut(key).ok_or(CloudError::Unreadable)?.take();
    serde_json::from_value(item).map_err(|_| CloudError::Unreadable)
}

fn decode(value: Value) -> Result<Snapshot> {
    #[derive(Deserialize)]
    struct Wire {
        #[serde(flatten)]
        meta: SnapshotMeta,
        encoding: String,
        data: String,
    }
    let wire: Wire = field(value, "document")?;
    validate_meta(&wire.meta)?;
    if wire.encoding != "base64" || wire.data.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
        return Err(CloudError::Unreadable);
    }
    let bytes = STANDARD
        .decode(wire.data)
        .map_err(|_| CloudError::Unreadable)?;
    if bytes.len() != wire.meta.byte_length
        || hex::encode(Sha256::digest(&bytes)) != wire.meta.sha256
    {
        return Err(CloudError::Unreadable);
    }
    Ok(Snapshot {
        meta: wire.meta,
        bytes,
    })
}

pub struct PlatformClient<'a>(pub &'a CloudClient);

impl PlatformClient<'_> {
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let path = format!("/api/document-platform{path}");
        let mut call = Call::new(method, &path).max_bytes(MAX_RESPONSE);
        call.timeout = TRANSFER_TIMEOUT;
        if let Some(body) = body {
            call = call.json(body);
        }
        self.0.call(call).await?.json()
    }

    pub async fn list(&self) -> Result<Vec<SnapshotMeta>> {
        let rows: Vec<SnapshotMeta> = field(
            self.call(Method::Get, "/documents", None).await?,
            "documents",
        )?;
        if rows.len() > 1000 {
            return Err(CloudError::Unreadable);
        }
        let mut ids = HashSet::new();
        for row in &rows {
            validate_meta(row)?;
            if !ids.insert(&row.id) {
                return Err(CloudError::Unreadable);
            }
        }
        Ok(rows)
    }

    pub async fn upload(
        &self,
        name: &str,
        bytes: &[u8],
        target: Option<(&str, u64)>,
        area: Option<&str>,
    ) -> Result<Snapshot> {
        let format = supported_name(name).ok_or(CloudError::Unreadable)?;
        if bytes.len() > MAX_FILE_BYTES || area.is_some_and(|id| !valid_id(id) || target.is_some())
        {
            return Err(CloudError::Unreadable);
        }
        let (method, path, version) = match target {
            Some((id, v)) if (1..MAX_VERSION).contains(&v) => (Method::Put, doc_path(id)?, v),
            Some(_) => return Err(CloudError::Unreadable),
            None => (Method::Post, "/documents".into(), 0),
        };
        let mut body = json!({
            "schemaVersion": 2, "name": name, "format": format, "encoding": "base64",
            "data": STANDARD.encode(bytes), "sha256": hex::encode(Sha256::digest(bytes)),
            "baseVersion": version
        });
        if let Some(area) = area {
            body["areaId"] = json!(area);
        }
        let saved = decode(self.call(method, &path, Some(body)).await?)?;
        if saved.meta.name != name
            || saved.meta.format != format
            || saved.bytes != bytes
            || saved.meta.version != version + 1
            || area.is_some_and(|id| saved.meta.area_id.as_deref() != Some(id))
            || match target {
                Some((id, _)) => id != saved.meta.id || saved.meta.role == Role::Viewer,
                None => saved.meta.role != Role::Owner,
            }
        {
            return Err(CloudError::Unreadable);
        }
        Ok(saved)
    }

    pub async fn snapshot(&self, id: &str, version: Option<u64>) -> Result<Snapshot> {
        let mut path = doc_path(id)?;
        if let Some(v) = version {
            if !(1..=MAX_VERSION).contains(&v) {
                return Err(CloudError::Refused);
            }
            path.push_str(&format!("/history/{v}"));
        }
        let doc = decode(self.call(Method::Get, &path, None).await?)?;
        if doc.meta.id != id || version.is_some_and(|v| doc.meta.version != v) {
            return Err(CloudError::Unreadable);
        }
        Ok(doc)
    }

    pub async fn history(&self, id: &str) -> Result<Value> {
        self.call(Method::Get, &format!("{}/history", doc_path(id)?), None)
            .await
    }

    pub async fn members(&self, id: &str) -> Result<Vec<Member>> {
        field(
            self.call(Method::Get, &format!("{}/members", doc_path(id)?), None)
                .await?,
            "members",
        )
    }

    pub async fn add_member(&self, id: &str, email: &str, role: Role) -> Result<()> {
        if role == Role::Owner {
            return Err(CloudError::Refused);
        }
        self.call(
            Method::Post,
            &format!("{}/members", doc_path(id)?),
            Some(json!({"email": email, "role": role})),
        )
        .await?;
        Ok(())
    }

    pub async fn revoke_member(&self, id: &str, user: &str) -> Result<()> {
        if !valid_id(user) {
            return Err(CloudError::Refused);
        }
        self.call(
            Method::Delete,
            &format!("{}/members/{user}", doc_path(id)?),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn links(&self, id: &str) -> Result<Value> {
        self.call(Method::Get, &format!("{}/links", doc_path(id)?), None)
            .await
    }

    pub async fn create_link(&self, id: &str) -> Result<DownloadLink> {
        let link: DownloadLink = field(
            self.call(
                Method::Post,
                &format!("{}/links", doc_path(id)?),
                Some(json!({"expiresInSeconds": 86400})),
            )
            .await?,
            "link",
        )?;
        if !valid_id(&link.id) || !valid_id(&link.token) {
            return Err(CloudError::Unreadable);
        }
        Ok(link)
    }

    pub async fn revoke_link(&self, id: &str, link: &str) -> Result<()> {
        if !valid_id(link) {
            return Err(CloudError::Refused);
        }
        self.call(
            Method::Delete,
            &format!("{}/links/{link}", doc_path(id)?),
            None,
        )
        .await?;
        Ok(())
    }

    pub fn download_url(&self, link: &DownloadLink) -> Result<String> {
        if !valid_id(&link.token) {
            return Err(CloudError::Refused);
        }
        Ok(format!(
            "{}/api/document-platform/links/{}/download",
            self.0.origin(),
            link.token
        ))
    }

    pub async fn areas(&self) -> Result<Vec<Area>> {
        let areas: Vec<Area> = field(
            self.0.get("/api/account/cloud-areas").await?.json()?,
            "areas",
        )?;
        if areas.len() > 100
            || areas
                .iter()
                .any(|s| !valid_id(&s.id) || s.label.encode_utf16().count() > 100)
        {
            return Err(CloudError::Unreadable);
        }
        Ok(areas)
    }

    pub async fn place(&self, id: &str, area: &str) -> Result<()> {
        if !valid_id(id) || !valid_id(area) {
            return Err(CloudError::Refused);
        }
        self.0
            .put(
                &format!("/api/account/cloud-areas/placements/snapshot/{id}"),
                json!({"areaId": area}),
            )
            .await?
            .into_ok()?;
        Ok(())
    }
}
