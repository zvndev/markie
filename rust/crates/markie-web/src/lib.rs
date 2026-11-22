//! Markie RS web islands (PARITY.md sections 18 and 19, and video embeds).
//!
//! The pure parts build without any web view: the Darkmown sanitizer and
//! preview document, Live Docs projects and the dev-server runner. The `wry`
//! feature adds the islands themselves: system web views hosted in a GPUI
//! window, sandboxed as tightly as Electron sandboxes the same content.

pub mod darkmown;
pub mod json;
pub mod live_docs;
