//! Markie Cloud client for Markie RS.
//!
//! Mirrors the Electron client's rules (electron/servers.js, share-origin.js,
//! server-request.js, sync.js and src/lib/{auth-client,collab,text-collab,
//! comments,live-snapshot}.ts). Pure rules live in their own functions so they
//! unit-test without a network; the HTTP and websocket layers sit on top.
pub mod account;
pub mod asset_cache;
pub mod assets;
pub mod auth;
pub mod auth_errors;
pub mod client;
pub mod collab;
pub mod comments;
pub mod docs;
pub mod error;
pub mod http;
pub mod links;
pub mod origin;
pub mod platform;
pub mod registry;
pub mod sharing;
pub mod sync;
pub mod tokens;

pub use origin::{CLOUD_ALIASES, CLOUD_DOCS_ORIGIN, DEFAULT_SERVER};

pub use client::CloudClient;
pub use error::CloudError;
