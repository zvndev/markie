# Current task - Markie

## F-006 - Repeatable light-mode visual audit

Description: A repeatable light-mode visual audit captures the primary Markie app shell and flags invisible or low-contrast UI before style fixes continue.

Acceptance steps:
1. Start the app or renderer in a local development environment with the built-in light theme active.
2. Capture screenshots or DOM/computed-style evidence for the toolbar, editor/rich view, left rail, library, command palette, settings, share dialog, and comments surfaces.
3. Record each invisible or low-contrast issue as a concrete checklist in a local audit artifact or test output.
4. Run the focused audit plus `./init.sh`.

Scope notes:
- Keep this run to audit/harness/evidence.
- Fix only a trivial issue if needed to make the audit run.
- Do not redesign layout or address the individual style clusters reserved for F-007 through F-011.
