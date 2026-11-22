//! Comments on local Markdown files, kept in the app's own data folder.
//! A port of electron/local-comments.js and electron/doc-meta.js.
//!
//! One folder per document under `<data>/doc-meta/`, named like the version
//! history folder (`<sha256(abs)[:8]>-<basename>`). `comments.json` holds
//! `{version: 1, threads: [...]}` and `doc.json` names the path. Markie RS's
//! data folder is its own, so these never mix with Electron's. Every write is
//! atomic (a temp file beside, then a rename). A thread whose quote is gone is
//! listed as detached, never dropped.
use crate::comments::anchor::{TextAnchor, TextRange, is_anchor, locate_quote, make_anchor, resolve_anchor};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

const KIND: &str = "comments";
const DOC_FILE: &str = "doc.json";
pub const MAX_BODY_CHARS: usize = 10_000;
pub const MAX_THREADS: usize = 500;
pub const MAX_COMMENTS_PER_THREAD: usize = 200;
const AGENT_NAME_MAX: usize = 64;
const DEFAULT_AGENT_NAME: &str = "Agent";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Author {
    User,
    Agent { name: String },
}

impl Author {
    /// "You" for the person at the keyboard, the agent's own name otherwise.
    pub fn label(&self) -> String {
        match self {
            Author::User => "You".into(),
            Author::Agent { name } => sanitize_author_name(name),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalComment {
    pub id: String,
    pub author: Author,
    pub body: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Resolved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalThread {
    pub id: String,
    pub anchor: TextAnchor,
    pub status: Status,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub comments: Vec<LocalComment>,
    #[serde(rename = "resolvedAt", skip_serializing_if = "Option::is_none", default)]
    pub resolved_at: Option<String>,
    #[serde(rename = "resolvedBy", skip_serializing_if = "Option::is_none", default)]
    pub resolved_by: Option<Author>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Record {
    version: u32,
    threads: Vec<LocalThread>,
}

/// A thread with where its quote is in the text now.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedThread {
    pub thread: LocalThread,
    /// None: the quote is gone, the thread is detached.
    pub range: Option<TextRange>,
}

/// The MCP client's name, reduced to one printable line (`sanitizeAuthorName`).
pub fn sanitize_author_name(raw: &str) -> String {
    let line: String = raw
        .chars()
        .map(|c| if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{feff}') || ('\u{e000}'..='\u{f8ff}').contains(&c) { ' ' } else { c })
        .collect();
    let squeezed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let clipped: String = squeezed.chars().take(AGENT_NAME_MAX).collect::<String>().trim().to_string();
    if clipped.is_empty() { DEFAULT_AGENT_NAME.into() } else { clipped }
}

fn clean_body(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("A comment needs some text.".into());
    }
    let body = raw.replace("\r\n", "\n").replace('\r', "\n").trim().to_string();
    if body.encode_utf16().count() > MAX_BODY_CHARS {
        return Err(format!("A comment can be at most {MAX_BODY_CHARS} characters."));
    }
    Ok(body)
}

/// `path.resolve`: absolute, with `.` and `..` folded.
fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `slugFor` in electron/snapshots.js: `<sha256(abs)[:8]>-<basename>`, the
/// basename with anything but `[A-Za-z0-9_. -]` as `_`, at most 60 units.
pub fn slug_for(path: &Path) -> String {
    let abs = resolve(path);
    let s = abs.to_string_lossy();
    let hash = hex::encode(Sha256::digest(s.as_bytes()));
    let base = abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let clean: String = base
        .encode_utf16()
        .map(|u| match u {
            0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f | 0x2e | 0x2d | 0x20 => u as u8 as char,
            _ => '_',
        })
        .take(60)
        .collect();
    format!("{}-{}", &hash[..8], if clean.is_empty() { "document".into() } else { clean })
}

fn now_iso() -> String {
    chrono_like_iso(std::time::SystemTime::now())
}

/// `Date.prototype.toISOString`: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn chrono_like_iso(t: std::time::SystemTime) -> String {
    let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let ms = d.as_millis() as i64;
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms.rem_euclid(1000))
}

fn new_id(prefix: &str) -> String {
    let mut b = [0u8; 9];
    let _ = getrandom::fill(&mut b);
    format!("{prefix}_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b))
}

/// Write beside the target, then rename over it.
fn write_atomic(file: &Path, body: &str) -> std::io::Result<()> {
    let dir = file.parent().unwrap_or(Path::new("."));
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    let tmp = dir.join(format!(
        "{}.markie-{:x}-{:x}-{}.tmp",
        file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
        hex::encode(b)
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The store: `<data>/doc-meta`.
#[derive(Debug, Clone)]
pub struct LocalComments {
    root: PathBuf,
}

impl LocalComments {
    /// `data_dir` is the app's data folder (Markie RS's own, never Electron's).
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("doc-meta") }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dir_for(&self, doc: &Path) -> PathBuf {
        self.root.join(slug_for(doc))
    }

    fn file_for(&self, doc: &Path) -> PathBuf {
        self.dir_for(doc).join(format!("{KIND}.json"))
    }

    fn load(&self, doc: &Path) -> Record {
        let threads = std::fs::read_to_string(self.file_for(doc))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("threads").cloned())
            .and_then(|t| t.as_array().cloned())
            .map(|a| a.into_iter().filter_map(|t| serde_json::from_value::<LocalThread>(t).ok()).collect())
            .unwrap_or_default();
        Record { version: 1, threads }
    }

    fn save(&self, doc: &Path, rec: &Record) -> Result<(), String> {
        let file = self.file_for(doc);
        let folder = file.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let body = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
        write_atomic(&file, &body).map_err(|e| e.to_string())?;
        let mut d = Map::new();
        d.insert("path".into(), json!(resolve(doc).to_string_lossy()));
        d.insert("updatedAt".into(), json!(now_iso()));
        write_atomic(&folder.join(DOC_FILE), &serde_json::to_string_pretty(&Value::Object(d)).unwrap()).map_err(|e| e.to_string())
    }

    /// Threads as stored, each with where its quote is in `text` now.
    pub fn list(&self, doc: &Path, text: &str, include_resolved: bool) -> Vec<PlacedThread> {
        self.load(doc)
            .threads
            .into_iter()
            .filter(|t| include_resolved || t.status != Status::Resolved)
            .map(|t| {
                let range = resolve_anchor(text, &t.anchor);
                PlacedThread { thread: t, range }
            })
            .collect()
    }

    pub fn threads(&self, doc: &Path) -> Vec<LocalThread> {
        self.load(doc).threads
    }

    fn add_thread(&self, doc: &Path, anchor: TextAnchor, body: &str, author: Author) -> Result<LocalThread, String> {
        if !is_anchor(&anchor) {
            return Err("That selection cannot be commented on.".into());
        }
        let mut rec = self.load(doc);
        if rec.threads.len() >= MAX_THREADS {
            return Err(format!("This document already has {MAX_THREADS} comment threads."));
        }
        let now = now_iso();
        let thread = LocalThread {
            id: new_id("t"),
            anchor,
            status: Status::Open,
            created_at: now.clone(),
            comments: vec![LocalComment { id: new_id("c"), author, body: clean_body(body)?, created_at: now }],
            resolved_at: None,
            resolved_by: None,
        };
        rec.threads.push(thread.clone());
        self.save(doc, &rec)?;
        Ok(thread)
    }

    /// The person at the keyboard comments on a range of the text in the editor.
    pub fn add_from_user(&self, doc: &Path, anchor: TextAnchor, body: &str) -> Result<LocalThread, String> {
        self.add_thread(doc, anchor, body, Author::User)
    }

    /// An agent comments on a quote, located in the file as it is on disk.
    pub fn add_from_agent(&self, doc: &Path, text: &str, quote: &str, body: &str, occurrence: Option<i64>, prefix: Option<&str>, suffix: Option<&str>, agent: &str) -> Result<LocalThread, String> {
        let at = locate_quote(text, quote, occurrence, prefix, suffix).map_err(|e| e.0)?;
        let anchor = make_anchor(text, at.start, at.end).ok_or("That quote cannot be commented on.")?;
        self.add_thread(doc, anchor, body, Author::Agent { name: sanitize_author_name(agent) })
    }

    pub fn reply(&self, doc: &Path, thread_id: &str, body: &str, author: Author) -> Result<LocalThread, String> {
        let mut rec = self.load(doc);
        let t = rec.threads.iter_mut().find(|t| t.id == thread_id).ok_or_else(|| format!("No comment thread {thread_id} on this document."))?;
        if t.comments.len() >= MAX_COMMENTS_PER_THREAD {
            return Err("This thread is full. Start a new one.".into());
        }
        t.comments.push(LocalComment { id: new_id("c"), author, body: clean_body(body)?, created_at: now_iso() });
        // A reply to a resolved thread reopens it.
        if t.status == Status::Resolved {
            t.status = Status::Open;
            t.resolved_at = None;
            t.resolved_by = None;
        }
        let out = t.clone();
        self.save(doc, &rec)?;
        Ok(out)
    }

    pub fn set_status(&self, doc: &Path, thread_id: &str, status: Status, author: Author) -> Result<LocalThread, String> {
        let mut rec = self.load(doc);
        let t = rec.threads.iter_mut().find(|t| t.id == thread_id).ok_or_else(|| format!("No comment thread {thread_id} on this document."))?;
        t.status = status;
        if status == Status::Resolved {
            t.resolved_at = Some(now_iso());
            t.resolved_by = Some(author);
        } else {
            t.resolved_at = None;
            t.resolved_by = None;
        }
        let out = t.clone();
        self.save(doc, &rec)?;
        Ok(out)
    }

    /// Only the person at the keyboard deletes, and only their own comments.
    /// Returns whether the thread went with it.
    pub fn remove_own(&self, doc: &Path, thread_id: &str, comment_id: &str) -> Result<bool, String> {
        let mut rec = self.load(doc);
        let t = rec.threads.iter_mut().find(|t| t.id == thread_id).ok_or_else(|| format!("No comment thread {thread_id} on this document."))?;
        let c = t.comments.iter().find(|c| c.id == comment_id).ok_or("That comment is already gone.")?;
        if c.author != Author::User {
            return Err("You can delete only your own comments.".into());
        }
        t.comments.retain(|c| c.id != comment_id);
        let gone = t.comments.is_empty();
        if gone {
            rec.threads.retain(|t| t.id != thread_id);
        }
        self.save(doc, &rec)?;
        Ok(gone)
    }

    /// Carry records along after the app renamed or moved `from` to `to`
    /// (a file or a folder). Never overwrites: a folder already at the
    /// destination is set aside as `.replaced-N`.
    pub fn move_records(&self, from: &Path, to: &Path) -> usize {
        let (src, dest) = (resolve(from), resolve(to));
        if src == dest {
            return 0;
        }
        let Ok(entries) = std::fs::read_dir(&self.root) else { return 0 };
        let mut moved = 0;
        for e in entries.flatten() {
            let folder = e.path();
            let Some(recorded) = std::fs::read_to_string(folder.join(DOC_FILE)).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.get("path")?.as_str().map(PathBuf::from)) else { continue };
            let recorded = resolve(&recorded);
            let next = if recorded == src {
                dest.clone()
            } else if let Ok(rel) = recorded.strip_prefix(&src) {
                dest.join(rel)
            } else {
                continue;
            };
            let target = self.dir_for(&next);
            if target == folder {
                continue;
            }
            if target.exists() {
                let mut n = 1;
                while target.with_extension(format!("replaced-{n}")).exists() {
                    n += 1;
                }
                let aside = PathBuf::from(format!("{}.replaced-{n}", target.to_string_lossy()));
                if std::fs::rename(&target, aside).is_err() {
                    continue;
                }
            }
            if std::fs::rename(&folder, &target).is_ok() {
                let doc_file = target.join(DOC_FILE);
                let mut d: Map<String, Value> = std::fs::read_to_string(&doc_file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
                d.insert("path".into(), json!(next.to_string_lossy()));
                d.insert("movedAt".into(), json!(now_iso()));
                let _ = write_atomic(&doc_file, &serde_json::to_string_pretty(&Value::Object(d)).unwrap());
                moved += 1;
            }
        }
        moved
    }
}

/// Whether a path is a document local comments apply to.
pub fn is_commentable_doc(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_match_electron() {
        // sha256("/tmp/a b/Notes é.md")[:8], basename with é as one `_`.
        let s = slug_for(Path::new("/tmp/a b/Notes é.md"));
        assert!(s.ends_with("-Notes _.md"), "{s}");
        assert_eq!(s.len(), 8 + 1 + "Notes _.md".len());
        assert_eq!(slug_for(Path::new("/tmp/x/../y.md")), slug_for(Path::new("/tmp/y.md")));
        assert!(slug_for(Path::new("/tmp/😀.md")).ends_with("-__.md"), "an emoji is two UTF-16 units");
    }

    #[test]
    fn iso_stamps_look_like_javascripts() {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_763_812_345_678);
        assert_eq!(chrono_like_iso(t), "2025-11-22T11:52:25.678Z");
    }

    #[test]
    fn threads_round_trip_on_disk_in_electrons_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalComments::new(dir.path());
        let doc = dir.path().join("notes.md");
        let text = "# Notes\n\nThe quick brown fox.\n";
        std::fs::write(&doc, text).unwrap();
        let a = make_anchor(text, 13, 18).unwrap();
        let t = store.add_from_user(&doc, a, "  Is it quick?  ").unwrap();
        assert_eq!(t.comments[0].body, "Is it quick?");
        assert!(t.id.starts_with("t_") && t.id.len() == 14);
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(store.dir_for(&doc).join("comments.json")).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["threads"][0]["anchor"]["exact"], "quick");
        assert_eq!(raw["threads"][0]["comments"][0]["author"], json!({ "kind": "user" }));
        let doc_json: Value = serde_json::from_str(&std::fs::read_to_string(store.dir_for(&doc).join("doc.json")).unwrap()).unwrap();
        assert_eq!(doc_json["path"], json!(doc.to_string_lossy()));

        let agent = store.add_from_agent(&doc, text, "brown fox", "Consider red.", None, None, None, "Claude\nCode").unwrap();
        assert_eq!(agent.comments[0].author, Author::Agent { name: "Claude Code".into() });
        let resolved = store.set_status(&doc, &t.id, Status::Resolved, Author::Agent { name: "Claude".into() }).unwrap();
        assert!(resolved.resolved_at.is_some());
        let reopened = store.reply(&doc, &t.id, "Still?", Author::User).unwrap();
        assert_eq!(reopened.status, Status::Open);
        assert!(reopened.resolved_by.is_none());

        // The quote moved: it still resolves. Removed: detached, not dropped.
        let placed = store.list(&doc, "Intro.\n\n# Notes\n\nThe quick brown fox.\n", true);
        assert_eq!(placed[0].range, Some(TextRange { start: 21, end: 26 }));
        let placed = store.list(&doc, "Nothing here.\n", true);
        assert!(placed.iter().all(|p| p.range.is_none()));
        assert_eq!(placed.len(), 2);

        // Agents' comments cannot be deleted; your own can, and the thread goes with the last.
        assert!(store.remove_own(&doc, &agent.id, &agent.comments[0].id).is_err());
        let c0 = &t.comments[0].id;
        assert!(!store.remove_own(&doc, &t.id, c0).unwrap());
        assert_eq!(store.threads(&doc).len(), 2);

        // A rename carries the folder.
        let moved = dir.path().join("renamed.md");
        assert_eq!(store.move_records(&doc, &moved), 1);
        assert_eq!(store.threads(&moved).len(), 2);
        assert!(store.threads(&doc).is_empty());
    }

    #[test]
    fn electron_files_load() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalComments::new(dir.path());
        let doc = Path::new("/tmp/elsewhere/x.md");
        let folder = store.dir_for(doc);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("comments.json"),
            r#"{"version":1,"threads":[{"id":"t_abc","anchor":{"exact":"x","prefix":"","suffix":"","start":0},"status":"resolved","createdAt":"2026-11-01T00:00:00.000Z","comments":[{"id":"c_1","author":{"kind":"agent","name":"Codex"},"body":"hi","createdAt":"2026-11-01T00:00:00.000Z"}],"resolvedAt":"2026-11-02T00:00:00.000Z","resolvedBy":{"kind":"user"}}]}"#,
        )
        .unwrap();
        let t = store.threads(doc);
        assert_eq!(t[0].resolved_by, Some(Author::User));
        assert_eq!(t[0].comments[0].author.label(), "Codex");
    }
}
