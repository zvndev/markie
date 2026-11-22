//! One-time, local-first onboarding from the original desktop workspace.

/// One key for both modules: `markie.seen.v1`, as first-run.ts names it.
pub(super) const SEEN_KEY: &str = super::welcome::SEEN_KEY;

pub(super) fn should_show_welcome(opened_file: bool, seen: bool) -> bool {
    !opened_file && !seen
}

/// Electron's text byte for byte (welcome.rs, fixtures/welcome.md).
pub(super) const WELCOME_DOC: &str = super::welcome::WELCOME_DOC;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handed_over_file_does_not_consume_the_welcome_document() {
        use markie_core::registry::Registry;
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("rs-registry.db");
        {
            let registry = Registry::open(&path).unwrap();
            let seen = registry.setting(SEEN_KEY).unwrap().is_some();
            assert!(!should_show_welcome(true, seen));
            assert!(should_show_welcome(false, seen));
            registry.set_setting(SEEN_KEY, "1").unwrap();
        }
        let reopened = Registry::open(&path).unwrap();
        assert!(!should_show_welcome(false, reopened.setting(SEEN_KEY).unwrap().is_some()));
    }
}
