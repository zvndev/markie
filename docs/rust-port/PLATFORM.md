# Markie RS: platform pieces

Date: 2026-11-22. Branch: `t3/markie-rs-platform-parity`, merged into `rust/markie-rs` by the parent.

This covers PARITY.md sections 20 (deep links, default apps and OS integration), 22 (the vault), 27 (crash reporting and logs) and 31 (miscellany), plus single-instance behaviour and the window's size and position.

Section 26, auto-update, is out of scope by design. The side build has no updater, feed or release pipeline. Section 25, the terminal, is hidden in Electron and skipped here.

## Where the code is

| File | What it does |
|---|---|
| `markie-app/src/deeplinks.rs` | `markie-rs://open` and `markie-rs://doc`: routing, share plans, the raw fetch, landing in Downloads |
| `markie-app/src/open_urls.rs` | `deep_links()` hands every `markie-rs://` link except `auth` to `deeplinks.rs` |
| `markie-app/src/instance.rs` | One instance per data folder, second-launch hand-over |
| `markie-app/src/logs.rs` | Crash log, consent, Sentry envelope, panic hook, Reveal Crash Log |
| `markie-app/src/default_apps.rs` | Settings, Files: "Open with Markie", with nothing claimable |
| `markie-app/src/workspace/vault.rs` | The vault page and `Workspace::open_vault` |
| `markie-core/src/links.rs` | What a click on a link inside a document may do |
| `scripts/bundle-mac.sh` | Registers the `markie-rs` URL scheme, and nothing else |

Small hooks in files other agents own:

- `main.rs`: panic hook, single-instance claim, launch links in argv, the Help menu, View, Vault, and min window size 600 by 400.
- `workspace.rs`: the `vault` field, `sync_vault` at the top of `render`, one `on_action`, and `open_external` leaving the vault first.
- `workspace/rail.rs`: `select_view` is `pub(super)`, and `render_workspace_page` returns the vault page for the Vault view.
- `Cargo.toml` of markie-app: markie-vault, reqwest, getrandom, regex, zeroize, dirs, and tokio's `rt` and `time` features.
- `workspace/settings.rs`: two `.child` lines for the default apps section and Error reporting.

## Section 20: deep links, default apps and OS integration

| Item | Status | Notes | Tests |
|---|---|---|---|
| `auth?token&state` sign-in return | Routed, not handled here | `deep_links()` leaves `markie-rs://auth` for the cloud sign-in code. `deeplinks::is_auth` is the same check as `isAuthDeepLink`. | `open_urls::tests`, `deeplinks::tests::classifies_like_electron_on_our_scheme` |
| `open?token&src` public link | Matches | Same plan as `planShareOpen`: trusted server fetched, untrusted public https host asked natively ("Open a document from host?"), anything else falls back to Markie Cloud. Fetch is `GET /s/<token>/raw`, 120 s, 100 MB cap. Lands in Downloads under the disposition name, collision-safe, then opens. | `share_plans`, `landing_names`, `fetches_a_public_link_without_following_redirects` |
| `doc?id&src` shared document | Matches, untested live | Fetched with Markie RS's own session from Keychain service "Markie RS", lands in Downloads under its cloud name, opens. Not signed in shows "Sign in to open this document". A failed pull shows Electron's wording. | `doc_links_carry_only_an_id` |
| Failure dialogs | Matches | "Couldn't open that link", "Couldn't open the shared document". Failures go to the crash log as `deep-link-shared-failed` and `deep-link-cloud-doc-failed`. | |
| Single instance, second-instance argv | Matches | A Unix socket per data folder. A second launch hands over its files (made absolute) and links, then exits. With nothing to open it raises the window. A stale socket from a crash is taken over. | `instance::tests` |
| macOS `open-file` and `open-url` | Matches | Files were already handled. Links now go through `deeplinks::deliver`. | |
| Launch links in argv | Matches | A `markie-rs://` link in argv is delivered after the window opens. | |
| Default apps (Settings, Files) | Differs on purpose | Same six formats, same order, notes and layout. It shows which format the shipping Markie owns. Every "Use Markie RS" button is disabled, with the reason in place: Markie RS is a side build and claims no file types. | `default_apps::tests` (incl. "Markie RS owns nothing on this Mac") |
| URL scheme registration | Matches | The bundle registers `markie-rs` only. No `markie`, no document types. | |
| Hidden-inset title bar, traffic lights at (14, 14) | Window shell's | Not changed here. | |
| Linux `.desktop` integration | Not built | Needs a `.desktop` file with `x-scheme-handler/markie-rs` and `xdg-mime default`. | |
| Links inside documents | Policy built, not wired | `markie_core::links::classify_click` ports `local-open-policy.js` and `externalWebTarget`: web links to the browser, passive files open, scripts and apps are revealed, other schemes ignored. It is narrower than Electron: only files inside the document's folder, not workspace grants. **The rich editor's Cmd-click still calls `cx.open_url(href)` for any href.** The editor behaviour agent should call `classify_click` there. | `links::tests` |
| IPC `set-default-md`, `default-apps-status` and so on | Not applicable | No IPC in a native app; the calls are direct. | |

## Section 22: vault

The page is `VaultPage` in `workspace/vault.rs`. It fills the document area when the window shell's Vault rail view is open, in place of the shell's placeholder. `Workspace::open_vault` opens that view; View, Vault toggles it. Leaving the view locks the vault unless edits are unsaved; then they stay and the idle lock still applies. Electron asks instead, because its rail can wait for an answer.

The vault is `vault.json` in Markie RS's data folder (`FileVaultStorage`). The Touch ID secret is a Keychain generic password under service "Markie RS Vault". Nothing reads Electron's IndexedDB vault or its "Markie Safe Storage" item.

| Item | Status | Notes | Tests |
|---|---|---|---|
| Create a passphrase vault, 16+ code points | Matches | Passphrase and confirm, strength meter with label and bits, "Create encrypted vault". Errors use `failureCopy`'s words. | `create_save_lock_unlock_backup_restore`, `failure_copy_matches_electron` |
| Wordlist generator | Matches | "Suggest a passphrase" fills both fields with six words and shows them with Copy. Copy goes through the secret clipboard. | markie-vault passphrase tests |
| Unlock by passphrase | Matches | Off the UI thread ("Working locally…"). A failed unlock relocks. | same |
| Unlock with Touch ID | Matches, needs Kirby | "Unlock with Touch ID" shows only when the Mac can prompt, the Keychain secret exists and the vault has a device slot. Cancel and missing or stale secret behave as in Electron. | flow test with Touch ID doubles |
| Turn Touch ID on and off | Matches | Settings, Touch ID: confirm with passphrase, then the sheet. The one-time offer after a passphrase unlock, with "Not now" remembered in `vault-touch-id-offer`. | |
| Confirm open, reveal and copy with Touch ID | Matches | Every open of a non-env item, every reveal and copy asks for a fresh check naming the item. When the sensor cannot be used, a passphrase check stands in. | |
| Lock, idle lock, checkpoint | Matches | "Lock vault" asks first when edits are unsaved. Five minutes idle locks, after a checkpoint save of at most two seconds, with Electron's four messages. Leaving the page locks. | |
| Lock when the page is hidden | Differs | Electron locks on `visibilitychange`. GPUI has no "hidden" signal here; minimize does not lock yet. Idle lock still applies. | |
| Encrypted documents | Matches | New private note, import encrypted copy (8 MiB cap), filter by name, groups "Environment keys" and "Files", sizes and recovery marks, rename with type check, save, delete, Cmd-S. | `filenames_keep_their_type` |
| Download unencrypted copy | Differs in wording | A save panel instead of a browser download, so the button reads "Save unencrypted copy…". Same confirm first. | |
| `.env` editor | Matches mostly | Keys and Raw views, key count, Reveal all and Hide all, Copy as .env, per-row Show, Copy, ×, Add key, key problems, duplicate warning, parked `# KEY=value` comments masked, malformed lines kept, 60 s re-mask, Raw asks before revealing. A multi-line value shows as text when revealed and is edited in Raw, where Electron offers a textarea in the row. | `parked_keys_are_masked`, `key_problems`, markie-vault dotenv tests |
| DOCX inside the vault | Differs | Electron edits DOCX runs in place. Markie RS keeps a DOCX opaque: stored, renamed, exported, not edited. | |
| Secret clipboard, cleared after 30 s | Matches | `SecretClipboard` with the macOS pasteboard, concealed type set, cleared only if it still holds the secret. Lock clears it at once. | markie-vault clipboard tests |
| Back up and restore | Matches | "Back up vault…" saves `Markie Vault.markievault` through a save panel. "Restore from backup…" checks the file, asks for its passphrase, asks before replacing, deletes the replaced vault's Keychain secret. | flow test |
| Persisted-storage warning | Not applicable | It is about browsers evicting IndexedDB. A file in the data folder is not evicted. | |
| Data migration out of IndexedDB | Deferred | Kirby deferred it to the real switchover. `markie-migrate` can already read it. | |

## Section 27: crash reporting and logs

| Item | Status | Notes | Tests |
|---|---|---|---|
| `markie-crash.log` | Matches | In Markie RS's data folder. Same line format, 1 MB with one rotated generation `markie-crash.log.1`. | `entry_format_matches_electron`, `log_rotates_one_generation` |
| Uncaught errors logged | Matches in kind | A panic hook logs `panic` with the message, location and backtrace, then runs the default hook. Rust has no `unhandledRejection` or `child-process-gone`. | |
| Reveal Crash Log (Help menu) | Matches | "Reveal Crash Log in Finder" on macOS, Explorer and plain labels elsewhere. With no log yet it shows "No crashes have been recorded yet." | |
| Opt-in error reporting | Matches | `crash-reporting.json`, fails closed. The DSN comes from `MARKIE_SENTRY_DSN` or a committed empty constant, so a stock build is inert and the setting is hidden, exactly as in Electron. With a DSN set, Settings shows "Send crash reports" and "Show the crash log". | `consent_fails_closed`, `dsn_rules` |
| Sentry envelope POST and scrubbing | Matches | Same three-line envelope, auth header, `scrubText` rules (paths to basenames, home and user name to `~`, app and web URLs kept). Frames read V8 and Rust backtraces. Event `platform` is `native` rather than `javascript`. | `scrub_matches_the_javascript`, `frames_from_v8_and_rust`, `envelope_shape_and_scrubbing` |
| Native crash dumps (`crashReporter`, no upload) | Not built | macOS already writes `.ips` reports to `~/Library/Logs/DiagnosticReports` for a crashed Markie RS. | |
| Error boundary keeps the app usable | Not applicable | There is no renderer. A panic in GPUI ends the process after it is logged. | |
| `stdio-guard` | Not built | Rust ignores SIGPIPE, and `log_crash` writes stderr inside `catch_unwind`, so a closed stderr cannot turn logging into a crash. Other `eprintln!` calls in the app could still panic on a closed stderr. | |

## Section 31: miscellany

| Item | Status | Notes |
|---|---|---|
| Private release gate | Not applicable | Markie RS has no private or preview builds. |
| First run welcome document | Not built | No welcome document yet. Electron skips it when the OS handed over a file. Owner: window shell or local features. |
| Media: `![](clip.mp4)` as a video player | Not mine | `markie-editor/src/media.rs` exists; the editor agents own it. |
| Dropped attachments linked, never copied | Not mine | Editor behaviour. |
| Asset cache under `asset-cache` | Not built | Belongs with cloud sync. |
| CSP for YouTube and Vimeo frames | Not applicable yet | No web content runs. When `markie-web` hosts embeds, its frame allowlist must be the same two origins. |
| Origin allowlist for any request with a token | Matches | Deep-link fetches go through `markie_cloud::origin::Trust`. The session is sent only through `CloudClient`, which refuses untrusted origins. |
| Native dialogs for an untrusted share host | Matches | `window.prompt`, an NSAlert, so nothing in a document can answer it. |
| Links never launch scripts or apps | Policy built, not wired | See "Links inside documents" above. |

## Window size and position

Electron opens every window at 1280 by 820, centered, minimum 600 by 400, and does not remember its size or position. Markie RS now does the same: the minimum went from 640 by 420 to 600 by 400. Remembering the frame would be a difference, so it is not built.

## Windows and Linux

Everything compiles behind cfg gates. What a build there still needs:

- Single instance: a named pipe on Windows. Today every launch there is the first.
- Deep links: register `markie-rs` in the registry on Windows and in a `.desktop` file on Linux. Links in argv are already handled.
- Touch ID: Windows Hello and a Linux keyring prompt. `NoBiometric` keeps device unlock off.
- Secret clipboard: a concealed writer per platform. Today a copy goes nowhere on those platforms rather than into clipboard history.
- Default apps: read `UserChoice` and `xdg-mime query default`. Today the section says default apps are a macOS feature.
- Crash log reveal uses Explorer and `xdg-open`; untested.

## Manual check for Kirby

Touch ID: open Markie RS, View, Vault, create a vault, accept "Use Touch ID…", confirm with the passphrase and your finger, lock, then "Unlock with Touch ID" should open it.

## Evidence

`.autoloop/runs/platform/NOTES.md` in this worktree, with the scratch data folders `platform/`, `platform-dbg/` and `platform-rel2/`.

- No screenshots. During this run the display was asleep and Kirby's Markie was frontmost, so `capture.sh` could not create an image and `act.sh` refused to focus. The vault page has not been seen on screen yet; it needs a capture pass against `vault-panel.tsx`.
- Single instance, checked on the release bundle and the debug build with a scratch HOME and data folder: a second launch with a file exits at once and the running instance opens it.
- Once, on the first release run, the running instance's main thread sat in `open()` and nothing opened. It did not happen again on a fresh data folder. Cause unknown; worth watching.

Tests: `cargo test --workspace`, 698 passed, 0 failed, after merging `rust/markie-rs` at 21f5aae.
