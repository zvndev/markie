//! What an agent may do with comments on a local document, through the
//! bridge: list them, add one on a quoted passage, reply, and resolve. The
//! port of `electron/agent-comments.js`.
//!
//! Markie RS is the only writer of the comment store, so the MCP server asks
//! here instead of touching the data folder itself. The MCP server fences the
//! path first; this checks again, because the bridge is the boundary that
//! actually writes:
//! - an absolute path to a Markdown file that exists, inside the home folder,
//!   judged after symlinks are resolved;
//! - the file is only read, never written. Comments live in Markie RS's data
//!   folder (`doc-meta/`), in Electron's format.
//!
//! Local comments are a super-nightly feature. Without it the app has no
//! panel to show them, so every call refuses with the stable sentence rather
//! than storing comments nobody can see.
use crate::{COMMENTS_UNAVAILABLE, Reply};
use markie_cloud::comments::local::{Author, LocalComments, LocalThread, PlacedThread, Status, sanitize_author_name};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// `MAX_DOC_BYTES` in agent-comments.js.
pub const MAX_DOC_BYTES: u64 = 10 * 1024 * 1024;

fn commentable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx"))
}

/// `resolveDoc`: the real path of a Markdown file inside the home folder.
pub fn resolve_doc(raw: Option<&str>, home: &Path) -> Result<PathBuf, String> {
    let raw = raw.filter(|r| !r.trim().is_empty()).ok_or("Give the absolute path of a markdown file.")?;
    let expanded = raw.strip_prefix("~/").map_or_else(|| PathBuf::from(raw), |rest| home.join(rest));
    if !expanded.is_absolute() {
        return Err("Give the absolute path of a markdown file.".into());
    }
    let real = expanded.canonicalize().map_err(|_| format!("No such file: {}", expanded.display()))?;
    let real_home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    if real == real_home || !real.starts_with(&real_home) {
        return Err("path must be inside your home folder".into());
    }
    if !commentable(&real) {
        return Err("Comments work on markdown files (.md, .markdown, .mdx).".into());
    }
    let meta = std::fs::metadata(&real).map_err(|_| format!("No such file: {}", expanded.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", real.display()));
    }
    if meta.len() > MAX_DOC_BYTES {
        let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Err(format!("{name} is too large to comment on."));
    }
    Ok(real)
}

fn read_text(real: &Path) -> Result<String, String> {
    std::fs::read(real)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(|_| "Markie could not read this file.".to_string())
}

fn thread_id(params: &Value) -> Result<String, String> {
    params["thread_id"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "thread_id is required. Get it from markie_list_comments.".to_string())
}

fn author_label(author: &Author) -> String {
    match author {
        Author::User => "You".into(),
        Author::Agent { name } => sanitize_author_name(name),
    }
}

fn status_word(status: Status) -> &'static str {
    match status {
        Status::Open => "open",
        Status::Resolved => "resolved",
    }
}

/// `threadForAgent`: plain names, the quote, where it is now, the conversation.
pub fn thread_for_agent(placed: &PlacedThread) -> Value {
    let t = &placed.thread;
    let mut out = json!({
        "thread_id": t.id,
        "status": status_word(t.status),
        "anchored": placed.range.is_some(),
        "quote": t.anchor.exact,
        "comments": t.comments.iter().map(|c| json!({
            "comment_id": c.id,
            "author": author_label(&c.author),
            "body": c.body,
            "created_at": c.created_at,
        })).collect::<Vec<_>>(),
    });
    if let Some(r) = &placed.range {
        out["start"] = json!(r.start);
        out["end"] = json!(r.end);
    }
    if t.status == Status::Resolved
        && let Some(by) = &t.resolved_by
    {
        out["resolved_by"] = json!(author_label(by));
    }
    out
}

/// The thread as the agent should see it after a change.
fn current(store: &LocalComments, real: &Path, id: &str) -> Result<Value, String> {
    let text = read_text(real)?;
    Ok(store
        .list(real, &text, true)
        .iter()
        .find(|t| t.thread.id == id)
        .map(thread_for_agent)
        .unwrap_or(Value::Null))
}

fn agent_name(params: &Value) -> String {
    params["agent"].as_str().filter(|a| !a.trim().is_empty()).unwrap_or("Agent").to_string()
}

fn answer(store: &LocalComments, real: &Path, thread: Result<LocalThread, String>) -> Reply {
    let thread = thread?;
    Ok(json!({ "path": real, "thread": current(store, real, &thread.id)? }))
}

/// Handle `comments_list`, `comments_add`, `comments_reply` and
/// `comments_resolve`. `enabled` is the super-nightly switch; `data` is
/// Markie RS's own data folder.
pub fn handle(method: &str, params: &Value, data: &Path, home: &Path, enabled: bool) -> Reply {
    if !enabled {
        return Err(COMMENTS_UNAVAILABLE.into());
    }
    let store = LocalComments::new(data);
    let real = resolve_doc(params["path"].as_str(), home)?;
    match method {
        "comments_list" => {
            let text = read_text(&real)?;
            let threads: Vec<Value> = store
                .list(&real, &text, params["include_resolved"] == true)
                .iter()
                .map(thread_for_agent)
                .collect();
            let detached = threads.iter().filter(|t| t["anchored"] == false).count();
            Ok(json!({ "path": real, "count": threads.len(), "detached": detached, "threads": threads }))
        }
        "comments_add" => {
            let text = read_text(&real)?;
            let quote = params["quote"].as_str().unwrap_or_default();
            let body = params["body"].as_str().unwrap_or_default();
            let occurrence = match &params["occurrence"] {
                Value::Null => None,
                v => Some(v.as_f64().map(|n| n as i64).unwrap_or(i64::MIN)),
            };
            let thread = store.add_from_agent(
                &real,
                &text,
                quote,
                body,
                occurrence,
                params["prefix"].as_str(),
                params["suffix"].as_str(),
                &agent_name(params),
            );
            answer(&store, &real, thread)
        }
        "comments_reply" => {
            let id = thread_id(params)?;
            let body = params["body"].as_str().unwrap_or_default();
            let thread = store.reply(&real, &id, body, Author::Agent { name: sanitize_author_name(&agent_name(params)) });
            answer(&store, &real, thread)
        }
        "comments_resolve" => {
            let id = thread_id(params)?;
            let thread = store.set_status(&real, &id, Status::Resolved, Author::Agent { name: sanitize_author_name(&agent_name(params)) });
            answer(&store, &real, thread)
        }
        other => Err(format!("Unknown method: {other}")),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let data = root.path().join("data");
        std::fs::create_dir_all(home.join("notes")).unwrap();
        let doc = home.join("notes/plan.md");
        std::fs::write(&doc, "# Plan\n\nShip the quick brown fox on Friday.\nThe fox is quick.\n").unwrap();
        (root, home, data, doc)
    }

    #[test]
    fn a_stable_build_saves_nothing() {
        let (_root, home, data, doc) = setup();
        let params = json!({"path": doc, "quote": "Friday", "body": "Which Friday?"});
        assert_eq!(handle("comments_add", &params, &data, &home, false), Err(COMMENTS_UNAVAILABLE.into()));
        assert!(!data.join("doc-meta").exists());
    }

    #[test]
    fn an_agent_adds_replies_resolves_and_lists_like_electron() {
        let (_root, home, data, doc) = setup();
        let add = json!({"path": doc, "quote": "fox", "occurrence": 2, "body": "Which fox?", "agent": "Claude\nCode"});
        let added = handle("comments_add", &add, &data, &home, true).unwrap();
        let thread = &added["thread"];
        let id = thread["thread_id"].as_str().unwrap().to_string();
        assert_eq!(thread["quote"], "fox");
        assert_eq!(thread["anchored"], true);
        assert_eq!(thread["status"], "open");
        assert_eq!(thread["comments"][0]["author"], "Claude Code");
        // The second "fox", counted in UTF-16 units from the top of the file.
        let text = std::fs::read_to_string(&doc).unwrap();
        let second = text.match_indices("fox").nth(1).unwrap().0;
        assert_eq!(thread["start"], second);
        // The file itself is never written.
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), text);
        // Stored where the window's comment panel reads them.
        let store = LocalComments::new(&data);
        assert_eq!(store.threads(&doc.canonicalize().unwrap()).len(), 1);

        let reply = json!({"path": doc, "thread_id": id, "body": "The second one.", "agent": "Claude Code"});
        let replied = handle("comments_reply", &reply, &data, &home, true).unwrap();
        assert_eq!(replied["thread"]["comments"].as_array().unwrap().len(), 2);

        let resolved = handle("comments_resolve", &json!({"path": doc, "thread_id": id, "agent": "Claude Code"}), &data, &home, true).unwrap();
        assert_eq!(resolved["thread"]["status"], "resolved");
        assert_eq!(resolved["thread"]["resolved_by"], "Claude Code");

        let open = handle("comments_list", &json!({"path": doc}), &data, &home, true).unwrap();
        assert_eq!(open["count"], 0, "resolved threads are hidden by default");
        let all = handle("comments_list", &json!({"path": doc, "include_resolved": true}), &data, &home, true).unwrap();
        assert_eq!((all["count"].as_u64(), all["detached"].as_u64()), (Some(1), Some(0)));
    }

    #[test]
    fn refusals_keep_electrons_words() {
        let (root, home, data, doc) = setup();
        let ambiguous = handle("comments_add", &json!({"path": doc, "quote": "fox", "body": "x"}), &data, &home, true).unwrap_err();
        assert!(ambiguous.contains("2"), "{ambiguous}");
        let outside = root.path().join("outside.md");
        std::fs::write(&outside, "hi").unwrap();
        assert_eq!(handle("comments_list", &json!({"path": outside}), &data, &home, true).unwrap_err(), "path must be inside your home folder");
        let txt = home.join("notes/a.txt");
        std::fs::write(&txt, "hi").unwrap();
        assert_eq!(handle("comments_list", &json!({"path": txt}), &data, &home, true).unwrap_err(), "Comments work on markdown files (.md, .markdown, .mdx).");
        std::os::unix::fs::symlink(&outside, home.join("notes/link.md")).unwrap();
        assert!(handle("comments_list", &json!({"path": home.join("notes/link.md")}), &data, &home, true).is_err());
        assert_eq!(handle("comments_reply", &json!({"path": doc, "body": "x"}), &data, &home, true).unwrap_err(), "thread_id is required. Get it from markie_list_comments.");
        assert_eq!(handle("comments_list", &json!({"path": "notes/plan.md"}), &data, &home, true).unwrap_err(), "Give the absolute path of a markdown file.");
    }
}
