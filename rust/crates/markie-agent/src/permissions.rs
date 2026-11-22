use serde_json::{Value, json};
use std::{fs, io, path::Path};

const FILE: &str = "agent-permissions.json";

pub fn sync_always(data: &Path) -> bool {
    fs::read(data.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|v| v["cloudSync"] == "always")
}

pub fn set_sync_always(data: &Path, allowed: bool) -> io::Result<()> {
    fs::create_dir_all(data)?;
    let mut file = tempfile::NamedTempFile::new_in(data)?;
    serde_json::to_writer(
        &mut file,
        &if allowed {
            json!({"cloudSync": "always"})
        } else {
            json!({})
        },
    )?;
    file.persist(data.join(FILE))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opt_in_and_revocation_persist_and_corruption_defaults_to_ask() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!sync_always(dir.path()));
        set_sync_always(dir.path(), true).unwrap();
        assert!(sync_always(dir.path()));
        set_sync_always(dir.path(), false).unwrap();
        assert!(!sync_always(dir.path()));
        fs::write(dir.path().join(FILE), "{").unwrap();
        assert!(!sync_always(dir.path()));
    }
}
