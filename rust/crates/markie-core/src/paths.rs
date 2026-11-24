//! Which app this build is, and where it keeps its own data.
//!
//! Two builds come out of this source, chosen by the `nightly` cargo feature
//! and nothing else:
//!
//! - **Markie RS**, the default: the dev side build. Its own name, bundle id
//!   and `markie-rs://` scheme, so it never answers for Markie.
//! - **Markie**, with `nightly`: the Mac app itself, on the private
//!   super-nightly channel. It carries Markie's identity (`com.zvn.markie`,
//!   `markie://`, Markie's document types), because the installed Electron
//!   super-nightly updates itself into it and macOS must see one app
//!   (docs/rust-port/NIGHTLY.md).
//!
//! Whatever the identity, the data never mixes with Electron Markie's.
//! `PROFILE_NAME` names the data folder, the Keychain services and the cloud
//! folder, and it is never one of Electron's folders (`markie`, which the
//! Mac's disk also reads as `Markie`, and `Markie Super-nightly`). The
//! Electron profile is only ever read, from a copy, by the first-run import.
//!
//! The public Mac release, when it comes, is a third identity block here: the
//! same name and bundle id, its own `PROFILE_NAME`, `CHANNEL` and
//! `ELECTRON_PROFILE` (`markie`). Windows stays on Electron and reads none of
//! this.

use std::path::PathBuf;

/// The Mac app on the super-nightly channel, as opposed to the dev build.
pub const NIGHTLY: bool = cfg!(feature = "nightly");

#[cfg(not(feature = "nightly"))]
mod identity {
    pub const APP_NAME: &str = "Markie RS";
    pub const BUNDLE_ID: &str = "com.zvn.markie.rs";
    pub const URL_SCHEME: &str = "markie-rs";
    pub const URL_SCHEME_PREFIX: &str = "markie-rs://";
    pub const PROFILE_NAME: &str = "Markie RS";
    pub const CHANNEL: &str = "dev";
    pub const ELECTRON_PROFILE: Option<&str> = None;
}
#[cfg(feature = "nightly")]
mod identity {
    pub const APP_NAME: &str = "Markie";
    pub const BUNDLE_ID: &str = "com.zvn.markie";
    pub const URL_SCHEME: &str = "markie";
    pub const URL_SCHEME_PREFIX: &str = "markie://";
    pub const PROFILE_NAME: &str = "Markie Nightly";
    pub const CHANNEL: &str = "super-nightly";
    pub const ELECTRON_PROFILE: Option<&str> = Some("Markie Super-nightly");
}
/// What the user sees: the menu bar, the window, About.
pub use identity::APP_NAME;
/// What macOS sees: the bundle id and the one URL scheme the bundle claims.
pub use identity::{BUNDLE_ID, URL_SCHEME, URL_SCHEME_PREFIX};
/// This build's own places: the data folder under Application Support, the
/// Keychain service of its sign-in (and, with " Vault", of its vault), and its
/// folder under Documents for cloud files. Never one of Electron's.
pub use identity::PROFILE_NAME;
/// The update channel, and the Electron userData folder of the same channel,
/// which the first-run import reads from a copy. None: nothing is imported
/// without being asked.
pub use identity::{CHANNEL, ELECTRON_PROFILE};

/// Electron Markie's userData folders. `PROFILE_NAME` is never one of these,
/// compared the way the Mac's disk compares names.
pub const ELECTRON_PROFILES: &[&str] = &["markie", "Markie Super-nightly"];

/// The version this build reports. The nightly carries `X.Y.Z-super-nightly.N`,
/// given to the compiler as `MARKIE_NIGHTLY_VERSION` by
/// `scripts/nightly-release.sh`; a nightly built without it is `.0`, which
/// every published nightly is newer than.
pub const APP_VERSION: &str = if NIGHTLY {
    match option_env!("MARKIE_NIGHTLY_VERSION") {
        Some(version) => version,
        None => concat!(env!("CARGO_PKG_VERSION"), "-super-nightly.0"),
    }
} else {
    env!("CARGO_PKG_VERSION")
};

/// The commit a nightly was built from (`MARKIE_NIGHTLY_COMMIT`), or "".
pub const BUILD_COMMIT: &str = match option_env!("MARKIE_NIGHTLY_COMMIT") {
    Some(commit) => commit,
    None => "",
};

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MARKIE_RS_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(PROFILE_NAME)
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Electron's `workspace.defaultRootPath()`: `~/Documents/Markie`, where
/// `Projects.md` lives. `MARKIE_RS_DOCUMENTS_DIR` points it at a scratch
/// folder for testing.
pub fn default_root() -> PathBuf {
    if let Ok(dir) = std::env::var("MARKIE_RS_DOCUMENTS_DIR") {
        return PathBuf::from(dir).join("Markie");
    }
    dirs::document_dir().unwrap_or_else(|| home_dir().join("Documents")).join("Markie")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_build_is_one_app_and_its_data_is_never_electrons() {
        assert_eq!(URL_SCHEME_PREFIX, format!("{URL_SCHEME}://"));
        // The Mac's disk ignores letter case, so "Markie" is Electron's "markie".
        for electron in ELECTRON_PROFILES {
            assert!(!PROFILE_NAME.eq_ignore_ascii_case(electron), "{PROFILE_NAME} is Electron's {electron}");
        }
        assert!(!PROFILE_NAME.eq_ignore_ascii_case("Markie"));
        if let Some(source) = ELECTRON_PROFILE {
            assert!(ELECTRON_PROFILES.contains(&source), "the import reads a real Electron profile name");
        }
        if NIGHTLY {
            // The Mac app itself: Markie's identity, so Electron's updater installs it over Electron.
            assert_eq!((APP_NAME, BUNDLE_ID, URL_SCHEME), ("Markie", "com.zvn.markie", "markie"));
            assert_eq!((PROFILE_NAME, CHANNEL, ELECTRON_PROFILE), ("Markie Nightly", "super-nightly", Some("Markie Super-nightly")));
            assert!(APP_VERSION.contains("-super-nightly."), "{APP_VERSION}");
        } else {
            // The dev build never answers for Markie.
            assert_eq!((APP_NAME, BUNDLE_ID, URL_SCHEME), ("Markie RS", "com.zvn.markie.rs", "markie-rs"));
            assert_eq!((PROFILE_NAME, CHANNEL, ELECTRON_PROFILE), ("Markie RS", "dev", None));
            assert_eq!(APP_VERSION, env!("CARGO_PKG_VERSION"));
        }
    }

    #[test]
    fn the_data_folder_is_named_for_the_profile() {
        if std::env::var_os("MARKIE_RS_DATA_DIR").is_none() {
            assert_eq!(data_dir().file_name().and_then(|n| n.to_str()), Some(PROFILE_NAME));
        }
    }
}
