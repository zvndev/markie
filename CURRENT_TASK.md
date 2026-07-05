# Current Task - Windows workflow evidence trigger

## Task
Make the Windows launch-smoke workflow run automatically when release-relevant changes reach `main`,
while keeping manual dispatch and PR coverage.

## Acceptance Criteria
1. `.github/workflows/windows-launch-smoke.yml` supports `workflow_dispatch`, `pull_request`, and
   `push` on `main`.
2. The push and PR triggers watch the release-relevant desktop paths.
3. `release:preflight` validates the workflow trigger and command shape.
4. Focused release-preflight tests pass.
5. Lint/build or full boot smoke passes after the workflow guard change.

## Scope Guard
Do not push, publish, deploy, run external CI, sign/notarize artifacts, change release credentials,
or alter the unrelated pre-existing `electron/main.js` updater/menu diff.
