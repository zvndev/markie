# Markie desktop: feature parity inventory

What desktop Markie 0.9.7 does, and what a native Rust build must match. Written 2026-11-21 from the Electron source on this branch. Section 0 and the closing lists are the ones to read first.

Repo: `/Users/macbookpro-kirby/Desktop/Coding/ZVN/markie-rs`, version 0.9.7. Line counts are rough `wc -l` figures for non-test files. The IPC spine is `electron/preload.js` (268 lines), its typed mirror is `src/lib/electron.ts` (1061), and the handlers live in `electron/main.js` (4143). Most channels are registered through `handle(...)` from line 1320 on. The renderer shell is `src/app/page.tsx` (2896).

Product docs worth reading alongside this one: `docs/document-workspace.md` and `docs/decisions/2026-10-14-original-document-engine.md`.

**Feature flags matter.** Several areas below ship only in the "super-nightly" build (`src/lib/nightly.ts`: private release, desktop preview, or `localStorage["markie.nightly"]="1"` in dev). The terminal is turned off outright (`src/lib/features.ts`: `TERMINAL_ENABLED = false`). Each area is tagged **[stable]**, **[nightly]** or **[hidden]**.

---

## 0. Cross-cutting state a Rust client must read or migrate (top risk)

Some user data lives inside Chromium's own storage, not in plain files:

- **Chromium localStorage** (LevelDB under the Electron userData folder):
  - `markie.token.v1` and `markie.token.v1@<origin>`: bearer tokens per server.
  - `markie.auth.principal.v1`, `markie.server.v1`, `markie.authstate.v1`: the sign-in nonce.
  - `markie.themes.v1`: the theme store. `markie.colormode.v1`, `markie.sync.v1`, `markie.cloud.sources.v1`, `markie.libtab.v4`.
  - `markie.leftpanel.width.v1` and the `markie.browse.*` keys (format, sort, open, starred, fullpath). `markie.skills.fullpath.v1`, `markie.search.types.v1`.
  - `markie.documents.zoom.v1`, `markie.linkPreviews.v1`, `markie.seen.v1` (first run), `markie.defaultApps.hintDismissed.v1`, `markie.vault.touchIdOffer`.
  - Per-document "normalize" consent (`src/lib/rich-override.ts`) and appearance (`src/lib/doc-appearance.ts`).
- **Chromium IndexedDB:**
  - `markie-encrypted-vault`: vault records (`src/lib/vault/storage.ts`).
  - `markie-document-library`: imported/recovered document records (`src/lib/document-library/indexed-db.ts`).
  - **Losing these loses vault contents.** The Rust app needs a one-time migration that reads Chromium LevelDB/IndexedDB, or an export step run from the last Electron build.
- **Plain files under userData:**
  - `registry.db` (SQLite, section 2) and `servers.json`.
  - `snapshots/` and `doc-meta/` (sections 8 and 12), `drafts/` (section 9), `asset-cache/` (`cache.json` plus files named by hash).
  - `agent-permissions.json`, `live-docs-projects.json`, `seeded-examples.json`, `markie-crash.log`, `preflight-ready`, `private-release-credential`.
  - Per-vault Touch ID secret files.
  - Crash-reporting consent and the update-channel opt-in, both under userData (`electron/main.js` ~3231–3266, ~3614–3622).
- **Home folder:** `~/.markie/agent-<instance>.sock` and `~/.markie/agent-bridge-<instance>.json`, where `instance = sha256(userData)[:10]` (section 15).
- **Custom URL schemes:**
  - `app://markie/` serves the bundle, with CSP from `electron/csp.js`. This goes away in Rust.
  - `markie-asset://` serves a document's local pictures, gated by `electron/local-assets.js`. It also carries Darkmown picture-scope hosts (`electron/darkmown-preview.js`).
  - `markie://` deep links (section 20).

---

## 1. Library panel (Recent, Projects) and the Files workspace [stable]

- **What the user can do:**
  - Open the left-rail Library. It lists recent and opened files with their sync state.
  - Filter by type; sort by name, recency or type.
  - Create new documents (Markdown, Word, text, Darkmown, Locked vault).
  - Drop files to import them.
  - Use a per-row context menu: rename, move, Trash (optionally deleting the cloud copy), reveal, sync on/off.
  - Pick a cloud upload destination ("area").
  - Use the Projects tab, the Files workspace roots, and Settings › Files (default folder `~/Documents/Markie`).
- **Files:**
  - Renderer: `src/components/library.tsx` (1260), `projects-panel.tsx` (242), `file-menu.tsx` (145), `library-document-filters.tsx` (73), `new-document-modal.tsx` (166), `activity-bar.tsx` (251), `panel-resizer.tsx` (150), `panel-notice.tsx`, `format-badge.tsx`, `document-format-mark.tsx`, `cloud-area-picker.tsx` (62).
  - Renderer libs: `src/lib/library-overview.ts` (165), `library-state.ts`, `library-document-query.ts`, `left-rail.ts`, `folder-tree.ts`, `first-run.ts`, `welcome-doc.ts`, `src/lib/document-library/*` (468).
  - Main: `electron/workspace.js` (206), `examples.js` (104; seeds a Darkmown example once).
- **Compatibility:**
  - IPC: `ws-roots`, `ws-default-path`, `ws-create-default`, `ws-add-root`, `ws-remove-root`, `ws-list-dir`, `ws-mkdir`, `ws-new-file`, `ws-move`, `ws-rename`, `ws-trash`, `ws-reveal`.
  - IPC: `library-state`, `library-trash-file`, `registry-track`, `registry-get`, `registry-set-role`, events `library-changed` and `menu-library`.
  - Data: the SQLite tables `files` and `workspace_roots`, and IndexedDB `markie-document-library` (recovery records with tags and collections).
  - Cloud areas: `GET`/`POST /api/account/cloud-areas` and `PUT /api/account/cloud-areas/placements/{markdown|snapshot}/:docId` (`src/lib/account-identities.ts`).
- **Rust port note:** Pure native UI. The recovery records need migrating out of IndexedDB.

## 2. Local registry (SQLite schema) [stable]

- **Files:** `electron/registry.js` (832). Uses better-sqlite3 in WAL mode. The file is `userData/registry.db` and `PRAGMA user_version` is currently 2.
- **Schema to keep exactly:**
  - `files(path PK, name, content_hash, cloud_doc_id, cloud_version INT, sync_state DEFAULT 'local-only', last_opened_at, last_synced_at, share_role, share_role_user, assets_state, assets_fingerprint, assets_skipped JSON, links_state, links_fingerprint, cloud_origin)`.
    - `sync_state` values: `local-only | synced | unpushed | conflict | paused`.
    - `cloud_origin` NULL means Markie Cloud. Legacy aliases are rewritten at startup.
  - `workspace_roots(path, added_at)`.
  - `md_stars(path, kind 'folder'|'file', added_at)`.
  - `md_index_cache(path, name, mtime_ms)`.
  - `skill_sources(id "owner/repo")`.
  - `skill_installs(path, target, name, source, skill_path, folder_hash, root, installed_at)`.
  - v1 tables: `md_meta(path, mtime_ms, birthtime_ms, fm_project, fm_block, repo_name, scanned_at)`, `project_pins`, `project_blocks(block_id, project, auto_name, custom_name, merged_into, …)`, `project_assignments(path, project, block_id, source, mtime_ms, fingerprint)`, `projects_config(key, value)`.
  - v2 table: `projects(project, custom_name, user_created, …)`.
  - On Windows, paths are lowercased at the boundary (`canonicalPath`).
- **Rust port note:** `rusqlite` can open the same file in place. Keep the migrations PRAGMA-guarded and idempotent.

## 3. Browse: the device-wide document index [stable]

- **What the user can do:** Browse every openable document on the machine, star files and folders, filter by format, sort, toggle full paths, and refresh. The index rescans on focus at most every 5 minutes.
- **Files:** `electron/mdindex.js` (567), `mdmeta.js` (212), `frontmatter.js` (58), `skill-frontmatter.js` (182); `src/components/browse-view.tsx` (715).
- **Compatibility:**
  - IPC: `mdindex-scan`, `mdindex-refresh`, `mdindex-stars`, `mdindex-star-toggle`, event `mdindex-updated`. Row shape is `MdRow` (`src/lib/electron.ts` around line 727).
  - Walk budget: 200k files, 30 s, depth 24, 4000 snippets. Snippets are 8 KB, taken only from text formats in files under 256 KB.
  - Exclusions: named directories, bundles, iCloud provider folders (`/Library/Mobile Documents/`).
  - Always scanned: the tool folders `~/.claude/skills`, `~/.codex`, `~/.agents/skills`, `~/.cursor/skills`, `~/.gemini/skills`, plus `CLAUDE_CONFIG_DIR`.
  - Front matter `markie: { project, block }` must be read the same way as in `src/lib/front-matter.ts`.
- **Rust port note:** A good fit for native code (`ignore` / `walkdir` crates). Keep the extension list in step with section 6.

## 4. Projects: the virtual taxonomy [stable]

- **What the user can do:** Auto-cluster documents into projects and blocks; pin, rename, merge and create projects; write an overview section into the user's organization document.
- **Files:** `src/lib/projects/*` (1525: `cluster.ts` 557, `taxonomy.ts` 318, `rules.ts` 249, `assign.ts`, `audit.ts`, `search.ts`), `src/lib/use-projects.ts`, `electron/projects-config.js` (97).
- **Compatibility:** IPC `projects-state`, `projects-save-cache`, `projects-pin`, `projects-block-set`, `projects-project-set`, `projects-create`, `projects-config`, `projects-write-overview`. Uses the registry v1/v2 tables. The config document is rewritten only below its overview marker. Rules are YAML (js-yaml).
- **Rust port note:** Pure logic; port as-is.

## 5. Global search across documents [stable]

- **What the user can do:** Press ⇧⌘F to search the text of all indexed documents, with type chips and term highlighting.
- **Files:** `src/components/global-search.tsx` (273), `src/lib/doc-search.ts`, `electron/doc-text.js`, which re-exports **`mcp/doc-text.cjs` (418)**. That file is shared with the MCP `markie_search_documents` tool so the two rankings never drift.
- **Compatibility:** IPC `doc-search` returns a `DocumentSearchResponse`.
- **Rust port note:** If search moves to Rust, the MCP server, which stays in Node, either keeps its own copy (parity tests needed) or calls the Rust code.

## 6. File open/save pipeline, formats and size tiers [stable]

- **What the user can do:**
  - Open from the dialog, a drop, Finder or `open -a`, the command line, or a second-instance launch.
  - Save (⌘S) and Save As (⇧⌘S); rename; duplicate/fork (⇧⌘D); reveal (⌥⌘R).
  - Copy the file path or the whole contents.
  - Rely on a 1 s polling watcher that notices outside edits.
- **Files:**
  - Main: `electron/main.js` (`open-file` around line 1375, `save-file` around 1448, `save-file-as`, `rename-file`, `watch-file` around 726–744 using `fs.watchFile` at 1000 ms), `document-files.cjs` (200, opaque byte "leases" for office/.wd files), `file-grants.js` (164), `atomic-write.js` (186), `disk-memory.js` (117), `doc-tiers.js` (115), `text-byte-route.js`, `doc-names.js`, `dialog-start.js`.
  - Renderer: `src/lib/document-formats.ts`, `native-document-files.ts`, `web-files.ts`, `use-document.ts`, `document-session.ts`, `document-shell.ts`.
- **Format table** (identical in `src/lib/document-formats.ts`, `electron/mdindex.js` and `electron/document-files.cjs`):
  - `md/markdown/mdx` → markdown
  - `wd` → darkmown
  - `txt/text/log` → text
  - `csv`, `json`, `yaml/yml`, `xml` → literal text
  - `docx/doc/rtf/odt` → byte engine
  - `html/htm` → unsupported for editing; converts to a TXT copy with consent
- **Size tiers:** `LARGE_DOC_BYTES = 1_000_000` opens source-only. `MAX_DOC_BYTES = 100_000_000` is refused.
- **Text decoding:** `decodeTextDocument` preserves the UTF-8 BOM and UTF-16 LE/BE BOMs, and keeps the newline style (lf, crlf, cr, mixed). It refuses UTF-32 and binary magic bytes.
- **IPC:**
  - Text files: `open-file`, `open-file-path`, `get-initial-file`, `save-file {filePath, content, force, autosave}`, `save-file-as`, `rename-file`, `reveal-file`, `watch-file`; events `file-opened`, `file-changed-on-disk`.
  - Byte documents: `document-files:{open, save-as, read, write, release, take-initial}`, event `document-file-opened`.
  - Sync IPC: `grant-file-path`, `attach-file-path`.
- **Rust port note:** Native. Replace the 1 s polling with `notify`, but keep the semantics of "my own write is not a foreign change" (`disk-memory.js`).

## 7. Source mode editor (CodeMirror) [stable]

- **What the user can do:**
  - Edit raw source in Source (⌘2) or Split (⌘3) mode. Rich mode is ⌘1.
  - Find and replace (⌘F, ⌥⌘F).
  - Format GFM tables (⌥⌘T).
  - Get syntax highlighting for fenced code through `@codemirror/language-data`.
  - Undo and redo through the menu.
  - Large documents get a virtualized editor.
  - CSV files show as a table, and convert CSV ↔ GFM.
- **Files:** `src/components/source-editor.tsx` (55), `editor.tsx` (170), `find-bar.tsx` (345), `large-doc.tsx`; `src/lib/editor-keymap.ts`, `source-find.ts`, `source-handle.ts`, `source-comments.ts`, `format-tables.ts` (110), `csv.ts` (171), `undo-target.ts`.
- **Rust port note:** Needs a native code editor with good performance on a 1–100 MB buffer (gpui-kit or Zed's editor crate, with tree-sitter for Markdown and fenced languages).

## 8. Rich "View" mode (TipTap/ProseMirror) [stable]

- **What the user can do:**
  - Edit WYSIWYG: headings, aligned paragraphs and headings, lists, task lists, tables with column alignment, images with resize and width, video embed cards (YouTube/Vimeo).
  - Math, inline and block, drawn with KaTeX.
  - Highlight, colour, font family, font size, underline. These serialize as inline HTML.
  - Formatting rail, document toolbar and formatting toolbar.
  - Section rail (an H1–H3 minimap), image lightbox, statistics panel (⇧⌘I).
  - Zoom (⌘=, ⌘-, ⌘0) and page width (⌥⌘], ⌥⌘[). Pinch zoom.
  - Front matter is held aside and never shown.
  - **Byte-for-byte preservation:** only the blocks the user changed are re-serialized.
- **Files:**
  - Components: `src/components/rich-view.tsx` (1086), `format-rail.tsx` (358), `formatting-toolbar.tsx` (506), `doc-toolbar.tsx` (178), `section-rail.tsx` (706), `image-lightbox.tsx` (346), `stats-panel.tsx`, `rich-guard.tsx`, `rich-pane-error.tsx`.
  - Libs: `src/lib/rich-extensions.ts` (312), `rich-math.ts` (640), `rich-embed.ts` (285), `rich-block-preserve.ts` (410), `rich-hold-aside.ts`, `rich-roundtrip.ts`, `rich-safety.ts`, `use-rich-safety.ts`, `rich-aligned-blocks.ts`, `rich-table-align.ts`, `rich-media-html.ts`, `rich-data-images.ts`, `rich-find.ts`, `rich-search.ts`, `rich-keymap.ts`, `rich-warmup.ts`, `section-outline.ts` (312), `front-matter.ts`, `embeds.ts` (120, also copied in the server), `asset-url.ts`, `attach.ts`, `doc-appearance.ts`, `document-zoom.ts`, `stats.ts`.
- **Compatibility:**
  - ProseMirror node and mark names matter because they define the Yjs XML in section 11. Nodes: StarterKit (paragraph and heading replaced by aligned versions), `text` (MathAwareText), `mathInline`, `mathBlock`, TableKit plus AlignedTable, `taskList`, `taskItem`, `image` (LocalImage, base64 allowed), `embed`. Marks: Highlight (multicolor), TextStyle, Color, FontFamily, FontSize; TextAlign on heading and paragraph.
  - Serialization: tiptap-markdown with `html: true`, `linkify`, `tightLists`.
  - The `$…$` / `$$…$$` math syntax is kept as written.
  - A width is written as an `<img width>` HTML form.
- **Rust port note (largest risk):**
  - GPUI has no ProseMirror. The Rust app needs a native rich Markdown editor that can (a) round-trip the exact Markdown and preserve unchanged blocks, (b) map to the same Yjs XmlFragment schema for collaboration, and (c) draw KaTeX math.
  - Math needs a native TeX renderer (for example ReX or a MathJax-to-SVG path). Otherwise this part needs web content.
  - Embed cards need thumbnails; playing the video itself needs a web view or the browser.
  - Raw inline HTML in Markdown (`<span style>`, `<img width>`, colours) has to be interpreted natively or shown as source.

## 9. Autosave, drafts (crash journal), save conflicts and outside edits [stable]

- **What the user can do:**
  - Autosave runs after 1 s of idle, at most every 5 s during continuous typing (`src/lib/autosave.ts`).
  - A crash-recovery draft strip appears after a crash.
  - A non-modal strip appears when the file changed on disk. A conflict dialog appears if both copies changed.
  - Closing the window flushes pending saves first.
- **Files:** `src/lib/autosave.ts`, `use-save-guard.ts` (215), `disk-change.ts`; `src/components/draft-strip.tsx`, `disk-change.tsx` (178), `conflict-dialog.tsx` (211); `electron/drafts.js` (144), `save-conflict.js`, `close-flush.js`.
- **Compatibility:**
  - IPC: `draft-save`, `draft-check`, `draft-discard`, events `app-will-close` and `app-close-ready` / `app-close-cancel` (with a hard timeout).
  - Drafts live in `userData/drafts/`, one file per document plus `index.json`, named by the slug from section 12.
  - Rule: autosave never opens a dialog. It refuses and shows the strip instead.

## 10. Markie Cloud sync (snapshot sync), assets and links [stable]

- **What the user can do:**
  - Turn sync on or off per document.
  - Push, retry and pull; check for updates; open shared documents.
  - Resolve conflicts: keep both, take the cloud copy, or overwrite.
  - Media and document links travel with the document.
  - A background reconcile repairs pushes that never landed.
  - Shared-to-me documents land in `~/Documents/Markie/Cloud/`.
  - Multiple servers: Markie Cloud plus self-hosted servers.
- **Files:**
  - Sync engine: `electron/sync.js` (1548), `asset-sync.js` (374), `asset-cache.js` (394), `link-sync.js`, `doc-links.js`, `doc-assets.js`, `reconcile.js` (151), `cloud-doc-for.js`, `doc-link-open.js`.
  - Servers and origins: `servers.js` (456), `server-request.js`, `share-origin.js` (228), `cloud-origin.json` (`https://api.markiedocs.com`, docs origin `https://markiedocs.com`).
  - Renderer: `src/components/cloud-view.tsx` (698), `servers-setting.tsx` (441), `src/lib/server-sessions.ts` (385), `line-diff.ts`.
- **IPC:**
  - Sessions and servers: `sync-config`, `sync-session`, `servers-list`, `servers-probe`, `servers-add`, `servers-remove`, `server-request`, `sync-doc-role`.
  - Documents: `doc-sync-on`, `doc-sync-off`, `doc-push`, `doc-resolve`, `doc-retry-push`, `doc-check-updates`, `doc-remote-content`, `doc-keep-both`, `doc-pull`, `doc-open-shared`.
  - Links and assets: `asset-reconcile`, `resolve-doc-links`, `open-doc-link`.
- **REST endpoints** (bearer `Authorization: Bearer <token>`):
  - Documents:
    - `GET /api/docs`
    - `GET`, `PUT` `{name, content, hash, baseVersion, areaId?}` (409 on conflict), and `DELETE` `/api/docs/:id`. A new document uses a client `randomUUID` as its id.
  - Links: `GET`/`PUT /api/docs/:id/links`.
  - Assets: `PUT /api/assets/:sha256`, `POST /api/docs/:id/assets/missing {hashes}`, `PUT /api/docs/:id/assets`, `GET /api/docs/:id/assets/file?ref=`.
  - Server probe: `GET /api/server-info`.
- **Rust port note:** Native HTTP (reqwest). Origin pinning and the token-per-origin rule must be kept.

## 11. Live collaboration (Yjs over y-websocket) [stable]

- **What the user can do:** Edit together in real time, with peer cursors and avatars, in synced rich Markdown and in plain-text documents.
- **Files:** `src/lib/collab.ts` (270), `collab-runtime.ts`, `collab-loader.ts`, `text-collab.ts`, `live-snapshot.ts` (427), `live-snapshot-rich.ts`, `rich-room-migrate.ts` (300), `room-migration-update.ts`, `live-room-carry.ts`; `src/components/rich-view.tsx`, `text-collab-editor.tsx` (272), `toolbar.tsx` (438, peers).
- **Wire protocol:**
  - Connect to `wss://<server>/collab/<docId>?ticket=<t>`, using standard y-protocols: message 0 is sync, message 1 is awareness.
  - Get the ticket with `POST /api/docs/:id/collab-ticket {schema: 2}`, which returns `{ticket, expiresAt}`. A ticket lasts 5 minutes and is refreshed in place in `params` on each reconnect. Legacy servers fall back to a `?token=` parameter.
  - Close codes: 4403 means access revoked; 4426 means the room is too new for this client.
  - The server elects one seeder per empty room and drops other clients' writes while seeding is pending. The client waits `SEED_SETTLE_MS = 150` and gives up a claim after 15 s.
- **Yjs document schema (must match exactly):**
  - Rich room: `ydoc.getXmlFragment("default")`, the y-prosemirror binding of the TipTap schema in section 8.
  - Text room: `ydoc.getText("content")`.
  - Map `meta`: `schemaVersion` (1 plain, 2 with math or front matter), `editorModel = 2`, `contentKind = "text"`, `storedCopy = {version, hash, next}`.
  - Awareness fields: `user {name, color, …}` and `markieSnapshotWriter: true`. The writer with the lowest clientID writes the stored copy back over REST.
  - Peer colours come from `colorForName`.
- **Rust port note:**
  - Use `yrs` with a y-sync implementation.
  - The hard part is a native editor-to-XmlFragment binding that is byte-compatible with y-prosemirror: element names, attributes, and marks encoded as formatting attributes on XmlText. Web and mobile clients share the same rooms.

## 12. Comments: cloud threads and local comments

- **Cloud comments [stable]:**
  - Threads on synced and collaborative documents: add, reply, resolve or reopen, delete.
  - Files: `src/lib/comments.ts`, `comment-anchors.ts`, `comment-target.ts`; `src/components/comments.tsx` (446).
  - REST: `GET`/`POST /api/docs/:id/threads`, `POST /threads/:tid/comments`, `…/status`, `DELETE …/comments/:cid`.
  - **Anchor format:** `{from, to}` are y-prosemirror **Y.RelativePosition JSON** into the XmlFragment.
  - Rust: needs `yrs` StickyIndex positions that are compatible with y-prosemirror's position mapping.
- **Local comments [nightly]:**
  - Comments on local Markdown files. Agents can also add them through MCP.
  - Files: `electron/local-comments.js` (218), `doc-meta.js` (160), `text-anchor.mjs` (233), `agent-comments.js`; `src/components/local-comments.tsx` (539), `src/lib/local-comments.ts` (291), `rich-comments.ts`.
  - IPC: `local-comments-{list, add, reply, status, delete}`, event `local-comments-changed`.
  - **On disk:** `userData/doc-meta/<sha256(abs)[:8]>-<basename>/comments.json` = `{version: 1, threads: [{id, anchor: {exact, prefix, suffix, start}, status, comments: [...]}]}`, plus a `doc.json` naming the path. Threads whose text is gone show as "detached".

## 13. Version history (snapshots) [stable dialog; full view nightly]

- **What the user can do:**
  - A version is kept before every overwrite.
  - List versions with author (you, an outside edit, or a named agent), name a version, view it, restore it, and see a line or word diff ("highlight changes").
  - Retention keeps everything for 24 h, then hourly for 7 days, daily for 30 days, the newest 5 always, at most 200 per file and 500 MB total. Named versions are never pruned.
- **Files:** `electron/history.js` (476), `snapshots.js` (186), `agent-history.js`; `src/components/history-dialog.tsx` (155), `version-history-view.tsx` (611); `src/lib/version-history.ts`, `version-diff.ts` (500), `line-diff.ts`.
- **Compatibility:**
  - IPC: `history-list`, `history-read`, `history-head`, `history-name`, event `menu-history`.
  - **On disk:** `userData/snapshots/<hash8>-<basename>/<ISO stamp, ':'→'-'>[-N].md`, plus `meta.json` ({stamp → author/name}) and `last-write.json` ({hash, author, time}).

## 14. Sharing, people, roles and public links [stable]

- **What the user can do:**
  - A Google-Docs-style share dialog: invite by email as viewer or editor, remove people, set general access (Restricted or Anyone with the link), create or revoke a public link, copy links.
  - Accept, decline, block or unblock share requests.
  - See "Shared by me" and "Shared with me" in the Cloud page.
  - A view-only banner appears when the user lacks edit rights. The role is remembered offline per account.
  - A hosted Live Doc address exists for a cloud `.wd`.
- **Files:** `src/components/share-dialog.tsx` (869), `share-gate.tsx` (285), `share-people.tsx` (289), `share-banner.tsx` (175), `cloud-view.tsx`; `src/lib/auth-client.ts` (844; `makeSharesClient`), `share-role.ts`, `general-access.ts`, `share-access-view.ts`.
- **REST endpoints:**
  - Access and listings: `GET /api/docs/:id/access`, `GET /api/docs/shared-by-me`, `GET /api/docs/share-contacts`.
  - Members: `GET`/`POST /api/docs/:id/shares`, `DELETE /api/docs/:id/shares/:idOrEmail`.
  - Public link: `GET`/`POST`/`DELETE /api/docs/:id/public-link`.
  - Live Doc: `GET /api/docs/:id/live-doc` returns `{url, access, network}`.
  - People: `GET /api/people/requests`, `GET /api/people`, `POST /api/people/:id/{accept,block,unblock}`, `POST /api/people/requests/:docId/decline`, `DELETE /api/people/:id`.
- **Web pages:** the private link is `/d/:id` and the public link is `/s/:token`. Their raw text is at `/d/:id/raw` and `/s/:token/raw`.

## 15. AI agent bridge, MCP server and remote agents [stable on macOS/Linux; bridge off on Windows]

- **What the user can do:**
  - Connect Claude, Codex and other agents to the local MCP server. The Agents dialog shows `claude mcp add markie -- node <path>` and a snippet for `~/.codex/config.toml`.
  - Agents can find, search, read and write documents, list skills, open files in Markie, check `.md` and `.wd` files, read the guide, and use Cloud status, sync and public links (with consent prompts) and comments.
  - Remote agents use Cloud agent tokens.
- **Files:**
  - Main: `electron/agent-bridge.js` (109), `agent-cloud.js` (201), `agent-history.js`, `agent-comments.js`.
  - MCP server (stays Node, shipped in Resources): `mcp/markie-mcp.mjs` (652), `lib.mjs` (373), `doc-text.cjs`, `check-md.mjs`, `check-wd.mjs`, `markdown-guide.mjs`, `comment-tools.mjs`, `scan.mjs`, `darkmown-compiler.mjs`.
  - Renderer: `src/components/agents-dialog.tsx` (217), `remote-agents-panel.tsx` (379); `src/lib/agent-tokens.ts`.
- **Compatibility:**
  - The bridge is a Unix socket at `~/.markie/agent-<instance>.sock` (folder mode 0700). The discovery file `agent-bridge-<instance>.json` (0600) names the socket and a token.
  - One request per connection, as newline-delimited JSON: `{"token", "method", "params"}` → `{"ok", "result" | "error"}`.
  - Methods: `cloud_status`, `cloud_sync`, `cloud_public_link`, `cloud_revoke_public_link`, `history_note_write {path, agent, sha256}`, `comments_list`, `comments_add`, `comments_reply`, `comments_resolve`.
  - Consent: a native dialog with "always allow" for sync, stored in `agent-permissions.json` as `{cloudSync: "always"}`. A public link is confirmed every time.
  - `markie_open_in_markie` runs `open -a Markie <path>` on macOS (`mcp/lib.mjs` around line 319). The Rust app's bundle name and Windows/Linux launchers must still match.
  - IPC: `mcp-info` (returns serverPath), `agent-permissions`, `agent-permissions-set`.
  - REST: `GET`/`POST /api/agent-tokens`, `DELETE /api/agent-tokens/:id`.
- **Rust port note:** Keep the socket protocol exactly as it is. The Rust app must still bundle Node and the `mcp/` folder, or the MCP server needs a rewrite.

## 16. Skills and agent files view [stable]

- **What the user can do:** See SKILL.md files and agent instruction files grouped by tool (Claude, Codex, Cursor, Gemini, universal), with descriptions from front matter. Move an installed skill to the Trash.
- **Files:** `src/components/skills-view.tsx` (639), `src/lib/skills-panel.ts`, `agent-files.ts`; `electron/skill-trash.js`, `skill-frontmatter.js`, plus the `mdindex.js` skill roots.
- **Compatibility:** IPC `skills-trash`. Only a folder that sits directly in a tool's skills folder qualifies (realpath-checked). The registry tables `skill_sources` and `skill_installs` exist.

## 17. Office documents workspace: DOCX, DOC, RTF, ODT, HTML import [stable]

- **What the user can do:**
  - DOCX editing in an original engine: runs and paragraphs, headings, lists, spacing and alignment, page setup (Letter, A4, Legal, orientation), tables, PNG/JPEG pictures, hyperlinks, page breaks, comments, simple revisions, page/continuous/outline views. The Word find tool is a stub.
  - DOC: text extraction in a worker, limited to 5 s and 32 MiB, producing a TXT copy.
  - RTF and ODT: a bounded codec with same-format save.
  - HTML: with explicit consent, converts to a UTF-8 TXT copy.
  - Native Format, Insert, Layout and Review menus.
  - Word Export PDF and Print stay on light paper.
- **Files:**
  - Codecs: `src/lib/office/*` (6479 total; `docx.ts` 803, `odt.ts` 522, `rtf.ts` 466, `docx-edit.ts` 362, `docx-media.ts` 324, `zip.ts` 313, `cfb.ts` 253, `xml.ts`, `docx-print.ts`, …), `src/lib/document-import/*` (532).
  - Workspace: `src/components/documents/*` (5270; `word-document-editor.tsx` 587, `use-document-workspace.ts` 499, `word-paragraph.tsx`, `document-workspace.tsx`, `text-document-editor.tsx`, CSS 1660), `document-workspace-host.tsx` (278), `document-workbench.tsx` (development only).
  - Menus: `electron/document-menu.js`, `document-menu-commands.json` (49 command ids, such as `format-*`, `insert-*`, `layout-*`, `review-*`, `view-*`).
- **Compatibility:** IPC `document-menu-state`, event `document-command`. The original bytes come back unchanged when the document was not edited.
- **Rust port note:**
  - Port the TypeScript codecs, which are written from the specifications. The provenance rules in the decision doc apply, and they rule out dropping in third-party Office engines.
  - The Word page layout is React/CSS today and must be laid out natively.

## 18. Darkmown `.wd` interactive documents [stable for editing; links and pictures nightly]

- **What the user can do:**
  - Edit `.wd` source and view a compiled interactive preview: Source, Preview, or Split.
  - The preview runs only after an explicit trust step, and Reset returns it to authored defaults.
  - "Make Interactive" turns a `.md` into an unsaved `.wd`.
  - The `.wd` preview can show pictures beside the file and open links in the browser [nightly].
- **Files:** `src/components/documents/darkmown-document-editor.tsx` (167); `src/lib/darkmown/*` (778; `security.ts` 429, `frame.ts`, `preview.ts`, compiler worker); the vendored `src/lib/darkmown/vendor/compiler-browser.mjs` and `runtime.js.txt` (pinned, with PROVENANCE); `electron/darkmown-preview.js` (238), `darkmown-runtime-policy.json`, `darkmown-link-bridge-policy.json`.
- **Compatibility:**
  - IPC `darkmown-preview-picture-scope`, `darkmown-preview-open-link`.
  - Messages from the frame: `markie:preview-theme` and `markie:wd-link`.
  - Pictures are served on a `markie-asset://<random-scope-host>/` URL.
- **Rust port note:** **This inherently needs a web view.** The compiled output is HTML/JS run in a sandboxed srcdoc iframe with a hash-pinned CSP. Embed a system webview (wry/WKWebView/WebView2) with equivalent isolation: no same-origin, no navigation, no popups.

## 19. Live Docs: Darkmown projects [nightly]

- **What the user can do:**
  - Add Darkmown site project folders, browse the project tree, open tabs, edit and save files (with revision checks).
  - Run `node_modules/.bin/darkmown dev` and see the live site in a native view inside the window.
- **Files:** `electron/live-docs-projects.cjs` (579), `live-docs-preview.js` (593); `src/components/live-docs/live-docs-area.tsx` (541), `live-docs-preview-panel.tsx` (150); `src/lib/live-docs/*`.
- **Compatibility:**
  - IPC `live-docs-projects-{list, add, remove}`, `live-docs-project-{open, close, tree, read, write}`, event `live-docs-project-changed`.
  - IPC `live-docs-preview-{choose, start, stop, layout}`, event `live-docs-preview-status`.
  - The project list is in `userData/live-docs-projects.json`. The user's Node is found through the login shell.
- **Rust port note:** **Needs an embedded web view** for the running dev server (it is an Electron WebContentsView today).

## 20. Deep links, default apps and OS integration [stable]

- **What the user can do:**
  - Handle `markie://auth?token&state` (sign-in return), `markie://open?token&src` (public link, fetched anonymously after confirming the host), and `markie://doc?id&src` (fetched with the user's session).
  - Make Markie the default app for chosen file types (Settings › Files).
  - Single instance; macOS `open-file` and `open-url` events; second-instance argv.
  - Hidden-inset title bar with traffic lights at (14, 14). Linux `.desktop` integration.
  - Links inside documents: a passive file opens directly, anything else is revealed in Finder.
- **Files:** `electron/deep-links.js` (64), `share-open.js` (110), `default-apps.js` (77; Swift calling `LSSetDefaultRoleHandlerForContentType`), `desktop-intents.js`, `linux-desktop.js` (185), `local-open-policy.js`, `external-web.cjs`; `src/components/default-apps-section.tsx`; `src/lib/local-link.ts`, `external-link.ts`, `doc-links.ts`.
- **Compatibility:**
  - IPC `set-default-md`, `default-md-status`, `default-apps-status`, `default-apps-set`, `open-external`, `open-local-file`, event `deep-link`.
  - Endpoint: `GET /s/:token/raw`. A shared document lands in Downloads.
  - Packaging must keep the bundle id, the UTIs and file associations, and the `markie` URL scheme.

## 21. Sign-in and accounts (better-auth) [stable]

- **What the user can do:**
  - Sign in with Google or Apple through the system browser, which returns a deep link.
  - Email and password, sign up, email one-time code, verify email, reset password, sign out.
  - Link identities (Google, Apple, email) with step-up verification.
  - Keep a separate account per added server.
- **Files:** `src/components/sign-in.tsx` (438), `linked-identities.tsx`, `private-release-gate.tsx`; `src/lib/auth-client.ts` (844), `auth-state.ts` (single-use nonce tied to its server), `auth-store.ts`, `auth-errors.ts`, `account-identities.ts`, `server-sessions.ts`; `electron/private-release.js`.
- **REST endpoints:**
  - Browser starts: `GET /auth/google-start?state=` and `GET /auth/apple-start?state=`, which come back through `/auth/desktop-bridge` to a `markie://auth` link.
  - Session: `GET /api/me`.
  - Email: `POST /api/auth/sign-in/email`, `/sign-up/email`, `/sign-out`.
  - One-time codes: `/email-otp/send-verification-otp`, `/sign-in/email-otp`, `/email-otp/verify-email`, `/forget-password/email-otp`, `/email-otp/reset-password`.
  - Account (identities and capabilities): `GET /api/account/capabilities`, `POST /api/account/identities/sign-in/{start,verify}`, `/api/account/identities[...]` (step-up and email start/verify).
  - Document platform: `/api/document-platform/*`.
  - The token arrives in the `set-auth-token` response header (better-auth bearer plugin).
- **Rust port note:** Store tokens in the Keychain or credential manager, not plaintext. Migrate the existing ones from localStorage (section 0).

## 22. Vault: encrypted local documents, Touch ID and secret clipboard [stable UI, experimental format]

- **What the user can do:**
  - Create and unlock a passphrase vault (16+ code points; a wordlist generator is included).
  - Keep encrypted documents and a `.env` key/value editor.
  - Unlock with Touch ID and confirm actions (open, reveal, copy) with it.
  - Copy a secret; the clipboard is cleared automatically.
  - Back up the vault.
- **Files:** `src/lib/vault/*` (1573; `repository.ts`, `index.ts`, `dotenv.ts`, `envelope.ts`, `storage.ts`, `passphrase.ts`, `wordlist.ts`, `backup.ts`); `src/components/documents/vault-panel.tsx` (840), `vault-env-editor.tsx` (255); `electron/vault-touch-id.js` (157), `secret-clipboard.js`.
- **Crypto format (must match exactly):**
  - `VaultHeader {kind: "markie-vault", version: 1, vaultId, kdf: {PBKDF2, SHA-256, iterations 600k (max 1M), salt}, wrap: {AES-GCM, iv, ciphertext}}`.
  - Documents: `{kind: "markie-vault-document", cipher: "AES-GCM", keyWrap: "AES-KW", wrappedKey, …}`. Device slot version 1.
  - Limits: 8 MiB of content, 128 records.
  - Stored in IndexedDB `markie-encrypted-vault`.
- **IPC:** `vault-touch-id-{available, enroll, unlock, confirm, remove}`, `secret-clipboard-copy`, `secret-clipboard-clear`.
- **Rust port note:** Use RustCrypto (pbkdf2, aes-gcm, aes-kw). Touch ID through LocalAuthentication; Keychain in place of safeStorage. **Data migration out of IndexedDB is mandatory.**

## 23. Export, print and converted copies [stable]

- **What the user can do:**
  - Export PDF in dark or light (⇧⌘E is dark) and Print (⌘P).
  - Export a standalone HTML file with local images inlined as data URIs.
  - Export a converted copy as DOCX, RTF, ODT, TXT or MD. In RTF and ODT, tables become tab-separated rows.
  - Word documents get their own PDF and print path.
- **Files:** `electron/export-pdf.js` (255; hidden window, temp file, `printToPDF` or `print`, deadline), `export-document.js` (64), `inline-images.js`, `local-assets.js`; `src/lib/use-export.ts`, `export-formats.ts` (585), `markdown-html.ts` (131; remark, rehype-raw, sanitize, KaTeX, highlight.js), `pdf-styles.ts` (430), `rehype-media.ts`, `rehype-embeds.ts`, `rehype-contain-styles.ts`, `src/app/print.css`, `src/lib/office/docx-print.ts`.
- **Compatibility:** IPC `export-pdf {html, theme, docPath, mode}`, `export-html`, `export-document {format, defaultName, data}`; menu events `menu-export-pdf` and `menu-print`. The sanitize schema is shared with `server/src/render.ts`.
- **Rust port note:** PDF and print currently rely on Chromium's `printToPDF` and HTML/CSS with KaTeX and highlight.js. Options: a hidden webview, or a native layout path (typst, printpdf, or a skia-pdf backend). HTML export is string generation and can stay.

## 24. Link previews on hover [stable]

- **What the user can do:** Hover a link to see a card with title, description, site and image. Fetched only on a deliberate hover; can be turned off in Settings.
- **Files:** `electron/link-preview.js` (440; fetch from main, string scan only, no DOM, image returned as a data URI); `src/components/link-preview-card.tsx` (127); `src/lib/link-previews.ts`.
- **Compatibility:** IPC `link-preview(url)` returns `LinkPreview` (four plain strings plus a data URI).
- **Rust port note:** Native. Keep the size, timeout and SSRF limits.

## 25. Terminal panel [hidden: `TERMINAL_ENABLED = false`]

- **What the user can do:** (When enabled.) Open PTY tabs with xterm.js, capped at 12 sessions, toggled with ⌃\`, plus "Open in…" an external terminal app.
- **Files:** `electron/terminal.js` (372, node-pty); `src/components/terminal-panel.tsx` (304).
- **Compatibility:** IPC `term-{available, create, write, resize, kill, external-apps, open-external}`, events `term-data` and `term-exit`.
- **Rust port note:** Use `portable-pty` with alacritty_terminal or Zed's terminal crate. It is optional, because the feature ships turned off.

## 26. Auto-update channels [stable]

- **What the user can do:**
  - Check for updates (also every 6 h).
  - Opt in to "Get new versions early" (the beta feed; the default is `latest`).
  - Get a sticky "update ready" toast with restart-to-install.
  - Private and preview builds update separately or not at all.
- **Files:** `electron/update-channel.js` (222), `update-policy.js` (113), `updater-logging.js`, `private-release.js`, `desktop-preview.cjs`; `src/components/update-toast.tsx`; `server/download-manifest.json` (feeds).
- **Compatibility:** IPC `check-for-updates`, `update-status`, `update-channel-get`, `update-channel-set`, `quit-and-install`, events `update-available`, `update-progress`, `update-ready`. The feeds are electron-updater `latest*.yml` and `beta*.yml` (`-mac`, `-linux` suffixes).
- **Rust port note:** Needs a new updater (Sparkle on macOS, a custom tool on Windows). The last Electron build has to migrate users over to the new feed format.

## 27. Crash reporting and logs [stable]

- **What the user can do:**
  - Opt in to error reporting (off by default, and inert without a DSN).
  - Reveal Crash Log from the Help menu.
  - A top-level error boundary keeps the app usable; renderer errors are logged.
- **Files:** `electron/crash-reporting.js` (124), `sentry-envelope.js` (204; raw Sentry envelope POST to `/api/<project>/envelope/`, no SDK), `crash-log.js` (`userData/markie-crash.log`), `crash-reporting.config.json` (DSN empty), `stdio-guard.js`; `src/components/error-boundary.tsx`.
- **Compatibility:** IPC `crash-consent-get`, `crash-consent-set`, `crash-log-reveal`, `log-renderer-error`.
- **Rust port note:** Native panic hook plus the same envelope POST and scrubbing.

## 28. Settings, themes and appearance [stable]

- **What the user can do:**
  - Settings sections: account, appearance, files, advanced (servers, updates, error reporting, links).
  - Style templates (Markie, Paper, Nord, Solarized, Ink, Rosé, Forest, Studio), each with a light and dark variant.
  - Light, dark or system colour mode.
  - Custom presets: colour tokens plus typography (typeface, size, content width).
  - Themes follow the account across devices. An owner can pin a theme to a shared document.
- **Files:** `src/components/settings.tsx` (890); `src/lib/theme.ts` (827), `color-mode.ts`, `theme-sync.ts`, `katex-css.generated.ts`, `src/app/globals.css`.
- **Compatibility:**
  - `ThemeTokens`: background, surface, surface2, foreground, muted, border, docRule, accent, link, status* colours, fontSize, contentWidth, typography.
  - The store is in `markie.themes.v1`.
  - REST: `GET`/`PUT /api/me/themes {store}`, `GET`/`PUT /api/docs/:id/theme`.
- **Rust port note:** Map the tokens onto the GPUI theme; keep the JSON shape for cloud sync.

## 29. Menus, shortcuts and command palette [stable]

- **What the user can do:**
  - Native menus:
    - File: New ⌘N, Open ⌘O, Library ⌘L, Search All ⇧⌘F, Save, Save As, History, Fork ⇧⌘D, Reveal ⌥⌘R, Print ⌘P, Export.
    - Edit: Undo/Redo, Find ⌘F, Replace ⌥⌘F, Format Tables ⌥⌘T.
    - View: modes ⌘1/2/3, zoom, page width ⌥⌘[ and ⌥⌘], Command Palette ⌘K, Theme, Shortcuts ⌘/, Statistics ⇧⌘I.
    - Settings ⌘,; Default Apps; Check for Updates.
    - The document menus from section 17.
  - The command palette (about 40 commands) uses fuzzy ranking: prefix, word, substring, subsequence.
  - A shortcuts help sheet.
- **Files:** `electron/main.js` menu template (around lines 3700–3960), `document-menu.js`; `src/components/command-palette.tsx`, `shortcuts-help.tsx`; `src/lib/commands.ts`, `toolbar-shortcuts.ts`, `editor-keymap.ts`; `page.tsx` around line 2166 (the command list).
- **Compatibility:** Events `menu-*` (about 30), `set-mode`, `toggle-stats`.

## 30. Cloud document platform (byte snapshots for office files) [stable, opt-in]

- **What the user can do:** Upload or replace an office document snapshot in the cloud, list cloud documents, manage members and download links.
- **Files:** `src/lib/document-cloud.ts`; `src/components/document-cloud-dialog.tsx` (223), `document-cloud-library.tsx` (116), `cloud-document-editor.tsx`.
- **REST endpoints:** `/api/document-platform/documents[/:id[/members[/:userId]|/links[/:linkId]|/history[/:version]]]`, with body `{schemaVersion: 2, name, format, encoding: "base64", data, sha256, baseVersion, areaId?}`, and `/api/document-platform/links/:token/download`.

## 31. Miscellany

- **Private release gate [nightly]:**
  - No document UI until the build is authorized.
  - IPC `private-release-{status, session, authorize, lock, take-auth-link}`.
  - Uses the `--markie-private-release` and `--markie-desktop-preview` command-line flags.
- **First run:** a welcome document, skipped when the OS handed over a file (`first-run.ts`, `welcome-doc.ts`).
- **Media:** `![](clip.mp4)` becomes a video player (`rehype-media.ts`). Dropped attachments are linked where they live, never copied (`attach.ts`).
- **Asset cache:** cloud document media is cached by hash under `userData/asset-cache` (`cache.json` index).
- **Security posture to keep:**
  - CSP whitelists only the YouTube and Vimeo frame origins (`csp.js`).
  - Origin allowlist for any request carrying a token.
  - Native dialogs for an untrusted share host.
  - Links never launch scripts or apps.

---

## Things that inherently need web content (summary)

1. **Darkmown `.wd` preview.** Compiled HTML/JS runs in a sandboxed iframe.
2. **Live Docs preview.** A running dev server is shown in an embedded view.
3. **YouTube/Vimeo embeds.** Playback needs an iframe; a thumbnail card can be native.
4. **PDF export and print.** Today this is Chromium `printToPDF` over HTML/CSS with KaTeX and highlight.js.
5. **KaTeX math.** This needs either a native TeX renderer or a web view.
6. **Raw inline HTML in Markdown.** Spans with styles, `<img width>`, colours, and sanitized blocks preserved as-is have to be interpreted natively or shown as source.

## Biggest port risks, in order

1. A rich editor that round-trips Markdown byte for byte **and** is wire-compatible with y-prosemirror's XmlFragment `"default"` and the RelativePosition comment anchors.
2. Migrating data out of Chromium localStorage and IndexedDB: tokens, themes, the **vault**, and recovery records.
3. A native office codec port (about 6.5k lines of TypeScript) plus Word page layout.
4. Replacing the updater.
5. Keeping the MCP server, which is Node, working against the same `~/.markie` bridge, the `open -a Markie` launcher, and shared `doc-text` search.
