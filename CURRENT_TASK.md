# Current Task - Desktop update menu support

## Task
Make desktop update checks user-visible from the app menu while keeping local/dev builds honest and
packaged production menus clean.

## Acceptance Criteria
1. Manual update checks route through the same update state machine as automatic checks.
2. Dev and unpackaged builds explain that updates require a packaged release build.
3. A downloaded update can be installed from the manual update prompt.
4. Packaged production menus do not expose DevTools.
5. Release preflight validates the Electron desktop-support contract and passes locally.

## Scope Guard
Do not push, publish, deploy, run external CI, sign/notarize artifacts, change release credentials,
or run production update feeds.
