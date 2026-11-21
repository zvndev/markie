//! One live text room over `wss://<server>/collab/<docId>?ticket=`. Speaks the
//! standard y-protocols: message 0 is sync (step 1, step 2, update), message 1
//! is awareness. The room's text is `ydoc.getText("content")`.
use crate::collab::snapshot::{SNAPSHOT_WRITER_FIELD, StoredRecord, read_stored_record, snapshot_writer, write_stored_record};
use crate::collab::text::{TextBinding, new_doc};
use crate::collab::ticket::{FirstTicket, first_ticket};
use crate::collab::{CLOSE_ACCESS_REVOKED, CLOSE_ROOM_TOO_NEW, CONTENT_KIND_KEY, META_MAP, PeerUser, SCHEMA_KEY, SEED_SETTLE_MS, TEXT_COLLAB_KEY, TEXT_ROOM_SCHEMA, collab_ws_base, room_url};
use crate::error::{CloudError, Result};
use crate::sharing::SharesClient;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as Ws;
use yrs::sync::{Awareness, Message, SyncMessage};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, Map, Origin, ReadTxn, TextRef, Transact, Update};

const REMOTE: &str = "markie-remote";
const OBSERVER: &str = "markie-room";
/// y-protocols drops a peer it has not heard from in 30 s; renew at half that.
const AWARENESS_RENEW: Duration = Duration::from_secs(15);

/// Why the socket ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// 4403: access to the document went away. Stop for good; the pane goes read-only.
    AccessRevoked,
    /// 4426: the room needs a newer Markie.
    RoomTooNew,
    /// Any other close code.
    Code(u16),
    /// The connection dropped without a close frame.
    Dropped,
}

impl CloseReason {
    fn from_code(code: u16) -> Self {
        match code {
            CLOSE_ACCESS_REVOKED => CloseReason::AccessRevoked,
            CLOSE_ROOM_TOO_NEW => CloseReason::RoomTooNew,
            c => CloseReason::Code(c),
        }
    }
    /// Application closes end the session; others may reconnect.
    pub fn is_final(self) -> bool {
        matches!(self, CloseReason::AccessRevoked | CloseReason::RoomTooNew)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomStatus {
    pub connected: bool,
    pub synced: bool,
    pub closed: Option<CloseReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomEvent {
    Synced,
    /// Someone else's edit changed the text: the whole new string.
    RemoteText(String),
    Peers(Vec<PeerUser>),
    Closed(CloseReason),
}

#[derive(Debug, Clone)]
pub struct RoomOptions {
    pub user: PeerUser,
    /// Viewer: presence yes, edits no.
    pub readonly: bool,
    /// Offer to write the stored copy back over REST.
    pub offer_snapshot_writer: bool,
}

struct Inner {
    doc: Doc,
    text: TextRef,
    awareness: Mutex<Awareness>,
    binding: Mutex<TextBinding>,
    status: Mutex<RoomStatus>,
    out: mpsc::UnboundedSender<Ws>,
    events: broadcast::Sender<RoomEvent>,
    changes: watch::Sender<u64>,
    readonly: bool,
}

impl Inner {
    fn bump(&self) {
        self.changes.send_modify(|v| *v += 1);
    }

    fn send(&self, msg: Message) {
        let _ = self.out.send(Ws::Binary(msg.encode_v1().into()));
    }

    fn local_awareness(&self) -> Option<Message> {
        let a = self.awareness.lock().unwrap();
        let id = a.client_id();
        a.update_with_clients([id]).ok().map(Message::Awareness)
    }

    fn peers(&self) -> Vec<(u64, Value)> {
        let a = self.awareness.lock().unwrap();
        a.iter()
            .filter_map(|(id, state)| {
                let data = state.data?;
                serde_json::from_str::<Value>(&data).ok().map(|v| (id.get(), v))
            })
            .collect()
    }

    fn handle(&self, bytes: &[u8]) {
        let Ok(msg) = Message::decode_v1(bytes) else { return };
        match msg {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                let update = self.doc.transact().encode_state_as_update_v1(&sv);
                self.send(Message::Sync(SyncMessage::SyncStep2(update)));
            }
            Message::Sync(SyncMessage::SyncStep2(u)) => {
                self.apply_remote(&u);
                let first = {
                    let mut s = self.status.lock().unwrap();
                    let first = !s.synced;
                    s.synced = true;
                    first
                };
                if first {
                    self.binding.lock().unwrap().mark_synced(&self.doc);
                    let _ = self.events.send(RoomEvent::Synced);
                }
                self.bump();
            }
            Message::Sync(SyncMessage::Update(u)) => {
                self.apply_remote(&u);
                self.bump();
            }
            Message::Awareness(update) => {
                let _ = self.awareness.lock().unwrap().apply_update(update);
                let _ = self.events.send(RoomEvent::Peers(self.peer_users()));
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

    fn apply_remote(&self, bytes: &[u8]) {
        let Ok(update) = Update::decode_v1(bytes) else { return };
        {
            let mut txn = self.doc.transact_mut_with(REMOTE);
            if txn.apply_update(update).is_err() {
                return;
            }
        }
        let changed = self.binding.lock().unwrap().remote_changed(&self.doc);
        if let Some(text) = changed {
            let _ = self.events.send(RoomEvent::RemoteText(text));
        }
    }

    fn peer_users(&self) -> Vec<PeerUser> {
        let own = self.awareness.lock().unwrap().client_id().get();
        self.peers()
            .into_iter()
            .filter(|(id, _)| *id != own)
            .filter_map(|(_, v)| serde_json::from_value::<PeerUser>(v.get("user")?.clone()).ok())
            .filter(|u| !u.name.is_empty())
            .collect()
    }

    fn closed(&self, reason: CloseReason) {
        {
            let mut s = self.status.lock().unwrap();
            if s.closed.is_some() {
                return;
            }
            s.connected = false;
            s.closed = Some(reason);
        }
        let _ = self.events.send(RoomEvent::Closed(reason));
        self.bump();
    }
}

/// A connected text room. Dropping it closes the socket.
pub struct TextRoom {
    inner: Arc<Inner>,
    tasks: Vec<JoinHandle<()>>,
}

impl TextRoom {
    /// Connect to a room URL that already carries its ticket.
    pub async fn connect(url: &str, opts: RoomOptions) -> Result<TextRoom> {
        let (ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(res) => CloudError::Status { status: res.status().as_u16(), message: None },
            _ => CloudError::Offline,
        })?;
        let (mut sink, mut stream) = ws.split();
        let doc = new_doc();
        let text = doc.get_or_insert_text(TEXT_COLLAB_KEY);
        doc.get_or_insert_map(META_MAP);
        let binding = TextBinding::new(&doc, text.clone());
        let mut awareness = Awareness::new(doc.clone());
        let state = json!({ "user": opts.user, SNAPSHOT_WRITER_FIELD: opts.offer_snapshot_writer });
        awareness.set_local_state(state).map_err(|e| CloudError::Invalid(e.to_string()))?;
        let (out, mut rx) = mpsc::unbounded_channel::<Ws>();
        let (events, _) = broadcast::channel(256);
        let (changes, _) = watch::channel(0u64);
        let inner = Arc::new(Inner {
            doc: doc.clone(),
            text,
            awareness: Mutex::new(awareness),
            binding: Mutex::new(binding),
            status: Mutex::new(RoomStatus { connected: true, synced: false, closed: None }),
            out: out.clone(),
            events,
            changes,
            readonly: opts.readonly,
        });

        // Every local transaction goes out as an update; remote ones do not echo.
        let tx = out.clone();
        let remote = Origin::from(REMOTE);
        doc.observe_update_v1(OBSERVER, move |txn, e| {
            if txn.origin() == Some(&remote) {
                return;
            }
            let msg = Message::Sync(SyncMessage::Update(e.update.clone()));
            let _ = tx.send(Ws::Binary(msg.encode_v1().into()));
        })
        .map_err(|e| CloudError::Invalid(e.to_string()))?;

        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let close = matches!(m, Ws::Close(_));
                if sink.send(m).await.is_err() || close {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        let r = inner.clone();
        let reader = tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
                match frame {
                    Ok(Ws::Binary(b)) => r.handle(&b),
                    Ok(Ws::Close(c)) => {
                        r.closed(c.map(|f| CloseReason::from_code(u16::from(f.code))).unwrap_or(CloseReason::Dropped));
                        return;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            r.closed(CloseReason::Dropped);
        });
        let h = inner.clone();
        let heartbeat = tokio::spawn(async move {
            let mut tick = tokio::time::interval(AWARENESS_RENEW);
            tick.tick().await;
            loop {
                tick.tick().await;
                if h.status.lock().unwrap().closed.is_some() {
                    return;
                }
                if let Some(m) = h.local_awareness() {
                    h.send(m);
                }
            }
        });

        // Open the handshake: our state vector, then our presence.
        let sv = doc.transact().state_vector();
        inner.send(Message::Sync(SyncMessage::SyncStep1(sv)));
        if let Some(m) = inner.local_awareness() {
            inner.send(m);
        }
        Ok(TextRoom { inner, tasks: vec![writer, reader, heartbeat] })
    }

    /// Ask the document's server for a ticket (retrying a transient failure the
    /// way the web client does) and connect.
    pub async fn join(shares: &SharesClient<'_>, origin: &str, doc_id: &str, opts: RoomOptions) -> Result<TextRoom> {
        let mut attempt = 0;
        let ticket = loop {
            match first_ticket(&shares.collab_ticket(doc_id).await, attempt) {
                FirstTicket::Connect(t) => break t,
                FirstTicket::RetryAfterMs(ms) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    attempt += 1;
                }
                FirstTicket::Legacy => return Err(CloudError::Invalid("This server is too old for live editing from Markie RS.".into())),
                FirstTicket::Unavailable => return Err(CloudError::Invalid("Live editing isn't available for this document right now.".into())),
            }
        };
        Self::connect(&room_url(&collab_ws_base(origin), doc_id, &ticket), opts).await
    }

    pub fn doc(&self) -> &Doc {
        &self.inner.doc
    }

    pub fn status(&self) -> RoomStatus {
        self.inner.status.lock().unwrap().clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RoomEvent> {
        self.inner.events.subscribe()
    }

    /// The room's text as it stands.
    pub fn text(&self) -> String {
        self.inner.text.get_string(&self.inner.doc.transact())
    }

    /// Push one whole-string local edit. The merged text, or None when the
    /// room has not synced, is read-only, or is closed.
    pub fn apply_local(&self, next: &str) -> Option<String> {
        if self.inner.readonly || self.status().closed.is_some() {
            return None;
        }
        self.inner.binding.lock().unwrap().apply_local(&self.inner.doc, next)
    }

    /// After the first sync and the settle delay, seed an empty room from the
    /// local file with the text-room stamp, in one transaction. True when this
    /// client seeded. The server elects one seeder and drops anyone else's.
    pub async fn seed_after_settle(&self, local: &str, timeout: Duration) -> Result<bool> {
        self.wait_for(timeout, |r| r.status().synced).await?;
        tokio::time::sleep(Duration::from_millis(SEED_SETTLE_MS)).await;
        if self.inner.readonly || !self.text().is_empty() || local.is_empty() {
            return Ok(false);
        }
        let meta = self.inner.doc.get_or_insert_map(META_MAP);
        let mut txn = self.inner.doc.transact_mut();
        let seeded = self.inner.binding.lock().unwrap().seed_if_empty(&mut txn, local);
        if seeded {
            meta.insert(&mut txn, SCHEMA_KEY, TEXT_ROOM_SCHEMA);
            meta.insert(&mut txn, CONTENT_KIND_KEY, "text");
        }
        Ok(seeded)
    }

    /// Other people in the room.
    pub fn peers(&self) -> Vec<PeerUser> {
        self.inner.peer_users()
    }

    /// Whether this client is the one that writes the stored copy.
    pub fn is_snapshot_writer(&self) -> bool {
        let own = self.inner.awareness.lock().unwrap().client_id().get();
        let states = self.inner.peers();
        snapshot_writer(states.iter().map(|(id, v)| (*id, v))) == Some(own)
    }

    pub fn stored_record(&self) -> Option<StoredRecord> {
        read_stored_record(&self.inner.doc)
    }

    pub fn write_stored_record(&self, record: &StoredRecord) {
        write_stored_record(&self.inner.doc, record)
    }

    /// The schema the room's meta map records.
    pub fn room_schema(&self) -> Option<i64> {
        let meta = self.inner.doc.get_or_insert_map(META_MAP);
        match meta.get(&self.inner.doc.transact(), SCHEMA_KEY) {
            Some(yrs::Out::Any(yrs::Any::Number(n))) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            _ => None,
        }
    }

    /// Wait until `pred` holds, re-checking on every change.
    pub async fn wait_for(&self, timeout: Duration, pred: impl Fn(&TextRoom) -> bool) -> Result<()> {
        let mut rx = self.inner.changes.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if pred(self) {
                return Ok(());
            }
            if self.status().closed.is_some() && !pred(self) {
                return Err(CloudError::Invalid("The live session closed.".into()));
            }
            match tokio::time::timeout_at(deadline, rx.changed()).await {
                Ok(Ok(())) => continue,
                _ => return Err(CloudError::Invalid("Timed out waiting for the live session.".into())),
            }
        }
    }

    /// Say goodbye to peers and close the socket.
    pub async fn close(mut self) {
        self.shutdown();
        for t in self.tasks.drain(..) {
            let abort = t.abort_handle();
            if tokio::time::timeout(Duration::from_secs(2), t).await.is_err() {
                abort.abort();
            }
        }
    }

    fn shutdown(&self) {
        {
            let mut a = self.inner.awareness.lock().unwrap();
            a.clean_local_state();
        }
        if let Some(m) = self.inner.local_awareness() {
            self.inner.send(m);
        }
        let _ = self.inner.out.send(Ws::Close(None));
        let _ = self.inner.doc.unobserve_update_v1(OBSERVER);
    }
}

impl Drop for TextRoom {
    fn drop(&mut self) {
        if !self.tasks.is_empty() {
            self.shutdown();
            for t in &self.tasks {
                t.abort();
            }
        }
    }
}
