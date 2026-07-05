# Current Task - F-018 release docs and preflight clarity

## Task
Make the release docs and local preflight clearly describe how to produce and verify desktop
downloads for Apple Silicon macOS, Intel macOS, Windows, and Linux without confusing local checks
with public publishing.

## Acceptance Criteria
1. `docs/RELEASING.md` lists per-platform local build/pack commands, expected artifact patterns,
   and verification commands for Apple Silicon macOS, Intel macOS, Windows x64, and Linux x64.
2. The docs explicitly separate safe local dry runs from signing, notarization, upload, publish,
   deploy, and public release approval.
3. `release:preflight` validates that the release-doc contract contains required platform/gate
   snippets without requiring credentials.
4. Focused release-preflight tests and full boot smoke pass.
5. `feature_list.json` marks `F-018` passing only with fresh evidence.

## Scope Guard
Do not sign, notarize, publish, deploy, upload, change release credentials, touch production data, or
alter the unrelated pre-existing `electron/main.js` updater/menu diff.
