# Phase 3: Keyboard-First, Performance, Local Theming

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markie is fully drivable without a mouse, typing stays native-fast on large docs, and users can restyle their documents with saveable theme presets (cloud sync of presets comes in Phase 8).

**Architecture:** A central command registry (`src/lib/commands.ts`) describes every app action once — id, title, shortcut, run(ctx) — and feeds three consumers: the command palette (Cmd+K), the global keydown handler, and the shortcut cheat-sheet (Cmd+/). Theming is CSS custom properties: a `ThemeTokens` object (fonts, colors, sizes, code theme) applied to `:root`-scoped variables that globals.css already consumes; presets persist in localStorage under `markie.themes` (schema versioned for Phase 8 cloud sync).

**Parent roadmap:** `docs/superpowers/plans/2026-06-11-markie-roadmap.md`

---

### Task 1: Command registry + palette (Cmd+K) + cheat-sheet (Cmd+/)

**Files:**
- Create: `src/lib/commands.ts` (registry: ids, titles, keywords, shortcuts; pure, testable)
- Create: `src/components/command-palette.tsx` (fuzzy filter, arrow-key nav, Enter runs)
- Create: `src/components/shortcuts-help.tsx` (grouped cheat-sheet from the registry)
- Modify: `src/app/page.tsx` (registry context: mode setters, file ops, format ops, theme ops)
- Modify: `electron/main.js` + `electron/preload.js` + `src/lib/electron.ts` (menu items View > Command Palette ⌘K, Help-style Shortcuts ⌘/)

Commands (initial set): Open, Save, Save As, Duplicate, Rename, Export PDF Dark/Light, Export HTML, View/Edit/Split mode, Statistics, Format Tables, all format-rail actions (when rich editor focused), theme switching (one command per preset), Shortcuts help.

- [ ] Registry with unit tests (fuzzy match ranking, shortcut formatting).
- [ ] Palette: fixed overlay, input autofocus, ↑/↓/Enter/Esc, runs command, closes.
- [ ] Esc/Tab focus management: palette and panels trap focus; Esc always returns to the active editor.
- [ ] Verify via dev browser; commit.

### Task 2: Performance — budget, measurement, fixes

- [ ] Add `scripts/perf-check.mjs`: drives the packaged app via CDP, loads a generated 5k-line doc, sends 50 keystrokes into the rich view, samples `PerformanceObserver` long tasks + input→rAF latency, prints p50/p95. Fail threshold: p95 > 32ms.
- [ ] Memoize the CodeMirror pane against rich-view-originated content churn (skip `setContent` echo into CodeMirror when value unchanged — verify no extra re-renders with React Profiler counts via CDP).
- [ ] Debounce stats panel recompute (only when visible).
- [ ] Run perf-check before/after; record numbers in the commit message; commit.

### Task 3: Theming engine + light theme + settings UI

- [ ] `src/lib/theme.ts`: `ThemeTokens` type (bg, surface, text, muted, accent, link, font body/mono, font size, content width, code highlight scheme), `applyTheme(tokens)` setting CSS vars, `BUILT_IN_THEMES` (Markie Dark = current look, Markie Light), localStorage persistence (`markie.themes.v1`), versioned export/import JSON. Unit tests for persistence round-trip.
- [ ] Refactor globals.css hardcoded colors to the variables (keep current values as the Dark preset).
- [ ] `src/components/theme-settings.tsx`: panel (View > Theme…, also via palette): preset list (apply/duplicate/delete), token editors (color inputs, font size slider, width), live preview, Save as preset.
- [ ] PDF export honors the active theme where it already supports dark/light; otherwise unchanged this phase.
- [ ] Verify both built-ins + a custom preset survive app restart (packaged, CDP localStorage check); commit.

### Task 4: Verify, ship

- [ ] `npm test`, lint, pack; CDP pass: palette opens with ⌘K, runs "Toggle Split", cheat-sheet on ⌘/, theme switch persists across relaunch; perf-check p95 within budget.
- [ ] Roadmap update, PR, merge (standing approval), push.
