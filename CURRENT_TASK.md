# Current Task - Theme control consistency

## Task
Make theming behave consistently across toolbar buttons, command-palette built-in theme commands,
stored color mode, CSS variables, and the visible Library/editor surfaces.

## Acceptance Criteria
1. Applying built-in light/dark themes through non-toolbar paths updates the same color-mode state
   as the toolbar buttons.
2. Toolbar active state follows color-mode changes triggered elsewhere in the renderer.
3. Light and dark CSS variables remain readable across editor, Library, and overlay surfaces.
4. The live Electron app visibly switches into light mode and shows the default Library workspace.
5. Focused theme tests, visual guard, build/lint, and full local release preflight pass.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
