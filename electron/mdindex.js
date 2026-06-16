// Device-wide markdown index. Pure walk + exclusion logic lives here with no
// electron/registry imports at module load, so it is unit-testable under vitest.
const fs = require("fs");
const path = require("path");
const os = require("os");

const fsp = fs.promises;
const MD_RE = /\.(md|markdown|mdx)$/i;

// Non-dot directories that are vendored, generated, or system noise.
const EXCLUDED_NAMES = new Set([
  "node_modules", "Library", "vendor", "bower_components",
  "dist", "build", "out", "target", "Pods",
  "venv", "site-packages", "DerivedData",
  "tmp", "temp",
]);

// A directory is excluded if it is hidden (dot-dir) or a known vendored name.
// Dot-dir pruning removes the bulk of noise (.git/.bun/.cargo/.scion/.claude/…)
// and keeps the walk fast by never descending into it.
function isExcludedDir(name) {
  if (!name) return false;
  if (name.startsWith(".")) return true;
  return EXCLUDED_NAMES.has(name);
}

// Directories explicitly re-included even though the rules above would prune
// them (they live under a dot-dir). Absolute paths, resolved against home.
function allowlist(home) {
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex"), // OpenAI Codex agent files (AGENTS.md, etc.)
  ];
}

// True if any path segment of `full` (relative to home) is itself an excluded
// dir name. This catches children re-exposed when we force-descend a dot-dir
// for the allowlist: e.g. `.claude/sessions` has the excluded `.claude` segment.
function hasExcludedSegment(full, home) {
  const rel = full.startsWith(home + path.sep) ? full.slice(home.length + 1) : full;
  return rel.split(path.sep).filter(Boolean).some((s) => isExcludedDir(s));
}

// Decide whether to descend into `full` (a directory named `name`).
//
// Allowlisted roots (e.g. ~/.claude/skills, ~/.codex) let the walk pierce the
// dot-dir barrier, but *inside* them we still prune node_modules, other vendored
// dirs, and any nested dot-dir — otherwise allowlisting a tool dir would drag in
// its node_modules. Everything outside the allowlist uses the segment predicate.
function shouldDescend(full, name, home) {
  const allow = allowlist(home);
  // The allowlisted root itself → descend into it.
  if (allow.some((a) => a === full)) return true;
  // An ancestor of an allowlisted root → descend toward it.
  if (allow.some((a) => a.startsWith(full + path.sep))) return true;
  // Strictly inside an allowlisted root → keep pruning vendored + nested dots.
  if (allow.some((a) => full.startsWith(a + path.sep))) {
    if (name === "pkg" && path.basename(path.dirname(full)) === "go") return false;
    if (name.startsWith(".")) return false;
    if (EXCLUDED_NAMES.has(name)) return false;
    return true;
  }
  // Outside the allowlist entirely.
  if (name === "pkg" && path.basename(path.dirname(full)) === "go") return false;
  return !hasExcludedSegment(full, home);
}

// Recursively collect markdown files under rootDir, pruning excluded dirs.
// `home` is passed so the allowlist resolves correctly (tests pass a temp home).
async function walk(rootDir, { home = os.homedir() } = {}) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, vanished) — skip silently
    }
    const subdirs = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldDescend(full, ent.name, home)) subdirs.push(full);
      } else if (ent.isFile() && MD_RE.test(ent.name)) {
        let mtimeMs = 0;
        try { mtimeMs = (await fsp.stat(full)).mtimeMs; } catch { /* keep 0 */ }
        out.push({ path: full, name: ent.name, dir, mtimeMs });
      }
    }
    // Sequential descent keeps memory/FD pressure low on huge trees.
    for (const d of subdirs) await visit(d);
  }
  await visit(rootDir);
  return out;
}

let _cache = null;          // { files, scannedAt }
let _scanning = null;       // in-flight promise (dedupe concurrent scans)

// Run a fresh walk from home. Concurrent callers share one in-flight scan.
function rescan() {
  if (_scanning) return _scanning;
  const home = os.homedir();
  _scanning = walk(home, { home })
    .then((files) => {
      _cache = { files, scannedAt: new Date().toISOString() };
      return _cache;
    })
    .finally(() => { _scanning = null; });
  return _scanning;
}

// Return whatever is cached (may be null on first call).
function getCached() {
  return _cache;
}

// Seed the in-memory cache from a persisted snapshot (instant first paint).
function seed(files, scannedAt) {
  if (Array.isArray(files)) _cache = { files, scannedAt: scannedAt || null };
}

module.exports = {
  isExcludedDir, EXCLUDED_NAMES, shouldDescend, allowlist, walk,
  rescan, getCached, seed,
};
