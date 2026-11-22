//! The room supervisor against a scripted websocket server on this computer:
//! tickets, reconnect with backoff, final closes, presence and the inbox.
use futures_util::{SinkExt, StreamExt};
use markie_cloud::collab::room::CloseReason;
use markie_cloud::collab::session::{LiveSession, LiveStatus, SessionOptions, TicketSource};
use markie_cloud::collab::PeerUser;
use markie_cloud::sharing::CollabTicketAnswer;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as Ws;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use yrs::sync::{Awareness, Message, SyncMessage};
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact};

/// Answers from a script, then tickets "t1", "t2", ...
struct Tickets {
    script: Mutex<Vec<CollabTicketAnswer>>,
    asked: AtomicUsize,
}

impl Tickets {
    fn new(script: Vec<CollabTicketAnswer>) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(script), asked: AtomicUsize::new(0) })
    }
}

impl TicketSource for Tickets {
    fn ticket(&self) -> Pin<Box<dyn Future<Output = CollabTicketAnswer> + Send + '_>> {
        let n = self.asked.fetch_add(1, Ordering::SeqCst) + 1;
        let next = {
            let mut s = self.script.lock().unwrap();
            if s.is_empty() { None } else { Some(s.remove(0)) }
        };
        Box::pin(async move { next.unwrap_or(CollabTicketAnswer::Ticket { ticket: format!("t{n}"), expires_at: 0 }) })
    }
}

/// A server from before tickets: no ticket route, and a session token to
/// fall back on (or none, when signed out).
struct LegacyTickets(Option<&'static str>);

impl TicketSource for LegacyTickets {
    fn ticket(&self) -> Pin<Box<dyn Future<Output = CollabTicketAnswer> + Send + '_>> {
        Box::pin(async { CollabTicketAnswer::Legacy })
    }
    fn legacy_token(&self) -> Option<String> {
        self.0.map(str::to_string)
    }
}

#[derive(Clone, Copy)]
enum Then {
    /// Sync, then drop the TCP connection without a close frame.
    Drop,
    /// Sync, then close with this code.
    Close(u16),
    /// Sync, push a text update and a peer, and stay open.
    Serve,
}

struct Server {
    origin: String,
    urls: Arc<Mutex<Vec<(Instant, String)>>>,
}

async fn server(script: Vec<Then>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let urls: Arc<Mutex<Vec<(Instant, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = urls.clone();
    tokio::spawn(async move {
        let mut k = 0usize;
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let then = script.get(k).copied().unwrap_or(Then::Serve);
            k += 1;
            let seen = seen.clone();
            tokio::spawn(async move {
                let path = Arc::new(Mutex::new(String::new()));
                let p2 = path.clone();
                let cb = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request, res| {
                    *p2.lock().unwrap() = req.uri().to_string();
                    Ok(res)
                };
                let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, cb).await else { return };
                seen.lock().unwrap().push((Instant::now(), path.lock().unwrap().clone()));
                // The server's half of the handshake: an empty room.
                let room = Doc::new();
                let step2 = room.transact().encode_state_as_update_v1(&StateVector::default());
                let _ = ws.send(Ws::Binary(Message::Sync(SyncMessage::SyncStep2(step2)).encode_v1().into())).await;
                match then {
                    Then::Drop => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        drop(ws);
                    }
                    Then::Close(code) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        let _ = ws.send(Ws::Close(Some(CloseFrame { code: CloseCode::from(code), reason: "scripted".into() }))).await;
                        while let Some(Ok(_)) = ws.next().await {}
                    }
                    Then::Serve => {
                        let text = room.get_or_insert_text("content");
                        let u = {
                            let mut txn = room.transact_mut();
                            text.insert(&mut txn, 0, "from the room");
                            txn.encode_update_v1()
                        };
                        let _ = ws.send(Ws::Binary(Message::Sync(SyncMessage::Update(u)).encode_v1().into())).await;
                        let mut aw = Awareness::new(Doc::with_client_id(999));
                        aw.set_local_state(serde_json::json!({ "user": { "name": "Peer One", "color": "#10b981" }, "cursor": null })).unwrap();
                        let up = aw.update_with_clients([aw.client_id()]).unwrap();
                        let _ = ws.send(Ws::Binary(Message::Awareness(up).encode_v1().into())).await;
                        while let Some(Ok(m)) = ws.next().await {
                            if matches!(m, Ws::Close(_)) {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    Server { origin: format!("http://127.0.0.1:{port}"), urls }
}

fn opts() -> SessionOptions {
    SessionOptions { user: PeerUser { name: "Rust".into(), color: "#3b82f6".into() }, readonly: false, offer_snapshot_writer: true }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drops_reconnect_with_backoff_and_4403_is_final() {
    let srv = server(vec![Then::Drop, Then::Drop, Then::Close(4403)]).await;
    let tickets = Tickets::new(vec![]);
    let s = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-1", Doc::new(), tickets.clone(), opts());
    assert!(s.wait_for(Duration::from_secs(10), |s| s.status().is_final()).await, "{:?}", s.history());
    assert_eq!(s.status(), LiveStatus::Closed(CloseReason::AccessRevoked));
    let urls = srv.urls.lock().unwrap().clone();
    assert_eq!(urls.len(), 3, "two drops, then the final close");
    // Each connection synced, so each reconnect waited the first backoff
    // step (200 ms) and reused the young ticket.
    for w in urls.windows(2) {
        let gap = w[1].0 - w[0].0;
        assert!(gap >= Duration::from_millis(200), "{gap:?}");
    }
    assert!(urls.iter().all(|(_, u)| u == "/collab/doc-1?ticket=t1"), "{urls:?}");
    assert_eq!(tickets.asked.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(srv.urls.lock().unwrap().len(), 3, "no reconnect after 4403");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_too_new_is_final_and_4000s_stop_ticket_refresh() {
    let srv = server(vec![Then::Close(4000), Then::Close(4426)]).await;
    let s = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-2", Doc::new(), Tickets::new(vec![]), opts());
    assert!(s.wait_for(Duration::from_secs(10), |s| s.status().is_final()).await);
    assert_eq!(s.status(), LiveStatus::Closed(CloseReason::RoomTooNew));
    assert!(s.ticket_halted());
    assert_eq!(srv.urls.lock().unwrap().len(), 2, "4000 reconnects, 4426 does not");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blip_on_the_first_ticket_is_retried_and_a_refusal_is_unavailable() {
    let srv = server(vec![Then::Serve]).await;
    let tickets = Tickets::new(vec![CollabTicketAnswer::Failed { status: 503 }]);
    let s = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-3", Doc::new(), tickets.clone(), opts());
    assert!(s.wait_for(Duration::from_secs(10), |s| s.synced()).await);
    assert_eq!(tickets.asked.load(Ordering::SeqCst), 2, "one retry after the 503");
    assert_eq!(srv.urls.lock().unwrap()[0].1, "/collab/doc-3?ticket=t2");

    let refused = Tickets::new(vec![CollabTicketAnswer::Failed { status: 403 }]);
    let s2 = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-4", Doc::new(), refused, opts());
    assert!(s2.wait_for(Duration::from_secs(5), |s| s.status().is_final()).await);
    assert_eq!(s2.status(), LiveStatus::Unavailable);
    // No session to fall back on: nothing to connect with.
    let s3 = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-5", Doc::new(), Arc::new(LegacyTickets(None)), opts());
    assert!(s3.wait_for(Duration::from_secs(5), |s| s.status().is_final()).await);
    assert_eq!(s3.status(), LiveStatus::Unavailable);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_from_before_tickets_takes_the_session_token() {
    // connectWithTicket: a "legacy" answer (no such route) connects with
    // `params = { token }` and never asks for a ticket again, reconnects
    // included.
    let srv = server(vec![Then::Drop, Then::Serve]).await;
    let s = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-legacy", Doc::new(), Arc::new(LegacyTickets(Some("session-token"))), opts());
    assert!(s.wait_for(Duration::from_secs(10), |s| s.synced() && s.history().1 >= 2).await);
    let urls: Vec<String> = srv.urls.lock().unwrap().iter().map(|(_, u)| u.clone()).collect();
    assert_eq!(urls[..2], ["/collab/doc-legacy?token=session-token", "/collab/doc-legacy?token=session-token"]);
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_never_writes_the_stored_copy_leaves_the_field_out() {
    // useLiveRoom sets markieSnapshotWriter only when it offers; the desktop
    // passes offer: false, so its presence carries no such field.
    let srv = server(vec![Then::Serve]).await;
    let mut o = opts();
    o.offer_snapshot_writer = false;
    let s = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-desk", Doc::new(), Tickets::new(vec![]), o);
    assert!(s.wait_for(Duration::from_secs(5), |s| s.synced()).await);
    let ours = s.states().into_iter().find(|(id, _)| *id == s.client_id()).unwrap().1;
    assert!(ours.get("markieSnapshotWriter").is_none(), "{ours}");
    assert_eq!(ours["user"]["name"], "Rust");
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn updates_wait_for_pump_and_presence_arrives() {
    let srv = server(vec![Then::Serve]).await;
    let doc = Doc::new();
    let text = doc.get_or_insert_text("content");
    let s = LiveSession::start(&tokio::runtime::Handle::current(), &srv.origin, "doc-6", doc.clone(), Tickets::new(vec![]), opts());
    // Wait for the update to be queued without applying it.
    let mut rx = s.subscribe();
    let deadline = Instant::now() + Duration::from_secs(5);
    while text.get_string(&doc.transact()).is_empty() && Instant::now() < deadline {
        if s.has_inbound() {
            assert_eq!(text.get_string(&doc.transact()), "", "nothing applies before pump");
            s.pump();
        }
        let _ = tokio::time::timeout(Duration::from_millis(100), rx.changed()).await;
    }
    assert_eq!(text.get_string(&doc.transact()), "from the room");
    assert!(s.wait_for(Duration::from_secs(5), |s| !s.peers().is_empty()).await);
    let p = &s.peers()[0];
    assert_eq!((p.user.name.as_str(), p.user.color.as_str(), p.cursor.is_none()), ("Peer One", "#10b981", true));
    s.set_cursor(Some((serde_json::json!({ "tname": "default", "assoc": -1 }), serde_json::json!({ "tname": "default", "assoc": -1 }))));
    let ours = s.states().into_iter().find(|(id, _)| *id == s.client_id()).unwrap().1;
    assert_eq!(ours["cursor"]["anchor"]["tname"], "default");
    assert_eq!(ours["markieSnapshotWriter"], true);
    let _ = doc.transact().state_vector();
    s.shutdown().await;
}
