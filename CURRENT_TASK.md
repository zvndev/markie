# Current task — F-001

## Task
When Markie's embedded terminal is enabled, a new shell starts in the current document folder and exposes `MARKIE_FILE`, `MARKIE_DIR`, and `MARKIE_WORKSPACE` for the active document.

## Acceptance criteria
1. Open a markdown file in Markie with the terminal feature enabled in a development run.
2. Create a new embedded terminal session.
3. Run `pwd` and confirm it starts in the active document's folder.
4. Run `printf '%s\n' "$MARKIE_FILE" "$MARKIE_DIR" "$MARKIE_WORKSPACE"` and confirm the values match the active document and workspace.
5. Run the focused terminal regression test plus `./init.sh`.

## Scope guard
Keep this to env/cwd injection only. Do not expose the hidden terminal UI or define new CLI/MCP API in this task.

## Plan
- Inspect the Electron terminal session creation path and renderer payload for active document context.
- Add the smallest context payload needed for new sessions.
- Add or update a focused regression test proving cwd and environment injection.
- Verify the focused test, then run the full `./init.sh` baseline.
