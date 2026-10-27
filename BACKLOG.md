# Backlog — Markie

> Open work is tracked in Circular (gocircular.dev). This file is a scratch list of scoped items
> waiting to be filed or decided. Remove an item when it is done; git history keeps the record.

## Open
- [ ] Every `/api/*` POST and PUT outside the agent routes reads an unauthenticated chunked body
      before auth runs. The body limit in server/src/index.ts sits in front of the routes, and
      Hono's bodyLimit buffers a body with no Content-Length in full before it can refuse it, so
      a caller with no session can make the server read 2 MB per request in general and 101 MB
      on `PUT /api/docs/:id`. `/api/agent/*` and `POST /mcp` already check the token first.
      type: security
      severity: medium
      acceptance_criteria: A POST or PUT under `/api/*` without a valid session (or the route's
        own auth) is answered from its headers before any body byte is read, with a test that
        sends a chunked body with no Content-Length and sees 401 without the body being consumed.
      source: PR #26 review round 2
- [ ] A Darkmown (.wd) document with a public link renders at `/s/:token` through the markdown
      pipeline, while `/d/:id` shows it as escaped source under the "interactive in the Markie
      app" note (`renderDarkmownSource`, server/src/render.ts). Both are sanitized and run no
      script, so this is consistency, not safety: the public page shows directive syntax as
      text mixed into rendered markdown. `/s/:token/raw` already downloads it as `.wd`.
      type: product
      severity: low
      acceptance_criteria: `/s/:token` for a darkmown document shows the same static view as
        `/d/:id`, with a test.
      source: PR #26 review round 1
- [ ] The storage quota (MARKIE_STORAGE_QUOTA_BYTES) does not count version history
      (doc_history, dp_history) or the live-collaboration update log (doc_updates). Both are
      bounded today, but a billing plan needs a decision on whether they are charged.
      type: product
      severity: low
      acceptance_criteria: Usage accounting states, and tests, what each stored table counts.
      source: self-hosting kit, server/src/quota.ts
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
      acceptance_criteria: A human-approved decision record in `docs/decisions/` sets the initial
        command/tool surface, and the first implementable slice is filed in Circular.
      source: long-agent-loop initializer 2026-06-28
- [ ] Private builds do not ship the MCP server. `createPrivateBuilderConfig`
      (scripts/private-release.mjs) sets `extraResources: []`, so `Contents/Resources/mcp/` is
      missing from super-nightlies and the Agents dialog shows a path that does not exist. Ship
      `mcp/` in private builds (the bundle scan must allow it), or point the dialog at the repo
      copy in private builds.
      type: release
      severity: low
      source: agent cloud links testing 2026-10-21
