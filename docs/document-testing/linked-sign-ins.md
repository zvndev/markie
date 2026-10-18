# Linked sign-ins and cloud areas

[Back to the test guide](README.md) · [Connected documents](connected-documents.md)

This feature is implemented in the source preview but is **off on the existing cloud service**. Updating the renderer alone does not enable it. It has not replaced the installed Super-nightly app. Use a disposable local database and synthetic files for acceptance testing; do not migrate a production database just to try these checks.

## Enable a local test server

Use the existing server setup and auth migrations, then set `MARKIE_ACCOUNT_IDENTITIES=1` for that server. It needs a private `BETTER_AUTH_SECRET` of at least 32 bytes and working email delivery (`RESEND_API_KEY` and `EMAIL_FROM`). New identity codes fail closed if delivery is unavailable; they are never printed as a development shortcut. Keep credentials outside source control. `/api/account/capabilities` advertises the enabled feature without exposing account information.

Google linking appears only when that server already has Google OAuth configured. It uses the existing Google callback, an explicit browser consent flow, and a one-use handoff. Changing provider settings or deploying this server remains a separate release checkpoint. Automated tests use injected delivery and synthetic provider records, not real mailboxes or Google accounts.

The rollout flag is not a down-migration. Preserve verified-address history, invitation decision fences and failed Google-write authorization markers when disabling the feature; deleting them can revive stale claims or delayed writes. Take and verify an isolated database backup before staged migration testing. Primary sign-in and existing document grants remain the recovery path while the new routes are disabled.

## Link an email

1. Sign in to an existing account. In Settings, expand **Manage linked sign-ins**.
2. Choose **Link another email**. Confirm the code sent to the primary address, then enter the new address and its separate code.
3. The new address must appear as verified. The primary account ID, existing documents, owner/editor/viewer roles and release entitlement must not change.
4. Sign out and use email-code sign-in with the added address. It must open that same account—not create another one.
5. Ask a test collaborator to share a disposable Markdown document to the added address. Both new shares and pending invitations should arrive in this account. An existing viewer grant must not become editor merely because another address was verified.

An address belonging to a different existing account is refused, even if that other account is not verified. No accounts are merged. The primary address cannot be removed through these controls. An incorrect, expired, replayed, cross-session or replaced code must fail without changing the account.

## Google sign-ins

Confirm the primary mailbox, then choose **Link Google sign-in** and finish the explicit link in the default browser. A provider's email claim does not automatically become an additional verified recipient mailbox; use the email flow above for that address too.

Unlinking a Google provider requires a new primary-email confirmation and signs out **all** sessions of that account, including this device. Existing upstream sessions do not identify their original provider, so revoking them all is deliberate. The primary email/password or primary email-code sign-in remains available. Removing a verified secondary email instead revokes sessions created through that email and their collaboration connections, while retaining primary sessions and existing document grants.

## Organize cloud files

1. Open Cloud and expand **Cloud area**. Create a labeled area and filter the list. Legacy Markdown and document snapshots use the same area selection.
2. Before syncing a new local file, choose **Upload destination** in Library or the share flow. Document snapshot uploads offer the same choice.
3. Upload a synthetic file, reopen the cloud list and verify it appears in the selected area. A rejected destination must not retry into the default area.
4. Save another revision of an existing synced file. It must retain its placement; choosing a new upload destination is not an implicit move operation.
5. Switch accounts or servers during a delayed upload. Old labels/results must disappear, and the upload must not continue under the replacement account's credentials.

Areas are personal labels, not separate accounts, permissions, storage quotas or Google Drive connections. Filing a shared document never changes access or another person's filing. Unlinking an identity keeps its area and documents. The server also supports explicit per-user placement and area renaming; dedicated move/rename controls are not included in this UI milestone.

## Validation boundaries

The regression suites cover SQLite transactions, OTP/session races, share revocation, cloud-area isolation, native upload binding and browser-rendered dark/light interactions. Live Google consent, real email delivery, packaged Windows runtime and a production migration still need staged acceptance. Source changes are not a public release.
