//! Markie RS export, print and converted copies (PARITY.md section 23).
//!
//! Everything here is pure: bytes in, bytes out, no UI and no network. The app
//! asks where a file goes and writes it (`workspace/export.rs`).
//!
//! - [`render`]: Markdown to the sanitized HTML every export starts from,
//!   the port of `markdown-html.ts`.
//! - [`styles`]: the standalone page and stylesheet (`pdf-styles.ts`).
//! - [`assets`]: which local pictures may be read, and inlining them.

pub mod assets;
pub mod autolink;
pub mod convert;
pub mod embeds;
pub mod hast;
pub mod highlight;
pub mod markdown;
pub mod math_html;
pub mod mdast;
pub mod render;
pub mod sanitize;
pub mod strict_math;
pub mod styles;

pub use render::{render_markdown_html, render_tree};
pub use styles::{Theme, build_pdf_html};
