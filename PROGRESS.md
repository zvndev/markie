# Release and operations log: Markie

> Releases, deploys, and production changes, newest at the bottom. Append a new entry; do not
> rewrite old ones. Older entries, including the long-agent-loop journal, are in git history.

## 2026-10-20 Release pipeline, self-hosting, public repo hardening

Kirby asked for a super nightly, early access, then timed stable pipeline, self-hosted servers that can still share, and a secure public repo.
- Public repo: gitleaks over all history and the unpushed commits found only fixtures. Actions hold no secrets; Azure signing trusts only `main`. Pinned the signing workflow's actions to SHAs with Dependabot for the pins, turned on Dependabot alerts and security fixes, required CI approval for all outside contributors, and protected `main` (PR plus unit, lint-build, server, mcp, version-consistency; admins can bypass).
- Release pipeline: `release:publish:early:*`, `release:promote`, `release:promote-due`, `release:hold`/`unhold`, `release:rollback:early`/`:win`. Early builds carry stable numbers and the same files are promoted after a 3-day soak. The CONSTITUTION amendment that lets one "release" approve the timed promotion is drafted for Kirby; nothing schedules `promote-due` yet.
- Self-hosted server: `/api/server-info`, `MARKIE_OFFICIAL` (unset keeps Markie Cloud's guards), any S3 storage, encrypted backups required, `deploy/init.sh`, invite-only sign-up by default (`MARKIE_SIGNUP`, `MARKIE_ADMIN_EMAIL`), optional quotas, `docs/SELF-HOSTING.md`. Docker end to end with MinIO passed, including restore after losing the volume. Production needs no new variables.
- Desktop: trusted servers list, a native prompt before opening links from unknown servers, a session per server, per-doc `cloud_origin` registry column, server badges, invite-only messaging. Private builds stay on Markie Cloud.
- Security review of the multi-server code found a high-severity token mix-up through Google sign-in; fixed with an `iss` on the desktop deep link, plus seven smaller fixes (explicit sync destination, look-alike names, bounded bodies, encoded path checks with origin-bound tokens, loopback, landing extensions, private-build lock).
- Fixed test flakes: vault clipboard clear race, MCP tests inheriting the developer's CLAUDE_CONFIG_DIR.

Verification: npm test 4789 passed, server 453 passed, MCP 81, lint, typecheck, build. 0.8.1-super-nightly.16 published at d5bd85c; the unauthenticated feed returns 404.
Not verified: a real self-hosted server on the internet, real Google sign-in against one, live editing across servers, B2 with the new empty `region` line (lands at the next api deploy).

## 2026-10-21 Production: api.markiedocs.com, linked sign-ins, key rotation, nightly.17

Kirby approved the production steps.
- **Domain.** Railway custom domain `api.markiedocs.com` on service `api`; Vercel DNS `CNAME api -> 3ghxt5sn.up.railway.app`. Certificate was still validating at the time of writing.
- **API deploy.** `a101c56` from a clean `git archive`, after snapshot `/data/pre-deploy-2026-10-21.db` (integrity ok) and a check that no two accounts' emails differ only by case (18 users, 0 collisions). `/health` 200, `/api/docs` 401, Litestream writing to `markie-db-age`.
- **Linked sign-ins.** `MARKIE_ACCOUNT_IDENTITIES=1`; `/api/account/identities` answers 401 without a session.
- **Litestream key rotated.** New age identity in `~/.markie-secrets/litestream-age-identity-2026-10-21.txt`; Railway identity and recipient both match it. A full restore from B2 inside the container decrypted with the new key (18 users, integrity ok).
- **Nightly.** `0.8.1-super-nightly.17` published at `a101c56` (nightly.16 had already shipped at d5bd85c). Unauthenticated feed 404.

- **Certificate.** Stuck at `VALIDATING_OWNERSHIP` until the `_railway-verify.api` TXT record was added; the CLI never printed it.
- **Google redirect URI.** Added through Codex computer use in Arc on project `markie-499114`; the Railway callback stays.
- **Flip.** `BETTER_AUTH_URL=https://api.markiedocs.com`. Both names report that origin in `/api/server-info`; `/auth/google-start` on the Railway name answers 308 to the new name; Google receives `redirect_uri=https://api.markiedocs.com/api/auth/callback/google` and shows its sign-in page with no mismatch.

Not verified: a full Google and email sign-in by a real released app after the flip.

## 2026-10-21 Locked private builds finish Google sign-in (nightly.18, .19)

A real sign-out test on nightly.17 stranded Kirby on the private-build screen: it offered only email codes. Two causes, fixed in turn:
- **nightly.18 (1a5bb99).** The gate hid Google because main dropped every deep link while locked and only the document shell listened for `markie://auth`. Main now lets `markie://auth` through while locked, and the gate takes it while locked.
- **nightly.19 (8c025ae).** Google still did not unlock: locking reloads the window and clears `rendererReady`, which only the document shell sets, so main queued the link forever. Main now keeps it as `pendingAuthLink` for the gate to collect, and also sends it live.

Verification: full suite 4826, lint, typecheck. Live, through Codex computer use in Markie and Arc: nightly.19 signed out, Continue with Google, the gate cleared on its own, same account, synced docs and the 9 local drafts intact. Email-code sign-in through `api.markiedocs.com` also passed on nightly.17.

## 2026-10-21 Agent cloud links (nightly.20, a7eec0f)

Kirby asked that an agent can make him "a hosted private Markie" and hand back a link he can open away from the computer; public links only when he says so.
- **App:** `electron/agent-bridge.js` listens on `~/.markie/agent-<id>.sock` (0600, dir 0700) with a token in `agent-bridge-<id>.json` (0600). `electron/agent-cloud.js` decides: Markdown and text under home only; consent on an agent's first upload with "always allow" (Agents dialog toggle); every public link confirmed; locked private builds refuse.
- **MCP:** `markie_cloud_status`, `markie_cloud_sync`, `markie_cloud_public_link` (create only when asked), `markie_cloud_revoke_public_link`, via `mcp/agent-client.mjs`. Instructions tell agents to hand back the private link.
- **Server:** `/auth/web-signin` and `/auth/web-google`, and the `/d/<id>` access page offers Sign in. Not deployed yet: Railway paused builds in all regions during a major outage on 2026-10-21.
- **Library:** Copy private link.

Verification: app suite 4842, server 480, MCP 85, lint, typecheck. Live on nightly.20: the repo MCP server synced `~/Documents/Markie/agent-cloud-link-test.md` after one consent click (driven through Codex computer use), returned `https://api.markiedocs.com/d/be41f999-…`, which is 403 anonymously, has no public link, and opens in Arc with Kirby's session.
Not verified: web sign-in on the live server (pending deploy), a public link made live, an agent registered in Claude Code or Codex using the tools on its own.

## 2026-10-22 Markie Cloud moved from Railway to Fly.io

Railway disclosed on 2026-10-21 that customer environment variables may have been read, and paused deploys. Kirby chose to leave Railway.
- **Secrets rotated in the move:** new Backblaze backup key (`markie-backup-fly-20261022`) and media key (`markie-assets-fly-20261022`), new age identity (saved to `~/.markie-secrets/litestream-age-identity-2026-10-22.txt`), new `BETTER_AUTH_SECRET`. The leaked `Markie-key` and `markie-assets-api` keys are deleted. Google and Resend/justemail secrets still carry the leaked values until Kirby makes new ones.
- **Cutover (03:27–03:31 UTC):** consistent snapshot of the Railway database (integrity ok, two identical snapshots, so no writes lost), Railway `api` deployment removed at 03:29:12, database seeded onto the Fly volume through a temporary machine (sha256 matched), app started with a new Litestream generation, `api.markiedocs.com` CNAME flipped to Fly at 03:30:35. Certificate was issued before the flip.
- **Website:** markiedocs.com's `/download`, `/d/` and `/s/` rewrites now proxy to `api.markiedocs.com` (markie-site 723a86b).
- **Verified on Fly:** 18 users, 45 docs, integrity ok; `/health` 200, `/api/docs` 401, server-info origin `api.markiedocs.com`, Google start uses the `api.markiedocs.com` callback, web sign-in page 200, Litestream writing to `markie-db-age`, new media key lists the bucket.
- **Consequence:** released v0.8.0 apps call the Railway hostname, which now answers 404, so their Cloud features stop until they update to a build that knows `api.markiedocs.com`.

Still to do: new Google and email secrets; move the super-nightly gateway (still on Railway, publish key leaked) and ship a nightly that points at it; stable v0.8.1; delete the Railway `markie` project (its volume still holds database copies); purge Litestream generations written under the leaked age keys.

## 2026-10-22 Nightly channel on Fly, Railway markie project deleted, 0.8.1 hotfix prepared

- **Lockout found and fixed.** Stopping the Railway API locked the installed nightly: it re-authorizes every 30 s through the gateway, which verified sessions against the dead Railway API, and Railway's paused deploys blocked changing that. The gateway now runs on Fly as `markie-nightly` (`server/fly.nightly.toml`, new publish key in `~/.markie-secrets/fly-2026-10-22/`), `PRIVATE_GATEWAY_ORIGIN` is `https://markie-nightly.fly.dev` (57a8b8b), and `0.8.1-super-nightly.21` was published there and installed by hand into /Applications (signed, notarized, Gatekeeper accepted; nightly.20 kept at /tmp/Markie-nightly20-fallback.app). It opened already unlocked; account, synced docs and the 9 drafts intact (checked through Codex computer use).
- **Railway `markie` project deleted**, with the stopped API, its volume of database copies, and the old gateway with the leaked publish key. zvndev's Railway workspace is empty.
- **0.8.1 hotfix** on branch `hotfix/0.8.1-cloud-origin` (worktree `../markie-wt-hotfix-081`, 2427055): v0.8.0 plus the Cloud address change only. Default server `api.markiedocs.com`, the Railway host removed from the allowlist and the CSP, a saved Railway server migrated on read. v0.8.0's own suite on its own lockfile: 2528 passed, lint clean. Who it fixes: every released build; 4 non-ZVN accounts, one active on Oct 20.

## 2026-10-22 Google and email secrets rotated; per-client rate limits on Fly; 0.8.1 prepared

- **JustEmail:** new key `markie-api-fly-2026-10-22b` (id 301480317f6f5efa57f6a8080a1f7fc8, sending only, markiedocs.com only) set on Fly from the clipboard; a sign-in code to kirby@zvndev.com was accepted with no send errors. A first attempt made a key with all domains and an uncopied secret; it was revoked. The old `markie-api` key is still active until Kirby confirms delivery.
- **Google:** the OAuth client had two secrets (the cap). `yCIl` was unused and deleted; new secret `JxK-` set on Fly; a real web Google sign-in landed on the private test document; the leaked `v_8J` was disabled and is gone. The client now holds only `JxK-`.
- **Rate limits:** better-auth could not resolve the client IP on Fly and used one shared bucket. `MARKIE_CLIENT_IP_HEADER=fly-client-ip` on Fly only (618ce8a); warning gone after deploy.
- **0.8.1:** PR #13 merged to main (84cb5a5); `release:prepare:mac` passed (preflight, arm64 and x64 launch smoke, codesign, Gatekeeper, notarization stapled on apps and DMGs). The packaged app names `api.markiedocs.com`; the one Railway string left is the saved-address migration. Preflight needs `CLAUDE_CONFIG_DIR` unset on main until the MCP test isolation fix lands there. Not published: waiting for Kirby.

## 2026-10-22 Markie 0.8.1 published (macOS)

- `release:publish:mac -- --confirm-public-release=0.8.1` at Kirby's "yea publish": zips, DMGs, blockmaps and `latest-mac.yml` uploaded; `release:verify:public --version=0.8.1 --deep` valid with full SHA-512 checks; markiedocs.com/download/latest.json reports 0.8.1.
- Final human check done through Codex computer use: the real 0.8.0 arm64 zip from markie-releases, run from a test folder, had already downloaded 0.8.1, installed it with Restart & Update, relaunched as 0.8.1, and showed the old stable profile signed in (kirby@zvndev.com) with no Cloud error. Test copy removed; the nightly was quit for the test and relaunched.
- Tag `v0.8.1` on 84cb5a5 pushed. Windows was not built or published.
- Main now carries 0.8.1 (hotfix plus #1-#3); `feat/document-platform-foundation` does not have the hotfix commit yet and must take it when it merges.

## 2026-10-22 Markie 0.8.1 for Windows; 0.8.1 merged into the platform branch

- Windows: `windows-release.yml` on main 84cb5a5 with `signing: azure`, `publish_release: true` (run 39729791197, success: Azure Trusted Signing, signature check, install/launch/uninstall on a Windows runner). `release:prepare:win` verified the installer signed by CN=ZVN DEV LLC and every SHA-512; `release:publish:win -- --confirm-public-release=0.8.1` uploaded the installer, blockmap and `windows/latest.yml`; `release:verify:public:win --deep` valid. latest.json: mac-arm64, mac-x64 and windows-x64 all 0.8.1. Not checked: an installed Windows 0.8.0 updating itself.
- `origin/main` merged into `feat/document-platform-foundation` (89da0cc). The branch's own cloud-origin code won the conflicts, since it already treats Railway as an alias of api.markiedocs.com; main brought 0.8.1, its changelog and #1-#3. App 4842, MCP 85, server 480, lint, typecheck.

## 2026-10-25 Markie 0.9.0 stable; mobile app and agent links merged; server deployed

- **0.9.0:** reached the release gate with `mcp/doc-text.cjs` missing from the public asar. Fixed in PR #20, which also made `mac-launch-smoke` and Windows `launch-smoke` run on every PR and read `markie-crash.log`. Published to early access, then promoted to stable at Kirby's request, with the update checks passed.
- **PR #31 merged** (6f0cfbd): the Capacitor mobile app in `apps/mobile`, remote agent tokens scoped to the documents they write, hosted MCP at `POST /mcp`, Darkmown cloud sync, and the richer agent guide. Contract: `docs/mobile/AGENT-LINKS-CONTRACT.md`.
- **Server:** Fly `markie-api` release v5, after a better-sqlite3 snapshot at `/data/pre-deploy-2026-10-25.db`. 47 documents intact. AASA and assetlinks live on api.markiedocs.com and markiedocs.com (markie-site 184d1e7).
- **Mobile stores:** iOS 0.1.0 (1) uploaded to App Store Connect as "Markie Docs" (team 3VU8SG5TD9), not yet in a TestFlight group. Android AAB built and signed with the upload key; Play upload waits on the Play Console account verification.

## 2026-10-27 Markie 0.9.1 on early access (macOS and Windows)

- PR #34 set 0.9.1 with release notes. Built from main 6451801, which also carries the server-only PRs #35 and #36.
- `release:prepare:mac` passed: preflight, arm64 and x64 launch smoke, signing, notarization and stapling. Windows run 40500533436 signed by Azure; `release:prepare:win` verified CN=ZVN DEV LLC and every SHA-512.
- `release:publish:early:mac` and `release:publish:early:win` published. `mac/beta-mac.yml` and `windows/beta.yml` report 0.9.1; the stable feeds stay on 0.9.0. Promotion is due 2026-10-30 unless held.
- Kirby's Mac moved from `0.9.1-super-nightly.1` to the public 0.9.1 build (Gatekeeper accepted, launched).
- Still open: TestFlight group and export compliance (needs Kirby in App Store Connect), Play internal testing (needs the Play account verified), the Play app-signing SHA-256 in `ANDROID_APP_CERT_SHA256`, and tag `v0.9.1` after promotion.

## 2026-10-27 Markie 0.9.1 stable (macOS and Windows)

- Kirby asked for stable the same day, so `release:promote -- --confirm-promote=0.9.1 --now` skipped the soak. It shipped the early build's exact bytes; `latest-mac.yml`, `latest.yml` and `latest.json` report 0.9.1.
- `release:verify:public --deep` passed on both platforms.
- Update from 0.9.0: Windows `windows-update-check.yml` run 40553536063 passed 12/12 with install and relaunch. Mac `update:check` passed 9/9.
- The Mac check fails with `bad option: --remote-debugging-port` if the shell exports `ELECTRON_RUN_AS_NODE`. Run it under `env -u ELECTRON_RUN_AS_NODE`.
- Tagged `v0.9.1` on 6451801, the release commit, and created the GitHub release.
- Mac `update:check -- --install` then passed 12/12: Restart & Update replaced the bundle with 0.9.1 and it relaunched on its own.

## 2026-10-27 Markie Cloud moved to ZVN's own boxes; 0.9.1 stable

- `markie-api` moved from Fly to the ZVN boxes on 2026-10-27: Kamal, `zvn-apps-a`, Cloudflare for SaaS in front of `api.markiedocs.com`.
- Deploy and rollback steps live in `ZVN-DEV/zvn-infra`, `docs/migrations/markie-api.md`. The Fly app is parked, not deleted, as the undo.
- After the move, the zvndev.com zone's Bot Blocker rule blocked every native iOS request (CFNetwork user agent), so Send code in the iPhone app failed. The rule now runs only on the marketing sites (zvn-infra PR #21).
- The Share dialog's public link was restyled to match the website (PR #42).
- Repo docs were cleaned of Railway, Fly, and the long-agent-loop machinery.
- 0.9.1 stable itself is recorded in the entry above.

## 2026-10-27 Markie 0.9.2 stable on macOS, Windows and Linux; new brand everywhere

- Kirby asked for the new brand and Linux to ship straight to stable with no nightly round. PR #51 set 0.9.2; release commit `ed94dec`.
- Brand ("L3 Underline", lowercase wordmark with a red underline): app icons, title bar and sign-in (PR #45), server pages and emails, iOS and Android icons, README (PR #47). markiedocs.com was redesigned in the instinct.com style with a dark mode toggle (markie-site PR #2, Vercel prod).
- Linux (PR #46): AppImage and .deb for x64 through `linux-release.yml` run 40588266051. Unsigned by design; evidence and SHA512SUMS on the `linux-built` tag. The manifest still lists Linux as `ready`; moving it to `public` needs the release tests rewritten off the live manifest first.
- Windows run 40588262569 signed by CN=ZVN DEV LLC. Mac arm64 and x64 notarized, stapled, Gatekeeper accepted.
- Published to early access on all three platforms, then `release:promote -- --confirm-promote=0.9.2 --now`. `release:verify:public --deep` passed on mac, win and linux. Tagged `v0.9.2`, GitHub release created.
- Server: image `zvn-apps/markie-api:ed94dece7bd3` deployed with Kamal to `zvn-apps-a`. The deploy needs `MARKIE_ENABLE_CRONS=true` (zvn-infra PR #26 documents it).
- The Mac prepare failed twice before passing. The agent shell's `ELECTRON_RUN_AS_NODE=1` reached the preflight launch, and the release lint scanned `.claude/worktrees`. Run prepare under `env -u ELECTRON_RUN_AS_NODE`; both folders are now ignored.
- Promotion hit one transient Backblaze 500 ("internal incident") on `windows/latest.yml`. It cleared within minutes and the retry promoted.
- Mobile: iOS 0.1.0 (2) with the new icons uploaded to App Store Connect from Xcode (PR #48). Android AAB 0.1.0 (2) at `~/Desktop/Markie-mobile-0.1.0-2.aab`.
- Still open: TestFlight internal group (Kirby in App Store Connect), Play internal testing (account verification), the Play app-signing SHA-256 in `ANDROID_APP_CERT_SHA256`, a hand check of the AppImage and .deb on a real Linux desktop, and the GitHub social preview image (Settings, no API).
