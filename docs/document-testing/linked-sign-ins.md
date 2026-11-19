# Linked sign-ins and cloud areas

[Back to the test guide](README.md) · [Connected documents](connected-documents.md)

This feature is controlled by `MARKIE_ACCOUNT_IDENTITIES` on the server. Updating the app alone does not enable it. Use a disposable local database and synthetic files for acceptance testing; do not migrate a production database just to try these checks.

## Enable a local test server

Use the existing server setup and auth migrations, then set `MARKIE_ACCOUNT_IDENTITIES=1` for that server. It needs a private `BETTER_AUTH_SECRET` of at least 32 bytes and working email delivery (`RESEND_API_KEY` and `EMAIL_FROM`). New identity codes fail closed if delivery is unavailable; they are never printed as a development shortcut. Keep credentials outside source control. `/api/account/capabilities` advertises the enabled feature without exposing account information.

Google linking appears only when that server already has Google OAuth configured. It uses the existing Google callback, an explicit browser consent flow, and a one-use handoff. Changing provider settings or deploying this server remains a separate release checkpoint. Automated tests use injected delivery and synthetic provider records, not real mailboxes or Google accounts.

Apple works the same way, and only when the server has all four Apple settings:

| Setting | Value |
|---|---|
| `APPLE_CLIENT_ID` | The Services ID, for example `com.zvn.markie.signin` |
| `APPLE_TEAM_ID` | The Apple Developer team ID |
| `APPLE_KEY_ID` | The ID of the Sign in with Apple key |
| `APPLE_PRIVATE_KEY` | The contents of that key's `.p8` file. Literal `\n` escapes are accepted. |

With any of them missing, nothing about Apple shows: no buttons, no routes, and `apple` is absent from `/api/server-info`. A key that is set but unreadable stops the server at boot. The Services ID's return URL is `<server>/api/auth/callback/apple`. The server signs Apple's client secret from the key itself and signs a fresh one each day, so there is nothing to rotate by hand. Automated tests use a throwaway key and a stand-in for Apple's token endpoint.

The rollout flag is not a down-migration. Preserve verified-address history, invitation decision fences and failed Google and Apple write authorization markers when disabling the feature; deleting them can revive stale claims or delayed writes. Take and verify an isolated database backup before staged migration testing. Primary sign-in and existing document grants remain the recovery path while the new routes are disabled.

## Link an email

1. Sign in to an existing account. In Settings, expand **Manage linked sign-ins**.
2. Choose **Link another email**. Confirm the code sent to the primary address, then enter the new address and its separate code.
3. The new address must appear as verified. The primary account ID, existing documents, owner/editor/viewer roles and release entitlement must not change.
4. Sign out and use email-code sign-in with the added address. It must open that same account—not create another one.
5. Ask a test collaborator to share a disposable Markdown document to the added address. Both new shares and pending invitations should arrive in this account. An existing viewer grant must not become editor merely because another address was verified.

With the feature on, email-code sign-in for an address that no verified account owns still works as before: a new address creates an account (subject to `MARKIE_SIGNUP`), and an unproven account is reclaimed by its mailbox owner.

An address belonging to a different existing account is refused, even if that other account is not verified. No accounts are merged. The primary address cannot be removed through these controls. An incorrect, expired, replayed, cross-session or replaced code must fail without changing the account.

## Google and Apple sign-ins

Confirm the primary mailbox, then choose **Link Google sign-in** or **Link Apple sign-in** and finish the explicit link in the default browser. A provider's email claim does not automatically become an additional verified recipient mailbox; use the email flow above for that address too.

Each Google or Apple sign-in linked or used to sign up from now on is listed with its address, for example `Google: kirby@zvndev.com` or `Apple: x7k2p9qz4m@privaterelay.appleid.com`. The address is a label only. Markie never uses it to sign in, to match an account or to send mail. A Hide My Email address is shown as Apple gives it. Rows linked before this change have no address and keep their old name, such as `Google sign-in 2`.

Check these with two Apple IDs and two Google accounts on one test account:

1. Link both Apple IDs and both Google accounts. Each row must show its own address.
2. Sign out. Sign in with one of the Apple IDs. It must open the same account, not a new one.
3. Unlink one Apple ID. The other three rows must stay.
4. Sign in with Apple using an Apple ID whose email already has a separate Markie account. It must be refused with a message to sign in by email code and link Apple in Settings. No accounts merge.

Unlinking a Google or Apple provider requires a new primary-email confirmation and signs out **all** sessions of that account, including this device. The confirmation is scoped to that provider: a code confirmed for unlinking Google cannot unlink Apple. Existing upstream sessions do not identify their original provider, so revoking them all is deliberate. The primary email/password or primary email-code sign-in remains available. Removing a verified secondary email instead revokes sessions created through that email and their collaboration connections, while retaining primary sessions and existing document grants.

## Organize cloud files

1. Open Cloud and expand **Cloud area**. Create a labeled area and filter the list. Legacy Markdown and document snapshots use the same area selection.
2. Before syncing a new local file, choose **Upload destination** in Library or the share flow. Document snapshot uploads offer the same choice.
3. Upload a synthetic file, reopen the cloud list and verify it appears in the selected area. A rejected destination must not retry into the default area.
4. Save another revision of an existing synced file. It must retain its placement; choosing a new upload destination is not an implicit move operation.
5. Switch accounts or servers during a delayed upload. Old labels/results must disappear, and the upload must not continue under the replacement account's credentials.

Areas are personal labels, not separate accounts, permissions, storage quotas or Google Drive connections. Filing a shared document never changes access or another person's filing. Unlinking an identity keeps its area and documents. The server also supports explicit per-user placement and area renaming; dedicated move/rename controls are not included in this UI milestone.

## Validation boundaries

The regression suites cover SQLite transactions, OTP/session races, share revocation, cloud-area isolation, native upload binding and browser-rendered dark/light interactions. Live Google and Apple consent, real email delivery, packaged Windows runtime and a production migration still need staged acceptance. Source changes are not a public release.
