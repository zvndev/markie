# Current Task - macOS Intel package evidence pass

## Task
Make one verified local release/runtime pass toward full Mac support by exercising the macOS Intel
package path on this Apple Silicon host through Rosetta, while preserving the certificate-free local
release boundary.

## Acceptance Criteria
1. `electron:pack:mac:x64` builds an unpacked Intel macOS app through the local electron-builder
   wrapper with `CSC_IDENTITY_AUTO_DISCOVERY=false`, `mac.identity=null`, `--publish never`, and no
   Developer ID signing, notarization, upload, deploy, or release credentials.
2. The existing `build/preflight.cjs` window smoke gate launches the packed Intel app and verifies
   the renderer loaded.
3. `electron:smoke:mac:x64` verifies the Intel app layout, executable, renderer bundle, and bundled
   Markie MCP resources, reporting Rosetta host compatibility when available.
4. Focused package-smoke and release-preflight tests cover the new host-compatible smoke mode.
5. Record evidence in `PROGRESS.md`, run syntax checks, focused tests, package/smoke commands, and
   `git diff --check`.

## Scope Guard
Keep this local and reversible. Do not Developer ID sign, notarize, publish, upload, deploy, touch
release credentials, or claim Windows support is complete without matching Windows host evidence.
Preserve unrelated local edits, including the pre-existing `electron/main.js` updater/menu diff.
