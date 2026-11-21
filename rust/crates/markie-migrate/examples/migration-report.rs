//! Prints what a migration would carry over, by count and key name only.
//! It never prints a token, a setting's value or vault content.
//!
//!   cargo run -p markie-migrate --example migration-report -- --copy-from <userData> <empty scratch dir>
//!   cargo run -p markie-migrate --example migration-report -- <existing copy>
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = if args.first().map(String::as_str) == Some("--copy-from") {
        let copied = markie_migrate::copy_profile(args[1].as_ref(), args[2].as_ref()).expect("copy");
        println!("copied {} files, {} bytes; Electron running: {}", copied.files, copied.bytes, copied.electron_was_running);
        copied.root
    } else {
        args[0].clone().into()
    };
    match markie_migrate::read_copy(&root) {
        Ok(data) => {
            let r = &data.report;
            println!("localStorage origins: {:?}", r.local_storage_origins);
            println!("markie.* keys ({}): {:?}", r.markie_keys.len(), r.markie_keys.iter().map(|k| redact_path(k)).collect::<Vec<_>>());
            println!("other keys: {}", r.foreign_keys);
            println!("sessions: {} ({} confirmed)", data.settings.sessions.len(), data.settings.sessions.iter().filter(|s| s.user_id.is_some()).count());
            println!("themes: {}, color mode set: {}", data.settings.themes.is_some(), data.settings.color_mode.is_some());
            println!("rejected keys: {:?}", data.settings.rejected_keys);
            println!("IndexedDB databases: {:?}", r.indexeddb_databases);
            println!("vault records: {:?}, device slot: {}, from blob: {}", r.vault_records, r.vault_has_device_slot, r.vault_from_blob);
            println!("library documents: {:?}, recovery: {:?}", r.library_documents, r.library_recovery);
            println!("torn logs: {}", r.torn_logs);
        }
        Err(e) => println!("migration read failed: {e}"),
    }
}

/// Per-document keys carry a file path; only their prefix is printed.
fn redact_path(key: &str) -> String {
    match key.split_once(':') {
        Some((prefix, _)) => format!("{prefix}:<path>"),
        None => key.split_once('@').map_or(key.to_string(), |(p, _)| format!("{p}@<origin>")),
    }
}
