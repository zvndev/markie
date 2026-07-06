# Current Task - Packaged CSP hardening

## Task
Remove the broad packaged Electron `script-src 'unsafe-inline'` allowance while preserving the
Next static export bootstrap that Markie needs to render.

## Acceptance Criteria
1. Packaged app CSP computes SHA-256 hashes for the exact inline scripts in the built `out/*.html`
   files.
2. `script-src` no longer includes broad `unsafe-inline`.
3. `electron/main.js` uses the shared CSP helper for packaged app responses.
4. Release preflight requires the CSP helper and main-process wiring.
5. Focused CSP tests, packaged mac launch smoke, and full local release preflight pass.

## Scope Guard
Do not push, publish, deploy, sign/notarize, change release credentials, or run production update
feeds. Windows native launch still requires a Windows host/workflow run.
