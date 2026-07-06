# Current Task - Visual launch smoke evidence

## Task
Make packaged desktop launch evidence human-reviewable by preserving a screenshot beside the JSON
probe whenever a host-compatible packaged app launch smoke runs.

## Acceptance Criteria
1. mac packaged launch smoke writes `launch-smoke.json` and `screenshot.png`.
2. Windows packaged launch smoke writes the same screenshot evidence on a Windows host.
3. The Windows workflow uploads both JSON and screenshot evidence.
4. Release preflight enforces the screenshot evidence path in docs and workflow checks.
5. Focused launch-smoke tests and full local release preflight pass.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
