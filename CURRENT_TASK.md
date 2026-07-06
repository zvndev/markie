# Current Task - Packaged mac launch evidence

## Task
Make mac desktop readiness more defensible by proving the current unsigned Apple Silicon package
can be launched and inspected as a real packaged Electron app, not only as a dev build or static
structure check.

## Acceptance Criteria
1. A reusable host-native desktop launch smoke script exists for packaged mac artifacts.
2. Release preflight enforces the launch smoke script and docs so the evidence path does not drift.
3. A fresh `dist/mac-arm64/Markie.app` package passes structure smoke and real packaged launch smoke.
4. Full local release preflight still passes without signing, notarization, upload, publish, deploy,
   or release credentials.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch remains host-gated until the workflow can run on Windows.
