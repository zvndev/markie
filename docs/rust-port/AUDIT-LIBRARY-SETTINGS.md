# Audit: Library, registry, Browse, Projects, search, open and save, settings, menus

Written 2026-11-22 against Electron Markie 0.9.7 (`markdown-viewer-zvn` at ae62cfa, read only). Branch `t3/markie-rs-library-settings-parity`, from `rust/markie-rs` at 3b6f6c0. Sections 1 to 6, 28 and 29 of PARITY.md.

## Score

**Parity: 114 of 117 = 97.4 % (94 PASS and 20 IMPROVEMENT; 3 NEEDS-CAPTURE), after the five Settings › Agents and page polish rows (28.A1, 28.A2, 1.P1, 1.P2, 29.P1, 2026-11-25), and before them the nine Markdown style and font rows of 2026-11-24 (end of this file), Back and Forward (29.12, 2026-11-25) Markie's own folders in Projects (4.P1 to 4.P5, 2026-11-25) and the six Google Docs import rows (28.G1 to 28.G6, 2026-11-25). Before them: 91 of 91.** Row 3.1 became an IMPROVEMENT on 2026-11-23 (branch `t3/markie-rs-browse-ux`): Browse is a page, not Electron's narrow panel. Row 1.2 became one the same day (branch `t3/markie-rs-home-pages`): Recent is a page of document cards, and a launch with no file opens on it. Rescored on 2026-11-22: Kirby excluded the database layout rows (2.2, 2.3, 2.8), which nothing a user sees depends on.

| Count | Rows |
|---|---|
| All rows | 96 |
| PASS | 89 |
| IMPROVEMENT | 2 (3.1: Browse is a page with a folder tree and the folder's contents; 1.2: Recent is a page of document cards) |
| FAIL | 0 |
| NEEDS-CAPTURE | 0 |
| EXCLUDED | 4 (2.2, 2.3, 2.8 and the earlier one) |
| EXCLUDED-PLATFORM | 1 |

The score is (PASS + IMPROVEMENT) ÷ (all rows − EXCLUDED − EXCLUDED-PLATFORM). IMPROVEMENT means Markie RS deliberately differs to fix a flaw in Electron, and counts as meeting parity (SCORE.md). The schema rows 2.2, 2.3 and 2.8 were FAIL until Kirby excluded them on 2026-11-22.

After the merge of `rust/markie-rs` at e8e8e07, rows 2.9, 2.10 and 29.7 pass with the other auditors' work, and their roll-ups 29.1 and 29.2 pass with them.

Rows that failed and were fixed in this audit: 1.2, 1.3, 1.5, 1.7, 1.8, 1.11, 1.12, 2.1, 3.1, 6.2, 6.3, 6.4, 28.6, 29.3, 29.4, 29.5 and 29.8. Rows 28.2a and 28.2b were fixed in code; their look still needs a capture. Rows 1.6 and 28.2 pass since the cloud audit merged (in-place row sync actions; the full Servers section).

## Method

- One row per bullet and sub-bullet of the eight sections, in PARITY.md's order. A heading bullet ("What the user can do", "Files", "Compatibility") is a roll-up row: PASS only when every row under it is PASS or EXCLUDED.
- A "Files" or "IPC" row lists code, not behaviour. It is PASS when every item listed has a Markie RS counterpart named in the row. The behaviour itself is judged in the rows that describe it.
- Behaviour was proved three ways:
  - Electron's own code run in Node on the same input as Markie RS. The fixture is `rust/crates/markie-app/src/fixtures/library-settings-parity.json`, written by `rust/scripts/parity/library-settings-parity.mjs` (palette ranking and the Library query). `rust/scripts/parity/local-parity.mjs` covers search and Projects.
  - Rust tests named in each row.
  - Reading both code paths, cited by file and line.
- Screen: `IOConsoleLocked = Yes` for the whole run. No app was launched, captured or driven. The captures owed are listed at the end.

## Fixes made in this audit

| Commit | What |
|---|---|
| 6afa546 | `~/Documents/Markie` made and registered when no live root exists. "Welcome to Darkmown.wd" offered there once. `PRAGMA user_version = 2` with the v1 and v2 project tables made at open. |
| c8bd750 | Recent list filters and sorts like `queryLibraryDocuments`. The type menu gains "Other". Drops on the window and on the Library open files. A launch with no file shows the welcome document once, then an empty page, and never reopens the last file. The index walks again on window focus, at most every five minutes. |
| 916b4d2 | Menu bar laid out as Electron's template, with an Edit menu, Save As ⇧⌘S and History greyed until versions exist. Edit commands reach the focused editor. The palette gains the 20 commands it lacked, filtered by the open document. |
| 989f895 | Themes follow the account through `/api/me/themes`. Settings › Advanced › Servers shows the real session and every trusted server. |
| 566df22 | Members of a shared Markie Cloud document read it in the owner's pinned theme, with the "Owner theme" chip. |
| 228d4c4 | Recent files that are gone stay listed as "Missing on disk", with Remove from Library. |
| d5f1253 | A size-tier test against `doc-tiers.js`, and this report. |
| 535badf | Merge of `rust/markie-rs` (cloud, office and platform audits), conflicts resolved as its message lists. |
| ac0bea6 | Settings › Advanced: the checkboxes stay on the panel and the descriptions wrap (found by the cloud auditor). |
| 220da82 | The Library's own "Upload destination" picker, used by a row's Sync to cloud. |
| 9bf5837 | Merge of `rust/markie-rs` at e8e8e07. One menu bar (`menus.rs`) carries every auditor's items in Electron's places, one Edit menu, one palette list. |

Shared files touched, kept small, for the other auditors:

- `workspace/account.rs`: `backend` and `run_bg` made visible to sibling modules. Nothing else changed.
- `workspace/cloud.rs`: one call to `pull_cloud_themes` at the end of `on_account_changed`.
- `workspace/collab.rs`: `release_doc_theme` in `collab_on_open`, and `check_doc_theme` once members resolve.
- `markie-core/src/registry.rs`: `Registry::forget`, and the PRAGMA and project tables at open.
- `workspace/cloud_page.rs` and `workspace/share.rs`: `render_area_create` and `create_cloud_area` take an `AreaTarget` (Page, Share, Library) instead of a bool. `select_button` made visible.
- `workspace/first_run.rs` (from the cloud audit): its welcome text and seen key now come from `welcome.rs`, which holds Electron's text byte for byte. Its own copy had replaced Electron's dashes.

## 1. Library panel and the Files workspace

| # | Bullet | Status | Evidence (Electron / Markie RS / test) | Notes |
|---|---|---|---|---|
| 1.1 | What the user can do | PASS | Roll-up | |
| 1.2 | Library lists recent and opened files with their sync state | IMPROVEMENT | `library.tsx` fileRow; `library.rs` set_lists, `library_rows.rs` sync_status_icon; `states_map_from_the_cloud_badge`, `recent_files_that_are_gone_stay_listed_as_missing`; `recent_page.rs`, `doc_grid.rs`, `doc_preview.rs`; `recent_page::tests` (9), `doc_grid::tests` (6), `doc_preview::tests` (10); scenes `recent`, `launch`, `library` in SCREEN.md, before and after in `.autoloop/runs/home-pages/` | Fixed: files gone from disk were hidden. They now show "Missing on disk". Deliberately differs (2026-11-23, `t3/markie-rs-home-pages`): Electron lists recent files only as names in a 252 px panel, so documents look alike, and a launch with no file shows an empty page. Markie RS adds a Recent page in the document area: cards that show the start of each document, grouped Today, This week and Earlier, with Starred as a filter, grid or list, and "Missing on disk" with Remove. A launch with no file opens on it (the first launch still shows the welcome document), and it is one click away on the rail. The Library panel's Recent list stays, reading the same list through the same filter, type and sort. |
| 1.3 | Filter by type; sort by name, recency or type | PASS | `library-document-query.ts`; `library.rs` query_rows; `recent_query_matches_electrons_query_library_documents` (112 cases from Electron's code), `the_recent_tab_filters_without_ranking_or_reading_bodies` | Fixed: ranking, snippet search, label-based Type sort, recency by mtime, missing "Other". |
| 1.4 | Create new documents (Markdown, Word, text, Darkmown, Locked vault) | PASS | `new-document-modal.tsx:16-25`; `file_ops.rs` WRITING_TYPES and DATA_TYPES, `copies_and_renames`; palette `commands_follow_electrons_list` | Same ten types, labels and descriptions. Locked vault comes from the Vault page (section 22) and the palette's "Open Vault", as in Electron. |
| 1.5 | Drop files to import them | PASS | `library.tsx:387` onDrop, `page.tsx:1701` handleDrop; `file_ops.rs` library_drop_paths, window_drop_target; `drops_open_what_electron_opens` | Fixed: no drop handling existed. The Library notice uses Electron's wording. |
| 1.6 | Per-row menu: rename, move, Trash (optionally the cloud copy), reveal, sync on/off | PASS | `library.tsx:608` rowMenuEntries; `library_rows.rs` row_entries_for, run_row_action; `each_state_offers_electrons_sync_action`, `a_file_that_is_gone_is_removed_from_the_library_not_deleted`, `a_cloud_copy_without_its_file_offers_download` | Entries, order, tones and separators match. 0.9.7's menu has no rename, move or reveal, so neither does Markie RS. The sync actions run in place since the cloud audit (f6e11d5, merged). |
| 1.7 | Pick a cloud upload destination ("area") | PASS | `library.tsx:884`, `cloud-area-picker.tsx`; `library_area.rs`; `the_picker_names_the_chosen_area_or_the_default_cloud` | Fixed: the Library used the Cloud page's area filter. It now has its own picker, with "Default cloud", the areas and New area, reset on an account change. |
| 1.8 | Projects tab, Files workspace roots, Settings › Files (default folder `~/Documents/Markie`) | PASS | `workspace-default.ts`, `workspace.js:62`; `workspace_ops.rs` ensure_default_root, `projects.rs`; `the_default_root_is_made_only_when_no_live_root_is_registered`, `the_outline_nests_folders_then_files_then_unsorted` | Fixed: the default folder was never made or registered. |
| 1.9 | Files | PASS | Roll-up | |
| 1.10 | Renderer components | PASS | library.tsx → `rail.rs`, `library.rs`; projects-panel → `projects.rs`; file-menu → `library_rows.rs`; filters → `rail.rs` select_button; new-document-modal → `file_ops.rs`; activity-bar → `rail.rs`; panel-resizer → `rail.rs` panel_width; panel-notice, format-badge, document-format-mark → `rail.rs`, `icons.rs`; cloud-area-picker → `cloud_office.rs` | |
| 1.11 | Renderer libs | PASS | library-overview → `rail.rs` band; library-state, library-document-query → `library.rs`; left-rail → `rail.rs` LeftView; folder-tree → `folder_tree.rs`; first-run, welcome-doc → `welcome.rs` (new); document-library → `office_recovery.rs` | Fixed: first run and the welcome document were missing. `the_welcome_is_electrons_text`, `the_welcome_shows_once_and_never_over_a_file`. |
| 1.12 | Main: workspace.js, examples.js | PASS | `workspace_ops.rs`; `seed_examples`; `the_darkmown_example_is_offered_once_and_never_overwrites` | Fixed: the example was never seeded. Same id, name, bytes and marker file. |
| 1.13 | Compatibility | PASS | Roll-up | |
| 1.14 | IPC ws-* | PASS | `workspace_ops.rs` live_roots, ensure_default_root, remove_root, move_into, rename; `file_ops.rs` trash, reveal; `paths::default_root` | `ws-list-dir`, `ws-mkdir` and `ws-new-file` have no caller in 0.9.7's renderer. |
| 1.15 | IPC library-state, library-trash-file, registry-track, registry-get, registry-set-role, events | PASS | `workspace.rs` refresh_lists; `file_ops.rs` trash; `Registry::track_opened`, `forget`; `cloud.rs` share_role | |
| 1.16 | Data: `files`, `workspace_roots`, IndexedDB recovery records | PASS | `registry.rs:73-90`; `recents_roots_stars_settings` | The IndexedDB records are the "Recovered from Markie" list, excluded by Kirby. Markie RS's own office recovery is `office_recovery.rs`. |
| 1.17 | Cloud areas REST | PASS | `account-identities.ts:141-151`; `markie-cloud/src/platform.rs` areas, create_area, place; `sync.rs` sync_on_in_area | GET, POST and the snapshot placement are built. Electron's renderer calls `place` only for snapshots (`document-cloud-dialog.tsx:196`). A Markdown document's area travels with sync-on, as Electron's `areaId` does. |
| 1.18 | Rust port note: recovery records out of IndexedDB | EXCLUDED | | The "Recovered from Markie" list, Kirby's decision. |

## 2. Local registry

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 2.1 | Files: registry.js, WAL, `registry.db`, `PRAGMA user_version` 2 | PASS | `registry.rs:71` WAL, `paths::data_dir()/registry.db`; `user_version_is_three_with_the_project_and_folder_tables` (3 since Markie's own folders, 4.P1) | Fixed: user_version was never set. |
| 2.2 | Schema to keep exactly | EXCLUDED | Roll-up | 2.3 and 2.8 fail. Rescored EXCLUDED (Kirby, 2026-11-22: the database layout is internal; nothing a user sees or does depends on it). |
| 2.3 | `files(…)` with all columns | EXCLUDED | `registry.js:72-170`; `registry.rs:73` | Markie RS's `files` has path to share_role. The cloud columns (share_role_user, assets_*, links_*, cloud_origin) live as one JSON record per path in `rs_cloud_sync` (`markie-cloud` SyncRecord). Blocker: the identical table only matters for opening Electron's database in place, which the side-build rules forbid. Migration reads Electron's file through `markie-migrate`. Recommend Kirby mark it EXCLUDED. Rescored EXCLUDED (Kirby, 2026-11-22: the database layout is internal; nothing a user sees or does depends on it). |
| 2.4 | `sync_state` values | PASS | `markie-cloud/src/sync.rs:10,22` kebab-case SyncState; `push_only_from_synced_or_unpushed` | |
| 2.5 | `cloud_origin` NULL is Markie Cloud; legacy aliases rewritten | PASS | `origin.rs` canonical_cloud_origin; `allowed_server_origin`, `trusted_list_replaces_the_pin` | |
| 2.6 | `workspace_roots(path, added_at)` | PASS | `registry.rs:84`; `recents_roots_stars_settings` | |
| 2.7 | `md_stars(path, kind, added_at)` | PASS | `registry.rs:88`; same test | |
| 2.8 | `md_index_cache(path, name, mtime_ms)` | EXCLUDED | `registry.rs:93` rs_index_snapshot | Same role, one JSON row. Same blocker and recommendation as 2.3. Rescored EXCLUDED (Kirby, 2026-11-22: the database layout is internal; nothing a user sees or does depends on it). |
| 2.9 | `skill_sources` | PASS | `registry.js:96-99`; `markie-agent/src/skills.rs:360` SKILL_TABLES, ensure_skill_tables at registry open (`workspace.rs`); `the_registry_gets_electrons_skill_tables` | Agents audit. Same columns as Electron. |
| 2.10 | `skill_installs` | PASS | `registry.js:100-121`; same | Agents audit. Same columns, `root` included. |
| 2.11 | v1 tables | PASS | `projects/store.rs:23-60`; `decisions_round_trip_and_survive_upserts` | Created at open now. |
| 2.12 | v2 `projects` | PASS | `projects/store.rs:60`; same test | |
| 2.13 | Windows paths lowercased (`canonicalPath`) | EXCLUDED-PLATFORM | `registry.rs:54` | Built, untested on macOS. |
| 2.14 | Rust port note: PRAGMA-guarded, idempotent migrations | PASS | `CREATE TABLE IF NOT EXISTS` throughout; `user_version_is_three_with_the_project_and_folder_tables` reopens the file | |

## 3. Browse

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 3.1 | Browse every document, star, filter, sort, full paths, refresh, rescan on focus at most every 5 min | IMPROVEMENT | `browse-view.tsx`, `main.js:929`; `rail/browse.rs`, `rail/browse_page.rs`, `folder_tree.rs`, `workspace.rs` rescan_on_focus; `rail::browse::tests` (14), `folder_tree::tests`, `focus_walks_again_only_after_five_minutes`; scenes `browse` in SCREEN.md, before and after in `.autoloop/runs/browse-ux/` | Deliberately differs: Electron's 252 px panel cut names short, lost the place in a deep tree, listed same-named matches with no path, and never said what was listed or when it was checked. Markie RS shows "Documents on this Mac" as a page: counts and last check in the header, a folders-only tree, the chosen folder's contents with a breadcrumb, matches with their folder and the word marked, and arrow keys, Return and Escape. Every function is kept (index, rescan, rescan on focus, type filter, name filter, sort, stars, open and closed folder memory, Add Folder). The full-path toggle is gone because the path is always shown (breadcrumb, match rows, tooltips). New: the row menu on documents, and a count of documents found while a scan runs. Electron's Browse may not be captured (SCREEN.md rule 7). |
| 3.2 | Files | PASS | mdindex.js → `index.rs`; mdmeta.js → `projects/meta.rs`; frontmatter.js → `projects/frontmatter.rs`; skill-frontmatter.js → `markie-agent/src/skills.rs`; browse-view → `rail/browse.rs`, `rail/browse_page.rs` | |
| 3.3 | Compatibility | PASS | Roll-up | |
| 3.4 | IPC mdindex-*, `MdRow` | PASS | `index.rs` scan, `IndexedDoc`; `Registry::toggle_star`, `stars` | |
| 3.5 | Walk budget 200k, 30 s, depth 24, 4000 snippets, 8 KB, under 256 KB | PASS | `mdindex.js:27-28`; `index.rs:18-19,66-71`; `stops_at_the_file_budget` | |
| 3.6 | Exclusions | PASS | `mdindex.js:94-113`; `index.rs:169`; `finds_every_openable_type_and_prunes_noise` | |
| 3.7 | Always-scanned tool folders | PASS | `mdindex.js:157-191`; `index.rs:140-160`; same test | |
| 3.8 | Front matter `markie: { project, block }` | PASS | `frontmatter::tests::reads_block_and_inline_forms`; `.autoloop/runs/library-settings/parity-report.txt` | |
| 3.9 | Rust port note: extension list in step with section 6 | PASS | `FormatKind::OPENABLE`; `classifies_like_the_electron_table` | |

## 4. Projects

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 4.1 | Auto-cluster; pin, rename, merge, create; write overview | PASS | `projects/*`; `cluster::tests::*`, `taxonomy::tests::*`, store tests; parity report "projects tree … all match" | Pin, rename, merge, create and overview are IPC-only in 0.9.7, so API-only here too. Since 4.P4, automatic grouping runs only when Settings turns it on, and only over files no folder holds. |
| 4.2 | Files | PASS | cluster, taxonomy, rules, assign, search → `projects/*.rs`; projects-config.js → `projects/config.rs` | `audit.ts` is a developer script, not a feature. |
| 4.3 | IPC projects-*, config rewritten below the marker, YAML rules | PASS | `config::write_overview_section`, `rules.rs`; `rules::tests::*`, `compute_end_to_end_keeps_decisions` | |
| 4.4 | Rust port note | PASS | as 4.1 | |
| 4.P1 | Markie's own folders: nested to any depth, a manual order for subfolders and files, a file in at most one folder, nothing on disk moved | IMPROVEMENT | `markie-core/src/projects/folders.rs` (tables `folders`, `folder_items`, `folder_released`, registry `user_version` 3); `folders::tests::*` (nine tests); `registry::tests::user_version_is_three_with_the_project_and_folder_tables`; `projects::tests::a_move_carries_every_record` (a renamed file keeps its folder) | New in Markie RS (2026-11-25, `t3/markie-rs-projects-folders`). Electron's tab only showed automatic groups and an "Edit how this is organized" link to `Projects.md`, so a person who does not use agents could not organize anything. Projects now shows the folders a person makes, then Unsorted: recent files and files that left a folder. |
| 4.P2 | Organize by hand: New Folder (top level or inside), rename inline (double-click or Return), Delete Folder with a confirm, Move to…, Remove from Folder, Open, Show in Finder, New Document Here, Add Files…, a missing file with Locate… and Remove; each from the keyboard and a right-click menu, each undone with ⌘Z | IMPROVEMENT | `workspace/projects.rs` (actions, `Selection`, `menu_entries`, `delete_message`, `destinations`), `workspace/projects_view.rs` (outline, keys, menu, dialogs); `folders::tests::undo_and_redo_every_organize_action`; `projects::tests::*` (13 tests); scenes `projects-tree`, `projects-menu-file`, `projects-menu-folder`, `projects-confirm`, `projects-moveto`, `projects-rename`, `projects-search`, `projects-empty`, light and dark | The delete confirm says the folder's files go back to Unsorted, folders inside it are deleted too, and nothing is deleted from disk. A file's menu keeps Make Private… in its own group. |
| 4.P3 | Drag and drop: a file or folder into a folder, reordering with an insertion line, back out to Unsorted, several at once with ⌘-click and ⇧-click; files from Finder added to a folder without moving; a drag over the Projects tab opens it | IMPROVEMENT | `projects::zone_for`, `target_for`, `drop_allowed`; `folders::drop_items`; tests `drop_zones_and_targets`, `a_folder_never_drops_into_itself_or_its_insides`, `drops_beside_rows_and_back_to_unsorted`, `cmd_and_shift_clicks_select_like_finder`; scenes `projects-drag-into`, `projects-drag-insert` | The drop highlight and insertion line are drawn from state in the scenes; a real trackpad drag needs a scheduled screen session. |
| 4.P4 | Automatic grouping off by default, one switch in Settings › Agents since 28.A1 ("Organize files into projects automatically"); an install with groups converts them once into folders and turns it off | IMPROVEMENT | `folders::migrate_from_taxonomy`, `projects::compute`; `projects::tests::a_new_install_starts_with_no_folders_and_grouping_off`, `an_install_with_groups_converts_them_once_into_folders` (made-up registries); `projects_view::render_auto_organize_setting` | Projects.md (`open_projects_config`) is kept for automatic grouping; Settings › Agents › "Organizing rules for Projects" opens it. |
| 4.P5 | Recent and Cloud pages: select several documents (⌘-click, ⇧-click, ⌘A, ⇧-arrows, Space, a checkbox on hover; Escape clears), a bar with Move to Folder…, Remove from Folder, Star and Open, one ⌘Z each; selected cards drag onto a folder | IMPROVEMENT | `doc_grid.rs` (`DocGridState::selection`, `check_box`), `recent_page.rs` (`render_bulk_bar`, `BulkUndo`, `star_flips`), `cloud_page.rs` (`render_cloud_bulk_bar`, `cloud_only_note`); tests `star_stars_the_rest_or_unstars_all_and_the_bar_counts`, `cloud_only_documents_say_why_they_cannot_go_in_a_folder`; scenes `recent` with `select`, grid and list, light and dark | The selection survives switching between grid and list. On the Cloud page only documents with a file on this Mac move; the bar says why the others cannot. |

## 5. Global search

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 5.1 | ⇧⌘F, type chips, term highlighting | PASS | `global-search.tsx`; `rail.rs` search overlay; `highlights_merge_like_global_search`, `cmd_shift_f_searches_all_documents_inside_the_source_editor`; parity report: five queries match order, name hits and excerpts | Electron's search may not be captured (rule 7). |
| 5.2 | Files: doc-text.cjs shared with the MCP | PASS | `doc_text.rs`; `doc_text::tests::*` | |
| 5.3 | IPC doc-search → DocumentSearchResponse | PASS | `doc_text::SearchResponse`; `ranks_name_body_path_like_electron` | |
| 5.4 | Rust port note: parity tests if search moves to Rust | PASS | `rust/scripts/parity/local-parity.mjs` runs `mcp/doc-text.cjs` itself; `.autoloop/runs/library-settings/parity-report.txt` "all match" | |

## 6. Open and save pipeline

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 6.1 | What the user can do | PASS | Roll-up | |
| 6.2 | Open from dialog, drop, Finder or `open -a`, command line, second instance | PASS | `main.rs` on_open_urls, `instance.rs`, `open_urls.rs`; `instance` and `open_urls` tests, `drops_open_what_electron_opens` | Drop fixed. |
| 6.3 | Save ⌘S, Save As ⇧⌘S, rename, duplicate ⇧⌘D, reveal ⌥⌘R | PASS | `page.tsx:1187` handleSaveAs; `untitled.rs` save_as, `office.rs` write_to; `electron_accelerators_reach_their_items`, `file_menu_matches_electron`, `copies_and_renames` | Fixed: no Save As. It writes what is on screen, opens the new file, keeps CSV's first table with Electron's note. |
| 6.4 | Copy the file path or the whole contents | PASS | palette "Copy File Path", "Copy Document Contents"; `chrome.rs` copy_all; `commands_follow_electrons_list` | Copy Document Contents was missing from the palette. |
| 6.5 | 1 s polling watcher for outside edits | PASS | `main.js:726-744`; `workspace.rs` 1 s timer; `own_writes_are_quiet_and_others_are_reported` | |
| 6.6 | Files | PASS | Roll-up | |
| 6.7 | Main files | PASS | open/save → `document.rs`, `save.rs`; document-files → `office.rs`; atomic-write → `save.rs`; disk-memory → `disk.rs`; doc-tiers → `document.rs`; doc-names → `file_ops.rs`; dialog-start → `default_dir`; file-grants → not needed, there is no renderer to grant across | |
| 6.8 | Renderer files | PASS | document-formats → `formats.rs`; use-document, document-session → `workspace.rs`; native-document-files → `office.rs` | |
| 6.9 | Format table, identical in three places | PASS | One `FormatKind` table serves index, open and search; `classifies_like_the_electron_table` | |
| 6.10 | md, markdown, mdx → markdown | PASS | same test | |
| 6.11 | wd → darkmown | PASS | same test | |
| 6.12 | txt, text, log → text | PASS | same test | |
| 6.13 | csv, json, yaml, yml, xml → literal text | PASS | same test | |
| 6.14 | docx, doc, rtf, odt → byte engine | PASS | `office.rs`; `office_and_unknown_files` | |
| 6.15 | html, htm → TXT copy with consent | PASS | `import_copy.rs`; `import_copy::tests` | |
| 6.16 | Size tiers 1 MB source only, 100 MB refused | PASS | `doc-tiers.js:25-32`; `document.rs:36-38`; `size_tiers_match_doc_tiers` | Test added in this audit. |
| 6.17 | Text decoding: BOMs, newline style, refuse UTF-32 and binary | PASS | `round_trips_bom_encoding_and_newlines`, `refuses_binary_and_invalid_bytes`, `detects_mixed_newlines` | |
| 6.18 | IPC | PASS | Roll-up | |
| 6.19 | Text-file IPC | PASS | `document::open`, `save_text`, `save_as`, `file_ops.rs` rename, reveal; watcher | |
| 6.20 | Byte-document IPC | PASS | `office.rs` open, save, write_to, recovery | |
| 6.21 | Sync IPC grant-file-path, attach-file-path | PASS | `cloud.rs` binds by path | No renderer boundary to grant across. |
| 6.22 | Rust port note: own write is not a foreign change | PASS | `disk.rs`; `own_writes_are_quiet_and_others_are_reported` | |

## 28. Settings, themes and appearance

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 28.1 | What the user can do | PASS | Roll-up | Roll-up: 28.2a and 28.2b pass on screen. |
| 28.2 | Sections: account, appearance, files, advanced (servers, updates, error reporting, links) | PASS | `settings.tsx:57-180`, `servers-setting.tsx`; `settings.rs`, `servers_setting.rs` (cloud audit); `rows_say_who_is_signed_in_like_account_line`, `the_submit_button_reads_like_server_sign_in`, `only_an_explicit_zero_turns_previews_off`, `logs` consent tests | Tabs, order and wording match. Updates is greyed (updater excluded). Files' "Use Markie" buttons are greyed (no file-type claims, excluded). The Servers section, with add, remove and per-server sign-in, came with the cloud audit. |
| 28.2a | Advanced: "Get new versions early" and "Preview links on hover" show their checkbox | PASS | `settings.tsx:225-283`; `settings.rs` setting_text; `setting_text_may_shrink_so_its_checkbox_stays_on_the_panel` | Capture pass 2026-11-22, Electron 0.9.7 at 1280x820: both checkboxes sit on the panel in light and dark (`.autoloop/runs/capture-pass/sbs-adv-light.png`, `sbs-adv-dark.png`). The "Not in Markie RS yet" tag and "You are running Markie RS 0.1.0." are the side build's own wording. |
| 28.2b | Advanced: the descriptions wrap inside the panel | PASS | same | Same captures: every description wraps inside the panel at the same line breaks as Electron's. |
| 28.3 | Eight templates, light and dark | PASS | `theme.rs`; `eight_templates_with_their_typography` | |
| 28.4 | Light, dark or system | PASS | `chrome.rs` ColorMode, observe_window_appearance; `color_mode_round_trips` | Following a live macOS change was not exercised, as before. |
| 28.5 | Custom presets: colours plus typography | PASS | `ThemeStore`, `appearance.rs`; `store_transitions_match_theme_ts`, `appearance::tests::*` | Colour wells are hex fields, as recorded in LOCAL-FEATURES.md. |
| 28.6 | Themes follow the account; owner pins a theme to a shared document | PASS | `theme-sync.ts`, `page.tsx:505,1951`; `theme_sync.rs`, `doc_theme.rs`; `a_pull_keeps_the_accounts_store_or_asks_for_ours`, `the_push_wraps_the_store_like_theme_sync`, `only_members_on_markie_cloud_read_the_pinned_theme`, `the_answer_and_the_store_follow_get_doc_theme` | Fixed: neither existed. Electron's renderer never calls `setDocTheme`, so there is no pinning UI in either app. |
| 28.7 | Files | PASS | settings.tsx → `settings.rs`, `appearance.rs`; theme.ts → `markie-core/theme.rs`; color-mode → `chrome.rs`; theme-sync → `theme_sync.rs`, `doc_theme.rs`; katex-css → `markie-math`; globals.css → `themes.rs`, `dialog_chrome.rs` | |
| 28.8 | Compatibility | PASS | Roll-up | |
| 28.9 | `ThemeTokens` fields | PASS | `theme.rs:17` serde camelCase; `legacy_stores_normalize` | |
| 28.10 | Store in `markie.themes.v1` | PASS | registry setting `themes.v1`, same JSON | |
| 28.11 | REST `/api/me/themes`, `/api/docs/:id/theme` | PASS | `theme_sync.rs` THEMES_PATH, `doc_theme.rs` | PUT on a document has no caller in 0.9.7. |
| 28.12 | Rust port note: tokens onto GPUI; JSON shape kept | PASS | `themes.rs` apply_store; `every_painted_preset_reaches_the_chrome` | |

## 29. Menus, shortcuts and command palette

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 29.1 | What the user can do | PASS | Roll-up | |
| 29.2 | Native menus | PASS | Roll-up | |
| 29.3 | File menu | PASS | `main.js:3741-3833` with `document-menu.js` install; `menus.rs`; `file_menu_matches_electron`, `history_is_greyed_until_the_document_has_versions`, `electron_accelerators_reach_their_items` | Rebuilt. |
| 29.4 | Edit: Undo/Redo, Find ⌘F, Replace ⌥⌘F, Format Tables ⌥⌘T | PASS | `main.js:3835-3883`; `source.rs` edit_menu (editors audit), used by `menus.rs`; `edit_view_window_and_help_match_electron` (exactly one Edit menu) | This audit and the editors audit each built one; the merge kept the editors' routing and removed this audit's duplicate. |
| 29.5 | View: modes, zoom, page width, Command Palette, Theme, Shortcuts, Statistics | PASS | `main.js:3885-3960`; same tests | Theme… opens Settings › Appearance, as `menu-theme` does. |
| 29.6 | Settings ⌘,; Default Apps; Check for Updates | PASS | app menu in `menus.rs`; same test | Check for Updates is left out: updater, excluded. |
| 29.7 | The document menus from section 17 | PASS | `document-menu.js` install, `document-menu-commands.json`; `menus.rs` build; `office_commands_are_directly_in_the_reference_file_and_view_groups`, `file_menu_matches_electron`, `edit_view_window_and_help_match_electron` | Format, Insert, Layout and Review sit between Edit and View, disabled without a Word document. File has Document Details… (Office audit) after the New items. The Export submenu says "Export PDF…" for a Word document and "PDF (Light)…" otherwise, as `install` relabels it. View gets the Word layouts and the three Darkmown views (agents audit) straight after a separator. |
| 29.8 | Palette: about 40 commands, fuzzy ranking | PASS | `page.tsx:2164-2240`, `commands.ts`; `palette.rs`; `ranking_matches_electrons_filter_commands` (16 queries through Electron's filterCommands), `commands_follow_electrons_list`, `context_filters_like_electron` | Fixed: 20 commands were missing. Markie RS's ten extra commands come after Electron's. |
| 29.9 | Shortcuts help sheet | PASS | `shortcuts-help.tsx`; `shortcuts.rs`; `groups_follow_electron_order` | Same grouping and order. It also lists Markie RS's extra shortcuts: ⌥⌘O, ⇧⌘O and ⌘R, a Go group (Back ⌘[, Forward ⌘]) and, last, a Source group with the CodeMirror keys Source text has (editors audit 7.19 to 7.27). |
| 29.10 | Files | PASS | main.js template → `menus.rs`; document-menu.js → `menus.rs` plus office actions; command-palette → `palette.rs`; shortcuts-help → `shortcuts.rs`; commands.ts → `palette.rs`; editor-keymap → `markie-editor` bind_keys | |
| 29.11 | Events `menu-*`, `set-mode`, `toggle-stats` | PASS | `actions.rs` | Each event is a GPUI action. |
| 29.12 | Back and Forward between places | IMPROVEMENT | `workspace/nav.rs` (`NavHistory`, `navigate`, `render_nav_buttons`), `menus.rs` Go menu, `palette.rs`, `main.rs` keys; tests `back_and_forward_walk_the_places_and_a_new_visit_clears_forward`, `a_moved_or_deleted_place_is_skipped_and_dropped`, `each_place_keeps_its_mode_and_scroll`, `cmd_brackets_go_back_and_forward_but_indent_in_source_text`, `go_has_back_and_forward_greyed_with_nowhere_to_go` | Electron has no back and forward between documents (Kirby asked for it on 2026-11-25). A place is a document with a file (by any route: Open, Recent, Library, Browse, search, a link, a drop, a deep link, a synced cloud document; Word, CSV and PDF included), the one untitled buffer (back to it brings its journalled text back), or a page that replaces the document area (Recent, Browse, Cloud, Live Docs, Vault). Panels, dialogs, the palette, ⇧⌘F search and the History page are not places; Back on the History page goes back to its document. Each place keeps its mode and scroll. A new visit clears Forward. A file moved or deleted outside Markie is skipped with a notice; a rename, move or Save As inside Markie follows the file. Leaving a document saves or journals it as opening another one does. Two 28 pt chevrons sit after the wordmark in the title bar with its icon buttons' size, colours and hover, dimmed and inert with nowhere to go, tooltips "Back (⌘[)" and "Forward (⌘])", accessible labels. ⌘[ and ⌘] go Back and Forward except in Source text, where they outdent and indent as CodeMirror does. A Go menu (Finder's) sits between View and Window. A mouse's back and forward buttons, and the swipes macOS sends as them, go Back and Forward; a two-finger trackpad swipe is not available from GPUI. Off-screen title bar, light and dark: `.autoloop/runs/nav/bars.png`. |

## FAIL rows left

| Row | Blocker | Owner |
|---|---|---|
| 2.3, 2.8 | Column-identical tables matter only for sharing Electron's database, which the side-build rules forbid | Kirby: recommend EXCLUDED |

The roll-up row 2.2 clears when these do.

## Pending Kirby's call, not changed

- Dark ink on highlights in dark mode.
- The code block language label.
- Also noted: the title bar's palette button opens a template menu, where Electron's opens Settings › Appearance. An earlier task brief asked for the menu (VISUAL-SHELL.md, "Deliberate deviation"), so it is left as it is.

## Captures owed (screen locked)

Each one is light and dark at 1280 x 820, the same fixture in both apps, per SCREEN.md. Launch with `env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME=<scratch>`, plus `MARKIE_RS_DATA_DIR=<scratch>` for Markie RS and `--user-data-dir=<scratch>` for Electron.

1. The menu bar: open each menu with `act.sh <pid> click` on its title. Compare File, Edit, View and Window.
2. The palette (⌘K) with an empty query and with "exp".
3. The shortcuts sheet (⌘/).
4. Settings › Advanced, signed out. This is safe in both apps.
5. The welcome document on a fresh data folder, Rich mode.
6. A Library row whose file was deleted after opening it. Markie RS only, since Electron's Library shows Kirby's files.
7. The "Owner theme" chip. It needs a shared test document on a local server.
8. Drag a fixture file onto each window, using `act.sh` drag if available. Otherwise mark it manual.
9. Save As (⇧⌘S): the sheet opens with the document's name.
10. Settings › Advanced in both apps, signed out: each row shows its checkbox and the descriptions wrap inside the panel (rows 28.2a, 28.2b).
11. The Library signed in to a local test server: "Upload destination" and its menu.

## Tests run

- `cargo test -p markie-app` after the merge: 149 passed.
- `cargo test -p markie-core`: 92 passed.
- `cargo test --workspace` after merging e8e8e07: 1073 passed, 0 failed, 2 ignored.
- `node --import ./rust/scripts/ts-run/register.mjs rust/scripts/parity/library-settings-parity.mjs`: regenerates the fixture from Electron's code.
- `local-parity.mjs` on `.autoloop/runs/library-settings/home`: all match. Five search queries were checked for order, name hits and excerpts, plus the Projects tree and the ignored count.

## Markdown styles and fonts, 2026-11-24

Electron PRs #150 and #151, ported on branch `t3/markie-rs-styles-fonts` ([STYLES-FONTS.md](STYLES-FONTS.md)). Nine rows. Six meet parity; three need a capture. The section score is now **97 of 100 = 97.0 %**.

| ID | Item | Status | Evidence | Notes |
|---|---|---|---|---|
| 28.S1 | Six presets with Electron's choices, numbers and type pairings; stored styles cleaned and resolved the same way | PASS | `markdown_style::tests` against `markdown-style-golden.json` (made by Electron's own functions) | The lists are generated from Electron's modules. |
| 28.S2 | Every style option drawn in View: headings, paragraphs, lists, tasks, tables, quotes, code, dividers, links | PASS | `.autoloop/runs/styles-fonts/GALLERY.md`: six presets, light and dark, beside Electron's editing view; `md::tests` | Rows land within 1 pt of Electron's over a 492 pt frame of Compact (they were 5.5 pt off before heights were set on whole device pixels). Spacious's link underline on hover is drawn. |
| 28.S3 | Picture placement, frame, corner radius and captions | IMPROVEMENT | Gallery, Editorial and Classic | Electron's editing view ignores placement and captions; its read view draws them. Markie RS draws them in View. |
| 28.S4 | Settings › Markdown style: cards drawn by the renderer, In use, Delete, Rename, Duplicate, Customize | NEEDS-CAPTURE | `style_ui.rs`; scene `style-settings` (`ui/rs-settings-light.png`) | Screen session check, about 4 minutes: open Settings › Appearance in both apps. Compare the "Markdown style" heading and its two lines, the six cards (each a small page in its own style) and the row under them. Click Compact, then Editorial: the document behind changes and "In use:" follows. Click Duplicate: a card "Editorial copy" appears. Click it, then Rename (type a name, Enter), then Delete: the base preset is in use again. |
| 28.S5 | Style editor: start from, thirteen elements, reset an element, save as, save to, discard, live sample | NEEDS-CAPTURE | `style_ui.rs`; scene `style-settings` with `editor: true` (`ui/rs-editor-dark.png`); store transitions held to Electron's by `the_store_transitions_are_electrons` | Screen session check, about 7 minutes: click Customize… in both apps. Compare the panel (1120 × 780 at most), the head, "Start from" and the thirteen rows with their summaries. Open Tables and click Zebra, then Bold: the sample on the right redraws, the row gets a blue dot, the head says "(edited). Not saved yet." Click "Reset to Spacious": the dot goes. Open Paragraphs and spacing and drag "Line spacing": the sample follows the drag. Open Typefaces and pick a text face from the menu. Click "Save as new style…", type a name, Enter: the name is in "Start from". Change one option, then "Save to <name>", then change another and "Discard changes". Press Escape: the editor closes and Settings is still open. |
| 28.S6 | Spacious is unchanged | PASS | Six frames before and after, light and dark: 0 differing pixels (`spacious/`) | Baseline binary built from a55cbae. |
| 28.F1 | Font library: the same 26 families, ids and files, licenses shipped | PASS | `fonts::tests` (SHA-256 of all 54 files), `native::tests` (all 54 register) | Licenses are in the binary and in the bundle's `Resources/font-licenses`. |
| 28.F2 | Body, heading and code menus with every face under its group, drawn in itself; fonts on this computer; the bundled list | NEEDS-CAPTURE | `style_ui::tests`; `fonts::tests` for the `local:` ids | Screen session check, about 4 minutes: in Typography open "Body font" in both apps. Compare the group headings (System, Sans serif, Easy to read, Rounded, Serif, With personality, Monospace), each name drawn in its own face, and the tick. Pick Lora: the document and the specimen change. Open "Code font" and pick JetBrains Mono: code in the document changes. Click "Show fonts on this computer", type "fut", click Body beside Futura: the note names the bundled stand-in, and the Body menu lists Futura under "Only on this computer". Open "Fonts included with Markie": 26 lines. |
| 28.F4 | Fonts layered template, then style, then the person's own | PASS | `theme::tests::fonts_are_layered_template_then_style_then_the_persons_own` | |

The three open rows wait for the scheduled screen session; each row says what to click and what to compare. A still frame of each state can be drawn beforehand without the screen: `scene.sh style-settings <out> light '{"style":"technical"}' <file>`, then the same with `"editor":true,"group":"tables"` and with `"face":"body"`.

## Google Docs import, 2026-11-25

Branch `t3/markie-rs-google-import` ([GOOGLE-DOCS.md](GOOGLE-DOCS.md)). Electron has no Google Docs import, so each row is an IMPROVEMENT under SCORE.md's rules. Six rows, all met. Hidden until a build carries `MARKIE_GOOGLE_DESKTOP_CLIENT_ID`; the real Google is checked by `rust/scripts/google-spike.sh`, not by these rows.

| ID | Item | Status | Evidence | Notes |
|---|---|---|---|---|
| 28.G1 | Settings › Files › Google Docs: connect, disconnect, account, import folder, progress with Cancel, synced Docs with last sync and errors | IMPROVEMENT | `google_docs.rs`; `google_docs::tests` (5); scene `google` light and dark: connected, importing, waiting with a folder warning, not connected | The grant is `drive.file` only, kept in the Keychain service "<profile> Google", and never sent to Markie Cloud. |
| 28.G2 | File › Import from Google Docs… and the palette's Import, Refresh, Refresh All and Save as Word | IMPROVEMENT | `menus.rs` (`google_docs::menu_items`), `palette.rs` (`google_docs::palette_commands`) | Both lists are empty without a client, so menus and palette are unchanged in such builds. |
| 28.G3 | A picked Doc becomes `<title>.md`: headings, lists with nesting and checkboxes, tables, code, rules, footnotes, images as links, one heading per tab | IMPROVEMENT | `markie-google` `tests/convert.rs` (15, one made-up fixture per element), `tests/flow.rs` (14, against the fake Google) | Title collisions get " (2)"; a file that is not the Doc's own is never overwritten. |
| 28.G4 | Refresh from Google, per file and for all; local edits kept as a dated conflict copy | IMPROVEMENT | `tests/flow.rs` refresh and conflict tests | One-way in this step; nothing is written to Google. |
| 28.G5 | Save as Word beside the Markdown file | IMPROVEMENT | `tests/flow.rs` `save_as_word_writes_beside_the_markdown_and_replaces_its_own_copy` | Google's own `.docx` export. |
| 28.G6 | A Google mark on synced files in Recents | IMPROVEMENT | `recent_page.rs` (one line), `google_docs::mark`, icon `markie/google-doc.svg` | Not yet captured in a `recent` scene with synced files. |

## Settings › Agents and page polish, 2026-11-25

Branch `t3/markie-rs-agents-setting-polish`. Kirby: agent features belong in Settings, off by default, since not everyone uses agents; and the document pages want a max width and a created date. Electron has neither, so each row is an IMPROVEMENT under SCORE.md's rules. Five rows, all met. The flaw list and its before and after shots are in [POLISH-2026-11-25.md](POLISH-2026-11-25.md).

| ID | Item | Status | Evidence | Notes |
|---|---|---|---|---|
| 28.A1 | Settings › Agents, between Files and Advanced: "Show Skills & agent files in the sidebar" (off), Projects' "Organize files into projects automatically", "Organizing rules for Projects" (Edit rules opens `Projects.md`) and "Connect an agent (MCP)" (Connect… opens the rail robot's dialog) | IMPROVEMENT | `agents_setting.rs`; `agents_setting::tests` (3); scene `settings` with `section: "agents"`, light and dark, 760 and 1280 pt | The switch is `markie.agents.skillsPanel.v1` in the registry; only "1" shows the panel, so new and existing installs start hidden. The rail's robot button stays. |
| 28.A2 | The rail's Skills button (sparkle) hidden unless 28.A1 turns it on; while off, the palette's entry reads "Turn On Skills & Agent Files (Settings › Agents)" and turns it on; a window on Skills falls back to Recent, and so does the pencil's way back | IMPROVEMENT | `rail.rs` (`skills_enabled`), `palette.rs` (`SKILLS_TURN_ON`), `agents_setting::without_skills`; `a_window_on_skills_falls_back_to_recent` | No keyboard shortcut opens Skills, so none needed a change. |
| 1.P1 | Recent, Cloud and Browse share one centred column at most 1200 pt wide: header, toolbar, bulk bar, group labels and rows line up; the hairlines still run the full width | IMPROVEMENT | `recent_page::page_gutter`, `PAGE_MAX`; `the_page_is_as_wide_as_the_window_allows`; scenes `recent`, `cloud`, `browse` at 1900 pt | Browse closes the column with hairlines on both sides. |
| 1.P2 | Created date: "Created Nov 3" as a line on each card and a column in list view, on Recent and Cloud; "Date created" in both sort menus | IMPROVEMENT | `library::birth_ms`, `query_rows_created`, `recent_page::created_line`, `cloud_page::entry_created_ms`; `date_created_sorts_newest_first_and_unknown_last`, `the_created_line_is_a_day_and_nothing_when_unknown`, `a_narrow_list_drops_the_created_column_but_cards_keep_the_line`; server `agent-links.test.ts` "GET /api/docs carries each document's created_at" | Local files use the birth time; Markie Cloud documents the server's `created_at`, now in `GET /api/docs` (server change, ships with the next Markie Cloud deploy; until then Cloud shows none). Unknown shows nothing. A list narrower than 720 pt drops the column. Browse keeps Electron's orders. |
| 29.P1 | The title bar fits a narrow window: below 900 pt the wordmark steps aside, the file name truncates, and Share and the theme controls stay on screen | IMPROVEMENT | `chrome.rs` `title_bar_content_width`, `title_bar_narrow`; `the_title_bar_fits_the_window_and_drops_the_wordmark_when_narrow`; scene `doc` at 760 pt | At 760 pt Share was cut off before. |
