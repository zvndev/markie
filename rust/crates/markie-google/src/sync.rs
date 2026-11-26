//! Two-way sync for one picked Doc, and the timing around it.
//!
//! `sync_doc` is one round for one file:
//! 1. Drive `files.get`: still there, still shared, its `version` and what
//!    this account may do. Trashed or unshared: sync stops, the file stays.
//! 2. Nothing changed on either side (the file says what the last sync
//!    wrote, `version` didn't move): done, no Docs read.
//! 3. `documents.get` with suggestions inline, a three-way block diff of the
//!    base (the Markdown last synced), the file and the Doc (`merge.rs`).
//! 4. Changes made only here become requests (`plan.rs`), sent in one
//!    `batchUpdate` with `targetRevisionId`, so Google merges them with
//!    collaborator edits; as suggestions when the record says so. Never an
//!    empty one, never `files.update` with content.
//! 5. The Doc is read again. The file gets Google's changes, and any
//!    collaborator edit Google merged in, spliced around its own text. A
//!    block changed differently on both sides is a conflict: Google's text
//!    wins in the Doc and the file, and Markie's version is kept beside it
//!    as a dated conflict copy (and in the file's history).
//! 6. The new base, `revisionId` and `version` are stored.
//!
//! Compared on normalized blocks, so a sync never bounces back as a change
//! and never rewrites the file's own spelling (`*` or `-` bullets).
//!
//! `Scheduler` decides when: local saves debounced, polling every minute and
//! on focus, backoff on errors and 429s, and at most 50 writes a minute per
//! person against Google's 60 (<https://developers.google.com/workspace/docs/api/limits>).
//! `Detector` finds remote changes with `changes.list`, or, when that
//! doesn't list `drive.file` picks (unverified), with each Doc's `version`.
use crate::api::{DriveFile, SyncSource};
use crate::error::{GoogleError, Result};
use crate::md::{self, Parsed};
use crate::merge::{ChunkKind, From, diff3, merged_text};
use crate::model::Mode;
use crate::plan::{plan, remote_view};
use crate::store::{self, Stopped, SyncRecord};
use chrono::{DateTime, Local};
use markie_core::history::{History, Writer};
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// What one round did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Synced {
    /// Nothing changed on either side.
    Unchanged,
    /// Only Google changed: the file now has Google's text.
    Pulled,
    /// Edits went to Google, `pulled` if Google's own changes came in too.
    Pushed { pulled: bool },
    /// The same block changed on both sides: Google's text won, Markie's version is at `copy`.
    Conflict { copy: PathBuf, pushed: bool },
    /// Sync is off for this Doc now: trashed, unshared or the file deleted here.
    Stopped(Stopped),
    /// Two-way sync is off for this file (Refresh only).
    RefreshOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub outcome: Synced,
    /// Local edits that stay here, by reason ("tables").
    pub held: Vec<String>,
    /// How many requests went to Google.
    pub requests: usize,
}

fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.replace("\r\n", "\n").trim_end().as_bytes()))
}

/// The sentence a stopped Doc's row says.
pub fn stopped_line(s: Stopped) -> &'static str {
    match s {
        Stopped::Trashed => "Stopped: this Doc is in the trash in Google. Your file is kept.",
        Stopped::NoAccess => "Stopped: Markie can no longer open this Doc in Google. Your file is kept.",
        Stopped::FileDeleted => "Unlinked: the file was deleted on this Mac. Nothing was changed in Google.",
    }
}

/// Why a Doc can't take edits from Markie at all, if it can't.
pub fn read_only_reason(rec: &SyncRecord) -> Option<&'static str> {
    if rec.tabs > 1 {
        return Some("has tabs");
    }
    match rec.access {
        Some(a) if !a.writable(rec.suggest) && !a.can_edit && !a.can_comment => Some("view only"),
        Some(a) if !a.writable(rec.suggest) => Some("comment only, turn on suggestions"),
        _ => None,
    }
}

fn stop(db: &Connection, path: &Path, mut rec: SyncRecord, why: Stopped) -> Result<Report> {
    rec.stopped = Some(why);
    rec.error = None;
    store::put(db, path, &rec)?;
    Ok(Report { outcome: Synced::Stopped(why), held: Vec::new(), requests: 0 })
}

/// The merged block list and which chunks replace local blocks with remote ones.
fn merge_plan(chunks: &[crate::merge::Chunk]) -> (Vec<From>, Vec<(Range<usize>, Range<usize>)>, bool) {
    let mut expected = Vec::new();
    let mut replace = Vec::new();
    let mut conflict = false;
    for c in chunks {
        match c.kind {
            ChunkKind::Same | ChunkKind::LocalOnly | ChunkKind::Both => expected.extend(c.local.clone().map(From::Local)),
            ChunkKind::RemoteOnly | ChunkKind::Conflict => {
                conflict |= c.kind == ChunkKind::Conflict;
                expected.extend(c.remote.clone().map(From::Remote));
                replace.push((c.local.clone(), c.remote.clone()));
            }
        }
    }
    (expected, replace, conflict)
}

/// One sync round for the file at `path`. `history` keeps Markie's text
/// before sync replaces it. Local edits are never lost: on any failure the
/// file is left as it was.
pub fn sync_doc(src: &dyn SyncSource, db: &Connection, path: &Path, now: DateTime<Local>, history: Option<&History>) -> Result<Report> {
    let mut rec = store::get(db, path)?.ok_or_else(|| GoogleError::Store("this file is not synced with Google".into()))?;
    if let Some(s) = rec.stopped {
        return Ok(Report { outcome: Synced::Stopped(s), held: Vec::new(), requests: 0 });
    }
    if !rec.two_way {
        return Ok(Report { outcome: Synced::RefreshOnly, held: Vec::new(), requests: 0 });
    }
    // A file deleted here: unlink, never touch Drive.
    let Ok(local_text) = std::fs::read_to_string(path) else {
        return stop(db, path, rec, Stopped::FileDeleted);
    };
    let file = match src.file(&rec.doc_id) {
        Ok(f) if f.trashed => return stop(db, path, rec, Stopped::Trashed),
        Ok(f) => f,
        Err(GoogleError::NoAccess(_)) => return stop(db, path, rec, Stopped::NoAccess),
        Err(e) => return Err(remember(db, path, rec, e)),
    };
    let access = file.access();
    let prior_access = rec.access;
    if !rec.suggest_chosen {
        rec.suggest = !access.owned && (access.can_edit || access.can_comment);
    }
    rec.access = Some(access);
    let local_changed = !rec.matches_base(&local_text);
    let remote_changed = file.version.is_none() || file.version != rec.version;
    // Edits already found unsendable, in a file that hasn't changed since.
    let held_again = local_changed && rec.held_hash.as_deref() == Some(hash(&local_text).as_str());
    if (!local_changed || held_again) && !remote_changed {
        let changed = rec.error.take().is_some();
        if changed || rec.access != prior_access {
            store::put(db, path, &rec)?;
        }
        return Ok(Report { outcome: Synced::Unchanged, held: rec.held.clone(), requests: 0 });
    }
    match round(src, db, path, &mut rec, &file, &local_text, now, history) {
        Ok(r) => Ok(r),
        Err(GoogleError::NoAccess(_)) => stop(db, path, rec, Stopped::NoAccess),
        Err(e) => Err(remember(db, path, rec, e)),
    }
}

/// Keep a round's problem on the record for the row; transient ones too.
fn remember(db: &Connection, path: &Path, mut rec: SyncRecord, e: GoogleError) -> GoogleError {
    rec.error = Some(e.to_string());
    let _ = store::put(db, path, &rec);
    e
}

#[allow(clippy::too_many_arguments)]
fn round(src: &dyn SyncSource, db: &Connection, path: &Path, rec: &mut SyncRecord, file: &DriveFile, local_text: &str, now: DateTime<Local>, history: Option<&History>) -> Result<Report> {
    let doc = src.document(&rec.doc_id)?;
    let tabs = crate::convert::doc_to_markdown(&doc).tabs;
    rec.tabs = tabs;
    let base = md::parse(&rec.base_markdown);
    let local = md::parse(local_text);
    let view = match remote_view(&doc) {
        Ok(v) => v,
        Err(_) => return pull_only(db, path, rec, file, &doc, local_text, now, history, "this Doc's layout"),
    };
    if tabs > 1 {
        return pull_only(db, path, rec, file, &doc, local_text, now, history, "Docs with tabs");
    }
    let chunks = diff3(&base.keys(), &local.keys(), &view.parsed.keys());
    let access = rec.access.unwrap_or_default();
    let suggest = rec.suggest && (access.can_comment || access.can_edit);
    let writable = access.writable(rec.suggest);
    let any_local = chunks.iter().any(|c| c.kind == ChunkKind::LocalOnly);
    let mut held: Vec<String> = Vec::new();
    let mut requests = 0;
    let (after, remote2, file2) = if any_local && writable {
        let p = plan(&view, &local, &chunks, if suggest { Mode::Suggest } else { Mode::Edit });
        held.extend(p.held.iter().map(|s| s.to_string()));
        if p.requests.is_empty() {
            (None, view.clone(), file.clone())
        } else {
            let revision = doc.get("revisionId").and_then(Value::as_str).ok_or_else(|| GoogleError::Parse("revisionId".into()))?;
            src.batch_update(&rec.doc_id, &p.requests, revision, suggest)?;
            requests = p.requests.len();
            rec.pushed_at = Some(now.to_rfc3339());
            // Read back what Google now has, collaborator edits included.
            let doc2 = src.document(&rec.doc_id)?;
            let file2 = src.file(&rec.doc_id)?;
            let view2 = remote_view(&doc2).map_err(|e| GoogleError::Parse(e))?;
            (Some(md::parse(&crate::convert::doc_to_markdown(&p.after.to_doc()).markdown)), view2, file2)
        }
    } else {
        if any_local && !writable {
            held.push(if access.can_comment { "comment-only Docs without suggestions".into() } else { "view-only Docs".into() });
        }
        (None, view.clone(), file.clone())
    };
    // The file: Google's changes spliced into the local text.
    let (expected, replace, mut conflict) = merge_plan(&chunks);
    // A merge Markdown can't say (a nested item left without its parent):
    // Google's text wins, as in a conflict, and the file's text is kept as a copy.
    let merged = merged_text(&local, &view.parsed, &replace, &expected);
    let merged = match (merged, &after) {
        (None, _) => {
            conflict = true;
            remote2.markdown.clone()
        }
        (Some(m), None) => m,
        // After a write: what Google holds against what Markie expected, so a
        // collaborator edit merged in by Google reaches the file too.
        (Some(merged), Some(expected_doc)) => {
            let m = md::parse(&merged);
            let chunks2 = diff3(&expected_doc.keys(), &m.keys(), &remote2.parsed.keys());
            let (exp2, rep2, c2) = merge_plan(&chunks2);
            conflict |= c2;
            merged_text(&m, &remote2.parsed, &rep2, &exp2).unwrap_or_else(|| {
                conflict = true;
                remote2.markdown.clone()
            })
        }
    };
    let mut outcome = match (requests > 0, merged != local_text) {
        (true, pulled) => Synced::Pushed { pulled },
        (false, true) => Synced::Pulled,
        (false, false) => Synced::Unchanged,
    };
    if conflict {
        let copy = crate::import::conflict_copy(db, path, local_text, now)?;
        rec.conflict = Some(copy.clone());
        outcome = Synced::Conflict { copy, pushed: requests > 0 };
    }
    if merged != local_text {
        if let Some(h) = history {
            let _ = h.capture(path, &merged, Writer::Agent("Google Docs".into()));
        }
        markie_core::save::atomic_write(path, merged.as_bytes())?;
    }
    rec.base_markdown = remote2.markdown.clone();
    rec.revision_id = remote2.model.doc.get("revisionId").and_then(Value::as_str).map(str::to_string);
    rec.version = file2.version.clone();
    rec.modified_time = file2.modified_time.clone();
    rec.synced_at = now.to_rfc3339();
    rec.error = None;
    rec.held_hash = (!held.is_empty()).then(|| hash(&merged));
    rec.held = held.clone();
    rec.title = remote2.model.doc.get("title").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| rec.title.clone());
    store::put(db, path, rec)?;
    Ok(Report { outcome, held, requests })
}

/// A Doc Markie can only read: Google's changes come in block by block,
/// local edits stay here and are named.
#[allow(clippy::too_many_arguments)]
fn pull_only(db: &Connection, path: &Path, rec: &mut SyncRecord, file: &DriveFile, doc: &Value, local_text: &str, now: DateTime<Local>, history: Option<&History>, why: &str) -> Result<Report> {
    let converted = crate::convert::doc_to_markdown(doc);
    let base = md::parse(&rec.base_markdown);
    let local = md::parse(local_text);
    let remote: Parsed = md::parse(&converted.markdown);
    let chunks = diff3(&base.keys(), &local.keys(), &remote.keys());
    let (expected, replace, mut conflict) = merge_plan(&chunks);
    let merged = merged_text(&local, &remote, &replace, &expected).unwrap_or_else(|| {
        conflict = true;
        converted.markdown.clone()
    });
    let held: Vec<String> = if chunks.iter().any(|c| c.kind == ChunkKind::LocalOnly) { vec![why.to_string()] } else { Vec::new() };
    let mut outcome = if merged != local_text { Synced::Pulled } else { Synced::Unchanged };
    if conflict {
        let copy = crate::import::conflict_copy(db, path, local_text, now)?;
        rec.conflict = Some(copy.clone());
        outcome = Synced::Conflict { copy, pushed: false };
    }
    if merged != local_text {
        if let Some(h) = history {
            let _ = h.capture(path, &merged, Writer::Agent("Google Docs".into()));
        }
        markie_core::save::atomic_write(path, merged.as_bytes())?;
    }
    rec.base_markdown = converted.markdown;
    rec.revision_id = doc.get("revisionId").and_then(Value::as_str).map(str::to_string);
    rec.version = file.version.clone();
    rec.modified_time = file.modified_time.clone();
    rec.synced_at = now.to_rfc3339();
    rec.error = None;
    rec.held_hash = (!held.is_empty()).then(|| hash(&merged));
    rec.held = held.clone();
    store::put(db, path, rec)?;
    Ok(Report { outcome, held, requests: 0 })
}

// ------------------------------------------------------------------ timing

/// How long after the last save Markie waits before sending.
pub const DEBOUNCE: Duration = Duration::from_secs(3);
/// How often Markie looks for changes in Google while it is open.
pub const POLL: Duration = Duration::from_secs(60);
/// Markie's own ceiling, under Google's 60 writes a minute per person.
pub const WRITES_PER_MINUTE: usize = 50;
const BACKOFF_MAX: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Look for changes in Google.
    Poll,
    /// Sync these files now.
    Sync(Vec<PathBuf>),
}

#[derive(Debug, Default, Clone)]
struct DocTimer {
    /// A local save, waiting out the debounce.
    local_due: Option<Instant>,
    /// Google changed it, or someone asked: sync at the next tick.
    remote_due: bool,
    failures: u32,
    retry_at: Option<Instant>,
}

/// When to poll and when to sync each file. Pure: the caller passes the
/// time in and reports results back, so tests drive it without waiting.
#[derive(Debug, Default)]
pub struct Scheduler {
    docs: HashMap<PathBuf, DocTimer>,
    last_poll: Option<Instant>,
    poll_due: bool,
    writes: VecDeque<Instant>,
    /// Google said 429, or the network is down: nothing until then.
    paused_until: Option<Instant>,
    pause_step: u32,
    /// Files with unsaved edits in an editor: never synced underneath them.
    held: HashSet<PathBuf>,
    pub interval: Option<Duration>,
    pub debounce: Option<Duration>,
}

/// The wait before the `n`th retry: 5 s, 10 s, 20 s … up to 5 minutes.
pub fn backoff(n: u32) -> Duration {
    (Duration::from_secs(5) * 2u32.saturating_pow(n.saturating_sub(1).min(10))).min(BACKOFF_MAX)
}

impl Scheduler {
    fn interval(&self) -> Duration {
        self.interval.unwrap_or(POLL)
    }

    /// Markie (or the file watcher) saw the file written.
    pub fn saved(&mut self, path: &Path, now: Instant) {
        let d = self.debounce.unwrap_or(DEBOUNCE);
        self.docs.entry(path.to_path_buf()).or_default().local_due = Some(now + d);
    }

    /// Google reported a change, or the person asked to sync.
    pub fn changed(&mut self, path: &Path) {
        self.docs.entry(path.to_path_buf()).or_default().remote_due = true;
    }

    /// The window came to the front: poll now.
    pub fn focus(&mut self) {
        self.poll_due = true;
    }

    /// An editor has unsaved edits in this file (or not any more).
    pub fn hold(&mut self, path: &Path, held: bool) {
        if held {
            self.held.insert(path.to_path_buf());
        } else {
            self.held.remove(path);
        }
    }

    pub fn forget(&mut self, path: &Path) {
        self.docs.remove(path);
        self.held.remove(path);
    }

    pub fn paused(&self, now: Instant) -> bool {
        self.paused_until.is_some_and(|t| now < t)
    }

    /// Whether a write may go out now.
    pub fn can_write(&mut self, now: Instant) -> bool {
        while self.writes.front().is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60)) {
            self.writes.pop_front();
        }
        self.writes.len() < WRITES_PER_MINUTE
    }

    pub fn wrote(&mut self, now: Instant) {
        self.writes.push_back(now);
    }

    /// What to do now.
    pub fn due(&mut self, now: Instant) -> Vec<Action> {
        if self.paused(now) {
            return Vec::new();
        }
        let mut out = Vec::new();
        if self.poll_due || self.last_poll.is_none_or(|t| now.duration_since(t) >= self.interval()) {
            self.poll_due = false;
            self.last_poll = Some(now);
            out.push(Action::Poll);
        }
        let mut paths: Vec<PathBuf> = Vec::new();
        let writes_ok = self.can_write(now);
        for (p, t) in &mut self.docs {
            if self.held.contains(p) || t.retry_at.is_some_and(|r| now < r) {
                continue;
            }
            let local = t.local_due.is_some_and(|d| now >= d);
            // A local change waits while the write budget is spent.
            if (local && writes_ok) || t.remote_due || (t.retry_at.is_some() && t.local_due.is_none()) {
                t.local_due = None;
                t.remote_due = false;
                t.retry_at = None;
                paths.push(p.clone());
            }
        }
        paths.sort();
        if !paths.is_empty() {
            out.push(Action::Sync(paths));
        }
        out
    }

    /// A sync of `path` ended. Transient errors retry with backoff; a 429
    /// or a network failure pauses everything.
    pub fn done(&mut self, path: &Path, result: &std::result::Result<(), GoogleError>, now: Instant) {
        let t = self.docs.entry(path.to_path_buf()).or_default();
        match result {
            Ok(()) => {
                t.failures = 0;
                t.retry_at = None;
                self.pause_step = 0;
            }
            Err(e) if e.is_transient() => {
                t.failures += 1;
                t.retry_at = Some(now + backoff(t.failures));
                self.pause_for(e, now);
            }
            Err(_) => {
                t.failures = 0;
                t.retry_at = None;
            }
        }
    }

    /// A 429 or a network failure, from any call: nothing goes out for a while.
    pub fn pause_for(&mut self, e: &GoogleError, now: Instant) {
        if let GoogleError::RateLimited { retry_after_secs } = e {
            self.pause_step += 1;
            let wait = retry_after_secs.map(Duration::from_secs).unwrap_or_else(|| backoff(self.pause_step)).max(Duration::from_secs(1));
            self.paused_until = Some(now + wait);
        } else if matches!(e, GoogleError::Network(_) | GoogleError::Timeout) {
            self.pause_step += 1;
            self.paused_until = Some(now + backoff(self.pause_step));
        }
    }

    /// Whether a file is waiting to retry after an error.
    pub fn retrying(&self, path: &Path) -> bool {
        self.docs.get(path).is_some_and(|t| t.retry_at.is_some())
    }

    /// Whether a local save is waiting to go.
    pub fn pending(&self, path: &Path) -> bool {
        self.docs.get(path).is_some_and(|t| t.local_due.is_some() || t.remote_due)
    }
}

// ------------------------------------------------------------------ detection

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detect {
    /// `changes.list` has listed a picked Doc's change: trusted.
    Changes,
    /// `changes.list` missed a change `version` showed, or failed: each
    /// Doc's `version` is checked instead.
    Versions,
}

impl Detect {
    pub fn as_str(self) -> &'static str {
        match self {
            Detect::Changes => "changes",
            Detect::Versions => "versions",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "changes" => Some(Detect::Changes),
            "versions" => Some(Detect::Versions),
            _ => None,
        }
    }
}

/// Finds Docs that changed in Google. Starts with `changes.list` and checks
/// it against each Doc's `version` until it has proved itself one way or
/// the other; then keeps a slow `version` sweep as a safety net.
#[derive(Debug, Default)]
pub struct Detector {
    /// None until decided.
    pub mode: Option<Detect>,
    token: Option<String>,
    /// When the token was taken: changes older than it were never going to be listed.
    token_at: Option<DateTime<chrono::Utc>>,
    last_sweep: Option<Instant>,
    /// Docs changes.list reported since the last sweep.
    reported: HashSet<String>,
    /// Changes a sweep found too close to the list call to judge: the next
    /// list must have them, or changes.list doesn't list picks.
    suspects: HashSet<String>,
}

/// How often the safety sweep runs once changes.list is trusted.
pub const SAFETY_SWEEP: Duration = Duration::from_secs(15 * 60);

impl Detector {
    pub fn new(mode: Option<Detect>) -> Self {
        Self { mode, ..Default::default() }
    }

    /// The Doc IDs (among `records`) that changed in Google since last time.
    pub fn poll(&mut self, src: &dyn SyncSource, records: &[(PathBuf, SyncRecord)], now: Instant) -> Result<Vec<String>> {
        let watched: Vec<&SyncRecord> = records.iter().map(|(_, r)| r).filter(|r| r.two_way && r.stopped.is_none()).collect();
        if watched.is_empty() {
            return Ok(Vec::new());
        }
        let ids: HashSet<&str> = watched.iter().map(|r| r.doc_id.as_str()).collect();
        let mut changed: HashSet<String> = HashSet::new();
        let listed_at = chrono::Utc::now();
        if self.mode != Some(Detect::Versions) {
            match self.list_changes(src) {
                Ok(list) => {
                    for id in list.into_iter().filter(|i| ids.contains(i.as_str())) {
                        self.reported.insert(id.clone());
                        changed.insert(id);
                    }
                }
                Err(e) if e.is_transient() || e == GoogleError::Reconnect => return Err(e),
                // Refused outright: this grant can't list changes.
                Err(_) => self.mode = Some(Detect::Versions),
            }
        }
        // Last poll's close calls: listed now, or never going to be.
        if self.mode.is_none() && !self.suspects.is_empty() {
            let suspects = std::mem::take(&mut self.suspects);
            self.mode = Some(if suspects.iter().all(|id| self.reported.contains(id)) { Detect::Changes } else { Detect::Versions });
        }
        let sweep = match self.mode {
            Some(Detect::Versions) => true,
            None => true,
            Some(Detect::Changes) => self.last_sweep.is_none_or(|t| now.duration_since(t) >= SAFETY_SWEEP),
        };
        if sweep {
            self.last_sweep = Some(now);
            for r in &watched {
                let f = match src.file(&r.doc_id) {
                    Ok(f) => f,
                    // Gone or unshared: the sync round says so for the row.
                    Err(GoogleError::NoAccess(_)) => {
                        changed.insert(r.doc_id.clone());
                        continue;
                    }
                    Err(e) => return Err(e),
                };
                let moved = f.version.is_none() || f.version != r.version || f.trashed;
                if !moved {
                    continue;
                }
                // A change changes.list should have listed, if it lists picks.
                // Made after the token: changes.list should list it. Well before
                // the list call it is missing for sure; close to it, ask again next poll.
                let modified = f.modified_time.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|m| m.with_timezone(&chrono::Utc));
                if let (None, Some(at), Some(m), false) = (self.mode, self.token_at, modified, self.reported.contains(&r.doc_id) || f.trashed)
                    && m > at
                {
                    if m < listed_at - chrono::Duration::seconds(5) {
                        self.mode = Some(Detect::Versions);
                    } else {
                        self.suspects.insert(r.doc_id.clone());
                    }
                }
                changed.insert(r.doc_id.clone());
            }
            if self.mode.is_none() && !self.reported.is_empty() {
                self.mode = Some(Detect::Changes);
            }
            self.reported.clear();
        }
        let mut out: Vec<String> = changed.into_iter().collect();
        out.sort();
        Ok(out)
    }

    fn list_changes(&mut self, src: &dyn SyncSource) -> Result<Vec<String>> {
        let token = match self.token.clone() {
            Some(t) => t,
            None => {
                let t = src.start_page_token()?;
                self.token = Some(t.clone());
                self.token_at = Some(chrono::Utc::now());
                return Ok(Vec::new());
            }
        };
        let (ids, next) = src.changed_since(&token)?;
        self.token = Some(next);
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_wait_out_the_debounce_and_a_new_save_restarts_it() {
        let mut s = Scheduler { interval: Some(Duration::from_secs(3600)), ..Default::default() };
        let t0 = Instant::now();
        let p = Path::new("/g/a.md");
        assert_eq!(s.due(t0), vec![Action::Poll]);
        s.saved(p, t0);
        assert!(s.due(t0 + Duration::from_secs(2)).is_empty());
        s.saved(p, t0 + Duration::from_secs(2));
        assert!(s.due(t0 + Duration::from_secs(4)).is_empty(), "the second save restarted the wait");
        assert_eq!(s.due(t0 + Duration::from_secs(5)), vec![Action::Sync(vec![p.to_path_buf()])]);
        assert!(s.due(t0 + Duration::from_secs(6)).is_empty());
    }

    #[test]
    fn a_file_with_unsaved_edits_is_never_synced_underneath_them() {
        let mut s = Scheduler { interval: Some(Duration::from_secs(3600)), ..Default::default() };
        let t0 = Instant::now();
        s.due(t0);
        let p = Path::new("/g/a.md");
        s.hold(p, true);
        s.changed(p);
        assert!(s.due(t0).is_empty());
        s.hold(p, false);
        assert_eq!(s.due(t0), vec![Action::Sync(vec![p.to_path_buf()])]);
    }

    #[test]
    fn errors_back_off_and_a_429_pauses_everything() {
        assert_eq!(backoff(1), Duration::from_secs(5));
        assert_eq!(backoff(3), Duration::from_secs(20));
        assert_eq!(backoff(40), Duration::from_secs(300));
        let mut s = Scheduler { interval: Some(Duration::from_secs(3600)), ..Default::default() };
        let t0 = Instant::now();
        s.due(t0);
        let p = Path::new("/g/a.md");
        s.changed(p);
        assert_eq!(s.due(t0).len(), 1);
        s.done(p, &Err(GoogleError::RateLimited { retry_after_secs: Some(30) }), t0);
        assert!(s.paused(t0 + Duration::from_secs(29)));
        assert!(s.due(t0 + Duration::from_secs(10)).is_empty());
        // After the pause the file retries on its own.
        let later = t0 + Duration::from_secs(31);
        assert!(s.due(later).contains(&Action::Sync(vec![p.to_path_buf()])));
        // A permanent error does not retry.
        s.done(p, &Err(GoogleError::NoAccess(String::new())), later);
        assert!(!s.retrying(p));
    }

    #[test]
    fn writes_stay_under_googles_per_minute_limit() {
        let mut s = Scheduler { interval: Some(Duration::from_secs(3600)), debounce: Some(Duration::ZERO), ..Default::default() };
        let t0 = Instant::now();
        s.due(t0);
        for _ in 0..WRITES_PER_MINUTE {
            s.wrote(t0);
        }
        let p = Path::new("/g/a.md");
        s.saved(p, t0);
        assert!(s.due(t0 + Duration::from_secs(1)).is_empty(), "the minute's budget is spent");
        assert_eq!(s.due(t0 + Duration::from_secs(61)), vec![Action::Sync(vec![p.to_path_buf()])]);
    }

    #[test]
    fn focus_polls_at_once() {
        let mut s = Scheduler::default();
        let t0 = Instant::now();
        assert_eq!(s.due(t0), vec![Action::Poll]);
        assert!(s.due(t0 + Duration::from_secs(1)).is_empty());
        s.focus();
        assert_eq!(s.due(t0 + Duration::from_secs(2)), vec![Action::Poll]);
        assert_eq!(s.due(t0 + Duration::from_secs(62)), vec![Action::Poll]);
    }

    #[test]
    fn stopped_docs_say_why_in_plain_words() {
        assert!(stopped_line(Stopped::Trashed).contains("trash"));
        assert!(stopped_line(Stopped::FileDeleted).contains("Nothing was changed in Google"));
        let rec = SyncRecord { tabs: 2, ..Default::default() };
        assert_eq!(read_only_reason(&rec), Some("has tabs"));
        let viewer = SyncRecord { access: Some(store::Access { owned: false, can_edit: false, can_comment: false }), ..Default::default() };
        assert_eq!(read_only_reason(&viewer), Some("view only"));
    }
}
