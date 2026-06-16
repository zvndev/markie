# App chrome redesign — top bar + left rail + Skills

_Date: 2026-06-16 · Status: approved (clarifications answered), ready to build_

Consolidates four requests: move Share + theme controls to the top bar; turn the
left rail into a VS Code-style view switcher; add a Skills/Agents section; tidy
Browse exclusions.

## 1. Top bar (`toolbar.tsx`)

Right group, left→right: **theme/mode controls** then **Share**.
- **Mode + theme:** System / Light / Dark segmented control + a "Themes" button
  (opens theme presets). Moved out of the left rail. Uses the existing
  `@/lib/color-mode` (`getColorMode`/`applyColorMode`) and a new `onThemePresets`
  prop. A compact segmented control (icons), not the rail's vertical stack.
- **Share:** the top bar already renders a Share button, but only when
  `canShare`. Make it **always visible**; clicking always calls the page's
  `handleShareClick` (which opens the dialog when shareable, or nudges to
  sign-in/sync otherwise). Show a subtle active state when `canShare`.

## 2. Left rail (`activity-bar.tsx`) — view switcher

Top→bottom:
- **New file** (`+` icon) at the very top → `onNewFile` (blank untitled doc).
- **divider**
- **Library** (folder) → panel shows Recent + Files (keeps an internal
  Recent/Files sub-toggle).
- **Browse** (compass) → device-wide markdown index.
- **Shared** (people) → shared-with-you docs.
- **Skills** (sparkles) → agent/skill files (section 4).
- spacer
- **Shortcuts** (?) and **Account** (avatar) stay at the bottom.

Each nav icon sets the active panel view and ensures the panel is open (VS Code
model). Clicking the active icon while the panel is open toggles it closed.

**Removed from the rail:** Share (→ top bar), the color-mode group and theme
presets (→ top bar), and the standalone Open-file icon (already in the top bar +
⌘O).

State: lift `leftView: "library" | "browse" | "shared" | "skills"` and
`libraryOpen` into `page.tsx`. The rail receives `leftView`, `onSelectView`,
`libraryOpen`.

## 3. Library panel (`library.tsx`) — view router

Remove the in-panel `Recent · Files · Shared · Browse` tab row. The panel renders
by the `view` prop passed from `page.tsx`:
- `library` → Recent + Files (small inline Recent/Files toggle retained).
- `browse` → `<BrowseView>`.
- `shared` → the shared-with-you list (existing `sharedItems` rendering).
- `skills` → `<SkillsView>`.

`page.tsx` passes `view={leftView}` to `<Library>`.

## 4. Skills / Agents section (`skills-view.tsx`, new)

Surfaces well-known agent instruction + skill files device-wide, grouped by tool.
Data source: the existing `mdIndexScan` rows (no new IPC) classified by a pure
helper `src/lib/agent-files.ts`:

```
classifyAgentFile(path, name) -> "claude" | "openai" | "gemini" | "cursor" | null
```

Rules (case-insensitive):
- **claude:** name `CLAUDE.md`, or path contains `/.claude/skills/` (e.g.
  `SKILL.md`), or path contains `/.claude/` with an `.md`.
- **openai:** name `AGENTS.md`, or path contains `/.codex/`.
- **gemini:** name `GEMINI.md`.
- **cursor:** name `.cursorrules` (note: not `.md`, so out of the current scan —
  documented as a later add; the classifier still recognizes it).
- else `null`.

`SkillsView` reuses `BrowseView`'s row/open/star interactions but groups by tool
header (Claude · OpenAI/Codex · Gemini · Cursor), each entry showing the file
name + muted path, click-to-open, star.

**"omx":** unknown token from the request — left as a TODO. The classifier's tool
list is a single array, so adding `omx` later is one line once defined.

## 5. Browse exclusions (`electron/mdindex.js`)

- Add `tmp` and `temp` to `EXCLUDED_NAMES` (`.tmp` is already excluded as a
  dot-dir). node_modules stays hard-excluded.
- Expand the allowlist so agent files in dot-dirs are indexed:
  `allowlist(home) = [ ~/.claude/skills, ~/.codex ]`. (`~/.claude/CLAUDE.md`
  already surfaces because `.claude` is descended as an allowlist ancestor.)

## Testing

- `mdindex`: `tmp`/`temp` excluded; `~/.codex` descended; existing tests stay
  green.
- `agent-files`: `classifyAgentFile` table — CLAUDE.md→claude, AGENTS.md→openai,
  `~/.codex/x.md`→openai, GEMINI.md→gemini, `.cursorrules`→cursor, a normal
  `README.md`→null, a `~/.claude/skills/x/SKILL.md`→claude.
- Manual: rail switches panels; Share + theme live in the top bar; New file
  blanks the editor; Skills lists agent files grouped by tool; Browse shows no
  tmp/temp/node_modules.

## Out of scope (later)

- `.cursorrules` and other non-`.md` agent files (needs the scan to collect
  specific non-md filenames).
- Whatever `omx` turns out to be.
- Per-section empty-state polish beyond a one-line message.
