// Feature flags for in-progress work that ships in the codebase but stays
// hidden from the UI until it's ready.

// The integrated terminal is built (real PTY via node-pty + xterm) but its
// product direction is being redesigned into a context-aware, tool/MCP-enabled
// shell (see docs/superpowers/specs/2026-06-12-markie-upcoming-features.md).
// Hidden for now; flip to true to expose the current terminal + ⌃` toggle.
export const TERMINAL_ENABLED = false;
