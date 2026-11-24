//! Putting a verified bundle where the running one is.
//!
//! The new bundle is first moved beside the installed one, so both are on one
//! volume, and then the two change places in a single `renamex_np(RENAME_SWAP)`
//! call: at every instant the installed path holds one whole bundle, the old
//! or the new, never half of either. The old bundle is kept as the roll back.

use std::ffi::{CString, OsStr};
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum SwapError {
    #[error("this copy is not running from an app bundle")]
    NotABundle,
    #[error("macOS is running this copy from a temporary place; move {} to Applications first", crate::BUNDLE_NAME)]
    Translocated,
    #[error("the folder holding {} cannot be changed by this account", crate::BUNDLE_NAME)]
    NotWritable,
    #[error("the update could not be put in place: {0}")]
    Io(#[from] std::io::Error),
}

/// The `.app` a running executable sits in: `…/X.app/Contents/MacOS/exe`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name() == Some(OsStr::new("MacOS"))
        && contents.file_name() == Some(OsStr::new("Contents"))
        && app.extension() == Some(OsStr::new("app")))
    .then(|| app.to_path_buf())
}

/// Whether `target` can be replaced where it is: a real bundle directory, not
/// one macOS is running from a randomized read-only copy, in a folder this
/// account may write to.
pub fn installable(target: &Path) -> Result<(), SwapError> {
    let meta = std::fs::symlink_metadata(target).map_err(|_| SwapError::NotABundle)?;
    if !meta.file_type().is_dir() || target.extension() != Some(OsStr::new("app")) {
        return Err(SwapError::NotABundle);
    }
    if target.components().any(|c| c.as_os_str() == OsStr::new("AppTranslocation")) {
        return Err(SwapError::Translocated);
    }
    let parent = target.parent().ok_or(SwapError::NotABundle)?;
    let path = CString::new(parent.as_os_str().as_bytes()).map_err(|_| SwapError::NotABundle)?;
    // SAFETY: a valid NUL-terminated path; access only reads permissions.
    if unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) } != 0 {
        return Err(SwapError::NotWritable);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    /// Where the bundle that was running now is, when it could be kept.
    pub previous: Option<PathBuf>,
}

fn c_path(path: &Path) -> std::io::Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::Error::other("path has a NUL byte"))
}

/// Swap two directories on one volume in one step.
#[cfg(target_os = "macos")]
fn exchange(a: &Path, b: &Path) -> std::io::Result<()> {
    let (a, b) = (c_path(a)?, c_path(b)?);
    // SAFETY: two valid NUL-terminated paths.
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn exchange(_a: &Path, _b: &Path) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

/// For a volume without an atomic swap: move the old one aside, move the new
/// one in, and put the old one back if that second move fails.
fn replace_in_two_moves(new: &Path, target: &Path, aside: &Path) -> std::io::Result<()> {
    std::fs::rename(target, aside)?;
    if let Err(error) = std::fs::rename(new, target) {
        std::fs::rename(aside, target)?;
        return Err(error);
    }
    std::fs::rename(aside, new)
}

/// Replace the bundle at `target` with the verified bundle at `staged`.
///
/// `recheck` runs on the new bundle after it has been copied to the target's
/// volume, when a plain move across volumes was not possible; a copy is a new
/// set of bytes and is verified again before it is trusted. `previous_dir` is
/// where the replaced bundle is kept (one generation).
pub fn install(
    staged: &Path,
    target: &Path,
    previous_dir: &Path,
    recheck: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<Installed, SwapError> {
    installable(target)?;
    let parent = target.parent().ok_or(SwapError::NotABundle)?;
    let name = target.file_name().ok_or(SwapError::NotABundle)?.to_string_lossy();
    let unique = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    // Hidden, beside the target: same volume, so the swap is one rename.
    let incoming = parent.join(format!(".{name}.update-{unique}"));
    match std::fs::rename(staged, &incoming) {
        Ok(()) => {}
        // Two volumes: a rename cannot cross them, so copy and check the copy.
        Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
            copy_bundle(staged, &incoming)?;
            if let Err(reason) = recheck(&incoming) {
                let _ = std::fs::remove_dir_all(&incoming);
                return Err(SwapError::Io(std::io::Error::other(reason)));
            }
        }
        Err(error) => return Err(SwapError::Io(error)),
    }
    let swapped = match exchange(&incoming, target) {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EINVAL)) || error.kind() == std::io::ErrorKind::Unsupported => {
            let aside = parent.join(format!(".{name}.previous-{unique}"));
            replace_in_two_moves(&incoming, target, &aside)
        }
        Err(error) => Err(error),
    };
    if let Err(error) = swapped {
        let _ = std::fs::remove_dir_all(&incoming);
        return Err(SwapError::Io(error));
    }
    // `incoming` now holds the bundle that was installed. Keep it for a roll
    // back; if it cannot be kept, it is removed rather than left in the way.
    let keep = previous_dir.join(&*name);
    let kept = std::fs::create_dir_all(previous_dir)
        .and_then(|()| match std::fs::remove_dir_all(&keep) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        })
        .and_then(|()| std::fs::rename(&incoming, &keep));
    let previous = match kept {
        Ok(()) => Some(keep),
        Err(_) => {
            let _ = std::fs::remove_dir_all(&incoming);
            None
        }
    };
    Ok(Installed { previous })
}

/// A faithful copy of a bundle (links, permissions, extended attributes), for
/// the case where the staged bundle and the installed one are on two volumes.
fn copy_bundle(from: &Path, to: &Path) -> std::io::Result<()> {
    let status = std::process::Command::new(crate::bundle::DITTO).arg(from).arg(to).env_clear().stdin(std::process::Stdio::null()).status()?;
    if status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_dir_all(to);
        Err(std::io::Error::other("copying the update next to the installed app failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(dir: &Path, name: &str, marker: &str) -> PathBuf {
        let app = dir.join(name);
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/markie-rs"), marker).unwrap();
        app
    }

    fn marker(app: &Path) -> String {
        std::fs::read_to_string(app.join("Contents/MacOS/markie-rs")).unwrap()
    }

    fn never(_: &Path) -> Result<(), String> {
        panic!("a move on one volume is not a copy and needs no second check")
    }

    #[test]
    fn finds_the_bundle_an_executable_runs_from() {
        assert_eq!(bundle_of(Path::new("/Applications/Markie Nightly.app/Contents/MacOS/markie-rs")), Some(PathBuf::from("/Applications/Markie Nightly.app")));
        for loose in ["/repo/rust/target/debug/markie-rs", "/Applications/Markie Nightly.app/Contents/Resources/markie-rs", "/x/MacOS/markie-rs", "/Markie Nightly/Contents/MacOS/markie-rs", "markie-rs"] {
            assert_eq!(bundle_of(Path::new(loose)), None, "{loose}");
        }
    }

    #[test]
    fn the_new_bundle_takes_the_place_and_the_old_one_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        let staging = dir.path().join("staging");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        let target = bundle(&apps, crate::BUNDLE_NAME, "old");
        let staged = bundle(&staging, crate::BUNDLE_NAME, "new");
        let previous_dir = dir.path().join("updates/previous");

        let installed = install(&staged, &target, &previous_dir, &never).unwrap();
        assert_eq!(marker(&target), "new");
        let kept = installed.previous.unwrap();
        assert_eq!(kept, previous_dir.join(crate::BUNDLE_NAME));
        assert_eq!(marker(&kept), "old");
        assert!(!staged.exists());
        // Nothing but the bundle is left beside it.
        let beside: Vec<_> = std::fs::read_dir(&apps).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(beside, [OsStr::new(crate::BUNDLE_NAME)]);

        // A second update replaces the kept generation.
        let staged = bundle(&staging, crate::BUNDLE_NAME, "newer");
        install(&staged, &target, &previous_dir, &never).unwrap();
        assert_eq!(marker(&target), "newer");
        assert_eq!(marker(&previous_dir.join(crate::BUNDLE_NAME)), "new");
    }

    #[test]
    fn a_failed_install_leaves_the_running_bundle_exactly_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        std::fs::create_dir_all(&apps).unwrap();
        let target = bundle(&apps, crate::BUNDLE_NAME, "old");
        // The staged bundle is not there (deleted between verify and install).
        let missing = dir.path().join("staging").join(crate::BUNDLE_NAME);
        assert!(install(&missing, &target, &dir.path().join("previous"), &never).is_err());
        assert_eq!(marker(&target), "old");
        let beside: Vec<_> = std::fs::read_dir(&apps).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(beside, [OsStr::new(crate::BUNDLE_NAME)], "no leftovers beside the app");
    }

    #[test]
    fn the_two_move_fallback_restores_the_old_bundle_when_the_new_one_cannot_move_in() {
        let dir = tempfile::tempdir().unwrap();
        let target = bundle(dir.path(), crate::BUNDLE_NAME, "old");
        let aside = dir.path().join(".aside");
        let missing = dir.path().join("missing.app");
        assert!(replace_in_two_moves(&missing, &target, &aside).is_err());
        assert_eq!(marker(&target), "old");
        assert!(!aside.exists());
        // And when it can, the old one ends up where the new one was.
        let new = bundle(dir.path(), ".incoming.app", "new");
        replace_in_two_moves(&new, &target, &aside).unwrap();
        assert_eq!(marker(&target), "new");
        assert_eq!(marker(&new), "old");
        assert!(!aside.exists());
    }

    #[test]
    fn refuses_places_it_cannot_or_must_not_replace() {
        let dir = tempfile::tempdir().unwrap();
        // Not a bundle: a plain folder, a missing path, a file, a link to a bundle.
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(matches!(installable(&plain), Err(SwapError::NotABundle)));
        assert!(matches!(installable(&dir.path().join("missing.app")), Err(SwapError::NotABundle)));
        std::fs::write(dir.path().join("file.app"), "x").unwrap();
        assert!(matches!(installable(&dir.path().join("file.app")), Err(SwapError::NotABundle)));
        let real = bundle(dir.path(), "real.app", "x");
        std::os::unix::fs::symlink(&real, dir.path().join("link.app")).unwrap();
        assert!(matches!(installable(&dir.path().join("link.app")), Err(SwapError::NotABundle)));
        assert!(installable(&real).is_ok());

        // Gatekeeper path randomization: macOS runs a quarantined app from here.
        let translocated = dir.path().join("AppTranslocation/ABCD-1234/d");
        std::fs::create_dir_all(&translocated).unwrap();
        let app = bundle(&translocated, crate::BUNDLE_NAME, "x");
        assert!(matches!(installable(&app), Err(SwapError::Translocated)));

        // A folder this account cannot write to.
        let locked = dir.path().join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        let app = bundle(&locked, crate::BUNDLE_NAME, "old");
        std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o555)).unwrap();
        let staged = bundle(dir.path(), crate::BUNDLE_NAME, "new");
        let result = install(&staged, &app, &dir.path().join("previous"), &never);
        std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(matches!(result, Err(SwapError::NotWritable)), "{result:?}");
        assert_eq!(marker(&app), "old");
        assert_eq!(marker(&staged), "new", "a refused install does not consume the staged bundle");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_swap_is_one_step_both_bundles_exist_whole_afterwards() {
        let dir = tempfile::tempdir().unwrap();
        let a = bundle(dir.path(), "a.app", "A");
        let b = bundle(dir.path(), "b.app", "B");
        exchange(&a, &b).unwrap();
        assert_eq!((marker(&a).as_str(), marker(&b).as_str()), ("B", "A"));
        assert!(exchange(&a, &dir.path().join("missing.app")).is_err());
        assert_eq!(marker(&a), "B");
    }
}
