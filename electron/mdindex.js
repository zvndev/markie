// Device-wide markdown index. Pure walk + exclusion logic lives here with no
// electron/registry imports at module load, so it is unit-testable under vitest.
const fs = require("fs");
const path = require("path");
const os = require("os");

const fsp = fs.promises;
const MD_RE = /\.(md|markdown|mdx)$/i;

// Non-dot directories that are vendored, generated, or system noise.
//
// The cloud-storage names (Dropbox, Google Drive, OneDrive) matter more than
// they look: every readdir inside a provider-backed folder is an XPC round trip
// to that provider's file-provider daemon, which is what turned a background
// index into visible Finder/system pressure. The Windows names keep the walk
// out of AppData, where a profile hides tens of thousands of vendored files.
const EXCLUDED_NAMES = new Set([
  "node_modules", "Library", "vendor", "bower_components",
  "dist", "build", "out", "target", "Pods",
  "venv", "site-packages", "DerivedData",
  "tmp", "temp",
  // Cloud-sync mounts (macOS + Windows).
  "Dropbox", "Google Drive", "OneDrive",
  // macOS media/app folders that are bundle farms, not document folders.
  "Applications", "Pictures", "Movies", "Music",
  // Windows profile noise.
  "AppData", "Application Data", "Local Settings", "$Recycle.Bin",
]);

// Directories that are really opaque documents: a package/bundle whose insides
// are an implementation detail. Descending into a .photoslibrary or an .app is
// tens of thousands of pointless readdirs, and any .md inside is vendored.
const BUNDLE_RE =
  /\.(app|photoslibrary|musiclibrary|tvlibrary|aplibrary|fcpbundle|imovielibrary|logicx|band|rcproject|xcodeproj|xcworkspace|playground|pvm|vmwarevm|utm|sparsebundle|download|lproj|framework|bundle|kext|pkg|appex|plugin|qlgenerator|prefpane|wdgt)$/i;

// Budget: a device-wide walk must always terminate, even on a machine with a
// pathological tree. Hitting a limit returns what was found so far rather than
// running forever or holding a million rows in memory.
const DEFAULT_BUDGET = { maxFiles: 200000, maxMs: 30000, maxDepth: 24 };

function isBundleDir(name) {
  return BUNDLE_RE.test(String(name || ""));
}

// A directory is excluded if it is hidden (dot-dir) or a known vendored name.
// Dot-dir pruning removes the bulk of noise (.git/.bun/.cargo/.scion/.claude/…)
// and keeps the walk fast by never descending into it.
function isExcludedDir(name) {
  if (!name) return false;
  if (name.startsWith(".")) return true;
  if (isBundleDir(name)) return true;
  return EXCLUDED_NAMES.has(name);
}

// macOS "Desktop & Documents" iCloud sync turns every readdir under ~/Desktop
// and ~/Documents into a fileproviderd round trip, so we leave a provider-backed
// one alone unless the user explicitly made it a workspace root — an indexer has
// no business waking the sync daemon.
//
// The old test was a marker directory anywhere under ~/Library/Mobile Documents,
// which is present as soon as *any* iCloud-aware app is installed. That skipped
// ~/Desktop and ~/Documents on machines where neither is synced at all. Ask each
// folder instead: when the feature is on, macOS replaces the folder with a link
// into ~/Library/Mobile Documents/…, so its real path says so.
const MOBILE_DOCUMENTS = "/Library/Mobile Documents/";

function isProviderBacked(dir, realpath) {
  try {
    return String(realpath(dir)).includes(MOBILE_DOCUMENTS);
  } catch {
    return false; // missing or unreadable — nothing to spare
  }
}

// Injected `platform`/`realpath` keep this testable off a real Mac.
function icloudDesktopDocuments({
  home,
  platform = process.platform,
  realpath = fs.realpathSync,
} = {}) {
  if (platform !== "darwin" || !home) return [];
  return [path.join(home, "Desktop"), path.join(home, "Documents")].filter((dir) =>
    isProviderBacked(dir, realpath)
  );
}

// The set of absolute directories the walk refuses to enter. A directory the
// user registered as a workspace root is never in it: an explicit choice
// outranks the heuristic.
function skippedDirs({ home, platform = process.platform, realpath = fs.realpathSync, roots = [] } = {}) {
  const registered = new Set((roots || []).filter(Boolean).map((r) => path.resolve(r)));
  const skip = new Set();
  for (const dir of icloudDesktopDocuments({ home, platform, realpath })) {
    if (registered.has(dir)) continue;
    // Registered somewhere *below* the tree still means the user asked for it.
    if ([...registered].some((r) => r.startsWith(dir + path.sep))) continue;
    skip.add(dir);
  }
  return skip;
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

// The registered workspace root `full` sits in (the deepest one), or null.
function nearestRoot(full, roots = []) {
  let best = null;
  for (const r of roots || []) {
    if (!r) continue;
    if (full === r || full.startsWith(r + path.sep)) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best;
}

// Decide whether to descend into `full` (a directory named `name`).
//
// Allowlisted roots (e.g. ~/.claude/skills, ~/.codex) let the walk pierce the
// dot-dir barrier, but *inside* them we still prune node_modules, other vendored
// dirs, and any nested dot-dir — otherwise allowlisting a tool dir would drag in
// its node_modules. Everything outside the allowlist uses the segment predicate.
//
// A registered workspace root outranks every name-based rule: the user pointed
// at that folder on purpose, and `~/Dropbox/Notes` or `~/Pictures/Screenshots`
// would otherwise be pruned by the very names we added to keep the *unasked-for*
// walk cheap. Inside a root the vendored-name rules still apply — they are just
// measured from the root instead of from $HOME, so the root's own excluded
// ancestor no longer taints everything under it.
function shouldDescend(full, name, home, { allow = allowlist(home), skip = null, roots = [] } = {}) {
  if (skip && skip.has(full)) return false;
  const base = nearestRoot(full, roots);
  // The registered root itself → always walk it.
  if (base === full) return true;
  if (isBundleDir(name)) return false;
  // Inside a registered root: prune vendored/dot dirs relative to the root.
  if (base) {
    if (name === "pkg" && path.basename(path.dirname(full)) === "go") return false;
    return !hasExcludedSegment(full, base);
  }
  // An ancestor of a registered root → descend toward it, excluded name or not.
  if ((roots || []).some((r) => r.startsWith(full + path.sep))) return true;
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
//
// `stats` is an optional caller-owned object the walk fills in with what the
// budget did ({ files, dirs, ms, truncated, reason }). Returning the plain array
// keeps every existing caller working; the metadata rides alongside.
async function walk(rootDir, {
  home = os.homedir(),
  platform = process.platform,
  realpath = fs.realpathSync,
  roots = [],
  budget = {},
  now = Date.now,
  stats = {},
} = {}) {
  const limits = { ...DEFAULT_BUDGET, ...budget };
  const startedAt = now();
  // Hoisted: these were rebuilt for every directory the walk touched.
  const allow = allowlist(home);
  const skip = skippedDirs({ home, platform, realpath, roots });
  const registered = (roots || []).filter(Boolean).map((r) => path.resolve(r));
  const out = [];
  let dirs = 0;
  let stopped = null;   // "files" | "time" — abort the whole walk
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
        if (shouldDescend(full, ent.name, home, { allow, skip, roots: registered }))
          subdirs.push(full);
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

let _cache = null;          // { files, scannedAt }
let _scanning = null;       // in-flight promise (dedupe concurrent scans)

// Targets to walk, with any target that already sits inside another dropped —
// walking both ~ and ~/Notes would index ~/Notes twice.
// A registered workspace root is kept even when it sits inside another target:
// it may live under a name the $HOME walk prunes, and walking it as its own
// target is what guarantees it is indexed. Duplicate rows are dropped by path
// in rescan(), so overlapping targets cost time, never correctness.
function scanTargets(targets, roots = []) {
  const keep = new Set((roots || []).filter(Boolean).map((r) => path.resolve(r)));
  const resolved = [...new Set(targets.filter(Boolean).map((t) => path.resolve(t)))];
  return resolved.filter(
    (t) =>
      keep.has(t) ||
      !resolved.some((other) => other !== t && t.startsWith(other + path.sep))
  );
}

// Run a fresh scan. Concurrent callers share one in-flight scan.
//
// `rescan()` with no arguments keeps its original meaning (walk $HOME), so
// existing callers in main.js do not have to change. Pass
// `rescan({ roots, includeHome: false })` to index only the user's registered
// workspace roots — far less filesystem pressure than a device-wide walk.
// The user's registered workspace roots, read lazily so this module still has
// no load-time dependency on the registry (or, through it, on Electron).
// Failing to read them is not fatal: it only means the heuristics apply.
function registeredRoots() {
  try {
    return require("./workspace.js").roots();
  } catch {
    return [];
  }
}

function rescan(options = {}) {
  if (_scanning) return _scanning;
  const home = options.home || os.homedir();
  // Without this, a $HOME scan would prune an iCloud-synced ~/Documents even
  // when the user had explicitly registered it as a workspace root.
  const roots = Array.isArray(options.roots) ? options.roots : registeredRoots();
  const includeHome = options.includeHome !== false;
  const targets = scanTargets(includeHome || !roots.length ? [home, ...roots] : roots, roots);

  _scanning = (async () => {
    const files = [];
    const seen = new Set();
    const stats = { truncated: false, reason: null };
    // One budget for the whole rescan, not one per target: three roots used to
    // buy three times the file cap and three times the wall clock, which is how
    // a "30 second" scan became a minute and a half of disk pressure.
    const limits = { ...DEFAULT_BUDGET, ...(options.budget || {}) };
    const now = options.now || Date.now;
    const startedAt = now();
    let usedFiles = 0;
    for (const target of targets) {
      const remainingFiles = limits.maxFiles - usedFiles;
      const remainingMs = limits.maxMs - (now() - startedAt);
      if (remainingFiles <= 0 || remainingMs <= 0) {
        stats.truncated = true;
        stats.reason = stats.reason || (remainingFiles <= 0 ? "files" : "time");
        break;
      }
      const one = {};
      const rows = await walk(target, {
        ...options,
        home,
        roots,
        budget: { ...limits, maxFiles: remainingFiles, maxMs: remainingMs },
        stats: one,
      });
      usedFiles += one.files || 0;
      for (const row of rows) {
        if (seen.has(row.path)) continue;
        seen.add(row.path);
        files.push(row);
      }
      if (one.truncated) {
        stats.truncated = true;
        stats.reason = stats.reason || one.reason;
      }
    }
    _cache = {
      files,
      scannedAt: new Date().toISOString(),
      roots: targets,
      truncated: stats.truncated,
      truncatedReason: stats.reason,
    };
    return _cache;
  })().finally(() => { _scanning = null; });

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
  isExcludedDir, isBundleDir, EXCLUDED_NAMES, BUNDLE_RE, DEFAULT_BUDGET, registeredRoots,
  shouldDescend, allowlist, icloudDesktopDocuments, skippedDirs, scanTargets, nearestRoot,
  walk, rescan, getCached, seed,
};
