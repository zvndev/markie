//! Local-first snapshot sync. UI state and writes belong to the workspace;
//! network requests run on Tokio and are bound to a confirmed principal.
use super::{DocKind, Workspace};
use gpui_kit::component::WindowExt as _;
use gpui_kit::*;
use markie_cloud::docs::{Doc, DocMeta, DocsClient, Role};
use markie_cloud::http::Transport;
use markie_cloud::platform::{Area, PlatformClient, SnapshotMeta};
use markie_cloud::registry::ServerStore;
use markie_cloud::sync::{self, LibraryState, PushResult, SyncEngine, SyncRecord, SyncState};
use markie_cloud::tokens::{KeyringTokenStore, MemoryTokenStore, TokenStore};
use markie_cloud::{CloudClient, DEFAULT_SERVER, assets, links};
use markie_core::{document, formats, history::Writer, paths, registry::Registry};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

pub(super) async fn network<T: Send + 'static>(
    future: impl Future<Output = T> + Send + 'static,
) -> Result<T, String> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("markie-cloud")
            .build()
            .map_err(|e| e.to_string())
    });
    runtime
        .as_ref()
        .map_err(Clone::clone)?
        .spawn(future)
        .await
        .map_err(|_| "The cloud task did not complete.".into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Binding {
    pub user: String,
    pub record: SyncRecord,
    #[serde(default)]
    pending_area: Option<String>,
    #[serde(default)]
    media: assets::Transfer,
    #[serde(default)]
    links: links::Transfer,
}

impl Binding {
    fn new(user: &str, record: SyncRecord) -> Self {
        Self {
            user: user.into(),
            record,
            pending_area: None,
            media: Default::default(),
            links: Default::default(),
        }
    }

    fn origin(&self) -> &str {
        self.record
            .cloud_origin
            .as_deref()
            .unwrap_or(DEFAULT_SERVER)
    }
}

#[derive(Clone)]
pub(super) struct Scope {
    pub user: String,
    pub client: CloudClient,
}

impl Scope {
    pub fn origin(&self) -> &str {
        self.client.origin()
    }
    pub fn active(&self) -> bool {
        self.client.session().is_some()
    }
    fn matches(&self, binding: &Binding) -> bool {
        self.user == binding.user && self.origin() == binding.origin()
    }
    fn engine(&self) -> SyncEngine<'_> {
        SyncEngine::new(&self.client, self.origin() == DEFAULT_SERVER)
    }
}

#[derive(Default)]
pub(super) struct Listing {
    pub user: String,
    pub docs: Option<Vec<DocMeta>>,
    pub snapshots: Vec<SnapshotMeta>,
    pub areas: Vec<Area>,
    pub error: Option<String>,
}

pub(super) struct CloudWorkspace {
    pub servers: ServerStore,
    pub tokens: Arc<dyn TokenStore>,
    transport: Transport,
    pub bindings: HashMap<PathBuf, Binding>,
    pub listings: BTreeMap<String, Listing>,
    pub notice: Option<String>,
    pub checking: bool,
    pub selection: Option<String>,
    pub area: Option<String>,
    pub source: super::cloud_ui::Source,
    pub busy: HashSet<PathBuf>,
    pub resource_epoch: u64,
    pub pending_link: Option<PathBuf>,
    suspend_push: bool,
    queued: HashSet<PathBuf>,
    cursors: HashMap<String, usize>,
}

impl CloudWorkspace {
    pub fn new(data: &Path, registry: Option<&Registry>) -> Self {
        let scratch = std::env::var_os("MARKIE_RS_DATA_DIR").is_some();
        let tokens: Arc<dyn TokenStore> = if scratch {
            Arc::new(MemoryTokenStore::new())
        } else {
            Arc::new(KeyringTokenStore::new(paths::APP_NAME))
        };
        Self {
            servers: ServerStore::open(Some(data.join("servers.json")), scratch),
            tokens,
            transport: Transport::new(),
            bindings: registry
                .and_then(|r| r.cloud_records().ok())
                .unwrap_or_default()
                .into_iter()
                .collect(),
            listings: BTreeMap::new(),
            notice: None,
            checking: false,
            selection: None,
            area: None,
            source: Default::default(),
            busy: HashSet::new(),
            resource_epoch: 0,
            pending_link: None,
            suspend_push: false,
            queued: HashSet::new(),
            cursors: HashMap::new(),
        }
    }

    pub fn scope(&self, origin: &str) -> Option<Scope> {
        let client = CloudClient::new(
            origin,
            self.servers.trust_handle(),
            self.tokens.clone(),
            self.transport.clone(),
        )
        .ok()?;
        let user = client.session()?.user_id?;
        Some(Scope {
            client: client.for_user(&user),
            user,
        })
    }

    pub fn scopes(&self) -> Vec<Scope> {
        self.servers
            .origins()
            .iter()
            .filter_map(|origin| self.scope(origin))
            .collect()
    }

    pub fn selected_scope(&self) -> Option<Scope> {
        self.selection
            .as_deref()
            .and_then(|origin| self.scope(origin))
            .or_else(|| self.scopes().into_iter().next())
    }

    pub fn listing(&self, scope: &Scope) -> Option<&Listing> {
        self.listings
            .get(scope.origin())
            .filter(|l| l.user == scope.user)
    }

    pub fn remote(&self, path: &Path) -> Option<&DocMeta> {
        let binding = self.bindings.get(path)?;
        let listing = self
            .listings
            .get(binding.origin())
            .filter(|l| l.user == binding.user)?;
        listing
            .docs
            .as_ref()?
            .iter()
            .find(|row| Some(&row.id) == binding.record.cloud_doc_id.as_ref())
    }

    pub fn badge(&self, path: &Path) -> Option<&'static str> {
        let binding = self.bindings.get(path)?;
        let loaded = self
            .listings
            .get(binding.origin())
            .is_some_and(|l| l.user == binding.user && l.docs.is_some());
        Some(
            match sync::library_state(&binding.record, self.remote(path), loaded) {
                LibraryState::Behind => "Update available",
                LibraryState::Is(SyncState::Synced) => "Synced",
                LibraryState::Is(SyncState::Unpushed) => "Not backed up",
                LibraryState::Is(SyncState::Conflict) => "Conflict",
                LibraryState::Is(SyncState::Paused) => "Paused",
                LibraryState::Is(SyncState::LocalOnly) => return None,
            },
        )
    }

    pub fn find(&self, scope: &Scope, id: &str) -> Option<PathBuf> {
        self.bindings.iter().find_map(|(p, b)| {
            (scope.matches(b) && b.record.cloud_doc_id.as_deref() == Some(id)).then(|| p.clone())
        })
    }

    pub fn bound_scope(&self, path: &Path) -> Option<(Scope, String)> {
        let binding = self.bindings.get(path)?;
        let scope = self
            .scope(binding.origin())
            .filter(|s| s.matches(binding))?;
        Some((scope, binding.record.cloud_doc_id.clone()?))
    }

    pub fn media_note(&self, path: &Path) -> Option<String> {
        let binding = self.bindings.get(path)?;
        if let Some(status) = binding.media.refused {
            return Some(format!(" · media refused ({status})"));
        }
        if binding.record.state == SyncState::Synced
            && binding.record.share_role != Some(Role::Viewer)
            && binding.media.fingerprint.is_none()
        {
            return Some(" · media pending".into());
        }
        binding
            .media
            .skipped
            .iter()
            .find(|s| matches!(s.reason.as_str(), "outside" | "size"))
            .map(|s| format!(" · {}: {}", s.reason, s.reference))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextAction {
    Enable,
    Push,
    Repair,
    Pause,
    Delete,
    Pull,
    KeepBoth,
    Overwrite,
}

impl TextAction {
    fn sends_text(self) -> bool {
        matches!(
            self,
            Self::Enable | Self::Push | Self::Repair | Self::Overwrite
        )
    }
}

fn text_file(path: &Path) -> Result<(String, formats::TextEncoding, bool), String> {
    let doc = document::open(path).map_err(|e| e.to_string())?;
    match doc.content {
        document::Content::Text {
            text,
            encoding,
            bom,
        } => Ok((text, encoding, bom)),
        _ => Err("This document uses byte snapshots.".into()),
    }
}

fn path_occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Never descend through an existing symlink, including a Cloud directory
/// pointing at the Electron build's workspace.
pub(super) fn landing_base() -> PathBuf {
    if std::env::var_os("MARKIE_RS_DATA_DIR").is_some() {
        paths::data_dir()
    } else {
        paths::home_dir().join("Documents")
    }
}

pub(super) fn landing_dir() -> std::io::Result<PathBuf> {
    landing_dir_at(landing_base())
}

fn landing_dir_at(mut dir: PathBuf) -> std::io::Result<PathBuf> {
    for segment in ["Markie RS", "Cloud"] {
        dir.push(segment);
        match std::fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        if !std::fs::symlink_metadata(&dir)?.file_type().is_dir() {
            return Err(std::io::Error::other(
                "The Markie RS cloud folder is not a real directory.",
            ));
        }
    }
    dir.canonicalize()
}

#[cfg(test)]
mod tests {
    use super::{landing_dir_at, path_occupied};
    use markie_cloud::{assets, sync};

    #[test]
    fn cloud_landing_is_isolated_and_exclusive() {
        let scratch = tempfile::tempdir().unwrap();
        let original = scratch.path().join("Markie").join("Cloud");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::write(original.join("note.md"), "untouched").unwrap();
        let rs = landing_dir_at(scratch.path().to_owned()).unwrap();
        assert_eq!(
            rs,
            scratch
                .path()
                .canonicalize()
                .unwrap()
                .join("Markie RS/Cloud")
        );
        let path = sync::free_path(&rs, &sync::landing_name("../note.md"), path_occupied).unwrap();
        assets::create_copy(&path, b"first").unwrap();
        assert!(assets::create_copy(&path, b"second").is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "first");
        assert_eq!(
            std::fs::read_to_string(original.join("note.md")).unwrap(),
            "untouched"
        );
        assert!(
            sync::free_path(&rs, "note.md", path_occupied)
                .unwrap()
                .ends_with("note (2).md")
        );
    }

    #[cfg(unix)]
    #[test]
    fn cloud_landing_refuses_a_link_into_another_app() {
        let scratch = tempfile::tempdir().unwrap();
        let original = scratch.path().join("Markie");
        std::fs::create_dir(&original).unwrap();
        std::os::unix::fs::symlink(&original, scratch.path().join("Markie RS")).unwrap();
        assert!(landing_dir_at(scratch.path().to_owned()).is_err());
        assert!(!original.join("Cloud").exists());
    }
}

pub(super) fn land(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = landing_dir().map_err(|e| e.to_string())?;
    let path = sync::free_path(&dir, name, path_occupied)
        .ok_or("No unused filename for the cloud copy.")?;
    assets::create_copy(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

pub(super) fn name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

struct TextWork {
    scope: Scope,
    binding: Binding,
    action: TextAction,
    path: PathBuf,
    roots: Vec<PathBuf>,
    targets: HashMap<PathBuf, String>,
    remote: Option<DocMeta>,
}

struct TextResult {
    binding: Binding,
    status: Option<String>,
    replacement: Option<Replacement>,
}

struct Replacement {
    before: String,
    remote: String,
    encoding: formats::TextEncoding,
    bom: bool,
    keep_both: bool,
}

impl TextWork {
    async fn run(mut self) -> Result<TextResult, String> {
        let engine = self.scope.engine();
        let docs = DocsClient::new(&self.scope.client);
        let name = name(&self.path);
        let mut status = None;
        let mut replacement = None;
        if self.action == TextAction::Pause || self.action == TextAction::Delete {
            self.binding.record = engine
                .sync_off(&self.binding.record, self.action == TextAction::Delete)
                .await?;
        } else {
            let (text, encoding, bom) = text_file(&self.path)?;
            let hash = sync::hash_content(&text);
            let viewer = self.binding.record.share_role == Some(Role::Viewer);
            let previous = self.binding.record.clone();
            match self.action {
                TextAction::Pull | TextAction::KeepBoth => {
                    let keep_both = self.action == TextAction::KeepBoth;
                    if !keep_both
                        && previous.state != SyncState::Conflict
                        && previous.content_hash.as_deref() != Some(hash.as_str())
                    {
                        return Err("The local file has changes that are not backed up. Keep both to preserve them.".into());
                    }
                    let doc = engine.remote_content(&previous, &name).await?;
                    let mut previous = previous;
                    if keep_both {
                        previous.state = SyncState::Conflict;
                    }
                    self.binding.record =
                        sync::take_cloud(&previous, &doc, &name, &chrono::Utc::now().to_rfc3339())?;
                    self.binding.media = Default::default();
                    self.binding.links = Default::default();
                    replacement = Some(Replacement {
                        before: text.clone(),
                        remote: doc.content,
                        encoding,
                        bom,
                        keep_both,
                    });
                }
                TextAction::Overwrite => {
                    if viewer {
                        return Err(sync::VIEWER_REFUSAL.into());
                    }
                    self.binding.record = engine
                        .resolve_overwrite(&previous, &name, &text)
                        .await?
                        .record;
                }
                TextAction::Enable | TextAction::Push | TextAction::Repair => {
                    let creating = previous.cloud_version == 0;
                    let recovered = creating
                        && self.remote.as_ref().is_some_and(|r| {
                            !r.shared && r.version >= 1 && r.hash.as_deref() == Some(hash.as_str())
                        });
                    let same_content = previous.state == SyncState::Synced
                        && previous.content_hash.as_deref() == Some(hash.as_str());
                    let remote_matches = self.remote.as_ref().is_none_or(|r| {
                        r.version > previous.cloud_version
                            || r.hash.as_deref().is_none_or(|remote| remote == hash)
                    });
                    if recovered {
                        self.binding.record.cloud_version = self.remote.as_ref().unwrap().version;
                        self.binding.record.content_hash = Some(hash);
                        self.binding.record.state = SyncState::Synced;
                        self.binding.record.last_synced_at = Some(chrono::Utc::now().to_rfc3339());
                        self.binding.pending_area = None;
                    } else if self.action == TextAction::Enable
                        || !same_content
                        || (self.action == TextAction::Repair && !remote_matches)
                    {
                        let (record, result) = if self.action == TextAction::Enable || creating {
                            engine
                                .sync_on_in_area(
                                    &previous,
                                    &name,
                                    &text,
                                    viewer,
                                    self.binding.pending_area.as_deref(),
                                )
                                .await
                        } else {
                            engine.push(&previous, &name, &text, viewer).await
                        };
                        self.binding.record = record;
                        status = match result {
                            PushResult::Ok { .. } => {
                                self.binding.pending_area = None;
                                None
                            }
                            PushResult::Conflict { .. } => {
                                Some("This document has a newer cloud copy.".into())
                            }
                            PushResult::Error(s) => Some(s),
                            PushResult::Skipped(s) => Some(s.into()),
                        };
                    }
                }
                TextAction::Pause | TextAction::Delete => unreachable!(),
            }
            if self.action.sends_text()
                && !viewer
                && status.is_none()
                && let Some(id) = self.binding.record.cloud_doc_id.as_deref()
                && self.binding.record.state == SyncState::Synced
            {
                let version = self.binding.record.cloud_version;
                // Determine exposure from a fresh listing before offering a
                // private-only relative asset outside the document's folder.
                let private = docs.list().await.ok().is_some_and(|rows| {
                    rows.iter().any(|r| {
                        r.id == id
                            && !r.shared
                            && r.shared_out == Some(false)
                            && r.version == version
                    })
                });
                match assets::reconcile(
                    &docs,
                    id,
                    version,
                    &self.path,
                    &text,
                    &self.roots,
                    private,
                    &self.binding.media,
                )
                .await
                {
                    Ok(result) => self.binding.media = result,
                    Err(_) => {
                        self.binding.media.fingerprint = None;
                        status = Some("Media is still pending.".into());
                    }
                }
                let pointers =
                    links::resolve(&self.path, &text, |to| self.targets.get(to).cloned());
                match links::reconcile(&docs, id, version, &pointers, &self.binding.links).await {
                    Ok(result) => self.binding.links = result,
                    Err(_) => {
                        self.binding.links.fingerprint = None;
                        status.get_or_insert_with(|| "Document links are still pending.".into());
                    }
                }
            }
        }
        Ok(TextResult {
            binding: self.binding,
            status,
            replacement,
        })
    }
}

impl Workspace {
    fn store_binding(&mut self, path: &Path, binding: Binding) -> Result<(), String> {
        let registry = self
            .registry
            .as_ref()
            .ok_or("The local registry is unavailable.")?;
        registry
            .set_cloud_record(path, &binding)
            .map_err(|e| e.to_string())?;
        self.cloud.bindings.insert(path.to_owned(), binding);
        Ok(())
    }

    pub(super) fn cloud_after_save(&mut self, path: &Path, cx: &mut Context<Self>) {
        if self.cloud.suspend_push {
            return;
        }
        let Some(mut binding) = self.cloud.bindings.get(path).cloned() else {
            return;
        };
        if !matches!(
            binding.record.state,
            SyncState::Synced | SyncState::Unpushed
        ) || binding.record.cloud_doc_id.is_none()
        {
            return;
        }
        if self.doc.as_ref().is_some_and(|doc| {
            (&doc.path == path) && matches!(&doc.kind,
                DocKind::Text { saved, .. } if binding.record.content_hash.as_deref() != Some(sync::hash_content(saved).as_str()))
        }) {
            binding.record.state = SyncState::Unpushed;
            if let Err(error) = self.store_binding(path, binding.clone()) {
                self.cloud.notice = Some(error);
                return;
            }
        }
        if self.cloud.busy.contains(path) {
            self.cloud.queued.insert(path.to_owned());
            return;
        }
        if self
            .cloud
            .scope(binding.origin())
            .is_none_or(|scope| !scope.matches(&binding))
        {
            let mut binding = binding.clone();
            binding.record.state = SyncState::Unpushed;
            let _ = self.store_binding(path, binding);
            return;
        }
        self.cloud_text(path.to_owned(), TextAction::Push, None, cx);
    }

    pub(super) fn cloud_text(
        &mut self,
        path: PathBuf,
        action: TextAction,
        origin: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.registry.is_none() || self.cloud.busy.contains(&path) {
            return;
        }
        let old = self
            .cloud
            .bindings
            .get(&path)
            .filter(|b| b.record.state != SyncState::LocalOnly)
            .cloned();
        let scope = match old.as_ref().map(|b| b.origin()).or(origin.as_deref()) {
            Some(o) => self.cloud.scope(o),
            None => self.cloud.selected_scope(),
        };
        let Some(scope) = scope.filter(|s| old.as_ref().is_none_or(|b| s.matches(b))) else {
            if action == TextAction::Pause
                && let Some(mut binding) = old
            {
                binding.record.state = SyncState::Paused;
                if let Err(e) = self.store_binding(&path, binding) {
                    self.cloud.notice = Some(e);
                }
            } else {
                self.cloud.notice = Some("Sign in to the document's cloud account first.".into());
            }
            cx.notify();
            return;
        };
        let mut binding = old.unwrap_or_else(|| {
            Binding::new(
                &scope.user,
                SyncRecord {
                    cloud_origin: (scope.origin() != DEFAULT_SERVER)
                        .then(|| scope.origin().to_owned()),
                    ..Default::default()
                },
            )
        });
        if action == TextAction::Enable && binding.record.cloud_doc_id.is_none() {
            binding.record.cloud_doc_id = Some(sync::reserve_document_id());
            binding.record.state = SyncState::Unpushed;
            binding.pending_area = self.cloud.area.clone();
            if let Err(error) = self.store_binding(&path, binding.clone()) {
                self.cloud.notice = Some(error);
                cx.notify();
                return;
            }
        }
        if action != TextAction::Enable && binding.record.cloud_doc_id.is_none() {
            return;
        }
        let remote = self.cloud.remote(&path).cloned();
        if let Some(remote) = &remote {
            binding.record.share_role = Some(if remote.shared {
                remote.role.unwrap_or(Role::Viewer)
            } else {
                Role::Owner
            });
            binding.record.share_role_user = Some(scope.user.clone());
        }
        let work = TextWork {
            scope: scope.clone(),
            action,
            path: path.clone(),
            binding,
            remote,
            roots: self
                .registry
                .as_ref()
                .and_then(|r| r.roots().ok())
                .unwrap_or_default(),
            targets: self
                .cloud
                .bindings
                .iter()
                .filter_map(|(p, b)| {
                    if !scope.matches(b) {
                        return None;
                    }
                    Some((
                        p.canonicalize().unwrap_or_else(|_| p.clone()),
                        b.record.cloud_doc_id.clone()?,
                    ))
                })
                .collect(),
        };
        self.cloud.busy.insert(path.clone());
        if action != TextAction::Repair {
            self.cloud.notice = None;
        }
        cx.spawn(async move |this, cx| {
            let result = network(work.run()).await.and_then(|r| r);
            let _ = this.update(cx, |workspace, cx| {
                workspace.cloud.busy.remove(&path);
                if scope.active()
                    && workspace
                        .cloud
                        .scope(scope.origin())
                        .is_some_and(|s| s.user == scope.user)
                {
                    let outcome = result.and_then(|result| {
                        if let Some(write) = result.replacement {
                            workspace.apply_cloud_text(&path, write, cx)?;
                        }
                        workspace.store_binding(&path, result.binding)?;
                        Ok(result.status)
                    });
                    if action != TextAction::Repair {
                        workspace.cloud.notice = match outcome {
                            Ok(status) => status,
                            Err(error) => Some(error),
                        };
                    }
                    if workspace.doc.as_ref().is_some_and(|d| d.path == path)
                        && action != TextAction::Repair
                    {
                        workspace.refresh_cloud_resources(cx);
                    }
                }
                if workspace.cloud.queued.remove(&path) {
                    workspace.cloud_after_save(&path, cx);
                }
                if !matches!(action, TextAction::Repair | TextAction::Push) {
                    workspace.refresh_cloud(false, cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn apply_cloud_text(
        &mut self,
        path: &Path,
        write: Replacement,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let current = self.doc.as_ref().is_some_and(|d| d.path == path);
        if (current && (self.dirty || self.disk_conflict.is_some()))
            || std::fs::symlink_metadata(path).map_or(true, |m| !m.is_file())
            || text_file(path).ok().as_ref()
                != Some(&(write.before.clone(), write.encoding, write.bom))
        {
            return Err("The local file changed while Markie fetched the cloud version. Nothing was replaced.".into());
        }
        if write.keep_both {
            let copy = sync::keep_both_path(path, path_occupied)
                .ok_or("No unused filename for the local copy.")?;
            let bytes = formats::encode_text(&write.before, write.encoding, write.bom)
                .map_err(|e| e.to_string())?;
            assets::create_copy(&copy, &bytes).map_err(|e| e.to_string())?;
            if let Some(registry) = &self.registry {
                let _ = registry.track_opened(&copy);
            }
            self.refresh_lists();
        }
        let _ = self.history.capture(path, &write.before, Writer::User);
        document::save_text(path, &write.remote, write.encoding, write.bom)
            .map_err(|e| e.to_string())?;
        if current {
            self.load_text(path, write.remote.clone(), cx);
            if self.rich_active() {
                self.load_rich(&write.remote, cx);
            }
        }
        Ok(())
    }

    pub(super) fn start_cloud_poll(&mut self, cx: &mut Context<Self>) {
        self.refresh_cloud(true, cx);
        cx.spawn(async move |weak, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs(60))
                    .await;
                if weak
                    .update(cx, |this, cx| this.refresh_cloud(true, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn refresh_cloud(&mut self, background: bool, cx: &mut Context<Self>) {
        if self.cloud.checking {
            return;
        }
        let scopes = self.cloud.scopes();
        self.cloud.listings.retain(|origin, l| {
            scopes
                .iter()
                .any(|s| s.origin() == origin && s.user == l.user)
        });
        if scopes.is_empty() {
            cx.notify();
            return;
        }
        self.cloud.checking = true;
        let requests: Vec<_> = scopes
            .into_iter()
            .map(|scope| {
                let known: HashSet<_> = self
                    .cloud
                    .bindings
                    .values()
                    .filter(|b| scope.matches(b))
                    .filter_map(|b| b.record.cloud_doc_id.clone())
                    .collect();
                (scope, known)
            })
            .collect();
        cx.spawn(async move |this, cx| {
            let refresh = network(async move {
                let mut response = Vec::new();
                for (scope, known) in requests {
                    let docs = DocsClient::new(&scope.client);
                    let platform = PlatformClient(&scope.client);
                    let (legacy, snapshots, areas) =
                        tokio::join!(docs.list(), platform.list(), platform.areas());
                    let mut landed = Vec::new();
                    if let Ok(list) = &legacy {
                        for row in sync::arriving(list, &known).into_iter().take(25) {
                            if let Ok(pair) = scope.engine().pull(&row.id, &row.name).await {
                                landed.push(pair);
                            }
                        }
                    }
                    let error = legacy.as_ref().err().map(ToString::to_string);
                    let listing = Listing {
                        user: scope.user.clone(),
                        docs: legacy.ok(),
                        snapshots: snapshots.unwrap_or_default(),
                        areas: areas.unwrap_or_default(),
                        error,
                    };
                    response.push((scope, listing, landed));
                }
                response
            })
            .await;
            let _ = this.update(cx, |this, cx| {
                this.cloud.checking = false;
                if let Ok(replies) = refresh {
                    for (scope, listing, landed) in replies {
                        if !scope.active()
                            || this
                                .cloud
                                .scope(scope.origin())
                                .is_none_or(|s| s.user != scope.user)
                        {
                            continue;
                        }
                        for (doc, record) in landed {
                            if let Some(id) = record.cloud_doc_id.as_deref()
                                && this.cloud.find(&scope, id).is_none()
                                && let Err(error) = this.land_cloud_doc(&scope, doc, record)
                            {
                                this.cloud.notice = Some(error);
                            }
                        }
                        this.cloud
                            .listings
                            .insert(scope.origin().to_owned(), listing);
                        if background {
                            this.reconcile_cloud(&scope, cx);
                        }
                    }
                    this.refresh_lists();
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn land_cloud_doc(
        &mut self,
        scope: &Scope,
        doc: Doc,
        mut record: SyncRecord,
    ) -> Result<PathBuf, String> {
        if self.registry.is_none() {
            return Err("The local registry is unavailable.".into());
        }
        let name = sync::landing_name(&doc.name);
        let path = land(&name, doc.content.as_bytes())?;
        record.share_role = doc.role;
        record.share_role_user = Some(scope.user.clone());
        self.store_binding(&path, Binding::new(&scope.user, record))?;
        if let Some(registry) = &self.registry {
            let _ = registry.track_opened(&path);
        }
        Ok(path)
    }

    fn reconcile_cloud(&mut self, scope: &Scope, cx: &mut Context<Self>) {
        let mut paths: Vec<_> = self
            .cloud
            .bindings
            .iter()
            .filter_map(|(path, binding)| {
                if !scope.matches(binding)
                    || !matches!(
                        binding.record.state,
                        SyncState::Synced | SyncState::Unpushed
                    )
                    || self.cloud.busy.contains(path)
                    || self
                        .doc
                        .as_ref()
                        .is_some_and(|d| &d.path == path && self.dirty)
                {
                    return None;
                }
                let remote = self.cloud.remote(path);
                ((binding.record.cloud_version == 0 && binding.record.cloud_doc_id.is_some())
                    || remote.is_some_and(|remote| {
                        remote.version <= binding.record.cloud_version
                            && (!remote.shared || remote.role == Some(Role::Editor))
                    }))
                .then_some(path)
                .filter(|p| p.is_file())
                .cloned()
            })
            .collect();
        paths.sort();
        if paths.is_empty() {
            return;
        }
        let cursor = self.cloud.cursors.entry(scope.origin().into()).or_default();
        let mut offset = *cursor % paths.len();
        let limit = paths.len().min(4);
        let mut window = Vec::new();
        for _ in 0..limit {
            window.push(paths[offset].clone());
            offset = (offset + 1) % paths.len();
        }
        *cursor = offset;
        for path in window {
            self.cloud_text(path, TextAction::Repair, None, cx);
        }
    }

    pub(super) fn open_cloud_text(
        &mut self,
        scope: Scope,
        id: String,
        fallback: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(path) = self.cloud.find(&scope, &id).filter(|p| p.is_file()) {
            self.open_path(&path, window, cx);
            return;
        }
        let request = scope.clone();
        cx.spawn_in(window, async move |this, cx| {
            let pull = network(async move { request.engine().pull(&id, &fallback).await })
                .await
                .and_then(|r| r);
            let _ = this.update_in(cx, |this, window, cx| {
                if !scope.active()
                    || this
                        .cloud
                        .scope(scope.origin())
                        .is_none_or(|s| s.user != scope.user)
                {
                    return;
                }
                let landed = pull.and_then(|(doc, record)| {
                    if let Some(id) = record.cloud_doc_id.as_deref()
                        && let Some(path) = this.cloud.find(&scope, id).filter(|p| p.is_file())
                    {
                        return Ok(path);
                    }
                    this.land_cloud_doc(&scope, doc, record)
                });
                match landed {
                    Ok(path) => this.open_path(&path, window, cx),
                    Err(error) => window.push_notification(error, cx),
                }
            });
        })
        .detach();
    }

    pub(super) fn persist_cloud_choice(
        &mut self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.doc.as_ref().is_none_or(|d| d.path != path) || self.disk_conflict.is_some() {
            return false;
        }
        let dirty = |this: &Self, cx: &App| {
            this.dirty
                || matches!(this.doc.as_ref().map(|d| &d.kind), Some(DocKind::Office(o)) if o.is_dirty(cx))
        };
        if dirty(self, cx) {
            self.cloud.suspend_push = true;
            self.save(window, cx);
            self.cloud.suspend_push = false;
        }
        !dirty(self, cx)
    }
}
