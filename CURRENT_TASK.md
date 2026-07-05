# Current Task - Share permission copy parity

## Task
Make the Share dialog's visible permission summary match the server-scoped actions for read,
comment, edit, and manage access.

## Acceptance Criteria
1. Owner, editor, and viewer labels still come from server-derived access.
2. The Share dialog shows comment capability separately from read/edit/manage.
3. Viewer copy no longer claims viewers can comment when the server forbids comment writes.
4. Focused client and server permission tests pass.
5. Lint, build, and theme visual guard pass after the UI copy change.

## Scope Guard
Do not push, publish, deploy, run external CI, sign/notarize artifacts, change release credentials,
or alter the unrelated pre-existing `electron/main.js` updater/menu diff.
