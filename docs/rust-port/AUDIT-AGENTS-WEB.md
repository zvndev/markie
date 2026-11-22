# Audit: agents, skills, Darkmown, Live Docs and export

Date: 2026-11-22. Branch `t3/markie-rs-agents-web-parity`, from `rust/markie-rs` at 3b6f6c0.
Reference: Electron Markie 0.9.7 (`/Applications/Markie.app`) and its source at ae62cfa.
Sections: PARITY.md 15, 16, 18, 19 and 23.

## Score

Parity score: **50 / 53 = 94.3%**. That is PASS over all 67 rows less the 14 excluded ones (13 nightly, 1 Windows). No row needed plain EXCLUDED: nothing in these sections is the updater, the terminal, the Recovered list, sign-in moving, file-type claims or the private-release gate.

| Status | Rows |
|---|---|
| PASS | 50 |
| FAIL | 2 |
| NEEDS-CAPTURE | 1 (and 4 visual checks on PASS rows, V2 to V5) |
| EXCLUDED | 0 |
| EXCLUDED-NIGHTLY | 13 |
| EXCLUDED-PLATFORM | 1 |
| All rows | 67 |

The screen was locked for the whole run (`IOConsoleLocked = Yes`), so no window could be captured or driven. Visual rows are NEEDS-CAPTURE with steps at the end. Exported PDFs need no window, so they were compared page by page and measured (row 23.1).

## How rows were checked

- **MCP against both apps' code.** `.autoloop/runs/audit-agents-web/scripts/mcp-diff.mjs` starts Electron's `mcp/markie-mcp.mjs` and Markie RS's bootstrap `markie-rs-mcp.mjs` on the same scratch HOME, sends identical JSON-RPC, and compares every reply and every file written. 23 of 23 steps were identical: initialize, tools/list, resources, the guide, ping, an unknown method, find, search, read, write, the Markdown aliases, home-folder refusals, list_skills, check_md and check_wd on good and broken sources.
- **Bridge with the real Node client.** `markie-agent` `tests/bridge.rs` runs the repo's own `mcp/agent-client.mjs` and `mcp/lib.mjs` against a scratch Markie RS socket: discovery, modes, every method, bad token, bad JSON, unknown method, oversized and fragmented frames.
- **Goldens from Electron's own code.** Each golden script imports Electron's TypeScript or main-process module and writes what it returns. The Rust test compares against those bytes.
  - Export: `markie-export/scripts/goldens.mjs`. It was rerun today against the reference: no golden changed.
  - Darkmown preview: `markie-web/scripts/goldens.mjs`. Rerun today: no change.
  - New: `markie-agent/scripts/frontmatter-goldens.mjs` (38 SKILL.md front-matter cases through `electron/skill-frontmatter.js`).
  - New: `markie-agent/scripts/skills-goldens.mjs` (a 29-file agent tree through `mdindex.js` `skillToolFor` and the Skills view's own grouping code).
- **PDFs.** Electron's exact PDF HTML (`markie-export/scripts/electron-pdf-html.mjs`) printed by headless Chrome with a scratch profile, against Markie RS's Typst PDF of the same fixture.

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
| 15.12 | Cloud sync, with consent | PASS | `sync_keeps_attribution_on_creation_only_and_reports_private_link`; `permissions` test; commit 4bcd416 | Was FAIL: RS asked with a third "Always Allow" button and a warning sheet. Now an informational NSAlert sheet with Put in Cloud, Don't Allow and the "Always allow agents to put files in Markie Cloud" checkbox, which counts only with Put in Cloud, as Electron's `checkboxChecked`. The home refusal now says "can go to Markie Cloud" as `agent-cloud.js` does. The sheet itself is in NEEDS-CAPTURE V3. |
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
| 16.1 | SKILL.md and agent instruction files grouped by Claude, Codex, Cursor, Gemini, Universal | PASS | `tests/skills_golden.rs` `rows_match_electrons_skills_view` (24 rows, Electron's own grouping code); commit 7654097 | Was FAIL. RS used the skills folders, not the tool roots, to name a skill's tool; preferred README.md as a folder's entry; labelled a non-skill SKILL.md without its folder; dropped non-Markdown agent files; used home-relative paths for the cache and kind rules. The panel had no star, no Show in Finder, a dialog instead of the inline "Move … to the Trash?", "Full paths" instead of `~/`, absolute paths, a Rescan button, other empty and loading text, and no update when the index changed. All now as `skills-view.tsx`. Look in NEEDS-CAPTURE V4. |
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
| 18.13 | Preview look: untrusted and trusted, light and dark | NEEDS-CAPTURE | V1 | |

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
| 23.1 | Export PDF in dark or light; ⇧⌘E is dark | FAIL | `pdf.rs` tests incl. `layout_rules_measured_from_chromium`; `.autoloop/runs/audit-agents-web/pdf/` (both apps' PDFs, `sbs-*.png`, `lines.py`); commits b984e09, 3bf9747 | Fixed here: the palette lacked "Export PDF (Dark)" ⇧⌘E, "Export PDF (Light)", "Export HTML" and "Export as …". ⇧⌘E is only a label in Electron too, with no key bound; in a rich pane it centres text. Also fixed, each measured at 600 dpi against Electron's PDF: the list disc (was a 2 pt glyph, now Chromium's 3.72 pt disc in the same place to the pixel); sub and super offsets (H₂O's 2 sat on the baseline); a heading's own half-leading (rules sat 4 pt too close to h1 and h2 text); rules, quotes, code, tables and pictures taking a second half-leading; the quote bar and text 1 to 2 pt left. Page counts match on all 8 fixture PDFs. Left: per-line drift of up to 10.5 pt on page 2 and 24 pt on page 3 of `everything.md`. Code lines run 0.75 pt tighter each. Chromium grows a line with inline code by 1.8 pt. Math uses markie-math glyphs, not KaTeX's. Video and audio are plain boxes, not player chrome. Blocker: Typst has no CSS line-box model. Matching every line means printing Electron's HTML through a hidden WKWebView (`createPDF`), a new export path for the web-export owner. |
| 23.2 | Print (⌘P) | PASS | `key_tests::cmd_p_prints`; same PDF as 23.1 on the macOS print sheet | The sheet is in V5. It carries 23.1's PDF differences. |
| 23.3 | Standalone HTML with local images inlined | FAIL | `render_golden` (equal only after normalising math and code-token spans); `assets::tests` | The page, CSS, fit script and picture inlining match. Math is markie-math SVG, not KaTeX HTML with its 240 KB font CSS, and syntect splits code into tokens a little differently from highlight.js. Blocker: running KaTeX and highlight.js on export, through the wry web view RS already ships, would close it. That is a renderer change for the web-export owner, too large for this audit. |
| 23.4 | Converted copy as DOCX, RTF, ODT, TXT or MD | PASS | `convert_golden` `bytes_match_electron` (5 fixtures, byte for byte) | |
| 23.5 | In RTF and ODT, tables become tab-separated rows | PASS | `convert_golden` (everything and prices fixtures hold tables) | |
| 23.6 | Word documents get their own PDF and print path | PASS | `office_pdf::tests`; commit b984e09 | Was FAIL: RS offered Export PDF… for every Word, RTF and ODT file, never asked about review comments, suggested "<name>.pdf" and said nothing on success. Now only for a document `canPrintDocx` accepts, with Electron's comment question, "document.pdf", and its notices ("Exported PDF to … The Word file was not changed.", "Sent the supported document view to the printer."). The 26 TypeScript print cases are not ported one by one (WEB-EXPORT.md item 5). |
| 23.7 | Files: `export-pdf.js`, `export-document.js`, `inline-images.js`, `local-assets.js`, `use-export.ts`, `export-formats.ts`, `markdown-html.ts`, `pdf-styles.ts`, the rehype plugins, `print.css`, `docx-print.ts` | PASS | `markie-export/src/*`, `workspace/export.rs` | |
| 23.8 | IPC `export-pdf`, `export-html`, `export-document` | PASS | `workspace/export.rs`: same save names, extension fixing, busy guard and wording | `one_export_at_a_time`. |
| 23.9 | Menu events `menu-export-pdf`, `menu-print` | PASS | `main.rs` File > Print… and Export > PDF (Dark)…, PDF (Light)…, HTML… | |
| 23.10 | Sanitize schema shared with `server/src/render.ts` | PASS | `markie-export/src/sanitize.rs`; `render_golden` | |
| 23.11 | PDF and print through a hidden web view or native layout; HTML is string generation | PASS | Typst for PDF, strings for HTML | The choice itself; its differences are in 23.1 and 23.3. |

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

Shared files touched, each minimally:

- `markie-app/src/workspace.rs`: the skill tables at registry open, one call to update Skills on rescan, three Darkmown action handlers.
- `markie-app/src/main.rs`: three View menu items.
- `markie-app/src/actions.rs`: three actions.
- `markie-app/src/workspace/palette.rs`: export, export-as and Darkmown entries.
- `markie-app/src/workspace/chrome.rs`: the document Export PDF… entry gated on `canPrintDocx`.
- `markie-app/Cargo.toml`: AppKit features for NSAlert and `block2`.
- `markie-export/src/pdf.rs`: five Typst layout rules (the web-export owner's file).

## FAIL rows left

- **23.1 PDF layout.** After five measured fixes, lines still drift up to 10.5 pt on page 2 and 24 pt on page 3. Typst cannot model CSS line boxes (inline-code growth, code line pitch), KaTeX glyphs or media chrome. Blocker: needs a WKWebView `createPDF` export path over Electron's HTML.
- **23.3 HTML export math and code tokens.** Blocker: needs KaTeX and highlight.js run on export through the web view. That belongs to the web-export owner's renderer.

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
