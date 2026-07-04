# Current Task — Cross-platform runtime and share-scope pass

## Task
Make one verified pass toward first-class Windows/macOS desktop support, better library
organization, and fully scoped sharing permissions without changing release, signing, deploy, or
public API shape.

## Acceptance Criteria
1. In-app terminal shell selection is platform-aware for Darwin, Windows, and Linux, with
   regression coverage.
2. MCP `markie_open_in_markie` no longer assumes macOS `open -a`; platform command selection is
   covered for Darwin, Windows, and Linux.
3. Browse and Skills library path display compacts macOS, Linux, and Windows home paths
   consistently.
4. Sharing access policy has explicit read/edit/manage helpers, and deleted docs no longer retain
   share access.
5. Run focused tests, server tests, lint/build, visual guard, and boot the app for review.

## Scope Guard
Keep local-first behavior intact. Do not change release credentials, deploy, notarize, publish,
or touch production infrastructure. Preserve unrelated local edits, including the pre-existing
`electron/main.js` updater/menu diff. Do not claim Windows/macOS release support is complete until
packaging, signing, updater, and installer evidence exists.
