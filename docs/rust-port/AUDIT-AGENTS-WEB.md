# Audit: agents, skills, Darkmown, Live Docs and export

Date: 2026-11-22. Branch `t3/markie-rs-agents-web-parity`, from `rust/markie-rs` at 3b6f6c0.
Reference: Electron Markie 0.9.7 (`/Applications/Markie.app`) and its source at ae62cfa.
Sections: PARITY.md 15, 16, 18, 19 and 23.

## Score

Parity score: **52 / 53 = 98.1%**. That is PASS over all 67 rows less the 14 excluded ones (13 nightly, 1 Windows). No row needed plain EXCLUDED: nothing in these sections is the updater, the terminal, the Recovered list, sign-in moving, file-type claims or the private-release gate.

| Status | Rows |
|---|---|
| PASS | 52 |
| FAIL | 1 |
| NEEDS-CAPTURE | 0 |
| EXCLUDED | 0 |
| EXCLUDED-NIGHTLY | 13 |
| EXCLUDED-PLATFORM | 1 |
| All rows | 67 |

The screen was locked for the whole run (`IOConsoleLocked = Yes`), so no window could be captured or driven. Visual rows are NEEDS-CAPTURE with steps at the end. Exported PDFs need no window, so they were compared page by page and measured (row 23.1).

Follow-up on 2026-11-22, branch `t3/markie-rs-native-print` (no web views, Kirby's decision): rows 23.1 and 23.3 were reworked natively and re-measured against Electron's own `printToPDF` output. 23.1 is now PASS; 23.3 stays FAIL for math only. Evidence: `.autoloop/runs/native-print/` (see its README).

## How rows were checked

- **MCP against both apps' code.** `.autoloop/runs/audit-agents-web/scripts/mcp-diff.mjs` starts Electron's `mcp/markie-mcp.mjs` and Markie RS's bootstrap `markie-rs-mcp.mjs` on the same scratch HOME, sends identical JSON-RPC, and compares every reply and every file written. 23 of 23 steps were identical: initialize, tools/list, resources, the guide, ping, an unknown method, find, search, read, write, the Markdown aliases, home-folder refusals, list_skills, check_md and check_wd on good and broken sources.
- **Bridge with the real Node client.** `markie-agent` `tests/bridge.rs` runs the repo's own `mcp/agent-client.mjs` and `mcp/lib.mjs` against a scratch Markie RS socket: discovery, modes, every method, bad token, bad JSON, unknown method, oversized and fragmented frames.
- **Goldens from Electron's own code.** Each golden script imports Electron's TypeScript or main-process module and writes what it returns. The Rust test compares against those bytes.
  - Export: `markie-export/scripts/goldens.mjs`. It was rerun today against the reference: no golden changed.
  - Darkmown preview: `markie-web/scripts/goldens.mjs`. Rerun today: no change.
  - New: `markie-agent/scripts/frontmatter-goldens.mjs` (38 SKILL.md front-matter cases through `electron/skill-frontmatter.js`).
  - New: `markie-agent/scripts/skills-goldens.mjs` (a 29-file agent tree through `mdindex.js` `skillToolFor` and the Skills view's own grouping code).
- **PDFs.** Electron's exact PDF HTML (`markie-export/scripts/electron-pdf-html.mjs`) printed by Electron 42.11.18's own `printToPDF` with Markie's options, in a hidden window with a scratch profile, against Markie RS's Typst PDF of the same fixture. `scripts/pdf-lines.py` matches the two PDFs' lines by text and reports each baseline's offset.

## Section 15: agent bridge, MCP server and remote agents

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 15.1 | Connect Claude, Codex and others; the Agents dialog shows `claude mcp add` and a Codex snippet | PASS | `agents-dialog.tsx`; RS `workspace/agents.rs` `local_body`; commit 4bcd416 | Was FAIL: RS's dialog cut most of Electron's copy, used a plain button for the checkbox and hid the commands when the bridge was down. Now Electron's text, tool list, Cloud paragraph, checkbox, conventions block and copy blocks with their hints. Side-build rule: the server is named `markie-rs` and points at the RS bootstrap, quoted for the space in "Markie RS.app". The footer says Node 22.15 and that Markie RS must be open, because the RS bootstrap needs `registerHooks` and RS is never auto-launched. |
| 15.2 | Find documents | PASS | mcp-diff: find_documents all, query, find_md identical | Same Node source. |
| 15.3 | Search documents | PASS | mcp-diff: search_documents identical | |
| 15.4 | Read documents | PASS | mcp-diff: read md, json, read_md, outside-home refusal identical | |
| 15.5 | Write documents | PASS | mcp-diff: write_document, write_md (file bytes compared), outside-home refusal identical | |
| 15.6 | List skills | PASS | mcp-diff: list_skills identical | |
| 15.7 | Open files in Markie | PASS | `markie-agent` bridge test (`open_in_markie`); `app-smoke.mjs`; AGENTS-BRIDGE.md app smoke | Side-build rule: opens in the running Markie RS through its socket, never `open -a Markie`. |
| 15.8 | Check `.md` files | PASS | mcp-diff: check_md identical | |
| 15.9 | Check `.wd` files | PASS | mcp-diff: check_wd good and broken identical | |
| 15.10 | Read the guide | PASS | mcp-diff: guide tool and `markie://guide` resource identical | |
| 15.11 | Cloud status | PASS | `tests/cloud.rs`; INTEGRATION-CLOUD.md live run (`agent-status.json`) | |
| 15.12 | Cloud sync, with consent | PASS | `sync_keeps_attribution_on_creation_only_and_reports_private_link`; `permissions` test; commit 4bcd416 | Was FAIL: RS asked with a third "Always Allow" button and a warning sheet. Now an informational NSAlert sheet with Put in Cloud, Don't Allow and the "Always allow agents to put files in Markie Cloud" checkbox, which counts only with Put in Cloud, as Electron's `checkboxChecked`. The home refusal now says "can go to Markie Cloud" as `agent-cloud.js` does. Capture pass 2 (V3): the sheet matches Electron's `dialog.showMessageBox` word for word and in layout (`sbs-v3-sheet-light.png`), and Don't Allow returns the same refusal from both bridges. |
| 15.13 | Public links, with consent every time | PASS | `public_link_reads_do_not_create_and_live_docs_refuse_creation`; commit 4bcd416 | Was FAIL: the sheet's detail dropped ", without a Markie account. You can revoke the link later." Fixed. |
| 15.14 | Comments | PASS | `comments::tests::a_stable_build_saves_nothing`; bridge test rejects with the super-nightly sentence | 0.9.7 stable refuses with Electron's exact sentence; the nightly path is EXCLUDED-NIGHTLY below. |
| 15.14n | Comments that save (nightly half) | EXCLUDED-NIGHTLY | `localCommentsEnabled()` = `nightlyEnabledInMain()` in `electron/main.js` | Ported anyway behind `MARKIE_RS_NIGHTLY=1`. |
| 15.15 | Remote agents use Cloud agent tokens | PASS | `tokens::tests::refusals_say_what_agent_tokens_ts_says`; `remote_tokens_list_create_and_idempotent_revoke`; commit 4bcd416 | Was FAIL: placeholder `YOUR_TOKEN` (Electron `<token>`), no server wording for 400/409/422, raw dates, hidden token, shorter copy, a different revoke question. Now Electron's panel text, `formatWhen` dates ("Nov 22, 2026"), the token shown once, the new row added at once, separate load, create and revoke errors, and the scrim not closing while a token is on screen. |
| 15.16 | Files: main (`agent-bridge`, `agent-cloud`, `agent-history`, `agent-comments`) | PASS | `markie-agent/src/{bridge,cloud,comments}.rs`, history in `workspace/agents.rs` | |
| 15.17 | Files: MCP server stays Node, shipped in Resources | PASS | `markie-rs-mcp.mjs` bootstrap; bundle script copies `mcp/`; mcp-diff | |
| 15.18 | Files: renderer `agents-dialog`, `remote-agents-panel`, `agent-tokens` | PASS | `workspace/agents.rs`, `markie-agent/src/tokens.rs` | |
| 15.19 | Unix socket in a 0700 folder; 0600 discovery file naming socket and token | PASS | `real_node_mcp_and_client_only_reach_the_scratch_bridge` (modes checked) | Side-build rule: lives in RS's data folder, not `~/.markie`. |
| 15.20 | One request per connection, newline-delimited JSON | PASS | bridge test (fragmented, oversized, bad JSON); `unknown_methods_print_as_javascript_string_does`; commit 4bcd416 | Was FAIL in one corner: an unknown method that was a number or array printed as JSON, not as JavaScript's `String()`. Fixed. |
| 15.21 | Methods `cloud_*`, `history_note_write`, `comments_*` | PASS | bridge test calls each method | RS adds `open_in_markie` for the side build. |
| 15.22 | Consent stored in `agent-permissions.json` as `{cloudSync: "always"}`; public confirmed every time | PASS | `opt_in_and_revocation_persist_and_corruption_defaults_to_ask` | |
| 15.23 | `markie_open_in_markie` runs `open -a Markie` | PASS | bootstrap replaces the launcher with the RS socket | Side-build rule: RS must never open Electron. |
| 15.24 | IPC `mcp-info`, `agent-permissions`, `agent-permissions-set` | PASS | `adapter_path()`, `permissions::sync_always` / `set_sync_always` | Direct calls replace IPC. |
| 15.25 | REST `GET`/`POST /api/agent-tokens`, `DELETE /api/agent-tokens/:id` | PASS | `remote_tokens_list_create_and_idempotent_revoke` (wiremock) | |
| 15.26 | Keep the socket protocol exactly | PASS | rows 15.19 to 15.21 | |
| 15.27 | Bundle Node and the `mcp/` folder | PASS | bundle copies `mcp/`; expects system Node like the Agents setup says | Electron also runs the user's `node`. |
| 15.28 | Bridge on Windows (off in Electron) | EXCLUDED-PLATFORM | `startAgentBridge` returns on `win32` | |

## Section 16: Skills and agent files view

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 16.1 | SKILL.md and agent instruction files grouped by Claude, Codex, Cursor, Gemini, Universal | PASS | `tests/skills_golden.rs` `rows_match_electrons_skills_view` (24 rows, Electron's own grouping code); commit 7654097 | Was FAIL. RS used the skills folders, not the tool roots, to name a skill's tool; preferred README.md as a folder's entry; labelled a non-skill SKILL.md without its folder; dropped non-Markdown agent files; used home-relative paths for the cache and kind rules. The panel had no star, no Show in Finder, a dialog instead of the inline "Move … to the Trash?", "Full paths" instead of `~/`, absolute paths, a Rescan button, other empty and loading text, and no update when the index changed. All now as `skills-view.tsx`. Capture pass 2 (V4): the panel lists the golden tree by tool (`rs-skills-fixed-dark.png`). |
| 16.2 | Descriptions from front matter | PASS | `frontmatter::tests::matches_electrons_parse_frontmatter` (38 cases from `skill-frontmatter.js`) | Was FAIL: RS's own reader differed on comments, escapes, empty keys, unindented block bodies and anchors. Now a line-for-line port. |
| 16.3 | Move an installed skill to the Trash | PASS | `trash_guard_only_allows_direct_real_install_directories`; commit 7654097 | Electron's guard words and the inline confirm. Host Trash not exercised in a test. |
| 16.4 | Files: `skills-view`, `skills-panel`, `agent-files`, `skill-trash`, `skill-frontmatter`, `mdindex` skill roots | PASS | `markie-agent/src/{skills,frontmatter}.rs`, `workspace/skills.rs` | |
| 16.5 | IPC `skills-trash` | PASS | `trash_target` + `trash::delete` | Direct call. |
| 16.6 | Only a folder directly in a tool's skills folder qualifies, realpath-checked | PASS | `trash_guard_only_allows_direct_real_install_directories` (symlink, nested, project) | |
| 16.7 | Registry tables `skill_sources` and `skill_installs` exist | PASS | `the_registry_gets_electrons_skill_tables`; commit 7654097 | Was FAIL: RS had neither. Created at registry open with Electron's columns, from markie-agent (no markie-core edit). |

## Section 18: Darkmown `.wd`

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 18.1 | Edit `.wd` source and a compiled preview: Source, Preview or Split | PASS | `darkmown_golden` (29 fixtures × 5 variants, srcdoc byte for byte); commit b31dd35 | Was FAIL: RS switched modes with its own header buttons; Electron uses View > Darkmown Source, Darkmown Preview and Darkmown Source and Preview, and the palette's "View: …" entries. Now those, and the buttons are gone. Split stays the default. |
| 18.2 | The preview runs only after an explicit trust step | PASS | WEB-EXPORT.md: trust pinned to the exact text; sandbox and CSP hashes `pinned_hashes_match_the_scripts` | Drawing is in V1. |
| 18.3 | Reset returns it to authored defaults | PASS | `darkmown_reset` bumps the frame key as Electron's `reset` does | Drawing is in V1. |
| 18.4 | "Make Interactive" turns a `.md` into an unsaved `.wd` | EXCLUDED-NIGHTLY | `makeInteractiveAvailable = documentsEnabled && nightlyFeaturesEnabled()` (page.tsx) | Ported behind the switch (INTEGRATION-SHELL.md). |
| 18.5 | Pictures beside the file, links in the browser | EXCLUDED-NIGHTLY | `document-workspace-host.tsx`: `if (!bridge \|\| !nightlyFeaturesEnabled()) return null` | Ported behind `MARKIE_RS_NIGHTLY=1`. |
| 18.6 | Files: editor, `lib/darkmown`, pinned vendored compiler and runtime, `darkmown-preview.js`, the two policies | PASS | `markie-web/src/darkmown/*`, `island.rs`, `workspace/darkmown.rs` | |
| 18.7 | IPC `darkmown-preview-picture-scope`, `darkmown-preview-open-link` | EXCLUDED-NIGHTLY | only reached through the nightly `liveDocs` bridge | |
| 18.8 | Frame message `markie:preview-theme` | PASS | `island.rs` posts the same message to a running trusted frame | |
| 18.9 | Frame message `markie:wd-link` | EXCLUDED-NIGHTLY | link bridge script only with `links` (nightly) | |
| 18.10 | Pictures on a `markie-asset://<random host>/` URL | EXCLUDED-NIGHTLY | picture scope only with the nightly bridge | |
| 18.11 | Web view isolation: no same-origin, no navigation, no popups | PASS | `island.rs` srcdoc iframe `sandbox="allow-scripts"` or empty, navigation and popups refused; golden CSP | |
| 18.12 | Source limits before compiling | PASS | `past_200000_characters_the_preview_says_so_first`, `darkmown_golden` STOPS cases; commit b31dd35 | Was FAIL: past 200,000 characters Electron says "Darkmown preview is limited to 200,000 characters" before the worker's own limit; RS skipped that check. |
| 18.13 | Preview look: untrusted and trusted, light and dark | PASS | V1; `doc_toolbar::tests::*`; `island::tests::an_island_is_only_moved_when_its_place_changes`; `themes::tests::each_tone_paints_its_own_editor_background` | Was NEEDS-CAPTURE. Shell fixes, 2026-11-22, `Everything.wd`, all four states (`.autoloop/runs/shell-fixes/sbs-wd-{untrusted,trusted}-{dark,light}.png`). Markie RS now has Electron's `TextDocumentEditor` row (`workspace/doc_toolbar.rs`: "Darkmown · Source", Find, encoding, undo, redo, zoom, paragraph style, font, size, bold, italic, bullet list, editing the source as `wrap` and `setSourceStyle` do), the workspace's `docs-status` footer ("Saved", "230 words · DARKMOWN"), the plain 24 px textarea look and the document-mode title bar ("Save file", no Copy all). Trust is the preview's "Trust this document" button in both apps; in the first pass it never changed because Electron spends the first click on an inactive window activating it, and a filtering event tap dropped Markie RS's release (see the capture section). Also fixed: a preview that finished compiling between frames stayed blank, and the source editor stayed black after a live switch to light. Native form controls inside the preview differ (WebKit against Chromium), as the untrusted capture already showed. |

Row 18.12 is a sub-behaviour of 18.1 and 18.2 found while reading `preview.ts`. It is counted on its own because it was a separate fix.

## Section 19: Live Docs

All of section 19 is super-nightly in 0.9.7: `liveDocsAreaAvailable` and `liveDocsPreviewAvailable` need `nightlyFeaturesEnabled()` in page.tsx, and main refuses with `nightlyEnabledInMain()`. Markie RS ports it behind `MARKIE_RS_NIGHTLY=1` (WEB-EXPORT.md, INTEGRATION-SHELL.md item 7).

| # | Bullet | Status | Evidence |
|---|---|---|---|
| 19.1 | Add projects, browse the tree, open tabs, edit and save with revision checks | EXCLUDED-NIGHTLY | `nightlyFeaturesEnabled()`; RS `projects::tests` |
| 19.2 | Run `darkmown dev` and see the live site in a native view | EXCLUDED-NIGHTLY | `nightlyEnabledInMain()` in `live-docs-preview-*`; RS `starts_and_stops_a_dev_server` |
| 19.3 | Files: `live-docs-projects.cjs`, `live-docs-preview.js`, the area and panel | EXCLUDED-NIGHTLY | |
| 19.4 | IPC `live-docs-projects-*`, `live-docs-project-*`, `live-docs-project-changed` | EXCLUDED-NIGHTLY | `enabled: nightlyEnabledInMain` |
| 19.5 | IPC `live-docs-preview-*`, `live-docs-preview-status` | EXCLUDED-NIGHTLY | |
| 19.6 | List in `userData/live-docs-projects.json`; Node through the login shell | EXCLUDED-NIGHTLY | |
| 19.7 | Needs an embedded web view for the dev server | EXCLUDED-NIGHTLY | `island::SitePreview` |

## Section 23: export, print and converted copies

| # | Bullet | Status | Evidence | Notes |
|---|---|---|---|---|
| 23.1 | Export PDF in dark or light; ⇧⌘E is dark | PASS | `line_baselines_match_chromium` (all 5 fixtures, both themes, every line on Electron's page within 2 pt; worst 0.96 pt); `layout_rules_measured_from_chromium`; `.autoloop/runs/native-print/` (`pdf/`, `before/`, `after/`, `measure/summary.txt`, `sbs-*.png`); commit c0f65c8 | Was FAIL: lines drifted up to 23.9 pt on everything.md and 121.9 pt on long.md, where 45 lines fell on another page. The Typst projection now follows Chromium's CSS box model, worked out in Rust: line boxes from CoreText ascent and descent with the leading split around them, margins collapsed through parents, borders and padding taking space, table half-borders, sub and sup shifts, kbd at full size, orphans and widows of 2 with Chromium's three-line exception, a breaking code block slicing its padding, greedy line breaks with no hanging punctuation, and TeX's subscript drop under big operators as KaTeX uses. Max offset after: 0.96 pt (everything), 0.78 pt (long, 11 pages, same breaks), 0.62 to 0.77 pt (prices, prices-edge, plain). Earlier fixes kept: palette entries, disc, quote inset. Math glyphs and the video player chrome still draw differently; positions match. |
| 23.2 | Print (⌘P) | PASS | `key_tests::cmd_p_prints`; same PDF as 23.1 on the macOS print sheet | The sheet is in V5. It prints 23.1's PDF, so it now has Electron's line positions and page breaks. |
| 23.3 | Standalone HTML with local images inlined | FAIL | `code_colours_match_highlight_js` (13 code blocks, 11 languages, every character's stylesheet colour equal to highlight.js's); `render_golden`; `assets::tests`; `.autoloop/runs/native-print/html/` (both apps' pages and full-page captures); commit 9048776 | Code now passes: token classes follow highlight.js's grammar per language, and the code page captures are the same height with only anti-aliasing pixels apart. Display math was left-aligned because the page lacked KaTeX's wrapper rules; it is now centred with KaTeX's line height. Open, math only: markie-math's SVG glyphs draw visibly lighter than KaTeX's font glyphs, and a display formula with a big operator is about 3 CSS px taller (the integral's subscript sits a little lower). Self-contained SVG math needs no 240 KB font stylesheet; Kirby may count that as an improvement and close the row. |
| 23.4 | Converted copy as DOCX, RTF, ODT, TXT or MD | PASS | `convert_golden` `bytes_match_electron` (5 fixtures, byte for byte) | |
| 23.5 | In RTF and ODT, tables become tab-separated rows | PASS | `convert_golden` (everything and prices fixtures hold tables) | |
| 23.6 | Word documents get their own PDF and print path | PASS | `office_pdf::tests`; commit b984e09 | Was FAIL: RS offered Export PDF… for every Word, RTF and ODT file, never asked about review comments, suggested "<name>.pdf" and said nothing on success. Now only for a document `canPrintDocx` accepts, with Electron's comment question, "document.pdf", and its notices ("Exported PDF to … The Word file was not changed.", "Sent the supported document view to the printer."). The 26 TypeScript print cases are not ported one by one (WEB-EXPORT.md item 5). |
| 23.7 | Files: `export-pdf.js`, `export-document.js`, `inline-images.js`, `local-assets.js`, `use-export.ts`, `export-formats.ts`, `markdown-html.ts`, `pdf-styles.ts`, the rehype plugins, `print.css`, `docx-print.ts` | PASS | `markie-export/src/*`, `workspace/export.rs` | |
| 23.8 | IPC `export-pdf`, `export-html`, `export-document` | PASS | `workspace/export.rs`: same save names, extension fixing, busy guard and wording | `one_export_at_a_time`. |
| 23.9 | Menu events `menu-export-pdf`, `menu-print` | PASS | `main.rs` File > Print… and Export > PDF (Dark)…, PDF (Light)…, HTML… | |
| 23.10 | Sanitize schema shared with `server/src/render.ts` | PASS | `markie-export/src/sanitize.rs`; `render_golden` | |
| 23.11 | PDF and print through a hidden web view or native layout; HTML is string generation | PASS | Typst for PDF, strings for HTML | The choice itself, kept native (no web views). Typst is driven with Chromium's box model (23.1); the one open difference is 23.3's math. |

## Fixes made

| Commit | Rows | What |
|---|---|---|
| 7654097 | 16.1, 16.2, 16.3, 16.7 | Skills view rows and panel as Electron's, front-matter port, skill tables, two goldens |
| 4bcd416 | 15.1, 15.15 | Agents dialog and Remote agents panel as Electron's; token client wording |
| 4bcd416 | 15.12, 15.13 | Sync consent sheet with the checkbox; public-link wording; Cloud home refusal |
| 4bcd416 | 15.20 | Unknown-method text as JavaScript's `String()` |
| b31dd35 | 18.1, 18.12 | Darkmown view commands in View menu and palette; the 200,000-character check |
| b984e09 | 23.1, 23.6 | Export commands in the palette; the Word PDF and print path |
| 3bf9747 | 23.1 | PDF disc, sub/sup, heading half-leading, box spacing, quote inset |
| c0f65c8 | 23.1, 23.2 | PDF laid out with Chromium's CSS box model; Chromium baseline goldens and test |
| 9048776 | 23.3 | Code coloured as highlight.js does in 11 languages; display math centred with KaTeX's wrapper rules |

Shared files touched, each minimally:

- `markie-app/src/workspace.rs`: the skill tables at registry open, one call to update Skills on rescan, three Darkmown action handlers.
- `markie-app/src/main.rs`: three View menu items.
- `markie-app/src/actions.rs`: three actions.
- `markie-app/src/workspace/palette.rs`: export, export-as and Darkmown entries.
- `markie-app/src/workspace/chrome.rs`: the document Export PDF… entry gated on `canPrintDocx`.
- `markie-app/Cargo.toml`: AppKit features for NSAlert and `block2`.
- `markie-export/src/pdf.rs`: five Typst layout rules (the web-export owner's file).

## FAIL rows left

- **23.3 HTML export math.** Code passes. Math is markie-math SVG: positions and centring match Electron, but the glyphs draw lighter than KaTeX's font glyphs and a display formula with a big operator is about 3 CSS px taller. Closing it natively would mean matching KaTeX's glyph rendering; Kirby may instead accept self-contained SVG math as an improvement.

## NEEDS-CAPTURE steps

Screen locked. When unlocked, launch both apps per SCREEN.md, with `env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME=<scratch>`, a scratch data folder and `--user-data-dir=<scratch>` for Electron. Resize each to 1280×820 with `act.sh <pid> resize 1280 820`. Capture light and dark with `capture.sh`, and compare with `side-by-side.py`.

- **V1 (18.13).** Open `rust/crates/markie-web/tests/fixtures/Everything.wd` in both. Capture Split untrusted, then click Trust this document and capture trusted, then Reset state.
- **V2 (15.1, 15.15).** Open the Agents dialog in both. Capture it, then Remote agents… signed out.
- **V3 (15.12).** In RS with a scratch sign-in, run `markie_cloud_sync` through the bootstrap on a scratch file and capture the sheet. Compare with Electron's sheet from `dialog.showMessageBox`.
- **V4 (16.1).** Copy the skills golden tree into the scratch HOME. Open Skills in RS and capture. Do not open Electron's Skills view: it reads the index, which SCREEN.md rule 7 forbids opening in a scratch Electron.
- **V5 (23.2).** ⌘P on `everything.md` in RS and capture the print sheet.

## Tests run

- `cargo test --workspace` from `rust/` after the last fix: 977 passed, 0 failed, 2 ignored (the opt-in Keychain test and one other opt-in test), 65 suites.
- New tests:
  - markie-agent: `matches_electrons_parse_frontmatter`, `rows_match_electrons_skills_view`, `the_registry_gets_electrons_skill_tables`, `unknown_methods_print_as_javascript_string_does`, `refusals_say_what_agent_tokens_ts_says`.
  - markie-web: `past_200000_characters_the_preview_says_so_first`.
  - markie-export: `layout_rules_measured_from_chromium`.
  - markie-app: `home_paths_compact_as_path_display_does`, `export_commands_follow_electrons_list`.
- MCP comparison: `mcp-diff.mjs`, Electron's server against the RS bootstrap on one scratch HOME, 23 of 23 identical.
- Goldens rerun from the reference source: export and Darkmown unchanged.
- PDFs: 8 fixture PDFs per app, page counts equal, pixel measurements in `.autoloop/runs/audit-agents-web/pdf/`.
- Follow-up (`t3/markie-rs-native-print`): `cargo test --workspace` 1,080 passed, 0 failed, 5 ignored. New tests: markie-export `line_baselines_match_chromium`, `word_pagination_matches_electron`, `code_colours_match_highlight_js`; `layout_rules_measured_from_chromium` rewritten for the box model.
- Shell fixes (`t3/markie-rs-shell-fixes`): `cargo test --workspace` 1,090 passed, 0 failed, 5 ignored, 68 suites. New tests: markie-app `doc_toolbar::tests::*` (word count, save status, `wrap`, `setSourceStyle`), `watchdog::tests::*`, `themes::tests::each_tone_paints_its_own_editor_background`; markie-web `island::tests::an_island_is_only_moved_when_its_place_changes`.

## Capture pass, 2026-11-22

Electron 0.9.7 against this branch at 1280x820, evidence in `.autoloop/runs/capture-pass/`.

- V1 (18.13): see the row. Untrusted preview matches; trusted not reached; the Darkmown toolbar and status bar are missing in Markie RS. Closed by the shell fixes below.
- V2 (15.1, 15.15): the Agents dialog matches in wording, order, widths and the tool list (`sbs-agents-dark.png`, `crop-agents-*.png`). One difference was fixed in `agents.rs`: section labels now use `.markie-overlay-section` (10 px spaced caps, muted). The fix was not recaptured, and Remote agents signed out was not reached. Recaptured in the shell fixes below.
- V3 (15.12): see the pass 2 section below.
- V4 (16.1): see the pass 2 section below.
- V5 (23.2): ⌘P on `everything.md` opens the native print sheet with a three page preview (`rs-print-sheet.png`).

The score is unchanged: V2 to V5 sit on PASS rows, and 18.13 stays NEEDS-CAPTURE.

## Capture pass 2, 2026-11-22

Branch `t3/markie-rs-capture-pass-2`, evidence in `.autoloop/runs/capture-pass-2/`.

- V3 (15.12): both apps signed in to a local server (see AUDIT-CLOUD.md's pass 2 section), and the repo's `mcp/agent-client.mjs` sent `cloud_sync` for a scratch file through each app's own bridge. Both raise the same native sheet: "An agent wants to put "agent-note.md" in Markie Cloud", the path, "It stays private: only you can open it until you share it.", the "Always allow agents to put files in Markie Cloud" checkbox, Don't Allow and Put in Cloud (`sbs-v3-sheet-light.png`). Don't Allow returned `The user declined to put this file in Markie Cloud.` from both (`v3-e.json`, `v3-rs.json` in the scratch logs).
- V4 (16.1): why pass 1 saw "No agent files found": the scratch tree sat under `/tmp/`, and Electron's cache filter (`skills.rs` `CACHE`, from skills-view.tsx) skips any path containing `/tmp/`, as it should. That is not a Markie RS bug. Two real bugs were found on the way and fixed: the palette's "Skills & agent files…" never built the panel, so it stayed on "Looking for agent files…" (`palette.rs`); and in a scratch run the panel matched tool roots against `$HOME` while the device index walks the scratch data folder, so the two never met (`workspace.rs` `device_scan_options`, `skills.rs`, test `a_scratch_index_and_its_tool_roots_share_one_home`). With the tree in a scratch folder outside `/tmp` the panel lists it by tool (`rs-skills-fixed-dark.png`). Electron's Skills view was not opened, per SCREEN.md rule 7; its grouping is pinned by `rows_match_electrons_skills_view`.

The score is unchanged: V3 and V4 sit on PASS rows.

## Shell fixes, 2026-11-22

Branch `t3/markie-rs-shell-fixes`, Electron 0.9.7 against the release bundle at 1280x820, evidence in `.autoloop/runs/shell-fixes/` (see its README).

- The reported hang was not one. The main thread sat idle in its event loop in every sample. An AppKit event monitor (`MARKIE_RS_DEBUG_INPUT=1`) showed that synthetic presses reached the app as a mouse-down with the mouse-up missing or seconds late. Electron lost releases the same way. The cause is Codex Computer Use's filtering session event taps (`event-taps.txt`). SCREEN.md now says how to check for them and to drive presses with `act.sh press`. `MARKIE_RS_WATCHDOG=1` (on in debug builds) logs any real main-thread block over 2 s with its stack. Capture pass 2's freeze after Share, Sync and share was retried on the merged branch, signed in to a scratch server: sign-in, Sync and share, typing in the share field, a held press and Escape all responded, the watchdog logged no stall, and the same tap was present (`share-path/` in the evidence).
- V1 (18.13): PASS, see the row. All four states captured, toolbar, footer and title bar matched.
- V2 (15.1, 15.15): recaptured dark, top, scrolled and Remote agents signed out (`sbs-agents-dark.png`, `sbs-agents-dark-scrolled.png`, `sbs-remote-dark.png`). Fixed to match Electron: the panel is centred with 20 px padding that scrolls with the title, on `.markie-overlay-panel` colours, border and shadow; Electron's block margins; `CLAUDE.md`, `AGENTS.md`, `~/.claude/skills` and `~/.codex` in monospace; 18 px tool rows; a compact accent Remote agents… button and small accent Copy buttons. Left as is: GPUI has no backdrop blur, the checkbox is GPUI Kit's, and Remote agents replaces the dialog's content instead of stacking a second panel over it.

Score: 52 of 53 PASS. 18.13 moves to PASS. With V2 recaptured here, V3 and V4 checked in pass 2 and V5 in pass 1, no visual check is outstanding.

