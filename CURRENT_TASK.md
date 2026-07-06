# Current Task - Shared docs in Library Recent

## Task
Make the Library Recent view surface cloud-only documents shared with the user instead of showing
the empty workspace card while shared documents exist.

## Acceptance Criteria
1. The shared Library organizer keeps all shared docs for the Shared rail.
2. Shared docs without a local path are exposed as a distinct Recent section.
3. Shared docs already present on disk are not duplicated in Recent.
4. Focused Library organization/startup tests pass.
5. Full local release preflight, visual theme guard, and live Electron inspection pass.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
