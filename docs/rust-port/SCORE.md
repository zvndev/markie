# Markie RS parity score

The overall score across the five audits, and the rules behind it. Updated 2026-11-23 at `rust/markie-rs` 91a29ca plus the rescore commit, then branch `t3/markie-rs-share-dialog` (30.1, 14.1.1, 14.1 and 21.1.4 closed by the background comparison), then branch `t3/markie-rs-katex-look` (23.3 closed: Export HTML math drawn as Electron's KaTeX), then branch `t3/markie-rs-browse-ux` (library 3.1 is now an IMPROVEMENT; the totals do not move), then branch `t3/markie-rs-home-pages` (library 1.2 and cloud 14.1.2, 14.1.3 and 30.1 are now IMPROVEMENT; the totals do not move), then branch `t3/markie-rs-csv-table` (editors 7.10 to 7.18 added for the CSV table of Electron PR #149: eight PASS, one NEEDS-CAPTURE), then on 2026-11-24 branch `t3/markie-rs-styles-fonts` (Electron's Markdown styles and font library, PRs #150 and #151: 16 new rows across four audits).

## Overall

| Audit | Counted | Meets parity | Score |
|---|---|---|---|
| [Agents, Darkmown, Live Docs, export](AUDIT-AGENTS-WEB.md) | 55 | 55 | 100% |
| [Cloud, collaboration, sharing, sign-in](AUDIT-CLOUD.md) | 83 | 79 | 95.2% |
| [Editors, autosave, history](AUDIT-EDITORS.md) | 62 | 56 | 90.3% |
| [Library, search, settings, menus](AUDIT-LIBRARY-SETTINGS.md) | 100 | 97 | 97.0% |
| [Office, platform, vault (macOS)](AUDIT-OFFICE-PLATFORM.md) | 61 | 58 | 95.1% |
| **Total** | **361** | **345** | **95.6%** |

The total was 332 of 345 (96.2%) before the Markdown style and font rows. Those added 16 rows, of which 13 are met.

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
  - the vault's calmer layout, Touch ID first unlock, icon row actions and copy countdown (office 22.374, 22.375, 22.376, 22.378). Numbers are unchanged: these rows were PASS.
- **Excluded:** the database layout (library 2.2, 2.3, 2.8) and the crash report file format (office 27.427, 27.431).
- **Nightly-only features are out of the stable score** (EXCLUDED-NIGHTLY), as each audit already applied. Local comments (cloud 12.2, 12.2.1) were rescored on that rule.
- **No web views** in Markie RS: printing and export stay on the native engine.
- **Code highlighting stays at the 36 tree-sitter languages.** A syntect fallback was not simple or free (editors 7.4).

Score = (PASS + IMPROVEMENT) ÷ (all rows − every EXCLUDED class).

## What is still open (16 rows)

| Rows | What closes them |
|---|---|
| Office 22.377, 22.386a, 22.387a | Kirby checks Touch ID in person |
| Cloud 21.1.1, 21.3.1 and labels 21.1, 21.3 | One real Google or Apple sign-in into Markie RS. Server `markie-api` 8ed421211f04 is deployed. |
| Editors 8.6 and group 8.0 | One real trackpad pinch by Kirby |
| Editors 7.9 | The 50 MB timing, run with the speed comparison on a quiet Mac |
| Editors 7.18 | A scheduled screen session of about 15 minutes: the CSV table with a real pointer, keyboard and clipboard, and one frame beside Electron's |
| Library 28.S4, 28.S5, 28.F2 | A scheduled screen session of about 15 minutes: the Markdown style section, the style editor and the font menus with a real pointer, beside Electron's. The checks are written in each audit row |
| Editors 7.4 and group 7.0 | Stay open: Kirby kept 36 languages |

If every row above closes except the last two, the score is 359 of 361, which is 99.4%.
