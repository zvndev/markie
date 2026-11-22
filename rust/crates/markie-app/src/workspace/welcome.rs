//! A launch with nothing to open (page.tsx's boot effect): the first one ever
//! shows the welcome document (`src/lib/welcome-doc.ts`, copied byte for byte
//! into fixtures/welcome.md), every later one an empty page. Never the last
//! document: "There is no demo document: a launch without a file opens an
//! empty page, never made-up content."

use gpui_kit::*;
use markie_core::drafts::Drafts;

use super::{DocKind, OpenDoc, Workspace};

pub(super) const WELCOME_DOC: &str = include_str!("../fixtures/welcome.md");

/// `markie.seen.v1` (`first-run.ts`), kept in Markie RS's own registry.
pub(super) const SEEN_KEY: &str = "markie.seen.v1";

/// `shouldShowWelcome`: not when a file was opened, and only until seen. No
/// storage to read means it cannot prove they have seen it.
pub(super) fn should_show_welcome(opened_file: bool, seen: Option<Option<String>>) -> bool {
    if opened_file {
        return false;
    }
    match seen {
        None => true,
        Some(value) => value.is_none(),
    }
}

impl Workspace {
    /// The page a launch with no file opens.
    pub(super) fn open_launch_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let seen = self.registry.as_ref().map(|r| r.setting(SEEN_KEY).ok().flatten());
        let welcome = should_show_welcome(false, seen);
        let text = if welcome { WELCOME_DOC } else { "" };
        if welcome {
            self.open_welcome(window, cx);
        } else {
            self.open_untitled(super::untitled::untitled_name("md"), String::new(), window, cx);
        }
        // `applyExternalDoc`: what is shown is what counts as saved, so the
        // welcome is not an unsaved edit and never reaches the journal.
        self.dirty = false;
        if let Some(OpenDoc { kind: DocKind::Text { saved, .. }, .. }) = &mut self.doc {
            *saved = text.to_string();
        }
        let _ = self.drafts.discard(&Drafts::key_for(None));
        if welcome {
            if let Some(reg) = &self.registry {
                let _ = reg.set_setting(SEEN_KEY, &markie_core::clock::iso(markie_core::clock::now_ms()));
            }
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{WELCOME_DOC, should_show_welcome};

    #[test]
    fn the_welcome_shows_once_and_never_over_a_file() {
        assert!(should_show_welcome(false, Some(None)));
        assert!(!should_show_welcome(false, Some(Some("2026-11-22T00:00:00Z".into()))));
        assert!(!should_show_welcome(true, Some(None)), "a launch that opens a file goes straight to it");
        assert!(should_show_welcome(false, None), "no storage: show it rather than lose onboarding");
    }

    #[test]
    fn the_welcome_is_electrons_text() {
        assert!(WELCOME_DOC.starts_with("# Welcome to Markie\n\nThis is a real markdown file"));
        assert!(WELCOME_DOC.ends_with("press `⌘N` and start\nwriting.\n"));
    }
}
