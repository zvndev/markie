//! One way to write a file the user owns: a temp file beside the original,
//! fsynced, then renamed over it, keeping permission bits and (on macOS)
//! extended attributes such as Finder tags. A port of `electron/atomic-write.js`.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

fn temp_path_for(target: &Path) -> PathBuf {
    let name = target.file_name().map_or_else(|| "document".into(), |n| n.to_string_lossy().into_owned());
    let nonce = format!(
        "{:x}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    );
    target.with_file_name(format!("{name}.markie-{nonce}.tmp"))
}

/// Write `bytes` to `path` so a reader only ever sees the old file or the new one.
/// Symlinks are followed, so saving through one updates the file it points at.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let existing = fs::metadata(&target).ok();
    let temp = temp_path_for(&target);
    let result = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(meta) = &existing {
            fs::set_permissions(&temp, meta.permissions())?;
            #[cfg(unix)]
            copy_xattrs(&target, &temp);
        }
        fs::rename(&temp, &target)?;
        if let Some(dir) = target.parent() {
            // Persist the rename itself. Best effort: not every platform allows
            // opening a directory.
            if let Ok(d) = File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn copy_xattrs(from: &Path, to: &Path) {
    const MAX_XATTRS: usize = 32;
    let Ok(names) = xattr::list(from) else { return };
    for name in names.take(MAX_XATTRS) {
        if let Ok(Some(value)) = xattr::get(from, &name) {
            let _ = xattr::set(to, &name, &value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_contents_and_keeps_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1, "no temp file left behind");
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, "a").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        atomic_write(&link, b"b").unwrap();
        assert_eq!(fs::read_to_string(&real).unwrap(), "b");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }
}
