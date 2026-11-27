//! Images saved beside an imported Doc (src/images.rs), against the fake
//! Google (src/fake.rs): import saves files and writes relative images, a
//! pull that changes nothing rewrites nothing, an image removed in Google
//! loses its file, a failed download stays a link, image lines never reach
//! Google, conflict copies keep their images, renames and moves keep them
//! working, and the image line survives a markie-rich save. Never the real Google.
use chrono::{Local, TimeZone};
use markie_google::api::GoogleApi;
use markie_google::connect::connect_and_pick;
use markie_google::fake::FakeGoogle;
use markie_google::images;
use markie_google::store;
use markie_google::sync::{Synced, sync_doc};
use markie_google::tokens::Grant;
use markie_google::import;
use markie_vault::device::MemorySecretStore;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime};

fn now() -> chrono::DateTime<Local> {
    Local.with_ymd_and_hms(2026, 11, 26, 10, 15, 0).unwrap()
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake chart";
const JPG: &[u8] = b"\xff\xd8\xff\xe0fake logo";
const GIF: &[u8] = b"GIF89afake float";

fn text(t: &str) -> Value {
    json!({"paragraph": {"elements": [{"textRun": {"content": format!("{t}\n"), "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}})
}

/// A paragraph of `before` text, then the inline image `id`.
fn image(id: &str, before: &str) -> Value {
    let mut els = Vec::new();
    if !before.is_empty() {
        els.push(json!({"textRun": {"content": before, "textStyle": {}}}));
    }
    els.push(json!({"inlineObjectElement": {"inlineObjectId": id, "textStyle": {}}}));
    els.push(json!({"textRun": {"content": "\n", "textStyle": {}}}));
    json!({"paragraph": {"elements": els, "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}})
}

/// An image object served from `fake-image://{key}`, with alt text.
fn object(key: &str, description: Option<&str>, title: Option<&str>) -> Value {
    let mut embedded = json!({"imageProperties": {"contentUri": format!("fake-image://{key}")}});
    if let Some(d) = description {
        embedded["description"] = json!(d);
    }
    if let Some(t) = title {
        embedded["title"] = json!(t);
    }
    json!({"inlineObjectProperties": {"embeddedObject": embedded}})
}

fn doc(content: Vec<Value>, inline: Value, positioned: Value) -> Value {
    json!({"tabs": [{"tabProperties": {"tabId": "t.0", "title": "Tab 1"}, "documentTab": {"body": {"content": content}, "inlineObjects": inline, "positionedObjects": positioned}}]})
}

/// Intro, the chart alone, "A chart: " and the logo, and a floating picture.
fn field_notes() -> Value {
    let mut floating = text("Floating");
    floating["paragraph"]["positionedObjectIds"] = json!(["kix.pos1"]);
    doc(
        vec![text("Intro"), image("kix.img1", ""), image("kix.img2", "A chart: "), floating, text("After")],
        json!({"kix.img1": object("chart", Some("Sales by month"), None), "kix.img2": object("logo", None, Some("Logo"))}),
        json!({"kix.pos1": {"positionedObjectProperties": {"embeddedObject": {"imageProperties": {"contentUri": "fake-image://float"}}}}}),
    )
}

const FIELD_NOTES_MD: &str = "Intro\n\n![Sales by month](Field%20notes%20images/kix.img1.png)\n\nA chart: ![Logo](Field%20notes%20images/kix.img2.jpg)\n\nFloating\n\n![Image](Field%20notes%20images/kix.pos1.gif)\n\nAfter\n";

struct World {
    google: FakeGoogle,
    grant: Grant<MemorySecretStore>,
    db: Connection,
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let w = Self { google: FakeGoogle::start(), grant: Grant::new(MemorySecretStore::default()), db: Connection::open_in_memory().unwrap(), dir: tempfile::tempdir().unwrap() };
        w.google.add_image("chart", PNG, "image/png");
        w.google.add_image("logo", JPG, "image/jpeg");
        w.google.add_image("float", GIF, "image/gif");
        w
    }

    fn folder(&self) -> PathBuf {
        self.dir.path().join("Google Docs")
    }

    fn import_with(&self, ids: &[&str], two_way: bool) -> Vec<PathBuf> {
        self.google.set_pick(ids);
        let cfg = self.google.config();
        connect_and_pick(&cfg, &self.grant, None, &|url| {
            let url = url.to_string();
            std::thread::spawn(move || FakeGoogle::browse(&url));
        }, &AtomicBool::new(false), Duration::from_secs(20))
        .unwrap();
        let api = GoogleApi::new(&cfg, &self.grant);
        let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
        let report = import::import_picked(&api, &self.db, &self.folder(), &ids, now(), two_way, &mut |_| {}, &AtomicBool::new(false)).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        report.imported.into_iter().map(|i| i.path).collect()
    }

    fn import(&self, ids: &[&str]) -> Vec<PathBuf> {
        self.import_with(ids, true)
    }

    fn sync(&self, path: &Path) -> markie_google::sync::Report {
        let cfg = self.google.config();
        let api = GoogleApi::new(&cfg, &self.grant);
        sync_doc(&api, &self.db, path, now(), None).unwrap()
    }

    fn refresh(&self, path: &Path) -> import::Outcome {
        let cfg = self.google.config();
        let api = GoogleApi::new(&cfg, &self.grant);
        import::refresh(&api, &self.db, path, now()).unwrap()
    }

    fn writes(&self) -> usize {
        self.google.writes().len()
    }

    fn record(&self, path: &Path) -> store::SyncRecord {
        store::get(&self.db, path).unwrap().unwrap()
    }
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap()
}

/// What the reader, editor and export do with a relative image destination:
/// percent-decode it and join it to the file's folder.
fn resolve(md: &Path, dest: &str) -> PathBuf {
    let b = dest.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 3 <= b.len()
            && let Ok(v) = u8::from_str_radix(&dest[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    md.parent().unwrap().join(String::from_utf8(out).unwrap())
}

/// Every Markdown image destination in `text`.
fn destinations(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for ev in pulldown_cmark::Parser::new(text) {
        if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image { dest_url, .. }) = ev {
            out.push(dest_url.to_string());
        }
    }
    out
}

fn assert_images_resolve(md: &Path) {
    let text = read(md);
    let dests = destinations(&text);
    assert!(!dests.is_empty(), "no images in {text}");
    for d in dests {
        assert!(resolve(md, &d).is_file(), "{d} does not resolve beside {}", md.display());
    }
}

fn set_old_mtime(p: &Path) -> SystemTime {
    let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
    t
}

fn mtime(p: &Path) -> SystemTime {
    std::fs::metadata(p).unwrap().modified().unwrap()
}

#[test]
fn import_saves_each_image_beside_the_doc_as_a_relative_markdown_image() {
    let w = World::new();
    w.google.add_doc("d1", "Field notes", 1, field_notes());
    let path = w.import(&["d1"])[0].clone();
    assert_eq!(path.file_name().unwrap(), "Field notes.md");
    assert_eq!(read(&path), FIELD_NOTES_MD);
    let dir = w.folder().join("Field notes images");
    assert_eq!(std::fs::read(dir.join("kix.img1.png")).unwrap(), PNG);
    assert_eq!(std::fs::read(dir.join("kix.img2.jpg")).unwrap(), JPG);
    assert_eq!(std::fs::read(dir.join("kix.pos1.gif")).unwrap(), GIF);
    assert_images_resolve(&path);
    let rec = w.record(&path);
    assert_eq!(rec.images_dir.as_deref(), Some("Field notes images"));
    assert_eq!(rec.images.len(), 3);
    // The synced base is in the same local form as the file.
    assert_eq!(rec.base_markdown, FIELD_NOTES_MD);
    assert!(rec.matches_base(&read(&path)));
    // Nothing was sent, and the first round finds nothing to do.
    assert_eq!(w.sync(&path).outcome, Synced::Unchanged);
    assert_eq!(w.writes(), 0);
}

#[test]
fn a_second_pull_rewrites_nothing() {
    let w = World::new();
    w.google.add_doc("d1", "Field notes", 1, field_notes());
    let path = w.import(&["d1"])[0].clone();
    let dir = w.folder().join("Field notes images");
    let files: Vec<PathBuf> = ["kix.img1.png", "kix.img2.jpg", "kix.pos1.gif"].iter().map(|n| dir.join(n)).collect();
    let old: Vec<SystemTime> = files.iter().map(|f| set_old_mtime(f)).collect();
    let gets = w.google.image_gets();
    // Google changes only the text: every image link Google hands out is new.
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 6}, "text": ", more"}})]);
    assert_eq!(w.sync(&path).outcome, Synced::Pulled);
    assert_eq!(read(&path), FIELD_NOTES_MD.replace("Intro\n", "Intro, more\n"));
    assert!(w.google.image_gets() > gets, "a pull downloads the images again");
    for (f, t) in files.iter().zip(&old) {
        assert_eq!(mtime(f), *t, "{} was rewritten with the same bytes", f.display());
    }
    assert!(w.record(&path).matches_base(&read(&path)));
    // A round with nothing new reads nothing; one that only sends text downloads nothing.
    let gets = w.google.image_gets();
    assert_eq!(w.sync(&path).outcome, Synced::Unchanged);
    std::fs::write(&path, read(&path).replace("After\n", "After, mine\n")).unwrap();
    assert_eq!(w.sync(&path).outcome, Synced::Pushed { pulled: false });
    assert_eq!(w.google.image_gets(), gets);
    assert_eq!(w.sync(&path).outcome, Synced::Unchanged);
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3);
}

#[test]
fn an_image_removed_in_google_deletes_its_file_then_the_empty_folder() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, doc(vec![text("Intro"), image("kix.img1", ""), image("kix.img2", ""), text("After")], json!({"kix.img1": object("chart", None, None), "kix.img2": object("logo", None, None)}), json!({})));
    let path = w.import(&["d1"])[0].clone();
    let dir = w.folder().join("Plan images");
    assert!(dir.join("kix.img1.png").is_file() && dir.join("kix.img2.jpg").is_file());
    // "Intro\n" is 1..7, the chart's paragraph 7..9, the logo's 9..11.
    w.google.collaborate("d1", &[json!({"deleteContentRange": {"range": {"startIndex": 7, "endIndex": 9}}})]);
    assert_eq!(w.sync(&path).outcome, Synced::Pulled);
    assert_eq!(read(&path), "Intro\n\n![Image](Plan%20images/kix.img2.jpg)\n\nAfter\n");
    assert!(!dir.join("kix.img1.png").exists());
    assert!(dir.join("kix.img2.jpg").is_file());
    assert_eq!(w.record(&path).images.len(), 1);
    // The last one goes, and the folder with it.
    w.google.collaborate("d1", &[json!({"deleteContentRange": {"range": {"startIndex": 7, "endIndex": 9}}})]);
    assert_eq!(w.sync(&path).outcome, Synced::Pulled);
    assert_eq!(read(&path), "Intro\n\nAfter\n");
    assert!(!dir.exists());
    let rec = w.record(&path);
    assert!(rec.images.is_empty() && rec.images_dir.is_none());
    assert_eq!(w.writes(), 0);
}

#[test]
fn only_files_markie_wrote_are_ever_deleted() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, doc(vec![text("Intro"), image("kix.img1", ""), text("After")], json!({"kix.img1": object("chart", None, None)}), json!({})));
    let path = w.import(&["d1"])[0].clone();
    let dir = w.folder().join("Plan images");
    std::fs::write(dir.join("mine.txt"), "keep me").unwrap();
    std::fs::write(dir.join("kix.other.png"), "not Markie's").unwrap();
    w.google.collaborate("d1", &[json!({"deleteContentRange": {"range": {"startIndex": 7, "endIndex": 9}}})]);
    assert_eq!(w.sync(&path).outcome, Synced::Pulled);
    assert!(!dir.join("kix.img1.png").exists());
    assert_eq!(read(&dir.join("mine.txt")), "keep me");
    assert!(dir.join("kix.other.png").is_file());
    // The folder stays while anything else is in it.
    assert!(dir.is_dir());
}

#[test]
fn a_failed_download_stays_a_link_and_a_later_pull_saves_it() {
    let w = World::new();
    w.google.forbid_images(true);
    w.google.add_image("page", b"<html>sign in</html>", "text/html");
    w.google.add_doc("d1", "Plan", 1, doc(vec![text("Intro"), image("kix.img1", ""), image("kix.img3", ""), text("After")], json!({"kix.img1": object("chart", Some("Sales by month"), None), "kix.img3": object("page", None, None)}), json!({})));
    let path = w.import(&["d1"])[0].clone();
    let t = read(&path);
    assert!(t.contains("[Image: Sales by month](http://127.0.0.1:") && t.contains("/images/chart?sig="), "{t}");
    assert!(!w.folder().join("Plan images").exists());
    // Google lets images through again; the next pull saves the image. A
    // response that is not an image stays a link.
    w.google.forbid_images(false);
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 6}, "text": ", more"}})]);
    assert_eq!(w.sync(&path).outcome, Synced::Pulled);
    let t = read(&path);
    assert!(t.contains("![Sales by month](Plan%20images/kix.img1.png)"), "{t}");
    assert!(t.contains("[Image](http://127.0.0.1:") && t.contains("/images/page?sig="), "{t}");
    assert!(!w.folder().join("Plan images/kix.img3.html").exists());
    // A download that fails once the file is saved keeps the saved file.
    w.google.forbid_images(true);
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 1}, "text": "The "}})]);
    assert_eq!(w.sync(&path).outcome, Synced::Pulled);
    let t = read(&path);
    assert!(t.starts_with("The Intro, more\n") && t.contains("![Sales by month](Plan%20images/kix.img1.png)"), "{t}");
    assert!(w.folder().join("Plan images/kix.img1.png").is_file());
    assert_eq!(w.writes(), 0);
}

#[test]
fn editing_text_next_to_an_image_sends_only_the_text() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, doc(vec![text("Intro"), image("kix.img1", ""), text("After")], json!({"kix.img1": object("chart", Some("Chart"), None)}), json!({})));
    let path = w.import(&["d1"])[0].clone();
    assert_eq!(read(&path), "Intro\n\n![Chart](Plan%20images/kix.img1.png)\n\nAfter\n");
    std::fs::write(&path, "Intro\n\n![Chart](Plan%20images/kix.img1.png)\n\nAfter, edited\n").unwrap();
    let r = w.sync(&path);
    assert_eq!(r.outcome, Synced::Pushed { pulled: false });
    assert!(r.held.is_empty(), "{:?}", r.held);
    let (_, body) = &w.google.writes()[0];
    // "After\n" starts at 9: ", edited" goes in after "After", and every
    // request stays inside that paragraph, clear of the image at 7.
    let requests = body["requests"].as_array().unwrap();
    assert_eq!(requests[0], json!({"insertText": {"location": {"index": 14}, "text": ", edited"}}));
    for r in requests {
        let at = r.pointer("/insertText/location/index").or_else(|| r.pointer("/updateTextStyle/range/startIndex")).and_then(Value::as_u64);
        assert!(at.is_some_and(|i| i >= 14), "a request outside the edited text: {r}");
    }
    let sent = body.to_string();
    assert!(!sent.contains("Plan%20images") && !sent.contains("markieLocalSrc") && !sent.contains("inlineObject"), "{sent}");
    // The Doc keeps its image; the file keeps its line; nothing more to do.
    assert_eq!(w.google.markdown("d1"), "Intro\n\n[Image: Chart](fake-image://chart)\n\nAfter, edited\n");
    assert_eq!(read(&path), "Intro\n\n![Chart](Plan%20images/kix.img1.png)\n\nAfter, edited\n");
    assert_eq!(w.sync(&path).outcome, Synced::Unchanged);
    assert_eq!(w.writes(), 1);
}

#[test]
fn moving_deleting_or_editing_an_image_line_never_reaches_google() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, doc(vec![text("Intro"), image("kix.img1", ""), text("After")], json!({"kix.img1": object("chart", Some("Chart"), None)}), json!({})));
    let path = w.import(&["d1"])[0].clone();
    let line = "![Chart](Plan%20images/kix.img1.png)";
    for edited in [
        format!("Intro\n\nAfter\n\n{line}\n"),
        "Intro\n\nAfter\n".to_string(),
        format!("Intro\n\n{}\n\nAfter\n", line.replace("Chart", "A better caption")),
    ] {
        std::fs::write(&path, &edited).unwrap();
        let r = w.sync(&path);
        assert_eq!(r.held, ["images"], "{edited}");
        assert_eq!(r.outcome, Synced::Unchanged, "{edited}");
        assert_eq!(w.writes(), 0, "{edited}");
        assert_eq!(read(&path), edited);
        assert!(w.record(&path).conflict.is_none());
        // No ping-pong: the next round does nothing.
        assert_eq!(w.sync(&path).outcome, Synced::Unchanged);
    }
    // The Doc still has the image, so its file stays.
    assert!(w.folder().join("Plan images/kix.img1.png").is_file());
    assert_eq!(w.google.markdown("d1"), "Intro\n\n[Image: Chart](fake-image://chart)\n\nAfter\n");
}

#[test]
fn a_conflict_copy_keeps_its_images() {
    let w = World::new();
    w.google.add_doc("d1", "Field notes", 1, doc(vec![text("Intro"), image("kix.img1", ""), text("Two")], json!({"kix.img1": object("chart", Some("Chart"), None)}), json!({})));
    let path = w.import(&["d1"])[0].clone();
    std::fs::write(&path, "Intro\n\n![Chart](Field%20notes%20images/kix.img1.png)\n\nTwo, Markie's\n").unwrap();
    // Google edits the same paragraph ("Two\n" is 9..13) and removes the image (7..9).
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 12}, "text": ", Google's"}}), json!({"deleteContentRange": {"range": {"startIndex": 7, "endIndex": 9}}})]);
    let Synced::Conflict { copy, .. } = w.sync(&path).outcome else { panic!("a conflict") };
    assert_eq!(read(&path), "Intro\n\nTwo, Google's\n");
    assert_eq!(copy.file_name().unwrap(), "Field notes (conflict 2026-11-26 10.15).md");
    assert_eq!(read(&copy), "Intro\n\n![Chart](Field%20notes%20%28conflict%202026-11-26%2010.15%29%20images/kix.img1.png)\n\nTwo, Markie's\n");
    assert_images_resolve(&copy);
    assert_eq!(std::fs::read(w.folder().join("Field notes (conflict 2026-11-26 10.15) images/kix.img1.png")).unwrap(), PNG);
    // The Doc's own image went with it.
    assert!(!w.folder().join("Field notes images").exists());
    assert_eq!(w.sync(&path).outcome, Synced::Unchanged);
}

#[test]
fn refresh_only_docs_keep_their_images_too() {
    let w = World::new();
    w.google.add_doc("d1", "Plan", 1, doc(vec![text("Intro"), image("kix.img1", ""), text("After")], json!({"kix.img1": object("chart", None, None)}), json!({})));
    let path = w.import_with(&["d1"], false)[0].clone();
    assert_images_resolve(&path);
    // A local edit, then Google removes the image: the edit is kept as a
    // conflict copy with its image, and the Doc's file loses its own.
    std::fs::write(&path, read(&path).replace("After", "After, mine")).unwrap();
    w.google.collaborate("d1", &[json!({"deleteContentRange": {"range": {"startIndex": 7, "endIndex": 9}}})]);
    let import::Outcome::ConflictCopy(copy) = w.refresh(&path) else { panic!("a conflict copy") };
    assert_eq!(read(&path), "Intro\n\nAfter\n");
    assert!(!w.folder().join("Plan images").exists());
    assert_images_resolve(&copy);
}

#[test]
fn renaming_or_moving_the_file_keeps_its_images() {
    let w = World::new();
    w.google.add_doc("d1", "Field notes", 1, field_notes());
    let path = w.import(&["d1"])[0].clone();
    // A rename in place: the folder keeps its name, and every link works.
    let renamed = path.with_file_name("Trip.md");
    std::fs::rename(&path, &renamed).unwrap();
    store::move_path(&w.db, &path, &renamed).unwrap();
    images::follow_move(&w.db, &path, &renamed).unwrap();
    assert_images_resolve(&renamed);
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 6}, "text": ", more"}})]);
    assert_eq!(w.sync(&renamed).outcome, Synced::Pulled);
    assert_images_resolve(&renamed);
    assert_eq!(w.record(&renamed).images_dir.as_deref(), Some("Field notes images"));
    assert!(!w.folder().join("Trip images").exists());
    // A move to another folder in Markie takes the images folder along.
    let sub = w.folder().join("Travel");
    std::fs::create_dir_all(&sub).unwrap();
    let moved = sub.join("Trip.md");
    std::fs::rename(&renamed, &moved).unwrap();
    store::move_path(&w.db, &renamed, &moved).unwrap();
    images::follow_move(&w.db, &renamed, &moved).unwrap();
    assert!(sub.join("Field notes images/kix.img1.png").is_file());
    assert!(!w.folder().join("Field notes images").exists());
    assert_images_resolve(&moved);
    w.google.collaborate("d1", &[json!({"insertText": {"location": {"index": 1}, "text": "The "}})]);
    assert_eq!(w.sync(&moved).outcome, Synced::Pulled);
    assert_images_resolve(&moved);
    assert_eq!(w.writes(), 0);
}

#[test]
fn two_docs_never_share_an_images_folder() {
    let w = World::new();
    let one = || doc(vec![text("Intro"), image("kix.img1", "")], json!({"kix.img1": object("chart", None, None)}), json!({}));
    w.google.add_doc("d1", "Plan", 1, one());
    let first = w.import(&["d1"])[0].clone();
    let renamed = first.with_file_name("Old plan.md");
    std::fs::rename(&first, &renamed).unwrap();
    store::move_path(&w.db, &first, &renamed).unwrap();
    // A copy of that Doc, same title and same object IDs, takes the free name "Plan.md".
    w.google.add_doc("d2", "Plan", 1, one());
    let second = w.import(&["d2"])[0].clone();
    assert_eq!(second.file_name().unwrap(), "Plan.md");
    assert_eq!(w.record(&second).images_dir.as_deref(), Some("Plan images (2)"));
    assert_eq!(read(&second), "Intro\n\n![Image](Plan%20images%20%282%29/kix.img1.png)\n");
    assert_images_resolve(&renamed);
    assert_images_resolve(&second);
}

#[test]
fn the_image_line_survives_a_markie_rich_save() {
    use markie_rich::parse::parse_nodes;
    use markie_rich::serialize::nodes_to_markdown;
    for (dir, alt) in [("Field notes images", "Sales by month"), ("Plan (2) images", "Logo"), ("Río? #1 images", "IMG_1234 *bold* [x] & <y>"), ("Notes images", "")] {
        let line = images::markdown_image(alt, &images::destination(dir, "kix.abc123.png"));
        assert_eq!(nodes_to_markdown(&parse_nodes(&line)).trim_end(), line, "{dir} / {alt}");
        // And the reader finds the file the line names.
        let md = Path::new("/docs/Doc.md");
        assert_eq!(resolve(md, &destinations(&line)[0]), Path::new("/docs").join(dir).join("kix.abc123.png"));
    }
}

#[test]
fn images_in_every_tab_are_saved_and_pruned() {
    let w = World::new();
    let tab = |t: &str, content: Vec<Value>, inline: Value| json!({"tabProperties": {"title": t}, "documentTab": {"body": {"content": content}, "inlineObjects": inline}});
    let with_image = json!({"tabs": [tab("One", vec![text("First")], json!({})), tab("Two", vec![text("Second"), image("kix.t2", "")], json!({"kix.t2": object("chart", None, None)}))]});
    w.google.add_doc("m1", "Tabs", 1, with_image);
    let path = w.import(&["m1"])[0].clone();
    assert_eq!(read(&path), "# One\n\nFirst\n\n# Two\n\nSecond\n\n![Image](Tabs%20images/kix.t2.png)\n");
    assert_images_resolve(&path);
    // Google drops the image: a Doc with tabs only pulls, and its file goes.
    w.google.edit_doc("m1", 2, json!({"tabs": [tab("One", vec![text("First")], json!({})), tab("Two", vec![text("Second")], json!({}))]}));
    assert_eq!(w.sync(&path).outcome, Synced::Pulled);
    assert_eq!(read(&path), "# One\n\nFirst\n\n# Two\n\nSecond\n");
    assert!(!w.folder().join("Tabs images").exists());
    assert_eq!(w.writes(), 0);
}
