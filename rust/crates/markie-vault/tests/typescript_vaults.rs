//! Vaults written by the repo's TypeScript (`markie-migrate/fixtures/generate/gen.ts`),
//! opened here without Node. The fixture holds only made-up test data.
use markie_vault::backup::parse_vault_backup;
use markie_vault::device::DeviceKeeper;
use markie_vault::envelope::{decode_base64_checked, VaultDocumentMetadata};
use markie_vault::{DeviceFailure, FileVaultStorage, MemoryVaultStorage, StorageErrorCode, StoredVault, VaultError, VaultRepository, VaultStorage};
use serde_json::Value;
use zeroize::Zeroizing;

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../markie-migrate/tests/fixtures/fixture-data.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn std_b64(s: &str) -> Vec<u8> {
    let url = s.replace('+', "-").replace('/', "_");
    let url = url.trim_end_matches('=');
    if url.is_empty() { Vec::new() } else { decode_base64_checked(url, 0, 1 << 30).unwrap() }
}

struct Fixed(Vec<u8>);
impl DeviceKeeper for Fixed {
    fn release(&self, _: &str) -> Result<Zeroizing<[u8; 32]>, DeviceFailure> {
        Ok(Zeroizing::new(self.0.as_slice().try_into().unwrap()))
    }
    fn store(&self, _: &str, _: &[u8]) -> Result<(), DeviceFailure> {
        Ok(())
    }
    fn remove(&self, _: &str) -> Result<(), DeviceFailure> {
        Ok(())
    }
}

fn assert_documents<S: VaultStorage>(repo: &VaultRepository<S>, expected: &Value) {
    let mut expected: Vec<(String, String, Vec<u8>)> = expected
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["id"].as_str().unwrap().into(), d["name"].as_str().unwrap().into(), std_b64(d["bytes"].as_str().unwrap())))
        .collect();
    expected.sort();
    let mut got: Vec<(String, String, Vec<u8>)> = repo
        .list("")
        .unwrap()
        .into_iter()
        .map(|e| {
            let doc = repo.read(&e.id).unwrap().document;
            (e.id, doc.metadata.name, doc.bytes.to_vec())
        })
        .collect();
    got.sort();
    assert_eq!(got, expected);
}

#[test]
fn opens_typescript_vaults_by_passphrase_device_and_backup() {
    let data = fixture();
    let passphrase = data["passphrase"].as_str().unwrap();
    for (phase, expected) in [("phase1", "expected1"), ("phase2", "expected2")] {
        let stored = StoredVault::from_value(&data[phase]).unwrap();
        let mut repo = VaultRepository::new(MemoryVaultStorage::new(Some(stored.clone())));
        repo.unlock(passphrase).unwrap();
        assert_documents(&repo, &data[expected]);
        let mut device = VaultRepository::new(MemoryVaultStorage::new(Some(stored)));
        device.unlock_with_device(&Fixed(std_b64(data["deviceSecret"].as_str().unwrap()))).unwrap();
        assert_documents(&device, &data[expected]);
    }
    let backup = data["backup"].as_str().unwrap();
    parse_vault_backup(backup).unwrap();
    let mut restored = VaultRepository::new(MemoryVaultStorage::new(None));
    assert_eq!(restored.restore(backup, passphrase, false).unwrap(), None);
    assert_documents(&restored, &data["expected1"]);
    assert!(!restored.has_device_slot(), "a backup never carries the device slot");
}

#[test]
fn a_stale_device_secret_is_reported_as_stale() {
    let data = fixture();
    let stored = StoredVault::from_value(&data["phase1"]).unwrap();
    let mut repo = VaultRepository::new(MemoryVaultStorage::new(Some(stored)));
    let err = repo.unlock_with_device(&Fixed(vec![0; 32])).unwrap_err();
    assert!(matches!(err, VaultError::Device(DeviceFailure::Stale)));
    assert!(!repo.unlocked());
}

#[test]
fn file_storage_round_trip_with_revisions_and_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let data = fixture();
    let passphrase = data["passphrase"].as_str().unwrap();
    let storage = FileVaultStorage::new(dir.path().join("vault.json"));
    // Seed the file with the TypeScript snapshot, as a migration would.
    let stored = StoredVault::from_value(&data["phase2"]).unwrap();
    storage.commit(None, &StoredVault { revision: 1, ..stored }, false).unwrap();
    let mut repo = VaultRepository::new(storage);
    assert!(repo.inspect().unwrap());
    repo.unlock(passphrase).unwrap();
    let before = repo.list("").unwrap().len();
    let meta = VaultDocumentMetadata { name: "new.env".into(), media_type: "text/plain".into() };
    let id = repo.save(None, b"K=v\n", &meta).unwrap();
    assert_eq!(repo.list("").unwrap().len(), before + 1);
    assert_eq!(repo.list(".ENV").unwrap().iter().filter(|e| e.name.ends_with(".env")).count(), 2);
    repo.remove(&id).unwrap();
    assert_eq!(repo.list("").unwrap().len(), before);

    // A commit from a stale revision is refused and changes nothing.
    let current = repo.storage.load().unwrap().unwrap();
    let stale = StoredVault { revision: current.revision, ..current.clone() };
    assert!(matches!(repo.storage.commit(Some(current.revision - 1), &stale, false), Err(VaultError::Storage(StorageErrorCode::Conflict))));
    assert_eq!(repo.storage.load().unwrap().unwrap(), current);

    // The file is the same JSON structure storage.ts validates.
    let text = std::fs::read_to_string(dir.path().join("vault.json")).unwrap();
    assert!(text.starts_with("{\"version\":1,\"revision\":"));
    repo.lock();
    assert!(repo.list("").is_err());
}

/// Writes, reads and deletes one item in the real login Keychain under a
/// clearly named test service. Run by hand: `cargo test -p markie-vault -- --ignored`.
#[test]
#[ignore]
#[cfg(target_os = "macos")]
fn keychain_secret_store_round_trip_under_a_test_service() {
    use markie_vault::device::{KeychainSecretStore, SecretStore};
    let store = KeychainSecretStore::new("Markie RS Vault TEST (safe to delete)");
    let id = markie_vault::envelope::encode_base64(&[0x5a; 16]);
    store.delete(&id).unwrap();
    assert!(!store.has(&id));
    store.put(&id, &[3; 32]).unwrap();
    assert_eq!(store.get(&id).unwrap().as_slice(), &[3; 32]);
    store.delete(&id).unwrap();
    assert!(!store.has(&id));
}
