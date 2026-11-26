//! Google Docs import for Markie RS, step one of Google Docs sync
//! (docs/rust-port/GOOGLE-DOCS.md).
//!
//! - `config`: the Desktop OAuth client, compiled in from
//!   `MARKIE_GOOGLE_DESKTOP_CLIENT_ID` (and `_SECRET`). Without it the feature is hidden.
//! - `oauth`: PKCE, the loopback redirect and Google's desktop Picker flow
//!   (`trigger_onepick=true`), which hands back `picked_file_ids`. The grant is
//!   `drive.file` only and is never mixed with Markie Cloud sign-in.
//! - `tokens`: the refresh token in Markie RS's own Keychain service, through
//!   `markie_vault::device::SecretStore`.
//! - `api`: Docs `documents.get` and Drive `files.get`, `files.list` and `files.export`.
//! - `convert`: a Doc's JSON to Markdown, in Rust.
//! - `store`: one sync record per imported file: the ground for two-way sync.
//! - `import`: picking, importing, refreshing with conflict copies, and Save as Word.
//! - `md`, `merge`, `model`, `plan`: two-way sync's Markdown blocks, three-way
//!   diff, Doc model and write planner; `sync`: one round, the scheduler and
//!   change detection; `worker`: the thread that runs them while Markie is open.
//! - `write_test`: the spike tool's opt-in live write test, on a Doc it makes.
//! - `fake` (feature `fake` or tests): a local fake Google for tests and scenes.
//!
//! Nothing here sends Google data to Markie Cloud.
pub mod api;
pub mod config;
pub mod connect;
pub mod convert;
pub mod error;
pub mod import;
pub mod md;
pub mod merge;
pub mod model;
pub mod oauth;
pub mod plan;
pub mod store;
pub mod sync;
pub mod tokens;
pub mod worker;
pub mod write_test;

#[cfg(any(test, feature = "fake"))]
pub mod fake;

pub use error::{GoogleError, Result};

/// The only scope Markie asks Google for. The desktop Picker refuses any other.
pub const DRIVE_FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
pub const DOC_MIME: &str = "application/vnd.google-apps.document";
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
pub const DOCX_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
