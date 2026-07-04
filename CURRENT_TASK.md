# Current Task — User-directed polish/review pass

## Task
Fix first-use default workspace setup, make source-editor theming follow the active theme, improve
light-mode polish, and address high-confidence review findings that are safe in the current scope.

## Acceptance Criteria
1. The Files view creates/registers the default workspace root on first use and has regression
   coverage for existing-root, first-use, and failure paths.
2. CodeMirror source editing follows active light/dark/custom theme tone instead of staying dark.
3. Light-mode visual guard covers source-editor samples and passes with zero contrast findings.
4. High-severity viewer live-collab write access is blocked at the WebSocket sync boundary.
5. Run focused tests, visual guard, and `./init.sh`.

## Scope Guard
Keep local-first behavior intact. Do not change public API shapes, deploy, release, notarize,
publish, or touch credentials. Preserve unrelated local edits, including the pre-existing
`electron/main.js` updater/menu diff.
