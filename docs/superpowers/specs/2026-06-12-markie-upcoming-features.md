# Markie — Upcoming Features Plan

_Last updated: 2026-06-12_

A living roadmap of features that are designed or in-flight but not yet shipped
to users. Each item notes its current state and the intended shape. This is a
planning doc, not a committed spec — individual features get their own
`*-design.md` spec + implementation plan when we pick them up.

---

## 1. Context-aware terminal (deferred — design captured, UI hidden)

**Status:** The terminal is fully built (real PTY via `node-pty` + `xterm.js`,
tabbed, with an external-app launcher) but **hidden behind the
`TERMINAL_ENABLED` flag** in `src/lib/features.ts`. It's hidden because the
current "Open in <external app>" model is not the product we want, and the real
direction is a larger design decision.

**Chosen direction:** _Real shell + summonable agent._ The terminal stays a
genuine login shell (your real `zsh`; git/npm/vim all work), but Markie makes it
*aware* of the current doc + workspace and lets you summon a context-aware agent
on demand. Built in layers, each useful on its own:

- **Phase A — Context injection (foundation, small).** Inject env vars into
  every shell: `MARKIE_FILE`, `MARKIE_DIR`, `MARKIE_WORKSPACE`, and possibly
  `MARKIE_SELECTION`. Auto-`cd` new terminals to the open doc's folder;
  re-inject when the active file changes. Outcome: the shell always knows what
  you're looking at.
- **Phase B — The `markie` CLI (the bridge).** A bundled `markie` command on the
  terminal's PATH that talks to the running app over a local socket:
  `markie current`, `markie cat`, `markie files`, `markie open <f>`,
  `markie append/write`, `markie search`. Outcome: you (and any script) can
  read/edit the current doc and workspace from the shell.
- **Phase C — Markie MCP server (the tool surface).** Markie exposes a local
  **MCP server** with those same capabilities as MCP tools (`get_current_doc`,
  `read_doc`, `list_workspace`, `search`, `open_file`, `edit_doc`, …). Outcome:
  any MCP client — Claude Code, Codex, custom — can use Markie's tools. This is
  the "tools and MCP calls" requirement.
- **Phase D — Summonable agent.** `markie ask "…"` (or a hotkey) spins up an
  agent via the **ZVN inference gateway** (`claude()`/`codex()`), pre-wired to
  the MCP server so it already has doc + workspace context and tools. Outcome:
  the Copilot-in-terminal feeling, grounded in your file.
- **Phase E — Shell profile picker (replaces "Open in ▾").** Swap the
  external-app launcher for a `+ ▾` picker of installed shells
  (zsh/bash/fish/pwsh/nu) that run *inside* Markie — the actual VS Code model.
  External launch can survive as a minor secondary action, or get cut.

**Notes / decisions:**
- The embedded terminal is architecturally identical to VS Code's
  (xterm.js + node-pty). VS Code's "different terminals" are **shell profiles**,
  not embedded copies of Ghostty/iTerm — macOS has no API to embed another
  terminal emulator's window. So the right move is a shell picker (Phase E),
  not external launching.
- Build spine is A → B → C; D and E are the payoff and the polish. A is tiny and
  standalone. Nothing else depends on E.
- To re-expose the current terminal for dev work: set `TERMINAL_ENABLED = true`.

**Related tickets:** Task #48 (built terminal, done), Task #49 (this design).

---

## 2. Account-optional sharing — Phase 2 (parked on domain)

**Status:** Phase 1 backend is deployed and smoke-tested (pending-invite claim,
playful invite emails, viewer-default roles). Phase 2 is the **public
`/s/:token` page** where a recipient with no account can download the `.md` and
get nudged to join Markie.

**Blocked on:** Kirby's custom domain going live (the share/site URL). Until
then `MARKIE_SITE_URL` points at the placeholder.

**Related ticket:** Task #43.

---

## Housekeeping / operational

- **Rotate credentials** now that the release pipeline is proven: Apple
  app-specific password + B2 application key. They were passed inline at release
  time only (never written to the repo). See [release runbook in memory].
- **Commit policy:** working-tree changes (image/link modal, terminal hide,
  0.2.0 bump, sticky update toast) await an explicit go before committing, per
  the per-directory git identity rules (ZVN DEV; branch off `main`).
