// Device-wide markdown scan + exclusion rules for the Markie MCP server.
// Ported from electron/mdindex.js as self-contained ESM so the MCP server has
// NO dependency on ../electron — packaging it as an extraResource must never
// pull files out of the app's asar (that broke the app once; never again).
// Keep the exclusion rules AND the walk budget in sync with
// electron/mdindex.js; "scan.mjs exclusion rules stay in sync with
// electron/mdindex.js" in lib.test.mjs compares both against the original.
import { promises as fsp } from "node:fs";
import path from "node:path";

export const MD_RE = /\.(md|markdown|mdx)$/i;

// Non-dot directories that are vendored, generated, or system noise.
export const EXCLUDED_NAMES = new Set([
  "node_modules", "Library", "vendor", "bower_components",
  "dist", "build", "out", "target", "Pods",
  "venv", "site-packages", "DerivedData",
  "tmp", "temp",
  // Cloud-sync mounts (macOS + Windows): each readdir inside one is an XPC
  // round trip to the provider's daemon.
  "Dropbox", "Google Drive", "OneDrive",
  // macOS media/app folders that are bundle farms, not document folders.
  "Applications", "Pictures", "Movies", "Music",
  // Windows profile noise.
  "AppData", "Application Data", "Local Settings", "$Recycle.Bin",
]);

// Directories that are really opaque documents (packages/bundles).
export const BUNDLE_RE =
  /\.(app|photoslibrary|musiclibrary|tvlibrary|aplibrary|fcpbundle|imovielibrary|logicx|band|rcproject|xcodeproj|xcworkspace|playground|pvm|vmwarevm|utm|sparsebundle|download|lproj|framework|bundle|kext|pkg|appex|plugin|qlgenerator|prefpane|wdgt)$/i;

export function isBundleDir(name) {
  return BUNDLE_RE.test(String(name || ""));
}

// A directory is excluded if it is hidden (dot-dir), a bundle, or a known
// vendored name.
export function isExcludedDir(name) {
  if (!name) return false;
  if (name.startsWith(".")) return true;
  if (isBundleDir(name)) return true;
  return EXCLUDED_NAMES.has(name);
}

// Dot-dir roots explicitly re-included (agent/skill files live under them).
export function allowlist(home) {
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex"),
  ];
}

// True if any path segment of `full` (relative to home) is an excluded dir.
function hasExcludedSegment(full, home) {
  const rel = full.startsWith(home + path.sep) ? full.slice(home.length + 1) : full;
  return rel.split(path.sep).filter(Boolean).some((s) => isExcludedDir(s));
}

// Decide whether to descend into directory `full` (named `name`).
function shouldDescend(full, name, home, allow = allowlist(home)) {
  if (isBundleDir(name)) return false;
  if (allow.some((a) => a === full)) return true;
  if (allow.some((a) => a.startsWith(full + path.sep))) return true;
  if (allow.some((a) => full.startsWith(a + path.sep))) {
    if (name === "pkg" && path.basename(path.dirname(full)) === "go") return false;
    if (name.startsWith(".")) return false;
    if (EXCLUDED_NAMES.has(name)) return false;
    return true;
  }
  if (name === "pkg" && path.basename(path.dirname(full)) === "go") return false;
  return !hasExcludedSegment(full, home);
}

// What one scan is allowed to cost. The app's index has had these caps since it
// shipped; the MCP copy did not, so a single markie_find_md could walk a
// pathological tree for as long as it took. Hitting a limit returns what was
// found rather than failing: a partial answer now beats a perfect one in five
// minutes, as long as the caller is told it is partial.
export const DEFAULT_BUDGET = { maxFiles: 200000, maxMs: 30000, maxDepth: 24 };

// Recursively collect markdown files under rootDir, pruning excluded dirs.
//
// `stats` is an optional caller-owned object the walk fills in with what the
// budget did ({ files, dirs, ms, truncated, reason }). Returning the plain array
// keeps every existing caller working; the metadata rides alongside.
export async function walk(rootDir, { home, budget = {}, now = Date.now, stats = {} } = {}) {
  const baseHome = home ?? rootDir;
  const limits = { ...DEFAULT_BUDGET, ...budget };
  const startedAt = now();
  // Hoisted out of the per-directory loop: it was rebuilt for every readdir.
  const allow = allowlist(baseHome);
  const out = [];
  let dirs = 0;
  let stopped = null;   // "files" or "time": abort the whole walk
  let depthCapped = false;

  async function visit(dir, depth) {
    if (stopped) return;
    if (depth > limits.maxDepth) {
      depthCapped = true;
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, vanished) — skip silently
    }
    dirs += 1;
    const subdirs = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldDescend(full, ent.name, baseHome, allow)) subdirs.push(full);
      } else if (ent.isFile() && MD_RE.test(ent.name)) {
        if (out.length >= limits.maxFiles) {
          stopped = "files";
          return;
        }
        let mtimeMs = 0;
        try { mtimeMs = (await fsp.stat(full)).mtimeMs; } catch { /* keep 0 */ }
        out.push({ path: full, name: ent.name, dir, mtimeMs });
      }
    }
    // Checked per directory rather than per entry: one clock read per readdir.
    if (now() - startedAt > limits.maxMs) {
      stopped = "time";
      return;
    }
    // Sequential descent keeps memory/FD pressure low on huge trees.
    for (const d of subdirs) {
      if (stopped) return;
      await visit(d, depth + 1);
    }
  }

  await visit(rootDir, 0);
  stats.files = out.length;
  stats.dirs = dirs;
  stats.ms = now() - startedAt;
  stats.truncated = !!stopped || depthCapped;
  stats.reason = stopped || (depthCapped ? "depth" : null);
  return out;
}
