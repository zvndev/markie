# Current Task - Share permission scope clarity

## Task
Make the Share dialog visibly reflect the server-derived role and capabilities for the current user.

## Acceptance Criteria
1. The Share dialog shows the current role from `/api/docs/:id/access`.
2. Read, edit, and manage capabilities render from the same server-derived access object.
3. Owner/editor/viewer capability mapping has focused regression coverage.
4. Existing server share-access tests still pass.
5. Lint/build/tests and a live Electron dialog smoke pass where reachable without real auth.

## Scope Guard
Do not change public API routes, auth provider configuration, production data, release credentials,
or the unrelated pre-existing `electron/main.js` updater/menu diff.
