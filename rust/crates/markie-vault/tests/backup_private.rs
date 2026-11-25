//! Vault backups with private files: the version 2 format, restore and merge.
//! Every file here is made up for the test.
use markie_vault::backup::{
    read_vault_backup_file, restore_vault_backup_file, write_vault_backup_file, RestoreReport, VAULT_BACKUP_FILE_NAME,
};
use markie_vault::envelope::VaultDocumentMetadata;
use markie_vault::private::{PrivateMetadata, PrivateStore, PRIVATE_DIR, PRIVATE_FILE_BYTES};
use markie_vault::{FileVaultStorage, StorageErrorCode, VaultError, VaultErrorCode, VaultRepository};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const PASS: &str = "synthetic backup passphrase one";
const OTHER: &str = "synthetic backup passphrase two";

/// One Mac's Markie RS data folder: the vault and the private files.
struct Mac {
    _dir: tempfile::TempDir,
    data: PathBuf,
    repo: VaultRepository<FileVaultStorage>,
    store: PrivateStore,
}

impl Mac {
    fn empty() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_path_buf();
        let mut repo = VaultRepository::new(FileVaultStorage::new(data.join("vault.json")));
        repo.inspect().unwrap();
        Self { store: PrivateStore::new(data.join(PRIVATE_DIR)), _dir: dir, data, repo }
    }

    fn with_vault(passphrase: &str) -> Self {
        let mut mac = Self::empty();
        mac.repo.create(passphrase).unwrap();
        mac.repo
            .save(None, b"FIXTURE_TOKEN=made-up-vault-value\n", &VaultDocumentMetadata { name: "fixture.env".into(), media_type: "text/x-dotenv".into() })
            .unwrap();
        mac.store.unlock_or_create(passphrase).unwrap();
        mac
    }

    fn add(&self, name: &str, media_type: &str, folder: &str, bytes: &[u8]) -> String {
        self.store.add(bytes, &meta(name, media_type, folder)).unwrap()
    }

    fn back_up(&self, out: &Path) -> markie_vault::backup::BackupSummary {
        write_vault_backup_file(&self.repo.backup().unwrap(), &self.store, out).unwrap()
    }

    /// Every file under the data folder, by name, with a digest of its bytes.
    fn disk(&self) -> BTreeMap<String, Vec<u8>> {
        fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    let rel = path.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                    out.insert(rel, Sha256::digest(std::fs::read(&path).unwrap()).to_vec());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.data, &self.data, &mut out);
        out
    }

    /// Name and bytes of every private file, sorted.
    fn private_files(&self) -> Vec<(String, String, String, Vec<u8>)> {
        let mut out: Vec<_> = self
            .store
            .list()
            .unwrap()
            .into_iter()
            .map(|e| {
                let doc = self.store.read(&e.id).unwrap();
                (e.metadata.name, e.metadata.media_type, e.metadata.folder, doc.bytes.to_vec())
            })
            .collect();
        out.sort();
        out
    }
}

fn meta(name: &str, media_type: &str, folder: &str) -> PrivateMetadata {
    PrivateMetadata { name: name.into(), media_type: media_type.into(), folder: folder.into(), made_private_ms: 1_764_000_000_000 }
}

fn found(haystack: &[u8], needle: &[u8]) -> bool {
    regex::bytes::Regex::new(&regex::escape(&String::from_utf8_lossy(needle))).unwrap().is_match(haystack)
}

/// Made-up files of several formats. The markers must never appear in a backup.
fn fixtures() -> Vec<(&'static str, &'static str, &'static str, Vec<u8>)> {
    let mut pdf = b"%PDF-1.7\n1 0 obj << /Title (FIXTURE-PDF-MARKER) >> endobj\n".to_vec();
    pdf.extend((0..2000u32).map(|i| (i * 7 % 251) as u8));
    let mut docx = b"PK\x03\x04word/document.xml FIXTURE-DOCX-MARKER".to_vec();
    docx.extend(std::iter::repeat_n(0u8, 512));
    vec![
        ("Launch plan.md", "text/markdown", "/Users/fixture/Plans", b"# Fixture plan\nThe made-up code is FIXTURE-MD-MARKER.\n".to_vec()),
        ("notes.txt", "text/plain", "/Users/fixture/Notes", b"FIXTURE-TXT-MARKER plain text\n".to_vec()),
        ("staging.env", "text/x-dotenv", "/Users/fixture/Config", b"FIXTURE_ENV_MARKER=not-a-real-key\n".to_vec()),
        ("lease.pdf", "application/pdf", "/Users/fixture/Papers", pdf),
        ("Report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "/Users/fixture/Papers", docx),
    ]
}

const NEEDLES: &[&[u8]] = &[
    b"FIXTURE-MD-MARKER",
    b"FIXTURE-TXT-MARKER",
    b"FIXTURE_ENV_MARKER",
    b"FIXTURE-PDF-MARKER",
    b"FIXTURE-DOCX-MARKER",
    b"Launch plan",
    b"notes.txt",
    b"staging.env",
    b"lease.pdf",
    b"Report.docx",
    b"/Users/fixture",
    b"made-up-vault-value",
    b"fixture.env",
];

#[test]
fn private_files_round_trip_and_the_backup_holds_no_plaintext_or_names() {
    let source = Mac::with_vault(PASS);
    for (name, media, folder, bytes) in fixtures() {
        source.add(name, media, folder, &bytes);
    }
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    let summary = source.back_up(&out);
    assert_eq!((summary.version, summary.private_files), (2, 5));

    // The byte scan: no contents, names or folders, in the clear or as UTF-16.
    let bytes = std::fs::read(&out).unwrap();
    for needle in NEEDLES {
        assert!(!found(&bytes, needle), "the backup holds {:?}", String::from_utf8_lossy(needle));
        let wide: Vec<u8> = needle.iter().flat_map(|b| [*b, 0]).collect();
        assert!(!bytes.windows(wide.len()).any(|w| w == wide.as_slice()));
    }
    // The private-files key travels only as key.json's passphrase-wrapped slot.
    assert!(found(&bytes, b"\"kdf\":\"PBKDF2-HMAC-SHA256\""));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&out).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // No temporary file is left beside it.
    assert_eq!(std::fs::read_dir(out_dir.path()).unwrap().count(), 1);

    // A new Mac: no vault, no private files.
    let mut target = Mac::empty();
    let backup = read_vault_backup_file(&out).unwrap();
    assert_eq!((backup.version, backup.private_count()), (2, 5));
    let report = restore_vault_backup_file(&mut target.repo, &mut target.store, &backup, PASS, false).unwrap();
    assert_eq!(report, RestoreReport { replaced_vault_id: None, private_restored: 5, private_already_here: 0, private_kept_both: 0 });
    assert!(target.store.is_unlocked());
    assert_eq!(target.private_files(), source.private_files());
    assert_eq!(target.repo.list("").unwrap().len(), 1);
    // The passphrase alone opens them again later.
    target.store.lock();
    target.store.unlock(PASS).unwrap();
    assert_eq!(target.store.count(), 5);
}

#[test]
fn a_private_file_near_the_size_limit_round_trips() {
    let source = Mac::with_vault(PASS);
    let mut large = Vec::with_capacity(PRIVATE_FILE_BYTES - 4096);
    let line = b"FIXTURE-LARGE-LINE synthetic filler for the size limit test.\n";
    while large.len() + line.len() <= PRIVATE_FILE_BYTES - 4096 {
        large.extend_from_slice(line);
    }
    source.add("big archive.bin", "application/octet-stream", "/Users/fixture/Big", &large);
    source.add("small.md", "text/markdown", "/Users/fixture/Big", b"# small fixture\n");
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    assert_eq!(source.back_up(&out).private_files, 2);
    let bytes = std::fs::read(&out).unwrap();
    assert!(bytes.len() > PRIVATE_FILE_BYTES - 4096);
    for needle in [&b"FIXTURE-LARGE-LINE"[..], b"big archive", b"/Users/fixture"] {
        assert!(!found(&bytes, needle));
    }
    drop(bytes);
    let mut target = Mac::empty();
    let backup = read_vault_backup_file(&out).unwrap();
    let report = restore_vault_backup_file(&mut target.repo, &mut target.store, &backup, PASS, false).unwrap();
    assert_eq!(report.private_came_back(), 2);
    let entry = target.store.list().unwrap().into_iter().find(|e| e.metadata.name == "big archive.bin").unwrap();
    assert_eq!(entry.bytes, large.len());
    assert!(target.store.read(&entry.id).unwrap().bytes.as_slice() == large.as_slice());
}

#[test]
fn an_old_backup_restores_exactly_as_before() {
    let source = Mac::with_vault(PASS);
    let old = source.repo.backup().unwrap();
    // A vault with no private files still writes version 1, byte for byte, so Electron reads it.
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    assert_eq!(source.back_up(&out).version, 1);
    assert_eq!(std::fs::read_to_string(&out).unwrap(), old);

    let mut target = Mac::empty();
    let backup = read_vault_backup_file(&out).unwrap();
    assert_eq!((backup.version, backup.private_count()), (1, 0));
    assert_eq!(backup.vault_text(), old);
    let report = restore_vault_backup_file(&mut target.repo, &mut target.store, &backup, PASS, false).unwrap();
    assert_eq!(report, RestoreReport::default());
    assert_eq!(target.repo.list("").unwrap().len(), 1);
    // Private files are left alone: no key is made.
    assert!(!target.store.has_key());
    // The same backup through the old text path still works too.
    let mut again = Mac::empty();
    again.repo.restore(&old, PASS, false).unwrap();

    // A version 1 file with a leading byte-order mark, as before.
    let bom = out_dir.path().join("bom.markievault");
    std::fs::write(&bom, format!("\u{feff}{old}")).unwrap();
    assert_eq!(read_vault_backup_file(&bom).unwrap().version, 1);
}

#[test]
fn restoring_merges_and_never_overwrites() {
    let mut mac = Mac::with_vault(PASS);
    let kept = mac.add("kept.md", "text/markdown", "/Users/fixture/A", b"kept fixture\n");
    let edited = mac.add("edited.md", "text/markdown", "/Users/fixture/A", b"before the edit\n");
    let removed = mac.add("removed.txt", "text/plain", "/Users/fixture/B", b"removed fixture\n");
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    mac.back_up(&out);

    // After the backup: one edited, one removed, one new.
    mac.store.replace(&edited, b"after the edit\n", &meta("edited.md", "text/markdown", "/Users/fixture/A")).unwrap();
    mac.store.remove(&removed).unwrap();
    mac.add("new.md", "text/markdown", "/Users/fixture/C", b"new fixture\n");

    let backup = read_vault_backup_file(&out).unwrap();
    let report = restore_vault_backup_file(&mut mac.repo, &mut mac.store, &backup, PASS, true).unwrap();
    assert_eq!(report.private_restored, 1, "removed.txt came back under its own ID");
    assert_eq!(report.private_already_here, 1, "kept.md was identical");
    assert_eq!(report.private_kept_both, 1, "edited.md differs: both copies stay");
    assert!(report.replaced_vault_id.is_some());

    let files = mac.private_files();
    let edited_copies: Vec<&[u8]> = files.iter().filter(|f| f.0 == "edited.md").map(|f| f.3.as_slice()).collect();
    assert_eq!(edited_copies.len(), 2);
    assert!(edited_copies.contains(&&b"after the edit\n"[..]));
    assert!(edited_copies.contains(&&b"before the edit\n"[..]));
    assert!(mac.store.read(&removed).is_ok());
    assert_eq!(mac.store.read(&edited).unwrap().bytes.as_slice(), b"after the edit\n");
    assert!(mac.store.read(&kept).is_ok());
    assert_eq!(files.len(), 5);

    // Restoring the same backup again adds nothing, not even a second copy of edited.md.
    let again = restore_vault_backup_file(&mut mac.repo, &mut mac.store, &backup, PASS, true).unwrap();
    assert_eq!(again.private_came_back(), 0);
    assert_eq!(again.private_already_here, 3);
}

#[test]
fn merging_into_a_mac_with_its_own_key_keeps_its_files_under_one_passphrase() {
    let source = Mac::with_vault(PASS);
    source.add("from backup.md", "text/markdown", "/Users/fixture/A", b"backup fixture\n");
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    source.back_up(&out);
    let backup = read_vault_backup_file(&out).unwrap();

    // Another Mac, another vault and passphrase, with a private file of its own.
    let mut other = Mac::with_vault(OTHER);
    let own = other.add("own.md", "text/markdown", "/Users/fixture/B", b"own fixture\n");

    // Locked, its files cannot be carried over: refused, nothing changed.
    other.store.lock();
    let before = other.disk();
    let refused = restore_vault_backup_file(&mut other.repo, &mut other.store, &backup, PASS, true).unwrap_err();
    assert!(matches!(refused, VaultError::PrivateFilesLocked));
    assert_eq!(other.disk(), before);

    // Open, they are merged and the store moves to the restored vault's passphrase.
    other.store.unlock(OTHER).unwrap();
    let report = restore_vault_backup_file(&mut other.repo, &mut other.store, &backup, PASS, true).unwrap();
    assert_eq!(report.private_restored, 1);
    let mut fresh = PrivateStore::new(other.data.join(PRIVATE_DIR));
    assert_eq!(fresh.unlock(OTHER).unwrap_err().code(), Some(VaultErrorCode::AuthenticationFailed));
    fresh.unlock(PASS).unwrap();
    assert_eq!(fresh.read(&own).unwrap().bytes.as_slice(), b"own fixture\n");
    assert_eq!(fresh.count(), 2);
}

#[test]
fn a_wrong_passphrase_changes_nothing() {
    let source = Mac::with_vault(PASS);
    source.add("a.md", "text/markdown", "/Users/fixture/A", b"fixture\n");
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    source.back_up(&out);
    let backup = read_vault_backup_file(&out).unwrap();

    let mut target = Mac::empty();
    let err = restore_vault_backup_file(&mut target.repo, &mut target.store, &backup, "not the backup passphrase at all", false).unwrap_err();
    assert_eq!(err.code(), Some(VaultErrorCode::AuthenticationFailed));
    assert!(target.disk().is_empty());
    assert!(!target.store.is_unlocked());

    // Into a Mac with its own vault: that vault and its files stay as they were.
    let mut other = Mac::with_vault(OTHER);
    other.add("own.md", "text/markdown", "/Users/fixture/B", b"own\n");
    let before = other.disk();
    let err = restore_vault_backup_file(&mut other.repo, &mut other.store, &backup, OTHER, true).unwrap_err();
    assert_eq!(err.code(), Some(VaultErrorCode::AuthenticationFailed));
    assert_eq!(other.disk(), before);
}

/// Rewrites a version 2 backup with `edit` applied to its body (after the
/// manifest), then recomputes every digest so only the encryption can notice.
fn forge(bytes: &[u8], edit: impl FnOnce(&mut [u8])) -> Vec<u8> {
    let first = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    let second = first + bytes[first..].iter().position(|b| *b == b'\n').unwrap() + 1;
    let mut manifest: serde_json::Value = serde_json::from_slice(&bytes[first..second - 1]).unwrap();
    let mut body = bytes[second..bytes.len() - 32].to_vec();
    edit(&mut body);
    let vault_bytes = manifest["vaultBytes"].as_u64().unwrap() as usize;
    let mut at = vault_bytes;
    for file in manifest["files"].as_array_mut().unwrap() {
        let n = file["bytes"].as_u64().unwrap() as usize;
        let digest: String = Sha256::digest(&body[at..at + n]).iter().map(|b| format!("{b:02x}")).collect();
        file["sha256"] = digest.into();
        at += n;
    }
    let mut out = bytes[..first].to_vec();
    out.extend_from_slice(manifest.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(&body);
    let digest = Sha256::digest(&out);
    out.extend_from_slice(&digest);
    out
}

#[test]
fn a_truncated_or_tampered_backup_is_refused_and_changes_nothing() {
    let source = Mac::with_vault(PASS);
    source.add("a.md", "text/markdown", "/Users/fixture/A", b"first fixture\n");
    source.add("b.md", "text/markdown", "/Users/fixture/A", b"second fixture\n");
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    source.back_up(&out);
    let good = std::fs::read(&out).unwrap();
    let bad = out_dir.path().join("bad.markievault");
    let refused = |bytes: &[u8]| {
        std::fs::write(&bad, bytes).unwrap();
        read_vault_backup_file(&bad).unwrap_err()
    };

    // Truncated anywhere, or one byte flipped anywhere: refused before the passphrase.
    for cut in [1, 32, 33, good.len() / 2, good.len() - 40] {
        assert!(matches!(refused(&good[..good.len() - cut]), VaultError::Backup), "cut {cut}");
    }
    for at in [25, good.len() / 3, good.len() / 2, good.len() - 50, good.len() - 1] {
        let mut flipped = good.clone();
        flipped[at] ^= 0x01;
        assert!(matches!(refused(&flipped), VaultError::Backup), "flip at {at}");
    }
    let mut longer = good.clone();
    longer.push(0);
    assert!(matches!(refused(&longer), VaultError::Backup));

    // A forged file whose digests all match: the encryption refuses it, and nothing changes.
    let forged = forge(&good, |body| {
        let last = body.len() - 1;
        body[last] ^= 0x01;
    });
    std::fs::write(&bad, &forged).unwrap();
    let checked = read_vault_backup_file(&bad).unwrap();
    let mut other = Mac::with_vault(PASS);
    other.add("own.md", "text/markdown", "/Users/fixture/B", b"own\n");
    let before = other.disk();
    let err = restore_vault_backup_file(&mut other.repo, &mut other.store, &checked, PASS, true).unwrap_err();
    assert_eq!(err.code(), Some(VaultErrorCode::AuthenticationFailed));
    assert_eq!(other.disk(), before);
    let mut empty = Mac::empty();
    assert!(restore_vault_backup_file(&mut empty.repo, &mut empty.store, &checked, PASS, false).is_err());
    assert!(empty.disk().is_empty());

    // Changed on disk after it was checked: the second read notices.
    let checked = read_vault_backup_file(&out).unwrap();
    let mut changed = good.clone();
    let at = good.len() - 40;
    changed[at] ^= 0x01;
    std::fs::write(&out, &changed).unwrap();
    let mut late = Mac::empty();
    assert!(matches!(restore_vault_backup_file(&mut late.repo, &mut late.store, &checked, PASS, false).unwrap_err(), VaultError::Backup));
    assert!(late.disk().is_empty());
}

#[test]
fn unknown_future_versions_are_refused_with_their_own_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("future.markievault");
    std::fs::write(&path, b"MARKIE-VAULT-BACKUP 3\n{}\n").unwrap();
    assert!(matches!(read_vault_backup_file(&path).unwrap_err(), VaultError::BackupTooNew));
    std::fs::write(&path, br#"{"kind":"markie-vault-backup","version":7,"header":"x","records":[]}"#).unwrap();
    assert!(matches!(read_vault_backup_file(&path).unwrap_err(), VaultError::BackupTooNew));
    for junk in [&b"MARKIE-VAULT-BACKUP 1\n{}\n"[..], b"MARKIE-VAULT-BACKUP x\n", b"MARKIE-VAULT-BACKUP 2\n", b"not a backup", b""] {
        std::fs::write(&path, junk).unwrap();
        assert!(matches!(read_vault_backup_file(&path).unwrap_err(), VaultError::Backup));
    }
}

#[test]
fn a_backup_of_a_store_without_its_key_is_refused() {
    let source = Mac::with_vault(PASS);
    source.add("a.md", "text/markdown", "/Users/fixture/A", b"fixture\n");
    std::fs::remove_file(source.data.join(PRIVATE_DIR).join("key.json")).unwrap();
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join(VAULT_BACKUP_FILE_NAME);
    let err = write_vault_backup_file(&source.repo.backup().unwrap(), &source.store, &out).unwrap_err();
    assert_eq!(err.storage_code(), Some(StorageErrorCode::Unavailable));
    assert!(!out.exists());
    assert_eq!(std::fs::read_dir(out_dir.path()).unwrap().count(), 0);
}
