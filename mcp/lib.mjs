// Pure helpers for the Markie MCP server: path guarding, query matching, and
// agent-file grouping (classification itself lives in agent-classify.mjs). Kept dependency-light and side-effect-free so they
// can be unit-tested in isolation (node --test lib.test.mjs).
import { resolve, join, sep, dirname, basename, win32 as winPath } from "node:path";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
// Self-contained scan rules (no ../electron dependency — see scan.mjs header).
import { isExcludedDir, allowlist } from "./scan.mjs";
import { classifyAgentFile } from "./agent-classify.mjs";

export const MD_RE = /\.(md|markdown|mdx)$/i;

// Display order + labels for grouped skills — mirrors src/lib/agent-files.ts.
export const AGENT_TOOLS = [
  { id: "claude", label: "Claude" },
  { id: "openai", label: "OpenAI · Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "cursor", label: "Cursor" },
];

function relSegments(full, home) {
  const rel =
    full === home
      ? ""
      : full.startsWith(home + sep)
        ? full.slice(home.length + 1)
        : full;
  return rel.split(sep).filter(Boolean);
}

// The allowlisted root (e.g. ~/.claude/skills, ~/.codex) containing `full`, or
// null. Inside such a root the leading dot-dir is permitted; deeper vendored or
// hidden dirs are still pruned.
function allowRootFor(full, home) {
  return (
    allowlist(home).find((a) => full === a || full.startsWith(a + sep)) || null
  );
}

// Canonicalize by realpath-ing the deepest EXISTING ancestor and re-appending
// the non-existent tail. This resolves any symlink in the path (file OR dir) so
// the caller's checks run against the real on-disk location, not the lexical
// string. New files (whose parents may not exist yet) still resolve correctly.
// Guards against a symlink cycle made of links that all dangle, which realpath
// would report as ELOOP but our manual walk cannot see.
const MAX_LINK_HOPS = 40;

function canonicalize(full) {
  let existing = full;
  const tail = [];
  let hops = 0;
  while (true) {
    try {
      const real = realpathSync(existing);
      return tail.length ? join(real, ...tail.slice().reverse()) : real;
    } catch (e) {
      if (e.code !== "ENOENT") throw e; // ELOOP/EACCES/… → caller rejects

      // SECURITY: a symlink whose target does not exist yet still fails
      // realpath with ENOENT. Treating it as a plain new file would let a
      // dangling link inside home resolve to any path anywhere, so follow it
      // by hand. A cloned repo can carry such a link as ordinary content.
      let target = null;
      try {
        if (lstatSync(existing).isSymbolicLink()) target = readlinkSync(existing);
      } catch {
        // not a link, or it vanished between the two calls
      }
      if (target !== null) {
        if (++hops > MAX_LINK_HOPS) throw new Error("too many symbolic links");
        existing = resolve(dirname(existing), target);
        continue;
      }

      const parent = dirname(existing);
      if (parent === existing) return full; // hit the root; nothing existed
      tail.push(basename(existing));
      existing = parent;
    }
  }
}

// Validate a path for read/write. Returns { ok, path } or { ok:false, error }.
// Mirrors what the device index would surface: markdown extension, under home,
// and no excluded/hidden ancestor segment (except the allowlisted skill roots).
// SECURITY: paths are realpath-canonicalized so a symlink (file or directory)
// cannot dodge these checks (read/write outside home). Writes additionally
// refuse the allowlisted skill roots so agents can't implant skill files.
export function guardPath(input, home, { mode = "read" } = {}) {
  if (!input || typeof input !== "string") {
    return { ok: false, error: "path is required" };
  }
  let full = input;
  if (full === "~") full = home;
  else if (full.startsWith("~/")) full = join(home, full.slice(2));
  full = resolve(full);

  // Canonicalize home + target so symlinks can't dodge the checks below.
  let homeReal = home;
  try { homeReal = realpathSync(home); } catch { /* fake/non-existent home in tests */ }
  let real;
  try { real = canonicalize(full); } catch {
    return { ok: false, error: "path could not be resolved" };
  }

  if (!MD_RE.test(real)) {
    return { ok: false, error: "only .md, .markdown, or .mdx files are allowed" };
  }
  if (real !== homeReal && !real.startsWith(homeReal + sep)) {
    return { ok: false, error: "path must be inside your home folder" };
  }

  const root = allowRootFor(real, homeReal);
  if (mode === "write" && root) {
    return { ok: false, error: "writing agent/skill files is disabled" };
  }

  const dirSegs = relSegments(real, homeReal).slice(0, -1); // drop the filename
  const skip = root ? relSegments(root, homeReal).length : 0;
  for (const s of dirSegs.slice(skip)) {
    if (isExcludedDir(s)) {
      return { ok: false, error: `refused: "${s}" is an excluded directory` };
    }
  }
  return { ok: true, path: real };
}

// Case-insensitive substring match on a scan row's name or path. Empty → all.
export function matchQuery(row, query) {
  const q = (query || "").toLowerCase();
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) || row.path.toLowerCase().includes(q)
  );
}

// Which agent tool a file belongs to, or null. ONE definition, shared with the
// app: re-exported rather than mirrored, because the mirror drifted.
export { classifyAgentFile, isCachedAgentPath } from "./agent-classify.mjs";

// Group scan rows into agent tools (display order), dropping empty groups.
export function groupSkills(rows) {
  const byTool = new Map();
  for (const r of rows) {
    const tool = classifyAgentFile(r.path, r.name);
    if (!tool) continue;
    const arr = byTool.get(tool);
    if (arr) arr.push(r);
    else byTool.set(tool, [r]);
  }
  return AGENT_TOOLS.map((t) => ({
    id: t.id,
    label: t.label,
    files: (byTool.get(t.id) ?? []).sort((a, b) => a.path.localeCompare(b.path)),
  })).filter((g) => g.files.length > 0);
}

// Where the Windows installer puts Markie. NSIS defaults to a per-user install
// under %LOCALAPPDATA%\\Programs; the machine-wide install lands in Program Files.
function windowsMarkieExe({ env = process.env, exists = existsSync } = {}) {
  // win32.join explicitly: this path is a Windows path even when the rule is
  // being evaluated (in a test) on a POSIX host.
  const candidates = [
    env.LOCALAPPDATA && winPath.join(env.LOCALAPPDATA, "Programs", "Markie", "Markie.exe"),
    env.ProgramFiles && winPath.join(env.ProgramFiles, "Markie", "Markie.exe"),
    env["ProgramFiles(x86)"] && winPath.join(env["ProgramFiles(x86)"], "Markie", "Markie.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // unreadable location — try the next one
    }
  }
  return null;
}

// The command that opens a file in Markie. `open -a Markie` on macOS is exact;
// the other platforms have to work harder.
export function markieOpenCommand(filePath, platform = process.platform, {
  env = process.env,
  exists = existsSync,
} = {}) {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "path is required" };
  }
  if (platform === "darwin") {
    return {
      ok: true,
      command: "open",
      args: ["-a", "Markie", filePath],
      message: `Opening ${filePath} in Markie`,
    };
  }
  if (platform === "win32") {
    // The old form was `powershell -Command "Start-Process -LiteralPath $args[0]"
    // <path>`, which binds nothing: with -Command the trailing argument is
    // appended to the script text, so $args is empty and the path is ignored.
    // Launching the installed executable directly is both correct and actually
    // opens Markie rather than whatever owns the .md association.
    const exe = windowsMarkieExe({ env, exists });
    if (exe) {
      return {
        ok: true,
        command: exe,
        args: [filePath],
        message: `Opening ${filePath} in Markie`,
      };
    }
    // No install found: hand the path to explorer.exe, which launches the
    // system .md handler and does no command-line re-parsing. `cmd.exe /c start`
    // was rejected: Node only quotes arguments containing spaces or quotes, so
    // a file named `notes&calc&.md` would make cmd.exe run `calc` — a real
    // command-injection through a filename an agent or archive can create.
    const explorer = winPath.join(env.SystemRoot || env.windir || "C:\\Windows", "explorer.exe");
    return {
      ok: true,
      command: explorer,
      args: [filePath],
      message: `Opening ${filePath} with your system Markdown handler`,
    };
  }
  if (platform === "linux") {
    return {
      ok: true,
      command: "xdg-open",
      args: [filePath],
      message: `Opening ${filePath} with your system Markdown handler`,
    };
  }
  return { ok: false, error: `unsupported platform: ${platform}` };
}
