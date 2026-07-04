# Current Task - Cross-platform external terminal runtime fallback

## Task
Complete one `F-016` runtime-platform slice by replacing the remaining macOS-only external terminal
launcher behavior with platform-aware candidates for macOS, Windows, and Linux, while preserving the
renderer-supplied app-name guard.

## Acceptance Criteria
1. `electron/terminal.js` no longer returns no external terminal apps or `"macOS only"` just because
   the host is Windows or Linux.
2. Windows exposes safe built-in terminal choices (`PowerShell`, `Command Prompt`) and detected
   Windows Terminal, and opens them in the requested Markie folder without shell-string execution.
3. Linux exposes `$TERMINAL` plus detected common terminal emulators and opens them in the requested
   folder without accepting arbitrary renderer-supplied commands.
4. Focused terminal tests cover macOS, Windows, Linux, unknown renderer-supplied app names,
   availability checks, and neutral terminal UI labels.
5. The hidden terminal renderer surface stops hardcoding `zsh` as the tab label, while preserving
   existing feature-flagged behavior.

## Scope Guard
Do not expose the terminal feature flag, add public APIs, add dependencies, or change terminal
product scope. Keep this to the existing hidden terminal surface and local runtime helpers. Preserve
unrelated local edits, including the pre-existing `electron/main.js` updater/menu diff.
