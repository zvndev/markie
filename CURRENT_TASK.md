# Current Task - Desktop Release Hardening

## Task
Finish the Windows x64 app and repair the desktop interaction regressions that block normal file
creation, navigation, menu dismissal, and window movement.

## Acceptance Criteria
1. Creating a file in the workspace opens it immediately in the editor.
2. Opening or creating a document exits stale panels and overlays so the document is visible.
3. Action and export menus dismiss on Escape, outside click, and navigation changes.
4. macOS and Windows paths resolve their parent folders and base names correctly.
5. The toolbar exposes a broad native drag surface without making controls unclickable.
6. Full local release preflight and Windows x64 package smoke pass.
7. A native Windows launch is confirmed on the final pushed commit.

## Scope Guard
Do not publish Windows artifacts publicly, enable Windows auto-update feeds, or add Windows code
signing without an explicit release decision.
