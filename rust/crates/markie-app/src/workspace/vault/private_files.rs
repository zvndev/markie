//! Make Private and Make Not Private for private files, without UI. Export
//! is the vault page's own `export_decrypted`, from the opened copy.
//!
//! Make Private reads a local file, stores it in the private store
//! (`markie_vault::private`), proves the encrypted copy decrypts back to the
//! same bytes, and only then removes the original. Then every copy Markie
//! itself holds goes: history snapshots, drafts, office recovery, local
//! comments, Library and Projects rows, and the in-memory text caches. The
//! window does the rest (an open tab, previews) in `Workspace::made_private`.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use markie_core::registry::Registry;
use markie_vault::private::{PRIVATE_DIR, PRIVATE_FILE_BYTES, PrivateMetadata, PrivateStore};
use markie_vault::VaultError;

/// Where Markie RS keeps its private files.
pub fn private_dir() -> PathBuf {
    markie_core::paths::data_dir().join(PRIVATE_DIR)
}

/// Why a file cannot be made private, in words for the sheet.
#[derive(Debug)]
pub enum Refusal {
    Missing,
    NotAFile,
    /// A symbolic link: deleting it would leave the file it points to.
    Link,
    /// Another hard link to the same file would keep the plaintext.
    HardLinked,
    TooBig,
    /// It changed while it was being encrypted. Nothing was deleted.
    Changed,
    Vault(VaultError),
    /// The encrypted copy is safe, but the original could not be deleted.
    Delete(String),
}

impl Refusal {
    pub fn copy(&self) -> String {
        match self {
            Refusal::Missing => "That file is no longer there. Nothing was changed.".into(),
            Refusal::NotAFile => "Only a file can be made private, not a folder.".into(),
            Refusal::Link => "This is a link to another file. Make the file it points to private instead. Nothing was changed.".into(),
            Refusal::HardLinked => {
                "This file has another name elsewhere on the disk, which would keep an unencrypted copy. Nothing was changed.".into()
            }
            Refusal::TooBig => format!("Private files can be up to {} MiB. Nothing was changed.", PRIVATE_FILE_BYTES / (1024 * 1024)),
            Refusal::Changed => "The file changed while Markie was encrypting it. Nothing was deleted. Try again.".into(),
            Refusal::Vault(e) => super::failure_copy(e).into(),
            Refusal::Delete(e) => format!(
                "The private copy is saved, but Markie could not delete the original ({e}). Delete it yourself, or Make Not Private to undo."
            ),
        }
    }
}

/// Checks a file before anything is read: a plain file, one name, in size.
pub fn check_file(path: &Path) -> Result<u64, Refusal> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| Refusal::Missing)?;
    if meta.file_type().is_symlink() {
        return Err(Refusal::Link);
    }
    if !meta.is_file() {
        return Err(Refusal::NotAFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err(Refusal::HardLinked);
        }
    }
    if meta.len() as usize > PRIVATE_FILE_BYTES {
        return Err(Refusal::TooBig);
    }
    Ok(meta.len())
}

/// The media type a private file is stored with.
pub fn media_type_for(name: &str) -> String {
    if markie_vault::dotenv::is_env_file_name(name) {
        return "text/plain".into();
    }
    markie_core::formats::classify(name).mime_type().to_string()
}

/// Best-effort overwrite, then delete. On APFS (copy-on-write) and on SSDs
/// (wear levelling) an overwrite in place cannot be guaranteed to reach the
/// blocks that held the old bytes: the zeros may land elsewhere and the old
/// blocks stay until the volume reuses them. FileVault is what protects those
/// blocks; this only shortens the window on volumes where it does work.
fn overwrite_and_delete(path: &Path, len: u64) -> std::io::Result<()> {
    if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(path) {
        let zeros = vec![0u8; 64 * 1024];
        let mut left = len;
        while left > 0 {
            let n = left.min(zeros.len() as u64) as usize;
            if file.write_all(&zeros[..n]).is_err() {
                break;
            }
            left -= n as u64;
        }
        let _ = file.sync_all();
    }
    std::fs::remove_file(path)
}

/// Make Private, the file half. Returns the private file's ID.
///
/// The original is deleted only after the encrypted copy has been read back
/// from disk, decrypted and compared byte for byte (`PrivateStore::add`), and
/// after a second read shows the file did not change meanwhile.
pub fn make_private(store: &PrivateStore, path: &Path, now_ms: i64) -> Result<String, Refusal> {
    let len = check_file(path)?;
    let bytes = zeroize::Zeroizing::new(std::fs::read(path).map_err(|_| Refusal::Missing)?);
    if bytes.len() as u64 != len {
        return Err(Refusal::Changed);
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or(Refusal::NotAFile)?;
    let folder = path.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let metadata = PrivateMetadata { media_type: media_type_for(&name), name, folder, made_private_ms: now_ms };
    let id = store.add(&bytes, &metadata).map_err(Refusal::Vault)?;
    // Verified. Before deleting, make sure the original is still what was encrypted.
    let again = std::fs::read(path).map(zeroize::Zeroizing::new);
    if !matches!(&again, Ok(b) if b.as_slice() == bytes.as_slice()) {
        let _ = store.remove(&id);
        return Err(Refusal::Changed);
    }
    if let Err(e) = overwrite_and_delete(path, len) {
        return Err(Refusal::Delete(e.to_string()));
    }
    Ok(id)
}

/// Every copy of `path` Markie keeps in its data folder, and the in-memory
/// body-text cache. History, drafts, recovery and comments are keyed by the
/// file's path, so they go by that key.
pub fn purge_local_copies(data_dir: &Path, path: &Path, registry: Option<&Registry>) {
    let history = markie_core::history::History::new(data_dir);
    let _ = std::fs::remove_dir_all(history.dir_for(path));
    let drafts = markie_core::drafts::Drafts::new(data_dir);
    let _ = drafts.discard(&markie_core::drafts::Drafts::key_for(Some(path)));
    let _ = markie_core::office_recovery::RecoveryStore::new(data_dir).remove(path);
    let comments = markie_cloud::comments::local::LocalComments::new(data_dir);
    let _ = std::fs::remove_dir_all(comments.dir_for(path));
    if let Some(registry) = registry
        && let Err(e) = registry.purge_path(path)
    {
        eprintln!("markie-rs: registry purge failed: {e:#}");
    }
    markie_core::doc_text::SHARED_CACHE.lock().unwrap_or_else(|p| p.into_inner()).remove(path);
}

/// A name in `dir` that is free: `name`, else "name 2", "name 3"…
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// Writes a decrypted copy to a new file (never over an existing one), syncs
/// it and reads it back. Returns where it landed.
fn write_copy(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let safe = super::safe_file_name(name);
    std::fs::create_dir_all(dir)?;
    let target = free_path(dir, &safe);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    let same = written.is_ok() && std::fs::read(&target).is_ok_and(|b| b == bytes);
    if !same {
        let _ = std::fs::remove_file(&target);
        return Err(written.err().unwrap_or_else(|| std::io::Error::other("the copy did not read back the same")));
    }
    Ok(target)
}

/// Make Not Private: the file goes back to `dir` (its original folder unless
/// the user picked another) and leaves the private store, in that order.
pub fn make_not_private(store: &PrivateStore, id: &str, dir: Option<&Path>) -> Result<PathBuf, String> {
    let doc = store.read(id).map_err(|e| super::failure_copy(&e).to_string())?;
    let dir = dir.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(&doc.metadata.folder));
    let target = write_copy(&dir, &doc.metadata.name, &doc.bytes).map_err(|e| format!("Markie could not write the file there: {e}. It is still private."))?;
    store.remove(id).map_err(|e| format!("The file is back at {}, but its private copy could not be removed: {}", target.display(), super::failure_copy(&e)))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use markie_core::history::Writer;

    const PASS: &str = "synthetic fixture passphrase";
    const SECRET: &str = "Fixture memo: the synthetic launch code is OCELOT-7731-QUILL.";
    const NEEDLE: &[u8] = b"OCELOT-7731-QUILL";

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    /// Every file under `dir` whose bytes contain `needle`.
    fn files_containing(dir: &Path, needle: &[u8]) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else if std::fs::read(&p).is_ok_and(|b| contains(&b, needle)) {
                    found.push(p);
                }
            }
        }
        found
    }

    fn unlocked_store(data: &Path) -> PrivateStore {
        let mut store = PrivateStore::new(data.join(PRIVATE_DIR));
        store.unlock_or_create(PASS).unwrap();
        store
    }

    /// The test the task names: after Make Private, nothing under Markie's
    /// data folder holds the file's plaintext, though every store had a copy.
    #[test]
    fn make_private_leaves_no_plaintext_in_the_data_folder() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let docs = root.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let doc = docs.join("memo.md");
        std::fs::write(&doc, SECRET).unwrap();

        // Markie's own copies, made the way the app makes them.
        let history = markie_core::history::History::new(&data);
        history.capture(&doc, SECRET, Writer::User).unwrap();
        history.capture(&doc, &format!("{SECRET}\nsecond"), Writer::User).unwrap();
        markie_core::drafts::Drafts::new(&data).save(Some(&doc), &format!("{SECRET} draft")).unwrap();
        markie_core::office_recovery::RecoveryStore::new(&data).put(&doc, "md", SECRET.as_bytes()).unwrap();
        let comments = markie_cloud::comments::local::LocalComments::new(&data);
        comments
            .add_from_agent(&doc, SECRET, "OCELOT-7731-QUILL", "quoted the fixture", None, None, None, "fixture-agent")
            .unwrap();
        let registry = Registry::open(&data.join("registry.db")).unwrap();
        registry.track_opened(&doc).unwrap();
        markie_core::projects::store::pin_set(registry.conn(), &doc.to_string_lossy(), "OCELOT-7731-QUILL project", None).unwrap();
        markie_core::doc_text::SHARED_CACHE.lock().unwrap().set(&doc, "1:1".into(), Some(SECRET.into()));
        assert!(!files_containing(&data, NEEDLE).is_empty(), "the fixture must seed plaintext first");

        let store = unlocked_store(&data);
        let id = make_private(&store, &doc, 1).unwrap();
        purge_local_copies(&data, &doc, Some(&registry));
        drop(registry);

        assert!(!doc.exists(), "the original is gone");
        assert_eq!(files_containing(&data, NEEDLE), Vec::<PathBuf>::new());
        assert_eq!(files_containing(&data, b"memo.md"), Vec::<PathBuf>::new(), "not even the name is left");
        assert!(markie_core::doc_text::SHARED_CACHE.lock().unwrap().get(&doc, "1:1").is_none());
        assert_eq!(store.read(&id).unwrap().bytes.as_slice(), SECRET.as_bytes());
        let registry = Registry::open(&data.join("registry.db")).unwrap();
        assert!(registry.recent(10).unwrap().is_empty());
        assert!(markie_core::projects::store::pins_all(registry.conn()).unwrap().is_empty());
    }

    #[test]
    fn make_not_private_restores_the_same_bytes_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let docs = root.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let doc = docs.join("memo.txt");
        let bytes = b"\xEF\xBB\xBFfixture\r\nwith a BOM and CRLF\r\n\x00binary tail";
        std::fs::write(&doc, bytes).unwrap();
        let store = unlocked_store(&data);
        let id = make_private(&store, &doc, 1).unwrap();
        // Something took the name meanwhile: the restore lands beside it.
        std::fs::write(&doc, b"newer file").unwrap();
        let back = make_not_private(&store, &id, None).unwrap();
        assert_eq!(back, docs.join("memo 2.txt"));
        assert_eq!(std::fs::read(&back).unwrap(), bytes);
        assert_eq!(std::fs::read(&doc).unwrap(), b"newer file");
        assert_eq!(store.count(), 0);
        // A restore to a folder the user picked, which does not exist yet.
        let id = make_private(&store, &back, 2).unwrap();
        let elsewhere = root.path().join("picked");
        let copy = make_not_private(&store, &id, Some(&elsewhere)).unwrap();
        assert_eq!(copy, elsewhere.join("memo 2.txt"));
        assert_eq!(std::fs::read(copy).unwrap(), bytes);
    }

    #[test]
    fn refusals_change_nothing() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let store = unlocked_store(&data);
        assert!(matches!(make_private(&store, &root.path().join("gone.md"), 1), Err(Refusal::Missing)));
        assert!(matches!(make_private(&store, root.path(), 1), Err(Refusal::NotAFile)));
        let target = root.path().join("real.md");
        std::fs::write(&target, "fixture").unwrap();
        #[cfg(unix)]
        {
            let link = root.path().join("link.md");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(matches!(make_private(&store, &link, 1), Err(Refusal::Link)));
            let hard = root.path().join("hard.md");
            std::fs::hard_link(&target, &hard).unwrap();
            assert!(matches!(make_private(&store, &target, 1), Err(Refusal::HardLinked)));
            std::fs::remove_file(&hard).unwrap();
        }
        let mut locked = PrivateStore::new(data.join(PRIVATE_DIR));
        locked.lock();
        assert!(matches!(make_private(&locked, &target, 1), Err(Refusal::Vault(_))));
        assert!(target.exists(), "a refusal never deletes the original");
        assert_eq!(store.count(), 0);
        for r in [Refusal::Missing, Refusal::Link, Refusal::TooBig, Refusal::Changed, Refusal::Delete("busy".into())] {
            assert!(!r.copy().contains('\u{2014}'));
        }
    }
}
