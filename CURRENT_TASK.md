# Current Task - F-020 manifest-backed download page copy

## Task
Update the repo-owned public download page copy so it clearly presents all supported desktop
platforms from the manifest, including planned platforms without pretending they are published.

## Acceptance Criteria
1. The download page renders Apple Silicon macOS, Intel macOS, Windows x64, and Linux x64 cards from
   the manifest.
2. Each platform card exposes the manifest-backed route and expected artifact pattern.
3. Planned platform cards remain unavailable placeholders; the public macOS route still links through
   the feed.
4. Render/server tests, release preflight, and full boot smoke pass.
5. `feature_list.json` marks `F-020` passing only with fresh evidence.

## Scope Guard
Do not sign, notarize, publish, deploy, upload, change release credentials, touch production data, or
alter the unrelated pre-existing `electron/main.js` updater/menu diff.
