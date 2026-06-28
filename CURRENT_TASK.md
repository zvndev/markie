# Current Task — F-015

## Task
A cross-platform desktop audit maps macOS-only assumptions and creates a safe implementation
checklist for Windows, Intel Mac, and Linux support.

## Acceptance Criteria
1. Search Electron, renderer, MCP, release, and docs code for macOS-only assumptions and
   Apple-Silicon-only release assumptions.
2. Classify each finding as runtime behavior, packaging config, docs/download page, test/preflight,
   or human-gated release/deploy work.
3. Add the resulting checklist to the roadmap docs or backlog without changing runtime behavior.
4. Run `./init.sh`.

## Scope Guard
Audit and checklist only. Do not change runtime behavior, publish, deploy, notarize, upload,
or use release credentials.
