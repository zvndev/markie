# Current Task - Cross-platform launch intent hardening

## Task
Make Windows/mac desktop launch behavior more defensible by extracting and testing OS launch
intent parsing and by fixing the local Windows package path that was trying to cross-rebuild
native modules from source on macOS.

## Acceptance Criteria
1. Windows/Linux argv handoff for Markie deep links and openable files is covered by side-effect-free tests.
2. macOS-only default Markdown registration has explicit unsupported fallback coverage for Windows/Linux.
3. `electron/main.js` uses the shared desktop intent helper for cold-start and second-instance launch inputs.
4. `electron:pack:win` succeeds locally without native source cross-compilation and `electron:smoke:win` passes.
5. Fresh mac packaged launch smoke and full local release preflight pass.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
