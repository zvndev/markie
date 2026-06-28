# Current Task — F-009

## Description
Light mode is legible in modal and popover surfaces: command palette, settings, theme settings, stats, share, agents, and comments.

## Acceptance Criteria
- Open each modal/popover surface in light and dark mode.
- Fix hardcoded dark backgrounds, invisible text, weak borders, and unreadable hover/focus states in those surfaces.
- Verify keyboard focus visibility and text contrast for each modal/popover.
- Run the focused visual/style verification plus `./init.sh`.

## Scope
This wakeup may touch overlay/modal/popover styles and their focused visual audit coverage only. Broader interaction redesign, editor content contrast, and layout polish stay in later ledger items.
