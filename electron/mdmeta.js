// Per-file metadata the taxonomy needs beyond the index row: creation time,
// the markie front matter declaration, and the containing repo's name.
// Incremental on purpose: extraction reads file heads, and reading 12k heads
// on every rescan would turn a cheap stat walk into real IO. Only rows whose
// mtime moved since the stored extraction are touched.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { extractMarkieMeta } = require("./frontmatter");

const HEAD_BYTES = 4096;

function defaultReadHead(p) {
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf-8", 0, read);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function defaultStatBirthtime(p) {
  try {
    const st = fs.statSync(p);
    // Some filesystems report 0 or the epoch for birthtime; treat that as
    // unknown rather than as "made in 1970", which would sort wrongly forever.
    return st.birthtimeMs > 0 ? st.birthtimeMs : null;
  } catch {
    return null;
  }
}

// The nearest ancestor holding a .git entry, named by its directory. Stops at
// home so a walk never climbs out into /Users or /. The cache is per rescan
// and covers every directory walked, not just the hits: most directories have
// no repo above them, and that answer is the expensive one to recompute.
function findRepoRoot(
  dir,
  { home = os.homedir(), exists = fs.existsSync, cache = new Map() } = {}
) {
  let d = dir;
  const walked = [];
  let found = null;
  while (d && (d === home || d.startsWith(home + path.sep))) {
    if (cache.has(d)) {
      found = cache.get(d);
      break;
    }
    walked.push(d);
    if (exists(path.join(d, ".git"))) {
      found = path.basename(d);
      break;
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  for (const w of walked) cache.set(w, found);
  return found;
}

// rows: current index rows. Updates md_meta for new/changed paths only, and
// returns how many it did plus how many it deliberately left for later.
//
// `budgetMs` exists because the first pass is not cheap: measured against the
// owner's real index, extracting 14,554 files took 2.1 seconds of synchronous
// open/read/stat, and the main process has nothing else to do meanwhile. Two
// seconds of unresponsive window is not something a user should pay for a
// feature they have not asked for yet. Every later pass touches only files
// whose mtime moved and finishes in about a millisecond, so the budget only
// ever bites on the very first run and after a bulk rewrite. Callers slice
// until `remaining` reaches zero; skipping an up-to-date row is a Map lookup,
// so re-walking the list each slice costs nothing worth measuring.
function refreshMeta(
  rows,
  {
    registry,
    readHead = defaultReadHead,
    statBirthtime = defaultStatBirthtime,
    findRepoRoot: findRoot = findRepoRoot,
    home = os.homedir(),
    budgetMs = Infinity,
    now = Date.now,
  } = {}
) {
  const known = new Map(registry.metaAll().map((m) => [m.path, m.mtime_ms]));
  const repoCache = new Map();
  const pending = [];
  const startedAt = now();
  let remaining = 0;
  let spent = false;
  for (const row of rows) {
    if (known.get(row.path) === row.mtimeMs) continue;
    if (spent || now() - startedAt >= budgetMs) {
      spent = true;
      remaining += 1;
      continue;
    }
    const head = readHead(row.path);
    const meta = extractMarkieMeta(head);
    pending.push({
      path: row.path,
      mtimeMs: row.mtimeMs,
      birthtimeMs: statBirthtime(row.path),
      fmProject: meta.project,
      fmBlock: meta.block,
      repoName: findRoot(row.dir, { home, cache: repoCache }),
    });
  }
  if (pending.length) registry.metaUpsertMany(pending);
  return { updated: pending.length, remaining };
}

// Pure join for the IPC payloads. metaByPath: Map<path, md_meta row>.
// Additive by design: a row with no metadata yet still renders, it just has
// nothing extra to say.
function withMeta(rows, metaByPath) {
  return rows.map((r) => {
    const m = metaByPath.get(r.path);
    return {
      ...r,
      birthtimeMs: m ? m.birthtime_ms : null,
      fmProject: m ? m.fm_project : null,
      fmBlock: m ? m.fm_block : null,
      repoName: m ? m.repo_name : null,
    };
  });
}

module.exports = { refreshMeta, withMeta, findRepoRoot, HEAD_BYTES };
