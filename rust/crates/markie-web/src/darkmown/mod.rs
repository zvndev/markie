//! Darkmown `.wd` interactive documents (PARITY.md section 18): source
//! limits, the sanitizer and the preview document. The compiler itself is
//! Electron's pinned JavaScript build, which runs in a disposable web view
//! ([`crate::compiler`]); everything it returns is untrusted and goes through
//! [`security`] before any frame sees it.

pub mod limits;
pub mod links;
pub mod preview;
pub mod security;
