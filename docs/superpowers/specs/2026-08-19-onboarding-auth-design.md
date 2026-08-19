# Onboarding & Auth Pass — Design

Date: 2026-08-19
Status: approved for implementation

## Problem

Markie has no onboarding, and auth is buried in a Settings tab.

First launch paints a hardcoded `SAMPLE` doc (a fake "Northstar Sprint Brief") and silently
creates a default workspace folder. Nothing tells the user what Markie is, where their library
lives, or that an account exists.

The whole sign-in surface is ~130 lines of inline JSX in `settings.tsx`, reachable only if the
user already knows to look there. Password is the primary method, Google and email-code are
visually demoted, there is no forgot-password path anywhere in the codebase, and errors surface
as developer strings (`Request failed (409).`).

Underneath, `authClient.me()` fires independently in five components, each doing its own
`/api/me` round trip on mount, and an `authNonce` counter is threaded by hand into three of them
as an invalidation bus.

## Decisions

| Question | Decision |
| --- | --- |
| Account posture | Local-first, account earned. First run never mentions an account. |
| First-run shape | The welcome document *is* the onboarding. No modal, no wizard. |
| Auth methods | Google first, email code second, password behind a link. All three kept. |
| Forgot password | In-app, by code. No hosted reset page. |
| Auth state | One store. `authNonce` deleted. |
| Beta channel | Opt-in only, unlisted, revocable. |

Non-goals: changing `auth-state.ts` or `desktop-auth.ts`. The deep-link nonce handshake is
careful, tested work and nothing here requires touching it.

## 1. Auth store

New `src/lib/auth-store.ts`: a module-level store with `{ user, status }` where status is
`checking | in | out`, plus `subscribe`, `refresh`, and `signOut`. A `useAuth()` hook wraps it
with `useSyncExternalStore`.

One `/api/me` on boot instead of five. The deep-link handler in `page.tsx` calls `refresh()`
instead of bumping a counter, and `authNonce` is removed from `page.tsx`, `settings.tsx`,
`activity-bar.tsx`, and the two other call sites.

Rationale: the sign-in dialog must tell `share-gate` "you're in now, reopen the real dialog",
the sync toggle must react to sign-out, and the invited-newcomer flow must refresh the Library
the moment a session lands. All three are trivial with a store and awkward with a counter.

Consumers migrated: `settings.tsx`, `share-dialog.tsx`, `comments.tsx`, `activity-bar.tsx`,
`page.tsx`, `share-gate.tsx`.

## 2. Sign-in surface

New `src/components/sign-in-dialog.tsx`, extracted out of `settings.tsx`. Takes a `reason` prop
so the copy names why sign-in is being asked for:

- from Share: "Sign in to share. Your file stays on this Mac."
- from the sync toggle: "Sign in to sync. Your files stay on this Mac until you turn sync on."
- from Settings: "Sign in to Markie."

Method order: **Continue with Google** (primary) → **email + Email me a code** → "Use a password
instead" (link, reveals the password form) → "Forgot?" inside the password form.

`settings.tsx` Account tab renders the same component rather than its own copy, so there is one
sign-in surface in the app.

### Error copy

Replace status-code passthrough with intent-named messages:

| Condition | Copy |
| --- | --- |
| status 0 | "Can't reach Markie's server. Check your connection." |
| 401 on password | "That email and password don't match." |
| 409 on sign-up | "That email already has an account. Sign in instead." |
| 429 | "Too many attempts. Wait a minute and try again." |
| 400 on OTP verify | "That code isn't right, or it expired. Send a new one." |
| Google state mint failure | "Couldn't start Google sign-in on this machine. Use an email code instead." |

## 3. Welcome document

Replace the `SAMPLE` constant with a real welcome doc in `src/lib/welcome-doc.ts`. It teaches
Markie by being a Markie document: it renders well (so it demos the product), and its content
is the actual feature tour (⌘K, ⌘E, checkboxes, themes, the library).

First-run detection lives in `src/lib/first-run.ts`: a `markie.seen.v1` localStorage flag. On a
cold Dock launch with no flag, paint the welcome doc and set the flag. On later launches, no
welcome doc.

Opening Markie by double-clicking a `.md` file always goes straight to that file and shows no
onboarding, on first run or any other run. This is the common case for a default handler and
must not be hijacked.

The doc mentions sharing and sync exist and that Markie will ask when they're used. It never
asks for an account.

## 4. Forgot password

better-auth's `emailOTP` plugin already ships the endpoints, so this needs no hosted reset page,
no reset-link email, and no new dependency:

- `POST /forget-password/email-otp` with `{ email }` sends a code
- `POST /email-otp/reset-password` with `{ email, otp, password }` resets and signs in

Server change is one branch in `sendVerificationOTP` in `server/src/auth.ts` to give
`type === "forget-password"` its own subject and body, instead of falling through to the
generic "verification code" text.

Client adds `requestPasswordReset` and `resetPassword` to `authClient`, and a two-step view in
the sign-in dialog (email → code + new password).

Rate limiting: `/forget-password/email-otp` is an email trigger and therefore a spam and cost
vector, so it gets the same tightened rule the OTP send already has.

## 5. Invited-newcomer journey

Today an invite email sends a non-user to a web preview that has no path onward. The backend
half already works: `claimPendingInvites` in the `user.create` hook sweeps pending invites into
the new user's Library the moment they sign up.

Add the missing front half: the shared-document preview page gets a real "Get Markie" CTA built
from `primaryDownloadCta()`, plus a line telling the reader that signing up with this same email
puts the document in their library automatically.

The CTA uses the stable manifest route, never a versioned artifact URL, per the release
protocol.

## 6. Beta channel

Requirements: available only to existing users who opt in, never listed publicly, and revocable
after the fact.

**Feed separation.** Beta builds carry a prerelease version (`0.5.0-beta.1`), which makes
Electron Builder emit `beta-mac.yml` alongside the stable `latest-mac.yml`. The two feeds live
in the same bucket and never overwrite each other.

**Unlisted.** `server/download-manifest.json` stays the stable-channel source of truth and gains
no public beta platform entry, so the website and the email CTAs cannot surface a beta build.
The beta feed path is recorded in a separate `betaFeed` block that the site does not read.

**Opt-in.** A "Receive beta updates" toggle in Settings → Advanced, persisted in the main
process (the updater lives there) and applied as `autoUpdater.channel`. Default off. The toggle
is only reachable from inside the app, which satisfies "existing users only".

**Bail-out.** Turning the toggle off sets the channel back to `stable` and enables
`allowDowngrade`, so the user returns to the current stable build on the next check rather than
being stranded above it. On our side, a beta can be withdrawn by reverting `beta-mac.yml`.

Publishing remains a human checkpoint. This work builds and verifies the mechanism; it uploads
nothing.

## Testing

Unit (vitest): auth store transitions and subscriber notification; first-run flag; error-copy
mapping; beta channel resolution. Server (node:test): the `forget-password` OTP subject branch,
and that the reset route is rate-limited.

Manual/e2e: packaged launch under `MARKIE_E2E=1`, driving first run, sign-in dialog from Share
and from the sync toggle, and the beta toggle round trip.

Verification gates before this is release-ready: `npm test`, `npm run lint`, `npm run build`,
`(cd server && npm test)`, `node --test mcp/lib.test.mjs`, `npm run electron:smoke:mac:launch`.
