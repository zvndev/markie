//! Markie RS rich editor model (Phase 2a spike, ENG-8731).
//!
//! * `document`: Markdown as top-level blocks that keep their source bytes.
//! * `parse` / `serialize`: blocks to the TipTap-shaped model and back.
//! * `room` / `ydoc`: that model as y-prosemirror's XML, through `yrs`.
//! * `merge`: a room's content folded back onto the opened document.

pub mod document;
pub mod embed;
pub mod linkify;
pub mod merge;
pub mod model;
pub mod parse;
pub mod room;
pub mod serialize;
pub mod ydoc;

pub use document::{Block, BlockContent, Document};
pub use model::{Inline, Marks, Node};
