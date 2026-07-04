# Current Task - Restore host native runtime after cross-arch packaging

## Task
Fix the live Library/default-workspace failure caused by cross-architecture local packaging leaving
the development `better-sqlite3` native module in the wrong architecture for the running Electron
host.

## Acceptance Criteria
1. A repeatable local command restores the root `node_modules/better-sqlite3` prebuild for the
   current host platform, host architecture, and Electron version.
2. The local electron-builder wrapper automatically runs that restore step after cross-platform or
   cross-architecture local build/package commands, so Windows/Linux/Intel-Mac package checks do not
   leave the Mac development app unable to load its registry.
3. Release preflight requires the restore helper to remain present, and focused tests cover the
   wrapper decision logic.
4. Library loading failures no longer leave the panel stuck on `Loading…`; they settle to an empty
   state with a readable notice.
5. Live Electron/CDP verification proves `libraryState`, `wsCreateDefault`, and the Files tab default
   workspace work again in the actual app.

## Scope Guard
Do not change registry schema, sharing schema, production release credentials, signing, publishing,
or the current public download status. Preserve unrelated local edits, including the pre-existing
`electron/main.js` updater/menu diff.
