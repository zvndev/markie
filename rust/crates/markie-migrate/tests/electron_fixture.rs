//! Reads a real Chromium profile written by Electron 42 (the version Markie
//! ships) with made-up data from the repo's TypeScript. See fixtures/generate.
use markie_migrate::markie::{read_copy, ColorMode};
use markie_vault::StoredVault;
use serde_json::Value;
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn data() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("fixture-data.json")).unwrap()).unwrap()
}

fn std_b64(s: &str) -> Vec<u8> {
    let url = s.replace('+', "-").replace('/', "_");
    let url = url.trim_end_matches('=');
    if url.is_empty() { Vec::new() } else { markie_vault::envelope::decode_base64_checked(url, 0, 1 << 30).unwrap() }
}

#[test]
fn reads_settings_sessions_vault_and_library() {
    let data = data();
    let out = read_copy(&fixtures().join("electron-userdata")).unwrap();

    // localStorage: phase 1 values with phase 2's edits on top.
    let mut expected: std::collections::BTreeMap<String, String> =
        serde_json::from_value(data["localStorage1"].clone()).unwrap();
    for (k, v) in data["localStorage2"]["set"].as_object().unwrap() {
        expected.insert(k.clone(), v.as_str().unwrap().into());
    }
    for k in data["localStorage2"]["remove"].as_array().unwrap() {
        expected.remove(k.as_str().unwrap());
    }
    let markie_keys: Vec<String> = expected.keys().filter(|k| k.starts_with("markie.")).cloned().collect();
    assert_eq!(out.report.markie_keys, markie_keys);
    assert_eq!(out.report.foreign_keys, 1);
    assert_eq!(out.report.local_storage_origins, vec!["app://markie".to_string()]);

    let s = &out.settings;
    assert_eq!(s.primary_server, None, "Markie Cloud is the default, not an override");
    assert_eq!(s.color_mode, Some(ColorMode::Dark));
    assert_eq!(s.themes.as_ref().unwrap(), &serde_json::from_str::<Value>(expected["markie.themes.v1"].as_str()).unwrap());
    assert_eq!(s.sessions.len(), 2);
    let primary = s.sessions.iter().find(|x| x.primary).unwrap();
    assert_eq!(primary.origin, "https://api.markiedocs.com");
    assert_eq!(primary.token, "fixture-token-primary-rotated");
    // The binding was for the old token, so the rotated token is unconfirmed.
    assert_eq!(primary.user_id, None);
    let other = s.sessions.iter().find(|x| !x.primary).unwrap();
    assert_eq!((other.origin.as_str(), other.token.as_str(), other.user_id.as_deref()), ("https://docs.example.test", "fixture-token-selfhosted", Some("fixture-user-2")));
    let mut paths = s.rich_override_paths.clone();
    paths.sort();
    assert_eq!(paths, vec!["/Users/fixture/Notes/Ünïcödé.md".to_string(), "/Users/fixture/🔐 秘密.md".to_string()]);
    assert!(!s.other.contains_key("markie.seen.v1"), "a removed key stays removed");
    assert_eq!(s.other["markie.leftpanel.width.v1"], "288");
    assert!(format!("{s:?}").contains("<redacted>") && !format!("{s:?}").contains("fixture-token"));

    // IndexedDB: the vault is phase 2's snapshot, read out of its blob file.
    assert_eq!(out.vault.as_ref().unwrap(), &StoredVault::from_value(&data["phase2"]).unwrap());
    assert!(out.report.vault_from_blob);
    assert!(out.report.vault_has_device_slot);
    assert_eq!(out.report.indexeddb_databases, vec!["markie-encrypted-vault".to_string(), "markie-document-library".to_string()]);

    let library = out.library.unwrap();
    let rows = &data["libraryRows"];
    assert_eq!(library.documents.len(), rows["documents"].as_array().unwrap().len());
    for row in rows["documents"].as_array().unwrap() {
        let doc = library.documents.iter().find(|d| d.id == row["id"].as_str().unwrap()).unwrap();
        assert_eq!(doc.bytes, std_b64(row["bytes"].as_str().unwrap()));
        assert_eq!(doc.name, row["name"].as_str().unwrap());
        assert_eq!(doc.format, row["format"].as_str().unwrap());
        assert_eq!(doc.revision, row["revision"].as_i64().unwrap());
        assert_eq!(doc.exported_revision, row["exportedRevision"].as_i64());
        assert_eq!(doc.collection.as_deref(), row["collection"].as_str());
        assert_eq!(doc.extracted_text.as_deref(), row["extractedText"].as_str());
        assert_eq!(doc.tags, row["tags"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect::<Vec<_>>());
    }
    assert_eq!(library.recovery.len(), rows["recovery"].as_array().unwrap().len());
    for r in &library.recovery {
        assert_eq!(r.document_id, r.record.id);
    }
}

#[test]
fn the_migrated_vault_opens_with_the_fixture_passphrase() {
    let data = data();
    let out = read_copy(&fixtures().join("electron-userdata")).unwrap();
    let mut repo = markie_vault::VaultRepository::new(markie_vault::MemoryVaultStorage::new(out.vault));
    repo.unlock(data["passphrase"].as_str().unwrap()).unwrap();
    let mut names: Vec<String> = repo.list("").unwrap().into_iter().map(|e| e.name).collect();
    names.sort();
    let mut expected: Vec<String> = data["expected2"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap().into()).collect();
    expected.sort();
    assert_eq!(names, expected);
}

#[test]
fn copy_then_read_and_the_copy_matches() {
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("copy");
    let copied = markie_migrate::copy_profile(&fixtures().join("electron-userdata"), &target).unwrap();
    assert!(copied.files >= 8);
    assert!(!copied.electron_was_running);
    let a = read_copy(&target).unwrap();
    let b = read_copy(&fixtures().join("electron-userdata")).unwrap();
    assert_eq!(a.report, b.report);
    // The scratch folder must be empty, and never inside the source.
    assert!(markie_migrate::copy_profile(&fixtures().join("electron-userdata"), &target).is_err());
    assert!(markie_migrate::copy_profile(&fixtures().join("electron-userdata"), &fixtures().join("electron-userdata/inside")).is_err());
}

#[test]
fn a_damaged_table_fails_loudly() {
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("copy");
    markie_migrate::copy_profile(&fixtures().join("electron-userdata"), &target).unwrap();
    let dir = target.join("IndexedDB/app_markie_0.indexeddb.leveldb");
    for table in std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "ldb")) {
        let mut bytes = std::fs::read(&table).unwrap();
        bytes[100] ^= 0xff;
        std::fs::write(&table, bytes).unwrap();
    }
    let err = read_copy(&target).unwrap_err().to_string();
    assert!(err.contains("checksum"), "{err}");
}

#[test]
fn a_missing_blob_file_fails_loudly() {
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("copy");
    markie_migrate::copy_profile(&fixtures().join("electron-userdata"), &target).unwrap();
    std::fs::remove_dir_all(target.join("IndexedDB/app_markie_0.indexeddb.blob")).unwrap();
    assert!(read_copy(&target).is_err());
}
