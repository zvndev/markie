# Current Task - Windows native launch smoke path

## Task
Make Windows launch readiness auditable by adding a Windows-host smoke command and CI workflow that
build the unsigned Windows x64 unpacked app, verify its package structure, launch `Markie.exe` on a
real Windows runner, and prove the packaged renderer loads Markie UI through CDP.

## Acceptance Criteria
1. `electron:smoke:win:launch` exists and runs only on `win32`, with a clear failure on Mac/Linux so
   structure-only checks cannot be mistaken for native Windows launch evidence.
2. The launch smoke resolves `dist/win-unpacked/Markie.exe`, starts it with an isolated user data
   directory and remote debugging port, connects to the packaged Electron page through CDP, and
   validates title, document readiness, and visible Markie UI.
3. Focused tests cover the host guard, Windows executable resolution, CDP target selection, and
   renderer-probe validation without attempting to run a Windows binary on this Mac.
4. Release preflight requires the launch smoke script, package script, and Windows-host workflow to
   remain present, but does not run the Windows-only launch smoke on non-Windows hosts.
5. Documentation and the cross-platform audit distinguish local Windows structure evidence from
   native Windows launch proof.

## Scope Guard
Keep this local/CI-only and reversible. Do not code sign, publish, upload, deploy, touch release
credentials, or claim public Windows support is complete without a successful Windows-host run,
Windows code signing, update feeds, public download URLs, and human-gated release approval. Preserve
unrelated local edits, including the pre-existing `electron/main.js` updater/menu diff.
