# Current Task — Download manifest pass

## Task
Make one verified local-only pass toward first-class Windows/macOS desktop support by adding a
repo-local desktop download manifest and using it as the source of truth for server download
routes, public share CTAs, and release preflight prerequisites.

## Acceptance Criteria
1. A checked-in manifest names the public Apple Silicon macOS download plus planned Intel Mac,
   Windows x64, and Linux x64 targets.
2. `/download/mac`, public share pages, and invite emails read their CTA route/copy from the
   manifest instead of hardcoded macOS strings.
3. Planned platform routes render an honest unavailable page and do not redirect to unpublished
   artifacts.
4. `release:preflight` validates the manifest exists without signing, notarizing, uploading,
   publishing, deploying, or touching credentials.
5. Run focused server/preflight tests, `release:preflight`, visual guard, and `./init.sh`.

## Scope Guard
Keep local-first behavior intact. Do not sign, notarize, publish, upload, deploy, or touch release
credentials. Preserve unrelated local edits, including the pre-existing `electron/main.js`
updater/menu diff. Do not claim Windows/macOS release support is complete until native-host package
verification, signing/notarization/code-signing, updater feeds, and public download URLs are
approved and verified.
