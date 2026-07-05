# Current Task - Windows evidence and offline build hardening

## Task
Make the Windows packaged-app launch smoke artifact self-contained enough to audit after GitHub
Actions uploads it, and remove the production build's remote font dependency uncovered during
verification.

## Acceptance Criteria
1. The launch smoke JSON keeps the existing top-level compatibility fields.
2. The artifact records host, package, app, target, and renderer probe metadata needed to understand
   what executable was launched and what UI loaded.
3. Focused unit coverage proves the artifact builder works without requiring a Windows host.
4. The Next app builds without fetching Google-hosted font assets.
5. Syntax checks, focused Windows/release tests, and release preflight pass.

## Scope Guard
Do not sign, notarize, publish, deploy, upload, change release credentials, or alter the unrelated
pre-existing `electron/main.js` updater/menu diff.
