//! The spike tool's opt-in live write test (`google-spike.sh --write-test`).
//!
//! It makes one new Doc of its own, "Markie sync test", runs two-way sync
//! against it both ways, with a collaborator's edit made while Markie
//! writes, a conflict and a suggestion, prints what Google did, and moves
//! that Doc to the trash at the end, whatever happened.
//!
//! It can't write anywhere else: every write goes through `Only`, which
//! refuses any Doc ID but the one it created, and Drive's `drive.file` grant
//! covers files the app made. The tests run it against the fake Google.
use crate::api::{DocsSource, DriveFile, GoogleApi, SyncSource};
use crate::error::{GoogleError, Result};
use crate::md;
use crate::store::{self, SyncRecord};
use crate::sync::{Synced, sync_doc};
use markie_vault::device::SecretStore;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::path::Path;

pub const TITLE: &str = "Markie sync test";

/// What the write test needs beyond sync: making and trashing its own Doc.
pub trait TestDocs: SyncSource {
    fn create(&self, title: &str) -> Result<String>;
    fn trash(&self, id: &str) -> Result<()>;
}

impl<S: SecretStore> TestDocs for GoogleApi<'_, S> {
    fn create(&self, title: &str) -> Result<String> {
        let v = self.create_document(title)?;
        v.get("documentId").and_then(Value::as_str).map(str::to_string).ok_or_else(|| GoogleError::Parse("documentId".into()))
    }
    fn trash(&self, id: &str) -> Result<()> {
        self.trash_own_test_doc(id)
    }
}

/// Every call goes to the one Doc this test made, or fails.
pub struct Only<'a> {
    inner: &'a dyn TestDocs,
    id: String,
    /// A "collaborator" edit to make just before Markie's next write.
    race: RefCell<Option<Vec<Value>>>,
}

// One thread only; RefCell is fine.
unsafe impl Sync for Only<'_> {}

impl Only<'_> {
    fn check(&self, id: &str) -> Result<()> {
        if id == self.id { Ok(()) } else { Err(GoogleError::NoAccess(format!("the write test only touches its own Doc, not {id}"))) }
    }
    /// An edit made straight through the API, as a collaborator would.
    pub fn edit(&self, requests: &[Value]) -> Result<()> {
        let doc = self.inner.document(&self.id)?;
        let rev = doc.get("revisionId").and_then(Value::as_str).unwrap_or_default().to_string();
        self.inner.batch_update(&self.id, requests, &rev, false).map(|_| ())
    }
}

impl DocsSource for Only<'_> {
    fn file(&self, id: &str) -> Result<DriveFile> {
        self.check(id)?;
        self.inner.file(id)
    }
    fn document(&self, id: &str) -> Result<Value> {
        self.check(id)?;
        self.inner.document(id)
    }
    fn export(&self, id: &str, mime: &str) -> Result<Vec<u8>> {
        self.check(id)?;
        self.inner.export(id, mime)
    }
    fn folder_docs(&self, _: &str) -> Result<Vec<DriveFile>> {
        Ok(Vec::new())
    }
}

impl SyncSource for Only<'_> {
    fn batch_update(&self, id: &str, requests: &[Value], target: &str, suggest: bool) -> Result<Value> {
        self.check(id)?;
        if let Some(edit) = self.race.borrow_mut().take() {
            self.edit(&edit)?;
        }
        self.inner.batch_update(id, requests, target, suggest)
    }
    fn start_page_token(&self) -> Result<String> {
        self.inner.start_page_token()
    }
    fn changed_since(&self, token: &str) -> Result<(Vec<String>, String)> {
        self.inner.changed_since(token)
    }
}

/// One check's result, for the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

/// The Doc index where `needle` starts (units are Doc indices).
fn text_index(doc: &Value, needle: &str) -> Option<usize> {
    let m = crate::model::DocModel::from_doc(doc).ok()?;
    let all: Vec<u16> = m.units.iter().map(|u| if let crate::model::UKind::Text(c) = u.kind { c } else { 0 }).collect();
    let n: Vec<u16> = needle.encode_utf16().collect();
    all.windows(n.len()).position(|w| w == n.as_slice())
}

fn same(a: &str, b: &str) -> bool {
    md::parse(a).keys() == md::parse(b).keys()
}

/// Run the write test in `folder` (outside the repo). Always trashes its Doc.
pub fn run(api: &dyn TestDocs, folder: &Path, say: &mut dyn FnMut(&str)) -> Result<Vec<Check>> {
    let id = api.create(TITLE)?;
    say(&format!("Made the Doc \u{201c}{TITLE}\u{201d} ({id}). Only it is written to; it goes to the trash at the end."));
    let only = Only { inner: api, id: id.clone(), race: RefCell::new(None) };
    let result = checks(&only, folder, say);
    match api.trash(&id) {
        Ok(()) => say("Moved \u{201c}Markie sync test\u{201d} to the trash."),
        Err(e) => say(&format!("Could not trash the test Doc ({e}). Delete \u{201c}{TITLE}\u{201d} by hand.")),
    }
    result
}

fn checks(only: &Only, folder: &Path, say: &mut dyn FnMut(&str)) -> Result<Vec<Check>> {
    let mut out = Vec::new();
    let mut check = |name: &'static str, ok: bool, detail: String, say: &mut dyn FnMut(&str)| {
        say(&format!("{} {name}: {detail}", if ok { "PASS" } else { "FAIL" }));
        out.push(Check { name, ok, detail });
    };
    std::fs::create_dir_all(folder)?;
    let db = Connection::open_in_memory()?;
    let path = folder.join("Markie sync test.md");
    let now = chrono::Local::now();
    // Import the empty Doc, two-way.
    let file = only.file(&only.id)?;
    crate::import::import_doc(only, &db, folder, &file, now, true)?;
    let path = store::all(&db)?.into_iter().map(|(p, _)| p).next().unwrap_or(path);

    // 1. Markie to Google.
    let local = "# Markie sync test\n\nA paragraph with **bold**, *italic*, ~~struck~~, `code` and [a link](https://example.com/markie).\n\n## A list\n\n- one\n- two\n    - nested\n\n1. first\n2. second\n\n- [ ] a checkbox\n\n```\nlet x = 1;\n```\n\nThe end.\n";
    std::fs::write(&path, local)?;
    let r = sync_doc(only, &db, &path, now, None)?;
    let doc = only.document(&only.id)?;
    let remote = crate::convert::doc_to_markdown(&doc).markdown;
    check("write from Markie", same(&remote, local) && r.held.is_empty(), format!("{} requests; Google now reads back {}", r.requests, if same(&remote, local) { "the same Markdown" } else { "different Markdown" }), say);
    if !same(&remote, local) {
        say(&format!("--- Google's Doc as Markdown\n{remote}--- Markie's file\n{local}"));
    }
    // How a checkbox list shows in the API (the converter's unverified rule).
    let model = crate::model::DocModel::from_doc(&doc).ok();
    if let Some(m) = &model {
        for p in m.paragraphs() {
            if let Some((id, kind, _)) = m.bullet(p) {
                let lvl = m.lists.get(&id).and_then(|l| l.pointer("/listProperties/nestingLevels/0")).cloned().unwrap_or_default();
                say(&format!("    list {id} \u{201c}{}\u{201d} reads as {kind:?}: level 0 glyphType={} glyphSymbol={}", m.text(p), lvl.get("glyphType").and_then(Value::as_str).unwrap_or("-"), lvl.get("glyphSymbol").and_then(Value::as_str).unwrap_or("-")));
            }
        }
    }
    let again = sync_doc(only, &db, &path, now, None)?;
    check("no ping-pong", again.outcome == Synced::Unchanged && again.requests == 0, format!("{:?}", again.outcome), say);

    // 2. Google to Markie.
    let at = text_index(&doc, "The end.").ok_or_else(|| GoogleError::Parse("the end paragraph".into()))?;
    only.edit(&[json!({"insertText": {"location": {"index": at}, "text": "Truly. "}})])?;
    let r = sync_doc(only, &db, &path, now, None)?;
    let file_text = std::fs::read_to_string(&path)?;
    check("Google to Markie", file_text.contains("Truly. The end."), format!("{:?}", r.outcome), say);

    // 3. A collaborator's edit while Markie writes.
    let doc = only.document(&only.id)?;
    let at = text_index(&doc, "A paragraph").ok_or_else(|| GoogleError::Parse("the paragraph".into()))?;
    *only.race.borrow_mut() = Some(vec![json!({"insertText": {"location": {"index": at}, "text": "Collaborator: "}})]);
    let text = std::fs::read_to_string(&path)?.replace("- two", "- two, from Markie");
    std::fs::write(&path, &text)?;
    let r = sync_doc(only, &db, &path, now, None)?;
    let remote = crate::convert::doc_to_markdown(&only.document(&only.id)?).markdown;
    let file_text = std::fs::read_to_string(&path)?;
    let merged = remote.contains("Collaborator: ") && remote.contains("two, from Markie") && same(&remote, &file_text);
    check("merge with a collaborator (targetRevisionId)", merged, format!("{:?}", r.outcome), say);

    // 4. A conflict on one paragraph.
    let doc = only.document(&only.id)?;
    let at = text_index(&doc, "first").ok_or_else(|| GoogleError::Parse("first".into()))? + "first".len();
    only.edit(&[json!({"insertText": {"location": {"index": at}, "text": " (Google)"}})])?;
    let text = std::fs::read_to_string(&path)?.replace("1. first", "1. first (Markie)");
    std::fs::write(&path, &text)?;
    let r = sync_doc(only, &db, &path, now, None)?;
    let ok = matches!(&r.outcome, Synced::Conflict { copy, .. } if std::fs::read_to_string(copy).is_ok_and(|c| c.contains("first (Markie)")));
    check("conflict keeps Google's text and a copy", ok && std::fs::read_to_string(&path)?.contains("first (Google)"), format!("{:?}", r.outcome), say);

    // 5. Suggestions.
    let mut rec: SyncRecord = store::get(&db, &path)?.unwrap_or_default();
    rec.suggest = true;
    rec.suggest_chosen = true;
    store::put(&db, &path, &rec)?;
    let text = std::fs::read_to_string(&path)?.replace("- one", "- one, suggested");
    std::fs::write(&path, &text)?;
    match sync_doc(only, &db, &path, now, None) {
        Ok(r) => {
            let doc = only.document(&only.id)?;
            let inline = doc.to_string().contains("suggestedInsertionIds");
            let remote = crate::convert::doc_to_markdown(&doc).markdown;
            check("suggestion mode (writeMode SUGGEST)", inline && remote.contains("one, suggested"), format!("{:?}; suggestions inline in the Doc: {inline}", r.outcome), say);
        }
        Err(e) => check("suggestion mode (writeMode SUGGEST)", false, format!("Google refused: {e:?}"), say),
    }
    // 6. Whether changes.list lists a Doc this app made.
    if let Ok(token) = only.start_page_token() {
        let _ = only.edit(&[json!({"insertText": {"location": {"index": 1}, "text": "Last edit. "}})]);
        std::thread::sleep(std::time::Duration::from_secs(3));
        match only.changed_since(&token) {
            Ok((ids, _)) => say(&format!("changes.list after an edit lists the test Doc: {}", ids.contains(&only.id))),
            Err(e) => say(&format!("changes.list failed: {e:?}")),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakeGoogle;
    use crate::tokens::Grant;
    use markie_vault::device::MemorySecretStore;

    #[test]
    fn the_write_test_touches_only_its_own_doc_and_trashes_it() {
        let google = FakeGoogle::start();
        google.add_doc("other1", "Someone's Doc", 1, json!({"tabs": [{"documentTab": {"body": {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Hands off\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}]}}}]}));
        google.set_pick(&["other1"]);
        let cfg = google.config();
        let grant = Grant::new(MemorySecretStore::default());
        crate::connect::connect_and_pick(&cfg, &grant, None, &|url| {
            let url = url.to_string();
            std::thread::spawn(move || FakeGoogle::browse(&url));
        }, &Default::default(), std::time::Duration::from_secs(20))
        .unwrap();
        let api = GoogleApi::new(&cfg, &grant);
        let dir = tempfile::tempdir().unwrap();
        let mut lines = Vec::new();
        let checks = run(&api, dir.path(), &mut |l| lines.push(l.to_string())).unwrap();
        let failed: Vec<_> = checks.iter().filter(|c| !c.ok).collect();
        assert!(failed.is_empty(), "{failed:?}\n{}", lines.join("\n"));
        assert_eq!(checks.len(), 6);
        // Every write went to the test Doc, which is now in the trash.
        let writes = google.writes();
        let test_id = &writes[0].0;
        assert!(writes.iter().all(|(id, _)| id == test_id && id != "other1"));
        assert_eq!(google.file(test_id).meta["trashed"], json!(true));
        assert_eq!(google.markdown("other1"), "Hands off\n");
        // The guard refuses another Doc outright.
        let only = Only { inner: &api, id: test_id.clone(), race: RefCell::new(None) };
        assert!(matches!(only.batch_update("other1", &[json!({})], "r", false), Err(GoogleError::NoAccess(_))));
    }
}
