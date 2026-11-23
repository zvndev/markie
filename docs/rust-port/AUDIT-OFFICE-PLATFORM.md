# Markie RS Office and platform parity audit

macOS score: **94.92% (52 PASS + 4 IMPROVEMENT ÷ 59 eligible)**, rescored on 2026-11-22 after Kirby excluded the crash report format rows (27.427, 27.431). 105 rows: 52 PASS, 4 IMPROVEMENT (vault, 2026-11-23), 0 FAIL,
41 EXCLUDED, 5 EXCLUDED-PLATFORM, 0 NEEDS-CAPTURE, and 3 NEEDS-KIRBY (Touch ID, checked by Kirby in person).
All 93 inventory bullets are represented. Both exclusion classes stay out of the denominator.

Baseline: Rust `3b6f6c0`, Electron source `ae62cfa7e73f`, installed reference
`0.9.7`. The follow-up merged through `987ba30`. Only scratch app
instances and synthetic fixtures were used; no live profile, real Keychain
item, user vault, or user document was used.

IDs are source line numbers in [PARITY.md](PARITY.md) at the baseline. The
category bullets have rows of their own. Where a source bullet has unlike
verification requirements, a suffix splits it. Electron paths are relative
to the read-only reference repository. In this report **App**, **Core**,
**Office**, **Word**, **Vault**, **Migrate**, **Cloud**, **Web**, and **Export**
mean the corresponding `rust/crates/markie-*` crates. A native operation
can match an IPC operation without implementing the Electron transport.

## 0. Cross-cutting state

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 0.17 | Chromium localStorage container | EXCLUDED | Electron `src/lib/server-sessions.ts:30`; Migrate `local_storage.rs`; `reads_settings_sessions_vault_and_library` | Reader works on synthetic Electron data. No live migration before cutover. |
| 0.18 | Primary and per-origin bearer token keys | EXCLUDED | Electron `src/lib/auth-client.ts:72`, `src/lib/server-sessions.ts:30`; Migrate `reads_settings_sessions_vault_and_library` | Native sessions are isolated. |
| 0.19 | Principal, server and auth nonce keys | EXCLUDED | Electron `src/lib/auth-client.ts:15,130`, `src/lib/auth-state.ts:19`; Migrate `local_storage.rs` | Do not migrate an in-flight nonce. |
| 0.20 | Theme, color mode, sync, cloud sources and library tab keys | EXCLUDED | Electron `src/lib/theme.ts:535`, `color-mode.ts:30`, `auth-client.ts:828`, `library-state.ts:60`, `src/components/cloud-view.tsx:73`; App `workspace.rs:215`; Migrate fixture | Audit is of moving settings, not their native UI. |
| 0.21 | Left panel width, Browse filters/sort/open/stars/full path, Skills full path and Search types | EXCLUDED | Electron `src/lib/panel-width.ts:5`, `src/components/browse-view.tsx:24`, `skills-view.tsx:26`, `global-search.tsx:24`; App `workspace/rail.rs:31`; Migrate fixture | Raw keys are not applied to the side build. |
| 0.22 | Document zoom, link previews, first run, default-app hint and Touch ID offer | EXCLUDED | Electron `src/lib/document-zoom.ts:7`, `link-previews.ts:9`, `first-run.ts:9`, `src/components/library.tsx:94`, `documents/vault-panel.tsx:36`; App `workspace.rs:309`, `workspace/vault.rs:42`; Migrate fixture | Keep separate settings. |
| 0.23 | Per-document normalization consent and appearance | EXCLUDED | Electron `src/lib/rich-override.ts` and `doc-appearance.ts`; App `workspace/appearance.rs`; Migrate `local_storage.rs` | No automatic import. |
| 0.24 | Chromium IndexedDB container | EXCLUDED | Electron `src/lib/vault/storage.ts:44`; Migrate `reads_settings_sessions_vault_and_library` | Cutover only. |
| 0.25 | Encrypted vault records | EXCLUDED | Electron `src/lib/vault/storage.ts:44`; Migrate `the_migrated_vault_opens_with_the_fixture_passphrase` | This is the migration row, not crypto compatibility. |
| 0.26 | Imported/recovered document records | EXCLUDED | Electron `src/lib/document-library/indexed-db.ts`; Migrate `reads_settings_sessions_vault_and_library` | Cutover and Recovered from Markie are deferred. |
| 0.27 | One-time migration or export without loss | EXCLUDED | Electron `src/lib/vault/storage.ts:44`; Migrate `copy_then_read_and_the_copy_matches`; App `workspace.rs` `on_import` | The app does not execute the reader against Electron's data. |
| 0.28 | Plain userData files | EXCLUDED | Electron `electron/main.js:1714`; Core `paths.rs:10` | The side build's stores are independent. |
| 0.29 | Registry and servers file | EXCLUDED | Electron `electron/registry.js`, `servers.js`; App `workspace.rs:186` | No copy or reuse of the live registry or added servers. |
| 0.30 | Snapshots, doc metadata, drafts and asset-cache | EXCLUDED | Electron `electron/main.js:1714`, `snapshots.js`; App `workspace.rs:253,282`, `workspace/cloud_resources.rs:36` | Cutover only. |
| 0.31 | Agent permissions, live projects, seeded examples, crash log, preflight and release credential | EXCLUDED | Electron `electron/main.js:2994`, `examples.js`, `private-release.js`; App `workspace.rs:257,268`, `logs.rs:23` | No import and no reuse of build credentials. |
| 0.32 | Per-vault Touch ID secrets | EXCLUDED | Electron `electron/vault-touch-id.js`; App `workspace/vault.rs:92` | Enroll a new slot at cutover. |
| 0.33 | Error-reporting consent and update opt-in | EXCLUDED | Electron `electron/main.js:3612`, `update-channel.js`; App `logs.rs:25,132` | No import of consent. Updater intentionally absent. |
| 0.34 | Home-folder agent socket and discovery files | EXCLUDED | Electron `electron/main.js:2994,3020`; App `workspace/agents.rs` | Do not open the Electron socket or credential. Native agent protocol is section 15. |
| 0.35 | Custom schemes | PASS | Electron `electron/main.js:326,1097,1161,4005`; Rust `scripts/bundle-mac.sh:40,48`, Web `island.rs:105,160` | Native bundle, scoped assets and the separate hand-back scheme replace Electron's transport. |
| 0.36 | Bundle origin and CSP | PASS | Electron `electron/main.js:1097`, `csp.js:64`; App `main.rs:224`, Web `island.rs:412` | The native shell does not host its UI at an app URL; web islands enforce separate CSPs. |
| 0.37 | Local picture and Darkmown picture scope transport | PASS | Electron `electron/main.js:1161`, `local-assets.js:107`, `darkmown-preview.js`; Rust editor `media.rs:40`, Web `island.rs:105,123,160` | Native media opens from the filesystem, with a separate scope for picture requests in the preview. Cloud caching is assessed in 31.478. |
| 0.38 | Claim the legacy `markie://` scheme | EXCLUDED | Electron `electron/main.js:4005`; Rust `scripts/bundle-mac.sh:53`; `keeps_only_markie_rs_links_for_sign_in` | Keep it for the shipped application. |

## 17. Office

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 17.298 | Office workspace behavior | PASS | Electron `src/components/documents/use-document-workspace.ts:29`; App `workspace/office.rs:91`; Word engine/edit tests; Export `word_pagination_matches_electron` | Editing, imports, untitled recovery, and active menu state are covered. Printed pagination now matches Electron (17.306), which was the only gap. |
| 17.299 | DOCX editing, formatting, page setup and views, objects and review; Find | PASS | Electron `src/components/documents/word-document-editor.tsx:34,400,406,579`, `word-find.ts:6,21`, `src/lib/office/docx-numbering.ts:96`; Word `word_find_replaces_literal_matches_across_runs_in_one_undo_step`, `headings_lists_and_alignment_change_the_paragraph`, `page_size_and_orientation_follow_the_layout_commands`, `tables_insert_after_the_caret_and_are_editable`, `pictures_scale_into_the_content_box`, `links_need_a_selection_and_can_be_retargeted`, `page_breaks_insert_at_the_caret_and_add_a_paragraph_at_the_end`, `comments_attach_to_the_caret_paragraph`, `tracked_typing_makes_a_revision_that_can_be_accepted`; Office `reuses_the_first_numbering_instance_in_document_order` | Find and formatting edits round-trip through the original engine. URL and grapheme primitives already shipped in Markie RS now handle IDNA, path normalization and extended clusters; tested by `normalizes_link_targets_like_the_url_serializer` and the Word editing suite. |
| 17.300 | DOC extraction to TXT, worker and budgets | PASS | Electron `src/lib/office/legacy-doc-worker-client.ts:3,21`, `src/components/documents/use-document-workspace.ts:29`; App `import_reads_at_most_one_byte_past_its_budget`, `doc_copy_rejects_lone_surrogates_but_accepts_literal_replacement_characters`; Office `extracts_a_real_synthetic_doc_off_thread`, `stops_waiting_for_a_hung_import_on_its_time_budget` | `worker_parses_an_original_doc_without_opening_a_window` and `reaps_a_timed_out_document_worker` cover the separate process. The importer cancels previous opens and preserves the 32 MiB / 5 second limits. |
| 17.301 | RTF and ODT bounded same-format save | PASS | Electron `src/lib/office/rich-document.ts`; Office `retains_exact_original_bytes_and_owns_defensive_copies`, `exports_unchanged_source_byte_for_byte_and_owns_an_isolated_copy`, `edits_and_reopens_same_format_preserving_unrelated_part_bytes`; Word `an_untouched_document_saves_its_original_bytes` | `decodes_bytes_with_document_and_font_codepage_authority` exercises Shift_JIS, GBK, EUC-KR and Big5. Untouched bytes and edited reopening are covered for RTF and ODT. |
| 17.302 | HTML consent and UTF-8 TXT copy | PASS | Electron `src/components/documents/use-document-workspace.ts:310`, `src/lib/document-import/index.ts:8`; App `workspace/import_copy.rs` `confirm_conversion`; Office `html_extracts_paragraph_heading_inline_text_and_character_references_in_order`, `html_does_not_execute_scripts_custom_elements_handlers_forms_or_fetch` | A bounded, inert template fragment uses the browser's tree-building model. `html_repairs_misplaced_table_text_as_the_browser_does` covers malformed markup; source consent and file preservation are unchanged. |
| 17.303 | Native Format, Insert, Layout and Review menus | PASS | Electron `electron/document-menu.js:27,87`; Word `actions.rs` `register_commands`, `menu_commands_follow_the_selection_and_format`; GPUI `platform/app_menu.rs:341` | macOS validates the registered actions. Word tools suspend the native commands and Outline is DOCX-only. Visual/native input verification still pending. |
| 17.304 | Light paper for Word PDF export and print | PASS | Electron `src/lib/office/docx-print.ts`; App `workspace/export.rs:106`; Export `office_pdf.rs:236,282`, `plain_documents_print`, `converted_markdown_prints_with_lists_tables_and_links` | The Office branch never passes dark theme. Print dialog appearance remains for capture. |
| 17.305 | Source surfaces | PASS | Electron `src/lib/office/`, `src/components/documents/`, `electron/document-menu.js`; Rust Office crate, Word crate, App `workspace/office.rs:67` | Code location inventory, not a second blanket pass on features. |
| 17.306 | Codec and document-import equivalents | PASS | Electron `src/lib/office/docx-hyperlinks.ts`, `rtf.ts`, `docx-print.ts`, `src/lib/document-import/`; Office `src/docx/links.rs:17`, `src/rtf.rs`, `src/document_import/html.rs`; Export `office_pdf.rs:171,227,302`, `word_pagination_matches_electron`; `.autoloop/runs/native-print/word/` | Inert HTML repair, CJK decoding, IDNA and grapheme rules are covered. The print projection now uses Chromium's rules from `docx-print.ts`: line boxes from each face's rounded ascent and descent, `.paragraph` min-height 1.4em, collapsed margins, unsplittable table rows with half-borders and cell padding that keeps paragraph margins inside, list markers on the first baseline, orphans and widows of 2, the page laid out at whole px, greedy line breaks. Proved against Electron's own `printToPDF` of `buildDocxPrintHTML` for 7 fixtures built by Electron's TypeScript (`scripts/word-print-fixtures.mjs`): same page counts, every line on Electron's page, worst 1.35 pt; table rows 6 and 12 of the pagination fixture move to a new page in both. Before: first lines 4.8 pt low, and 6 pages where Electron prints 7. Commit 85d18ba. |
| 17.307 | Document workspace and sessions | PASS | Electron `src/components/documents/use-document-workspace.ts:29,268`; App `workspace/office.rs:91,193`, `workspace/import_copy.rs`, `workspace/untitled.rs` | New Office documents are editable before choosing a file. `unsaved_office_session_only_saves_to_its_original_format` and `pending_untitled_ignores_normal_files_and_exported_sessions` cover first save and recovery. |
| 17.308 | Command IDs and session menu mapping | PASS | Electron `electron/document-menu-commands.json`, `document-menu.js`; Word `commands.rs` and `actions.rs`; App `main.rs` `set_menus` | The File and View groups now expose the Office actions directly. `office_commands_are_directly_in_the_reference_file_and_view_groups` checks both groups. |
| 17.309a | Menu-state and action compatibility | PASS | Electron `electron/document-menu.js:27,87`; Word `menu_commands_follow_the_selection_and_format`; App `main.rs:171` | Word actions depend on the selection and format, suspend under modal workspace layers, and are listed by capability in the palette. `menu_commands_follow_the_selection_and_format` covers the command gate. |
| 17.309b | Unchanged bytes and edited reopen | PASS | Electron `src/lib/office/rich-document.ts`; App `workspace/office.rs:147`; Word `an_untouched_document_saves_its_original_bytes`; Office `returns_the_byte_identical_original_when_untouched_or_reverted` | Save untouched is a no-op on disk; exported bytes equal the input for DOCX, RTF and ODT, and all three reopen with the edit. |
| 17.310 | Native port placement | PASS | Electron `src/lib/office/` and `src/components/documents/word-document-editor.tsx:579`; Rust `markie-office` and `markie-office-view` Cargo manifests | Architecture row. The editor and codecs are native. |
| 17.311 | Original codecs and provenance | PASS | Electron `docs/decisions/2026-10-14-original-document-engine.md`; Office `Cargo.toml` and `src/lib.rs` | No third-party Office engine in the port. |
| 17.312 | Native Word page layout appearance | PASS | Electron `src/components/documents/word-document-editor.tsx:579`, `word-paragraph.tsx`, `word-images.tsx`, `document-workspace.tsx:185`, `document-workspace.css` (`.docs-word-*`, `.docs-page-break-marker`, `.docs-status`), `globals.css` `::-webkit-scrollbar`; Word `layout.rs` `BreakHint`, `collapsed`, `column_fractions`, `scrollbar_thumb`; `view.rs` `paragraph_with_break`, `picture_element`, `block_element`, `scrollbar`; app `workspace/office.rs` `status_strip` | Word view spacing pass, 2026-11-22, `sample.docx` from `sample_docx`, 1280x820, scratch homes and profiles, Page, Continuous, Continuous with Outline and Page with Outline in light and dark (`.autoloop/runs/word-view/sbs-*.png`, with `diff-*.png`). Every text row, rule, picture, table line, column edge, scrollbar thumb and the status strip land within one device pixel of Electron in all eight captures. Fixed: an empty line above a break that opens a paragraph (Chromium keeps the line box before the block marker; the rule sat 22.4 px high); the picture is Electron's block button with 1 px border and 10 px margins collapsing with neighbours (it had 4 px padding, so the list sat 4 px high); table columns follow Chromium's automatic layout instead of equal thirds; the 6 px scrollbar takes layout width and paints the `--accent` thumb (the page sat 3 px right); the "Page break" label scales with zoom at a 10 px line; Electron's 38 px `.docs-status` strip under the page ("Saved", "Edited", "Not saved to a file yet" with the hover detail, `49 words · DOCX`), which also fixes Continuous paper running 38 px further; the toolbar's History button, which put the zoom and style groups on Electron's positions. Typing and Cmd-S moved both strips through `Edited · 50 words` and back to `Saved` (`strip-*.png`). Known rendering-only differences: GPUI draws glyphs slightly heavier and blends the last device pixel of a scaled picture's edge. Polish pass (2026-11-22, `.autoloop/runs/polish/`, 1280x820, light and dark): the title bar's "Save file" shows before Export for Word, RTF, ODT and `.wd`, as Electron's `documentMode` does (`sbs-word-light.png`, `sbs-word-dark.png`; `chrome.rs` `document_mode_for`, test `save_file_shows_where_electrons_document_mode_does`). The divider between zoom and style was already in place on this branch. Fixed in the formatting row (`markie-office-view/src/view.rs`): the colour control is Electron's `px-1` label with a 14 px select, which put the insert group within 1 pt of Electron's, from 4 pt left; the size field centres its number in the room Chromium leaves beside a number field's spin button and centres the line, so the digits land on Electron's pixels, from 3.5 pt high and 7.5 pt right; the selects and the size field take `.markie-overlay-field`'s 7 px corners, fill and border, and the font select shows its placeholder in the ink, as a select does (`crop-word-toolbar-*.png`, test `fields_take_electrons_overlay_field_colours`). The View menu's Page Layout, Continuous Layout, Document Outline, Actual Size and Light Paper now reach the open Word document whether or not the page has keyboard focus (`markie-office-view/src/actions.rs` `route_view_commands`, `main.rs`, `workspace/office.rs` `route_word_view_command`, test `every_view_menu_item_is_routed`). Checked with the Library filter holding focus: Document Outline closed the outline and Continuous Layout switched the page (`rs-view-menu-*.png`). Still differing: Insert link shows disabled in Markie RS until the selection allows a link, where Electron's button is always enabled. |

## 20. OS integration

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 20.342 | OS integration behavior | PASS | Electron `electron/main.js:3983-4030,4128`; App `main.rs` launch queue, `open_urls.rs`, `instance.rs` | Mac file/URL delivery and second launch dispatch share the same queue. Native OS tests below are scoped to macOS. |
| 20.342w | OS integration behavior on Windows | EXCLUDED-PLATFORM | App `instance.rs` | macOS-only benchmark; Windows is a later phase. |
| 20.343a | Sign-in return on the native side scheme | PASS | Electron `electron/deep-links.js`, `src/lib/auth-state.ts:19`; App `keeps_only_markie_rs_links_for_sign_in`; Cloud `start_urls_ask_for_the_markie_rs_hand_back` | URL hand-backs and initial argv dispatch to the same account handler. No live account sign-in attempted. |
| 20.343b | Anonymous public link and confirmation | PASS | Electron `electron/share-open.js:84`, `main.js` `openSharedTokenFromDeepLink`; App `share_plans`, `fetches_a_public_link_without_following_redirects` | Trust plan and local mock HTTP request, without sending an account bearer token. |
| 20.343c | Account document ID with source hint and own session | PASS | Electron `electron/main.js` `openCloudDocFromDeepLink`; App `deeplinks.rs:413`, `doc_links_carry_only_an_id`; Cloud `client.rs:102` | Uses the side build's own session on a trusted server. Live signed-in flow not run. |
| 20.344 | Claim file types in Settings | EXCLUDED | Electron `electron/default-apps.js`, `src/components/default-apps-section.tsx`; App `default_apps.rs` | Native buttons intentionally cannot take over. |
| 20.345 | Single instance; macOS OS events; argv | PASS | Electron `electron/main.js:4007,4022,4026,4128`; App `a_second_launch_hands_over_and_a_stale_socket_is_taken_over`, `args_round_trip`, `open_urls.rs:13` | Mac handlers route file URLs and auth callbacks; Unix handoff and cold path/URL ordering are covered by the isolated instance and open URL tests. No Windows implementation is claimed. |
| 20.345w | Windows second-instance handoff | EXCLUDED-PLATFORM | App `instance.rs` `cfg(not(unix))` | macOS-only benchmark; named-pipe single-instance support is deferred. |
| 20.346a | Hidden inset title bar and traffic lights | PASS | Electron `electron/main.js:883`; App `main.rs` `TitlebarOptions` | Capture pass 2026-11-22 against Electron 0.9.7, each window focused: the red light sits at (14, 14) and spans 13.5 pt in both apps, light and dark, with the same spacing to the markie wordmark (`.autoloop/runs/capture-pass/crop-titlebar.png`). |
| 20.346b | Linux desktop integration | EXCLUDED-PLATFORM | Electron `electron/linux-desktop.js:69,112`; Rust `scripts/com.zvn.markie.rs.desktop`; App `linux_launcher_advertises_only_the_side_build_scheme` | Linux registration and launcher behavior are a later phase. |
| 20.347 | Open passive local files, reveal other files | PASS | Electron `electron/main.js:2453`, `file-grants.js:66,87`, `local-open-policy.js:19`; Core `workspace_roots_grant_passive_files_and_never_turn_scripts_into_opens`; App `workspace/rich.rs` `open_rich_link` | `attachment_grants_are_exact_and_opened_document_grants_follow_moves` proves exact dropped-file grants, opened-document roots, and workspace roots. Targets are resolved before classification; scripts reveal only. |
| 20.348 | Source inventory for OS integration | PASS | Electron `electron/deep-links.js`, `default-apps.js`, `desktop-intents.js`, `local-open-policy.js`; App `deeplinks.rs`, `default_apps.rs`, `open_urls.rs`; Core `links.rs` | Implementation map, not a separate behavioral claim. |
| 20.349 | Compatibility surfaces | PASS | Electron `electron/main.js:2453,3983`; App `open_urls.rs:13`, `deeplinks.rs:303`, `workspace/rich.rs` | Native calls replace IPC. The session grant test covers local rights; default-app ownership changes remain deliberately excluded. |
| 20.350 | Default-app status and operations, external/local links, deep-link delivery | PASS | Electron `electron/main.js:2453,2567,4007`, `electron/default-apps.js`; App `default_apps.rs`, `open_urls.rs:13`, `workspace/rich.rs`; Core `only_plain_web_addresses_reach_the_browser` | Local links now use active session grants; external links and deep links retain their existing routing. Claims on file types and the shipping URL scheme remain excluded. |
| 20.351 | Raw route and Downloads landing | PASS | Electron `electron/share-open.js:84`, `main.js:2436`; App `fetches_a_public_link_without_following_redirects`, `landing_names` | Endpoint path, anonymous fetch and naming tested locally. |
| 20.352 | Packaging claims for the production bundle, scheme and UTIs | EXCLUDED | Electron `electron/main.js:4005`; `scripts/bundle-mac.sh:40,53` | Side bundle keeps `com.zvn.markie.rs`, only `markie-rs` and no file associations. |

## 22. Vault and clipboard

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 22.374 | Vault behavior | IMPROVEMENT | Electron `src/components/documents/vault-panel.tsx:326,610`; App `workspace/vault.rs`; `create_save_lock_unlock_backup_restore` | Local unlock, encrypted editing, save, backup, and automatic lock are covered by isolated tests. Actual Touch ID and the comparison capture remain separate checks. IMPROVEMENT (2026-11-23, `t3/markie-rs-vault-ux`): calmer layout on purpose. One filled primary action per state, a Locked/Unlocked chip and a Lock button in the header, messages next to what caused them instead of in the header, search once the list is longer than five, ⌘F and Escape. Evidence `.autoloop/runs/vault-ux/vault-before-after.png`. |
| 22.375 | Passphrase vault creation, unlock and generator | IMPROVEMENT | Electron `src/lib/vault/passphrase.ts:21,83`, `documents/vault-panel.tsx:338`; Vault compatibility test; App `create_save_lock_unlock_backup_restore`, `failure_copy_matches_electron` | Six-word generator, 16+ code points, wrong-passphrase behavior and no plaintext fallback. IMPROVEMENT (2026-11-23): Touch ID is the one primary button when it is on, with the passphrase one click away; the create card puts Suggest one beside the field and shows errors inline. Generator, limits and failure copy unchanged. |
| 22.376 | Encrypted documents and env key/value editor | IMPROVEMENT | Electron `src/components/documents/vault-panel.tsx`, `vault-env-editor.tsx`; App `workspace/vault.rs:1671,1881`, `parked_keys_are_masked`, `key_problems` | `private_docx_preserves_original_bytes_and_edits_survive_encrypted_save` covers the in-vault engine. Revealed multiline env values are editable in their row and removed from the visible editor when hidden. IMPROVEMENT (2026-11-23): rows use eye, copy and trash icons in a bordered table; a copied row shows a check. Parsing, masking, parked keys and the Raw view are unchanged. |
| 22.377 | Real Touch ID unlock and confirmation of open, reveal and copy | NEEDS-KIRBY | Electron `electron/vault-touch-id.js`, `vault-panel.tsx:207`; App `workspace/vault.rs` `unlock_with_touch_id`; Vault `device.rs` | Trait tests are not a real sensor check. Follow procedure below. |
| 22.378 | Copy a secret and clear only if unchanged | IMPROVEMENT | Electron `electron/secret-clipboard.js:20,36`; Vault `clears_after_the_timer_if_unchanged`, `leaves_what_the_user_copied_since`, `a_new_copy_replaces_the_old_timer_and_clear_now_works`; App `workspace/vault.rs` `secret_pasteboard` | macOS concealed pasteboard implementation plus tests named in this row. Clears after 30 seconds if unchanged; non-macOS is listed separately. IMPROVEMENT (2026-11-23): the copy confirmation counts down ("Copied API_KEY. Markie clears it from the clipboard in 30 s.") instead of one long sentence in the header. Clearing rules unchanged; `copy_feedback_counts_down_and_ends`. |
| 22.378w | Secret clipboard on Windows and Linux | EXCLUDED-PLATFORM | App `workspace/vault.rs` `secret_pasteboard` | Non-macOS clipboard behavior is a later phase. |
| 22.379 | Vault backup and restore | PASS | Electron `src/lib/vault/backup.ts:26,33`; App `create_save_lock_unlock_backup_restore`; Vault compatibility test | Test-only backup round trips in both directions. |
| 22.380 | Vault source surfaces | PASS | Electron `src/lib/vault/`, `src/components/documents/vault-panel.tsx`, `electron/secret-clipboard.js`; Vault crate, App `workspace/vault.rs:1947` | Native codec, repository, clipboard and UI are identifiable. |
| 22.381 | Exact vault wire format | PASS | Electron `src/lib/vault/envelope.ts:119,140,153`; Vault compatibility test | Ciphertext envelopes, canonical validation and backup interoperability exercised. |
| 22.382 | Header PBKDF2, SHA-256, iteration cap and AES-GCM wrap | PASS | Electron `src/lib/vault/envelope.ts:2,125`; Vault `header_rejects_non_canonical_forms`; Vault compatibility test | TypeScript create to Rust unlock and inverse. |
| 22.383 | Document envelope AES-GCM/AES-KW and device slot v1 | PASS | Electron `src/lib/vault/envelope.ts:144,159`; Vault compatibility test | Synthetic binary and empty documents, plus a fake device secret. |
| 22.384 | 8 MiB content and 128 records | PASS | Electron `src/lib/vault/envelope.ts:2`, `storage.ts:44`; Vault `envelope.rs` `limits`, `storage.rs` | Same checked content/record caps. |
| 22.385 | IndexedDB store and cutover | EXCLUDED | Electron `src/lib/vault/storage.ts:44`; Migrate `the_migrated_vault_opens_with_the_fixture_passphrase` | Native uses its own atomic JSON. Migration postponed by Kirby. |
| 22.386a | Touch ID available, enroll, unlock, confirm, remove transport | NEEDS-KIRBY | Electron `electron/vault-touch-id.js`; App `workspace/vault.rs` `refresh_touch_id`, `enroll_touch_id`; Vault `device.rs` | Native takes the place of IPC. Check all five operations on the sensor. |
| 22.386b | Clipboard copy and clear transport | PASS | Electron `electron/secret-clipboard.js:20`; Vault `clipboard.rs:85`; App `workspace/vault.rs` `secret_pasteboard` | macOS native copy/clear takes the place of IPC. Fake clipboard tests cover clearing, replacement and the timer. |
| 22.386bw | Clipboard copy/clear transport on Windows and Linux | EXCLUDED-PLATFORM | App `workspace/vault.rs` `secret_pasteboard` | Non-macOS clipboard behavior is a later phase. |
| 22.387a | RustCrypto, LocalAuthentication and separate Keychain | NEEDS-KIRBY | Electron `electron/vault-touch-id.js`, `src/lib/vault/envelope.ts`; Vault `Cargo.toml`, `device.rs`; App `the_vault_lives_in_markie_rs_own_places` | Crypto proven separately. Verify the actual consent sheet and Keychain lifecycle with a scratch vault. |
| 22.387b | IndexedDB migration | EXCLUDED | Electron `src/lib/vault/storage.ts:44`; Migrate `the_migrated_vault_opens_with_the_fixture_passphrase` | Same switchover rule as 22.385. |
| 22.A | Window hiding and idle lock | PASS | Electron `src/components/documents/vault-panel.tsx:328,610`; App `hidden_window_triggers_the_same_lock_as_idle_without_reentering` | Native visibility invokes the bounded checkpoint. The live minimize/restore and platform visibility definitions remain to be checked. |
| 22.B | Locked and unlocked vault appearance | PASS | Electron `src/components/documents/vault-panel.tsx:719`, `vault-env-editor.tsx`; App `workspace/vault.rs:1404,1671,1947` | Capture pass 2 (2026-11-22, `.autoloop/runs/capture-pass-2/`), light, scratch vault created by passphrase in both. The locked page now matches (`sbs-vault0-light.png`, `sbs-vault-typed-light.png`: card, label, fields, strength meter "Strong · about 71 bits", buttons). Fixed in `vault.rs` and `chrome.rs`: the title bar shows "Protected documents" with no rename or copy, as document-workspace.tsx; the header has `leading-tight` and `text-sm` lines; the card is `bg-surface`; the label has its tracking; Create, Suggest a passphrase and Restore from backup… are plain text buttons with `px-3 py-2` as Electron 0.9.7 paints them (its filled and underlined classes do not reach the screen), not a filled button and blue links. Fields are still about 4 pt shorter. Unlocked page (`sbs-vault-open-light.png`): same structure and wording, but Markie RS draws bordered Settings and Lock vault, a filled "Use Touch ID…", a link-styled "Not now", bordered list actions and a grey list column, where Electron paints plain text buttons on the page background. Fix: `plain_button` for those actions and the page background for the list column. Not reached: dark, lock and unlock, backup and the env page (macOS crash alerts for another app covered the middle of the screen). Touch ID was not touched. Cloud and vault pass (2026-11-22, `.autoloop/runs/cloud-vault/`): matched, light and dark. The cause of every remaining difference was one stylesheet rule: the vault sits in `.docs-workspace`, whose unlayered `button` and `input` rules outrank the Tailwind classes vault-panel.tsx and vault-env-editor.tsx write (Tailwind's are in `@layer utilities`). So every vault button, primary, quiet or bordered, is plain 13 px text with `6px 9px` inside a transparent 1 px border, the accent on hover and while pressed, 45% when disabled; every field is 7 px by 9 px with the parent's type and line height (36 pt under a `text-sm` label); the list items lose their selected fill (there is no `.bg-accent`). Fixed in `vault.rs`: `docs_button`, `docs_button_sized` and `docs_input` replace every gpui-kit button and field on the page, the list column and the Touch ID offer use `--surface`, `text-sm` and `text-xs` carry Tailwind's 20 px and 16 px lines, the Settings heading 24 px, the Touch ID sentence wraps inside the 576 pt column with its button below, and the env editor follows the same rules (Keys and Raw pressed fill, Show and Hide pressed when revealed, Add key at its own width, no empty table). Add key now leaves an editable row saying "Add a key name.", as Electron keeps its edited model; it used to re-read the text and call the `=` line unreadable (`env_rows`). Paired: locked and typed (`sbs-vault0-dark.png`, `sbs-vault-typed-dark.png`, `sbs-vault-locked-dark.png`), unlocked (`sbs-vault-open-dark.png`, `sbs-vault-unlocked-dark.png`), lock with unsaved edits, unlock, Settings (`sbs-vault-settings-dark.png`, `sbs-vault-settings-light.png`), backup and the restore form (`rs-vault-backup-dark.png`, `sbs-vault-restore-dark.png`), the env page (`sbs-vault-env-dark.png`, `sbs-vault-env-light.png`, `sbs-vault-envrow-light.png`). Electron's backup is a browser download into the real Downloads, so it was compared from source; Markie RS saves through a save panel and says "Backup saved." (PLATFORM.md records that choice, and "Save unencrypted copy…" for the same reason). Touch ID was not touched. |

## 25. Hidden terminal

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 25.409 | PTY tabs, 12 sessions, shortcut and external terminal | EXCLUDED | Electron `src/lib/features.ts` `TERMINAL_ENABLED`; `electron/terminal.js` | Feature ships hidden. |
| 25.410 | Terminal sources | EXCLUDED | Electron `electron/terminal.js`, `src/components/terminal-panel.tsx` | No native terminal module. |
| 25.411 | Terminal IPC and events | EXCLUDED | Electron `electron/main.js:1778` | No parity target under the hidden flag. |
| 25.412 | Proposed native PTY and emulator | EXCLUDED | Electron `src/lib/features.ts`; Rust App `Cargo.toml` | Not introduced in the side build. |

## 26. Auto-update

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 26.416 | Update behavior | EXCLUDED | Electron `electron/main.js:3278`; App `main.rs:1` | No side-build updater. |
| 26.417 | Manual and six-hour checks | EXCLUDED | Electron `electron/main.js:3278`, `update-policy.js` | Not polled. |
| 26.418 | Beta opt-in and latest default | EXCLUDED | Electron `electron/update-channel.js` | Not offered. |
| 26.419 | Sticky ready notice and restart to install | EXCLUDED | Electron `src/components/update-toast.tsx` | Not offered. |
| 26.420 | Separate private and preview updater behavior | EXCLUDED | Electron `electron/update-policy.js`, `private-release.js` | No release channels in this build. |
| 26.421 | Update sources and feed manifest | EXCLUDED | Electron `electron/update-channel.js`, `updater-logging.js`; `server/download-manifest.json` | Rust does not consume the feed. |
| 26.422 | Update IPC, events and latest/beta feeds | EXCLUDED | Electron `electron/main.js:3278`, `electron/preload.js`; App `main.rs:1` | No replacement contracts in the side build. |
| 26.423 | New updater and feed migration | EXCLUDED | Electron `electron/update-policy.js`; App `main.rs:1` | Switchover concern only. |

## 27. Crash reporting and logs

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 27.427 | Crash reporting behavior | EXCLUDED | Electron `electron/main.js:301,347,939,3605`; App `logs.rs:415,438` | The live scratch document failure recovered without changing the source bytes. Fatal crash parity still lacks Electron's out-of-process Crashpad supervision; see 27.431. Rescored EXCLUDED (Kirby, 2026-11-22: the crash report file format is internal; Markie RS writes Apple .ips reports instead of Crashpad .dmp). |
| 27.428 | Opt-in; default off; inert without DSN | PASS | Electron `electron/crash-reporting.js:33,82,95`; App `consent_fails_closed`, `dsn_rules` | No live DSN used. |
| 27.429 | Reveal Crash Log in Help | PASS | Electron `electron/main.js:3633` and `revealCrashLog`; App `main.rs:179`, `logs.rs:438`, `log_rotates_one_generation` | Same command and empty-log treatment; actual file-manager UI not driven. |
| 27.430 | Top-level error boundary and error logging | PASS | Electron `src/components/error-boundary.tsx`; `electron/main.js:939,3605`; App `logs.rs:415` | The scratch Word pane visibly displayed the error screen. Reload reopened the same fixture without changing its SHA-256. Unit test: `a_failed_projection_does_not_prevent_the_replacement_from_rendering`. |
| 27.431 | Crash reporter sources, envelope, log, DSN, stdio | EXCLUDED | Electron `electron/crash-reporting.js:95`, `sentry-envelope.js`, `crash-log.js:14`, `stdio-guard.js:20`; App `entry_format_matches_electron`, `envelope_shape_and_scrubbing`, `logs.rs:415` | The app reveals its own macOS `.ips` reports without uploading them, verified with a scratch metadata fixture. It does not produce Electron's Crashpad `.dmp` files. A real fatal-process test would write an OS report outside the allowed scratch location; exact dump parity needs a separately approved crash reporter or an isolated macOS test environment. Rescored EXCLUDED (Kirby, 2026-11-22: the crash report file format is internal; Markie RS writes Apple .ips reports instead of Crashpad .dmp). |
| 27.432 | Consent, reveal and renderer-error operations | PASS | Electron `electron/main.js:3605,3612,3620,3633`; App `logs.rs:132,140,438` | The scratch process wrote exactly one renderer error, kept the app alive, and recovered through Reload. Existing consent and log reveal tests apply; the shared system clipboard was not overwritten by the probe. |
| 27.433 | Panic hook and scrubbed Sentry envelope POST | PASS | Electron `electron/crash-reporting.js:95`, `sentry-envelope.js`; App `logs.rs:390,415`, `scrub_matches_the_javascript`, `frames_from_v8_and_rust`, `envelope_shape_and_scrubbing` | Native platform and stack types differ; wire envelope and scrub tested, no external upload. |

## 31. Miscellany

| ID | Inventory item | Status | Evidence | Notes |
|---|---|---|---|---|
| 31.472 | Private release gate | EXCLUDED | Electron `electron/main.js:1330`, `private-release.js`; App `main.rs:1` | Electron release-lane machinery. The side build has no release pipeline, as with its updater. |
| 31.473 | Suppress document UI until authorization | EXCLUDED | Electron `electron/main.js:1330`, `src/components/private-release-gate.tsx`; App `main.rs` `gpui_kit::open_window` | The macOS side app is not a private Electron release variant; no release authorization UI is required. |
| 31.474 | Private release status, session, authorize, lock and auth hand-back | EXCLUDED | Electron `electron/main.js:1333-1345`; App `open_urls.rs:23`, `workspace/account.rs` | Private release-session and build-credential IPC belong to the shipping Electron release pipeline. |
| 31.475 | Private-release and preview CLI flags | EXCLUDED | Electron `electron/private-release.js`, `desktop-preview.cjs`; App `main.rs` initial args | The private-release and preview launch flags belong to Electron's release pipeline. |
| 31.476 | One-time welcome; skip if the OS opened a file | PASS | Electron `src/lib/first-run.ts:30`, `welcome-doc.ts`, `src/app/page.tsx:1972`; App `a_handed_over_file_does_not_consume_the_welcome_document`, `main.rs` launch queue | First-run marker uses the isolated registry. Already queued Finder files and argv go first. The live cold Finder timing still needs to be checked. |
| 31.477 | Inline MP4 player; link dropped attachments in place | PASS | Electron `src/lib/rehype-media.ts:17,32`, `attach.ts:50,67`; Rust editor `render.rs:956`, `hrefs_like_attach_ts`, `attachments` | An authorized synthetic MP4 played inline with changing frames and WebKit controls. `mp4_seeking_accepts_a_bounded_range_only` tests seeking bounds. Dropped files remain in place, with exact grants and relative or absolute links as in `attach.ts`. |
| 31.478 | Persistent hash media cache, `asset-cache/cache.json` | PASS | Electron `electron/asset-cache.js:39`, `main.js:1714`; App `workspace/cloud_resources.rs:36`; Cloud `assets.rs:374` | `persists_deduplicated_hash_files_and_wipes_when_account_changes` and `never_overwrites_through_a_cache_symlink` cover `<Markie RS data>/asset-cache/cache.json`, hash blobs, limits, and account isolation. |
| 31.479 | Security posture | PASS | Electron `electron/csp.js:64`, `main.js:2453`, `share-open.js:84`; App `deeplinks.rs:303`, `workspace/rich.rs`; Web `island.rs:412` | All four enumerated safety policies are present. Exact functional filesystem grants are tracked separately in 20.347. |
| 31.480 | Only YouTube and Vimeo remote player frame origins | PASS | Electron `electron/csp.js:15`; Export `embeds.rs:27,114`; Web `island.rs:408,412` | Only a canonical provider iframe on the video path; Darkmown has its own no-frame policy. |
| 31.481 | Origin allowlist before sending a bearer token | PASS | Electron `electron/main.js` `trustedServerArg`, `share-origin.js`; Cloud `client.rs:59,95,102`, `allowed_server_origin`, `redirects_are_not_followed` | Untrusted share host fetch is anonymous after consent. |
| 31.482 | Native confirmation for untrusted share host | PASS | Electron `electron/main.js` untrusted share prompt; App `deeplinks.rs:333,362`, `share_plans` | Host trust decision tested. UI uses the native window prompt before fetch. |
| 31.483 | Never launch scripts or apps from links | PASS | Electron `electron/local-open-policy.js:19`; Core `passive_files_open_and_programs_are_shown`, `workspace_roots_grant_passive_files_and_never_turn_scripts_into_opens`; editor `scripts_bundles_and_other_schemes_never_reach_the_opener`; Office `src/docx/links.rs:17` | Programs reveal rather than launch. Word links only receive allowed web/mail destinations from the codec. |

## Deferred screen verification

The baseline pass had a locked console. The follow-up captured Markie RS
Word and vault views in both themes at 1280 × 820 points. Installed Electron
0.9.7 opened the scratch Office Library automatically. Close inputs sent
only to the scratch PID did not dismiss it, and accessibility exposed no
web area to confirm panel state, so those reference captures were removed.
There is no valid paired geometry or styling verdict for 20.346a yet; 22.B
was paired by the cloud and vault pass (row above). 17.312 was captured in both themes by the Word view spacing pass (row above). To repeat them:

1. Make a private scratch directory with separate `rs-home`, `rs-data`,
   `electron-home`, `electron-data` and fixture directories. Generate a Word
   fixture with `cargo run -p markie-office-view --example sample_docx -- <fixture.docx>`.
   Give each app its own identical copy (and a separate HTML fixture for
   the importer). Build Markie RS with the documented local bundle command;
   do not register production schemes.
2. Start each binary in the background under a short screen lock, redirecting
   its process output to its own scratch log. For Markie RS:

   ```sh
   rust/scripts/screen/with-screen-lock.sh office-rs -- sh -c '
     env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME="$1" MARKIE_RS_DATA_DIR="$2" "$3" "$4" >"$5" 2>&1 &
     printf "%s\n" "$!"
   ' sh "<rs-home>" "<rs-data>" "rust/target/release/Markie RS.app/Contents/MacOS/markie-rs" "<rs-fixture.docx>" "<rs.log>"
   ```

   For Electron, use its separate home, profile and fixture:

   ```sh
   rust/scripts/screen/with-screen-lock.sh office-electron -- sh -c '
     env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u ELECTRON_RUN_AS_NODE HOME="$1" /Applications/Markie.app/Contents/MacOS/Markie "--user-data-dir=$2" "$3" >"$4" 2>&1 &
     printf "%s\n" "$!"
   ' sh "<electron-home>" "<electron-data>" "<electron-fixture.docx>" "<electron.log>"
   ```

   Use a short scratch path to avoid the Unix socket path limit. Record only
   the launched PIDs. Do not capture until the reference Library has been
   confirmed closed, and never navigate into Browse, Search or Library.
3. Use only `rust/scripts/screen/act.sh <pid>` for focus, keys, menus and
   clicks. Resize each to `1280 820`. Under Appearance choose Light in each
   scratch session, then Dark for the second pass. Capture the same Word
   Page, Continuous and Outline views with the title bar visible; include
   the formatting row and a Review or print sheet using the same fixture.
4. In each scratch app, use View/Vault or the Vault rail icon. Capture the
   locked screen, then create a new synthetic passphrase vault without the
   Touch ID offer, import a synthetic `.env` with two keys and save an
   encrypted note. Capture the unlocked list, env editor with values masked,
   and settings, light and dark. Minimize each with `act.sh <pid> minimize`;
   restore/focus and confirm the vault checkpoint locked without losing the
   last saved note.
5. Capture with `rust/scripts/screen/capture.sh <pid> <out.png>`; compare via
   `rust/scripts/screen/side-by-side.py <electron.png> <rs.png> <comparison.png> --diff <diff.png>`.
   Put results under `.autoloop/runs/office-platform/` and quit only by
   `kill <owned-pid>`.

For 22.377, 22.386a and 22.387a, Kirby can open a scratch vault on a Touch
ID Mac, enroll after entering the passphrase, and lock. Cancel the first
biometric unlock and verify it stays locked, then unlock with a finger.
For a test note and an env key, verify each Open, Reveal and Copy prompts
afresh and cancellation keeps the content hidden and the clipboard unchanged.
Disable Touch ID in the scratch vault settings and verify the unlock button
disappears and the test item is removed. Do not print keys or use the
installed Markie Keychain item.

Linux launcher check (only in a scratch Linux desktop with `markie-rs` on
PATH): install `rust/scripts/com.zvn.markie.rs.desktop` in the scratch
`XDG_DATA_HOME/applications` directory, refresh with
`update-desktop-database`, and use
`xdg-mime default com.zvn.markie.rs.desktop x-scheme-handler/markie-rs`.
Check that only the side-build scheme resolves to the new entry. Do not make
it a handler for either document types or `markie://`.

## Merge touchpoints and reference verification

- App `src/main.rs` and `src/open_urls.rs`: forward cold local file URLs and
  auth links through the same paths as running-instance deliveries. In
  `src/workspace.rs`, `src/workspace/untitled.rs`,
  `src/workspace/first_run.rs` and `src/workspace/import_copy.rs`, keep the
  first-run marker and import generation local.
- App `src/workspace/rich.rs`, editor `src/behaviour.rs` and `src/lib.rs`,
  and Core `src/links.rs`: apply workspace roots before opening local links;
  keep restricted Cloud copies bounded.
- Word `src/actions.rs`, `commands.rs`, `editor.rs`, `editor_tests.rs`,
  `tools.rs`, and `view.rs`: Find and Replace, the menu gates, and round-trip
  proofs. Office `src/docx/review.rs` and `tests/docx_operations.rs`: list
  numbering reuse order. App `src/workspace/vault.rs`: native visibility and
  checkpoint lock.
- Ran Electron's own sources with Node and synthetic inputs. Confirmed
  unchanged bytes and edit/reopen on DOCX, RTF and ODT; literal Find and
  Replace; numbering reuse order; Word menu IDs, labels and order; malformed Unicode rejection;
  one-time welcome; passive file classification; and clipboard clear
  semantics. The cross-language vault fixture passed all 12 check groups.
- Final `cargo test --workspace`: 977 passed, 0 failed, 2 ignored. Focused
  suites also passed: 61 Word view tests, 16 DOCX operation tests and 5 local
  link tests. The real Keychain integration test was not run. The inventory
  row count and `git diff --check` both passed.

| Commit | Audit rows addressed |
|---|---|
| `4c51b5c` | 17.300 and 17.302: bounded import reads, strict DOC Unicode, stale result guard. 20.343a, 20.345 and 20.346b: startup handoff and Linux entry. 31.476: one-time onboarding. |
| `cad4a66` | 17.299: literal Find and Replace. 17.303 and 17.309a: native commands suspend while a Word tool is open. 17.309b: byte and edit/reopen proof. |
| `fd74119` | 17.299 and 17.306: reuse numbering instances in source order. |
| `85d18ba` | 17.298 and 17.306: Word print pagination as Chromium's, measured against Electron's PDFs (branch `t3/markie-rs-native-print`). |
| `9b8dfea` | 20.347 and 20.350: workspace-root local links. 31.483: test the no-launch rule with a granted root. |
| `8136dc2` | 22.A: trigger lock on native window hiding and keep a timed-out repository checkpoint off the UI thread. |

## macOS follow-up verification

- `25d23d4`: exact user-dropped attachment grants, opened-document directory
  grants, workspace roots, and grant movement. Passive files open; executable
  targets reveal only.
- `6931d50`, `cb44d23`: encrypted DOCX run edits and revealed multiline env
  editing. The DOCX regression checks untouched bytes and encrypted reopen.
- `b6852a6`, `754c164`, `8f632a3`: untitled Office first save and recovery,
  native File/View mapping, and selection/modal gating. `bb12e89` proves
  DOC subprocess extraction and timeout reaping. `0a4f6f3` reuses primitives
  already present in Markie RS for browser-standard codec behavior; it
  replaces the handwritten HTML fragment builder and entity table.
- `118b3d9`: account-bound, content-addressed cache under the side app's data
  folder. Tests cover the Electron index shape, reuse, eviction and symlink
  refusal.
- `905e8c9`, `4ecc4e3`: a deliberate scratch render failure showed the
  error screen, logged exactly once, and reopened the fixture on Reload
  without changing its SHA-256. It did not exercise a fatal process crash.
  Native report discovery uses [Apple's .ips report metadata](https://developer.apple.com/documentation/xcode/interpreting-the-json-format-of-a-crash-report),
  not Crashpad. No native report was collected from outside scratch.
- `4622669`: a scratch MP4 played inline. The pictures at two timestamps
  show WebKit controls and changing playback frames.

Native-only evidence is in
`.autoloop/runs/office-platform-resume.rHbmVA/` in this worktree:
`probe-before.png`, `probe-after.png`, `clip-playing-a.png`,
`clip-playing-b.png`, and the four `rs-word-*` and `rs-vault-*` captures.
The app processes launched for verification have been closed. Copy details
was not clicked because the desktop clipboard is shared.

The final Rust run, `cargo test --workspace`, passed **990 tests**, with 0
failures and 2 ignored. The ignored Keychain tests were not run.
