# Current Task - Desktop package smoke evidence pass

## Task
Make one verified local release/runtime pass toward full Windows and Mac support by adding a
host-aware package smoke contract for unpacked desktop artifacts, then prove the Apple Silicon
macOS package path locally.

## Acceptance Criteria
1. Unpacked package smoke checks cover macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64
   artifact layouts without Developer ID signing, notarization, upload, publish, deploy, or release
   credentials.
2. The smoke checker verifies the app executable, renderer bundle, and bundled Markie MCP resources
   for each target and reports when only structure evidence is possible on the current host.
3. Local package/build scripts disable electron-builder Developer ID identity discovery through a
   wrapper, and release preflight validates that wrapper plus package-smoke scripts for the desktop
   matrix.
4. `scripts/perf-check.mjs`, README, release docs, and the cross-platform audit plan no longer
   document only a Mac package command.
5. Run focused package-smoke tests, release-preflight tests, syntax checks, a local macOS arm64
   package, the matching package smoke command, visual guard, and `./init.sh`.

## Scope Guard
Keep this local and reversible. Do not Developer ID sign, notarize, publish, upload, deploy, touch
release credentials, or claim Windows/Intel Mac public support is complete without matching host
evidence.
Preserve unrelated local edits, including the pre-existing `electron/main.js` updater/menu diff.
