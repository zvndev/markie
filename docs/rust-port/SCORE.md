# Markie RS parity score

The overall score across the five audits, and the rules behind it. Updated 2026-11-23 at `rust/markie-rs` 91a29ca plus the rescore commit, then branch `t3/markie-rs-share-dialog` (30.1, 14.1.1, 14.1 and 21.1.4 closed by the background comparison), then branch `t3/markie-rs-katex-look` (23.3 closed: Export HTML math drawn as Electron's KaTeX), then branch `t3/markie-rs-browse-ux` (library 3.1 is now an IMPROVEMENT; the totals do not move), then branch `t3/markie-rs-home-pages` (library 1.2 and cloud 14.1.2, 14.1.3 and 30.1 are now IMPROVEMENT; the totals do not move), then branch `t3/markie-rs-csv-table` (editors 7.10 to 7.18 added for the CSV table of Electron PR #149: eight PASS, one NEEDS-CAPTURE), then on 2026-11-24 branch `t3/markie-rs-styles-fonts` (Electron's Markdown styles and font library, PRs #150 and #151: 16 new rows across four audits), then branch `t3/markie-rs-live-notice` (cloud 11.2 is now an IMPROVEMENT; the totals do not move), then branch `t3/markie-rs-skills-rows` (agents 16.1 is now IMPROVEMENT; the totals do not move), then on 2026-11-25 branch `t3/markie-rs-nav-history` (Back and Forward, library 29.12, IMPROVEMENT; the full-page History, editors 13.2, 13.8 and 13.9, IMPROVEMENT; Source's CodeMirror keys, editors 7.19 to 7.27, nine PASS: 12 new rows, all met), then branch `t3/markie-rs-source-markdown-keys` (Source's Markdown keys from `@codemirror/lang-markdown`, editors 7.28 to 7.30: three new PASS rows), then branch `t3/markie-rs-private-files` (Make Private, office 22.P1 to 22.P5: five new IMPROVEMENT rows), then branch `t3/markie-rs-projects-folders` (Markie's own folders in Projects and bulk selection on Recent and Cloud, library 4.P1 to 4.P5: five new IMPROVEMENT rows). Then branch `t3/markie-rs-google-import` (Google Docs import, library 28.G1 to 28.G6: six new IMPROVEMENT rows). Then branch `t3/markie-rs-agents-setting-polish` (Settings › Agents and the page polish, library 28.A1, 28.A2, 1.P1, 1.P2 and 29.P1: five new IMPROVEMENT rows). Then branch `t3/markie-rs-first-run-import` ("Bring your documents", library 28.B1 to 28.B6: six new IMPROVEMENT rows). Then branch `t3/markie-rs-vault-backup-private` (backups carry private files, office 22.P6: one new IMPROVEMENT row).

## Overall

| Audit | Counted | Meets parity | Score |
|---|---|---|---|
| [Agents, Darkmown, Live Docs, export](AUDIT-AGENTS-WEB.md) | 55 | 55 | 100% |
| [Cloud, collaboration, sharing, sign-in](AUDIT-CLOUD.md) | 83 | 79 | 95.2% |
| [Editors, autosave, history](AUDIT-EDITORS.md) | 84 | 78 | 92.9% |
| [Library, search, settings, menus](AUDIT-LIBRARY-SETTINGS.md) | 123 | 120 | 97.6% |
| [Office, platform, vault (macOS)](AUDIT-OFFICE-PLATFORM.md) | 67 | 64 | 95.5% |
| **Total** | **412** | **396** | **96.1%** |

The total was 332 of 345 (96.2%) before the Markdown style and font rows. Those added 16 rows, of which 13 are met. The eight CSV sheet rows (editors 7b, Electron PR #154) then made it 353 of 369; all eight are met. Back and Forward, the History page and Source's keys (2026-11-25) added 12 rows, all met: 365 of 381. Source's Markdown keys (list continuation, markup deletion, paste as link) added three, all met: 368 of 384. Private files (Make Private, Make Not Private, the passphrase-only key) added five IMPROVEMENT rows: 373 of 389. Markie's own folders and bulk selection added five IMPROVEMENT rows: 378 of 394. Google Docs import (2026-11-25) added six IMPROVEMENT rows: 384 of 400. Settings › Agents and the page polish (2026-11-25) added five IMPROVEMENT rows: 389 of 405. "Bring your documents" (2026-11-25) added six IMPROVEMENT rows: 395 of 411. Private files in vault backups added one IMPROVEMENT row: 396 of 412.

Target set by Kirby on 2026-11-22: 98.5% or better.

## Rules (Kirby, 2026-11-22)

- **Parity means features and visuals:** what a user sees and can do. Internal formats and plumbing are not scored.
- **IMPROVEMENT counts as meeting parity.** It marks a row where Markie RS deliberately differs to fix a flaw in Electron. Kept improvements:
  - no TipTap rewrites of text the user did not touch on save (editors 8.13);
  - dark text on highlights in dark mode;
  - a code block's language label while the cursor is in it;
  - the title-bar palette button opens a template menu, where Electron opens Settings;
  - Browse as a page: "Documents on this Mac" with a folder tree, the chosen folder's contents, a breadcrumb, counts, the last check, and matches shown with their folder (library 3.1). Numbers are unchanged: the row was PASS;
  - Recent as a page: recent documents as cards that show the start of each one, grouped by day, with Starred, grid or list and "Missing on disk"; a launch with no file opens on it (library 1.2). Numbers are unchanged: the row was PASS;
  - the Cloud page's layout: one header, one toolbar row, share requests as a one-line strip that opens, and documents and snapshots as cards (cloud 14.1.2, 14.1.3, 30.1). Numbers are unchanged: these rows were PASS;
  - a style's picture placement and captions drawn in View, where Electron's editing view ignores them (library 28.S3);
  - the live note names this file's reason by line ("Line 40 has a footnote, which live editing can't keep.") in one line with Save a copy, where Electron lists every possible cause whether the file has it or not (cloud 11.2). Numbers are unchanged: the row was PASS;
  - the Skills panel rows: a name and a description each wrap to two lines before an ellipsis, and Show in Finder, the star and Remove live in a toolbar shown on hover and on the keyboard cursor and in the row menu (right-click, ⋯, Shift-F10), instead of a line of links under every row (agents 16.1). Numbers are unchanged: the row was PASS;
  - the vault's calmer layout, Touch ID first unlock, icon row actions and copy countdown (office 22.374, 22.375, 22.376, 22.378). Numbers are unchanged: these rows were PASS;
  - Back and Forward between documents and pages: title-bar arrows, ⌘[ ⌘], a Go menu, the mouse's side buttons (library 29.12). Electron has none;
  - private files: Make Private moves any local file into the vault, encrypted, and removes the original and Markie's own copies; private files open only in the vault and need the passphrase even after a Touch ID unlock (office 22.P1 to 22.P5, [PRIVATE-FILES.md](PRIVATE-FILES.md)), and vault backups that carry them, encrypted, and merge them back on restore (office 22.P6). Electron has none;
  - Projects as Markie's own folders: nested folders a person makes, fills and orders by hand, by drag and drop, the keyboard and a right-click menu, with ⌘Z on every action and nothing moved on disk; automatic grouping off unless Settings turns it on; and several documents selected at once on the Recent and Cloud pages to move into a folder (library 4.P1 to 4.P5). Electron's tab could only be changed by editing `Projects.md`;
  - Google Docs import: connect with the Picker (`drive.file` only), one-way import to Markdown, Refresh with conflict copies, Save as Word, a Settings row, a menu and palette command, and a mark in Recents (library 28.G1 to 28.G6). Electron has none. Hidden until a build carries the Google client;
  - agent features in Settings › Agents, the Skills button off the rail until turned on there (library 28.A1, 28.A2); document pages in a centred column with a created date and a "Date created" sort (1.P1, 1.P2); a title bar that keeps Share on a narrow window (29.P1). Electron has none;
  - "Bring your documents" at first run: the folders a person already keeps documents in, counted live, brought in as Library roots and Projects folders with one ⌘Z, and Google Docs imports placed in one "Google Docs" folder (library 28.B1 to 28.B6). Electron has none;
  - History as Electron's super-nightly full page, in place of the stable popup whose click toggled a diff under the pointer (editors 13.2), with rows that select on the press (13.8) and Older and Newer arrows (13.9). Word, RTF and ODT keep the recovery dialog.
- **Excluded:** the database layout (library 2.2, 2.3, 2.8) and the crash report file format (office 27.427, 27.431).
- **Nightly-only features are out of the stable score** (EXCLUDED-NIGHTLY), as each audit already applied. Local comments (cloud 12.2, 12.2.1) were rescored on that rule.
- **No web views** in Markie RS: printing and export stay on the native engine.
- **Code highlighting stays at the 36 tree-sitter languages.** A syntect fallback was not simple or free (editors 7.4).

Score = (PASS + IMPROVEMENT) ÷ (all rows − every EXCLUDED class).

## What is still open (16 rows)

| Rows | What closes them |
|---|---|
| Office 22.377, 22.386a, 22.387a | Kirby checks Touch ID in person |
| Cloud 21.1.1, 21.3.1 and labels 21.1, 21.3 | One real Google or Apple sign-in into Markie RS. The server side is deployed: `markie-api` since 8ed421211f04, and at f6bba2b7d689 on 2026-11-24. |
| Editors 8.6 and group 8.0 | One real trackpad pinch by Kirby |
| Editors 7.9 | The 50 MB timing, run with the speed comparison on a quiet Mac |
| Editors 7.18 | A scheduled screen session of about 15 minutes: the CSV table with a real pointer, keyboard and clipboard, and one frame beside Electron's |
| Library 28.S4, 28.S5, 28.F2 | A scheduled screen session of about 15 minutes: the Markdown style section, the style editor and the font menus with a real pointer, beside Electron's. The checks are written in each audit row |
| Editors 7.4 and group 7.0 | Stay open: Kirby kept 36 languages |

If every row above closes except the last two, the score is 410 of 412, which is 99.5%.
