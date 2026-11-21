//! End to end against the real Markie server running on localhost.
//!
//! Run through `scripts/local-server.sh`, which boots `server/` on a scratch
//! database with console mail and sets MARKIE_CLOUD_TEST_SERVER and
//! MARKIE_CLOUD_TEST_LOG. Without those variables this test does nothing, so a
//! plain `cargo test` stays offline. It refuses any server that is not this
//! computer. Every address is on the SES mailbox simulator, and the server's
//! mail is only written to its log, so no mail goes anywhere.
use markie_cloud::auth::{AuthClient, AuthStates, CodeFlow, Provider, SignInOutcome, resolve_auth_deep_link};
use markie_cloud::collab::room::{CloseReason, RoomOptions, TextRoom};
use markie_cloud::collab::snapshot::{LiveSnapshotResult, RoomTexts, SnapshotIo, write_live_snapshot};
use markie_cloud::collab::{PeerUser, color_for_name};
use markie_cloud::comments::{CommentsClient, ThreadStatus};
use markie_cloud::docs::{DocsClient, PutDoc, PutOutcome, Role};
use markie_cloud::http::Transport;
use markie_cloud::registry::ServerStore;
use markie_cloud::sharing::{AddStatus, PeopleClient, SharesClient};
use markie_cloud::sync::{PushResult, SyncEngine, SyncRecord, SyncState, hash_content};
use markie_cloud::tokens::MemoryTokenStore;
use markie_cloud::{CloudClient, DEFAULT_SERVER};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

struct Env {
    base: String,
    log: String,
}

fn env() -> Option<Env> {
    let base = std::env::var("MARKIE_CLOUD_TEST_SERVER").ok()?;
    let log = std::env::var("MARKIE_CLOUD_TEST_LOG").ok()?;
    let u = url::Url::parse(&base).expect("server url");
    assert!(matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")), "the integration test only runs against this computer, not {base}");
    Some(Env { base: base.trim_end_matches('/').to_string(), log })
}

/// A unique SES-simulator address: it accepts mail and delivers it nowhere.
fn address(label: &str) -> String {
    let mut b = [0u8; 4];
    getrandom::fill(&mut b).unwrap();
    format!("success+markie-rs-{label}-{}@simulator.amazonses.com", hex::encode(b))
}

/// The newest code the server "sent" to `email`, read from its console mail log.
async fn code_for(env: &Env, email: &str, kind: &str, after: usize) -> String {
    for _ in 0..150 {
        let log = std::fs::read_to_string(&env.log).unwrap_or_default();
        let needle = format!("to={email} subject=\"");
        let found = log
            .lines()
            .filter(|l| l.contains(&needle) && l.contains(kind))
            .skip(after)
            .filter_map(|l| l.split(&needle).nth(1)?.split(' ').next().map(str::to_string))
            .last();
        if let Some(code) = found {
            return code;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {kind} for {email} in {}:\n{}", env.log, std::fs::read_to_string(&env.log).unwrap_or_default());
}

fn device(env: &Env, store: &ServerStore) -> CloudClient {
    CloudClient::new(&env.base, store.trust_handle(), Arc::new(MemoryTokenStore::new()), Transport::new()).unwrap()
}

async fn sign_up(env: &Env, store: &ServerStore, name: &str) -> (CloudClient, String, String) {
    let email = address(&name.to_lowercase());
    let c = device(env, store);
    let auth = AuthClient::new(&c);
    assert_eq!(auth.sign_up_email(&email, "correct horse battery", name).await.unwrap(), SignInOutcome::NeedsVerification);
    // An unproven address cannot sign in.
    assert_eq!(auth.sign_in_email(&email, "correct horse battery").await.unwrap(), SignInOutcome::NeedsVerification);
    let code = code_for(env, &email, "verification code", 0).await;
    let user = auth.verify_email(&email, &code).await.unwrap().expect("verify signs in");
    assert_eq!(c.session().unwrap().user_id.as_deref(), Some(user.id.as_str()));
    (c, email, user.id)
}

struct DocsIo<'a> {
    docs: DocsClient<'a>,
    id: String,
    name: String,
}

impl SnapshotIo for DocsIo<'_> {
    async fn save(&mut self, content: &str, base: i64) -> Result<i64, Option<String>> {
        let body = PutDoc { name: self.name.clone(), content: content.into(), hash: hash_content(content), base_version: base, area_id: None, origin: None };
        match self.docs.put(&self.id, &body).await {
            PutOutcome::Saved { version: Some(v) } => Ok(v),
            PutOutcome::Conflict { .. } => Err(None),
            other => Err(Some(format!("{other:?}"))),
        }
    }
    async fn read(&mut self) -> Option<(String, String, i64)> {
        self.docs.get(&self.id).await.ok().map(|d| (d.content, d.name, d.version))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn against_the_local_server() {
    let Some(env) = env() else {
        eprintln!("MARKIE_CLOUD_TEST_SERVER is not set; run scripts/local-server.sh to run this test.");
        return;
    };

    // Servers: the local server is checked and added like any self-hosted one.
    let mut store = ServerStore::open(None, true);
    let probe = store.probe(&Transport::new(), &env.base).await.expect("server-info");
    assert_eq!(probe.origin, env.base);
    assert!(probe.info.sign_in.email);
    store.add(&probe.probe_id).unwrap();
    assert!(store.is_trusted(&env.base));
    eprintln!("server: {} {:?}", probe.info.name, probe.info.sign_in);

    // Accounts: sign up, prove the address by the emailed code, sign in again by password.
    let (alice, alice_email, alice_id) = sign_up(&env, &store, "Alice").await;
    let (bob, bob_email, bob_id) = sign_up(&env, &store, "Bob").await;
    let alice2 = device(&env, &store);
    match AuthClient::new(&alice2).sign_in_email(&alice_email, "correct horse battery").await.unwrap() {
        SignInOutcome::SignedIn(u) => assert_eq!(u.id, alice_id),
        other => panic!("{other:?}"),
    }
    assert_eq!(AuthClient::new(&alice).me().await.unwrap().unwrap().email, alice_email.to_lowercase());

    // Code sign-in (this server has no verified identities, so the legacy route).
    let alice3 = device(&env, &store);
    let auth3 = AuthClient::new(&alice3);
    let flow = auth3.send_code(&alice_email).await.unwrap();
    assert!(matches!(flow, CodeFlow::Legacy { .. }));
    let code = code_for(&env, &alice_email.to_lowercase(), "sign-in code", 0).await;
    assert_eq!(auth3.verify_code(&flow, &code).await.unwrap().id, alice_id);

    // The browser bridge hands back a deep link with our nonce and this server as issuer.
    let states = AuthStates::new();
    let start = AuthClient::new(&alice3).browser_start_url(Provider::Google, &states).unwrap();
    assert!(start.starts_with(&format!("{}/auth/google-start?state=", env.base)));
    let state = start.rsplit("state=").next().unwrap().to_string();
    let bridge = alice3.get(&format!("/auth/desktop-bridge?state={state}")).await.unwrap();
    assert_eq!(bridge.status, 200);
    let html = String::from_utf8(bridge.bytes).unwrap();
    let link = html.split("href=\"markie://").nth(1).and_then(|s| s.split('"').next()).map(|s| format!("markie://{s}")).expect("deep link").replace("&amp;", "&");
    let adopted = resolve_auth_deep_link(&link, DEFAULT_SERVER, &states).expect("deep link accepted");
    assert_eq!(adopted.origin.as_deref(), Some(env.base.as_str()));
    // The bridge hands back the session token itself; it signs in as Alice.
    let via_link = device(&env, &store);
    via_link.set_token(Some(&adopted.token)).unwrap();
    assert_eq!(AuthClient::new(&via_link).me().await.unwrap().unwrap().id, alice_id);

    // Sign-out ends the session at the server too.
    let old = alice3.token().unwrap();
    AuthClient::new(&alice3).sign_out().await.unwrap();
    assert_eq!(alice3.token(), None);
    let probe_old = device(&env, &store);
    probe_old.set_token(Some(&old)).unwrap();
    assert_eq!(AuthClient::new(&probe_old).me().await.unwrap(), None);

    // Sync: create, push, a stale second device conflicts, keep both, overwrite.
    let a_sync = SyncEngine::new(&alice, false);
    let (rec, res) = a_sync.sync_on(&SyncRecord::default(), "notes.txt", "Line one\n", false).await;
    assert_eq!(res, PushResult::Ok { version: 1 });
    assert_eq!(rec.cloud_origin.as_deref(), Some(env.base.as_str()));
    let doc_id = rec.cloud_doc_id.clone().unwrap();
    let (rec, res) = a_sync.push(&rec, "notes.txt", "Line one\nLine two\n", false).await;
    assert_eq!(res, PushResult::Ok { version: 2 });
    let stale = SyncRecord { cloud_version: 1, ..rec.clone() };
    let a2_sync = SyncEngine::new(&alice2, false);
    let (conflicted, res) = a2_sync.push(&stale, "notes.txt", "Line one\nOther device\n", false).await;
    assert_eq!(res, PushResult::Conflict { server_version: Some(2) });
    assert_eq!(conflicted.state, SyncState::Conflict);
    let kb = a2_sync.resolve_keep_both(std::path::Path::new("/tmp/notes.txt"), &conflicted, "Line one\nOther device\n", |_| false).await.unwrap();
    assert_eq!(kb.original_content, "Line one\nLine two\n");
    assert_eq!((kb.original_record.state, kb.original_record.cloud_version), (SyncState::Synced, 2));
    assert!(kb.copy_path.ends_with("notes (my version).txt"));
    let listing = DocsClient::new(&alice).list().await.unwrap();
    assert!(listing.iter().any(|d| d.id == doc_id && d.version == 2 && !d.shared));

    // A document deleted remotely is gone for good.
    let (tmp, _) = a_sync.sync_on(&SyncRecord::default(), "scratch.md", "# Scratch\n", false).await;
    let off = a_sync.sync_off(&tmp, true).await.unwrap();
    assert_eq!(off.state, SyncState::LocalOnly);
    assert_eq!(DocsClient::new(&alice).get(tmp.cloud_doc_id.as_deref().unwrap()).await.unwrap_err().status(), Some(404));

    // Sharing: Bob has never accepted Alice, so the share is a request he accepts.
    let shares = SharesClient::new(&alice);
    assert_eq!(shares.add(&doc_id, &bob_email, Role::Editor).await.unwrap(), AddStatus::Requested);
    let bob_people = PeopleClient::new(&bob);
    let (requests, count) = bob_people.requests().await.unwrap();
    assert_eq!(count, 1);
    assert_eq!(requests[0].doc_id, doc_id);
    bob_people.accept(&requests[0].sender.id).await.unwrap();
    assert!(bob_people.people().await.unwrap().accepted.iter().any(|p| p.id == alice_id));
    let bob_list = DocsClient::new(&bob).list().await.unwrap();
    let shared = bob_list.iter().find(|d| d.id == doc_id).expect("shared doc listed");
    assert!(shared.shared);
    assert_eq!(shared.role, Some(Role::Editor));
    let access = SharesClient::new(&bob).access(&doc_id).await.unwrap();
    assert!(access.can_edit && !access.can_manage);
    assert!(shares.list(&doc_id).await.unwrap().iter().any(|m| m.user_id.as_deref() == Some(bob_id.as_str())));
    assert!(shares.shared_by_me().await.unwrap().iter().any(|d| d.id == doc_id));
    assert!(shares.contacts().await.unwrap().iter().any(|c| c.email == bob_email.to_lowercase()));

    // Public link: create, read back, revoke.
    let url = shares.create_public_link(&doc_id).await.unwrap();
    assert!(url.contains("/s/"));
    assert_eq!(shares.public_link(&doc_id).await.unwrap().as_deref(), Some(url.as_str()));
    shares.revoke_public_link(&doc_id).await.unwrap();
    assert_eq!(shares.public_link(&doc_id).await.unwrap(), None);

    // Comments: open, reply, resolve, delete a reply.
    let comments = CommentsClient::new(&alice);
    let thread = comments.create_thread(&doc_id, json!({ "from": 0, "to": 4 }), "Is this right?").await.unwrap();
    let reply = CommentsClient::new(&bob).reply(&doc_id, &thread, "Looks right to me.").await.unwrap();
    comments.set_status(&doc_id, &thread, ThreadStatus::Resolved).await.unwrap();
    let threads = CommentsClient::new(&bob).list(&doc_id).await.unwrap();
    assert_eq!((threads.len(), threads[0].comments.len(), threads[0].status), (1, 2, ThreadStatus::Resolved));
    CommentsClient::new(&bob).delete_comment(&doc_id, &thread, &reply).await.unwrap();
    assert_eq!(comments.list(&doc_id).await.unwrap()[0].comments.len(), 1);

    // Live text room: Alice joins first, so she holds the seed lock for the empty room.
    let user = |n: &str| PeerUser { name: n.into(), color: color_for_name(n).into() };
    let a_room = TextRoom::join(&shares, &env.base, &doc_id, RoomOptions { user: user("Alice"), readonly: false, offer_snapshot_writer: true }).await.unwrap();
    a_room.wait_for(Duration::from_secs(5), |r| r.status().synced).await.unwrap();
    let bob_shares = SharesClient::new(&bob);
    let b_room = TextRoom::join(&bob_shares, &env.base, &doc_id, RoomOptions { user: user("Bob"), readonly: false, offer_snapshot_writer: true }).await.unwrap();
    let stored = "Line one\nLine two\n";
    assert!(a_room.seed_after_settle(stored, Duration::from_secs(5)).await.unwrap());
    b_room.wait_for(Duration::from_secs(5), |r| r.text() == stored).await.unwrap();
    assert_eq!(b_room.room_schema(), Some(1));
    // Bob's edit reaches Alice, and Alice's reaches Bob.
    b_room.apply_local("Line one\nLine two\nBob was here\n").unwrap();
    a_room.wait_for(Duration::from_secs(5), |r| r.text().ends_with("Bob was here\n")).await.unwrap();
    a_room.apply_local("Line zero\nLine one\nLine two\nBob was here\n").unwrap();
    b_room.wait_for(Duration::from_secs(5), |r| r.text().starts_with("Line zero\n")).await.unwrap();
    // Presence carries the server-stamped identity: Bob's account name.
    a_room.wait_for(Duration::from_secs(5), |r| r.peers().iter().any(|p| p.name == "Bob")).await.unwrap();
    // Exactly one of them writes the stored copy back.
    b_room.wait_for(Duration::from_secs(5), |r| r.peers().len() == 1).await.unwrap();
    assert_ne!(a_room.is_snapshot_writer(), b_room.is_snapshot_writer());
    let (writer, writer_client) = if a_room.is_snapshot_writer() { (&a_room, &alice) } else { (&b_room, &bob) };
    let room_text = writer.text();
    let mut io = DocsIo { docs: DocsClient::new(writer_client), id: doc_id.clone(), name: "notes.txt".into() };
    let mut seen = RoomTexts::default();
    seen.add(stored);
    let saved = write_live_snapshot(&mut io, &room_text, "notes.txt", 2, &mut seen, Some(writer.doc())).await.unwrap();
    assert_eq!(saved, LiveSnapshotResult::Saved { version: 3 });
    assert_eq!(DocsClient::new(&alice).get(&doc_id).await.unwrap().content, room_text);
    assert_eq!(writer.stored_record().unwrap().version, 3);

    // Removing Bob closes his socket with 4403.
    shares.remove(&doc_id, &bob_id).await.unwrap();
    b_room.wait_for(Duration::from_secs(5), |r| r.status().closed.is_some()).await.ok();
    assert_eq!(b_room.status().closed, Some(CloseReason::AccessRevoked));
    assert_eq!(b_room.apply_local("anything"), None);
    a_room.close().await;
    b_room.close().await;
    eprintln!("local server integration: all steps passed");
}
