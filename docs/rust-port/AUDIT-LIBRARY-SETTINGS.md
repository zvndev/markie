# Audit: Library, registry, Browse, Projects, search, open and save, settings, menus

Written 2026-11-22 against Electron Markie 0.9.7 (`markdown-viewer-zvn` at ae62cfa, read only). Branch `t3/markie-rs-library-settings-parity`, from `rust/markie-rs` at 3b6f6c0. Sections 1 to 6, 28 and 29 of PARITY.md.

## Score

**Parity: 88 of 94 = 93.6 %.**

| Count | Rows |
|---|---|
| All rows | 96 |
| PASS | 88 |
| FAIL | 3 |
| NEEDS-CAPTURE | 3 |
| EXCLUDED | 1 |
| EXCLUDED-PLATFORM | 1 |

The score is PASS ÷ (all rows − EXCLUDED − EXCLUDED-PLATFORM). Of the 3 FAIL rows, 2 are schema rows behind a side-build rule (2.3, 2.8) and 1 is their roll-up (2.2).

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
| (merge) | Merge of `rust/markie-rs` at e8e8e07. One menu bar (`menus.rs`) carries every auditor's items in Electron's places, one Edit menu, one palette list. |

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
| 1.2 | Library lists recent and opened files with their sync state | PASS | `library.tsx` fileRow; `library.rs` set_lists, `library_rows.rs` sync_status_icon; `states_map_from_the_cloud_badge`, `recent_files_that_are_gone_stay_listed_as_missing` | Fixed: files gone from disk were hidden. They now show "Missing on disk". |
| 1.3 | Filter by type; sort by name, recency or type | PASS | `library-document-query.ts`; `library.rs` query_rows; `recent_query_matches_electrons_query_library_documents` (112 cases from Electron's code), `the_recent_tab_filters_without_ranking_or_reading_bodies` | Fixed: ranking, snippet search, label-based Type sort, recency by mtime, missing "Other". |
| 1.4 | Create new documents (Markdown, Word, text, Darkmown, Locked vault) | PASS | `new-document-modal.tsx:16-25`; `file_ops.rs` WRITING_TYPES and DATA_TYPES, `copies_and_renames`; palette `commands_follow_electrons_list` | Same ten types, labels and descriptions. Locked vault comes from the Vault page (section 22) and the palette's "Open Vault", as in Electron. |
| 1.5 | Drop files to import them | PASS | `library.tsx:387` onDrop, `page.tsx:1701` handleDrop; `file_ops.rs` library_drop_paths, window_drop_target; `drops_open_what_electron_opens` | Fixed: no drop handling existed. The Library notice uses Electron's wording. |
| 1.6 | Per-row menu: rename, move, Trash (optionally the cloud copy), reveal, sync on/off | PASS | `library.tsx:608` rowMenuEntries; `library_rows.rs` row_entries_for, run_row_action; `each_state_offers_electrons_sync_action`, `a_file_that_is_gone_is_removed_from_the_library_not_deleted`, `a_cloud_copy_without_its_file_offers_download` | Entries, order, tones and separators match. 0.9.7's menu has no rename, move or reveal, so neither does Markie RS. The sync actions run in place since the cloud audit (f6e11d5, merged). |
| 1.7 | Pick a cloud upload destination ("area") | PASS | `library.tsx:884`, `cloud-area-picker.tsx`; `library_area.rs`; `the_picker_names_the_chosen_area_or_the_default_cloud` | Fixed: the Library used the Cloud page's area filter. It now has its own picker, with "Default cloud", the areas and New area, reset on an account change. |
| 1.8 | Projects tab, Files workspace roots, Settings › Files (default folder `~/Documents/Markie`) | PASS | `workspace-default.ts`, `workspace.js:62`; `workspace_ops.rs` ensure_default_root, `projects.rs`; `the_default_root_is_made_only_when_no_live_root_is_registered`, `the_open_documents_project_opens_and_shared_folders_hide` | Fixed: the default folder was never made or registered. |
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
| 2.1 | Files: registry.js, WAL, `registry.db`, `PRAGMA user_version` 2 | PASS | `registry.rs:71` WAL, `paths::data_dir()/registry.db`; `user_version_is_two_with_the_project_tables` | Fixed: user_version was never set. |
| 2.2 | Schema to keep exactly | FAIL | Roll-up | 2.3 and 2.8 fail. |
| 2.3 | `files(…)` with all columns | FAIL | `registry.js:72-170`; `registry.rs:73` | Markie RS's `files` has path to share_role. The cloud columns (share_role_user, assets_*, links_*, cloud_origin) live as one JSON record per path in `rs_cloud_sync` (`markie-cloud` SyncRecord). Blocker: the identical table only matters for opening Electron's database in place, which the side-build rules forbid. Migration reads Electron's file through `markie-migrate`. Recommend Kirby mark it EXCLUDED. |
| 2.4 | `sync_state` values | PASS | `markie-cloud/src/sync.rs:10,22` kebab-case SyncState; `push_only_from_synced_or_unpushed` | |
| 2.5 | `cloud_origin` NULL is Markie Cloud; legacy aliases rewritten | PASS | `origin.rs` canonical_cloud_origin; `allowed_server_origin`, `trusted_list_replaces_the_pin` | |
| 2.6 | `workspace_roots(path, added_at)` | PASS | `registry.rs:84`; `recents_roots_stars_settings` | |
| 2.7 | `md_stars(path, kind, added_at)` | PASS | `registry.rs:88`; same test | |
| 2.8 | `md_index_cache(path, name, mtime_ms)` | FAIL | `registry.rs:93` rs_index_snapshot | Same role, one JSON row. Same blocker and recommendation as 2.3. |
| 2.9 | `skill_sources` | PASS | `registry.js:96-99`; `markie-agent/src/skills.rs:360` SKILL_TABLES, ensure_skill_tables at registry open (`workspace.rs`); `the_registry_gets_electrons_skill_tables` | Agents audit. Same columns as Electron. |
| 2.10 | `skill_installs` | PASS | `registry.js:100-121`; same | Agents audit. Same columns, `root` included. |
| 2.11 | v1 tables | PASS | `projects/store.rs:23-60`; `decisions_round_trip_and_survive_upserts` | Created at open now. |
| 2.12 | v2 `projects` | PASS | `projects/store.rs:60`; same test | |
| 2.13 | Windows paths lowercased (`canonicalPath`) | EXCLUDED-PLATFORM | `registry.rs:54` | Built, untested on macOS. |
| 2.14 | Rust port note: PRAGMA-guarded, idempotent migrations | PASS | `CREATE TABLE IF NOT EXISTS` throughout; `user_version_is_two_with_the_project_tables` reopens the file | |

## 3. Browse

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 3.1 | Browse every document, star, filter, sort, full paths, refresh, rescan on focus at most every 5 min | PASS | `browse-view.tsx`, `main.js:929`; `rail.rs`, `folder_tree.rs`, `workspace.rs` rescan_on_focus; `folder_tree::tests`, `count_tests`, `focus_walks_again_only_after_five_minutes` | Fixed: no rescan on focus. Electron's Browse may not be captured (SCREEN.md rule 7). |
| 3.2 | Files | PASS | mdindex.js → `index.rs`; mdmeta.js → `projects/meta.rs`; frontmatter.js → `projects/frontmatter.rs`; skill-frontmatter.js → `markie-agent/src/skills.rs`; browse-view → `rail.rs` | |
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
| 4.1 | Auto-cluster; pin, rename, merge, create; write overview | PASS | `projects/*`; `cluster::tests::*`, `taxonomy::tests::*`, store tests; parity report "projects tree … all match" | Pin, rename, merge, create and overview are IPC-only in 0.9.7, so API-only here too. |
| 4.2 | Files | PASS | cluster, taxonomy, rules, assign, search → `projects/*.rs`; projects-config.js → `projects/config.rs` | `audit.ts` is a developer script, not a feature. |
| 4.3 | IPC projects-*, config rewritten below the marker, YAML rules | PASS | `config::write_overview_section`, `rules.rs`; `rules::tests::*`, `compute_end_to_end_keeps_decisions` | |
| 4.4 | Rust port note | PASS | as 4.1 | |

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
| 28.1 | What the user can do | NEEDS-CAPTURE | Roll-up | 28.2a and 28.2b need a capture. |
| 28.2 | Sections: account, appearance, files, advanced (servers, updates, error reporting, links) | PASS | `settings.tsx:57-180`, `servers-setting.tsx`; `settings.rs`, `servers_setting.rs` (cloud audit); `rows_say_who_is_signed_in_like_account_line`, `the_submit_button_reads_like_server_sign_in`, `only_an_explicit_zero_turns_previews_off`, `logs` consent tests | Tabs, order and wording match. Updates is greyed (updater excluded). Files' "Use Markie" buttons are greyed (no file-type claims, excluded). The Servers section, with add, remove and per-server sign-in, came with the cloud audit. |
| 28.2a | Advanced: "Get new versions early" and "Preview links on hover" show their checkbox | NEEDS-CAPTURE | `settings.tsx:225-283`; `settings.rs` setting_text; `setting_text_may_shrink_so_its_checkbox_stays_on_the_panel` | Found by the cloud auditor side by side. Fixed in ac0bea6: the text column had no zero minimum width, so it pushed the checkbox out. Capture 10 confirms it. |
| 28.2b | Advanced: the descriptions wrap inside the panel | NEEDS-CAPTURE | same | Same cause and fix as 28.2a. |
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
| 29.9 | Shortcuts help sheet | PASS | `shortcuts-help.tsx`; `shortcuts.rs`; `groups_follow_electron_order` | Same grouping and order. It also lists Markie RS's three extra shortcuts (⌥⌘O, ⇧⌘O, ⌘R). |
| 29.10 | Files | PASS | main.js template → `menus.rs`; document-menu.js → `menus.rs` plus office actions; command-palette → `palette.rs`; shortcuts-help → `shortcuts.rs`; commands.ts → `palette.rs`; editor-keymap → `markie-editor` bind_keys | |
| 29.11 | Events `menu-*`, `set-mode`, `toggle-stats` | PASS | `actions.rs` | Each event is a GPUI action. |

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
