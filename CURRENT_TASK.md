# Current Task - Library status overview polish

## Task
Make the Library feel more organized by showing a compact status overview for local, synced, shared,
and attention-needed documents.

## Acceptance Criteria
1. The Library panel summarizes tracked documents without blocking the Files workspace.
2. The summary distinguishes device-local files, synced docs, shared docs, and issues.
3. Empty Recent state has clear primary actions instead of a paragraph.
4. The summary logic has focused regression coverage.
5. Lint/build/tests and live dark/light Electron checks pass.

## Scope Guard
Do not sign, notarize, publish, deploy, upload, change release credentials, or alter the unrelated
pre-existing `electron/main.js` updater/menu diff.
