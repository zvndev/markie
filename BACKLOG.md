# Backlog — Markie

> Durable, prioritized queue beyond the feature ledger. Highest severity at top. Close items with
> evidence; do not delete history. Move completed items to Done with the verification record.

## Open
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
- [ ] Document and enforce the 3-step radius scale (6/8/12px: cards `rounded-md`, popovers
      `rounded-lg`, modals `rounded-xl`) and audit remaining one-offs.
      type: design
      severity: low
      rationale: 2026-07-06 design review found radius one-offs (close buttons, mixed panel radii)
        that read as seams between surfaces; the scale exists implicitly but is not documented.
      acceptance_criteria: A short design-tokens note records the radius scale, and no interactive
        surface uses a radius outside it.
      source: product-designer design review 2026-07-06
- [ ] Update the light-mode visual audit's injected settings mock to match the sectioned Settings
      modal (Account/Appearance/Advanced), so its contrast samples track the real surface.
      type: infra
      severity: low
      rationale: scripts/light-mode-visual-audit.mjs injects a hardcoded HTML replica of the old
        auth-only Settings dialog (~line 470); after the 2026-07-06 Settings rebuild the mock
        samples copy/structure that no longer exists in the app.
      acceptance_criteria: The audit's settings sample reflects the tabbed Settings layout and the
        guard still reports zero findings.
      source: design-polish verification 2026-07-06
- [ ] Bump GitHub Actions to non-deprecated majors (checkout/setup-node/upload-artifact) in
      windows-launch-smoke.yml.
      type: infra
      severity: low
      rationale: Runners annotate Node 20-targeting action versions as deprecated and force Node 24.
      acceptance_criteria: Workflow runs clean with current action majors and no deprecation
        annotations.
      source: Windows launch smoke run 28813065520, 2026-07-06
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
