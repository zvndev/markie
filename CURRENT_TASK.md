# Current Task - Pending invite permission scope

## Task
Tighten sharing visibility so pending invite emails are treated as owner-only management state,
while joined collaborators can still see the people who already have access.

## Acceptance Criteria
1. `GET /api/docs/:id/shares` still allows owners, editors, and viewers to read joined
   collaborators for a document they can read.
2. Pending invite rows are included only for owners.
3. Viewers and editors cannot infer pending invite emails from the share-member list.
4. Existing share lifecycle, public-link, access-summary, and shared-by-me tests pass.
5. Full local release preflight passes without signing, publishing, uploading, or deploying.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
