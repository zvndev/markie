//! Where Markie RS keeps its own data. Deliberately a different folder from the
//! shipping Electron app ("Markie"), so this build can never read or corrupt
//! the real registry, settings, drafts or sign-in.

use std::path::PathBuf;

pub const APP_NAME: &str = "Markie RS";
pub const BUNDLE_ID: &str = "com.zvn.markie.rs";

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
