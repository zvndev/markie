# Current Task — F-012

## Selected feature
The primary desktop shell receives one native-feeling refinement pass for spacing, density, window chrome, and panel boundaries.

## Acceptance criteria
- Review the main app shell after light-mode fixes in both light and dark mode.
- Make a narrow layout polish pass on toolbar height/density, rail alignment, panel borders, and content spacing without changing navigation structure.
- Verify no text overlaps or clips at the minimum supported window size and at a normal desktop size.
- Run screenshot/visual verification plus `./init.sh`.

## Plan
- Inspect the current shell, toolbar, activity rail, panel, and editor layout classes.
- Make one focused CSS/component pass on shell density, boundaries, and content spacing only.
- Verify with rendered screenshots/computed layout evidence in built-in light and dark modes at normal and compact desktop sizes.
- Run the visual guard and full `./init.sh` before marking the feature complete.
