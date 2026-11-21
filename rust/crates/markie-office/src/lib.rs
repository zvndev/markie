//! Markie RS Office engine. A port of `src/lib/office` and
//! `src/lib/document-import` from the Electron app.
//!
//! Provenance: every codec here is our own, written from the public
//! specifications (ECMA-376/OPC, PKWARE APPNOTE, W3C XML, MS-CFB, MS-DOC, the
//! Microsoft RTF specification, OASIS ODF and WHATWG HTML), exactly as recorded
//! in `docs/decisions/2026-10-14-original-document-engine.md`. No third-party
//! Office engine is used. The only dependency is `miniz_oxide` for raw DEFLATE,
//! the generic platform primitive the decision allows.
//!
//! Offsets: the TypeScript engine measures text in UTF-16 code units. This
//! crate measures XML source offsets and paragraph text offsets in UTF-8 bytes,
//! which is what Rust strings and GPUI use. Every offset that would split a
//! character is rejected.

pub mod error;
pub mod xml;
pub mod zip;

pub use error::{ErrorKind, OfficeError, Result};
