//! The HTTP rules against a mock server: tokens stay with their origin, no
//! redirects, size caps, token rotation, the sign-in flows, sync answers and
//! collab tickets.
use markie_cloud::auth::{AuthClient, CodeFlow, SignInOutcome};
use markie_cloud::client::TrustHandle;
use markie_cloud::comments::CommentsClient;
use markie_cloud::docs::PutOutcome;
use markie_cloud::http::Transport;
use markie_cloud::origin::Trust;
use markie_cloud::sharing::{CollabTicketAnswer, SharesClient};
use markie_cloud::sync::{PushResult, SyncEngine, SyncRecord, SyncState};
use markie_cloud::tokens::{MemoryTokenStore, Session, TokenStore, set_token};
use markie_cloud::{CloudClient, CloudError};
use serde_json::json;
use std::sync::{Arc, RwLock};
use wiremock::matchers::{body_partial_json, header, header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn dev_trust() -> TrustHandle {
    Arc::new(RwLock::new(Trust::new([], true)))
}

fn client(server: &MockServer, tokens: Arc<MemoryTokenStore>) -> CloudClient {
    CloudClient::new(&server.uri(), dev_trust(), tokens, Transport::new()).unwrap()
}

#[tokio::test]
async fn a_token_goes_only_to_its_own_origin() {
    let a = MockServer::start().await;
    let b = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    set_token(tokens.as_ref(), &a.uri(), Some("token-a")).unwrap();
    Mock::given(method("GET")).and(path("/api/me")).and(header("authorization", "Bearer token-a")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "user": null }))).expect(1).mount(&a).await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(200)).expect(0).mount(&b).await;
    let ca = client(&a, tokens.clone());
    let cb = client(&b, tokens.clone());
    assert_eq!(ca.get("/api/me").await.unwrap().status, 200);
    // B holds no session, so nothing is sent at all.
    assert_eq!(cb.get("/api/me").await.unwrap_err(), CloudError::NotSignedIn);
}

#[tokio::test]
async fn an_untrusted_or_removed_origin_is_never_sent_anything() {
    let tokens: Arc<dyn TokenStore> = Arc::new(MemoryTokenStore::new());
    let trust: TrustHandle = Arc::new(RwLock::new(Trust::cloud_only()));
    assert!(matches!(CloudClient::new("https://evil.example.com", trust.clone(), tokens.clone(), Transport::new()), Err(CloudError::NotTrusted)));
    *trust.write().unwrap() = Trust::new(["https://docs.example.com".to_string()], false);
    let c = CloudClient::new("https://docs.example.com", trust.clone(), tokens.clone(), Transport::new()).unwrap();
    tokens.put("https://docs.example.com", Some(&Session { token: "t".into(), user_id: None })).unwrap();
    // The user removes the server: the next call stops before the network.
    *trust.write().unwrap() = Trust::cloud_only();
    assert_eq!(c.get("/api/me").await.unwrap_err(), CloudError::NotTrusted);
    // Paths outside the API are refused before the network too.
    *trust.write().unwrap() = Trust::new(["https://docs.example.com".to_string()], false);
    assert_eq!(c.get("/admin").await.unwrap_err(), CloudError::Refused);
    assert_eq!(c.get("/api/../admin").await.unwrap_err(), CloudError::Refused);
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let a = MockServer::start().await;
    let elsewhere = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    set_token(tokens.as_ref(), &a.uri(), Some("tok")).unwrap();
    Mock::given(method("GET")).and(path("/api/docs")).respond_with(ResponseTemplate::new(302).insert_header("location", format!("{}/api/docs", elsewhere.uri()))).mount(&a).await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(200)).expect(0).mount(&elsewhere).await;
    let answer = client(&a, tokens).get("/api/docs").await.unwrap();
    assert_eq!(answer.status, 302);
}

#[tokio::test]
async fn an_oversize_answer_is_refused() {
    let a = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    set_token(tokens.as_ref(), &a.uri(), Some("tok")).unwrap();
    Mock::given(method("GET")).and(path("/api/docs/x/shares")).respond_with(ResponseTemplate::new(200).set_body_string(" ".repeat(3 * 1024 * 1024))).mount(&a).await;
    assert_eq!(client(&a, tokens).get("/api/docs/x/shares").await.unwrap_err(), CloudError::TooLarge);
}

#[tokio::test]
async fn a_rotated_token_replaces_the_stored_one_and_drops_the_account() {
    let a = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    tokens.put(&a.uri(), Some(&Session { token: "old".into(), user_id: Some("u1".into()) })).unwrap();
    Mock::given(method("GET")).and(path("/api/docs")).respond_with(ResponseTemplate::new(200).insert_header("set-auth-token", "fresh").set_body_json(json!({ "docs": [] }))).mount(&a).await;
    let c = client(&a, tokens.clone());
    c.get("/api/docs").await.unwrap();
    assert_eq!(c.session(), Some(Session { token: "fresh".into(), user_id: None }));
}

#[tokio::test]
async fn email_sign_in_takes_the_header_token_and_confirms_it() {
    let a = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    Mock::given(method("POST")).and(path("/api/auth/sign-in/email")).and(body_partial_json(json!({ "email": "ada@example.com" })))
        .respond_with(ResponseTemplate::new(200).insert_header("set-auth-token", "tok").set_body_json(json!({ "token": "tok", "user": { "id": "u1" } })))
        .mount(&a).await;
    Mock::given(method("GET")).and(path("/api/me")).and(header("authorization", "Bearer tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "user": { "id": "u1", "email": "ada@example.com", "name": "Ada" } })))
        .mount(&a).await;
    let c = client(&a, tokens);
    let out = AuthClient::new(&c).sign_in_email("ada@example.com", "pw").await.unwrap();
    assert!(matches!(out, SignInOutcome::SignedIn(ref u) if u.id == "u1"));
    assert_eq!(c.session(), Some(Session { token: "tok".into(), user_id: Some("u1".into()) }));
}

#[tokio::test]
async fn sign_in_calls_carry_no_token() {
    let a = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    set_token(tokens.as_ref(), &a.uri(), Some("existing")).unwrap();
    Mock::given(method("POST")).and(path("/api/auth/sign-in/email")).and(header_exists("authorization")).respond_with(ResponseTemplate::new(500)).expect(0).mount(&a).await;
    Mock::given(method("POST")).and(path("/api/auth/sign-in/email")).respond_with(ResponseTemplate::new(403).set_body_json(json!({ "code": "EMAIL_NOT_VERIFIED" }))).mount(&a).await;
    let c = client(&a, tokens);
    assert_eq!(AuthClient::new(&c).sign_in_email("ada@example.com", "pw").await.unwrap(), SignInOutcome::NeedsVerification);
}

#[tokio::test]
async fn code_sign_in_uses_identities_when_advertised_and_legacy_otherwise() {
    let flow_id = "A".repeat(43);
    let a = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/account/capabilities")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "verifiedIdentities": true }))).mount(&a).await;
    Mock::given(method("POST")).and(path("/api/account/identities/sign-in/start")).and(body_partial_json(json!({ "email": "ada@example.com" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "challengeId": "ch_1", "flowId": flow_id }))).mount(&a).await;
    Mock::given(method("POST")).and(path("/api/account/identities/sign-in/verify")).and(body_partial_json(json!({ "challengeId": "ch_1", "code": "123456" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "token": "code-token" }))).mount(&a).await;
    Mock::given(method("GET")).and(path("/api/me")).and(header("authorization", "Bearer code-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "user": { "id": "u9", "email": "ada@example.com" } }))).mount(&a).await;
    let c = client(&a, Arc::new(MemoryTokenStore::new()));
    let auth = AuthClient::new(&c);
    let flow = auth.send_code(" Ada@Example.com ").await.unwrap();
    assert_eq!(flow, CodeFlow::Identity { email: "ada@example.com".into(), challenge_id: "ch_1".into(), flow_id: flow_id.clone() });
    assert_eq!(auth.verify_code(&flow, "123456").await.unwrap().id, "u9");

    let legacy = MockServer::start().await;
    Mock::given(method("GET")).and(path("/api/account/capabilities")).respond_with(ResponseTemplate::new(404)).mount(&legacy).await;
    Mock::given(method("POST")).and(path("/api/auth/email-otp/send-verification-otp")).and(body_partial_json(json!({ "type": "sign-in" }))).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true }))).expect(1).mount(&legacy).await;
    let c = client(&legacy, Arc::new(MemoryTokenStore::new()));
    assert_eq!(AuthClient::new(&c).send_code("ada@example.com").await.unwrap(), CodeFlow::Legacy { email: "ada@example.com".into() });
}

#[tokio::test]
async fn sync_answers_move_the_record() {
    let a = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    set_token(tokens.as_ref(), &a.uri(), Some("tok")).unwrap();
    Mock::given(method("PUT")).and(path("/api/docs/linked")).and(body_partial_json(json!({ "baseVersion": 2 }))).respond_with(ResponseTemplate::new(409).set_body_json(json!({ "error": "conflict", "serverVersion": 3 }))).mount(&a).await;
    Mock::given(method("PUT")).and(path("/api/docs/linked")).and(body_partial_json(json!({ "baseVersion": 3 }))).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "linked", "version": 4 }))).mount(&a).await;
    Mock::given(method("GET")).and(path("/api/docs/linked")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "doc": { "id": "linked", "name": "a.md", "version": 3, "content": "theirs" } }))).mount(&a).await;
    Mock::given(method("PUT")).and(path("/api/docs/broken")).respond_with(ResponseTemplate::new(200).set_body_string("<html>")).mount(&a).await;
    Mock::given(method("PUT")).and(path_regex_new()).and(body_partial_json(json!({ "baseVersion": 0, "name": "new.md" }))).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "version": 1 }))).mount(&a).await;
    let c = client(&a, tokens);
    let engine = SyncEngine::new(&c, true);

    let (rec, res) = engine.sync_on(&SyncRecord::default(), "new.md", "hello", false).await;
    assert_eq!(res, PushResult::Ok { version: 1 });
    assert_eq!((rec.state, rec.cloud_version), (SyncState::Synced, 1));
    assert_eq!(rec.cloud_doc_id.as_ref().map(|s| s.len()), Some(36));

    let linked = SyncRecord { cloud_doc_id: Some("linked".into()), cloud_version: 2, state: SyncState::Synced, ..Default::default() };
    let (rec, res) = engine.push(&linked, "a.md", "mine", false).await;
    assert_eq!((rec.state, res), (SyncState::Conflict, PushResult::Conflict { server_version: Some(3) }));
    let kb = engine.resolve_keep_both(std::path::Path::new("/d/a.md"), &rec, "mine", |_| false).await.unwrap();
    assert_eq!((kb.original_content.as_str(), kb.original_record.cloud_version, kb.copy_content.as_str()), ("theirs", 3, "mine"));
    let resolved = engine.resolve_overwrite(&rec, "a.md", "mine").await.unwrap();
    assert_eq!((resolved.record.state, resolved.version), (SyncState::Synced, 4));

    let broken = SyncRecord { cloud_doc_id: Some("broken".into()), cloud_version: 1, state: SyncState::Synced, ..Default::default() };
    let (rec, res) = engine.push(&broken, "b.md", "x", false).await;
    assert_eq!((rec.state, res), (SyncState::Unpushed, PushResult::Error(markie_cloud::sync::UNREADABLE.into())));
    assert_eq!(markie_cloud::docs::DocsClient::new(&c).put("nothing-mounted", &markie_cloud::docs::PutDoc { name: "n".into(), content: "".into(), hash: "".into(), base_version: 0, area_id: None, origin: None }).await, PutOutcome::Failed { status: 404 });
}

fn path_regex_new() -> wiremock::matchers::PathRegexMatcher {
    wiremock::matchers::path_regex(r"^/api/docs/[0-9a-f-]{36}$")
}

#[tokio::test]
async fn collab_tickets_and_the_legacy_fallback() {
    let a = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    set_token(tokens.as_ref(), &a.uri(), Some("tok")).unwrap();
    Mock::given(method("POST")).and(path("/api/docs/d1/collab-ticket")).and(body_partial_json(json!({ "schema": 2 }))).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ticket": "T1", "expiresAt": 99 }))).mount(&a).await;
    Mock::given(method("POST")).and(path("/api/docs/d2/collab-ticket")).respond_with(ResponseTemplate::new(404).set_body_json(json!({ "error": "not found" }))).mount(&a).await;
    Mock::given(method("POST")).and(path("/api/docs/d3/collab-ticket")).respond_with(ResponseTemplate::new(404).set_body_json(json!({ "error": "no_ticket" }))).mount(&a).await;
    let c = client(&a, tokens);
    let fresh = SharesClient::new(&c);
    assert_eq!(fresh.collab_ticket("d2").await, CollabTicketAnswer::Legacy);
    assert_eq!(fresh.collab_ticket("d3").await, CollabTicketAnswer::Failed { status: 404 });
    // Once the route has refused by name, a bare 404 is no longer "no route".
    assert_eq!(fresh.collab_ticket("d2").await, CollabTicketAnswer::Failed { status: 404 });
    let s = SharesClient::new(&c);
    assert_eq!(s.collab_ticket("d1").await, CollabTicketAnswer::Ticket { ticket: "T1".into(), expires_at: 99 });
    assert_eq!(s.collab_ticket("d2").await, CollabTicketAnswer::Failed { status: 404 });
}

#[tokio::test]
async fn comment_threads_parse() {
    let a = MockServer::start().await;
    let tokens = Arc::new(MemoryTokenStore::new());
    set_token(tokens.as_ref(), &a.uri(), Some("tok")).unwrap();
    Mock::given(method("GET")).and(path("/api/docs/d1/threads")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "threads": [{
        "id": "t1", "doc_id": "d1", "anchor": { "from": { "type": null }, "to": 4 }, "status": "open", "created_by": "u1", "created_at": "2026-11-21T00:00:00.000Z",
        "comments": [{ "id": "c1", "thread_id": "t1", "author_id": "u1", "author_name": "Ada", "author_email": "ada@example.com", "body": "Hi", "created_at": "2026-11-21T00:00:00.000Z" }]
    }] }))).mount(&a).await;
    let c = client(&a, tokens);
    let threads = CommentsClient::new(&c).list("d1").await.unwrap();
    assert_eq!(threads[0].comments[0].body, "Hi");
    assert_eq!(threads[0].anchor["to"], 4);
}
