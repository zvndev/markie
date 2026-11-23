# Markie RS parity score

The overall score across the five audits, and the rules behind it. Updated 2026-11-23 at `rust/markie-rs` 91a29ca plus the rescore commit, then branch `t3/markie-rs-share-dialog` (30.1, 14.1.1, 14.1 and 21.1.4 closed by the background comparison), then branch `t3/markie-rs-katex-look` (23.3 closed: Export HTML math drawn as Electron's KaTeX).

## Overall

| Audit | Counted | Meets parity | Score |
|---|---|---|---|
| [Agents, Darkmown, Live Docs, export](AUDIT-AGENTS-WEB.md) | 53 | 53 | 100% |
| [Cloud, collaboration, sharing, sign-in](AUDIT-CLOUD.md) | 80 | 76 | 95.0% |
| [Editors, autosave, history](AUDIT-EDITORS.md) | 53 | 48 | 90.6% |
| [Library, search, settings, menus](AUDIT-LIBRARY-SETTINGS.md) | 91 | 91 | 100% |
| [Office, platform, vault (macOS)](AUDIT-OFFICE-PLATFORM.md) | 59 | 56 | 94.9% |
| **Total** | **336** | **324** | **96.4%** |

Target set by Kirby on 2026-11-22: 98.5% or better.

## Rules (Kirby, 2026-11-22)

- **Parity means features and visuals:** what a user sees and can do. Internal formats and plumbing are not scored.
- **IMPROVEMENT counts as meeting parity.** It marks a row where Markie RS deliberately differs to fix a flaw in Electron. Kept improvements:
  - no TipTap rewrites of text the user did not touch on save (editors 8.13);
  - dark text on highlights in dark mode;
  - a code block's language label while the cursor is in it;
  - the title-bar palette button opens a template menu, where Electron opens Settings;
  - the vault's calmer layout, Touch ID first unlock, icon row actions and copy countdown (office 22.374, 22.375, 22.376, 22.378). Numbers are unchanged: these rows were PASS.
- **Excluded:** the database layout (library 2.2, 2.3, 2.8) and the crash report file format (office 27.427, 27.431).
- **Nightly-only features are out of the stable score** (EXCLUDED-NIGHTLY), as each audit already applied. Local comments (cloud 12.2, 12.2.1) were rescored on that rule.
- **No web views** in Markie RS: printing and export stay on the native engine.
- **Code highlighting stays at the 36 tree-sitter languages.** A syntect fallback was not simple or free (editors 7.4).

Score = (PASS + IMPROVEMENT) ÷ (all rows − every EXCLUDED class).

## What is still open (12 rows)

| Rows | What closes them |
|---|---|
| Office 22.377, 22.386a, 22.387a | Kirby checks Touch ID in person |
| Cloud 21.1.1, 21.3.1 and labels 21.1, 21.3 | One real Google or Apple sign-in into Markie RS. Server `markie-api` 8ed421211f04 is deployed. |
| Editors 8.6 and group 8.0 | One real trackpad pinch by Kirby |
| Editors 7.9 | The 50 MB timing, run with the speed comparison on a quiet Mac |
| Editors 7.4 and group 7.0 | Stay open: Kirby kept 36 languages |

If every row above closes except the last two, the score is 334 of 336, which is 99.4%.
