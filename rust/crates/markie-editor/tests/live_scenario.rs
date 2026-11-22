//! Sets up a live document on the local server for looking at Markie RS on
//! screen, then exits. Run through `interop/scenario.sh`; does nothing
//! without MARKIE_LIVE_SCENARIO_DIR.
//!
//! Writes, into that scratch folder only: `alice-session.json` and
//! `carol-session.json` (for `MARKIE_RS_TEST_SESSION`: Alice owns the
//! document, Carol may only view it) and `bob.json` (for the TipTap peer,
//! `interop/peer.test.ts`). They hold session tokens for throwaway accounts
//! on a server on this computer; nothing prints them.
use markie_cloud::auth::{AuthClient, SignInOutcome};
use markie_cloud::docs::{DocsClient, PutDoc, PutOutcome, Role};
use markie_cloud::http::Transport;
use markie_cloud::registry::ServerStore;
use markie_cloud::sharing::{PeopleClient, SharesClient};
use markie_cloud::sync::hash_content;
use markie_cloud::tokens::MemoryTokenStore;
use markie_cloud::CloudClient;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn address(label: &str) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 1_000_000_007;
    format!("success+markie-rs-scene-{label}-{n}@simulator.amazonses.com")
}

async fn sign_up(base: &str, log: &str, store: &ServerStore, name: &str) -> (CloudClient, String, markie_cloud::auth::MarkieUser) {
    let email = address(&name.to_lowercase().replace(' ', "-"));
    let c = CloudClient::new(base, store.trust_handle(), Arc::new(MemoryTokenStore::new()), Transport::new()).unwrap();
    let auth = AuthClient::new(&c);
    assert_eq!(auth.sign_up_email(&email, "correct horse battery", name).await.unwrap(), SignInOutcome::NeedsVerification);
    let needle = format!("to={email} subject=\"");
    let mut code = None;
    for _ in 0..150 {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        code = text.lines().filter(|l| l.contains(&needle)).filter_map(|l| l.split(&needle).nth(1)?.split(' ').next().map(str::to_string)).last();
        if code.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let user = auth.verify_email(&email, &code.expect("code")).await.unwrap().expect("verified");
    (c, email, user)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_up_a_live_document() {
    let (Ok(base), Ok(log), Ok(dir), Ok(file)) = (
        std::env::var("MARKIE_CLOUD_TEST_SERVER"),
        std::env::var("MARKIE_CLOUD_TEST_LOG"),
        std::env::var("MARKIE_LIVE_SCENARIO_DIR"),
        std::env::var("MARKIE_LIVE_SCENARIO_FILE"),
    ) else {
        return;
    };
    let u = url::Url::parse(&base).unwrap();
    assert!(matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")));
    let dir = PathBuf::from(dir);
    let mut store = ServerStore::open(None, true);
    let probe = store.probe(&Transport::new(), &base).await.unwrap();
    store.add(&probe.probe_id).unwrap();
    let (alice, _, alice_user) = sign_up(&base, &log, &store, "Alice Rust").await;
    let (bob, bob_email, _) = sign_up(&base, &log, &store, "Bob Tiptap").await;
    let (carol, carol_email, carol_user) = sign_up(&base, &log, &store, "Carol Viewer").await;
    let content = std::fs::read_to_string(&file).unwrap();
    let doc_id = uuid::Uuid::new_v4().to_string();
    let name = PathBuf::from(&file).file_name().unwrap().to_string_lossy().into_owned();
    let put = DocsClient::new(&alice).put(&doc_id, &PutDoc { name, content: content.clone(), hash: hash_content(&content), base_version: 0, area_id: None, origin: None }).await;
    assert!(matches!(put, PutOutcome::Saved { .. }));
    for (who, email, role) in [(&bob, &bob_email, Role::Editor), (&carol, &carol_email, Role::Viewer)] {
        SharesClient::new(&alice).add(&doc_id, email, role).await.unwrap();
        let people = PeopleClient::new(who);
        let (requests, _) = people.requests().await.unwrap();
        people.accept(&requests.iter().find(|r| r.doc_id == doc_id).unwrap().sender.id).await.unwrap();
    }
    let session = |c: &CloudClient, user: &markie_cloud::auth::MarkieUser| {
        json!({ "origin": base, "token": c.token().unwrap(), "user": user, "docs": { file.clone(): doc_id } })
    };
    std::fs::write(dir.join("alice-session.json"), serde_json::to_string_pretty(&session(&alice, &alice_user)).unwrap()).unwrap();
    std::fs::write(dir.join("carol-session.json"), serde_json::to_string_pretty(&session(&carol, &carol_user)).unwrap()).unwrap();
    std::fs::write(dir.join("bob.json"), serde_json::to_string_pretty(&json!({ "base": base, "docId": doc_id, "token": bob.token().unwrap(), "dir": dir })).unwrap()).unwrap();
}
