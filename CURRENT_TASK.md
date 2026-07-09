# Current Task - Windows x64 Build Artifacts

## Task
Build and verify a Windows x64 version of Markie while confirming the current macOS release and
Git state are pushed and published.

## Acceptance Criteria
1. `main` is pushed to `origin`, and the current release tag exists remotely.
2. The public macOS update feed and release artifacts for `0.2.9` are reachable.
3. Full local release preflight passes.
4. Windows x64 unpacked package, zip, and NSIS installer build locally with publish disabled.
5. Windows package smoke verifies PE executable and native module payloads.
6. Windows-host launch smoke is confirmed through the GitHub Actions workflow after push.

## Scope Guard
Do not publish Windows artifacts publicly, enable Windows auto-update feeds, or add Windows code
signing without an explicit release decision.
