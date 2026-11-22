use markie_agent::{cloud, tokens};
use markie_cloud::{
    CloudClient,
    http::Transport,
    origin::Trust,
    sync::{SyncRecord, SyncState},
    tokens::{MemoryTokenStore, set_token},
};
use serde_json::json;
use std::{
    fs,
    sync::{Arc, RwLock},
};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, header, method, path, path_regex},
};

fn client(server: &MockServer) -> CloudClient {
    let store = Arc::new(MemoryTokenStore::new());
    set_token(store.as_ref(), &server.uri(), Some("scratch-fixture")).unwrap();
    CloudClient::new(
        &server.uri(),
        Arc::new(RwLock::new(Trust::new([], true))),
        store,
        Transport::new(),
    )
    .unwrap()
}

#[tokio::test]
async fn sync_keeps_attribution_on_creation_only_and_reports_private_link() {
    let server = MockServer::start().await;
    let client = client(&server);
    let scratch = tempfile::tempdir().unwrap();
    let file = scratch.path().join("plan [one].md");
    fs::write(&file, "# Scratch\n").unwrap();
    let doc = cloud::Document::resolve(file.to_str().unwrap(), scratch.path()).unwrap();
    let initial = SyncRecord::default();
    assert_eq!(doc.describe(&initial)["syncState"], "local");
    Mock::given(method("PUT")).and(path_regex("^/api/docs/[^/]+$")).and(header("authorization", "Bearer scratch-fixture"))
        .and(body_partial_json(json!({"name":"plan [one].md","content":"# Scratch\n","baseVersion":0,"origin":{"kind":"agent","agent":"Test Agent"}})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"version":1}))).expect(1).mount(&server).await;
    let (synced, response) = cloud::sync(&client, &doc, &initial, " Test\nAgent ").await;
    let response = response.unwrap();
    let id = synced.cloud_doc_id.as_ref().unwrap();
    assert_eq!(synced.state, SyncState::Synced);
    assert_eq!(response["privateLink"], format!("{}/d/{id}", server.uri()));
    assert!(
        response["markdownLink"]
            .as_str()
            .unwrap()
            .starts_with("[plan \\[one\\].md](")
    );
    Mock::given(method("PUT"))
        .and(path(format!("/api/docs/{id}")))
        .and(|r: &wiremock::Request| {
            r.body_json::<serde_json::Value>()
                .is_ok_and(|b| b["baseVersion"] == 1 && b.get("origin").is_none())
        })
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({"serverVersion":2})))
        .expect(1)
        .mount(&server)
        .await;
    let (conflict, response) = cloud::sync(&client, &doc, &synced, "Other agent").await;
    assert_eq!(conflict.state, SyncState::Conflict);
    assert!(response.unwrap_err().contains("changed in Markie Cloud"));
}

#[tokio::test]
async fn public_link_reads_do_not_create_and_live_docs_refuse_creation() {
    let server = MockServer::start().await;
    let client = client(&server);
    let scratch = tempfile::tempdir().unwrap();
    let make = |name: &str| {
        let file = scratch.path().join(name);
        fs::write(&file, "# Scratch\n").unwrap();
        cloud::Document::resolve(file.to_str().unwrap(), scratch.path()).unwrap()
    };
    let doc = make("file.md");
    let live = make("file.wd");
    let record = SyncRecord {
        cloud_doc_id: Some("doc".into()),
        cloud_origin: Some(server.uri()),
        state: SyncState::Synced,
        ..SyncRecord::default()
    };
    let route = "/api/docs/doc/public-link";
    Mock::given(method("GET"))
        .and(path(route))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"url":null})))
        .expect(3)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(route))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"url":"https://example.test/public"})),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(route))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    assert!(
        matches!(cloud::public_status(&client, &doc, &record, false).await.unwrap(), cloud::PublicStatus::Done(v) if v["publicLink"].is_null())
    );
    assert!(matches!(
        cloud::public_status(&client, &doc, &record, true)
            .await
            .unwrap(),
        cloud::PublicStatus::Confirm
    ));
    assert!(
        matches!(cloud::public_status(&client, &live, &record, true).await, Err(e) if e == cloud::LIVE_DOC_PRIVATE)
    );
    assert!(cloud::create_public(&client, &live, &record).await.is_err());
    assert_eq!(
        cloud::create_public(&client, &doc, &record).await.unwrap()["publicLink"],
        "https://example.test/public"
    );
    assert!(cloud::revoke_public(&client, &doc, &record).await.unwrap()["publicLink"].is_null());
}

#[tokio::test]
async fn remote_tokens_list_create_and_idempotent_revoke() {
    let server = MockServer::start().await;
    let client = client(&server);
    let route = "/api/agent-tokens";
    Mock::given(method("GET")).and(path(route)).and(header("authorization", "Bearer scratch-fixture"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"tokens":[{"id":"1","name":"Phone","prefix":"fixture","createdAt":123},{"name":"malformed"}]}))).expect(1).mount(&server).await;
    Mock::given(method("POST"))
        .and(path(route))
        .and(body_partial_json(json!({"name":"Phone"})))
        .respond_with(
            ResponseTemplate::new(201)
                .set_body_json(json!({"id":"1","name":"Phone","token":"made-up-token-for-test"})),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/agent-tokens/1"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(tokens::list(&client).await.unwrap()[0].name, "Phone");
    let token = tokens::create(&client, " Phone ").await.unwrap();
    assert_eq!(token.id, "1");
    assert!(tokens::config(&tokens::url(&server.uri()), &token.token).contains("Authorization"));
    assert!(tokens::create(&client, &"x".repeat(65)).await.is_err());
    tokens::revoke(&client, &token.id).await.unwrap();
}
