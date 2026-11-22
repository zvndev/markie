//! Version history: every save keeps what the file said before, with an author
//! and time-shaped retention. Same on-disk format as `electron/history.js` and
//! `electron/snapshots.js`, so both apps can read each other's versions:
//!
//! `<data>/snapshots/<slug>/<stamp>[-2].md`, plus `meta.json`
//! (`{stamp: {author, iso, agent?, name?}}`) and `last-write.json`
//! (`{hash, author, iso, agent?}`).

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::{iso, ms_for_stamp, now_ms, sha256_hex, slug_for, stamp};

#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub keep_all_ms: i64,
    pub hourly_until_ms: i64,
    pub daily_until_ms: i64,
    pub keep_newest: usize,
    pub max_per_file: usize,
    pub max_total_bytes: u64,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            keep_all_ms: 24 * 3_600_000,
            hourly_until_ms: 7 * 24 * 3_600_000,
            daily_until_ms: 30 * 24 * 3_600_000,
            keep_newest: 5,
            max_per_file: 200,
            max_total_bytes: 500 * 1024 * 1024,
        }
    }
}

const NAME_MAX: usize = 120;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VersionMeta {
    #[serde(default)]
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iso: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LastWrite {
    hash: String,
    author: String,
    #[serde(default)]
    iso: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Version {
    pub stamp: String,
    pub ms: Option<i64>,
    pub bytes: u64,
    pub meta: VersionMeta,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Captured {
    Saved(PathBuf),
    NoFile,
    Duplicate,
    Unchanged,
}

/// Who is writing: the user, or a named agent.
#[derive(Clone, Debug)]
pub enum Writer {
    User,
    Agent(String),
}

#[derive(Clone, Copy)]
struct Entry<'a> {
    stamp: &'a str,
    ms: Option<i64>,
    named: bool,
}

/// Which stamps retention drops. Named and undatable versions are never dropped.
fn plan_retention(entries: &[Entry<'_>], now: i64, c: &Caps) -> Vec<String> {
    let named = entries.iter().filter(|e| e.named).count();
    let undated = entries.iter().filter(|e| !e.named && e.ms.is_none()).count();
    let mut sorted: Vec<&Entry<'_>> = entries.iter().filter(|e| !e.named && e.ms.is_some()).collect();
    sorted.sort_by(|a, b| b.ms.cmp(&a.ms));
    let mut drop = HashSet::new();
    let (mut hours, mut days) = (HashSet::new(), HashSet::new());
    for (i, e) in sorted.iter().enumerate() {
        if i < c.keep_newest {
            continue;
        }
        let ms = e.ms.unwrap_or_default();
        let age = now - ms;
        if age <= c.keep_all_ms {
            continue;
        }
        if age <= c.hourly_until_ms {
            if !hours.insert(ms.div_euclid(3_600_000)) {
                drop.insert(e.stamp.to_string());
            }
            continue;
        }
        if age <= c.daily_until_ms {
            if !days.insert(ms.div_euclid(86_400_000)) {
                drop.insert(e.stamp.to_string());
            }
            continue;
        }
        drop.insert(e.stamp.to_string());
    }
    let kept: Vec<&&Entry<'_>> = sorted.iter().filter(|e| !drop.contains(e.stamp)).collect();
    let room = c.max_per_file.saturating_sub(undated + named);
    for e in kept.iter().skip(room) {
        drop.insert(e.stamp.to_string());
    }
    drop.into_iter().collect()
}

fn clean_name(raw: &str) -> String {
    let line: String = raw
        .chars()
        .map(|c| if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{200b}'..='\u{200f}' | '\u{feff}') { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    line.chars().take(NAME_MAX).collect::<String>().trim().to_string()
}

pub struct History {
    root: PathBuf,
    caps: Caps,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl History {
    /// `data_dir` is the app data folder; versions live in its `snapshots/`.
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("snapshots"), caps: Caps::default(), now: Box::new(now_ms) }
    }

    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.now = Box::new(now);
        self
    }

    pub fn with_caps(mut self, caps: Caps) -> Self {
        self.caps = caps;
        self
    }

    pub fn dir_for(&self, file: &Path) -> PathBuf {
        self.root.join(slug_for(file))
    }

    fn stems(&self, file: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.dir_for(file))
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".md")).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn read_meta(&self, file: &Path) -> BTreeMap<String, VersionMeta> {
        fs::read(self.dir_for(file).join("meta.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write_meta(&self, file: &Path, meta: &BTreeMap<String, VersionMeta>) {
        let dir = self.dir_for(file);
        let _ = fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_vec(meta) {
            let _ = fs::write(dir.join("meta.json"), json);
        }
    }

    fn read_last_write(&self, file: &Path) -> Option<LastWrite> {
        fs::read(self.dir_for(file).join("last-write.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
    }

    fn write_last_write(&self, file: &Path, rec: &LastWrite) {
        let dir = self.dir_for(file);
        let _ = fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_vec(rec) {
            let _ = fs::write(dir.join("last-write.json"), json);
        }
    }

    /// Versions of `file`, oldest first.
    pub fn list(&self, file: &Path) -> Vec<Version> {
        let dir = self.dir_for(file);
        let meta = self.read_meta(file);
        self.stems(file)
            .into_iter()
            .map(|stamp| Version {
                ms: ms_for_stamp(&stamp),
                bytes: fs::metadata(dir.join(format!("{stamp}.md"))).map_or(0, |m| m.len()),
                meta: meta.get(&stamp).cloned().unwrap_or_default(),
                stamp,
            })
            .collect()
    }

    pub fn read(&self, file: &Path, stamp: &str) -> Option<String> {
        if stamp.contains(['/', '\\']) || stamp.contains("..") {
            return None;
        }
        fs::read_to_string(self.dir_for(file).join(format!("{stamp}.md"))).ok()
    }

    /// Keep what `file` says now, before `next` replaces it.
    pub fn capture(&self, file: &Path, next: &str, writer: Writer) -> std::io::Result<Captured> {
        let next_hash = sha256_hex(next.as_bytes());
        self.capture_hash(file, next_hash, writer)
    }

    /// The Node MCP announces the hash just before replacing the file.
    pub fn note_agent_write(&self, file: &Path, hash: &str, agent: String) -> std::io::Result<Captured> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "sha256 is required."));
        }
        self.capture_hash(file, hash.to_ascii_lowercase(), Writer::Agent(agent))
    }

    fn capture_hash(&self, file: &Path, next_hash: String, writer: Writer) -> std::io::Result<Captured> {
        let stamp_writer = |this: &Self| {
            let (author, agent) = match &writer {
                Writer::User => ("user".to_string(), None),
                Writer::Agent(a) => ("agent".to_string(), Some(a.clone())),
            };
            this.write_last_write(file, &LastWrite { hash: next_hash.clone(), author, iso: Some(iso((this.now)())), agent });
        };
        let Ok(previous) = fs::read_to_string(file) else {
            stamp_writer(self);
            return Ok(Captured::NoFile);
        };
        let prev_hash = sha256_hex(previous.as_bytes());
        let newest = self.stems(file).pop().and_then(|s| self.read(file, &s));
        if newest.is_some_and(|n| sha256_hex(n.as_bytes()) == prev_hash) {
            stamp_writer(self);
            return Ok(Captured::Duplicate);
        }
        if prev_hash == next_hash {
            stamp_writer(self);
            return Ok(Captured::Unchanged);
        }
        let who = match self.read_last_write(file) {
            Some(last) if last.hash == prev_hash => VersionMeta {
                author: last.author,
                iso: last.iso.or_else(|| Some(iso((self.now)()))),
                agent: last.agent,
                name: None,
            },
            last => VersionMeta {
                author: if last.is_some() { "external".into() } else { "user".into() },
                iso: Some(self.written_at(file)),
                agent: None,
                name: None,
            },
        };
        let dir = self.dir_for(file);
        fs::create_dir_all(&dir)?;
        let base = stamp((self.now)());
        let mut target = dir.join(format!("{base}.md"));
        let mut stem = base.clone();
        if target.exists() {
            stem = format!("{base}-2");
            target = dir.join(format!("{stem}.md"));
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .and_then(|mut f| std::io::Write::write_all(&mut f, previous.as_bytes()))?;
        let mut meta = self.read_meta(file);
        meta.insert(stem, who);
        self.write_meta(file, &meta);
        stamp_writer(self);
        self.retain(file);
        Ok(Captured::Saved(target))
    }

    fn written_at(&self, file: &Path) -> String {
        let now = (self.now)();
        let ms = fs::metadata(file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(now, |d| (d.as_millis() as i64).min(now));
        iso(ms)
    }

    /// Name a version (or clear its name with an empty string). Named versions
    /// are never pruned.
    pub fn set_name(&self, file: &Path, stamp: &str, raw: &str) -> Result<Option<String>, &'static str> {
        if !self.stems(file).iter().any(|s| s == stamp) {
            return Err("That version is gone.");
        }
        let name = clean_name(raw);
        let mut meta = self.read_meta(file);
        let entry = meta.entry(stamp.to_string()).or_default();
        entry.name = (!name.is_empty()).then(|| name.clone());
        self.write_meta(file, &meta);
        if name.is_empty() {
            self.retain(file);
        }
        Ok((!name.is_empty()).then_some(name))
    }

    fn retain(&self, file: &Path) {
        let dir = self.dir_for(file);
        let mut meta = self.read_meta(file);
        let stems = self.stems(file);
        let entries: Vec<Entry<'_>> = stems
            .iter()
            .map(|s| Entry {
                stamp: s,
                ms: ms_for_stamp(s),
                named: meta.get(s).is_some_and(|m| m.name.as_deref().is_some_and(|n| !n.is_empty())),
            })
            .collect();
        let drop = plan_retention(&entries, (self.now)(), &self.caps);
        if !drop.is_empty() {
            for stamp in &drop {
                let _ = fs::remove_file(dir.join(format!("{stamp}.md")));
                meta.remove(stamp);
            }
            self.write_meta(file, &meta);
        }
        self.prune_total();
    }

    /// Oldest unnamed versions across every document go first once the store
    /// passes its size cap.
    fn prune_total(&self) {
        let Ok(slugs) = fs::read_dir(&self.root) else { return };
        let mut all = Vec::new();
        for slug in slugs.flatten() {
            let folder = slug.path();
            let meta: BTreeMap<String, VersionMeta> = fs::read(folder.join("meta.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            let Ok(names) = fs::read_dir(&folder) else { continue };
            for n in names.flatten() {
                let name = n.file_name().to_string_lossy().into_owned();
                let Some(stem) = name.strip_suffix(".md") else { continue };
                let bytes = n.metadata().map_or(0, |m| m.len());
                let named = meta.get(stem).is_some_and(|m| m.name.is_some());
                all.push((name.clone(), folder.clone(), stem.to_string(), bytes, named));
            }
        }
        all.sort_by(|a, b| a.0.cmp(&b.0));
        let mut total: u64 = all.iter().map(|e| e.3).sum();
        for (_, folder, stem, bytes, named) in all {
            if total <= self.caps.max_total_bytes {
                break;
            }
            if named {
                continue;
            }
            let _ = fs::remove_file(folder.join(format!("{stem}.md")));
            let meta_path = folder.join("meta.json");
            if let Ok(mut meta) = fs::read(&meta_path)
                .map_err(|_| ())
                .and_then(|b| serde_json::from_slice::<BTreeMap<String, VersionMeta>>(&b).map_err(|_| ()))
            {
                meta.remove(&stem);
                if let Ok(json) = serde_json::to_vec(&meta) {
                    let _ = fs::write(meta_path, json);
                }
            }
            total -= bytes;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn setup() -> (tempfile::TempDir, PathBuf, History, Arc<AtomicI64>) {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("note.md");
        let clock = Arc::new(AtomicI64::new(1_763_721_252_345));
        let c = clock.clone();
        let history = History::new(&dir.path().join("data")).with_clock(move || c.load(Ordering::SeqCst));
        (dir, doc, history, clock)
    }

    #[test]
    fn keeps_the_previous_text_with_an_author() {
        let (_d, doc, h, clock) = setup();
        fs::write(&doc, "one").unwrap();
        assert_eq!(
            h.capture(&doc, "two", Writer::User).unwrap(),
            Captured::Saved(h.dir_for(&doc).join("2025-11-21T10-34-12.345Z.md"))
        );
        fs::write(&doc, "two").unwrap();
        clock.fetch_add(1000, Ordering::SeqCst);
        h.capture(&doc, "three", Writer::User).unwrap();
        let versions = h.list(&doc);
        assert_eq!(versions.len(), 2);
        assert_eq!(h.read(&doc, &versions[0].stamp).as_deref(), Some("one"));
        assert_eq!(h.read(&doc, &versions[1].stamp).as_deref(), Some("two"));
        assert_eq!(versions[1].meta.author, "user", "our own save wrote 'two'");
    }

    #[test]
    fn outside_writes_are_attributed_and_duplicates_skipped() {
        let (_d, doc, h, clock) = setup();
        fs::write(&doc, "mine").unwrap();
        h.capture(&doc, "mine 2", Writer::User).unwrap();
        fs::write(&doc, "someone else").unwrap();
        clock.fetch_add(1000, Ordering::SeqCst);
        h.capture(&doc, "mine 3", Writer::User).unwrap();
        assert_eq!(h.list(&doc).last().unwrap().meta.author, "external");
        assert_eq!(h.capture(&doc, "mine 3", Writer::User).unwrap(), Captured::Duplicate);
    }

    #[test]
    fn names_protect_versions_from_retention() {
        let (_d, doc, h, clock) = setup();
        fs::write(&doc, "v0").unwrap();
        for i in 1..=12 {
            clock.fetch_add(3 * 3_600_000, Ordering::SeqCst);
            h.capture(&doc, &format!("v{i}"), Writer::User).unwrap();
            fs::write(&doc, format!("v{i}")).unwrap();
            if i == 1 {
                let first = h.list(&doc)[0].stamp.clone();
                assert_eq!(h.set_name(&doc, &first, "  Launch\ndraft ").unwrap().as_deref(), Some("Launch draft"));
            }
        }
        clock.fetch_add(60 * 86_400_000, Ordering::SeqCst);
        fs::write(&doc, "late").unwrap();
        h.capture(&doc, "later", Writer::User).unwrap();
        let versions = h.list(&doc);
        assert!(versions.iter().any(|v| v.meta.name.as_deref() == Some("Launch draft")));
        assert!(versions.len() <= 1 + 5 + 1, "old unnamed versions pruned: {}", versions.len());
    }

    #[test]
    fn retention_plan_matches_the_electron_rules() {
        let now = 100 * 86_400_000;
        let stamps: Vec<String> = (0..10).map(|i| format!("s{i}")).collect();
        let entries: Vec<Entry<'_>> = stamps
            .iter()
            .enumerate()
            .map(|(i, s)| Entry { stamp: s, ms: Some(now - 2 * 3_600_000 * 24 - i as i64 * 60_000), named: false })
            .collect();
        // Ten versions a minute apart, two days old: five newest kept by the floor,
        // the rest share one hour bucket, so one more survives.
        let drop = plan_retention(&entries, now, &Caps::default());
        assert_eq!(drop.len(), 4);
    }
}
