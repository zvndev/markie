# Current Task - Server-truth share permission gating

## Task
Remove client-side ownership inference from the Share dialog and gate share management actions from
an explicit server-backed access summary for the current user and document.

## Acceptance Criteria
1. The server exposes a read-gated access summary for a doc with `role`, `canRead`, `canEdit`, and
   `canManage` derived from the same permission helpers used by docs, comments, themes, and collab.
2. Share access tests cover owner, editor, viewer, stranger, and deleted-doc summaries.
3. The renderer client can fetch the access summary without changing the existing share-list API.
4. `ShareDialog` uses `canManage` to show invite, remove, public-link revoke/create, and theme-pin
   controls instead of inferring owner status from whether the current user appears in `shares`.
5. Non-owners see their access role and cannot trigger owner-only management UI from the dialog.

## Scope Guard
Do not change the sharing schema, public-link token model, auth provider config, production data, or
release/deploy credentials. Preserve unrelated local edits, including the pre-existing
`electron/main.js` updater/menu diff.
