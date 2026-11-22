# Local features: status against Electron 0.9.7

Written 2026-11-22 for PARITY.md sections 1 to 6, 9, 13 and 28. The reference is the Electron source in `markdown-viewer-zvn` (src/, electron/, mcp/). Logic lives in `rust/crates/markie-core`; the app only wires it.

Status words:

- **Matches**: same rules and output as Electron, checked by a test or by running Electron's own code on the same input.
- **Differs**: built, but deliberately or necessarily not identical. The reason is given.
- **Not built**: missing, with the reason and who owns it.

## How it was checked

| Check | Where |
|---|---|
| Core unit tests | `cargo test -p markie-core` (81 tests, all pass) |
| App tests (Library, Projects rows) | `cargo test -p markie-app` |
| Electron's own code on the same rows | `rust/scripts/parity/local-parity.mjs`, fed by `cargo run -p markie-core --example local_parity` |
| Fixture run of that harness | `.autoloop/runs/local-features/parity-report.txt`: 20 checks, all match |
| Real device index, default 1.8 s budget | `.autoloop/runs/local-features/real-index-report.txt`: 84,361 rows, 31,708 Markdown files, 370 projects. The whole Projects tree matches. One excerpt differed only because Electron's budget ran out before the row Rust reached in time. |
| Real device index, budget lifted on both sides | `.autoloop/runs/local-features/real-index-unbounded-report.txt`: every check matches, and both sides scanned the same number of rows for each query. |
| Values computed in node | `hash8` block ids, the index fingerprint, the Projects.md template byte for byte |

The parity harness runs `mcp/doc-text.cjs` `searchDocuments`, `electron/frontmatter.js`, `electron/mdmeta.js` `findRepoRoot`, and `src/lib/projects/taxonomy.ts` `buildTaxonomy`, unmodified, on the rows Markie RS indexed. It compares result order, name hits, excerpts, every project key and name, every block id and name, every file and its order, and the ignored count.

Screenshots were not possible in this session: `screencapture` was refused ("could not create image from window") and `act.sh` correctly refused input because Kirby's Markie held the front. The on-screen comparison of the Projects tab and ⇧⌘F results is still owed.

## 1. Library panel and Files workspace

| Item | Status | Notes and tests |
|---|---|---|
| Recent list, filters, sort | Matches (shell agent) | Built by the window shell agent in `rail.rs`. |
| Projects tab | Matches | `workspace/projects.rs` mirrors `projects-panel.tsx`: one "Search projects and files" field, projects newest first with Unfiled last, the open document's project open by default, a project you shut stays shut, every match open while searching, the shared folder not repeated under each file, `compactDir` labels, the rules error banner, "Edit how this is organized". Tests: `projects::tests::the_open_documents_project_opens_and_shared_folders_hide`, core `projects::*`. |
| Empty and loading states | Matches | "Still finding your markdown…", "Working out where everything belongs…", "Nothing matches that.", "No projects yet." |
| Move a document | Matches (API) | `workspace_ops::move_into` is `workspace.js` `move`: same root guard, never overwrites ("Already a file with that name there"), and every path-keyed registry table follows (`Registry::move_path`, `move_prefix`). Electron 0.9.7's renderer never calls `ws-move` (Projects replaced the Folders tab), so there is no UI to match. Test: `workspace_ops::tests::moves_files_and_folders_with_their_registry_rows`. |
| Rename | Matches (API) | `workspace_ops::rename` with `sanitize_name`. The dialogs agent's rename UI in `file_ops.rs` does not call it yet, so registry rows other than the recent do not follow a rename from the UI. |
| Remove a workspace folder | Matches (API) | `workspace_ops::remove_root` only unregisters; nothing on disk changes. No UI in Electron 0.9.7 either. |
| New document, drop to import, trash, reveal, sync on/off, cloud area picker | Not mine | File operations (dialogs agent) and cloud (cloud agent). |
| Recovery records from IndexedDB | Not mine | Migration agent (`markie-migrate`). |

## 2. Local registry

| Item | Status | Notes and tests |
|---|---|---|
| `files`, `workspace_roots`, `md_stars` | Matches | Existing `registry.rs`. |
| v1 tables `md_meta`, `project_pins`, `project_blocks`, `project_assignments`, `projects_config` | Matches | `projects/store.rs`, column for column, created idempotently in Markie RS's own `registry.db`. Test: `store::tests::decisions_round_trip_and_survive_upserts`. |
| v2 table `projects` | Matches | Same file. A blank rename clears it, as in `projectSetName`. |
| `blockUpsert` never overwrites a user's name or merge | Matches | Same test. |
| Index fingerprint | Matches | `store::index_fingerprint`, vector from node. Test: `fingerprint_matches_electron`. |
| `movePath` / `movePrefix` over every path-keyed table | Matches | `Registry::move_path`, `move_prefix`. |
| `md_index_cache`, `skill_sources`, `skill_installs`, `PRAGMA user_version` | Differs | Markie RS keeps its index snapshot as one JSON row (`rs_index_snapshot`) and never sets `user_version`, because it never opens Electron's database. Skills tables belong to the skills agent. |

## 3. Browse: the device-wide index

| Item | Status | Notes and tests |
|---|---|---|
| Walk budget, exclusions, bundles, iCloud folders, agent tool folders | Matches | Existing `index.rs` (phase 0). |
| Every type indexed and filterable per type | Matches | Twelve formats, `FormatKind::OPENABLE`; the type menu and chips are the shell agent's. |
| Front matter `markie: { project, block }` | Matches | `projects/frontmatter.rs` is `electron/frontmatter.js`, same boundary regex as `front-matter.ts`. Test: `frontmatter::tests::reads_block_and_inline_forms`. |
| Repository detection incl. worktrees | Matches | `projects/meta.rs` is `mdmeta.js`: nearest `.git` up to home, worktree pointers resolve to the parent repo, submodules stay their own. Tests: `meta::tests::*`. |
| Incremental metadata (only moved mtimes re-read) with a time budget | Matches | `refresh_meta`. |
| Star toggle, full-path toggle, rescan on focus | Not mine | Shell agent. |

## 4. Projects: the virtual taxonomy

| Item | Status | Notes and tests |
|---|---|---|
| Assignment ladder: pin, front matter, rule, derived | Matches | `projects/assign.rs`. Test: `ladder_order_pin_frontmatter_rule_derived`. |
| Containers: defaults, discovered (three repos), `containers` / `not_containers` | Matches | `discover_containers`, `container_child`. Tests in `assign.rs`. |
| Rules YAML in `Projects.md` (`markie_rules`), validation messages, last-known-good fallback | Matches | `projects/rules.rs` with `serde_yaml`; the error strings are Electron's. Tests: `rules::tests::*`, `compute_end_to_end_keeps_decisions`. |
| Globs (`~`, `*`, `**`, everything else literal) and `{repo}` / `{folder}` | Matches | `compile_glob`, `CompiledRules`. |
| Work-session clustering, bulk-write guard, concentration limit, path and gap splits, block cap | Matches | `projects/cluster.rs`, a line-by-line port. Tests: `cluster::tests::*`. |
| Deterministic block ids | Matches | `hash8` reproduces the JavaScript djb2-xor over UTF-16 units. Vectors from node; ids equal on the parity run. |
| Block names (folder, dominant branch, humanized newest stem, "Work session <date>") | Matches | Parity run. |
| Taxonomy: blocks of one dissolve, decisions keep theirs, user-made empty projects, Unfiled last | Matches | `projects/taxonomy.rs`. Tests: `taxonomy::tests::*`. |
| `filterTaxonomy` | Matches | `filter_taxonomy`. |
| Pin, rename block, merge block, rename project, create project | Matches (API) | `store::pin_set`, `pin_clear`, `block_set_name`, `block_merge`, `project_set_name`, `project_create`. Electron's panel exposes none of these in 0.9.7 either; they are IPC only. |
| Write overview below the marker | Matches (API) | `config::write_overview_section`. Electron's renderer never calls it in 0.9.7. |
| Projects.md template | Matches | Byte-compared with `DEFAULT_PROJECTS_MD`. |
| Creating Projects.md | Differs | Electron writes the template when the tab asks for the config. Markie RS reads an existing one and writes the template only when the user clicks "Edit how this is organized", so the side build never creates a file in Documents unasked. `MARKIE_RS_DOCUMENTS_DIR` points it at scratch. |
| Audit gates (`audit.ts`) | Not built | A developer script, not a user feature. |

## 5. Global search

| Item | Status | Notes and tests |
|---|---|---|
| Text extraction for Markdown, Darkmown, text, CSV, JSON, YAML, XML, HTML, Word, ODT, RTF | Matches | `doc_text.rs` ports `mcp/doc-text.cjs`: per-format byte ceilings, ZIP part reader with an inflate ceiling, DOCX and ODT XML rules, HTML script and style removal, the RTF reader with CP1252 and `\u`, UTF-16 BOMs. Legacy `.doc` is found by name only, as in Electron. Tests: `doc_text::tests::*`. |
| Text cache by (path, mtime, size) with a 48 M character budget | Matches | `TextCache`, `SHARED_CACHE`. |
| Ranking: every term in name, or path, or body; score name 4, body 2, path 1; newest first; 1.8 s budget; stop at three times the limit | Matches | `search_documents`. Parity runs: order, name hits and excerpts match on six fixture queries and four queries over the real index. Within the same 1.8 s, Rust can reach more rows than Node, so on a very large index it may return an excerpt where Electron returns none. |
| Excerpts with marks | Differs (by design) | Same 70-character window. Marks are byte ranges into the excerpt, not UTF-16 offsets, because GPUI highlights by byte. |
| Recent files outside the walk join the pool | Matches | `search_pool`, built once per scan. |
| Supersede: a newer search stops an older one | Matches | Generation counter. The app also drops a stale answer (`Library::set_body_results`). |
| ⇧⌘F wiring | Matches | The shell's search overlay keeps its instant name filter, then swaps in the ranked body results after a 120 ms pause. Test: `library::tests::body_results_replace_the_instant_filter_until_the_query_moves`. |
| Type chips | Matches (shell agent) | The chips feed `formats`. |
| Term highlighting inside excerpts | Not built | The marks are delivered on `Hit::marks`; drawing them is the search panel's look (shell agent). |
| Hot path note for the performance agent | | `doc_text::search_documents` and `extract_search_text` are the hot paths. The pool is an `Arc<Vec<SearchRow>>` shared, never cloned per query. |

## 6. Open and save pipeline

| Item | Status | Notes and tests |
|---|---|---|
| Format table | Matches | `formats.rs`, unchanged. |
| Size tiers: 1 MB source only, 100 MB refused, both "at or above" | Matches | `document.rs`, same thresholds as `doc-tiers.js`. |
| Text decoding: BOMs, newline style, refusing UTF-32 and binary | Matches | Existing `formats.rs` tests. |
| Office files through the engine, untouched bytes kept | Matches | `office.rs` save writes the engine export. |
| HTML: converts to a TXT copy with consent | Differs | Built this round: a banner with Electron's wording and "Create text copy", using the office crate's `convert_additional_document`. Electron keeps the copy in its in-app library; Markie RS writes `<name> converted.txt` beside the source, never over a file, like its DOC copy. |
| Save As, duplicate, reveal, copy path, watcher | Not mine | File operations (dialogs agent); the watcher is done (phase 1 item 2). |

## 9. Autosave for office documents

| Item | Status | Notes and tests |
|---|---|---|
| Autosave with Markdown's rules (1 s idle, at most 5 s while typing) | Differs | Built as the brief asks: an edit in the Word view schedules the same `Autosave`, and the save goes through the engine (`office_autosave`), never opening a dialog. Electron itself does not autosave office files to disk: it writes a recovery revision 600 ms after each change and the file only on ⌘S. |
| Recovery revision 600 ms after a change | Matches | `office.rs` `on_office_changed` with `RECOVERY_DEBOUNCE_MS`. |
| Closing flushes pending saves | Matches | Built this round for every document: `on_app_quit` and the window's should-close hook run the no-dialog autosave (`flush_pending`). Markie RS used to quit without it. |

## 13. Version history for office documents

| Item | Status | Notes and tests |
|---|---|---|
| Recovery history: revisions on open, on edit, on save | Matches | `office_recovery.rs` follows `document-library/repository.ts`: five per document, 32 MB per document, 128 MB in all, eviction of the oldest and never the newest, identical bytes not stored twice, revision numbers never reused. Stored under `<data>/document-recovery/`. Tests: `office_recovery::tests::*`. |
| List, newest first | Matches | The history panel shows office revisions with their time. |
| View a revision | Differs | Electron has no preview; Markie RS shows the revision's words (extracted with `doc_text`) in the existing read-only preview. |
| Restore makes a newer revision | Matches | `RecoveryStore::restore`. |
| Restore leaves the file unchanged | Differs | Markie RS writes the restored bytes at once, because with autosave on the file would be written a second later anyway. |
| History follows a rename or move | Not built in the UI | `RecoveryStore::moved` exists; `file_ops.rs` (dialogs agent) does not call it yet. |
| Markdown history (text versions, retention, names) | Matches | Existing `history.rs`; the diff view is the dialogs agent's. |

## 28. Settings: presets and typography

| Item | Status | Notes and tests |
|---|---|---|
| Eight templates, light and dark | Matches | `theme.rs` reads the same `templates.json` the app paints from. Test: `eight_templates_with_their_typography`. |
| Template typography (body and heading face, line height, paragraph gap, size, width) | Matches (data) | `typography_of` with Electron's clamps, `TYPEFACES` as native family lists. Test: `typography_is_clamped_and_unknown_faces_fall_back`. |
| Custom presets: fork on first colour edit, per-tone overrides, edit in place, delete, choose, reset | Matches (logic) | `ThemeStore` with `markie.themes.v1`'s JSON shape and `normalizeThemeStore`'s legacy handling. Tests: `store_transitions_match_theme_ts`, `legacy_stores_normalize`. |
| Painting typography in documents | Not built | The rich editor hard-codes 16 px and the theme face (`markie-editor/src/render.rs` `look`). The editor agent can read `ThemeStore::painted(tone)`. |
| Settings UI for presets and typography | Not built | Dialogs agent (`settings.rs`). The store is not yet persisted by the app; the natural key is a registry setting `themes.v1` holding `ThemeStore::to_json()`. |
| Theme sync, pinned document themes | Not mine | Cloud agent. |

## Safety notes

- Every run used fixtures under the session scratchpad, a scratch `HOME` and a scratch `MARKIE_RS_DATA_DIR`. No file of Kirby's was moved, renamed, trashed or written.
- One leak to fix for everyone: the device index also walks `$CLAUDE_CONFIG_DIR/skills`, and agent shells export `CLAUDE_CONFIG_DIR` pointing at a real seat folder. A Markie RS instance started with a scratch `HOME` therefore still indexed real skill files from `~/.claude-seats/sam/skills`. Nothing was opened or captured; the instance was closed by PID and its scratch registry deleted. Unset `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when launching scratch instances.
- The real-index parity run read the home folder through the index only, and kept a summary without paths.
- The worktree has a `node_modules` symlink to the reference repo for `rust/scripts/ts-run/register.mjs`. It is gitignored and not committed.

## Open items

1. On-screen comparison of the Projects tab and ⇧⌘F against Electron, once screen capture is allowed.
2. Draw `Hit::marks` highlighting in the search overlay (shell agent).
3. Paint template typography in the rich editor (editor agent) and persist `ThemeStore` from Settings (dialogs agent).
4. Call `workspace_ops::rename` and `RecoveryStore::moved` from the rename and duplicate UI (dialogs agent).
5. Decide whether office autosave should write the file (this build) or only recovery revisions (Electron). It is a product call for Kirby.
