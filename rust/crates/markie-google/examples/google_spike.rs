//! The spike against the real Google, for Kirby to run once the Desktop OAuth
//! client exists: `rust/scripts/google-spike.sh` (see that script).
//!
//! It runs the real desktop Picker flow in the system browser and prints a
//! report. Without `--write-test` it only reads from Google: no create,
//! update, delete or share call is made.
//!
//! With `--write-test` it also makes one new Doc of its own, "Markie sync
//! test", runs two-way sync against it (both ways, a collaborator's edit
//! during a write, a conflict, a suggestion), reports, and moves that Doc to
//! the trash at the end (`markie_google::write_test`). It never writes to any
//! other Doc: every write is refused unless it names the Doc it made. The grant is kept in memory, never in the Keychain, and is
//! revoked at the end. With `--out DIR` it also saves each Doc's converted
//! Markdown, Google's own Markdown export and the `.docx` export there.
//!
//! Questions it answers (GOOGLE-SYNC-DESIGN "Open items for the spike"):
//! 1. Does the Picker flow work with a Desktop client and a loopback redirect, with no API key?
//! 2. Does a folder pick cover the Docs inside it, and Docs added later?
//! 3. What does each Doc convert to, and what do Google's Markdown and .docx exports keep?
//! 4. Does `changes.list` under drive.file list only picked files?
use markie_google::api::{DocsSource, GoogleApi, SyncSource};
use markie_google::config::{ClientConfig, Endpoints};
use markie_google::convert::doc_to_markdown;
use markie_google::tokens::Grant;
use markie_vault::device::MemorySecretStore;
use serde_json::Value;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

fn ask(prompt: &str) -> String {
    print!("\n>>> {prompt}\n    Press Enter when done (or type skip): ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    line.trim().to_string()
}

fn head(text: &str, lines: usize) -> String {
    let mut out: Vec<&str> = text.lines().take(lines).collect();
    if text.lines().count() > lines {
        out.push("    …");
    }
    out.iter().map(|l| format!("    | {l}")).collect::<Vec<_>>().join("\n")
}

fn docx_report(bytes: &[u8]) -> String {
    let dir = std::env::temp_dir().join(format!("markie-spike-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("export.docx");
    if std::fs::write(&file, bytes).is_err() {
        return "could not inspect".into();
    }
    let part = |name: &str| std::process::Command::new("/usr/bin/unzip").arg("-p").arg(&file).arg(name).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let doc = part("word/document.xml");
    let comments = part("word/comments.xml");
    let _ = std::fs::remove_dir_all(&dir);
    format!(
        "{} bytes; comments: {}; tracked insertions: {}; tracked deletions: {}; images: {}",
        bytes.len(),
        comments.matches("<w:comment ").count(),
        doc.matches("<w:ins ").count(),
        doc.matches("<w:del ").count(),
        doc.matches("<w:drawing>").count()
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = args.iter().position(|a| a == "--out").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let write_test = args.iter().any(|a| a == "--write-test");
    let id = std::env::var("MARKIE_GOOGLE_DESKTOP_CLIENT_ID").ok();
    let secret = std::env::var("MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET").ok();
    let Some(cfg) = ClientConfig::from_parts(id.as_deref(), secret.as_deref(), Endpoints::google()) else {
        eprintln!("Set MARKIE_GOOGLE_DESKTOP_CLIENT_ID (and MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET if the client has one).");
        std::process::exit(2);
    };
    if let Some(dir) = &out {
        std::fs::create_dir_all(dir).expect("the --out folder");
    }
    if write_test {
        println!("Markie Google Docs spike, with the write test: it makes \u{201c}{}\u{201d}, writes only to it, and trashes it at the end.", markie_google::write_test::TITLE);
    } else {
        println!("Markie Google Docs spike. Read-only. The grant stays in memory and is revoked at the end.");
    }
    println!("\n== 1. Picker flow (Desktop client, loopback redirect, no API key)");
    println!("Your browser opens Google's consent page with the Picker. Pick at least one Doc and one folder that has Docs in it.");
    let grant = Grant::new(MemorySecretStore::default());
    let picked = match markie_google::connect::connect_and_pick(&cfg, &grant, None, &|url| {
        let _ = std::process::Command::new("/usr/bin/open").arg(url).status();
    }, &AtomicBool::new(false), markie_google::oauth::PICK_TIMEOUT)
    {
        Ok(p) => p,
        Err(e) => {
            println!("RESULT: the Picker flow failed: {e:?}");
            std::process::exit(1);
        }
    };
    println!("RESULT: works. picked_file_ids: {} item(s). Account email from about.get: {}", picked.file_ids.len(), picked.email.as_deref().unwrap_or("(not given to drive.file)"));
    let api = GoogleApi::new(&cfg, &grant);
    let start_token = api.start_page_token().ok();

    let mut docs = Vec::new();
    let mut folders = Vec::new();
    for fid in &picked.file_ids {
        match api.file(fid) {
            Ok(f) if f.is_folder() => folders.push(f),
            Ok(f) if f.is_doc() => docs.push(f),
            Ok(f) => println!("  picked {} ({}): not a Doc, skipped", f.name, f.mime_type),
            Err(e) => println!("  picked {fid}: files.get failed: {e:?}"),
        }
    }

    println!("\n== 2. Folder picks");
    if folders.is_empty() {
        println!("No folder was picked; this question stays open.");
    }
    for folder in &folders {
        match api.folder_docs(&folder.id) {
            Ok(children) => {
                let readable = children.iter().filter(|c| api.document(&c.id).is_ok()).count();
                println!("Folder \u{201c}{}\u{201d}: files.list shows {} Doc(s); documents.get works for {readable}.", folder.name, children.len());
                if children.is_empty() {
                    println!("RESULT: a folder pick does NOT expose the Docs inside it (or the folder has none).");
                } else {
                    println!("RESULT: a folder pick {} the Docs inside it.", if readable == children.len() { "covers" } else { "partly covers" });
                }
            }
            Err(e) => println!("Folder \u{201c}{}\u{201d}: files.list failed: {e:?}", folder.name),
        }
        if ask(&format!("Now create a NEW Google Doc inside \u{201c}{}\u{201d} in Drive (in your browser).", folder.name)) != "skip" {
            match api.folder_docs(&folder.id) {
                Ok(children) => {
                    let names: Vec<_> = children.iter().map(|c| c.name.clone()).collect();
                    let readable = children.iter().filter(|c| api.document(&c.id).is_ok()).count();
                    println!("After adding: {} Doc(s) listed ({}), {readable} readable.", children.len(), names.join(", "));
                    println!("RESULT: compare with the count above to see whether a later Doc is covered.");
                }
                Err(e) => println!("files.list failed: {e:?}"),
            }
        }
    }

    println!("\n== 3. What each Doc converts to, and what Google's exports keep");
    for f in &docs {
        println!("\n-- \u{201c}{}\u{201d} ({})", f.name, f.id);
        let doc = match api.document(&f.id) {
            Ok(d) => d,
            Err(e) => {
                println!("documents.get failed: {e:?}");
                continue;
            }
        };
        let c = doc_to_markdown(&doc);
        println!("tabs: {}; images: {}; revisionId present: {}; Drive version: {:?}", c.tabs, c.images, doc.get("revisionId").is_some(), f.version);
        println!("Markie dropped: {}", if c.dropped.is_empty() { "nothing".to_string() } else { c.dropped.iter().copied().collect::<Vec<_>>().join(", ") });
        // Raw list levels, to confirm how checklists show in the API.
        let mut levels = Vec::new();
        let tabs = doc.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
        for t in &tabs {
            if let Some(lists) = t.pointer("/documentTab/lists").and_then(Value::as_object) {
                for (lid, l) in lists {
                    if let Some(first) = l.pointer("/listProperties/nestingLevels/0") {
                        levels.push(format!("{lid}: glyphType={} glyphSymbol={}", first.get("glyphType").and_then(Value::as_str).unwrap_or("-"), first.get("glyphSymbol").and_then(Value::as_str).unwrap_or("-")));
                    }
                }
            }
        }
        if !levels.is_empty() {
            println!("list level 0 of each list (checklists should show glyphType=GLYPH_TYPE_UNSPECIFIED, no symbol):\n    {}", levels.join("\n    "));
        }
        println!("Markie's Markdown:\n{}", head(&c.markdown, 25));
        match api.export(&f.id, "text/markdown") {
            Ok(bytes) => {
                let md = String::from_utf8_lossy(&bytes).into_owned();
                println!("Google's Markdown export ({} bytes; images inline: {}; tab titles present: {}):\n{}", bytes.len(), md.contains("data:image") || md.contains("!["), tabs.iter().all(|t| t.pointer("/tabProperties/title").and_then(Value::as_str).is_some_and(|title| md.contains(title))), head(&md, 15));
                if let Some(dir) = &out {
                    let _ = std::fs::write(dir.join(format!("{}.google.md", f.id)), &bytes);
                }
            }
            Err(e) => println!("Markdown export failed: {e:?}"),
        }
        match api.export(&f.id, markie_google::DOCX_MIME) {
            Ok(bytes) => {
                println!(".docx export: {}", docx_report(&bytes));
                if let Some(dir) = &out {
                    let _ = std::fs::write(dir.join(format!("{}.docx", f.id)), &bytes);
                }
            }
            Err(e) => println!(".docx export failed: {e:?}"),
        }
        if let Some(dir) = &out {
            let _ = std::fs::write(dir.join(format!("{}.markie.md", f.id)), &c.markdown);
            let _ = std::fs::write(dir.join(format!("{}.json", f.id)), serde_json::to_string_pretty(&doc).unwrap_or_default());
        }
    }

    println!("\n== 4. changes.list under drive.file");
    match start_token {
        None => println!("changes.getStartPageToken failed; question stays open."),
        Some(token) => {
            if ask("Now edit one Doc you PICKED and one Doc you did NOT pick, in your browser.") != "skip" {
                match api.changes(&token) {
                    Ok(v) => {
                        let ids: Vec<String> = v.get("changes").and_then(Value::as_array).map(|a| a.iter().filter_map(|c| c.get("fileId").and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default();
                        let unpicked: Vec<_> = ids.iter().filter(|i| !picked.file_ids.contains(i) && !docs.iter().any(|d| &d.id == *i)).collect();
                        println!("changes.list returned {} change(s); {} for files that were not picked.", ids.len(), unpicked.len());
                        println!("RESULT: {}", if unpicked.is_empty() { "only picked (or app-visible) files appear." } else { "unpicked files DO appear; filter by the sync records." });
                    }
                    Err(e) => println!("changes.list failed: {e:?}"),
                }
            }
        }
    }

    if write_test {
        println!("\n== 5. Write test (two-way sync on a Doc the test makes)");
        let dir = std::env::temp_dir().join(format!("markie-write-test-{}", std::process::id()));
        match markie_google::write_test::run(&api, &dir, &mut |line| println!("{line}")) {
            Ok(checks) => {
                let failed = checks.iter().filter(|c| !c.ok).count();
                println!("RESULT: {} of {} checks passed.", checks.len() - failed, checks.len());
            }
            Err(e) => println!("RESULT: the write test stopped: {e:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    let _ = grant.disconnect(&markie_google::oauth::http_client(), &cfg);
    if write_test {
        println!("\nDone. The grant was revoked. The only Doc written to was the test's own, now in the trash.");
    } else {
        println!("\nDone. The grant was revoked. Nothing was written to Google.");
    }
}
