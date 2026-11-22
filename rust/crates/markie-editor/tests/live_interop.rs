//! Markie RS and TipTap in one live room on the real Markie server.
//!
//! Run through `interop/run-live.sh`, which boots `server/` on localhost
//! with console mail (nothing is sent anywhere) and sets
//! MARKIE_CLOUD_TEST_SERVER, MARKIE_CLOUD_TEST_LOG and MARKIE_LIVE_DIR.
//! Without them the test does nothing, so `cargo test` stays offline.
//!
//! Alice edits in Markie RS (this process: the session supervisor, the rich
//! binding, the editor model). Bob edits in TipTap (a Node process running
//! the web app's own extensions with y-websocket, `interop/live.test.ts`).
//! Checked both ways: the seeded room, concurrent edits converging to the
//! same Markdown, each side's cursor resolving on the other's screen, each
//! side's comment anchor resolving to the same words, and Bob's socket
//! closing with 4403 when Alice removes him.
use markie_cloud::auth::{AuthClient, SignInOutcome};
use markie_cloud::collab::PeerUser;
use markie_cloud::collab::room::CloseReason;
use markie_cloud::collab::session::{CloudTickets, LiveSession, LiveStatus, SessionOptions};
use markie_cloud::comments::CommentsClient;
use markie_cloud::docs::{DocsClient, PutDoc, PutOutcome, Role};
use markie_cloud::http::Transport;
use markie_cloud::registry::ServerStore;
use markie_cloud::sharing::{PeopleClient, SharesClient};
use markie_cloud::sync::hash_content;
use markie_cloud::tokens::MemoryTokenStore;
use markie_cloud::CloudClient;
use markie_editor::collab::{MODEL_KEY, RichBinding};
use markie_rich::editor::{Editor, Pos};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const DOC: &str = "# Live interop\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph with **bold** and *italic* words.\n\n- first item\n- second item\n";

struct Env {
    base: String,
    log: String,
    dir: PathBuf,
}

fn env() -> Option<Env> {
    let base = std::env::var("MARKIE_CLOUD_TEST_SERVER").ok()?;
    let log = std::env::var("MARKIE_CLOUD_TEST_LOG").ok()?;
    let dir = PathBuf::from(std::env::var("MARKIE_LIVE_DIR").ok()?);
    let u = url::Url::parse(&base).unwrap();
    assert!(matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")), "only against this computer, not {base}");
    Some(Env { base: base.trim_end_matches('/').into(), log, dir })
}

/// An SES mailbox-simulator address: accepted and delivered nowhere. The
/// local server only writes mail to its log anyway.
fn address(label: &str) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 1_000_000_007;
    format!("success+markie-rs-live-{label}-{n}@simulator.amazonses.com")
}

async fn code_for(env: &Env, email: &str) -> String {
    for _ in 0..150 {
        let log = std::fs::read_to_string(&env.log).unwrap_or_default();
        let needle = format!("to={email} subject=\"");
        if let Some(code) = log.lines().filter(|l| l.contains(&needle) && l.contains("verification code")).filter_map(|l| l.split(&needle).nth(1)?.split(' ').next().map(str::to_string)).last() {
            return code;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no code for {email}");
}

async fn sign_up(env: &Env, store: &ServerStore, name: &str) -> (Arc<CloudClient>, String, String) {
    let email = address(&name.to_lowercase().replace(' ', "-"));
    let c = CloudClient::new(&env.base, store.trust_handle(), Arc::new(MemoryTokenStore::new()), Transport::new()).unwrap();
    let auth = AuthClient::new(&c);
    assert_eq!(auth.sign_up_email(&email, "correct horse battery", name).await.unwrap(), SignInOutcome::NeedsVerification);
    let code = code_for(env, &email).await;
    let user = auth.verify_email(&email, &code).await.unwrap().expect("verified");
    (Arc::new(c), email, user.id)
}

fn find(ed: &Editor, needle: &str) -> (Pos, Pos) {
    for b in 0..ed.block_count() {
        for l in 0..ed.leaves_of(b).len() {
            let t: String = ed.units(b, l).iter().map(|u| u.display()).collect();
            if let Some(i) = t.find(needle) {
                let a = t[..i].chars().count();
                return (Pos::new(b, l, a), Pos::new(b, l, a + needle.chars().count()));
            }
        }
    }
    panic!("{needle:?} not in the editor");
}

fn text_of(ed: &Editor, from: Pos, to: Pos) -> String {
    assert_eq!((from.block, from.leaf), (to.block, to.leaf), "one leaf");
    ed.units(from.block, from.leaf)[from.offset..to.offset].iter().map(|u| u.display()).collect()
}

/// Apply waiting room updates and fold them into the editor, once the room
/// is the document (claimed for this model), as the app does.
fn pump(s: &LiveSession, b: &mut RichBinding, ed: &mut Editor) {
    if s.has_inbound() {
        let caret = b.caret(ed);
        s.pump();
        b.refresh();
        if b.has_model() {
            b.pull(ed, caret).expect("Markie RS draws the room");
        }
    }
}

async fn until(s: &LiveSession, b: &mut RichBinding, ed: &mut Editor, secs: u64, what: &str, mut pred: impl FnMut(&LiveSession, &RichBinding, &Editor) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut rx = s.subscribe();
    loop {
        pump(s, b, ed);
        if pred(s, b, ed) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}; status {:?}", s.history());
        let _ = tokio::time::timeout(Duration::from_millis(200), rx.changed()).await;
    }
}

fn wait_file(path: &PathBuf, child: &mut std::process::Child, secs: u64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                return v;
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("the TipTap client exited early ({status}) before writing {}", path.display());
        }
        assert!(Instant::now() < deadline, "no {}", path.display());
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn markie_rs_and_tiptap_share_a_room() {
    let Some(env) = env() else {
        eprintln!("MARKIE_CLOUD_TEST_SERVER is not set; run interop/run-live.sh.");
        return;
    };
    std::fs::create_dir_all(&env.dir).unwrap();
    let mut store = ServerStore::open(None, true);
    let probe = store.probe(&Transport::new(), &env.base).await.expect("server-info");
    store.add(&probe.probe_id).unwrap();

    let (alice, _alice_email, alice_id) = sign_up(&env, &store, "Alice Rust").await;
    let (bob, bob_email, _bob_id) = sign_up(&env, &store, "Bob Tiptap").await;

    // Alice's document, shared with Bob as an editor (a request Bob accepts).
    let doc_id = uuid::Uuid::new_v4().to_string();
    let put = DocsClient::new(&alice).put(&doc_id, &PutDoc { name: "live-interop.md".into(), content: DOC.into(), hash: hash_content(DOC), base_version: 0, area_id: None, origin: None }).await;
    assert!(matches!(put, PutOutcome::Saved { .. }), "{put:?}");
    SharesClient::new(&alice).add(&doc_id, &bob_email, Role::Editor).await.unwrap();
    let bob_people = PeopleClient::new(&bob);
    let (requests, _) = bob_people.requests().await.unwrap();
    bob_people.accept(&requests.iter().find(|r| r.doc_id == doc_id).unwrap().sender.id).await.unwrap();
    assert_eq!(SharesClient::new(&bob).access(&doc_id).await.unwrap().role, Role::Editor);

    // Alice joins in Markie RS and seeds the empty room from her file.
    let rt = tokio::runtime::Handle::current();
    let doc = markie_rich::ydoc::new_doc(rand_id());
    let session = LiveSession::start(
        &rt,
        &env.base,
        &doc_id,
        doc.clone(),
        Arc::new(CloudTickets { client: alice.clone(), doc_id: doc_id.clone() }),
        SessionOptions { user: PeerUser { name: "Alice Rust".into(), color: markie_cloud::collab::color_for_name("Alice Rust").into() }, readonly: false, offer_snapshot_writer: true },
    );
    let mut binding = RichBinding::new(doc.clone());
    let mut ed = Editor::parse(DOC);
    until(&session, &mut binding, &mut ed, 20, "first sync", |s, _, _| s.synced()).await;
    tokio::time::sleep(Duration::from_millis(markie_cloud::collab::SEED_SETTLE_MS)).await;
    assert!(binding.is_empty(), "a new room is empty");
    assert!(session.send_update(binding.seed_update(&ed, false)));
    until(&session, &mut binding, &mut ed, 15, "the seed to come back", |_, b, _| b.has_model()).await;
    assert_eq!(binding.meta(MODEL_KEY), Some(json!(2)));
    assert_eq!(ed.to_markdown(), DOC, "the seed came back as the file");

    // Alice comments on "quick brown" and puts her caret on "lazy".
    let (qf, qt) = find(&ed, "quick brown");
    let anchor = binding.anchor_for(&ed, qf, qt).unwrap();
    let rust_thread = CommentsClient::new(&alice).create_thread(&doc_id, anchor.clone(), "Rust says: fast enough?").await.unwrap();
    let (lf, lt) = find(&ed, "lazy");
    ed.set_selection(lf, lt);
    session.set_cursor(binding.cursor_for(&ed));

    // Bob opens it in TipTap.
    let handoff = env.dir.join("handoff.json");
    std::fs::write(
        &handoff,
        serde_json::to_string_pretty(&json!({
            "base": env.base,
            "docId": doc_id,
            "token": bob.token().unwrap(),
            "rustThreadId": rust_thread,
            "rustAnchor": anchor,
            "dir": env.dir,
        }))
        .unwrap(),
    )
    .unwrap();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = std::process::Command::new("npx")
        .args(["vitest", "run", "--config", "rust/crates/markie-editor/interop/vitest.config.mts"])
        .current_dir(&repo)
        .env("MARKIE_LIVE_HANDOFF", &handoff)
        .stdout(std::fs::File::create(env.dir.join("node.log")).unwrap())
        .stderr(std::fs::File::create(env.dir.join("node.err.log")).unwrap())
        .spawn()
        .expect("npx vitest");

    // Bob reports what TipTap saw of Alice's work, then edits.
    let seen = wait_file(&env.dir.join("tiptap-seen.json"), &mut child, 120);
    assert_eq!(seen["rustCursorText"], "lazy", "Alice's caret on Bob's screen: {seen}");
    assert_eq!(seen["rustAnchorText"], "quick brown", "Alice's comment on Bob's screen: {seen}");
    assert_eq!(seen["roomText"].as_str().unwrap().contains("The quick brown fox"), true);

    // Alice types at the same moment, in the same paragraph, before Bob's edit reaches her.
    let (sf, _) = find(&ed, "over the");
    let _ = sf;
    let (_, after_dog) = find(&ed, "lazy dog");
    ed.set_caret(after_dog, false);
    ed.insert_text(" RUSTEDIT");
    binding.push(&ed);
    until(&session, &mut binding, &mut ed, 30, "Bob's edit", |_, _, e| e.to_markdown().contains("TIPTAP")).await;
    let md = ed.to_markdown();
    assert!(md.contains("jumps TIPTAP over the lazy dog RUSTEDIT."), "{md}");

    // Bob's caret and Bob's comment, on Alice's screen.
    // Bob's caret moves as TipTap focuses and then selects; wait for where it settles.
    until(&session, &mut binding, &mut ed, 20, "Bob's cursor on \"dog\"", |s, b, e| {
        s.peers().iter().any(|p| {
            p.user.name == "Bob Tiptap"
                && p.cursor.as_ref().and_then(|c| b.resolve_cursor(e, &c.anchor, &c.head)).is_some_and(|(x, y)| {
                    let (f, t) = if x <= y { (x, y) } else { (y, x) };
                    (f.block, f.leaf) == (t.block, t.leaf) && text_of(e, f, t) == "dog"
                })
        })
    })
    .await;
    let bob_peer = session.peers().into_iter().find(|p| p.user.name == "Bob Tiptap").unwrap();
    assert_eq!(bob_peer.user.color, markie_cloud::collab::color_for_name("Bob Tiptap"), "the server stamps the colour");
    let c = bob_peer.cursor.unwrap();
    let (ca, ch) = binding.resolve_cursor(&ed, &c.anchor, &c.head).unwrap();
    let (cf, ct) = if ca <= ch { (ca, ch) } else { (ch, ca) };
    assert_eq!(text_of(&ed, cf, ct), "dog");
    let deadline = Instant::now() + Duration::from_secs(30);
    let bobs = loop {
        let threads = CommentsClient::new(&alice).list(&doc_id).await.unwrap();
        if let Some(t) = threads.into_iter().find(|t| t.id != rust_thread) {
            break t;
        }
        assert!(Instant::now() < deadline, "Bob's thread never arrived");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let (bf, bt) = binding.resolve_anchor(&ed, &bobs.anchor).expect("Bob's anchor resolves");
    assert_eq!(text_of(&ed, bf, bt), "fox");
    std::fs::write(env.dir.join("rust-checked.json"), "{\"ok\": true}").unwrap();

    // Both sides converge to the same document.
    let done = wait_file(&env.dir.join("tiptap-done.json"), &mut child, 60);
    let tiptap_md = done["markdown"].as_str().unwrap();
    pump(&session, &mut binding, &mut ed);
    assert_eq!(tiptap_md.trim_end(), ed.to_markdown().trim_end(), "TipTap and Markie RS write the same Markdown");
    assert_eq!(done["room"], markie_rich::room::to_json(&binding.room()), "the same room");
    let status = child.wait().unwrap();
    assert!(status.success(), "the TipTap client's checks passed; see {}", env.dir.join("node.log").display());

    // Evidence for the report.
    std::fs::write(
        env.dir.join("rust-report.json"),
        serde_json::to_string_pretty(&json!({
            "markdown": ed.to_markdown(),
            "tiptapMarkdown": tiptap_md,
            "rustCursorOnTiptap": seen["rustCursorText"],
            "rustAnchorOnTiptap": seen["rustAnchorText"],
            "tiptapCursorOnRust": "dog",
            "tiptapAnchorOnRust": "fox",
            "statuses": format!("{:?}", session.history()),
        }))
        .unwrap(),
    )
    .unwrap();

    // Alice removes a viewer mid-session: their socket closes with 4403 and stays closed.
    let (carol, carol_email, _) = sign_up(&env, &store, "Carol Viewer").await;
    SharesClient::new(&alice).add(&doc_id, &carol_email, Role::Viewer).await.unwrap();
    let carol_people = PeopleClient::new(&carol);
    let (requests, _) = carol_people.requests().await.unwrap();
    carol_people.accept(&requests.iter().find(|r| r.doc_id == doc_id).unwrap().sender.id).await.unwrap();
    let cdoc = markie_rich::ydoc::new_doc(rand_id());
    let carol_session = LiveSession::start(
        &rt,
        &env.base,
        &doc_id,
        cdoc.clone(),
        Arc::new(CloudTickets { client: carol.clone(), doc_id: doc_id.clone() }),
        SessionOptions { user: PeerUser { name: "Carol Viewer".into(), color: "#8b5cf6".into() }, readonly: true, offer_snapshot_writer: false },
    );
    let mut cb = RichBinding::new(cdoc);
    let mut ced = Editor::parse("");
    until(&carol_session, &mut cb, &mut ced, 20, "Carol's sync", |s, b, _| s.synced() && !b.is_empty()).await;
    assert_eq!(ced.to_markdown().trim_end(), ed.to_markdown().trim_end());
    until(&session, &mut binding, &mut ed, 20, "Carol's presence", |s, _, _| s.peers().iter().any(|p| p.user.name == "Carol Viewer")).await;
    // Presence outlives y-protocols' 30 s timeout: renewals raise the clock,
    // so the server and every peer keep taking them.
    tokio::time::sleep(Duration::from_secs(36)).await;
    pump(&carol_session, &mut cb, &mut ced);
    assert!(carol_session.peers().iter().any(|p| p.user.name == "Alice Rust"), "Alice is still present after 36 s: {:?}", carol_session.peers());
    assert!(session.peers().iter().any(|p| p.user.name == "Carol Viewer"), "Carol is still present after 36 s");
    assert_eq!(session.history().1, 1, "no reconnect: the room kept talking");
    SharesClient::new(&alice).remove(&doc_id, &carol_id(&carol).await).await.unwrap();
    until(&carol_session, &mut cb, &mut ced, 20, "the 4403", |s, _, _| s.status().is_final()).await;
    assert_eq!(carol_session.status(), LiveStatus::Closed(CloseReason::AccessRevoked));
    let _ = alice_id;
    session.shutdown().await;
}

async fn carol_id(c: &CloudClient) -> String {
    AuthClient::new(c).me().await.unwrap().unwrap().id
}

fn rand_id() -> u64 {
    (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64 ^ 0x9e37_79b9) & 0xffff_ffff
}
