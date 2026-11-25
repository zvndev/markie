//! The whole one-way import against the fake Google (src/fake.rs): connect
//! through the Picker redirect, import, collide, refresh, keep conflict
//! copies, save as Word. Never the real Google, never the real Keychain.
use chrono::{Local, TimeZone};
use markie_google::api::GoogleApi;
use markie_google::connect::connect_and_pick;
use markie_google::fake::FakeGoogle;
use markie_google::import::{self, Outcome};
use markie_google::store;
use markie_google::tokens::{ACCOUNT, Grant};
use markie_google::{GoogleError, DOC_MIME};
use markie_vault::device::{MemorySecretStore, SecretStore};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

fn doc(text: &str) -> Value {
    json!({"tabs": [{"tabProperties": {"title": "Tab 1"}, "documentTab": {"body": {"content": [
        {"paragraph": {"elements": [{"textRun": {"content": format!("{text}\n"), "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}
    ]}}}]})
}

fn now() -> chrono::DateTime<Local> {
    Local.with_ymd_and_hms(2026, 11, 25, 14, 3, 0).unwrap()
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

    fn folder(&self) -> std::path::PathBuf {
        self.dir.path().join("Google Docs")
    }

    /// One "Import from Google Docs…": the fake browser picks `ids`.
    fn pick(&self, ids: &[&str]) -> markie_google::Result<markie_google::connect::Picked> {
        self.google.set_pick(ids);
        let cfg = self.google.config();
        connect_and_pick(&cfg, &self.grant, None, &|url| {
            let url = url.to_string();
            std::thread::spawn(move || FakeGoogle::browse(&url));
        }, &AtomicBool::new(false), Duration::from_secs(20))
    }

    fn import(&self, ids: &[String]) -> import::Report {
        let cfg = self.google.config();
        let api = GoogleApi::new(&cfg, &self.grant);
        import::import_picked(&api, &self.db, &self.folder(), ids, now(), &mut |_| {}, &AtomicBool::new(false)).unwrap()
    }

    fn refresh(&self, path: &std::path::Path) -> markie_google::Result<Outcome> {
        let cfg = self.google.config();
        let api = GoogleApi::new(&cfg, &self.grant);
        import::refresh(&api, &self.db, path, now())
    }
}

#[test]
fn connecting_runs_the_picker_with_pkce_and_keeps_only_the_refresh_token() {
    let w = World::new();
    w.google.add_doc("docA1", "Plan", 3, doc("Hello"));
    let picked = w.pick(&["docA1"]).unwrap();
    assert_eq!(picked.file_ids, ["docA1"]);
    assert_eq!(picked.email.as_deref(), Some("sample.person@example.com"));
    // The refresh token is in the secret store under Markie's one account.
    assert!(w.grant.connected());
    assert!(w.grant.secrets().get(ACCOUNT).unwrap().starts_with(b"refresh-"));
    let log = w.google.log();
    assert!(log.contains(&"GET /o/oauth2/v2/auth".to_string()));
    assert!(log.contains(&"POST /token".to_string()));
}

#[test]
fn saying_no_in_the_browser_stores_nothing() {
    let w = World::new();
    w.google.state.lock().unwrap().deny = true;
    assert_eq!(w.pick(&[]).unwrap_err(), GoogleError::Cancelled);
    assert!(!w.grant.connected());
}

#[test]
fn an_expired_access_token_is_refreshed_and_a_revoked_grant_asks_to_reconnect() {
    let w = World::new();
    w.google.add_doc("docA1", "Plan", 1, doc("Hello"));
    w.pick(&["docA1"]).unwrap();
    // Google forgets the access token: the next call refreshes once and works.
    w.google.state.lock().unwrap().access_tokens.clear();
    let report = w.import(&["docA1".into()]);
    assert_eq!(report.imported.len(), 1, "{report:?}");
    // Google forgets the grant: the person must connect again, and the Keychain item goes.
    {
        let mut s = w.google.state.lock().unwrap();
        s.access_tokens.clear();
        s.refresh_tokens.clear();
    }
    let path = report.imported[0].path.clone();
    w.google.edit_doc("docA1", 2, doc("Changed"));
    assert_eq!(w.refresh(&path).unwrap_err(), GoogleError::Reconnect);
    assert!(!w.grant.connected());
}

#[test]
fn disconnecting_revokes_and_clears_the_secret_store() {
    let w = World::new();
    w.pick(&[]).unwrap();
    let cfg = w.google.config();
    w.grant.disconnect(&markie_google::oauth::http_client(), &cfg).unwrap();
    assert!(!w.grant.connected());
    assert!(w.google.state.lock().unwrap().refresh_tokens.is_empty());
    assert!(w.google.log().contains(&"POST /revoke".to_string()));
}

#[test]
fn picked_docs_import_as_markdown_with_a_sync_record() {
    let w = World::new();
    w.google.add_doc("docA1", "Plan: Q3/Q4", 5, doc("Hello"));
    let picked = w.pick(&["docA1"]).unwrap();
    let report = w.import(&picked.file_ids);
    let item = &report.imported[0];
    assert_eq!(item.outcome, Outcome::New);
    assert_eq!(item.path, w.folder().join("Plan- Q3-Q4.md"));
    assert_eq!(std::fs::read_to_string(&item.path).unwrap(), "Hello\n");
    let rec = store::get(&w.db, &item.path).unwrap().unwrap();
    assert_eq!(rec.doc_id, "docA1");
    assert_eq!(rec.title, "Plan: Q3/Q4");
    assert_eq!(rec.version.as_deref(), Some("5"));
    assert_eq!(rec.revision_id.as_deref(), Some("rev-docA1-5"));
    assert_eq!(rec.base_markdown, "Hello\n");
    assert_eq!(report.summary(), "Imported 1 Google Doc.");
}

#[test]
fn title_collisions_never_overwrite_and_a_repick_reuses_the_docs_own_file() {
    let w = World::new();
    std::fs::create_dir_all(w.folder()).unwrap();
    std::fs::write(w.folder().join("Notes.md"), "mine, not Google's").unwrap();
    w.google.add_doc("docN1", "Notes", 1, doc("First"));
    w.google.add_doc("docN2", "Notes", 1, doc("Second"));
    let picked = w.pick(&["docN1", "docN2"]).unwrap();
    let report = w.import(&picked.file_ids);
    let paths: Vec<_> = report.imported.iter().map(|i| i.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(paths, ["Notes (2).md", "Notes (3).md"]);
    assert_eq!(std::fs::read_to_string(w.folder().join("Notes.md")).unwrap(), "mine, not Google's");
    // Picking the same Doc again goes to its own file, not a fourth one.
    let again = w.import(&["docN1".into()]);
    assert_eq!(again.imported[0].path, w.folder().join("Notes (2).md"));
    assert_eq!(again.imported[0].outcome, Outcome::Unchanged);
    // A record's name stays reserved even when its file was deleted.
    std::fs::remove_file(w.folder().join("Notes (3).md")).unwrap();
    w.google.add_doc("docN4", "Notes", 1, doc("Fourth"));
    let fourth = w.import(&{
        w.pick(&["docN4"]).unwrap();
        vec!["docN4".to_string()]
    });
    assert_eq!(fourth.imported[0].path, w.folder().join("Notes (4).md"));
}

#[test]
fn refresh_skips_unchanged_docs_and_updates_changed_ones() {
    let w = World::new();
    w.google.add_doc("docR1", "Daily", 1, doc("Monday"));
    w.pick(&["docR1"]).unwrap();
    let path = w.import(&["docR1".into()]).imported[0].path.clone();
    let before = w.google.log().len();
    assert_eq!(w.refresh(&path).unwrap(), Outcome::Unchanged);
    // Unchanged is decided from Drive's version alone: no documents.get.
    assert!(!w.google.log()[before..].iter().any(|l| l.starts_with("GET /v1/documents")));
    w.google.edit_doc("docR1", 2, doc("Tuesday"));
    assert_eq!(w.refresh(&path).unwrap(), Outcome::Updated);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "Tuesday\n");
    let rec = store::get(&w.db, &path).unwrap().unwrap();
    assert_eq!((rec.version.as_deref(), rec.base_markdown.as_str()), (Some("2"), "Tuesday\n"));
}

#[test]
fn local_edits_become_a_dated_conflict_copy_before_googles_text_lands() {
    let w = World::new();
    w.google.add_doc("docR1", "Daily", 1, doc("Monday"));
    w.pick(&["docR1"]).unwrap();
    let path = w.import(&["docR1".into()]).imported[0].path.clone();
    std::fs::write(&path, "Monday, with my notes\n").unwrap();
    // Google unchanged: local edits are left alone.
    assert_eq!(w.refresh(&path).unwrap(), Outcome::Unchanged);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "Monday, with my notes\n");
    // Google changed: local edits go to a conflict copy, Google's text to the file.
    w.google.edit_doc("docR1", 2, doc("Tuesday"));
    let Outcome::ConflictCopy(copy) = w.refresh(&path).unwrap() else { panic!("expected a conflict copy") };
    assert_eq!(copy, w.folder().join("Daily (conflict 2026-11-25 14.03).md"));
    assert_eq!(std::fs::read_to_string(&copy).unwrap(), "Monday, with my notes\n");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "Tuesday\n");
    // A second conflict in the same minute gets its own copy.
    std::fs::write(&path, "Tuesday, edited\n").unwrap();
    w.google.edit_doc("docR1", 3, doc("Wednesday"));
    let Outcome::ConflictCopy(second) = w.refresh(&path).unwrap() else { panic!() };
    assert_eq!(second, w.folder().join("Daily (conflict 2026-11-25 14.03) (2).md"));
}

#[test]
fn a_doc_that_was_trashed_or_unshared_keeps_the_local_file_and_records_why() {
    let w = World::new();
    w.google.add_doc("docT1", "Old", 1, doc("Keep me"));
    w.pick(&["docT1"]).unwrap();
    let path = w.import(&["docT1".into()]).imported[0].path.clone();
    w.google.trash("docT1");
    assert!(matches!(w.refresh(&path).unwrap_err(), GoogleError::NoAccess(_)));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "Keep me\n");
    assert_eq!(store::get(&w.db, &path).unwrap().unwrap().error.as_deref(), Some("This Doc is in the trash in Google."));
}

#[test]
fn refresh_all_reports_each_file() {
    let w = World::new();
    w.google.add_doc("docA1", "One", 1, doc("1"));
    w.google.add_doc("docA2", "Two", 1, doc("2"));
    w.pick(&["docA1", "docA2"]).unwrap();
    w.import(&["docA1".into(), "docA2".into()]);
    w.google.edit_doc("docA2", 2, doc("2b"));
    let cfg = w.google.config();
    let api = GoogleApi::new(&cfg, &w.grant);
    let mut seen = Vec::new();
    let results = import::refresh_all(&api, &w.db, now(), &mut |p| seen.push(p.clone()), &AtomicBool::new(false)).unwrap();
    let outcomes: Vec<_> = results.into_iter().map(|(_, r)| r.unwrap()).collect();
    assert_eq!(outcomes, [Outcome::Unchanged, Outcome::Updated]);
    assert_eq!(seen.last().unwrap().done, 2);
}

#[test]
fn a_folder_pick_that_covers_its_docs_imports_them() {
    let w = World::new();
    w.google.add_doc("docF1", "Inside one", 1, doc("a"));
    w.google.add_doc("docF2", "Inside two", 1, doc("b"));
    w.google.add_folder("fold1", "Team", &["docF1", "docF2"]);
    w.google.state.lock().unwrap().folder_grants_children = true;
    let picked = w.pick(&["fold1"]).unwrap();
    let report = w.import(&picked.file_ids);
    assert_eq!(report.imported.len(), 2);
    assert!(report.folders_without_access.is_empty());
}

#[test]
fn a_folder_pick_that_does_not_cover_its_docs_asks_for_the_files() {
    let w = World::new();
    w.google.add_doc("docF1", "Inside", 1, doc("a"));
    w.google.add_folder("fold1", "Team", &["docF1"]);
    w.google.add_other("sheet1", "Budget", "application/vnd.google-apps.spreadsheet");
    let picked = w.pick(&["fold1", "sheet1"]).unwrap();
    let report = w.import(&picked.file_ids);
    assert!(report.imported.is_empty());
    assert_eq!(report.folders_without_access, ["Team"]);
    assert_eq!(report.skipped, [("Budget".to_string(), "not a Google Doc".to_string())]);
    assert!(report.summary().contains("pick the files themselves"));
    // The person picks the file itself, as asked.
    let picked = w.pick(&["docF1"]).unwrap();
    assert_eq!(w.import(&picked.file_ids).imported.len(), 1);
}

#[test]
fn save_as_word_writes_beside_the_markdown_and_replaces_its_own_copy() {
    let w = World::new();
    w.google.add_doc("docW1", "Report", 1, doc("Body"));
    w.pick(&["docW1"]).unwrap();
    let path = w.import(&["docW1".into()]).imported[0].path.clone();
    std::fs::write(w.folder().join("Report.docx"), b"someone else's Word file").unwrap();
    let cfg = w.google.config();
    let api = GoogleApi::new(&cfg, &w.grant);
    let docx = import::save_as_word(&api, &w.db, &path).unwrap();
    assert_eq!(docx, w.folder().join("Report (2).docx"));
    assert!(std::fs::read(&docx).unwrap().starts_with(b"PK fake docx for Report v1"));
    assert_eq!(std::fs::read(w.folder().join("Report.docx")).unwrap(), b"someone else's Word file");
    // A later export replaces its own copy rather than making a third file.
    w.google.edit_doc("docW1", 2, doc("Body 2"));
    assert_eq!(import::save_as_word(&api, &w.db, &path).unwrap(), docx);
    assert!(std::fs::read(&docx).unwrap().starts_with(b"PK fake docx for Report v2"));
    assert_eq!(store::get(&w.db, &path).unwrap().unwrap().docx_path, Some(docx));
}

#[test]
fn the_fake_only_ever_hears_drive_file() {
    let w = World::new();
    w.pick(&[]).unwrap();
    // A non-Doc ID never reaches Docs.
    let cfg = w.google.config();
    let api = GoogleApi::new(&cfg, &w.grant);
    use markie_google::api::DocsSource;
    assert!(matches!(api.document("../../etc"), Err(GoogleError::NoAccess(_))));
    assert_eq!(DOC_MIME, "application/vnd.google-apps.document");
}

/// The Projects hook (`google_import_becomes_projects_folder`): imported Docs
/// land in one "Google Docs" folder, made once; a re-import adds only what is
/// new; a Doc the person moved stays where they put it.
#[test]
fn imported_docs_become_one_google_docs_projects_folder() {
    use markie_core::bring_docs::bring_folder;
    use markie_core::projects::folders;
    let w = World::new();
    w.google.add_doc("docP1", "Plan", 1, doc("Plan"));
    w.google.add_doc("docP2", "Budget", 1, doc("Budget"));
    let picked = w.pick(&["docP1", "docP2"]).unwrap();
    let report = w.import(&picked.file_ids);
    let paths: Vec<_> = report.imported.iter().map(|i| i.path.clone()).collect();
    assert_eq!(bring_folder(&w.db, &w.folder(), "Google Docs", &paths).unwrap(), 2);
    let tree = folders::tree(&w.db).unwrap();
    assert_eq!(tree.len(), 1);
    assert_eq!(tree[0].name, "Google Docs");
    assert_eq!(tree[0].files.len(), 2);

    // The person moves Plan to a folder of their own; then imports again,
    // with one new Doc.
    let mine = folders::create_folder(&w.db, None, "Planning").unwrap();
    let plan = w.folder().join("Plan.md");
    folders::place_files(&w.db, &[plan.to_string_lossy().into_owned()], &mine, None).unwrap();
    w.google.add_doc("docP3", "Notes", 1, doc("Notes"));
    let picked = w.pick(&["docP1", "docP2", "docP3"]).unwrap();
    let again = w.import(&picked.file_ids);
    let paths: Vec<_> = again.imported.iter().map(|i| i.path.clone()).collect();
    assert_eq!(bring_folder(&w.db, &w.folder(), "Google Docs", &paths).unwrap(), 1, "only the new Doc");
    let tree = folders::tree(&w.db).unwrap();
    let names: Vec<_> = tree.iter().map(|n| (n.name.as_str(), n.files.len())).collect();
    assert_eq!(names, [("Google Docs", 2), ("Planning", 1)], "no second Google Docs folder, and Plan stayed put");
    assert_eq!(folders::folder_of(&w.db, &plan.to_string_lossy()).unwrap(), Some(mine));
}
