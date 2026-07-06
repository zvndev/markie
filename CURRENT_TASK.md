# Current Task - Share dialog permission states

## Task
Make the Share dialog reflect server-derived permission state precisely, including the difference
between still-checking access, loaded owner/editor/viewer roles, and unavailable access.

## Acceptance Criteria
1. Share access copy distinguishes checking access from access that failed to load.
2. Empty people/public-link copy is role-aware and does not imply ownership when access is
   unavailable.
3. Owner-only actions refuse to run unless `canManage` is confirmed by server access.
4. Focused share-access view tests and server sharing tests pass.
5. Full local release preflight passes, and the live Electron app still boots for inspection.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
