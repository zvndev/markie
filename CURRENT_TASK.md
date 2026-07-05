# Current Task - F-017 local packaging dry-run closure

## Task
Close F-017 by verifying that Electron packaging config supports local dry-run targets for Apple
Silicon macOS, Intel macOS, Windows, and Linux without publishing.

## Acceptance Criteria
1. The electron-builder package matrix includes mac arm64, mac x64, Windows x64, and Linux x64 local
   targets.
2. Local pack/build scripts use the unsigned local wrapper and disable publishing.
3. Release preflight validates the packaging matrix and stops before signing, notarization, upload,
   publish, deploy, or credential checks.
4. Focused packaging/preflight tests and full boot smoke pass.
5. `feature_list.json` marks `F-017` passing only with fresh evidence.

## Scope Guard
Do not sign, notarize, publish, deploy, upload, change release credentials, touch production data, or
alter the unrelated pre-existing `electron/main.js` updater/menu diff.
