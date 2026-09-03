# Backlog — Markie

> Durable, prioritized queue beyond the feature ledger. Highest severity at top. Close items with
> evidence; do not delete history. Move completed items to Done with the verification record.

## Open
- [ ] The Windows release job's install/launch/uninstall step is not reliable. On the 0.5.3
      release the signed installer crashed under `/S` with `-1073741819` (0xC0000005, an
      access violation) on the GitHub runner; an unchanged re-run of the same job on the
      same commit passed and produced a good build. Nothing in the packaging config had
      changed since 0.5.2. Left as-is for 0.5.3 because a retry proved the artifact, but a
      release gate that fails at random teaches people to retry through real failures.
      Worth capturing the installer log on failure so the next occurrence can be diagnosed
      rather than re-run.
      type: release
      severity: medium
      acceptance_criteria: A failing Windows install step leaves enough evidence to tell a
        runner fault from a broken installer without re-running.
      source: 0.5.3 Windows release, run 33720230091
- [ ] Carry a document's attachments when it is shared: upload them to our own B2 Backblaze
      bucket and rewrite the links to point there, so a shared or published document is not
      full of holes where the pictures were. Today the share dialog counts the local files
      and says out loud that they will not travel (`localAssetCount` in `src/lib/attach.ts`,
      the note in `share-dialog.tsx`), which is the honest stopgap, not the answer.
      type: product
      severity: medium
      rationale: Kirby: "If it goes to cloud, then we will need to warn for now that it will
        not be transferred, but eventually we will upload to secure B2 Backblaze and link to
        it from there on. This may turn into a bit of a Google Drive / cloud doc thing at
        that point."
      acceptance_criteria: A document with a local picture, shared by link, shows that
        picture to somebody who opens it on another machine.
      source: attachments work 2026-09-02
- [ ] Pasting an image from the clipboard has nowhere to put it. Dropping a file links it
      where it already lives, which is the rule everywhere else, but a screenshot on the
      clipboard is not a file yet, so honouring that rule means writing one first (beside
      the document, or into a per-document folder). Needs a decision on where before it is
      built, because that choice is visible in every document it touches.
      type: product
      severity: medium
      acceptance_criteria: ⌘V with a screenshot on the clipboard puts the picture in the
        document and the markdown still opens in any other editor.
      source: attachments work 2026-09-02
- [ ] Wire the safe CDP window-checks (crash:check, disk:check, onboarding:check,
      panel-resize, overlay) into CI with `MARKIE_ALLOW_E2E=1` on a throwaway runner, now
      that they direct-kill and gate on consent. Was blocked on the Finder-crash risk.
      type: infra
      severity: medium
      source: e2e crash fix 2026-08-24
- [ ] Confirm the Windows update path on real hardware: a previous public Windows version
      finds, downloads, installs, and relaunches through Check for Updates. Everything else
      this item asked for is now in place: Authenticode signing runs in CI
      (`windows-release.yml`, Azure Trusted Signing), `windows-x64` is `public` in the
      manifest with the `windows/latest.yml` feed path, `update-policy.js` supports packaged
      win32 so `setupAutoUpdate` runs there, a locally packaged Windows build's
      `app-update.yml` points at the `windows` directory, and the release commands
      (`release:prepare:win`, `release:publish:win`, `release:verify:public:win`) exist and
      are written up under "Windows release runbook" in `docs/RELEASING.md`.
      type: release
      severity: high
      rationale: The last gate is the only one that cannot be met from this machine. It needs
        a published feed and a real PC, and it is a human release step by design.
      acceptance_criteria: A previous public Windows version updates itself through Check for
        Updates on real hardware.
      source: sprint 2026-08-23 (Windows audit); narrowed by 0.5.0 Windows updater work
- [ ] Server should force a resync (or replay) on a connection whose seed update it dropped.
      The seed lock drops a losing racer's first update; that client must currently reconnect
      before its edits land again.
      type: sync
      severity: medium
      acceptance_criteria: An editor whose update was dropped during seeding converges without
        a manual reconnect.
      source: sprint 2026-08-24 (Track 4 known caveat)
- [ ] Decide whether keyboard shortcuts should fire while a modal (conflict dialog, settings)
      is open. Today they do, and the new page.shortcuts tests document that as current
      behavior; if that is wrong, gate the handlers and flip the tests.
      type: product
      severity: low
      source: sprint 2026-08-24 (Track 5 finding, owner decision)
- [ ] `save-file-as` should decide the on-disk encoding after the dialog (accept
      `{ content, csvContent }` or return the path without writing) so the renderer's
      second write in `handleSaveAs` goes away; export handlers should return
      `{ canceled: true }` distinctly from errors.
      type: dx
      severity: low
      source: sprint 2026-08-23 (Track 3 follow-up)
- [ ] Put the CDP visual-check scripts in CI (consider a Playwright-for-Electron migration
      that dedupes the twelve hand-rolled bootstraps). The stale overlay assertion itself was
      fixed 2026-08-24 and the script runs to the end again.
      type: infra
      severity: medium
      source: sprint 2026-08-23 (Track 4 / coverage audit)
- [ ] Decide what a returning cold launch should open instead of the fake "Northstar Sprint Brief"
      sample (candidates: the last opened document, a blank buffer, or the Library).
      type: product
      severity: low
      rationale: first run now opens the real welcome doc, but a launch with no file on any later
        run still paints a fictional sprint brief the user never asked for. Left unchanged in the
        2026-08-19 onboarding pass to keep that diff to onboarding; note that
        scripts/light-mode-visual-audit.mjs and scripts/document-canvas-layout-check.mjs sample
        `.markdown-body th/td` and `pre`/`table` from whatever this launch paints, so a blank
        buffer would need those scripts updated first.
      acceptance_criteria: A cold launch with no file opens something the user chose or created,
        and both visual scripts still report zero findings.
      source: onboarding + auth pass 2026-08-19
- [ ] Approve or revise the context-aware terminal API shape before implementing bundled `markie`
      CLI commands or new MCP current-document tools.
      type: product
      severity: medium
      rationale: The upcoming terminal plan has a strong direction, but command/tool names are a
        public local API and are listed as a human checkpoint.
      acceptance_criteria: A human-approved ADR records the initial command/tool surface and the
        first implementable slice is split into `feature_list.json`.
      source: long-agent-loop initializer 2026-06-28

## Done
<!-- moved here with closing evidence -->

- [x] Surface owner comment-moderation in the UI (delete anybody's comment).
      type: product
      severity: low
      evidence: 2026-08-24 — threaded a `canModerate` prop from `page.tsx`
        (`canModerate={roleState === "owner"}`) through `rich-view.tsx` into `CommentLayer`.
        The delete gate at `comments.tsx` now shows Delete on any comment when the viewer
        owns the document, matching the server's existing owner-delete right. Test:
        "lets the document owner delete anyone's comment" (comments.test.tsx), plus the
        existing own-comment-only test still holds when `canModerate` is false.
- [x] Component tests for the page print/export handlers, plus the schemaVersion mismatch path.
      type: test
      severity: low
      evidence: 2026-08-24 — added `src/app/page.export.test.tsx` (8 tests) covering
        menu-export-pdf argument shape, the dark theme default, the in-flight guard refusing a
        second export then freeing up, cancelled-sheet-vs-error handling for both export and
        print, menu-export-html, and menu-print routing through `mode: "print"`. Extracted a
        pure `shouldWarnSchema(version, alreadyWarned)` helper in `collab.ts` (used by the
        rich-view meta observer) and covered the warn-once notice path in `collab.test.ts`.
- [x] Document and enforce the 3-step radius scale and audit remaining one-offs.
      type: design
      severity: low
      evidence: 2026-08-24 — `docs/design/radius-scale.md` records the 6/8/12px scale (cards
        `rounded-md`, popovers `rounded-lg`, modals `rounded-xl`). Audit found two one-offs,
        both fixed: `terminal-panel.tsx` dropdown menu (`rounded-md` → `rounded-lg`, it is a
        popover) and `update-toast.tsx` (`rounded-xl` → `rounded-lg`, it is a popover, not a
        modal).
- [x] Update the light-mode visual audit's injected settings mock to the sectioned Settings modal.
      type: infra
      severity: low
      evidence: 2026-08-24 — `scripts/light-mode-visual-audit.mjs` settings mock rewritten to the
        tabbed Account/Appearance/Advanced layout so its contrast samples track the real surface.
- [x] Bump GitHub Actions to non-deprecated majors in windows-launch-smoke.yml.
      type: infra
      severity: low
      evidence: 2026-08-24 — `checkout`, `setup-node`, and `upload-artifact` bumped to v5 in
        `windows-launch-smoke.yml` (and `ci.yml`); the release preflight's required-snippet
        assertion was updated to `actions/upload-artifact@v5` to match.

- [x] Stop the e2e window-check scripts from killing Finder (second incident).
      type: infra
      severity: high
      evidence: 2026-08-24 — root-caused to `process.kill(-child.pid)` group kills on
        `detached: true` Electron launches; on macOS the app re-launches via LaunchServices
        and the recycled launcher pid's group hit session services (uiagent, cli-llm-bridge),
        taking Finder down. Added `scripts/lib/safe-kill.mjs` (direct-child kill only) and
        converted crash-check, desktop-launch-smoke, onboarding-check, disk-change-check,
        ui-check; removed `detached`. Added `scripts/lib/e2e-consent.mjs` — every
        window-launching check refuses to boot without `MARKIE_ALLOW_E2E=1` (import-safe,
        CI sets it). The three ported checks now isolate `$HOME` to a temp dir. Verified:
        the gate exits 2 on direct run, safeKill never issues a negative-pid kill, importing
        a guarded script does not exit, full suites green.

- [x] Seed a collab room safely when the backing doc has content (was: seed from
      `docs.content` server-side).
      type: sync
      severity: medium
      evidence: 2026-08-24 sprint shipped a server-side seed lock instead of server-side
        seeding: `server/src/collab.ts` elects the first editor connection as the sole seeder
        of an empty room backed by a non-empty doc and drops other editors' updates until the
        first update persists, with hand-off on disconnect. Client (`rich-view.tsx`) waits for
        the first sync plus 150 ms and re-checks the fragment before seeding, and writes
        `schemaVersion` into the ydoc meta map. Server tests cover two-editor race, seeder
        hand-off, viewer never seeds, non-empty room unaffected. Note: an incompatible schema
        logs a console warning rather than refusing to bind (softened from the original
        acceptance criteria); the dropped-update force-resync follow-up is a new Open item.
- [x] Inline local images in PDF/HTML export and route ⌘P through the PDF pipeline.
      type: export
      severity: medium
      evidence: 2026-08-24 sprint added `electron/inline-images.js` (data-URI rewrite, docDir
        containment incl. symlink/`..` escapes, 10 MB per image / 30 MB total, 23 tests) wired
        into `export-pdf.js` and the `export-html` handler; `export-pdf.js` gained
        `mode: "print"` (hidden window, readiness wait, `webContents.print()` with the system
        dialog, cancel on dismiss, same busy guard); `page.tsx` handlePrint routes ⌘P through
        it with `window.print()` as the non-Electron fallback. 28 export-pdf tests pass.
- [x] Component tests for the files edited in the 2026-08-23 sprint.
      type: test
      severity: medium
      evidence: 2026-08-24 sprint added conflict-dialog, shared-view, library (all 8 item
        states plus exists:false), browse-view truncated notice, and page save / conflict /
        menu / shortcuts / drop test files (87 new tests; vitest 1025 across 86 files).
        page print/export handler tests were deliberately skipped because Track 3 was editing
        those handlers; new Open item tracks them.

- [x] Replace packaged CSP inline-script allowance.
      type: security
      severity: low
      rationale: Packaged Electron CSP included `script-src 'self' 'unsafe-inline'`, reducing CSP
        value if a renderer XSS path is introduced later.
      acceptance_criteria: Inline bootstrap requirements are replaced with hashes/nonces where
        practical, or the exact required inline script is documented and constrained with a hash.
      source: product-review security pass 2026-07-03
      evidence: 2026-07-05 pass added `electron/csp.js` and `electron/csp.test.ts`; packaged app
        CSP now hashes the exact inline Next static-export bootstrap scripts from built `out/*.html`
        files and emits `script-src 'self' <sha256...>` without broad script `unsafe-inline`.
        `npm test -- electron/csp.test.ts electron/release-preflight.test.ts` passed, and
        `release:preflight` requires the CSP helper/main-process wiring.
- [x] Harden privileged Electron file IPC with main-owned file grants.
      type: security
      severity: medium
      rationale: `open-file-path`, `save-file`, and `rename-file` trusted renderer-supplied paths.
        A compromised renderer could read/write/rename arbitrary local files unless main owned a
        grant list from dialogs, dropped files, and workspace roots.
      acceptance_criteria: Main process validates open/save/rename paths against user-granted
        paths or workspace roots, rejects unsafe names/extensions, and focused regressions prove
        ungranted paths are refused.
      source: product-review security pass 2026-07-03
      evidence: 2026-07-04 pass added `electron/file-grants.js` and
        `electron/file-grants.test.ts`; `npm test -- electron/file-grants.test.ts` passed 7 grant
        tests; `npm test` passed 15 files / 94 tests; `./init.sh` passed renderer/Electron tests,
        MCP tests, server tests, lint, and build; `npm run visual:guard:theme` passed with zero
        findings and wrote `.autoloop/runs/light-mode-audit-20260704165637/audit.json`.
- [x] Add a release/deploy smoke checklist that can run without production credentials.
      type: dx
      severity: medium
      rationale: Existing release and cloud deployment steps are credential-gated; the unattended
        loop needs a safe preflight that stops before publishing.
      acceptance_criteria: A documented command verifies packaging prerequisites and server config
        shape without signing, notarizing, uploading, or touching production.
      source: long-agent-loop initializer 2026-06-28
      evidence: `npm run release:preflight > .autoloop/runs/release-preflight-20260628-035123.log 2>&1`
        passed and stopped before any signing, notarization, upload, publish, deploy, or
        credentialed network action; `./init.sh > .autoloop/runs/init-20260628-035139-post-f003.log 2>&1`
        passed.
