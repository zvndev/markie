# Current Task - Main-page lint dependency cleanup

## Task
Remove the remaining ESLint warnings that make the main app shell look messier than it is, without
changing UI behavior or broadening product scope.

## Acceptance Criteria
1. `src/app/page.tsx` satisfies React hook dependency lint without making Electron IPC handlers
   capture stale callbacks.
2. The stale MCP eslint-disable comment is removed only if the underlying loop still lints cleanly.
3. `npm run lint` exits with zero warnings.
4. Focused MCP tests and renderer build still pass.

## Scope Guard
Do not change app behavior, add dependencies, alter public API shape, or touch production/release
surfaces. Preserve unrelated local edits, including the pre-existing `electron/main.js`
updater/menu diff.
