//! Crash drafts: the unsaved text of an open document, kept so a crash or a
//! forced quit never loses typing. Same format as `electron/drafts.js`:
//! `<data>/drafts/<slug>.md` plus `index.json`
//! (`{slug: {path, name, savedAt, bytes}}`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::{iso, now_ms, parse_iso, slug_for};

const MAX_AGE_MS: i64 = 7 * 86_400_000;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;

/// `use-save-guard.ts`: the journal runs ahead of the file, 250 ms after the
/// last edit, and 2 s for a buffer past 256 K characters (JavaScript string
/// length, UTF-16 units), where each write costs more.
pub const DRAFT_DEBOUNCE_MS: u64 = 250;
pub const BIG_DRAFT_CHARS: usize = 256 * 1024;
pub const BIG_DRAFT_DEBOUNCE_MS: u64 = 2000;

pub fn journal_delay_ms(text: &str) -> u64 {
    // UTF-16 length is at most the UTF-8 length, and at least a third of it,
    // so only a buffer in between is counted.
    let big = if text.len() <= BIG_DRAFT_CHARS {
        false
    } else if text.len() > BIG_DRAFT_CHARS * 3 {
        true
    } else {
        text.encode_utf16().count() > BIG_DRAFT_CHARS
    };
    if big { BIG_DRAFT_DEBOUNCE_MS } else { DRAFT_DEBOUNCE_MS }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftMeta {
    pub path: Option<String>,
    pub name: Option<String>,
    pub saved_at: String,
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub key: String,
    pub meta: DraftMeta,
}

pub struct Drafts {
    root: PathBuf,
}

impl Drafts {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("drafts") }
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn read_index(&self) -> BTreeMap<String, DraftMeta> {
        fs::read(self.index_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write_index(&self, index: &BTreeMap<String, DraftMeta>) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)?;
        let tmp = self.root.join("index.json.tmp");
        fs::write(&tmp, serde_json::to_vec(index)?)?;
        fs::rename(tmp, self.index_path())
    }

    pub fn key_for(path: Option<&Path>) -> String {
        path.map_or_else(|| "untitled".into(), slug_for)
    }

    fn file_for(&self, key: &str) -> PathBuf {
        self.root.join(format!("{key}.md"))
    }

    /// Keep `content` as the draft for `path`. Empty content clears the draft.
    pub fn save(&self, path: Option<&Path>, content: &str) -> std::io::Result<()> {
        let key = Self::key_for(path);
        let mut index = self.read_index();
        if content.trim().is_empty() {
            let _ = fs::remove_file(self.file_for(&key));
            index.remove(&key);
            return self.write_index(&index);
        }
        fs::create_dir_all(&self.root)?;
        let tmp = self.root.join(format!("{key}.md.tmp"));
        fs::write(&tmp, content)?;
        fs::rename(&tmp, self.file_for(&key))?;
        index.insert(
            key,
            DraftMeta {
                path: path.map(|p| std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().into_owned()),
                name: path.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()),
                saved_at: iso(now_ms()),
                bytes: content.len() as u64,
            },
        );
        self.prune(&mut index);
        self.write_index(&index)
    }

    fn prune(&self, index: &mut BTreeMap<String, DraftMeta>) {
        let cutoff = now_ms() - MAX_AGE_MS;
        let mut entries: Vec<(String, i64, u64)> = index
            .iter()
            .map(|(k, m)| (k.clone(), parse_iso(&m.saved_at).unwrap_or(0), m.bytes))
            .collect();
        entries.sort_by_key(|e| e.1);
        let mut total = 0;
        for (key, at, bytes) in &entries {
            if *at < cutoff {
                let _ = fs::remove_file(self.file_for(key));
                index.remove(key);
            } else {
                total += bytes;
            }
        }
        for (key, _, bytes) in &entries {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            if index.remove(key).is_some() {
                let _ = fs::remove_file(self.file_for(key));
                total -= bytes;
            }
        }
    }

    /// Drafts newer than the file they belong to, newest first.
    pub fn pending(&self) -> Vec<Draft> {
        let mut out: Vec<Draft> = self
            .read_index()
            .into_iter()
            .filter(|(_, meta)| {
                let Some(path) = &meta.path else { return true };
                let saved = parse_iso(&meta.saved_at).unwrap_or(0);
                let mtime = fs::metadata(path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64);
                !mtime.is_some_and(|m| m >= saved)
            })
            .map(|(key, meta)| Draft { key, meta })
            .collect();
        out.sort_by(|a, b| b.meta.saved_at.cmp(&a.meta.saved_at));
        out
    }

    pub fn read(&self, key: &str) -> Option<String> {
        if key.contains(['/', '\\']) || key.contains("..") {
            return None;
        }
        fs::read_to_string(self.file_for(key)).ok()
    }

    pub fn discard(&self, key: &str) -> std::io::Result<()> {
        let mut index = self.read_index();
        let _ = fs::remove_file(self.file_for(key));
        index.remove(key);
        self.write_index(&index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_waits_like_the_save_guard() {
        assert_eq!(journal_delay_ms("short"), 250);
        assert_eq!(journal_delay_ms(&"a".repeat(BIG_DRAFT_CHARS)), 250);
        assert_eq!(journal_delay_ms(&"a".repeat(BIG_DRAFT_CHARS + 1)), 2000);
        // 'é' is two UTF-8 bytes and one UTF-16 unit: JavaScript counts one.
        assert_eq!(journal_delay_ms(&"é".repeat(BIG_DRAFT_CHARS)), 250);
        assert_eq!(journal_delay_ms(&"é".repeat(BIG_DRAFT_CHARS + 1)), 2000);
    }

    #[test]
    fn a_draft_survives_until_the_file_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "saved").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let drafts = Drafts::new(&dir.path().join("data"));
        drafts.save(Some(&doc), "typed but not saved").unwrap();
        let pending = drafts.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(drafts.read(&pending[0].key).as_deref(), Some("typed but not saved"));
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&doc, "saved again").unwrap();
        assert!(drafts.pending().is_empty(), "a newer save supersedes the draft");
        drafts.save(Some(&doc), "   ").unwrap();
        assert!(drafts.read(&pending[0].key).is_none(), "blank content clears it");
    }
}
