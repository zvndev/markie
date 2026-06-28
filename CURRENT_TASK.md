# Current Task — F-004

## Description
The MCP server has a regression journey proving allowed markdown writes remain fenced to safe local markdown paths.

## Acceptance Criteria
1. Run the MCP test suite and identify the current filesystem guard coverage.
2. Add a user-observable MCP write/read regression that writes an allowed markdown file under a temporary safe home and reads it back.
3. Confirm symlink escape and unsafe extension cases still fail.
4. Run `node --test mcp/lib.test.mjs` and `./init.sh`.

## Scope
- Modify only the MCP regression coverage needed for this task unless a narrow implementation bug is exposed.
- Do not widen the MCP public API shape.
- Do not touch production, deployment, credentials, or external service configuration.

## Plan
1. Inspect `mcp/lib.test.mjs` and MCP filesystem guard helpers.
2. Add the smallest regression that exercises the existing write and read tool path against a temporary safe home.
3. Run the focused MCP suite, then the repo baseline.
