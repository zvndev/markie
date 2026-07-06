# Current Task - Platform-scoped desktop update checks

## Task
Make packaged desktop update behavior defensible across macOS, Windows, and Linux by extracting and
testing the update-feed policy and keeping non-macOS local packages away from the macOS production
feed.

## Acceptance Criteria
1. Packaged macOS remains the only platform that can set up `electron-updater`.
2. Packaged Windows/Linux manual update checks return an explicit unsupported-platform message.
3. `electron/main.js` delegates update support decisions to a side-effect-free helper.
4. Release preflight requires the update policy helper, main-process wiring, and runtime docs.
5. Focused update-policy tests and full local release preflight pass.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
