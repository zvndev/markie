//! Where Markie RS keeps its own data. Deliberately a different folder from the
//! shipping Electron app ("Markie"), so this build can never read or corrupt
//! the real registry, settings, drafts or sign-in.

use std::path::PathBuf;

/// Two builds come out of this source: the dev side build "Markie RS", and
/// with the `nightly` feature the private self-updating "Markie Nightly"
/// (docs/rust-port/NIGHTLY.md). Each has its own name, bundle id, data
/// folder, URL scheme and Keychain service, so the two run side by side and
/// neither ever answers for Electron Markie (`com.zvn.markie`, `markie://`).
pub const NIGHTLY: bool = cfg!(feature = "nightly");

#[cfg(not(feature = "nightly"))]
mod identity {
    pub const APP_NAME: &str = "Markie RS";
    pub const BUNDLE_ID: &str = "com.zvn.markie.rs";
    pub const URL_SCHEME: &str = "markie-rs";
    pub const URL_SCHEME_PREFIX: &str = "markie-rs://";
}
#[cfg(feature = "nightly")]
mod identity {
    pub const APP_NAME: &str = "Markie Nightly";
    pub const BUNDLE_ID: &str = "com.zvn.markie.nightly";
    pub const URL_SCHEME: &str = "markie-nightly";
    pub const URL_SCHEME_PREFIX: &str = "markie-nightly://";
}
pub use identity::{APP_NAME, BUNDLE_ID, URL_SCHEME, URL_SCHEME_PREFIX};

/// The version this build reports. A nightly carries `X.Y.Z-rs-nightly.N`,
/// given to the compiler as `MARKIE_NIGHTLY_VERSION` by
/// `scripts/nightly-release.sh`; a nightly built without it is `.0`, which
/// every published nightly is newer than.
pub const APP_VERSION: &str = if NIGHTLY {
    match option_env!("MARKIE_NIGHTLY_VERSION") {
        Some(version) => version,
        None => concat!(env!("CARGO_PKG_VERSION"), "-rs-nightly.0"),
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
        .join(APP_NAME)
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
    fn the_build_never_takes_electron_markies_identity() {
        assert_ne!(BUNDLE_ID, "com.zvn.markie");
        assert_ne!(URL_SCHEME, "markie");
        assert_ne!(APP_NAME, "Markie");
        assert_eq!(URL_SCHEME_PREFIX, format!("{URL_SCHEME}://"));
        if NIGHTLY {
            assert_eq!((APP_NAME, BUNDLE_ID, URL_SCHEME), ("Markie Nightly", "com.zvn.markie.nightly", "markie-nightly"));
            assert!(APP_VERSION.contains("-rs-nightly."), "{APP_VERSION}");
        } else {
            assert_eq!((APP_NAME, BUNDLE_ID, URL_SCHEME), ("Markie RS", "com.zvn.markie.rs", "markie-rs"));
            assert_eq!(APP_VERSION, env!("CARGO_PKG_VERSION"));
        }
    }
}
