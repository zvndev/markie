# Current Task - Authenticated share route verification

## Task
Prove the share invite/remove/public-link lifecycle locally with authenticated API routes, without
requiring production accounts, external credentials, or release actions.

## Acceptance Criteria
1. Local test users can sign up through the real Better Auth route and receive bearer tokens.
2. Owners can add an existing user as a member and remove that member by user id.
3. Owners can add and remove pending email invites by email.
4. Pending invites claim into real member access when the invited email signs up.
5. Viewer, editor, and owner permissions are enforced on doc writes, share management, and public
   link creation/revocation.
6. The server test command and release preflight pass with the new coverage.

## Scope Guard
Do not use production accounts, production credentials, external email delivery, public deploys,
pushes, signing, notarization, update feeds, or release publishing.
