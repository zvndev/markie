# Current Task — Desktop packaging matrix pass

## Task
Make one verified local-only pass toward first-class Windows/macOS desktop support by adding a
machine-checked packaging matrix, cross-platform icon assets, and release docs that distinguish
local artifact readiness from credentialed public release work.

## Acceptance Criteria
1. `package.json` defines local no-publish packaging scripts for macOS arm64, macOS x64, Windows
   x64, and Linux x64.
2. Electron Builder config includes macOS arm64/x64, Windows x64, and Linux x64 targets with
   platform-appropriate icon assets.
3. `release:preflight` validates the matrix and generated icons without signing, notarizing,
   uploading, publishing, deploying, or touching credentials.
4. README and release docs honestly describe current public release status versus local platform
   readiness.
5. Run focused preflight tests, `release:preflight`, lint/build, visual guard, and `./init.sh`.

## Scope Guard
Keep local-first behavior intact. Do not sign, notarize, publish, upload, deploy, or touch release
credentials. Preserve unrelated local edits, including the pre-existing `electron/main.js`
updater/menu diff. Do not claim Windows/macOS release support is complete until native-host package
verification, signing/notarization/code-signing, updater feeds, and download-page evidence exist.
