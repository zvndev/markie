//! The on-disk Electron asset-cache layout, confined to Markie RS's data dir.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type RequestResult = crate::error::Result<PathBuf>;
type RequestSlot = tokio::sync::Mutex<Option<RequestResult>>;

#[derive(Default)]
struct DiskState {
    generations: HashMap<PathBuf, u64>,
    requests: HashMap<(PathBuf, u64, String), Weak<RequestSlot>>,
}

static DISK: LazyLock<Mutex<DiskState>> = LazyLock::new(|| Mutex::new(DiskState::default()));
pub const CACHE_DIRECTORY: &str = "asset-cache";
pub const CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const CACHE_VALID_FOR: Duration = Duration::from_secs(60);

#[derive(Default, Deserialize, Serialize)]
struct Index {
    session: Option<String>,
    entries: BTreeMap<String, Entry>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub hash: String,
    mime: String,
    size: u64,
    used: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    validated_at: Option<i64>,
}

impl Entry {
    pub fn fresh(&self, now: i64) -> bool {
        self.validated_at.is_some_and(|at| {
            (0..CACHE_VALID_FOR.as_millis() as i64).contains(&now.saturating_sub(at))
        })
    }
}

pub struct AssetCache {
    dir: PathBuf,
    session: String,
    scopes: Vec<(String, String)>,
    generation: u64,
    limit: u64,
}

pub(crate) fn valid_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn index(dir: &Path) -> Index {
    let path = dir.join("cache.json");
    if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() <= 64 * 1024 * 1024) {
        return Index::default();
    }
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Index>(&bytes).ok())
        .map(|mut index| { index.entries.retain(|_, entry| valid_hash(&entry.hash)); index })
        .unwrap_or_default()
}

fn require_regular_or_missing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "asset cache entry is not a regular file")),
    }
}

fn write_index(dir: &Path, index: &Index) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join("cache.json");
    require_regular_or_missing(&path)?;
    markie_core::save::atomic_write(&path, &serde_json::to_vec(index)?)
}

fn bind(disk: &mut DiskState, dir: &Path, session: Option<&str>) -> io::Result<u64> {
    let marker = dir.join(".pending-clear");
    if fs::symlink_metadata(dir).is_ok_and(|meta| !meta.is_dir()) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "asset cache root is not a directory"));
    }
    require_regular_or_missing(&marker)?;
    require_regular_or_missing(&dir.join("cache.json"))?;
    let old = index(dir);
    let generation = disk.generations.entry(dir.to_path_buf()).or_default();
    let current = *generation;
    if !marker.exists() && old.session.as_deref() == session {
        return Ok(current);
    }
    *generation = current.wrapping_add(1);
    fs::create_dir_all(dir)?;
    // Fail closed if the previous owner could not be removed.
    fs::write(&marker, [])?;
    for item in fs::read_dir(dir)? {
        let item = item?;
        if item.file_name().to_str().is_some_and(valid_hash) {
            fs::remove_file(item.path())?;
        }
    }
    write_index(dir, &Index { session: session.map(str::to_string), entries: BTreeMap::new() })?;
    fs::remove_file(marker)?;
    Ok(*generation)
}

impl AssetCache {
    pub fn for_account(dir: &Path, account: &str, origin: &str) -> io::Result<Self> {
        Ok(Self::bind_sessions(dir, vec![(account.into(), origin.into())])?.expect("one scope"))
    }

    /// Bind the cache to the complete active account set. Navigating between
    /// documents on different signed-in servers does not change ownership.
    pub fn bind_sessions(dir: &Path, mut scopes: Vec<(String, String)>) -> io::Result<Option<Self>> {
        scopes.sort_unstable();
        scopes.dedup();
        if scopes.is_empty() {
            Self::clear(dir)?;
            return Ok(None);
        }
        let session = hex::encode(Sha256::digest(serde_json::to_vec(&scopes)?));
        let mut disk = DISK.lock().unwrap_or_else(|e| e.into_inner());
        let generation = bind(&mut disk, dir, Some(&session))?;
        Ok(Some(Self { dir: dir.into(), session, scopes, generation, limit: CACHE_LIMIT_BYTES }))
    }

    pub fn clear(dir: &Path) -> io::Result<()> {
        let mut disk = DISK.lock().unwrap_or_else(|e| e.into_inner());
        bind(&mut disk, dir, None).map(|_| ())
    }

    pub(crate) fn key(&self, account: &str, origin: &str, id: &str, reference: &str) -> Option<String> {
        self.scopes.iter().any(|(user, server)| user == account && server == origin).then(|| {
            let scope = crate::sync::hash_content(&serde_json::to_string(&(account, origin, id)).unwrap());
            format!("{scope}\t{reference}")
        })
    }

    /// Share an in-flight answer (including failures) with its waiters.
    /// Never hold the disk mutex across an await.
    pub(crate) fn request(&self, key: &str) -> Arc<RequestSlot> {
        let mut disk = DISK.lock().unwrap_or_else(|e| e.into_inner());
        disk.requests.retain(|_, lock| lock.strong_count() > 0);
        let slot = disk.requests.entry((self.dir.clone(), self.generation, key.into())).or_default();
        if let Some(lock) = slot.upgrade() {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(None));
        *slot = Arc::downgrade(&lock);
        lock
    }

    fn with_index<T>(&self, edit: impl FnOnce(&mut Index) -> io::Result<T>) -> io::Result<T> {
        let disk = DISK.lock().unwrap_or_else(|e| e.into_inner());
        if !fs::symlink_metadata(&self.dir).is_ok_and(|meta| meta.is_dir()) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "asset cache root is not a directory"));
        }
        let mut state = index(&self.dir);
        if disk.generations.get(&self.dir) != Some(&self.generation)
            || state.session.as_deref() != Some(&self.session)
            || fs::symlink_metadata(self.dir.join(".pending-clear")).is_ok()
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "asset cache session changed"));
        }
        let result = edit(&mut state)?;
        write_index(&self.dir, &state)?;
        Ok(result)
    }

    pub(crate) fn lookup(&self, key: &str, now: i64, validated: bool) -> io::Result<Option<(PathBuf, Entry)>> {
        self.with_index(|index| {
            let used = index.entries.values().map(|e| e.used.saturating_add(1)).max().unwrap_or(now).max(now);
            let Some(entry) = index.entries.get_mut(key) else { return Ok(None) };
            let path = self.dir.join(&entry.hash);
            if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.len() == entry.size) {
                index.entries.remove(key);
                return Ok(None);
            }
            entry.used = used;
            if validated { entry.validated_at = Some(now); }
            Ok(Some((path, entry.clone())))
        })
    }

    fn drop_unshared(&self, index: &Index, hash: &str) {
        if !index.entries.values().any(|entry| entry.hash == hash) {
            let _ = fs::remove_file(self.dir.join(hash));
        }
    }

    pub(crate) fn forget(&self, key: &str) -> io::Result<()> {
        self.with_index(|index| {
            if let Some(entry) = index.entries.remove(key) {
                self.drop_unshared(index, &entry.hash);
            }
            Ok(())
        })
    }

    pub(crate) fn store(&self, key: String, mime: &str, hash: &str, bytes: &[u8], now: i64) -> io::Result<PathBuf> {
        if !valid_hash(hash) || hex::encode(Sha256::digest(bytes)) != hash || bytes.len() as u64 > self.limit {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid asset cache payload"));
        }
        self.with_index(|index| {
            let path = self.dir.join(hash);
            require_regular_or_missing(&path)?;
            let size = bytes.len() as u64;
            if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.len() == size) {
                markie_core::save::atomic_write(&path, bytes)?;
            }
            let used = index.entries.values().map(|e| e.used.saturating_add(1)).max().unwrap_or(now).max(now);
            let old = index.entries.insert(key, Entry { hash: hash.into(), mime: mime.into(), size, used, validated_at: Some(now) });
            if let Some(old) = old { self.drop_unshared(index, &old.hash); }
            self.evict(index)?;
            Ok(path)
        })
    }

    fn evict(&self, index: &mut Index) -> io::Result<()> {
        let mut blobs = HashMap::<String, (u64, i64)>::new();
        for entry in index.entries.values() {
            let (_, last) = blobs.entry(entry.hash.clone()).or_insert((entry.size, entry.used));
            *last = (*last).max(entry.used);
        }
        let mut total = blobs.values().map(|(size, _)| *size).fold(0u64, u64::saturating_add);
        let mut lru: Vec<_> = blobs.into_iter().collect();
        lru.sort_by_key(|(_, (_, used))| *used);
        for (hash, (size, _)) in lru {
            if total <= self.limit { break; }
            match fs::remove_file(self.dir.join(&hash)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            index.entries.retain(|_, entry| entry.hash != hash);
            total = total.saturating_sub(size);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(cache: &AssetCache, key: &str, bytes: &[u8], now: i64) -> PathBuf {
        cache.store(key.into(), "image/png", &hex::encode(Sha256::digest(bytes)), bytes, now).unwrap()
    }

    #[test]
    fn the_cache_drops_the_least_recently_used_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = AssetCache::for_account(dir.path(), "alice", "https://a.example").unwrap();
        cache.limit = 20;
        let a = put(&cache, "a", &[1; 10], 1);
        let b = put(&cache, "b", &[2; 10], 2);
        cache.lookup("a", 3, false).unwrap().unwrap();
        let c = put(&cache, "c", &[3; 10], 4);
        assert!(!b.exists(), "the least recently used file goes first");
        assert!(cache.lookup("b", 5, false).unwrap().is_none(), "its ETag goes with it");
        assert!(a.exists() && c.exists(), "reading the oldest file promotes it");
    }

    #[test]
    fn a_different_session_or_a_sign_out_empties_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let origin = "https://a.example";
        let alice = AssetCache::for_account(dir.path(), "alice", origin).unwrap();
        let a = put(&alice, "doc", b"a", 1);
        AssetCache::for_account(dir.path(), "alice", origin).unwrap();
        assert!(a.exists(), "same session keeps its pictures");
        let bob = AssetCache::for_account(dir.path(), "bob", origin).unwrap();
        assert!(!a.exists(), "another account starts empty");
        let b = put(&bob, "doc", b"b", 2);
        AssetCache::clear(dir.path()).unwrap();
        assert!(!b.exists(), "signing out empties it");
        assert!(index(dir.path()).session.is_none() && index(dir.path()).entries.is_empty());
        let same_bob = AssetCache::for_account(dir.path(), "bob", origin).unwrap();
        assert!(same_bob.lookup("doc", 3, false).unwrap().is_none());
        assert!(bob.store("doc".into(), "image/png", &crate::sync::hash_content("b"), b"b", 3).is_err(),
            "an old request cannot repopulate the cache after signing out and back in");
    }

    #[test]
    fn multiple_accounts_share_one_budget_without_sharing_references() {
        let dir = tempfile::tempdir().unwrap();
        let scopes = vec![
            ("alice".into(), "https://a.example".into()),
            ("alice".into(), "https://b.example".into()),
            ("bob".into(), "https://a.example".into()),
        ];
        let cache = AssetCache::bind_sessions(dir.path(), scopes.clone()).unwrap().unwrap();
        let key = |account, origin, id, reference| cache.key(account, origin, id, reference).unwrap();
        let a = key("alice", "https://a.example", "doc", "pic.png");
        let b = key("alice", "https://b.example", "doc", "pic.png");
        let c = key("bob", "https://a.example", "doc", "pic.png");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, key("alice", "https://a.example", "doc2", "pic.png"));
        assert_ne!(a, key("alice", "https://a.example", "doc", "other.png"));
        let a_path = put(&cache, &a, b"a", 1);
        let b_path = put(&cache, &b, b"b", 2);
        let reordered = AssetCache::bind_sessions(dir.path(), scopes.into_iter().rev().collect()).unwrap().unwrap();
        assert_eq!(reordered.lookup(&a, 3, false).unwrap().unwrap().0, a_path);
        assert_eq!(reordered.lookup(&b, 4, false).unwrap().unwrap().0, b_path);
        assert!(reordered.lookup(&c, 4, false).unwrap().is_none());
        assert!(cache.key("bob", "https://b.example", "doc", "pic.png").is_none());
    }

    #[test]
    fn persists_deduplicated_hash_files_and_wipes_when_account_changes() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().join("asset-cache");
        let mut cache = AssetCache::for_account(&dir, "fixture", "https://example.org").unwrap();
        cache.limit = 6;
        let store = |cache: &AssetCache, key: &str, bytes: &[u8], now| {
            cache.store(key.into(), "image/png", &hex::encode(Sha256::digest(bytes)), bytes, now).unwrap()
        };
        let first = store(&cache, "doc1\tpic.png", b"abc", 42);
        assert_eq!(store(&cache, "doc2\tpic.png", b"abc", 43), first);
        let json: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("cache.json")).unwrap()).unwrap();
        assert_eq!(json["entries"]["doc1\tpic.png"]["validatedAt"], 42);
        assert_eq!(json["entries"]["doc1\tpic.png"]["size"], 3);
        let second = store(&cache, "doc3\tpic.png", b"defg", 44);
        assert!(!first.exists());
        assert!(second.is_file());
        let reopened = AssetCache::for_account(&dir, "fixture", "https://example.org").unwrap();
        assert!(reopened.lookup("doc3\tpic.png", 45, false).unwrap().unwrap().1.fresh(45));
        let other = AssetCache::for_account(&dir, "different-fixture", "https://example.org").unwrap();
        assert!(!second.exists());
        assert!(other.lookup("doc3\tpic.png", 46, false).unwrap().is_none());
        assert!(reopened.lookup("doc3\tpic.png", 46, false).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn never_overwrites_through_a_cache_symlink() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().join("asset-cache");
        let cache = AssetCache::for_account(&dir, "fixture", "https://example.org").unwrap();
        let protected = scratch.path().join("protected");
        fs::write(&protected, b"unchanged").unwrap();
        let hash = hex::encode(Sha256::digest(b"abc"));
        std::os::unix::fs::symlink(&protected, dir.join(&hash)).unwrap();
        assert!(cache.store("doc\tpic.png".into(), "image/png", &hash, b"abc", 42).is_err());
        assert_eq!(fs::read(&protected).unwrap(), b"unchanged");
    }
}
