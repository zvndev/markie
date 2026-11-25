# Markie RS docs

Last audited 2026-11-24.

Before planning from a doc, check its status here. Archived docs are history. The live plan is [PLATFORMS.md](PLATFORMS.md) and the live score is [SCORE.md](SCORE.md).

## Status words

- **Current**: how things work now, or the live plan. Kept up to date.
- **Reference**: design notes for a built feature, true as of the doc's date. Their status words ("Not built", "Open items") can lag. What works today is in the audits and SCORE.md.
- **Archived**: superseded plans, finished spikes and decided research, in [archive/](archive/). Do not plan from them.

Docs written before 2026-11-24 call Markie RS a "side build". That is still true of the dev build, `Markie RS.app`. The nightly build is Markie itself on the Mac super-nightly channel ([NIGHTLY.md](NIGHTLY.md)).

## Index

| Doc | Status | What it is for |
|---|---|---|
| [PLATFORMS.md](PLATFORMS.md) | Current | The platform plan: which app runs where, and the order of the work |
| [SCORE.md](SCORE.md) | Current | The parity score across the five audits, its rules, and the rows still open |
| [NIGHTLY.md](NIGHTLY.md) | Current | The Rust app as the Mac super-nightly: identity, the update from Electron, first-run import, release and roll back |
| [PARITY.md](PARITY.md) | Current | What Electron Markie 0.9.7 does, feature by feature. The spec the audits score against. Later Electron features are added as rows in the audits |
| [AUDIT-AGENTS-WEB.md](AUDIT-AGENTS-WEB.md) | Current | Row-by-row parity for agents, Skills, Darkmown, Live Docs and export |
| [AUDIT-CLOUD.md](AUDIT-CLOUD.md) | Current | Row-by-row parity for cloud sync, collaboration, comments, sharing and sign-in |
| [AUDIT-EDITORS.md](AUDIT-EDITORS.md) | Current | Row-by-row parity for the editors, CSV table, autosave, history and link previews |
| [AUDIT-LIBRARY-SETTINGS.md](AUDIT-LIBRARY-SETTINGS.md) | Current | Row-by-row parity for the Library, Browse, Projects, search, settings, styles and menus |
| [AUDIT-OFFICE-PLATFORM.md](AUDIT-OFFICE-PLATFORM.md) | Current | Row-by-row parity for Office documents, OS integration, the vault and crash logs, on macOS |
| [GOOGLE-DOCS.md](GOOGLE-DOCS.md) | Current | Google Docs import, step one: connect with the Picker, one-way import to Markdown, refresh, Save as Word, the spike tool, and what two-way sync still needs |
| [SCREEN.md](SCREEN.md) | Current | The rules and tools for comparing screens in the background, without Kirby's display |
| [PRIVATE-FILES.md](PRIVATE-FILES.md) | Current | Make Private: how private files are stored, the threat model, and the Touch ID keychain audit |
| [PERF.md](PERF.md) | Current | The speed goal, the measurements, and the final comparison still to run |
| [STYLES-FONTS.md](STYLES-FONTS.md) | Current | How Markdown styles and the font library are carried, and how their data is regenerated from Electron |
| [AGENTS-BRIDGE.md](AGENTS-BRIDGE.md) | Reference | Local MCP agents, remote agent tokens and Skills in the dev build |
| [CLOUD.md](CLOUD.md) | Reference | The Markie Cloud client crate and sign-in |
| [CLOUD-SYNC.md](CLOUD-SYNC.md) | Reference | Cloud file sync, assets, links and byte snapshots |
| [COLLAB.md](COLLAB.md) | Reference | Live collaboration, comments and sharing, proved against the web app's own code |
| [EDITOR-BEHAVIOUR.md](EDITOR-BEHAVIOUR.md) | Reference | How Source and View behave, and link previews |
| [INTEGRATION-CLOUD.md](INTEGRATION-CLOUD.md) | Reference | The closed list that wired sign-in, sync, collaboration and the agent bridge together |
| [INTEGRATION-EDITOR.md](INTEGRATION-EDITOR.md) | Reference | The closed list of editor integration items |
| [INTEGRATION-SHELL.md](INTEGRATION-SHELL.md) | Reference | The closed list for the window shell, formats and web integration |
| [LOCAL-FEATURES.md](LOCAL-FEATURES.md) | Reference | Library, registry, Browse, Projects, search, open and save, and settings logic |
| [MATH.md](MATH.md) | Reference | Native math: TeX to SVG through mitex and Typst |
| [MIGRATION.md](MIGRATION.md) | Reference | Reading Electron's Chromium storage and the vault format. The base of the first-run import |
| [OFFICE.md](OFFICE.md) | Reference | The Office engine port and the native Word page view |
| [RICH-EDITOR.md](RICH-EDITOR.md) | Reference | The native rich editor behind View mode |
| [VISUAL-DIALOGS.md](VISUAL-DIALOGS.md) | Reference | Visual parity of dialogs, sheets and settings |
| [VISUAL-EDITOR.md](VISUAL-EDITOR.md) | Reference | Visual parity of the Markdown page, toolbar, find bar and section rail |
| [VISUAL-FORMATS.md](VISUAL-FORMATS.md) | Reference | Visual parity of Word, RTF, ODT, CSV and plain-text documents |
| [VISUAL-SHELL.md](VISUAL-SHELL.md) | Reference | Visual parity of the title bar, activity rail, side panels and search |
| [WEB-EXPORT.md](WEB-EXPORT.md) | Reference | Web islands (Darkmown, Live Docs, video), export and print |
| [archive/PLAN.md](archive/PLAN.md) | Archived | The first rewrite plan. Its phase estimates are wrong. Use PLATFORMS.md |
| [archive/RESEARCH.md](archive/RESEARCH.md) | Archived | The "can Rust do everything" research and toolkit pick, now decided |
| [archive/SPIKE-2A.md](archive/SPIKE-2A.md) | Archived | The rich editor spike that ended GO. Use RICH-EDITOR.md |
| [archive/PLATFORM.md](archive/PLATFORM.md) | Archived | A 2026-11-22 branch report on OS integration, the vault and crash logs. Use AUDIT-OFFICE-PLATFORM.md and NIGHTLY.md |

## Not here

- Docs shared with the Electron app, such as `docs/superpowers` and `docs/mobile`, are audited on the Electron repo's `main`.
- The other `.md` files under `rust/` are test fixtures and the app's welcome document, not docs. `rust/README.md` is the crate layout and commands.
