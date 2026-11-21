//! Markie RS one-time migration out of the Electron app's Chromium storage.
//!
//! 1. `profile::copy_profile` copies the two stores out of the Electron
//!    userData folder into a scratch folder. That plain read is the only
//!    access to the live profile.
//! 2. `markie::read_copy` decodes the copy: localStorage (LevelDB), and the
//!    `markie-encrypted-vault` and `markie-document-library` IndexedDB
//!    databases (LevelDB, Blink and V8 structured clone, blob files).
//!
//! Nothing here writes to the Keychain, the Markie RS data folder or the
//! network; wiring the records into the app is the caller's job.
pub mod error;
pub mod idb;
pub mod leveldb;
pub mod local_storage;
pub mod markie;
pub mod profile;
pub mod v8;

pub use error::{MigrateError, Result};
pub use markie::{read_copy, ElectronData, Report};
pub use profile::{copy_profile, electron_user_data};
