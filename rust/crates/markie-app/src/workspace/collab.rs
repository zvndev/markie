//! Live collaboration for the open document: who may edit it, the live room
//! when it is shared, peers' presence and carets, and the banner that says
//! why typing does nothing. The rules are `src/app/page.tsx` (refreshCollab),
//! `src/components/rich-view.tsx` and `text-collab-editor.tsx`.
//!
//! * A document with a cloud copy is read-only until the server says who
//!   this person is to it (owner, editor, viewer). Offline, a role proved
//!   before on this machine for this account still counts.
//! * It goes live only when it is shared with someone (members > 0) and is
//!   not a large document. Viewers join with presence and no edits.
//! * Rich Markdown joins the TipTap room (`markie_editor::collab`); plain
//!   text joins the `Text("content")` room.
//! * The first editor into an empty room claims it with the file's content
//!   (one update the server accepts from one client), after the first sync
//!   and a 150 ms settle. Typing waits until the claim comes back, or 15 s,
//!   after which the pane goes back to the local copy and says so.
//! * 4403 locks the document and says access was removed; 4426 and a
//!   session that never started go back to the local copy.
//! * The desktop writes its own file from the room (when the room can carry
//!   the file exactly) and never the stored cloud copy, as Electron does.
//!
//! Which documents have a cloud copy is the sync work's to say: it calls
//! [`Workspace::attach_cloud_doc`]. For tests against a local server only,
//! `MARKIE_RS_TEST_SESSION` names a JSON file with a session and documents.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::component::h_flex;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::Value;

use markie_cloud::auth::MarkieUser;
use markie_cloud::collab::room::CloseReason;
use markie_cloud::collab::runtime;
use markie_cloud::collab::session::{CloudTickets, LiveSession, LiveStatus, Peer, SessionOptions};
use markie_cloud::collab::text::TextBinding;
use markie_cloud::collab::{CONTENT_KIND_KEY, META_MAP, PeerUser, SCHEMA_KEY, SEED_SETTLE_MS, TEXT_COLLAB_KEY, TEXT_ROOM_SCHEMA, color_for_name, initials};
use markie_cloud::docs::Role;
use markie_cloud::sharing::view::{self, BannerKind, ShareRoleState, role_for, share_banner_for};
use markie_cloud::sharing::{ShareAccess, SharesClient};
use markie_cloud::CloudClient;
use markie_core::formats::FormatKind;
use markie_editor::RemoteCursor;
use markie_editor::collab::RichBinding;
use yrs::{Map as _, Transact as _};

use super::chrome::no_drag;
use super::{DocKind, Mode, OpenDoc, Workspace};
use crate::themes::{self, Palette, hex};

/// How long a claim may wait for the server (collab.ts `liveTiming`).
const CLAIM_TIMEOUT: Duration = Duration::from_secs(15);

/// A signed-in account on one server. The sign-in work makes these.
pub struct CloudAccount {
    pub client: Arc<CloudClient>,
    pub user: MarkieUser,
}

impl CloudAccount {
    /// The name peers see: the account's name, else its address.
    pub fn display_name(&self) -> String {
        view::who(self.user.name.as_deref(), &self.user.email)
    }
}

/// The cloud copy of a local document.
#[derive(Clone)]
#[allow(dead_code)] // `name` is for the sync work's Library rows.
pub struct CloudDoc {
    pub account: Arc<CloudAccount>,
    pub doc_id: String,
    pub name: String,
}

enum Room {
    Rich(RichBinding),
    Text(TextBinding),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Waiting for the first sync.
    Syncing,
    /// Synced; the settle delay before deciding to seed.
    Settling,
    /// Our claim (seed or update) is on its way; typing waits.
    Claiming,
    /// The room is the document.
    Ready,
    /// A viewer in an empty room: the synced copy stays on screen.
    ShowFile,
}

struct Live {
    session: LiveSession,
    room: Room,
    stage: Stage,
    readonly: bool,
    revoked: bool,
    /// The room can write the file back exactly (no raw HTML, comments,
    /// footnotes or other held-aside blocks).
    carries: bool,
    front_matter: bool,
    /// Peers' cursor JSON as last seen, and when it last moved.
    cursors: HashMap<u64, (Value, Value, Instant)>,
    last_sel: (u64, u64),
    /// Whether our caret is in the room's awareness now.
    published: bool,
    _pump: Task<()>,
    _timer: Option<Task<()>>,
    _observe: Option<Subscription>,
}

/// Everything collaboration keeps on the workspace.
#[derive(Default)]
pub(super) struct Collab {
    /// Cloud copies by local path, from the sync work (or the test session).
    docs: HashMap<PathBuf, CloudDoc>,
    /// The open document's cloud copy.
    pub cloud: Option<CloudDoc>,
    /// None: a local document with nothing to enforce.
    pub role: Option<ShareRoleState>,
    pub access: Option<ShareAccess>,
    pub members: usize,
    pub shared_by: Option<String>,
    live: Option<Live>,
    /// A line under the role banner: access removed, no session, join failed.
    pub note: Option<&'static str>,
    pub status: Option<LiveStatus>,
    pub peers: Vec<Peer>,
    /// The session ended in a way that keeps it off for this document.
    live_unavailable: bool,
    /// Whether the rich editor has focus (y-tiptap publishes the caret only
    /// then).
    rich_focused: bool,
    run: u64,
    /// Whether this module made Source read-only.
    source_locked: bool,
    _resolve: Option<Task<()>>,
    test_session_loaded: bool,
    /// Comment threads beside the document (comments.rs).
    pub comments: super::comments::Comments,
    /// The share sheet, while it is open (share.rs).
    pub share: Option<super::share::ShareSheet>,
    /// Share requests and accepted people (share.rs).
    #[allow(dead_code)]
    pub people: Option<super::share::PeopleState>,
}

/// `MARKIE_RS_TEST_SESSION`: `{origin, token, user: {id, name, email}, docs: {path: docId}}`.
/// Loopback origins only, so it can never point the app at a real server.
#[derive(serde::Deserialize)]
struct TestSession {
    origin: String,
    token: String,
    user: MarkieUser,
    #[serde(default)]
    docs: HashMap<String, String>,
}

fn random_client_id() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish() & 0xffff_ffff
}

/// `MARKIE_RS_COLLAB_DEBUG=1`: log the live session's steps to stderr.
fn debug(what: impl FnOnce() -> String) {
    if std::env::var("MARKIE_RS_COLLAB_DEBUG").is_ok_and(|v| v == "1") {
        eprintln!("markie-rs collab: {}", what());
    }
}

fn role_memory_key(path: &Path) -> String {
    format!("share_role:{}", path.to_string_lossy())
}

// The attach and status calls are the seam the cloud sync and sign-in work
// call into; nothing in this branch calls them outside the test session.
#[allow(dead_code)]
impl Workspace {
    // ------------------------------------------------------------ attach

    /// The sync work says `path` has a cloud copy. Re-checks access when it is
    /// the open document.
    pub fn attach_cloud_doc(&mut self, path: PathBuf, doc: CloudDoc, cx: &mut Context<Self>) {
        let open = self.doc.as_ref().is_some_and(|d| d.path == path);
        self.collab.docs.insert(path, doc);
        if open {
            self.collab_on_open(cx);
        }
    }

    /// The open document has no cloud copy any more (sync turned off).
    pub fn detach_cloud_doc(&mut self, path: &Path, cx: &mut Context<Self>) {
        self.collab.docs.remove(path);
        if self.doc.as_ref().is_some_and(|d| d.path == path) {
            self.collab_on_open(cx);
        }
    }

    /// Whether a live session is running for the open document. The sync work
    /// skips pushing the stored copy while it is (the desktop never writes it).
    pub fn live_active(&self) -> bool {
        self.collab.live.as_ref().is_some_and(|l| l.stage == Stage::Ready && !l.revoked)
    }

    fn load_test_session(&mut self, cx: &mut Context<Self>) {
        if self.collab.test_session_loaded {
            return;
        }
        self.collab.test_session_loaded = true;
        let Ok(file) = std::env::var("MARKIE_RS_TEST_SESSION") else { return };
        let Some(t) = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str::<TestSession>(&s).ok()) else {
            eprintln!("markie-rs: MARKIE_RS_TEST_SESSION is not a session file");
            return;
        };
        let local = url::Url::parse(&t.origin).ok().is_some_and(|u| matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")));
        if !local {
            eprintln!("markie-rs: the test session only works with a server on this computer");
            return;
        }
        let task = runtime::handle().spawn(async move {
            let mut store = markie_cloud::registry::ServerStore::open(None, true);
            let probe = store.probe(&markie_cloud::http::Transport::new(), &t.origin).await.ok()?;
            store.add(&probe.probe_id).ok()?;
            let tokens = Arc::new(markie_cloud::tokens::MemoryTokenStore::new());
            let client = CloudClient::new(&t.origin, store.trust_handle(), tokens, markie_cloud::http::Transport::new()).ok()?;
            client.set_token(Some(&t.token)).ok()?;
            // Keep the store alive with the client: it holds the trust list.
            std::mem::forget(store);
            Some((client, t.user, t.docs))
        });
        cx.spawn(async move |this, cx| {
            let Ok(Some((client, user, docs))) = task.await else { return };
            let account = Arc::new(CloudAccount { client: Arc::new(client), user });
            this.update(cx, |w, cx| {
                for (path, id) in docs {
                    let p = PathBuf::from(&path);
                    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    w.collab.docs.insert(p, CloudDoc { account: account.clone(), doc_id: id, name });
                }
                w.collab_on_open(cx);
            })
            .ok();
        })
        .detach();
    }

    // ------------------------------------------------------------ resolve

    /// A document was opened (or its cloud state changed): stop any session,
    /// then ask the server what this person may do with it.
    pub(super) fn collab_on_open(&mut self, cx: &mut Context<Self>) {
        self.load_test_session(cx);
        self.stop_live(cx);
        self.collab.role = None;
        self.collab.access = None;
        self.collab.members = 0;
        self.collab.shared_by = None;
        self.collab.note = None;
        self.collab.live_unavailable = false;
        self.comments_reset(cx);
        // An owner's pinned theme belongs to the document it came with.
        self.release_doc_theme(cx);
        self.collab_check(cx);
    }

    /// Ask the server again (membership changed in the share sheet). A live
    /// session for the same document keeps running unless the role changed.
    pub(super) fn collab_recheck(&mut self, cx: &mut Context<Self>) {
        self.collab_check(cx);
    }

    /// Sync turned on or off for `path` (cloud.rs). When it is the open
    /// document, ask the server at once, so a shared document goes live as
    /// soon as it has a cloud copy, as Electron's refreshCollab does.
    pub(super) fn collab_after_sync_change(&mut self, path: &Path, cx: &mut Context<Self>) {
        if self.doc.as_ref().is_some_and(|d| d.path == path) {
            debug(|| "sync changed: re-checking access".into());
            self.collab_recheck(cx);
        }
    }

    fn collab_check(&mut self, cx: &mut Context<Self>) {
        self.collab.run += 1;
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else { return };
        // The cloud copy: attached by the sync work or the test session, else
        // the sync binding (cloud.rs) with its signed-in scope.
        let source = self
            .collab
            .docs
            .get(&path)
            .map(|d| (d.account.client.clone(), d.doc_id.clone(), d.account.user.id.clone(), Some(d.account.user.clone())))
            .or_else(|| self.cloud.bound_scope(&path).map(|(scope, id)| (Arc::new(scope.client), id, scope.user, None)));
        let Some((client, doc_id, user_id, known_user)) = source else {
            // No cloud copy any more (sync turned off, or signed out): a plain
            // local file, with nothing to enforce and no live session.
            if self.collab.cloud.is_some() || self.collab.live.is_some() || self.collab.role.is_some() {
                self.stop_live(cx);
                self.collab.role = None;
                self.collab.access = None;
                self.collab.members = 0;
                self.collab.shared_by = None;
                self.collab.note = None;
                self.comments_reset(cx);
            }
            self.collab.cloud = None;
            self.apply_lock(cx);
            self.local_comments_open(cx);
            cx.notify();
            return;
        };
        // Read-only until the server answers (a recheck keeps the role it has).
        if self.collab.role.is_none() {
            self.collab.role = Some(ShareRoleState::Checking);
        }
        self.apply_lock(cx);
        let run = self.collab.run;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let task = runtime::handle().spawn(async move {
            let me = match known_user {
                Some(u) => Some(u),
                None => markie_cloud::auth::AuthClient::new(&client).me().await.ok().flatten(),
            };
            let shares = SharesClient::new(&client);
            let access = shares.access(&doc_id).await;
            let members = shares.list(&doc_id).await;
            (client, doc_id, me, access, members)
        });
        self.collab._resolve = Some(cx.spawn(async move |this, cx| {
            let Ok((client, doc_id, me, access, members)) = task.await else { return };
            this.update(cx, |w, cx| {
                if w.collab.run != run {
                    return;
                }
                w.collab.cloud = me.map(|user| CloudDoc { account: Arc::new(CloudAccount { client, user }), doc_id, name });
                w.collab_resolved(path, user_id, access.ok(), members.ok(), cx);
            })
            .ok();
        }));
        cx.notify();
    }

    fn collab_resolved(&mut self, path: PathBuf, me: String, access: Option<ShareAccess>, members: Option<Vec<markie_cloud::sharing::ShareMember>>, cx: &mut Context<Self>) {
        let (Some(access), Some(members)) = (access, members) else {
            // Unreachable: a role proved before for this account still counts.
            let remembered = self
                .registry
                .as_ref()
                .and_then(|r| r.setting(&role_memory_key(&path)).ok().flatten())
                .and_then(|v| {
                    let (role, user) = v.split_once('|')?;
                    (user == me).then(|| role.to_string())
                });
            self.collab.role = Some(match remembered.as_deref() {
                Some("owner") => ShareRoleState::Owner,
                Some("editor") => ShareRoleState::Editor,
                Some("viewer") => ShareRoleState::Viewer,
                _ => ShareRoleState::Unreachable,
            });
            self.apply_lock(cx);
            cx.notify();
            return;
        };
        // Members read with the owner's pinned theme (page.tsx getDocTheme).
        self.check_doc_theme(&members, &me, cx);
        let Some(cloud) = self.collab.cloud.clone() else { return };
        self.share_cloud_ready(cx);
        debug(|| format!("access {:?}, {} members", access.role, members.len()));
        let owner = (access.role == Role::Owner).then(|| me.clone());
        let role = role_for(Some(&members), Some(&me), owner.as_deref());
        if let Some(reg) = &self.registry {
            let word = match role {
                Role::Owner => "owner",
                Role::Editor => "editor",
                Role::Viewer => "viewer",
            };
            let _ = reg.set_setting(&role_memory_key(&path), &format!("{word}|{me}"));
        }
        self.collab.role = Some(ShareRoleState::from_role(role));
        self.collab.access = Some(access);
        self.collab.members = members.len();
        self.apply_lock(cx);
        let large = self.doc.as_ref().is_some_and(|d| d.large);
        let readonly = role == Role::Viewer;
        let want = !large && !self.collab.live_unavailable && !members.is_empty();
        let running = self.collab.live.as_ref().map(|l| (l.session.doc_id() == cloud.doc_id, l.readonly));
        match running {
            Some((true, ro)) if want && ro == readonly => {}
            _ => {
                self.stop_live(cx);
                if want {
                    self.start_live(cloud, readonly, cx);
                }
            }
        }
        cx.notify();
    }

    /// Whether the open document may be edited right now.
    pub(super) fn doc_editable(&self) -> bool {
        let role_ok = self.collab.role.is_none_or(view::can_edit_document);
        let live_ok = self.collab.live.as_ref().is_none_or(|l| !l.revoked && !l.readonly && l.stage == Stage::Ready);
        role_ok && live_ok
    }

    /// Lock or unlock the rich editor and set where undo goes.
    fn apply_lock(&mut self, cx: &mut Context<Self>) {
        let editable = self.doc_editable();
        let shared_undo = matches!(self.collab.live.as_ref().map(|l| &l.room), Some(Room::Rich(_))) && self.collab.live.as_ref().is_some_and(|l| l.stage == Stage::Ready);
        self.rich.update(cx, |r, cx| {
            if r.read_only == editable || r.collab_undo != shared_undo {
                r.read_only = !editable;
                r.collab_undo = shared_undo;
                cx.notify();
            }
        });
        // Source follows: read-only for a viewer or before the room is ready,
        // and a read-only mirror whenever a rich room is live (page.tsx).
        let rich_live = matches!(self.collab.live.as_ref().map(|l| &l.room), Some(Room::Rich(_)));
        let lock_source = !editable || rich_live;
        if lock_source != self.collab.source_locked {
            self.collab.source_locked = lock_source;
            self.editor.update(cx, |s, cx| s.set_readonly(lock_source, cx));
        }
    }

    // ------------------------------------------------------------ the session

    fn start_live(&mut self, cloud: CloudDoc, readonly: bool, cx: &mut Context<Self>) {
        let Some(OpenDoc { format, kind: DocKind::Text { .. }, .. }) = self.doc.as_ref() else { return };
        let rich = *format == FormatKind::Markdown;
        debug(|| format!("start live: rich {rich}, readonly {readonly}"));
        let doc = markie_rich::ydoc::new_doc(random_client_id());
        let display = cloud.account.display_name();
        let session = LiveSession::start(
            &runtime::handle(),
            cloud.account.client.origin(),
            &cloud.doc_id,
            doc.clone(),
            Arc::new(CloudTickets { client: cloud.account.client.clone(), doc_id: cloud.doc_id.clone() }),
            // The desktop never writes the stored copy (live-snapshot.ts).
            SessionOptions { user: PeerUser { name: display.clone(), color: color_for_name(&display).into() }, readonly, offer_snapshot_writer: false },
        );
        let (room, carries, front_matter) = if rich {
            let r = self.rich.read(cx);
            let carries = !r.editor.doc.blocks.iter().any(|b| b.is_opaque());
            let fm = !r.editor.doc.front_matter.is_empty();
            (Room::Rich(RichBinding::new(doc.clone())), carries, fm)
        } else {
            let text = doc.get_or_insert_text(TEXT_COLLAB_KEY);
            (Room::Text(TextBinding::new(&doc, text)), true, false)
        };
        let mut changes = session.subscribe();
        let pump = cx.spawn(async move |this, cx| {
            loop {
                if changes.changed().await.is_err() {
                    return;
                }
                if this.update(cx, |w, cx| w.live_tick(cx)).is_err() {
                    return;
                }
            }
        });
        let observe = rich.then(|| cx.observe(&self.rich, |w, _, cx| w.live_selection(cx)));
        self.collab.live = Some(Live {
            session,
            room,
            stage: Stage::Syncing,
            readonly,
            revoked: false,
            carries,
            front_matter,
            cursors: HashMap::new(),
            last_sel: (u64::MAX, u64::MAX),
            published: false,
            _pump: pump,
            _timer: None,
            _observe: observe,
        });
        self.collab.status = Some(LiveStatus::Connecting);
        self.apply_lock(cx);
    }

    fn stop_live(&mut self, cx: &mut Context<Self>) {
        if let Some(live) = self.collab.live.take() {
            live.session.close();
        }
        self.collab.status = None;
        self.collab.peers.clear();
        self.rich.update(cx, |r, cx| {
            r.remote.clear();
            r.collab_undo = false;
            cx.notify();
        });
    }

    /// Something changed in the room: apply it, move on through the stages,
    /// refresh presence.
    fn live_tick(&mut self, cx: &mut Context<Self>) {
        let Some(live) = self.collab.live.as_mut() else { return };
        // Updates first, on this thread, straight into the editor.
        if live.session.has_inbound() {
            match &mut live.room {
                Room::Rich(binding) => {
                    let caret = binding.caret(&self.rich.read(cx).editor);
                    live.session.pump();
                    binding.refresh();
                    if matches!(live.stage, Stage::Ready) {
                        let mut refused = false;
                        let mut changed = false;
                        self.rich.update(cx, |r, cx| match binding.pull(&mut r.editor, caret) {
                            Ok(true) => {
                                changed = true;
                                r.remote_changed(cx);
                            }
                            Ok(false) => {}
                            Err(_) => refused = true,
                        });
                        if refused {
                            return self.live_refuse(cx);
                        }
                        if changed {
                            self.on_rich_edit(cx);
                        }
                    }
                }
                Room::Text(binding) => {
                    live.session.pump();
                    if live.session.ever_synced() && !binding.synced() {
                        binding.mark_synced(live.session.doc());
                    }
                    if let Some(text) = binding.remote_changed(live.session.doc()) {
                        if matches!(live.stage, Stage::Ready) {
                            self.pending_editor_text = Some(text);
                        }
                    }
                }
            }
        }
        let Some(live) = self.collab.live.as_mut() else { return };
        let status = live.session.status();
        if self.collab.status != Some(status) {
            debug(|| format!("status {status:?}"));
        }
        self.collab.status = Some(status);
        match status {
            LiveStatus::Closed(CloseReason::AccessRevoked) => {
                if !live.revoked {
                    live.revoked = true;
                    self.collab.note = Some(view::ACCESS_REVOKED_LINE);
                    self.collab.peers.clear();
                    self.rich.update(cx, |r, _| r.remote.clear());
                    self.apply_lock(cx);
                }
                cx.notify();
                return;
            }
            LiveStatus::Closed(_) | LiveStatus::Unavailable => {
                // The room moved past this build, or no ticket came: back to
                // the local copy, which stays editable alone.
                self.collab.note = Some(view::LIVE_UNAVAILABLE_LINE);
                self.collab.live_unavailable = true;
                self.stop_live(cx);
                self.apply_lock(cx);
                cx.notify();
                return;
            }
            _ => {}
        }
        // Stages.
        match live.stage {
            Stage::Syncing if live.session.synced() => {
                live.stage = Stage::Settling;
                live._timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(SEED_SETTLE_MS)).await;
                    this.update(cx, |w, cx| w.live_decide(cx)).ok();
                }));
            }
            Stage::Claiming => {
                if let Room::Rich(b) = &live.room {
                    if b.has_model() {
                        self.live_ready(true, cx);
                    }
                }
            }
            _ => {}
        }
        self.live_presence(cx);
        cx.notify();
    }

    /// After the settle: seed, claim, take the room as it is, or refuse.
    fn live_decide(&mut self, cx: &mut Context<Self>) {
        let Some(live) = self.collab.live.as_mut() else { return };
        if live.stage != Stage::Settling {
            return;
        }
        debug(|| "deciding after the settle".into());
        let readonly = live.readonly;
        match &mut live.room {
            Room::Rich(binding) => {
                binding.refresh();
                if !binding.is_empty() {
                    // Can this build draw it, and does it need bringing up to date?
                    if binding.nodes().is_err() {
                        return self.live_refuse(cx);
                    }
                    if readonly || binding.has_model() {
                        return self.live_ready(true, cx);
                    }
                    // A room an older build seeded: claim it for this model as it is.
                    let want = binding.room();
                    let schema = binding.claim_schema(&want, live.front_matter);
                    let update = binding.claim_update(&want, &[(markie_editor::collab::MODEL_KEY, yrs::Any::from(markie_editor::collab::EDITOR_MODEL)), (markie_editor::collab::SCHEMA_KEY, yrs::Any::from(schema))]);
                    return self.live_claim(update, cx);
                }
                if readonly {
                    // A viewer is not an author: the synced copy stays on screen.
                    live.stage = Stage::ShowFile;
                    self.apply_lock(cx);
                    return;
                }
                let r = self.rich.read(cx);
                if r.editor.doc.nodes().is_empty() || r.markdown().trim().is_empty() {
                    return self.live_ready(false, cx);
                }
                let update = binding.seed_update(&r.editor, live.front_matter);
                self.live_claim(update, cx);
            }
            Room::Text(binding) => {
                let doc = live.session.doc().clone();
                if !binding.synced() {
                    binding.mark_synced(&doc);
                }
                if !binding.text().is_empty() {
                    let text = binding.text().to_string();
                    self.pending_editor_text = Some(text);
                    return self.live_ready(false, cx);
                }
                if readonly {
                    live.stage = Stage::ShowFile;
                    self.apply_lock(cx);
                    return;
                }
                let local = self.editor.read(cx).value().to_string();
                if !local.is_empty() {
                    let meta = doc.get_or_insert_map(META_MAP);
                    let mut txn = doc.transact_mut();
                    if binding.seed_if_empty(&mut txn, &local) {
                        meta.insert(&mut txn, SCHEMA_KEY, TEXT_ROOM_SCHEMA);
                        meta.insert(&mut txn, CONTENT_KIND_KEY, "text");
                    }
                }
                self.live_ready(false, cx);
            }
        }
    }

    fn live_claim(&mut self, update: Vec<u8>, cx: &mut Context<Self>) {
        debug(|| format!("claim: {} bytes", update.len()));
        let Some(live) = self.collab.live.as_mut() else { return };
        if !live.session.send_update(update) {
            return self.live_refuse(cx);
        }
        live.stage = Stage::Claiming;
        live._timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CLAIM_TIMEOUT).await;
            this.update(cx, |w, cx| {
                if w.collab.live.as_ref().is_some_and(|l| l.stage == Stage::Claiming) {
                    w.live_refuse(cx);
                }
            })
            .ok();
        }));
        self.apply_lock(cx);
        cx.notify();
    }

    /// The room is the document from here on.
    fn live_ready(&mut self, pull: bool, cx: &mut Context<Self>) {
        debug(|| format!("ready (pull {pull})"));
        let Some(live) = self.collab.live.as_mut() else { return };
        live.stage = Stage::Ready;
        live._timer = None;
        if pull {
            if let Room::Rich(binding) = &mut live.room {
                let mut changed = false;
                let mut refused = false;
                self.rich.update(cx, |r, cx| match binding.pull(&mut r.editor, None) {
                    Ok(c) => {
                        changed = c;
                        if c {
                            r.remote_changed(cx);
                        }
                    }
                    Err(_) => refused = true,
                });
                if refused {
                    return self.live_refuse(cx);
                }
                if changed {
                    self.on_rich_edit(cx);
                }
            }
        }
        self.apply_lock(cx);
        self.live_presence(cx);
        self.live_selection(cx);
        self.cloud_comments_open(cx);
        cx.notify();
    }

    /// No live session for this document after all: the local copy, alone.
    fn live_refuse(&mut self, cx: &mut Context<Self>) {
        debug(|| "refused: back to the local copy".into());
        self.collab.note = Some(view::LIVE_JOIN_FAILED_LINE);
        self.collab.live_unavailable = true;
        self.stop_live(cx);
        self.apply_lock(cx);
        cx.notify();
    }

    /// Peers for the title bar, and their carets for the editor.
    fn live_presence(&mut self, cx: &mut Context<Self>) {
        let Some(live) = self.collab.live.as_mut() else { return };
        let peers = live.session.peers();
        let now = Instant::now();
        let mut cursors = Vec::new();
        if let Room::Rich(binding) = &live.room {
            if live.stage == Stage::Ready {
                let ed = &self.rich.read(cx).editor;
                for p in &peers {
                    let Some(c) = &p.cursor else {
                        live.cursors.remove(&p.client_id);
                        continue;
                    };
                    let moved = match live.cursors.get(&p.client_id) {
                        Some((a, h, at)) if *a == c.anchor && *h == c.head => *at,
                        _ => now,
                    };
                    live.cursors.insert(p.client_id, (c.anchor.clone(), c.head.clone(), moved));
                    if let Some((anchor, head)) = binding.resolve_cursor(ed, &c.anchor, &c.head) {
                        cursors.push(RemoteCursor { client: p.client_id, name: p.user.name.clone().into(), color: hex(&p.user.color), anchor, head, moved_at: moved });
                    }
                }
            }
        }
        self.collab.peers = peers;
        self.rich.update(cx, |r, cx| {
            r.remote = cursors;
            cx.notify();
        });
    }

    /// Publish our caret when it moves, and only while the editor has focus;
    /// without focus, take it out of awareness (y-tiptap's
    /// `updateCursorInfo`, run on every update and on focusin/focusout).
    fn live_selection(&mut self, cx: &mut Context<Self>) {
        let focused = self.collab.rich_focused;
        let Some(live) = self.collab.live.as_mut() else { return };
        if live.stage != Stage::Ready || live.revoked {
            return;
        }
        let Room::Rich(binding) = &live.room else { return };
        if !focused {
            if live.published {
                live.published = false;
                live.last_sel = (u64::MAX, u64::MAX);
                live.session.set_cursor(None);
            }
            return;
        }
        let ed = &self.rich.read(cx).editor;
        let key = (ed.sel_version, ed.version);
        if key == live.last_sel && live.published {
            return;
        }
        live.last_sel = key;
        live.published = true;
        live.session.set_cursor(binding.cursor_for(ed));
    }

    /// Follow the rich editor's focus, for `live_selection`.
    pub(super) fn watch_rich_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<Subscription> {
        let handle = self.rich.read(cx).focus_handle().clone();
        self.collab.rich_focused = handle.contains_focused(window, cx);
        vec![
            cx.on_focus_in(&handle, window, |this, _, cx| {
                this.collab.rich_focused = true;
                this.live_selection(cx);
            }),
            cx.on_focus_out(&handle, window, |this, _, _, cx| {
                this.collab.rich_focused = false;
                this.live_selection(cx);
            }),
        ]
    }

    /// A local edit in the rich editor: into the room, as the smallest change.
    pub(super) fn live_local_edit(&mut self, cx: &mut Context<Self>) {
        let Some(live) = self.collab.live.as_mut() else { return };
        if live.stage != Stage::Ready || live.revoked || live.readonly {
            return;
        }
        if let Room::Rich(binding) = &mut live.room {
            binding.push(&self.rich.read(cx).editor);
        }
    }

    /// A local edit in Source on a live plain-text document.
    pub(super) fn live_source_edit(&mut self, cx: &mut Context<Self>) {
        let Some(live) = self.collab.live.as_mut() else { return };
        if live.stage != Stage::Ready || live.revoked || live.readonly {
            return;
        }
        if let Room::Text(binding) = &mut live.room {
            let text = self.editor.read(cx).value().to_string();
            if let Some(merged) = binding.apply_local(live.session.doc(), &text) {
                if merged != text {
                    self.pending_editor_text = Some(merged);
                    cx.notify();
                }
            }
        }
    }

    /// ⌘Z and ⌘⇧Z in a live rich document: the room's own undo, which takes
    /// back only this person's edits.
    pub(super) fn live_undo(&mut self, redo: bool, cx: &mut Context<Self>) {
        let Some(live) = self.collab.live.as_mut() else { return };
        if live.stage != Stage::Ready || live.revoked || live.readonly {
            return;
        }
        let Room::Rich(binding) = &mut live.room else { return };
        let mut did = false;
        self.rich.update(cx, |r, cx| {
            did = if redo { binding.redo(&mut r.editor) } else { binding.undo(&mut r.editor) };
            if did {
                r.remote_changed(cx);
            }
        });
        if did {
            self.on_rich_edit(cx);
        }
    }

    /// While live, the file is written from the room only when the room can
    /// carry it exactly (live-room-carry.ts).
    pub(super) fn live_holds_file(&self) -> bool {
        self.collab.live.as_ref().is_some_and(|l| l.stage == Stage::Ready && !l.carries)
    }

    /// The rich room's binding and editor, for the comment layer.
    pub(super) fn live_rich_binding(&self) -> Option<&RichBinding> {
        match self.collab.live.as_ref() {
            Some(Live { room: Room::Rich(b), stage: Stage::Ready, .. }) => Some(b),
            _ => None,
        }
    }

    /// Whether the open document has a cloud copy this window can reach.
    pub(super) fn has_cloud_copy(&self) -> bool {
        let Some(path) = self.doc.as_ref().map(|d| &d.path) else { return false };
        self.collab.cloud.is_some() || self.collab.docs.contains_key(path) || self.cloud.bound_scope(path).is_some()
    }

    pub(super) fn live_running(&self) -> bool {
        self.collab.live.is_some()
    }

    // ------------------------------------------------------------ render

    /// The live dot and peers' avatars in the title bar (toolbar.tsx).
    pub(super) fn render_presence(&self, p: &Palette) -> Option<AnyElement> {
        let live = self.collab.live.is_some();
        let peers = &self.collab.peers;
        if !live && peers.is_empty() {
            return None;
        }
        let status = self.collab.status.unwrap_or(LiveStatus::Connecting);
        let dot = match status {
            LiveStatus::Connected => hex("#34d399"),
            LiveStatus::Connecting => hex("#fbbf24"),
            _ => hex("#71717a"),
        };
        let ring = p.surface;
        Some(
            h_flex()
                .gap(px(8.))
                .when(live, |el| {
                    el.child(
                        no_drag(div().id("tb-live"))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .tooltip({
                                let label = format!("Live session: {}", status.label());
                                move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx)
                            })
                            .child(div().size(px(6.)).rounded_full().bg(dot))
                            .child(div().text_size(px(10.)).text_color(p.muted).child("LIVE")),
                    )
                })
                .when(!peers.is_empty(), |el| {
                    el.child(
                        h_flex()
                            .children(peers.iter().take(4).enumerate().map(|(i, peer)| {
                                avatar(&peer.user.name, hex(&peer.user.color), ring, 20., 8.)
                                    .id(SharedString::from(format!("peer-{}", peer.client_id)))
                                    .when(i > 0, |el| el.ml(px(-6.)))
                                    .tooltip({
                                        let name = peer.user.name.clone();
                                        move |window, cx| gpui_kit::component::tooltip::Tooltip::new(name.clone()).build(window, cx)
                                    })
                            }))
                            .when(peers.len() > 4, |el| {
                                el.child(
                                    div()
                                        .ml(px(-6.))
                                        .size(px(20.))
                                        .rounded_full()
                                        .border_2()
                                        .border_color(ring)
                                        .bg(p.accent)
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(px(8.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(p.foreground)
                                        .child(format!("+{}", peers.len() - 4)),
                                )
                            }),
                    )
                })
                .into_any_element(),
        )
    }

    /// The strip above the document: the role line (share-banner.tsx), and
    /// the live session's notes under it.
    pub(super) fn render_live_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = themes::palette(cx);
        let role_view = self.collab.role.and_then(|r| share_banner_for(r, self.collab.shared_by.as_deref()));
        let file_note = self.live_holds_file() && self.mode == Mode::View;
        let source_note = self.collab.live.as_ref().is_some_and(|l| matches!(l.room, Room::Rich(_))) && self.mode == Mode::Source;
        let note = self.collab.note;
        if role_view.is_none() && note.is_none() && !file_note && !source_note {
            return None;
        }
        let bar = || div().flex_none().w_full().bg(p.surface).border_b_1().border_color(p.border).px(px(12.)).py(px(6.));
        let mut col = gpui_kit::component::v_flex().w_full();
        if let Some((kind, message)) = role_view {
            col = col.child(
                bar().child(
                    h_flex()
                        .gap(px(8.))
                        .when(kind == BannerKind::ViewOnly, |el| el.child(div().text_size(px(12.)).child("👁")))
                        .child(div().min_w_0().truncate().text_size(px(11.)).text_color(p.muted).child(message))
                        .when(kind == BannerKind::ViewOnly, |el| {
                            el.child(
                                no_drag(div().id("make-copy"))
                                    .ml_auto()
                                    .flex_none()
                                    .rounded(px(4.))
                                    .border_1()
                                    .border_color(p.border)
                                    .px(px(8.))
                                    .py(px(2.))
                                    .text_size(px(11.))
                                    .text_color(p.muted)
                                    .hover(|s| s.text_color(p.foreground))
                                    .cursor_pointer()
                                    .child("Make a copy")
                                    .on_click(cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(crate::actions::DuplicateDocument), cx))),
                            )
                        }),
                ),
            );
        }
        for line in [note, file_note.then_some(view::LIVE_FILE_REFUSAL_NOTE), source_note.then_some(view::LIVE_SOURCE_LINE)].into_iter().flatten() {
            let red = line == view::ACCESS_REVOKED_LINE;
            col = col.child(bar().py(px(4.)).text_size(px(11.)).text_color(if red { p.red } else { p.muted }).child(line));
        }
        Some(col.into_any_element())
    }
}

/// A round avatar with initials, like the peers' and the share dialog's.
pub(super) fn avatar(name: &str, color: Hsla, ring: Hsla, size: f32, font: f32) -> Div {
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .border_2()
        .border_color(ring)
        .bg(color)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(font))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(hsla(0., 0., 0., 0.8))
        .child(initials(name))
}
