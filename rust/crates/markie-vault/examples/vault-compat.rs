//! The Rust half of `compat/vault-compat.ts`. Reads one JSON request on stdin,
//! writes one JSON answer on stdout. Test data only: never run it on a real vault.
use markie_vault::backup::{parse_vault_backup, serialize_vault_backup};
use markie_vault::device::{FakeBiometric, MemorySecretStore, SecretStore, TouchIdKeeper};
use markie_vault::dotenv::{self, LineKind, Newline, Quote};
use markie_vault::envelope::{encode_base64, decode_base64_checked, VaultDeviceSlot, VaultDocumentEnvelope, VaultDocumentMetadata, VaultHeader};
use markie_vault::passphrase::estimate_passphrase_bits;
use markie_vault::{MemoryVaultStorage, StoredVault, VaultError, VaultRepository, VaultStorage};
use serde_json::{json, Value};
use std::io::Read;

fn b64(s: &str) -> Vec<u8> {
    decode_base64_checked(s.replace('+', "-").replace('/', "_").trim_end_matches('='), 0, 1 << 40).unwrap_or_default()
}

fn std_b64(bytes: &[u8]) -> String {
    // Node's Buffer base64 is standard with padding.
    let url = encode_base64(bytes).replace('-', "+").replace('_', "/");
    let pad = (4 - url.len() % 4) % 4;
    format!("{url}{}", "=".repeat(pad))
}

fn err_name(e: &VaultError) -> String {
    match e {
        VaultError::Vault(c) => format!("vault:{c:?}"),
        VaultError::Storage(c) => format!("storage:{c:?}"),
        VaultError::Device(c) => format!("device:{c:?}"),
        VaultError::Backup => "backup".into(),
        VaultError::BackupTooNew => "backup:too-new".into(),
        VaultError::PrivateFilesLocked => "private:locked".into(),
        VaultError::Save { .. } => "save".into(),
    }
}

fn documents<S: VaultStorage>(repo: &VaultRepository<S>) -> Value {
    let entries = repo.list("").unwrap();
    Value::Array(
        entries
            .iter()
            .map(|e| {
                let doc = repo.read(&e.id).unwrap().document;
                json!({ "id": e.id, "name": doc.metadata.name, "mediaType": doc.metadata.media_type, "bytes": std_b64(&doc.bytes) })
            })
            .collect(),
    )
}


/// A keeper that releases one fixed secret for whichever vault asks.
struct FixedKeeper(Vec<u8>);
impl markie_vault::device::DeviceKeeper for FixedKeeper {
    fn release(&self, _: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, markie_vault::DeviceFailure> {
        Ok(zeroize::Zeroizing::new(self.0.as_slice().try_into().map_err(|_| markie_vault::DeviceFailure::Missing)?))
    }
    fn store(&self, _: &str, _: &[u8]) -> Result<(), markie_vault::DeviceFailure> {
        Ok(())
    }
    fn remove(&self, _: &str) -> Result<(), markie_vault::DeviceFailure> {
        Ok(())
    }
}

fn open(req: &Value) -> Value {
    let stored = match StoredVault::from_value(&req["stored"]) {
        Ok(s) => s,
        Err(e) => return json!({ "error": err_name(&e) }),
    };
    let passphrase = req["passphrase"].as_str().unwrap();
    let mut repo = VaultRepository::new(MemoryVaultStorage::new(Some(stored.clone())));
    if let Err(e) = repo.unlock(passphrase) {
        return json!({ "error": err_name(&e) });
    }
    let by_passphrase = documents(&repo);
    let by_device = req["deviceSecret"].as_str().map(|s| {
        let mut repo = VaultRepository::new(MemoryVaultStorage::new(Some(stored.clone())));
        match repo.unlock_with_device(&FixedKeeper(b64(s))) {
            Ok(()) => documents(&repo),
            Err(e) => json!({ "error": err_name(&e) }),
        }
    });
    let restored = req["backup"].as_str().map(|backup| {
        let mut repo = VaultRepository::new(MemoryVaultStorage::new(None));
        match repo.restore(backup, passphrase, false) {
            Ok(_) => documents(&repo),
            Err(e) => json!({ "error": err_name(&e) }),
        }
    });
    json!({ "passphrase": by_passphrase, "device": by_device, "backup": restored })
}

fn make(req: &Value) -> Value {
    let passphrase = req["passphrase"].as_str().unwrap();
    let mut repo = VaultRepository::new(MemoryVaultStorage::new(None));
    repo.create(passphrase).unwrap();
    for doc in req["docs"].as_array().unwrap() {
        let metadata = VaultDocumentMetadata {
            name: doc["name"].as_str().unwrap().into(),
            media_type: doc["mediaType"].as_str().unwrap().into(),
        };
        repo.save(None, &b64(doc["bytes"].as_str().unwrap()), &metadata).unwrap();
    }
    let keeper = TouchIdKeeper::new(FakeBiometric::default(), MemorySecretStore::default());
    repo.enroll_device(passphrase, &keeper).unwrap();
    let vault_id = repo.vault_id().unwrap();
    let secret = keeper.secrets.get(&vault_id).unwrap();
    let stored = repo.storage.load().unwrap().unwrap();
    json!({
        "stored": serde_json::from_str::<Value>(&stored.to_json()).unwrap(),
        "storedJson": stored.to_json(),
        "deviceSecret": std_b64(&secret),
        "backup": serialize_vault_backup(&stored.without_device_slot()).unwrap(),
    })
}

fn quote_name(q: Quote) -> &'static str {
    match q {
        Quote::None => "",
        Quote::Double => "\"",
        Quote::Single => "'",
        Quote::Backtick => "`",
    }
}

fn eol_name(e: Option<Newline>) -> &'static str {
    e.map_or("", Newline::as_str)
}

fn dotenv_doc(text: &str) -> Value {
    let doc = dotenv::parse_dotenv(text);
    let lines: Vec<Value> = doc
        .lines
        .iter()
        .map(|l| match &l.kind {
            LineKind::Blank => json!({ "kind": "blank", "raw": l.raw, "eol": eol_name(l.eol) }),
            LineKind::Comment { text } => json!({ "kind": "comment", "raw": l.raw, "eol": eol_name(l.eol), "text": text }),
            LineKind::Malformed { reason } => json!({ "kind": "malformed", "raw": l.raw, "eol": eol_name(l.eol), "reason": reason }),
            LineKind::Entry(e) => json!({
                "kind": "entry", "raw": l.raw, "eol": eol_name(l.eol), "key": e.key, "value": e.value, "exported": e.exported,
                "quote": quote_name(e.quote), "lead": e.lead, "separator": e.separator, "valueSource": e.value_source, "trail": e.trail,
            }),
        })
        .collect();
    // One edit per entry line, a new entry, and a removal, to compare edit output too.
    let mut edited = doc.clone();
    for line in &doc.lines {
        if let LineKind::Entry(e) = &line.kind {
            edited = dotenv::update_dotenv_entry(&edited, line.id, None, Some(&format!("{} edited #x", e.value)));
        }
    }
    edited = dotenv::add_dotenv_entry(&edited, "NEW_KEY", "a b");
    if let Some(first) = doc.lines.first() {
        edited = dotenv::remove_dotenv_line(&edited, first.id);
    }
    json!({
        "lines": lines,
        "newline": doc.newline.as_str(),
        "serialized": dotenv::serialize_dotenv(&doc),
        "edited": dotenv::serialize_dotenv(&edited),
        "duplicates": dotenv::duplicate_dotenv_keys(&doc).into_iter().collect::<Vec<_>>(),
    })
}

fn parse_check(kind: &str, text: &str) -> Value {
    let result = match kind {
        "header" => VaultHeader::parse(text).map(|_| ()),
        "document" => VaultDocumentEnvelope::parse(text).map(|_| ()),
        "slot" => VaultDeviceSlot::parse(text).map(|_| ()),
        "backup" => parse_vault_backup(text).map(|_| ()),
        "stored" => match serde_json::from_str::<Value>(text) {
            Ok(v) => StoredVault::from_value(&v).map(|_| ()),
            Err(_) => Err(VaultError::Storage(markie_vault::StorageErrorCode::Corrupt)),
        },
        _ => unreachable!(),
    };
    match result {
        Ok(()) => json!("ok"),
        Err(e) => json!(err_name(&e)),
    }
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let req: Value = serde_json::from_str(&input).unwrap();
    let out = match req["command"].as_str().unwrap() {
        "open" => open(&req),
        "make" => make(&req),
        "dotenv" => Value::Array(req["texts"].as_array().unwrap().iter().map(|t| dotenv_doc(t.as_str().unwrap())).collect()),
        "strength" => Value::Array(
            req["passphrases"].as_array().unwrap().iter().map(|p| json!(estimate_passphrase_bits(p.as_str().unwrap()))).collect(),
        ),
        "metadata" => Value::Array(
            req["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| {
                    let meta = VaultDocumentMetadata { name: m["name"].as_str().unwrap().into(), media_type: m["mediaType"].as_str().unwrap().into() };
                    match meta.to_bytes() {
                        Ok(bytes) => json!(std_b64(&bytes)),
                        Err(e) => json!(err_name(&e)),
                    }
                })
                .collect(),
        ),
        "parse" => Value::Array(
            req["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| parse_check(i["kind"].as_str().unwrap(), i["text"].as_str().unwrap()))
                .collect(),
        ),
        other => panic!("unknown command {other}"),
    };
    println!("{out}");
}
