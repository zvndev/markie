# Current Task — F-002

## Selected item
When the active document changes, future embedded terminal sessions receive updated Markie context instead of stale document paths.

## Acceptance criteria
- Open document A, then open document B in the same Markie session.
- Create a new embedded terminal session after document B becomes active.
- Confirm `MARKIE_FILE` and `MARKIE_DIR` point at document B, not document A.
- Run the focused terminal regression test plus `./init.sh`.

## Plan
- Inspect the existing terminal context bridge from renderer to Electron.
- Add a focused regression proving the stored terminal context can be updated from document A to document B before opening a new shell.
- Patch only the context update path if the regression exposes stale state.
- Verify with the focused terminal test and full `./init.sh`.
