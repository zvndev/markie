# Current Task - Windows package structure evidence pass

## Task
Make one verified local release/runtime pass toward Windows support by building the Windows x64
unpacked artifact on this Mac and strengthening package-smoke checks so a Windows artifact only
passes when the executable, renderer bundle, bundled MCP server, and critical native runtime modules
are present.

## Acceptance Criteria
1. `electron:pack:win` runs through the local electron-builder wrapper with `--publish never`,
   `CSC_IDENTITY_AUTO_DISCOVERY=false`, `win.signAndEditExecutable=false`, and no code signing,
   upload, deploy, or release credentials.
2. `electron:smoke:win` verifies `dist/win-unpacked`, `Markie.exe`, `app.asar`, bundled MCP files,
   `better-sqlite3`, and Windows x64 `node-pty` native files.
3. The smoke checker rejects Windows executable/native payloads that are not PE/MZ binaries, so a
   cross-packaged artifact cannot pass with Mac/Linux native modules by accident.
4. Focused package-smoke tests cover native module requirements and binary-kind validation.
5. Record evidence in `PROGRESS.md`, run syntax checks, focused tests, package/smoke commands, and
   `git diff --check`.

## Scope Guard
Keep this local and reversible. Do not code sign, publish, upload, deploy, touch release
credentials, or claim Windows public support is complete without native Windows launch evidence,
updater feed work, public URLs, and human-gated release approval. Preserve unrelated local edits,
including the pre-existing `electron/main.js` updater/menu diff.
