//! Snapshot sync. A port of electron/sync.js, split in two:
//!
//! - Pure rules on a [`SyncRecord`] (the registry row's cloud fields): what a
//!   push sends, what each answer does to the record, keep-both names,
//!   landing names, listing fingerprints, the Library's view of a row.
//! - [`SyncEngine`], which runs those rules against one server's REST API and
//!   hands back the new record plus any text to write. It never touches the
//!   disk itself; the caller owns files and the registry.
//!
//! The states are the registry's: `local-only | synced | unpushed | conflict |
//! paused`. A push is allowed from `synced` and `unpushed`; anything that did
//! not land leaves the row `unpushed` so it stays retryable and the Library
//! never claims a backup that does not exist.
use crate::docs::{Doc, DocMeta, DocsClient, PutDoc, PutOutcome, Role};
use crate::error::CloudError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SyncState {
    #[default]
    LocalOnly,
    Synced,
    Unpushed,
    Conflict,
    Paused,
}

/// The cloud fields of one registry row.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SyncRecord {
    pub cloud_doc_id: Option<String>,
    /// The server the document lives on. None means the primary server.
    pub cloud_origin: Option<String>,
    pub cloud_version: i64,
    pub content_hash: Option<String>,
    pub state: SyncState,
    pub last_synced_at: Option<String>,
    pub share_role: Option<Role>,
    pub share_role_user: Option<String>,
}

/// The registry's content hash: sha256 hex of the UTF-8 text.
pub fn hash_content(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

/// Markie refuses to open a document at or over 100 MB.
pub const MAX_DOC_BYTES: usize = 100_000_000;

pub const UNREADABLE: &str = "The server sent an unreadable copy of this document.";
pub const STALE_UPLOAD: &str = "Your sign-in or cloud server changed during the upload. Confirm the account and destination before retrying.";
pub const VIEWER_REFUSAL: &str = "You have view-only access to this shared document. Make a copy to keep your changes.";
pub const UNPUSHED_TAKE_CLOUD: &str =
    "This file has changes that never reached the cloud. Taking the cloud copy would delete them. Save again to retry the backup first.";

fn mb(n: usize) -> String {
    format!("{:.1} MB", n as f64 / 1_000_000.0)
}

/// Why a cloud copy cannot be written to disk, or None.
pub fn over_cap(content: &str, name: &str) -> Option<String> {
    let size = content.len();
    (size >= MAX_DOC_BYTES).then(|| format!("{name} in the cloud is {}, more than Markie opens ({}). Nothing was changed.", mb(size), mb(MAX_DOC_BYTES)))
}

fn failure(verb: &str, status: u16) -> String {
    if status == 0 { format!("{verb} failed (offline)") } else { format!("{verb} failed ({status})") }
}

/// What one push or sync-on came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushResult {
    Ok { version: i64 },
    Conflict { server_version: Option<i64> },
    Skipped(&'static str),
    Error(String),
}

/// What a snapshot PUT will send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushPlan {
    pub cloud_id: String,
    pub base_version: i64,
    /// The server already knows this cloud id.
    pub linked: bool,
}

/// Plan a push after save. Only a tracked, cloud-linked row in `synced` or
/// `unpushed` is pushed. A viewer's push is refused before it is sent, and the
/// row turns `unpushed` because the edit is on disk only.
pub fn plan_push(record: &SyncRecord, viewer: bool) -> Result<PushPlan, (SyncRecord, PushResult)> {
    let pushable = matches!(record.state, SyncState::Synced | SyncState::Unpushed);
    let Some(id) = record.cloud_doc_id.clone().filter(|_| pushable) else {
        return Err((record.clone(), PushResult::Skipped("not synced")));
    };
    if viewer {
        return Err((SyncRecord { state: SyncState::Unpushed, ..record.clone() }, PushResult::Error(VIEWER_REFUSAL.into())));
    }
    Ok(PushPlan { cloud_id: id, base_version: record.cloud_version, linked: true })
}

/// Plan turning sync on. A linked row pushes against its version; a new one
/// gets a fresh client UUID and base version 0.
pub fn plan_sync_on(record: &SyncRecord, viewer: bool, new_id: impl FnOnce() -> String) -> Result<PushPlan, (SyncRecord, PushResult)> {
    if viewer && record.cloud_doc_id.is_some() {
        return Err((SyncRecord { state: SyncState::Unpushed, ..record.clone() }, PushResult::Error(VIEWER_REFUSAL.into())));
    }
    Ok(match &record.cloud_doc_id {
        Some(id) => PushPlan { cloud_id: id.clone(), base_version: record.cloud_version, linked: true },
        None => PushPlan { cloud_id: new_id(), base_version: 0, linked: false },
    })
}

/// Apply a PUT's answer to the record.
pub fn after_put(record: &SyncRecord, plan: &PushPlan, origin: Option<&str>, hash: &str, outcome: &PutOutcome, now: &str) -> (SyncRecord, PushResult) {
    let mut r = record.clone();
    match outcome {
        PutOutcome::Saved { version: Some(v) } => {
            r.cloud_doc_id = Some(plan.cloud_id.clone());
            if !plan.linked {
                r.cloud_origin = origin.map(str::to_string);
            }
            r.cloud_version = *v;
            r.content_hash = Some(hash.to_string());
            r.state = SyncState::Synced;
            r.last_synced_at = Some(now.to_string());
            (r, PushResult::Ok { version: *v })
        }
        PutOutcome::Saved { version: None } => {
            // Stored, but the version is unknown. Keep the id (and only the id)
            // so a retry reuses the same cloud doc instead of minting an orphan.
            if !plan.linked {
                r.cloud_doc_id = Some(plan.cloud_id.clone());
                r.cloud_origin = origin.map(str::to_string);
            }
            r.state = SyncState::Unpushed;
            (r, PushResult::Error(UNREADABLE.into()))
        }
        PutOutcome::Conflict { server_version } => {
            r.state = SyncState::Conflict;
            (r, PushResult::Conflict { server_version: *server_version })
        }
        PutOutcome::Failed { status } => {
            r.state = SyncState::Unpushed;
            (r, PushResult::Error(failure("push", *status)))
        }
        // Nothing is acknowledged for a session that changed mid-flight.
        PutOutcome::Stale => (record.clone(), PushResult::Error(STALE_UPLOAD.into())),
    }
}

/// Turning sync off: pause, or after a delete that landed (200 or 404), go back to local-only.
pub fn after_sync_off(record: &SyncRecord, delete_status: Option<u16>) -> Result<SyncRecord, String> {
    match delete_status {
        None => Ok(SyncRecord { state: SyncState::Paused, ..record.clone() }),
        Some(200) | Some(404) => Ok(SyncRecord { state: SyncState::LocalOnly, cloud_doc_id: None, cloud_origin: None, cloud_version: 0, ..record.clone() }),
        Some(status) => Err(failure("delete", status)),
    }
}

/// The record after taking the cloud copy, or why not.
pub fn take_cloud(record: &SyncRecord, doc: &Doc, name: &str, now: &str) -> Result<SyncRecord, String> {
    if record.state == SyncState::Unpushed {
        return Err(UNPUSHED_TAKE_CLOUD.into());
    }
    if let Some(e) = over_cap(&doc.content, name) {
        return Err(e);
    }
    Ok(SyncRecord {
        cloud_version: doc.version,
        content_hash: Some(hash_content(&doc.content)),
        state: SyncState::Synced,
        last_synced_at: Some(now.to_string()),
        ..record.clone()
    })
}

/// `name (my version).md`, then `name (my version 2).md`, …
pub fn keep_both_path(file: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let dir = file.parent().unwrap_or(Path::new(""));
    let base = file.file_name()?.to_string_lossy().to_string();
    let (stem, ext) = split_ext(&base);
    (0..1000).map(|n| if n == 0 { " (my version)".to_string() } else { format!(" (my version {})", n + 1) }).map(|s| dir.join(format!("{stem}{s}{ext}"))).find(|p| !exists(p))
}

fn split_ext(base: &str) -> (&str, &str) {
    match base.rfind('.') {
        Some(dot) if dot > 0 => (&base[..dot], &base[dot..]),
        _ => (base, ""),
    }
}

/// Keep both: the local text goes to a copy that is local-only; the original
/// takes the cloud copy and is synced at its version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeepBoth {
    pub copy_path: PathBuf,
    pub copy_content: String,
    pub copy_record: SyncRecord,
    pub original_content: String,
    pub original_record: SyncRecord,
}

pub fn keep_both(file: &Path, record: &SyncRecord, local: &str, doc: &Doc, now: &str, exists: impl Fn(&Path) -> bool) -> Result<KeepBoth, String> {
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if let Some(e) = over_cap(&doc.content, &name) {
        return Err(e);
    }
    let copy_path = keep_both_path(file, exists).ok_or("Couldn't find an unused name for the copy.")?;
    Ok(KeepBoth {
        copy_path,
        copy_content: local.to_string(),
        copy_record: SyncRecord { content_hash: Some(hash_content(local)), ..SyncRecord::default() },
        original_content: doc.content.clone(),
        original_record: SyncRecord {
            cloud_version: doc.version,
            content_hash: Some(hash_content(&doc.content)),
            state: SyncState::Synced,
            last_synced_at: Some(now.to_string()),
            ..record.clone()
        },
    })
}

/// A safe file name for a cloud document landing in `~/Documents/Markie/Cloud`.
pub fn landing_name(name: &str) -> String {
    let cleaned: String = name.replace('\\', "/").chars().filter(|c| (*c as u32) > 0x1f).collect();
    let base = cleaned.rsplit('/').next().unwrap_or("").trim().to_string();
    let base = if base.is_empty() || base == "." || base == ".." { "document.md".to_string() } else { base };
    let (_, ext) = split_ext(&base);
    const DOC_EXTS: &[&str] = &[".md", ".markdown", ".mdx", ".txt", ".text", ".log", ".csv", ".wd"];
    if DOC_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)) { base } else { format!("{base}.md") }
}

/// The first free `name`, `name (2)`, … in `dir`.
pub fn free_path(dir: &Path, base: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let (stem, ext) = split_ext(base);
    (1..1000).map(|n| if n == 1 { dir.join(base) } else { dir.join(format!("{stem} ({n}){ext}")) }).find(|p| !exists(p))
}

/// A fingerprint of a listing plus media states, so the Library repaints only when something changed.
pub fn listing_fingerprint(docs: &[DocMeta], media: &[(String, String, String)]) -> String {
    use sha1::Sha1;
    let mut parts: Vec<String> = docs.iter().map(|d| format!("{}:{}:{}:{}", d.id, d.version, if d.shared { 1 } else { 0 }, d.name)).collect();
    parts.sort();
    let mut m: Vec<String> = media.iter().map(|(id, state, skipped)| format!("{id}:{state}:{skipped}")).collect();
    m.sort();
    parts.extend(m);
    hex::encode(Sha1::digest(parts.join("\n").as_bytes()))
}

/// What the Library shows for a row's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibraryState {
    Is(SyncState),
    /// A newer snapshot exists on the server (another device).
    Behind,
}

/// The Library's view of a row given this server's listing. A synced row the
/// complete listing no longer names was deleted remotely and reads as paused.
pub fn library_state(record: &SyncRecord, remote: Option<&DocMeta>, listing_loaded: bool) -> LibraryState {
    if record.state == SyncState::Synced
        && let Some(r) = remote
        && r.version > record.cloud_version
    {
        return LibraryState::Behind;
    }
    if listing_loaded && record.state == SyncState::Synced && record.cloud_doc_id.is_some() && remote.is_none() {
        return LibraryState::Is(SyncState::Paused);
    }
    LibraryState::Is(record.state)
}

/// A newer version on the server for a local row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub cloud_id: String,
    pub local_version: i64,
    pub remote_version: i64,
    pub state: SyncState,
}

pub fn updates<'a>(records: impl IntoIterator<Item = &'a SyncRecord>, listing: &[DocMeta]) -> Vec<Update> {
    let remote: HashMap<&str, &DocMeta> = listing.iter().map(|d| (d.id.as_str(), d)).collect();
    records
        .into_iter()
        .filter_map(|r| {
            let id = r.cloud_doc_id.as_deref()?;
            let d = remote.get(id)?;
            (d.version > r.cloud_version).then(|| Update { cloud_id: id.to_string(), local_version: r.cloud_version, remote_version: d.version, state: r.state })
        })
        .collect()
}

/// Owned documents in a listing that no local row holds yet: they land on this device.
pub fn arriving<'a>(listing: &'a [DocMeta], known: &HashSet<String>) -> Vec<&'a DocMeta> {
    listing.iter().filter(|d| !d.shared && !d.id.is_empty() && !known.contains(&d.id)).collect()
}

/// Roles and exposure one server's listings have said, for one account.
#[derive(Debug, Default, Clone)]
pub struct ListingKnowledge {
    roles: HashMap<String, Role>,
    exposure: HashMap<String, bool>,
}

impl ListingKnowledge {
    /// Record a complete `GET /api/docs`. A document it no longer names loses
    /// its exposure answer: silence is not "private".
    pub fn note(&mut self, docs: &[DocMeta]) {
        let mut named = HashSet::new();
        for d in docs {
            named.insert(d.id.clone());
            self.roles.insert(d.id.clone(), if d.shared { d.role.unwrap_or(Role::Viewer) } else { Role::Owner });
            self.exposure.insert(d.id.clone(), if d.shared { true } else { d.shared_out != Some(false) });
        }
        self.exposure.retain(|k, _| named.contains(k));
    }
    pub fn set_role(&mut self, id: &str, role: Option<Role>) {
        match role {
            Some(r) => self.roles.insert(id.to_string(), r),
            None => self.roles.remove(id),
        };
    }
    pub fn role(&self, id: &str) -> Option<Role> {
        self.roles.get(id).copied()
    }
    /// True when someone else can read it, false when nobody can, None when unknown.
    pub fn is_exposed(&self, id: &str) -> Option<bool> {
        self.exposure.get(id).copied()
    }
    /// A new account or session: everything it said goes.
    pub fn clear(&mut self) {
        self.roles.clear();
        self.exposure.clear();
    }
}

/// The result of a resolve or pull: the record to store and the text to write, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub record: SyncRecord,
    pub write: Option<String>,
    pub version: i64,
}

/// Runs the rules against one server.
pub struct SyncEngine<'a> {
    docs: DocsClient<'a>,
    /// The origin new documents are recorded under, or None for the primary server.
    record_origin: Option<String>,
}

impl<'a> SyncEngine<'a> {
    pub fn new(client: &'a crate::CloudClient, primary: bool) -> Self {
        Self { docs: DocsClient::new(client), record_origin: if primary { None } else { Some(client.origin().to_string()) } }
    }

    async fn put(&self, plan: &PushPlan, name: &str, content: &str, area_id: Option<&str>) -> (String, PutOutcome) {
        let hash = hash_content(content);
        let body = PutDoc { name: name.into(), content: content.into(), hash: hash.clone(), base_version: plan.base_version, area_id: area_id.map(str::to_string), origin: None };
        let out = self.docs.put(&plan.cloud_id, &body).await;
        (hash, out)
    }

    /// Turn syncing on: create the cloud doc, or push a new snapshot of a linked one.
    pub async fn sync_on(&self, record: &SyncRecord, name: &str, content: &str, viewer: bool) -> (SyncRecord, PushResult) {
        let plan = match plan_sync_on(record, viewer, || uuid::Uuid::new_v4().to_string()) {
            Ok(p) => p,
            Err(refused) => return refused,
        };
        let (hash, out) = self.put(&plan, name, content, None).await;
        after_put(record, &plan, self.record_origin.as_deref(), &hash, &out, &crate::registry::iso_now_system())
    }

    /// Push after save.
    pub async fn push(&self, record: &SyncRecord, name: &str, content: &str, viewer: bool) -> (SyncRecord, PushResult) {
        let plan = match plan_push(record, viewer) {
            Ok(p) => p,
            Err(refused) => return refused,
        };
        let (hash, out) = self.put(&plan, name, content, None).await;
        after_put(record, &plan, self.record_origin.as_deref(), &hash, &out, &crate::registry::iso_now_system())
    }

    /// Turn sync off, optionally deleting the cloud copy first.
    pub async fn sync_off(&self, record: &SyncRecord, delete_remote: bool) -> Result<SyncRecord, String> {
        match (&record.cloud_doc_id, delete_remote) {
            (Some(id), true) => {
                let status = self.docs.delete(id).await.unwrap_or(0);
                after_sync_off(record, Some(status))
            }
            _ => after_sync_off(record, None),
        }
    }

    async fn fetch(&self, id: &str) -> Result<Doc, String> {
        self.docs.get(id).await.map_err(|e| match e {
            CloudError::Unreadable => UNREADABLE.to_string(),
            CloudError::Status { status, .. } => failure("fetch", status),
            _ => failure("fetch", 0),
        })
    }

    /// The cloud copy's text, for a diff.
    pub async fn remote_content(&self, record: &SyncRecord, name: &str) -> Result<Doc, String> {
        let id = record.cloud_doc_id.as_deref().ok_or("not synced")?;
        let doc = self.fetch(id).await?;
        if let Some(e) = over_cap(&doc.content, name) {
            return Err(e);
        }
        Ok(doc)
    }

    /// Resolve a conflict by taking the cloud copy.
    pub async fn resolve_take_cloud(&self, record: &SyncRecord, name: &str) -> Result<Resolved, String> {
        if record.state == SyncState::Unpushed {
            return Err(UNPUSHED_TAKE_CLOUD.into());
        }
        let id = record.cloud_doc_id.as_deref().ok_or("not resolvable")?;
        let doc = self.fetch(id).await?;
        let rec = take_cloud(record, &doc, name, &crate::registry::iso_now_system())?;
        Ok(Resolved { record: rec, write: Some(doc.content), version: doc.version })
    }

    /// Resolve a conflict by overwriting the cloud with the local text, based on
    /// whatever version the server holds now.
    pub async fn resolve_overwrite(&self, record: &SyncRecord, name: &str, local: &str) -> Result<Resolved, String> {
        let id = record.cloud_doc_id.clone().ok_or("not resolvable")?;
        let base = self.docs.get(&id).await.map(|d| d.version).unwrap_or(0);
        let plan = PushPlan { cloud_id: id, base_version: base, linked: true };
        let (hash, out) = self.put(&plan, name, local, None).await;
        match after_put(record, &plan, None, &hash, &out, &crate::registry::iso_now_system()) {
            (rec, PushResult::Ok { version }) => Ok(Resolved { record: rec, write: None, version }),
            (_, PushResult::Conflict { .. }) => Err(failure("push", 409)),
            (_, PushResult::Error(e)) => Err(e),
            (_, PushResult::Skipped(s)) => Err(s.into()),
        }
    }

    /// Resolve a conflict by keeping both.
    pub async fn resolve_keep_both(&self, file: &Path, record: &SyncRecord, local: &str, exists: impl Fn(&Path) -> bool) -> Result<KeepBoth, String> {
        let id = record.cloud_doc_id.as_deref().ok_or("not synced")?;
        let doc = self.fetch(id).await?;
        keep_both(file, record, local, &doc, &crate::registry::iso_now_system(), exists)
    }

    /// Download a cloud-only document for tracking at a new path.
    pub async fn pull(&self, cloud_id: &str, fallback_name: &str) -> Result<(Doc, SyncRecord), String> {
        let doc = self.fetch(cloud_id).await?;
        let name = if doc.name.is_empty() { fallback_name.to_string() } else { doc.name.clone() };
        if let Some(e) = over_cap(&doc.content, &name) {
            return Err(e);
        }
        let rec = SyncRecord {
            cloud_doc_id: Some(cloud_id.to_string()),
            cloud_origin: self.record_origin.clone(),
            cloud_version: doc.version,
            content_hash: Some(hash_content(&doc.content)),
            state: SyncState::Synced,
            last_synced_at: Some(crate::registry::iso_now_system()),
            ..SyncRecord::default()
        };
        Ok((doc, rec))
    }

    /// The listing, recorded into `knowledge`, plus the updates it implies.
    pub async fn check_updates<'r>(&self, records: impl IntoIterator<Item = &'r SyncRecord>, knowledge: &mut ListingKnowledge) -> Result<(Vec<DocMeta>, Vec<Update>), CloudError> {
        let listing = self.docs.list().await?;
        knowledge.note(&listing);
        let ups = updates(records, &listing);
        Ok((listing, ups))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synced(id: &str, v: i64) -> SyncRecord {
        SyncRecord { cloud_doc_id: Some(id.into()), cloud_version: v, state: SyncState::Synced, ..Default::default() }
    }

    #[test]
    fn hash_matches_the_registry() {
        // sha256("hello") as electron/registry.js hashContent computes it.
        assert_eq!(hash_content("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn push_only_from_synced_or_unpushed() {
        for s in [SyncState::LocalOnly, SyncState::Conflict, SyncState::Paused] {
            let r = SyncRecord { state: s, ..synced("a", 1) };
            assert_eq!(plan_push(&r, false).unwrap_err().1, PushResult::Skipped("not synced"));
        }
        assert_eq!(plan_push(&SyncRecord { cloud_doc_id: None, ..synced("a", 1) }, false).unwrap_err().1, PushResult::Skipped("not synced"));
        let p = plan_push(&SyncRecord { state: SyncState::Unpushed, ..synced("a", 3) }, false).unwrap();
        assert_eq!(p, PushPlan { cloud_id: "a".into(), base_version: 3, linked: true });
    }

    #[test]
    fn a_viewer_push_is_refused_and_marked_unpushed() {
        let (rec, res) = plan_push(&synced("a", 1), true).unwrap_err();
        assert_eq!(rec.state, SyncState::Unpushed);
        assert_eq!(res, PushResult::Error(VIEWER_REFUSAL.into()));
    }

    #[test]
    fn sync_on_mints_a_uuid_for_a_new_doc_only() {
        let p = plan_sync_on(&SyncRecord::default(), false, || "new-id".into()).unwrap();
        assert_eq!(p, PushPlan { cloud_id: "new-id".into(), base_version: 0, linked: false });
        let p = plan_sync_on(&synced("old", 4), false, || unreachable!()).unwrap();
        assert_eq!(p.base_version, 4);
    }

    #[test]
    fn put_answers_move_the_state() {
        let r = SyncRecord::default();
        let plan = PushPlan { cloud_id: "n".into(), base_version: 0, linked: false };
        let (rec, res) = after_put(&r, &plan, Some("https://docs.example.com"), "h", &PutOutcome::Saved { version: Some(1) }, "T");
        assert_eq!(res, PushResult::Ok { version: 1 });
        assert_eq!((rec.state, rec.cloud_version, rec.cloud_doc_id.as_deref(), rec.cloud_origin.as_deref(), rec.content_hash.as_deref()), (SyncState::Synced, 1, Some("n"), Some("https://docs.example.com"), Some("h")));

        // Unreadable 200: keep the id so the retry reuses it, stay unpushed at version 0.
        let (rec, res) = after_put(&r, &plan, None, "h", &PutOutcome::Saved { version: None }, "T");
        assert_eq!(res, PushResult::Error(UNREADABLE.into()));
        assert_eq!((rec.state, rec.cloud_doc_id.as_deref(), rec.cloud_version), (SyncState::Unpushed, Some("n"), 0));

        let linked = synced("a", 2);
        let lplan = plan_push(&linked, false).unwrap();
        let (rec, res) = after_put(&linked, &lplan, None, "h", &PutOutcome::Conflict { server_version: Some(5) }, "T");
        assert_eq!((rec.state, res), (SyncState::Conflict, PushResult::Conflict { server_version: Some(5) }));
        let (rec, res) = after_put(&linked, &lplan, None, "h", &PutOutcome::Failed { status: 0 }, "T");
        assert_eq!((rec.state, res), (SyncState::Unpushed, PushResult::Error("push failed (offline)".into())));
        let (rec, res) = after_put(&linked, &lplan, None, "h", &PutOutcome::Failed { status: 403 }, "T");
        assert_eq!((rec.state, res), (SyncState::Unpushed, PushResult::Error("push failed (403)".into())));
        // A stale session acknowledges nothing.
        let (rec, res) = after_put(&linked, &lplan, None, "h", &PutOutcome::Stale, "T");
        assert_eq!((rec, res), (linked.clone(), PushResult::Error(STALE_UPLOAD.into())));
    }

    #[test]
    fn sync_off_pauses_or_unlinks() {
        let r = synced("a", 2);
        assert_eq!(after_sync_off(&r, None).unwrap().state, SyncState::Paused);
        for s in [200, 404] {
            let x = after_sync_off(&r, Some(s)).unwrap();
            assert_eq!((x.state, x.cloud_doc_id, x.cloud_version), (SyncState::LocalOnly, None, 0));
        }
        assert_eq!(after_sync_off(&r, Some(500)), Err("delete failed (500)".into()));
        assert_eq!(after_sync_off(&r, Some(0)), Err("delete failed (offline)".into()));
    }

    fn doc(content: &str, v: i64) -> Doc {
        Doc { id: "a".into(), name: "a.md".into(), version: v, content: content.into(), hash: None, updated_at: None, format: None, role: None }
    }

    #[test]
    fn take_cloud_refuses_unpushed_edits() {
        let r = SyncRecord { state: SyncState::Unpushed, ..synced("a", 1) };
        assert_eq!(take_cloud(&r, &doc("x", 2), "a.md", "T"), Err(UNPUSHED_TAKE_CLOUD.into()));
        let rec = take_cloud(&SyncRecord { state: SyncState::Conflict, ..synced("a", 1) }, &doc("x", 2), "a.md", "T").unwrap();
        assert_eq!((rec.state, rec.cloud_version), (SyncState::Synced, 2));
    }

    #[test]
    fn keep_both_names_and_records() {
        let taken = [PathBuf::from("/d/a (my version).md")];
        let p = keep_both_path(Path::new("/d/a.md"), |p| taken.contains(&p.to_path_buf())).unwrap();
        assert_eq!(p, PathBuf::from("/d/a (my version 2).md"));
        assert_eq!(keep_both_path(Path::new("/d/README"), |_| false).unwrap(), PathBuf::from("/d/README (my version)"));
        let kb = keep_both(Path::new("/d/a.md"), &SyncRecord { state: SyncState::Conflict, ..synced("a", 1) }, "mine", &doc("theirs", 3), "T", |_| false).unwrap();
        assert_eq!(kb.copy_path, PathBuf::from("/d/a (my version).md"));
        assert_eq!((kb.copy_record.state, kb.copy_record.cloud_doc_id.clone()), (SyncState::LocalOnly, None));
        assert_eq!((kb.original_content.as_str(), kb.original_record.state, kb.original_record.cloud_version), ("theirs", SyncState::Synced, 3));
    }

    #[test]
    fn landing_and_free_names() {
        assert_eq!(landing_name("../../etc/passwd"), "passwd.md");
        assert_eq!(landing_name("notes.md"), "notes.md");
        assert_eq!(landing_name(""), "document.md");
        assert_eq!(landing_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(landing_name("bad\u{1}name.md"), "badname.md");
        let taken = [PathBuf::from("/c/n.md"), PathBuf::from("/c/n (2).md")];
        assert_eq!(free_path(Path::new("/c"), "n.md", |p| taken.contains(&p.to_path_buf())).unwrap(), PathBuf::from("/c/n (3).md"));
    }

    fn meta(id: &str, v: i64, shared: bool, out: Option<bool>) -> DocMeta {
        DocMeta { id: id.into(), name: id.into(), version: v, hash: None, updated_at: None, shared, role: shared.then_some(Role::Editor), shared_by: None, shared_out: out }
    }

    #[test]
    fn library_view_and_updates() {
        let r = synced("a", 1);
        assert_eq!(library_state(&r, Some(&meta("a", 2, false, None)), true), LibraryState::Behind);
        assert_eq!(library_state(&r, None, true), LibraryState::Is(SyncState::Paused));
        assert_eq!(library_state(&r, None, false), LibraryState::Is(SyncState::Synced));
        let ups = updates([&r, &synced("b", 5)], &[meta("a", 3, false, None), meta("b", 5, false, None)]);
        assert_eq!(ups, vec![Update { cloud_id: "a".into(), local_version: 1, remote_version: 3, state: SyncState::Synced }]);
        let known: HashSet<String> = ["a".to_string()].into();
        let listing = [meta("a", 1, false, None), meta("b", 1, false, None), meta("c", 1, true, None)];
        assert_eq!(arriving(&listing, &known).iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn listing_knowledge_fails_closed() {
        let mut k = ListingKnowledge::default();
        k.note(&[meta("own", 1, false, Some(false)), meta("out", 1, false, Some(true)), meta("silent", 1, false, None), meta("theirs", 1, true, None)]);
        assert_eq!(k.is_exposed("own"), Some(false));
        assert_eq!(k.is_exposed("out"), Some(true));
        assert_eq!(k.is_exposed("silent"), Some(true));
        assert_eq!(k.is_exposed("theirs"), Some(true));
        assert_eq!(k.role("theirs"), Some(Role::Editor));
        assert_eq!(k.role("own"), Some(Role::Owner));
        k.note(&[meta("out", 1, false, Some(true))]);
        assert_eq!(k.is_exposed("own"), None);
        assert_eq!(k.is_exposed("unknown"), None);
    }

    #[test]
    fn fingerprint_is_order_free() {
        let a = listing_fingerprint(&[meta("a", 1, false, None), meta("b", 2, true, None)], &[]);
        let b = listing_fingerprint(&[meta("b", 2, true, None), meta("a", 1, false, None)], &[]);
        assert_eq!(a, b);
        assert_ne!(a, listing_fingerprint(&[meta("a", 2, false, None), meta("b", 2, true, None)], &[]));
    }

    #[test]
    fn over_cap_refuses_100_mb() {
        assert!(over_cap("small", "a.md").is_none());
        assert!(over_cap(&"x".repeat(MAX_DOC_BYTES), "a.md").unwrap().contains("more than Markie opens"));
    }
}
