# Current Task - F-019 download manifest source of truth

## Task
Make the repo-local download manifest a complete source of truth for supported desktop downloads,
including current public macOS and planned Intel Mac, Windows, and Linux targets.

## Acceptance Criteria
1. `server/download-manifest.json` covers Apple Silicon macOS, Intel macOS, Windows x64, and Linux
   x64 with labels, routes, status, and artifact filename patterns.
2. Manifest validation rejects any platform missing an artifact pattern, while only public platforms
   require a live feed.
3. Server tests prove planned routes stay honest placeholders and the public route still resolves
   from the feed.
4. Manifest/server tests, release preflight, and full boot smoke pass.
5. `feature_list.json` marks `F-019` passing only with fresh evidence.

## Scope Guard
Do not sign, notarize, publish, deploy, upload, change release credentials, touch production data, or
alter the unrelated pre-existing `electron/main.js` updater/menu diff.
