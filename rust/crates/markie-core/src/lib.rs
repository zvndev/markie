//! Markie RS core. Everything here is UI-free and testable without a window.
//!
//! Each module mirrors one piece of the Electron app so the two stay in step:
//!
//! | Module      | Mirrors                                              |
//! | ----------- | ---------------------------------------------------- |
//! | `formats`   | `src/lib/document-formats.ts`                        |
//! | `index`     | `electron/mdindex.js` (the device-wide walk)         |
//! | `search`    | `src/lib/doc-search.ts` / global search              |
//! | `save`      | `electron/atomic-write.js`                           |
//! | `outline`   | `src/lib/section-outline.ts`                         |
//! | `stats`     | `src/lib/stats.ts`                                   |
//! | `paths`     | Electron `app.getPath("userData")`, but a separate   |
//! |             | "Markie RS" folder so this build never touches the   |
//! |             | shipping app's registry or settings.                 |
//! | `registry`  | `electron/registry.js` (recents and sync state)      |
//! | `history`   | `electron/history.js` + `snapshots.js` (versions)    |
//! | `drafts`    | `electron/drafts.js` (crash drafts)                  |
//! | `autosave`  | `src/lib/autosave.ts` (when to save)                 |
//! | `disk`      | `electron/disk-memory.js` (own write or outside edit)|

pub mod autosave;
pub mod clock;
pub mod csv;
pub mod disk;
pub mod doc_text;
pub mod document;
pub mod drafts;
pub mod formats;
pub mod history;
pub mod import;
pub mod link_preview;
pub mod index;
pub mod outline;
pub mod paths;
pub mod projects;
pub mod registry;
pub mod save;
pub mod search;
pub mod stats;
