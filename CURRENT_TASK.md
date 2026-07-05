# Current Task - Files workspace empty-state polish

## Task
Make the default Files workspace feel intentionally set up when it is empty, instead of showing a
bare `empty` label under the `MARKIE` root.

## Acceptance Criteria
1. The default workspace root is visibly marked as the default root when available.
2. An empty top-level workspace root shows a compact, theme-aware empty state with New file and New
   folder actions.
3. Empty nested folders remain compact and do not consume the whole side panel.
4. Build, lint, visual theme guard, and live Electron/CDP Library checks pass.

## Scope Guard
Do not change workspace persistence, filesystem IPC behavior, dependencies, public API shape,
release surfaces, or production data. Preserve unrelated local edits, including the pre-existing
`electron/main.js` updater/menu diff.
