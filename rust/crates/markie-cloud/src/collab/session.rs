//! A live room over y-websocket that keeps going: the room supervisor.
//!
//! This is the part of y-websocket's `WebsocketProvider` and of
//! `connectWithTicket` (src/lib/collab.ts) that the web client relies on,
//! for both room kinds (the rich `XmlFragment("default")` and the plain
//! `Text("content")`):
//!
//! * The first ticket is asked for with three quick retries on a transient
//!   failure. A refusal means no session ("unavailable"). Only a server from
//!   before tickets (no such route) gets the session token on the socket, as
//!   `connectWithTicket` does for it, and nothing else ever does.
//! * The ticket is refreshed in place every two minutes, and on a close when
//!   the last ask is older than 30 s. A 4000-4999 close stops the refreshes.
//! * A dropped socket reconnects with y-websocket's backoff,
//!   `min(2^n * 100, 2500)` ms, where `n` counts closes since the last sync.
//! * A 4400-4499 close is final (y-websocket's default `shouldReconnect`):
//!   4403 means access was revoked, 4426 that the room needs a newer client.
//! * No message for 30 s closes the socket; presence is renewed every 15 s
//!   and peers not heard from for 30 s are dropped, as y-protocols does.
//!
//! Remote document updates are not applied on the network thread. They wait
//! in an inbox until the owner calls [`LiveSession::pump`], on the thread
//! that owns the editor. That keeps the editor and the Yjs document in step:
//! nothing can change the room between the editor's last look and its next
//! local edit, which is the guarantee ProseMirror's synchronous binding gives
//! the web app.
use crate::client::CloudClient;
use crate::collab::room::CloseReason;
use crate::collab::ticket::{FirstTicket, OnClose, TICKET_REFRESH_MS, first_ticket, is_transient, on_close};
use crate::collab::{PeerUser, collab_ws_base, legacy_room_url, room_url};
use crate::collab::snapshot::SNAPSHOT_WRITER_FIELD;
use crate::sharing::{CollabTicketAnswer, SharesClient};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map as JsonMap, Value, json};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as Ws;
use yrs::sync::{Awareness, Message, SyncMessage};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, Origin, ReadTxn, Transact, Update};

/// The transaction origin of every update that came from the room.
pub const REMOTE_ORIGIN: &str = "markie-remote";
const OBSERVER_KEY: &str = "markie-live-session";
/// y-websocket's `maxBackoffTime`.
pub const MAX_BACKOFF_MS: u64 = 2500;
/// y-websocket's `messageReconnectTimeout`.
pub const MESSAGE_RECONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// y-protocols renews the local presence at half its 30 s timeout.
pub const AWARENESS_RENEW: Duration = Duration::from_secs(15);
/// y-protocols' `outdatedTimeout`.
pub const AWARENESS_OUTDATED_MS: u64 = 30_000;
/// The awareness field y-prosemirror's cursor plugin writes.
pub const CURSOR_FIELD: &str = "cursor";

/// The wait before reconnect number `unsuccessful` (closes since the last sync).
pub fn backoff_ms(unsuccessful: u32) -> u64 {
    let n = unsuccessful.min(16);
    (100u64 << n).min(MAX_BACKOFF_MS)
}

/// y-websocket's default `shouldReconnect`: 4400-4499 is the server's final answer.
pub fn is_terminal_close(code: u16) -> bool {
    (4400..4500).contains(&code)
}

/// What the toolbar shows ("connecting", "connected", "disconnected"), plus
/// the two ends a session can come to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveStatus {
    Connecting,
    Connected,
    Disconnected,
    /// No ticket could be had: the session never started.
    Unavailable,
    /// The server closed the room for good.
    Closed(CloseReason),
}

impl LiveStatus {
    /// The word Electron's toolbar puts after "Live:".
    pub fn label(self) -> &'static str {
        match self {
            LiveStatus::Connecting => "connecting",
            LiveStatus::Connected => "connected",
            LiveStatus::Disconnected | LiveStatus::Closed(_) => "disconnected",
            LiveStatus::Unavailable => "unavailable",
        }
    }
    pub fn is_final(self) -> bool {
        matches!(self, LiveStatus::Unavailable | LiveStatus::Closed(_))
    }
}

/// A remote selection as y-prosemirror publishes it: two Y.RelativePosition
/// objects, kept as JSON. Resolving them needs the room's structure, which is
/// the editor binding's business.
#[derive(Debug, Clone, PartialEq)]
pub struct PeerCursor {
    pub anchor: Value,
    pub head: Value,
}

/// Someone else in the room.
#[derive(Debug, Clone, PartialEq)]
pub struct Peer {
    pub client_id: u64,
    pub user: PeerUser,
    pub cursor: Option<PeerCursor>,
}

/// Read one awareness state the way the web client does: a peer needs a
/// name (toolbar.tsx filters on it); a missing colour is y-prosemirror's
/// `#ffa500`.
pub fn parse_peer(client_id: u64, state: &Value) -> Option<Peer> {
    let user = state.get("user")?;
    let name = user.get("name")?.as_str()?.to_string();
    if name.is_empty() {
        return None;
    }
    let color = user.get("color").and_then(Value::as_str).unwrap_or("#ffa500").to_string();
    let cursor = state.get(CURSOR_FIELD).and_then(|c| {
        let anchor = c.get("anchor")?.clone();
        let head = c.get("head")?.clone();
        (!anchor.is_null() && !head.is_null()).then_some(PeerCursor { anchor, head })
    });
    Some(Peer { client_id, user: PeerUser { name, color }, cursor })
}

/// Asks the document's server for a live-editing pass.
pub trait TicketSource: Send + Sync + 'static {
    fn ticket(&self) -> Pin<Box<dyn Future<Output = CollabTicketAnswer> + Send + '_>>;
    /// The session token, for a server that answered "no such route" to the
    /// ticket request (`CollabTicketAnswer::Legacy`). Its socket can only take
    /// the token, exactly as every build did before tickets.
    fn legacy_token(&self) -> Option<String> {
        None
    }
}

/// Tickets from the document's own server, with that server's session.
pub struct CloudTickets {
    pub client: Arc<CloudClient>,
    pub doc_id: String,
}

impl TicketSource for CloudTickets {
    fn ticket(&self) -> Pin<Box<dyn Future<Output = CollabTicketAnswer> + Send + '_>> {
        Box::pin(async move { SharesClient::new(&self.client).collab_ticket(&self.doc_id).await })
    }
    fn legacy_token(&self) -> Option<String> {
        self.client.token()
    }
}

#[derive(Debug, Clone)]
pub struct SessionOptions {
    pub user: PeerUser,
    /// Viewer: presence yes, edits no.
    pub readonly: bool,
    /// Offer to write the stored copy back over REST.
    pub offer_snapshot_writer: bool,
}

/// What [`LiveSession::pump`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pumped {
    /// Updates applied to the document.
    pub applied: usize,
    /// This pump completed the first sync of a connection.
    pub synced: bool,
}

struct Inbound {
    bytes: Vec<u8>,
    step2: bool,
    /// The connection it came on: a step 2 pumped after its socket closed
    /// does not make the next connection "synced".
    conn: u32,
}

struct State {
    status: LiveStatus,
    /// The current connection has synced.
    synced: bool,
    /// Any connection has synced.
    ever_synced: bool,
    unsuccessful: u32,
    ticket: Option<String>,
    asked_at: Option<Instant>,
    halted: bool,
    refreshing: bool,
    stopped: bool,
    /// Every status the session went through, for tests and the evidence log.
    history: Vec<LiveStatus>,
    connects: u32,
}

type Out = Arc<Mutex<Option<mpsc::UnboundedSender<Ws>>>>;

struct Shared {
    doc: Doc,
    awareness: Mutex<Awareness>,
    local: Mutex<JsonMap<String, Value>>,
    inbox: Mutex<VecDeque<Inbound>>,
    state: Mutex<State>,
    out: Out,
    changes: watch::Sender<u64>,
    stop: watch::Sender<bool>,
    tickets: Arc<dyn TicketSource>,
    ws_base: String,
    doc_id: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Shared {
    fn bump(&self) {
        self.changes.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn set_status(&self, s: LiveStatus) {
        {
            let mut st = self.state.lock().unwrap();
            if st.status == s {
                return;
            }
            st.status = s;
            st.history.push(s);
        }
        self.bump();
    }

    fn stopped(&self) -> bool {
        self.state.lock().unwrap().stopped
    }

    fn send(&self, msg: Message) {
        if let Some(tx) = self.out.lock().unwrap().as_ref() {
            let _ = tx.send(Ws::Binary(msg.encode_v1().into()));
        }
    }

    fn local_awareness(&self) -> Option<Message> {
        let a = self.awareness.lock().unwrap();
        let id = a.client_id();
        a.update_with_clients([id]).ok().map(Message::Awareness)
    }

    fn push_local_state(&self) {
        let state = Value::Object(self.local.lock().unwrap().clone());
        {
            let mut a = self.awareness.lock().unwrap();
            let _ = a.set_local_state(state);
        }
        if let Some(m) = self.local_awareness() {
            self.send(m);
        }
        self.bump();
    }

    fn handle(&self, bytes: &[u8]) {
        let Ok(msg) = Message::decode_v1(bytes) else { return };
        match msg {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                let update = self.doc.transact().encode_state_as_update_v1(&sv);
                self.send(Message::Sync(SyncMessage::SyncStep2(update)));
            }
            Message::Sync(SyncMessage::SyncStep2(u)) => {
                let conn = self.state.lock().unwrap().connects;
                self.inbox.lock().unwrap().push_back(Inbound { bytes: u, step2: true, conn });
                self.bump();
            }
            Message::Sync(SyncMessage::Update(u)) => {
                let conn = self.state.lock().unwrap().connects;
                self.inbox.lock().unwrap().push_back(Inbound { bytes: u, step2: false, conn });
                self.bump();
            }
            Message::Awareness(update) => {
                let _ = self.awareness.lock().unwrap().apply_update(update);
                self.bump();
            }
            Message::AwarenessQuery => {
                if let Some(m) = self.local_awareness() {
                    self.send(m);
                }
            }
            Message::Auth(_) | Message::Custom(..) => {}
        }
    }

    /// Everyone but us leaves when the socket drops (y-websocket does the same).
    fn drop_remote_presence(&self) {
        let mut a = self.awareness.lock().unwrap();
        let own = a.client_id();
        let others: Vec<_> = a.iter().map(|(id, _)| id).filter(|id| *id != own).collect();
        for id in others {
            a.remove_state(id);
        }
    }

    fn sweep_outdated(&self) -> bool {
        let mut a = self.awareness.lock().unwrap();
        let own = a.client_id();
        let now = now_ms();
        let stale: Vec<_> = a
            .iter()
            .map(|(id, _)| id)
            .filter(|id| *id != own)
            .filter(|id| a.meta(*id).is_some_and(|(_, at)| now.saturating_sub(at) >= AWARENESS_OUTDATED_MS))
            .collect();
        let any = !stale.is_empty();
        for id in stale {
            a.remove_state(id);
        }
        any
    }

    async fn ask(&self) -> CollabTicketAnswer {
        self.state.lock().unwrap().asked_at = Some(Instant::now());
        self.tickets.ticket().await
    }

    /// `refresh` in connectWithTicket: a ticket replaces the one held, a
    /// transient failure keeps it, anything else stops asking.
    async fn refresh(&self) {
        {
            let mut st = self.state.lock().unwrap();
            if st.stopped || st.halted || st.refreshing {
                return;
            }
            st.refreshing = true;
        }
        let answer = self.ask().await;
        let mut st = self.state.lock().unwrap();
        st.refreshing = false;
        if st.stopped || st.halted {
            return;
        }
        match answer {
            CollabTicketAnswer::Ticket { ticket, .. } => st.ticket = Some(ticket),
            a if is_transient(&a) => {}
            _ => st.halted = true,
        }
    }
}

/// One live room. Dropping it closes the socket and stops the supervisor.
pub struct LiveSession {
    shared: Arc<Shared>,
    tasks: Vec<JoinHandle<()>>,
}

impl LiveSession {
    /// Start the supervisor for `doc_id` on `origin`, on `rt`. `doc` is the
    /// room's document; it outlives reconnects, as y-websocket's does.
    pub fn start(rt: &tokio::runtime::Handle, origin: &str, doc_id: &str, doc: Doc, tickets: Arc<dyn TicketSource>, opts: SessionOptions) -> LiveSession {
        let out: Out = Arc::new(Mutex::new(None));
        let mut local = JsonMap::new();
        local.insert("user".into(), json!(opts.user));
        // useLiveRoom only sets the field on a client that offers to write;
        // the desktop (offer: false) never puts it in its presence at all.
        if opts.offer_snapshot_writer {
            local.insert(SNAPSHOT_WRITER_FIELD.into(), Value::Bool(true));
        }
        let mut awareness = Awareness::new(doc.clone());
        let _ = awareness.set_local_state(Value::Object(local.clone()));
        let (changes, _) = watch::channel(0u64);
        let (stop, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            doc: doc.clone(),
            awareness: Mutex::new(awareness),
            local: Mutex::new(local),
            inbox: Mutex::new(VecDeque::new()),
            state: Mutex::new(State {
                status: LiveStatus::Connecting,
                synced: false,
                ever_synced: false,
                unsuccessful: 0,
                ticket: None,
                asked_at: None,
                halted: false,
                refreshing: false,
                stopped: false,
                history: vec![LiveStatus::Connecting],
                connects: 0,
            }),
            out: out.clone(),
            changes,
            stop,
            tickets,
            ws_base: collab_ws_base(origin),
            doc_id: doc_id.to_string(),
        });

        // Every local transaction goes out as an update while connected;
        // remote ones never echo. Offline edits reach the room through the
        // sync handshake of the next connection.
        let remote = Origin::from(REMOTE_ORIGIN);
        let tx_out = out.clone();
        let _ = doc.observe_update_v1(OBSERVER_KEY, move |txn, e| {
            if txn.origin() == Some(&remote) {
                return;
            }
            if let Some(tx) = tx_out.lock().unwrap().as_ref() {
                let _ = tx.send(Ws::Binary(Message::Sync(SyncMessage::Update(e.update.clone())).encode_v1().into()));
            }
        });

        let s = shared.clone();
        let supervisor = rt.spawn(async move { supervise(s).await });
        let s = shared.clone();
        let refresher = rt.spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(TICKET_REFRESH_MS));
            tick.tick().await;
            loop {
                tick.tick().await;
                if s.stopped() {
                    return;
                }
                if s.state.lock().unwrap().ticket.is_some() {
                    s.refresh().await;
                }
            }
        });
        LiveSession { shared, tasks: vec![supervisor, refresher] }
    }

    pub fn doc(&self) -> &Doc {
        &self.shared.doc
    }

    pub fn doc_id(&self) -> &str {
        &self.shared.doc_id
    }

    pub fn status(&self) -> LiveStatus {
        self.shared.state.lock().unwrap().status
    }

    /// The current connection has synced (the provider's `synced`).
    pub fn synced(&self) -> bool {
        self.shared.state.lock().unwrap().synced
    }

    pub fn ever_synced(&self) -> bool {
        self.shared.state.lock().unwrap().ever_synced
    }

    /// Statuses in order, and how many sockets were opened.
    pub fn history(&self) -> (Vec<LiveStatus>, u32) {
        let st = self.shared.state.lock().unwrap();
        (st.history.clone(), st.connects)
    }

    /// Whether the ticket refresh loop stopped asking.
    pub fn ticket_halted(&self) -> bool {
        self.shared.state.lock().unwrap().halted
    }

    /// Wakes on every change: an update waiting, presence, status.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.shared.changes.subscribe()
    }

    /// Whether updates are waiting for [`LiveSession::pump`].
    pub fn has_inbound(&self) -> bool {
        !self.shared.inbox.lock().unwrap().is_empty()
    }

    /// Apply waiting room updates on the calling thread, origin
    /// [`REMOTE_ORIGIN`]. Call it from the thread that owns the editor, then
    /// read the room into the editor.
    pub fn pump(&self) -> Pumped {
        let items: Vec<Inbound> = self.shared.inbox.lock().unwrap().drain(..).collect();
        let mut out = Pumped::default();
        for item in items {
            if let Ok(u) = Update::decode_v1(&item.bytes) {
                let mut txn = self.shared.doc.transact_mut_with(REMOTE_ORIGIN);
                if txn.apply_update(u).is_ok() {
                    out.applied += 1;
                }
            }
            if item.step2 {
                let open = self.shared.out.lock().unwrap().is_some();
                let mut st = self.shared.state.lock().unwrap();
                if !st.synced && open && item.conn == st.connects {
                    st.synced = true;
                    st.ever_synced = true;
                    // A connection that synced did useful work.
                    st.unsuccessful = 0;
                    out.synced = true;
                }
            }
        }
        out
    }

    /// Send an update without applying it here: a seed or a migration that
    /// the server takes from one client only. The room changes for this
    /// client when the server sends it (or the winner's) back.
    pub fn send_update(&self, update: Vec<u8>) -> bool {
        let guard = self.shared.out.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => tx.send(Ws::Binary(Message::Sync(SyncMessage::Update(update)).encode_v1().into())).is_ok(),
            None => false,
        }
    }

    /// Whether a socket is open right now.
    pub fn connected(&self) -> bool {
        self.shared.out.lock().unwrap().is_some()
    }

    /// Other people in the room, in client-id order.
    pub fn peers(&self) -> Vec<Peer> {
        let a = self.shared.awareness.lock().unwrap();
        let own = a.client_id();
        let mut v: Vec<Peer> = a
            .iter()
            .filter(|(id, _)| *id != own)
            .filter_map(|(id, state)| {
                let data = state.data?;
                let v: Value = serde_json::from_str(&data).ok()?;
                parse_peer(id.get(), &v)
            })
            .collect();
        v.sort_by_key(|p| p.client_id);
        v
    }

    /// Every awareness state with a body, ours included, as JSON.
    pub fn states(&self) -> Vec<(u64, Value)> {
        let a = self.shared.awareness.lock().unwrap();
        a.iter()
            .filter_map(|(id, state)| {
                let data = state.data?;
                serde_json::from_str::<Value>(&data).ok().map(|v| (id.get(), v))
            })
            .collect()
    }

    pub fn client_id(&self) -> u64 {
        self.shared.awareness.lock().unwrap().client_id().get()
    }

    /// Set one field of our presence (`cursor`, `user`) and publish it.
    pub fn set_local_field(&self, key: &str, value: Value) {
        {
            let mut l = self.shared.local.lock().unwrap();
            if l.get(key) == Some(&value) {
                return;
            }
            l.insert(key.to_string(), value);
        }
        self.shared.push_local_state();
    }

    /// Our cursor as two relative positions, or none (the editor lost focus).
    pub fn set_cursor(&self, cursor: Option<(Value, Value)>) {
        let v = match cursor {
            Some((anchor, head)) => json!({ "anchor": anchor, "head": head }),
            None => Value::Null,
        };
        self.set_local_field(CURSOR_FIELD, v);
    }

    /// Wait until `pred` holds, pumping on every change. For tests and the
    /// headless interop client; the app pumps from its own loop.
    pub async fn wait_for(&self, timeout: Duration, mut pred: impl FnMut(&LiveSession) -> bool) -> bool {
        let mut rx = self.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            self.pump();
            if pred(self) {
                return true;
            }
            if tokio::time::timeout_at(deadline, rx.changed()).await.is_err() {
                self.pump();
                return pred(self);
            }
        }
    }

    /// Leave: clear our presence, close the socket, stop the supervisor.
    pub fn close(&self) {
        {
            let mut st = self.shared.state.lock().unwrap();
            if st.stopped {
                return;
            }
            st.stopped = true;
        }
        {
            let mut a = self.shared.awareness.lock().unwrap();
            a.clean_local_state();
        }
        if let Some(m) = self.shared.local_awareness() {
            self.shared.send(m);
        }
        let _ = self.shared.stop.send(true);
        let _ = self.shared.doc.unobserve_update_v1(OBSERVER_KEY);
    }

    /// Close and wait (briefly) for the socket to say goodbye.
    pub async fn shutdown(mut self) {
        self.close();
        for t in self.tasks.drain(..) {
            let abort = t.abort_handle();
            if tokio::time::timeout(Duration::from_secs(2), t).await.is_err() {
                abort.abort();
            }
        }
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.close();
        for t in &self.tasks {
            t.abort();
        }
    }
}

async fn sleep_or_stop(shared: &Shared, d: Duration) -> bool {
    let mut stop = shared.stop.subscribe();
    if *stop.borrow() {
        return false;
    }
    tokio::select! {
        _ = tokio::time::sleep(d) => true,
        _ = stop.changed() => false,
    }
}

/// What the socket is opened with.
enum Pass {
    Ticket(String),
    /// A server from before tickets: the session token (`?token=`).
    Token(String),
}

async fn supervise(shared: Arc<Shared>) {
    // The first pass, with quick retries on a blip.
    let mut attempt = 0;
    let ticket = loop {
        let answer = shared.ask().await;
        if shared.stopped() {
            return;
        }
        match first_ticket(&answer, attempt) {
            FirstTicket::Connect(t) => break Pass::Ticket(t),
            FirstTicket::RetryAfterMs(ms) => {
                if !sleep_or_stop(&shared, Duration::from_millis(ms)).await {
                    return;
                }
                attempt += 1;
            }
            FirstTicket::Legacy => match shared.tickets.legacy_token() {
                // LEGACY: only a server that answered "no such route" gets
                // here, and it can only take the session token. Nothing
                // refreshes it: the token is the pass.
                Some(token) => break Pass::Token(token),
                None => {
                    shared.set_status(LiveStatus::Unavailable);
                    return;
                }
            },
            FirstTicket::Unavailable => {
                shared.set_status(LiveStatus::Unavailable);
                return;
            }
        }
    };
    let legacy = match ticket {
        Pass::Ticket(t) => {
            shared.state.lock().unwrap().ticket = Some(t);
            None
        }
        Pass::Token(t) => Some(t),
    };

    loop {
        if shared.stopped() {
            return;
        }
        shared.set_status(LiveStatus::Connecting);
        let url = match &legacy {
            Some(token) => legacy_room_url(&shared.ws_base, &shared.doc_id, token),
            None => {
                let st = shared.state.lock().unwrap();
                room_url(&shared.ws_base, &shared.doc_id, st.ticket.as_deref().unwrap_or(""))
            }
        };
        let code = run_socket(&shared, &url).await;
        if shared.stopped() {
            return;
        }
        let unsuccessful = {
            let mut st = shared.state.lock().unwrap();
            st.synced = false;
            st.unsuccessful += 1;
            st.unsuccessful
        };
        shared.drop_remote_presence();
        if let Some(c) = code.filter(|c| is_terminal_close(*c)) {
            shared.state.lock().unwrap().halted = true;
            shared.set_status(LiveStatus::Closed(CloseReason::from_code(c)));
            return;
        }
        shared.set_status(LiveStatus::Disconnected);
        let since = shared.state.lock().unwrap().asked_at.map(|t| t.elapsed().as_millis() as u64).unwrap_or(u64::MAX);
        // A legacy socket has no ticket loop listening for closes.
        match if legacy.is_some() { OnClose::Keep } else { on_close(code, since) } {
            OnClose::Halt => shared.state.lock().unwrap().halted = true,
            OnClose::Refresh => shared.refresh().await,
            OnClose::Keep => {}
        }
        if !sleep_or_stop(&shared, Duration::from_millis(backoff_ms(unsuccessful))).await {
            return;
        }
    }
}

/// One socket, from open to close. Returns the close code, or None when the
/// connection failed or dropped without one.
async fn run_socket(shared: &Arc<Shared>, url: &str) -> Option<u16> {
    let mut stop = shared.stop.subscribe();
    let ws = tokio::select! {
        r = tokio_tungstenite::connect_async(url) => match r {
            Ok((ws, _)) => ws,
            Err(_) => return None,
        },
        _ = stop.changed() => return None,
    };
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Ws>();
    *shared.out.lock().unwrap() = Some(tx);
    shared.state.lock().unwrap().connects += 1;
    shared.set_status(LiveStatus::Connected);

    // Always open with our state vector, then our presence.
    let sv = shared.doc.transact().state_vector();
    shared.send(Message::Sync(SyncMessage::SyncStep1(sv)));
    if let Some(m) = shared.local_awareness() {
        shared.send(m);
    }

    let mut last = Instant::now();
    let mut renew = tokio::time::interval(AWARENESS_RENEW);
    renew.tick().await;
    let mut check = tokio::time::interval(MESSAGE_RECONNECT_TIMEOUT / 10);
    check.tick().await;
    let mut code = None;
    loop {
        tokio::select! {
            frame = stream.next() => match frame {
                Some(Ok(Ws::Binary(b))) => {
                    last = Instant::now();
                    shared.handle(&b);
                }
                Some(Ok(Ws::Close(f))) => {
                    code = f.map(|f| u16::from(f.code));
                    break;
                }
                Some(Ok(_)) => last = Instant::now(),
                Some(Err(_)) | None => break,
            },
            Some(m) = rx.recv() => {
                let closing = matches!(m, Ws::Close(_));
                if sink.send(m).await.is_err() || closing {
                    break;
                }
            }
            _ = renew.tick() => {
                // Re-set, not just resend: y-protocols takes a state only with
                // a higher clock, and drops a peer whose clock stops rising
                // for 30 s (its own renewal calls setLocalState).
                if let Some(m) = renew_local(&mut shared.awareness.lock().unwrap()) {
                    shared.send(m);
                }
            }
            _ = check.tick() => {
                if last.elapsed() > MESSAGE_RECONNECT_TIMEOUT {
                    break;
                }
                if shared.sweep_outdated() {
                    shared.bump();
                }
            }
            _ = stop.changed() => {
                // Flush the goodbye (our presence cleared), then close.
                while let Ok(m) = rx.try_recv() {
                    let _ = sink.send(m).await;
                }
                let _ = sink.send(Ws::Close(None)).await;
                break;
            }
        }
    }
    *shared.out.lock().unwrap() = None;
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
    code
}

/// Renew our presence the way y-protocols does: the same state with the
/// clock raised. None once our state is cleared (we are leaving).
pub(crate) fn renew_local(a: &mut Awareness) -> Option<Message> {
    let raw = a.local_state_raw()?;
    a.set_local_state_raw(raw);
    let id = a.client_id();
    a.update_with_clients([id]).ok().map(Message::Awareness)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renewing_presence_raises_its_clock() {
        let mut a = Awareness::new(Doc::new());
        a.set_local_state(json!({ "user": { "name": "A", "color": "#3b82f6" } })).unwrap();
        let id = a.client_id();
        let before = a.meta(id).unwrap().0;
        let Some(Message::Awareness(u)) = renew_local(&mut a) else { panic!("an update") };
        assert_eq!(a.meta(id).unwrap().0, before + 1);
        assert_eq!(u.clients[&id].clock, before + 1, "peers only take a higher clock");
        a.clean_local_state();
        assert!(renew_local(&mut a).is_none());
    }

    #[test]
    fn backoff_follows_y_websocket() {
        assert_eq!(backoff_ms(0), 100);
        assert_eq!(backoff_ms(1), 200);
        assert_eq!(backoff_ms(2), 400);
        assert_eq!(backoff_ms(3), 800);
        assert_eq!(backoff_ms(4), 1600);
        assert_eq!(backoff_ms(5), 2500);
        assert_eq!(backoff_ms(60), 2500);
    }

    #[test]
    fn only_4400s_are_final() {
        assert!(is_terminal_close(4403));
        assert!(is_terminal_close(4426));
        assert!(!is_terminal_close(4000));
        assert!(!is_terminal_close(1006));
        assert!(!is_terminal_close(1012));
        assert!(!is_terminal_close(4500));
    }

    #[test]
    fn peers_need_a_name_and_get_a_default_colour() {
        let p = parse_peer(7, &json!({ "user": { "name": "Ada" }, "cursor": { "anchor": { "assoc": 0 }, "head": { "assoc": 0 } } })).unwrap();
        assert_eq!(p.user.color, "#ffa500");
        assert!(p.cursor.is_some());
        assert!(parse_peer(1, &json!({ "user": { "name": "" } })).is_none());
        assert!(parse_peer(1, &json!({ "cursor": null })).is_none());
        let p = parse_peer(2, &json!({ "user": { "name": "B", "color": "#10b981" }, "cursor": null })).unwrap();
        assert_eq!(p.cursor, None);
    }

    #[test]
    fn labels_match_the_toolbar() {
        assert_eq!(LiveStatus::Connected.label(), "connected");
        assert_eq!(LiveStatus::Closed(CloseReason::AccessRevoked).label(), "disconnected");
        assert!(LiveStatus::Unavailable.is_final());
        assert!(!LiveStatus::Disconnected.is_final());
    }
}
