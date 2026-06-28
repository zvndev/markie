# Backlog — Markie

> Durable, prioritized queue beyond the feature ledger. Highest severity at top. Close items with
> evidence; do not delete history. Move completed items to Done with the verification record.

## Open
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
