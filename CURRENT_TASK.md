# Current task - Markie

## F-007 - Top chrome light-mode legibility

Description: Light mode is legible in the top toolbar, mode switcher, PDF/export menu, file controls, and activity/header chrome.

Acceptance steps:
1. Use the light-mode audit evidence from F-006 to identify toolbar/header/menu contrast failures.
2. Replace hardcoded dark styles and weak token combinations with theme-aware colors for that surface only.
3. Verify toolbar controls, hover/active states, dropdown text, dividers, and disabled/secondary text are visible in light and dark mode.
4. Run the focused style check or screenshot comparison plus `./init.sh`.

Scope notes:
- One wakeup scope: top chrome only.
- Do not redesign the whole layout in this task.
- Keep content/editor contrast fixes reserved for F-010.
