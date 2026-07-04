# Current Task — Electron file grant hardening pass

## Task
Make one verified local security pass toward fully scoped local-file permissions by replacing
renderer-trusted Electron file paths with a main-owned grant model for open, save, rename, drop,
and workspace-root flows.

## Acceptance Criteria
1. Main process grants files only from trusted sources: OS open events, open/save dialogs,
   dropped files resolved in preload, cloud/shared downloads, and configured workspace roots.
2. `open-file-path`, `save-file`, and `rename-file` reject ungranted paths, unsupported file
   extensions, traversal rename names, and symlink escapes from workspace roots.
3. Save As, cloud pull, and same-directory rename preserve usable grants for continued editing.
4. Focused regression tests prove ungranted paths are refused and granted/workspace paths still
   work.
5. Run focused grant tests, full renderer/Electron tests, visual guard, and `./init.sh`.

## Scope Guard
Keep local-first behavior intact. Do not sign, notarize, publish, upload, deploy, or touch release
credentials. Preserve unrelated local edits, including the pre-existing `electron/main.js`
updater/menu diff. Do not widen public APIs or introduce new dependencies. Do not claim sharing,
library, or platform support is complete until the app is re-verified visually and functionally.
