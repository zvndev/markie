# Current Task - F-008

## Feature
F-008: Light mode is legible in side-panel surfaces: Library, Browse, Skills/Agents, Shared, and file lists.

## Acceptance Criteria
1. Inspect side-panel surfaces in light and dark mode using the established audit harness.
2. Fix invisible links, badges, rows, empty states, buttons, and selected/hover states in the side panels.
3. Verify side panels remain readable at narrow and normal desktop widths.
4. Run the focused visual/style verification plus `./init.sh`.

## Scope
Side panels only. Do not touch modal/popover surfaces, editor content styles, platform packaging, terminal API shape, production/deploy credentials, or any human-checkpoint API/design decisions.

## Plan
- Locate the side-panel components and existing visual audit probes.
- Use the current audit/screenshots or computed contrast evidence to identify weak side-panel token pairs.
- Replace hardcoded/weak side-panel colors with existing theme tokens where needed.
- Add focused regression coverage if the contrast behavior is testable without broad UI changes.
- Verify with visual audit/computed-style checks for light and dark mode where practical, then run `./init.sh`.
