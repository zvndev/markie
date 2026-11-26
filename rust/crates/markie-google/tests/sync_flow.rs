//! Two-way sync against the fake Google (src/fake.rs): write-back as small
//! requests, no ping-pong, merging with a collaborator through
//! `targetRevisionId`, conflicts, read-only constructs, suggestions, 429s,
//! trash, unshare, deleted files and change detection. Never the real Google.
use chrono::{Local, TimeZone};
use markie_google::api::{DocsSource, DriveFile, GoogleApi, SyncSource};
use markie_google::connect::connect_and_pick;
use markie_google::fake::{FakeGoogle, Role};
use markie_google::store::{self, Stopped};
use markie_google::sync::{Detect, Detector, Synced, sync_doc};
use markie_google::tokens::Grant;
use markie_google::{GoogleError, import};
use markie_vault::device::MemorySecretStore;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

mod common;

fn now() -> chrono::DateTime<Local> {
    Local.with_ymd_and_hms(2026, 11, 26, 10, 15, 0).unwrap()
}

/// A one-tab Doc of (text, named style) paragraphs.
fn doc(paras: &[(&str, &str)]) -> Value {
    let content: Vec<Value> = paras
        .iter()
        .map(|(t, style)| json!({"paragraph": {"elements": [{"textRun": {"content": format!("{t}\n"), "textStyle": {}}}], "paragraphStyle": {"namedStyleType": style}}}))
        .collect();
    json!({"tabs": [{"tabProperties": {"tabId": "t.0", "title": "Tab 1"}, "documentTab": {"body": {"content": content}}}]})
}

fn plain(texts: &[&str]) -> Value {
    doc(&texts.iter().map(|t| (*t, "NORMAL_TEXT")).collect::<Vec<_>>())
}

struct World {
    google: FakeGoogle,
    grant: Grant<MemorySecretStore>,
    db: Connection,
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        Self { google: FakeGoogle::start(), grant: Grant::new(MemorySecretStore::default()), db: Connection::open_in_memory().unwrap(), dir: tempfile::tempdir().unwrap() }
    }

    /// Pick and import `ids` with two-way sync on; returns their files.
    fn import(&self, ids: &[&str]) -> Vec<PathBuf> {
        self.google.set_pick(ids);
        let cfg = self.google.config();
        connect_and_pick(&cfg, &self.grant, None, &|url| {
            let url = url.to_string();
            std::thread::spawn(move || FakeGoogle::browse(&url));
        }, &AtomicBool::new(false), Duration::from_secs(20))
        .unwrap();
        let api = GoogleApi::new(&cfg, &self.grant);
        let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
        let report = import::import_picked(&api, &self.db, &self.dir.path().join("Google Docs"), &ids, now(), true, &mut |_| {}, &AtomicBool::new(false)).unwrap();
        report.imported.into_iter().map(|i| i.path).collect()
    }

    fn sync(&self, path: &Path) -> markie_google::Result<markie_google::sync::Report> {
        let cfg = self.google.config();
        let api = GoogleApi::new(&cfg, &self.grant);
        sync_doc(&api, &self.db, path, now(), None)
    }

    fn sync_with(&self, src: &dyn SyncSource, path: &Path) -> markie_google::Result<markie_google::sync::Report> {
        sync_doc(src, &self.db, path, now(), None)
    }

    fn writes(&self) -> usize {
        self.google.writes().len()
    }
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn a_local_edit_goes_back_as_a_small_diff_and_never_bounces() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["Intro", "Hello world", "Outro"]));
    let path = w.import(&["d1"])[0].clone();
    assert_eq!(read(&path), "Intro\n\nHello world\n\nOutro\n");
    std::fs::write(&path, "Intro\n\nHello brave world\n\nOutro\n").unwrap();
    let r = w.sync(&path).unwrap();
    assert_eq!(r.outcome, Synced::Pushed { pulled: false });
    // One write, aimed at the revision read, with only the new words.
    let (id, body) = &w.google.writes()[0];
    assert_eq!(id, "d1");
    assert_eq!(body["writeControl"], json!({"targetRevisionId": "rev-d1-1"}));
    assert_eq!(body["requests"][0], json!({"insertText": {"location": {"index": 13}, "text": "brave "}}));
    assert!(!w.google.log().iter().any(|l| l.starts_with("PATCH") || l.contains("/upload/")), "never files.update with content");
    assert_eq!(w.google.markdown("d1"), "Intro\n\nHello brave world\n\nOutro\n");
    // The new base, revision and version are stored; the next round does nothing.
    let rec = store::get(&w.db, &path).unwrap().unwrap();
    assert_eq!((rec.version.as_deref(), rec.revision_id.as_deref()), (Some("2"), Some("rev-d1-2")));
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Unchanged);
    assert_eq!(w.writes(), 1, "no empty or repeated batchUpdate");
    assert_eq!(read(&path), "Intro\n\nHello brave world\n\nOutro\n");
}

#[test]
fn the_files_own_spelling_is_never_rewritten() {
    let w = World::new();
    w.google.add_doc("d1", "List", 1, doc(&[("Top", "HEADING_1"), ("Body", "NORMAL_TEXT")]));
    let path = w.import(&["d1"])[0].clone();
    // Same content, different spelling: a setext heading and a hard-wrapped paragraph.
    std::fs::write(&path, "Top\n===\n\nBody\n").unwrap();
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Unchanged);
    assert_eq!(w.writes(), 0);
    // A change in Google elsewhere comes in without touching the heading's spelling.
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 5}, "text": "More "}})]);
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Pulled);
    assert_eq!(read(&path), "Top\n===\n\nMore Body\n");
    assert_eq!(w.writes(), 0);
}

/// Lets a collaborator edit the Doc after Markie read it and before it writes.
struct Race<'a> {
    inner: &'a dyn SyncSource,
    google: &'a FakeGoogle,
    edit: Vec<Value>,
    done: std::cell::Cell<bool>,
}
unsafe impl Sync for Race<'_> {}
impl DocsSource for Race<'_> {
    fn file(&self, id: &str) -> markie_google::Result<DriveFile> {
        self.inner.file(id)
    }
    fn document(&self, id: &str) -> markie_google::Result<Value> {
        self.inner.document(id)
    }
    fn export(&self, id: &str, mime: &str) -> markie_google::Result<Vec<u8>> {
        self.inner.export(id, mime)
    }
    fn folder_docs(&self, id: &str) -> markie_google::Result<Vec<DriveFile>> {
        self.inner.folder_docs(id)
    }
}
impl SyncSource for Race<'_> {
    fn batch_update(&self, id: &str, requests: &[Value], rev: &str, suggest: bool) -> markie_google::Result<Value> {
        if !self.done.replace(true) {
            self.google.collaborate(id, &self.edit);
        }
        self.inner.batch_update(id, requests, rev, suggest)
    }
    fn start_page_token(&self) -> markie_google::Result<String> {
        self.inner.start_page_token()
    }
    fn changed_since(&self, t: &str) -> markie_google::Result<(Vec<String>, String)> {
        self.inner.changed_since(t)
    }
}

#[test]
fn google_merges_a_collaborators_edit_made_while_markie_was_writing() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["First", "Second", "Third"]));
    let path = w.import(&["d1"])[0].clone();
    std::fs::write(&path, "First\n\nSecond\n\nThird, from Markie\n").unwrap();
    let cfg = w.google.config();
    let api = GoogleApi::new(&cfg, &w.grant);
    // The collaborator types at the start of "First" (index 1) in the meantime.
    let race = Race { inner: &api, google: &w.google, edit: vec![json!({"insertText": {"location": {"index": 1}, "text": "Very "}})], done: Default::default() };
    let r = w.sync_with(&race, &path).unwrap();
    assert_eq!(r.outcome, Synced::Pushed { pulled: true });
    assert_eq!(w.google.markdown("d1"), "Very First\n\nSecond\n\nThird, from Markie\n");
    // The file has both: the collaborator's words came back after the write.
    assert_eq!(read(&path), "Very First\n\nSecond\n\nThird, from Markie\n");
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Unchanged);
}

#[test]
fn different_paragraphs_merge_both_ways_with_no_conflict() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["One", "Two", "Three"]));
    let path = w.import(&["d1"])[0].clone();
    std::fs::write(&path, "One, mine\n\nTwo\n\nThree\n").unwrap();
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 14}, "text": ", theirs"}})]);
    let r = w.sync(&path).unwrap();
    assert_eq!(r.outcome, Synced::Pushed { pulled: true });
    assert_eq!(w.google.markdown("d1"), "One, mine\n\nTwo\n\nThree, theirs\n");
    assert_eq!(read(&path), "One, mine\n\nTwo\n\nThree, theirs\n");
    assert!(store::get(&w.db, &path).unwrap().unwrap().conflict.is_none());
}

#[test]
fn the_same_paragraph_on_both_sides_keeps_googles_text_and_a_conflict_copy() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["One", "Two", "Three"]));
    let path = w.import(&["d1"])[0].clone();
    std::fs::write(&path, "One\n\nTwo, Markie's\n\nThree and more\n").unwrap();
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 8}, "text": ", Google's"}})]);
    let Synced::Conflict { copy, pushed } = w.sync(&path).unwrap().outcome else { panic!("a conflict") };
    assert!(pushed, "the other paragraph still went");
    assert_eq!(copy.file_name().unwrap().to_string_lossy(), "Plan (conflict 2026-11-26 10.15).md");
    assert_eq!(read(&copy), "One\n\nTwo, Markie's\n\nThree and more\n");
    assert_eq!(w.google.markdown("d1"), "One\n\nTwo, Google's\n\nThree and more\n");
    assert_eq!(read(&path), "One\n\nTwo, Google's\n\nThree and more\n");
    assert_eq!(store::get(&w.db, &path).unwrap().unwrap().conflict, Some(copy));
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Unchanged);
}

#[test]
fn comments_and_untouched_text_survive_a_write() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["Keep this sentence.", "Edit here please"]));
    let c1 = w.google.add_comment("d1", "this sentence");
    let c2 = w.google.add_comment("d1", "Edit");
    let path = w.import(&["d1"])[0].clone();
    std::fs::write(&path, "Keep this sentence.\n\nEdit here, done, please\n").unwrap();
    w.sync(&path).unwrap();
    let f = w.google.file("d1");
    assert_eq!(f.anchored(c1), "this sentence");
    assert_eq!(f.anchored(c2), "Edit", "an edit later in the paragraph leaves the anchor alone");
}

#[test]
fn tables_and_images_stay_read_only_and_say_so() {
    let w = World::new();
    let mut d = plain(&["Before"]);
    let content = d.pointer_mut("/tabs/0/documentTab/body/content").unwrap().as_array_mut().unwrap();
    content.push(json!({"table": {"rows": 1, "columns": 1, "tableRows": [{"tableCells": [{"content": [{"paragraph": {"elements": [{"textRun": {"content": "Pen\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}]}]}]}}));
    content.push(json!({"paragraph": {"elements": [{"textRun": {"content": "After\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}));
    w.google.add_doc("d1", "Plan", 1, d);
    let path = w.import(&["d1"])[0].clone();
    let text = read(&path);
    assert!(text.contains("| Pen |"), "{text}");
    std::fs::write(&path, text.replace("Pen", "Pencil").replace("After", "After, edited")).unwrap();
    let r = w.sync(&path).unwrap();
    assert_eq!(r.held, ["tables"]);
    let md = w.google.markdown("d1");
    assert!(md.contains("| Pen |") && md.contains("After, edited"), "{md}");
    // The local table edit stays in the file, and the next round sends nothing.
    assert!(read(&path).contains("Pencil"));
    let n = w.writes();
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Unchanged);
    assert_eq!(w.writes(), n);
    assert_eq!(store::get(&w.db, &path).unwrap().unwrap().held, ["tables"]);
}

#[test]
fn docs_owned_by_someone_else_get_suggestions() {
    let w = World::new();
    w.google.add_doc("d1", "Shared", 1, plain(&["Their text", "More"]));
    w.google.set_role("d1", Role::Writer);
    let path = w.import(&["d1"])[0].clone();
    let rec = store::get(&w.db, &path).unwrap().unwrap();
    assert!(rec.suggest, "on by default for a Doc this account does not own");
    std::fs::write(&path, "Their text, suggested\n\nMore\n").unwrap();
    w.sync(&path).unwrap();
    let (_, body) = &w.google.writes()[0];
    assert_eq!(body["writeControl"]["writeMode"], "SUGGEST");
    assert!(w.google.file("d1").model.unwrap().has_suggestions());
    // Read as accepted, the Doc says what the file says: no second write.
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Unchanged);
    assert_eq!(w.writes(), 1);
    // The owner rejects it: Google's text wins and comes back.
    w.google.resolve_suggestions("d1", false);
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Pulled);
    assert_eq!(read(&path), "Their text\n\nMore\n");
}

#[test]
fn commenters_only_suggest_and_viewers_never_write() {
    let w = World::new();
    w.google.add_doc("c1", "Comment only", 1, plain(&["Words"]));
    w.google.add_doc("v1", "View only", 1, plain(&["Words"]));
    w.google.set_role("c1", Role::Commenter);
    w.google.set_role("v1", Role::Reader);
    let paths = w.import(&["c1", "v1"]);
    for p in &paths {
        std::fs::write(p, "Words, mine\n").unwrap();
    }
    w.sync(&paths[0]).unwrap();
    assert_eq!(w.google.writes()[0].1["writeControl"]["writeMode"], "SUGGEST");
    let r = w.sync(&paths[1]).unwrap();
    assert_eq!(r.held, ["view-only Docs"]);
    assert_eq!(w.writes(), 1);
    assert_eq!(read(&paths[1]), "Words, mine\n", "the local edit is kept");
}

#[test]
fn a_429_or_no_network_leaves_the_file_alone_and_retries_later() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["One"]));
    let path = w.import(&["d1"])[0].clone();
    std::fs::write(&path, "One, edited\n").unwrap();
    w.google.state.lock().unwrap().throttle = 1;
    assert!(matches!(w.sync(&path).unwrap_err(), GoogleError::RateLimited { retry_after_secs: Some(1) }));
    assert_eq!(read(&path), "One, edited\n");
    w.google.state.lock().unwrap().offline = true;
    assert!(w.sync(&path).unwrap_err().is_transient());
    assert_eq!(read(&path), "One, edited\n");
    assert!(store::get(&w.db, &path).unwrap().unwrap().error.is_some());
    w.google.state.lock().unwrap().offline = false;
    assert_eq!(w.sync(&path).unwrap().outcome, Synced::Pushed { pulled: false });
    assert_eq!(w.google.markdown("d1"), "One, edited\n");
    assert!(store::get(&w.db, &path).unwrap().unwrap().error.is_none());
}

#[test]
fn trashed_unshared_and_deleted_stop_sync_and_keep_files() {
    let w = World::new();
    w.google.add_doc("t1", "Trashed", 1, plain(&["a"]));
    w.google.add_doc("u1", "Unshared", 1, plain(&["b"]));
    w.google.add_doc("f1", "Deleted here", 1, plain(&["c"]));
    let p = w.import(&["t1", "u1", "f1"]);
    w.google.trash("t1");
    w.google.unshare("u1");
    std::fs::remove_file(&p[2]).unwrap();
    assert_eq!(w.sync(&p[0]).unwrap().outcome, Synced::Stopped(Stopped::Trashed));
    assert_eq!(w.sync(&p[1]).unwrap().outcome, Synced::Stopped(Stopped::NoAccess));
    let before = w.google.log().len();
    assert_eq!(w.sync(&p[2]).unwrap().outcome, Synced::Stopped(Stopped::FileDeleted));
    assert_eq!(w.google.log().len(), before, "a file deleted here never reaches Drive");
    assert_eq!(read(&p[0]), "a\n");
    assert_eq!(read(&p[1]), "b\n");
    assert!(!w.google.file("f1").meta["trashed"].as_bool().unwrap());
    // Stopped stays stopped.
    assert_eq!(w.sync(&p[0]).unwrap().outcome, Synced::Stopped(Stopped::Trashed));
}

#[test]
fn a_doc_with_tabs_pulls_but_never_writes() {
    let w = World::new();
    let tab = |t: &str| json!({"tabProperties": {"title": t}, "documentTab": {"body": {"content": [{"paragraph": {"elements": [{"textRun": {"content": format!("{t} text\n"), "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}]}}});
    w.google.add_doc("m1", "Tabs", 1, json!({"tabs": [tab("One"), tab("Two")]}));
    let path = w.import(&["m1"])[0].clone();
    std::fs::write(&path, read(&path).replace("Two text", "Two text, edited")).unwrap();
    let r = w.sync(&path).unwrap();
    assert_eq!(r.held, ["Docs with tabs"]);
    assert_eq!(w.writes(), 0);
    assert!(read(&path).contains("edited"));
}

#[test]
fn a_renamed_file_keeps_syncing_and_refresh_only_files_are_left_alone() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["One"]));
    let path = w.import(&["d1"])[0].clone();
    let moved = path.with_file_name("Renamed.md");
    std::fs::rename(&path, &moved).unwrap();
    store::move_path(&w.db, &path, &moved).unwrap();
    std::fs::write(&moved, "One, renamed\n").unwrap();
    assert_eq!(w.sync(&moved).unwrap().outcome, Synced::Pushed { pulled: false });
    // Two-way off: Refresh only.
    let mut rec = store::get(&w.db, &moved).unwrap().unwrap();
    rec.two_way = false;
    store::put(&w.db, &moved, &rec).unwrap();
    std::fs::write(&moved, "One, not sent\n").unwrap();
    assert_eq!(w.sync(&moved).unwrap().outcome, Synced::RefreshOnly);
    assert_eq!(w.google.markdown("d1"), "One, renamed\n");
}

#[test]
fn new_headings_lists_and_marks_reach_the_doc() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["Intro"]));
    let path = w.import(&["d1"])[0].clone();
    let local = "Intro\n\n## Steps\n\n1. Gather **tools**\n2. Build\n    - check `level`\n\n- [ ] Ship it\n\nSee [the guide](https://example.com/guide) and ~~old~~ *new*.\n";
    std::fs::write(&path, local).unwrap();
    let r = w.sync(&path).unwrap();
    assert!(r.held.is_empty(), "{:?}", r.held);
    assert_eq!(markie_google::md::parse(&w.google.markdown("d1")).keys(), markie_google::md::parse(local).keys());
    assert_eq!(read(&path), local, "the file is not rewritten");
}

fn records(w: &World) -> Vec<(PathBuf, store::SyncRecord)> {
    store::all(&w.db).unwrap()
}

#[test]
fn changes_list_is_trusted_once_it_lists_a_picked_doc() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["One"]));
    w.import(&["d1"]);
    let cfg = w.google.config();
    let api = GoogleApi::new(&cfg, &w.grant);
    let mut d = Detector::new(None);
    let t = Instant::now();
    assert!(d.poll(&api, &records(&w), t).unwrap().is_empty());
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 1}, "text": "x"}})]);
    assert_eq!(d.poll(&api, &records(&w), t).unwrap(), ["d1"]);
    assert_eq!(d.mode, Some(Detect::Changes));
}

#[test]
fn when_changes_list_misses_picks_each_docs_version_is_checked() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["One"]));
    w.import(&["d1"]);
    w.google.state.lock().unwrap().changes_cover_picks = false;
    let cfg = w.google.config();
    let api = GoogleApi::new(&cfg, &w.grant);
    let mut d = Detector::new(None);
    let t = Instant::now();
    d.poll(&api, &records(&w), t).unwrap();
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 1}, "text": "x"}})]);
    // The version sweep finds it even though changes.list doesn't.
    assert_eq!(d.poll(&api, &records(&w), t).unwrap(), ["d1"]);
    // The next poll settles it: changes.list doesn't list picks here.
    d.poll(&api, &records(&w), t).unwrap();
    assert_eq!(d.mode, Some(Detect::Versions));
}

#[test]
fn import_offers_two_way_and_step_one_files_stay_refresh_only() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, plain(&["One"]));
    let p = w.import(&["d1"]);
    assert!(store::get(&w.db, &p[0]).unwrap().unwrap().two_way);
    let api_cfg = w.google.config();
    let api = GoogleApi::new(&api_cfg, &w.grant);
    w.google.add_doc("d2", "Other", 1, plain(&["Two"]));
    w.google.set_pick(&["d1", "d2"]);
    w.google.state.lock().unwrap().files.get_mut("d2").unwrap().granted = true;
    let r = import::import_picked(&api, &w.db, &w.dir.path().join("Google Docs"), &["d2".into()], now(), false, &mut |_| {}, &AtomicBool::new(false)).unwrap();
    assert!(!store::get(&w.db, &r.imported[0].path).unwrap().unwrap().two_way);
}

/// Random edits here and by a collaborator at once: after one round the
/// file and the Doc say the same, and the next round does nothing.
#[test]
fn random_edits_on_both_sides_converge_without_ping_pong() {
    use common::*;
    use markie_google::merge::diff3;
    use markie_google::model::Mode;
    use markie_google::plan::{plan, remote_view};
    let keys = |s: &str| markie_google::md::parse(s).blocks.into_iter().map(|b| b.key).collect::<Vec<_>>();
    let mut checked = 0;
    for seed in 1..=seeds(40) {
        let mut r = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15) | 1);
        let mut blocks: Vec<B> = (0..2 + r.below(6)).map(|_| block(&mut r, false)).collect();
        fix_levels(&mut blocks);
        let base = render(&blocks);
        // The Doc, made from the base through the planner.
        let empty = remote_view(&empty_doc()).unwrap();
        let local = markie_google::md::parse(&base);
        let p = plan(&empty, &local, &diff3(&empty.parsed.keys(), &local.keys(), &empty.parsed.keys()), Mode::Edit);
        if !p.held.is_empty() {
            continue;
        }
        let w = World::new();
        w.google.add_doc("d1", "Fuzz", 1, p.after.to_doc());
        let path = w.import(&["d1"])[0].clone();
        // A collaborator's edit, as Docs requests.
        let mut theirs = blocks.clone();
        edit(&mut r, &mut theirs);
        fix_levels(&mut theirs);
        let doc = w.google.file("d1").doc().unwrap();
        let view = remote_view(&doc).unwrap();
        let tl = markie_google::md::parse(&render(&theirs));
        let tp = plan(&view, &tl, &diff3(&view.parsed.keys(), &tl.keys(), &view.parsed.keys()), Mode::Edit);
        if !tp.held.is_empty() {
            continue;
        }
        w.google.collaborate("d1", &tp.requests);
        // Markie's edit.
        let mut mine = blocks.clone();
        edit(&mut r, &mut mine);
        fix_levels(&mut mine);
        std::fs::write(&path, render(&mine)).unwrap();
        let report = w.sync(&path).unwrap_or_else(|e| panic!("seed {seed}: {e:?}\n--- base\n{base}--- theirs\n{}--- mine\n{}", render(&theirs), render(&mine)));
        if !report.held.is_empty() {
            continue;
        }
        let (file, gdoc) = (read(&path), w.google.markdown("d1"));
        assert_eq!(keys(&file), keys(&gdoc), "seed {seed}: file and Doc differ\n--- base\n{base}--- theirs\n{}--- mine\n{}--- file\n{file}--- doc\n{gdoc}", render(&theirs), render(&mine));
        let n = w.writes();
        assert_eq!(w.sync(&path).unwrap().outcome, Synced::Unchanged, "seed {seed}: a second round changed something");
        assert_eq!(w.writes(), n, "seed {seed}: ping-pong");
        checked += 1;
    }
    assert!(checked > 20, "only {checked} seeds were checked");
}
