//! Markie RS native Word page view (Phase 4, ENG-8734).
//!
//! * `text`: UTF-8 and UTF-16 caret mapping and grapheme moves.
//! * `editor`: the editing model over the `markie-office` engine. No GPUI.
//! * `commands`: the Format, Insert, Layout, Review and View menu commands.
//! * `layout`: run and paragraph looks, page-break hints and pagination.
//! * `colors`: authored run colors adapted to the page on screen only.
//! * `view`: the GPUI page view, input handling and menus.

pub mod actions;
pub mod colors;
pub mod commands;
pub mod editor;
pub mod flow;
pub mod icons;
pub mod layout;
pub mod text;
mod tools;
pub mod view;

pub use view::{PaperTone, ViewMode, WordView, WordViewEvent};

#[cfg(test)]
mod editor_tests;
