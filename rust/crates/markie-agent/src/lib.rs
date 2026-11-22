//! Local agent surface. The Node MCP speaks the wire protocol; only the
//! desktop owns the cloud session and decides when a write is allowed.
#[cfg(unix)]
pub mod bridge;
pub mod cloud;
pub mod comments;
pub mod permissions;
pub mod skills;
pub mod tokens;

use std::fs;
use std::path::{Path, PathBuf};

pub const COMMENTS_UNAVAILABLE: &str = "Comments on local documents are only in the Markie super-nightly build for now. This Markie build cannot show them, so nothing was saved.";
pub const MAX_SYNC_BYTES: u64 = 10 * 1024 * 1024;
pub const METHODS: &[&str] = &[
    "cloud_status",
    "cloud_sync",
    "cloud_public_link",
    "cloud_revoke_public_link",
    "history_note_write",
    "comments_list",
    "comments_add",
    "comments_reply",
    "comments_resolve",
    "open_in_markie",
];
pub type Reply = Result<serde_json::Value, String>;

/// Fence again at the app boundary. History may announce a new file before
/// Node creates it, but its existing ancestor must still be inside the home.
pub fn guarded_path(raw: &str, home: &Path, allow_missing: bool) -> Result<PathBuf, String> {
    let expanded = raw
        .strip_prefix("~/")
        .map_or_else(|| PathBuf::from(raw), |p| home.join(p));
    if !expanded.is_absolute() || raw.trim().is_empty() {
        return Err("Give the absolute path of a file.".into());
    }
    let root = home
        .canonicalize()
        .map_err(|_| "The home folder could not be resolved.")?;
    let allowed = |real: &Path| {
        real != root
            && real.starts_with(&root)
            && ![
                ".markie",
                "Library/Application Support/Markie",
                "Library/Keychains",
                ".config/Markie",
                ".local/share/Markie",
                "AppData/Roaming/Markie",
            ]
            .iter()
            .any(|p| real.starts_with(root.join(p)))
    };
    let mut ancestor = expanded.as_path();
    let mut missing = Vec::new();
    let mut real = loop {
        match ancestor.canonicalize() {
            Ok(p) => break p,
            Err(e)
                if allow_missing
                    && e.kind() == std::io::ErrorKind::NotFound
                    && fs::symlink_metadata(ancestor)
                        .is_err_and(|err| err.kind() == std::io::ErrorKind::NotFound) =>
            {
                let name = ancestor
                    .file_name()
                    .ok_or("Give the absolute path of a file.")?;
                missing.push(name);
                ancestor = ancestor
                    .parent()
                    .ok_or("Give the absolute path of a file.")?;
            }
            Err(_) => return Err(format!("No such file: {}", expanded.display())),
        }
    };
    if !missing.is_empty() && !real.is_dir() {
        return Err("The parent is not a directory.".into());
    }
    for name in missing.into_iter().rev() {
        real.push(name);
    }
    if !allowed(&real) {
        return Err("Only files in your home folder can be opened through Markie.".into());
    }
    if real.exists() && !real.is_file() {
        return Err(format!("Not a file: {}", real.display()));
    }
    Ok(real)
}

pub fn sanitize_agent(raw: &str) -> String {
    use std::sync::LazyLock;
    static NON_PRINTING: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[\p{C}\p{Zl}\p{Zp}]").expect("valid Unicode classes"));
    let cleaned = NON_PRINTING.replace_all(raw, " ");
    let line = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let clipped: String = line.chars().take(64).collect();
    if clipped.is_empty() {
        "an agent".into()
    } else {
        clipped.trim_end().into()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn path_fence_allows_a_future_file_but_not_a_symlink_escape_or_electron_data() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("file.md");
        fs::write(&target, "fixture").unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("escape")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("gone.md"),
            home.path().join("dangling.md"),
        )
        .unwrap();
        assert!(guarded_path("~/escape/file.md", home.path(), false).is_err());
        assert!(guarded_path("~/escape/future.md", home.path(), true).is_err());
        assert!(guarded_path("~/dangling.md", home.path(), true).is_err());
        assert!(
            guarded_path(
                "~/Library/Application Support/Markie/file.md",
                home.path(),
                true
            )
            .is_err()
        );
        assert!(guarded_path("~/draft.md", home.path(), true).is_ok());
    }
}
