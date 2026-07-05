# Current Task - Library default workspace bootstrap

## Task
Make the Library create and surface Markie's default workspace as soon as the desktop Library opens,
instead of waiting for the user to discover the Files tab.

## Acceptance Criteria
1. The Library startup path creates `~/Documents/Markie` when no workspace roots exist.
2. Workspace bootstrap failure does not hide existing Library items.
3. The empty Recent state shows the ready default workspace instead of a dead empty panel.
4. Focused Library/workspace tests pass.
5. Lint, build, theme visual guard, and live Electron CDP checks pass in dark and light modes.

## Scope Guard
Do not push, publish, deploy, run external CI, sign/notarize artifacts, change release credentials,
or alter the unrelated pre-existing `electron/main.js` updater/menu diff.
