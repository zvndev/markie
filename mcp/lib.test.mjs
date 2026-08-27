import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPath, matchQuery, classifyAgentFile, isCachedAgentPath, groupSkills, markieOpenCommand } from "./lib.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, rmSync, existsSync } from "node:fs";
import { INSTRUCTIONS, applyMarkieFrontMatter } from "./conventions.mjs";
import { walk, DEFAULT_BUDGET } from "./scan.mjs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname as pdirname, join as pjoin } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = "/home/u";
const MCP_DIR = pdirname(fileURLToPath(import.meta.url));

function startMcpClient(home) {
  const child = spawn(process.execPath, [pjoin(MCP_DIR, "markie-mcp.mjs")], {
    cwd: pdirname(MCP_DIR),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderr = [];
  let buffer = "";
  let id = 1;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("exit", () => {
    const err = new Error(`MCP server exited early: ${stderr.join("")}`);
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  });

  function request(method, params) {
    const reqId = id++;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`Timed out waiting for ${method}: ${stderr.join("")}`));
      }, 3000);
      pending.set(reqId, {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
    return response;
  }

  return {
    request,
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    callTool(name, args) {
      return request("tools/call", { name, arguments: args });
    },
    close() {
      child.kill();
    },
  };
}

// These "allow" cases use a REAL temp home because guardPath now canonicalizes
// via realpath (a fake /home/u would be rewritten by macOS autofs resolution).
test("guardPath allows ordinary markdown under home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    for (const rel of ["notes.md", "projects/app/README.md", "Desktop/Coding/x.markdown", "a/b/c.mdx"]) {
      const p = pjoin(home, rel);
      const r = guardPath(p, home);
      assert.equal(r.ok, true, `${p} should be allowed: ${r.error}`);
      assert.equal(r.path, p);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath expands ~ against home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    const r = guardPath("~/notes.md", home);
    assert.equal(r.ok, true);
    assert.equal(r.path, pjoin(home, "notes.md"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath allows the skill/agent allowlist roots despite the dot-dir", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    for (const rel of [".claude/skills/kirby/SKILL.md", ".codex/AGENTS.md", ".codex/notes/todo.md"]) {
      assert.equal(guardPath(pjoin(home, rel), home).ok, true, `${rel} should be allowed`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath rejects non-markdown files", () => {
  const r = guardPath("/home/u/notes.txt", HOME);
  assert.equal(r.ok, false);
});

test("guardPath rejects paths outside home (incl. traversal)", () => {
  assert.equal(guardPath("/etc/passwd.md", HOME).ok, false);
  assert.equal(guardPath("/home/u/../etc/x.md", HOME).ok, false);
});

test("guardPath rejects excluded segments and hidden dirs", () => {
  for (const p of [
    "/home/u/proj/node_modules/x.md",
    "/home/u/app/tmp/x.md",
    "/home/u/app/temp/x.md",
    "/home/u/.config/x.md",
    "/home/u/.claude/sessions/x.md", // dot-dir, not an allowlist root
  ]) {
    assert.equal(guardPath(p, HOME).ok, false, `${p} should be rejected`);
  }
});

test("guardPath still prunes vendored dirs nested inside an allowlist root", () => {
  assert.equal(
    guardPath("/home/u/.claude/skills/k/node_modules/x.md", HOME).ok,
    false,
  );
});

test("matchQuery matches on name or path, case-insensitive; empty matches all", () => {
  const row = { name: "SKILL.md", path: "/home/u/.claude/skills/Brainstorm/SKILL.md", dir: "" };
  assert.equal(matchQuery(row, "skill"), true);
  assert.equal(matchQuery(row, "BRAINSTORM"), true);
  assert.equal(matchQuery(row, "nope"), false);
  assert.equal(matchQuery(row, ""), true);
});

test("classifyAgentFile mirrors src/lib/agent-files.ts", () => {
  assert.equal(classifyAgentFile("/x/.claude/CLAUDE.md", "CLAUDE.md"), "claude");
  assert.equal(classifyAgentFile("/x/proj/CLAUDE.md", "CLAUDE.md"), "claude");
  assert.equal(classifyAgentFile("/x/.claude/skills/k/SKILL.md", "SKILL.md"), "claude");
  assert.equal(classifyAgentFile("/x/proj/AGENTS.md", "AGENTS.md"), "openai");
  assert.equal(classifyAgentFile("/x/.codex/notes.md", "notes.md"), "openai");
  assert.equal(classifyAgentFile("/x/proj/GEMINI.md", "GEMINI.md"), "gemini");
  assert.equal(classifyAgentFile("/x/proj/.cursorrules", ".cursorrules"), "cursor");
  assert.equal(classifyAgentFile("/x/p/agents.md", "agents.md"), "openai");
  assert.equal(classifyAgentFile("/x/p/README.md", "README.md"), null);
});

test("groupSkills groups classified files by tool, in display order", () => {
  const rows = [
    { name: "README.md", path: "/x/README.md", dir: "/x" },
    { name: "AGENTS.md", path: "/x/.codex/AGENTS.md", dir: "/x/.codex" },
    { name: "CLAUDE.md", path: "/x/CLAUDE.md", dir: "/x" },
    { name: "SKILL.md", path: "/x/.claude/skills/k/SKILL.md", dir: "/x/.claude/skills/k" },
  ];
  const groups = groupSkills(rows);
  // README is not an agent file → excluded; empty groups dropped
  const ids = groups.map((g) => g.id);
  assert.deepEqual(ids, ["claude", "openai"]);
  assert.equal(groups[0].files.length, 2); // CLAUDE.md + SKILL.md
  assert.equal(groups[1].files.length, 1); // AGENTS.md
});

test("markieOpenCommand uses the Markie app on macOS", () => {
  assert.deepEqual(markieOpenCommand("/Users/u/Notes/a.md", "darwin"), {
    ok: true,
    command: "open",
    args: ["-a", "Markie", "/Users/u/Notes/a.md"],
    message: "Opening /Users/u/Notes/a.md in Markie",
  });
});

test("markieOpenCommand launches the installed Markie executable on Windows", () => {
  const exe = "C:\\Users\\u\\AppData\\Local\\Programs\\Markie\\Markie.exe";
  assert.deepEqual(
    markieOpenCommand("C:\\Users\\u\\Notes\\a.md", "win32", {
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      exists: (p) => p === exe,
    }),
    {
      ok: true,
      command: exe,
      args: ["C:\\Users\\u\\Notes\\a.md"],
      message: "Opening C:\\Users\\u\\Notes\\a.md in Markie",
    }
  );
});

test("markieOpenCommand falls back to explorer.exe, never a shell", () => {
  // The old powershell -Command form appended the path to the script text
  // instead of binding it, so nothing opened at all. `cmd.exe /c start` was
  // rejected because a filename containing `&` would be executed by cmd.
  assert.deepEqual(
    markieOpenCommand("C:\\Users\\u\\Notes\\a&calc&.md", "win32", {
      env: { SystemRoot: "C:\\Windows" },
      exists: () => false,
    }),
    {
      ok: true,
      command: "C:\\Windows\\explorer.exe",
      args: ["C:\\Users\\u\\Notes\\a&calc&.md"],
      message: "Opening C:\\Users\\u\\Notes\\a&calc&.md with your system Markdown handler",
    }
  );
});

test("markieOpenCommand uses xdg-open on Linux", () => {
  assert.deepEqual(markieOpenCommand("/home/u/Notes/a.md", "linux"), {
    ok: true,
    command: "xdg-open",
    args: ["/home/u/Notes/a.md"],
    message: "Opening /home/u/Notes/a.md with your system Markdown handler",
  });
});

test("markieOpenCommand rejects unsupported platforms", () => {
  const out = markieOpenCommand("/home/u/Notes/a.md", "freebsd");
  assert.equal(out.ok, false);
  assert.match(out.error, /unsupported platform/);
});

test("guardPath denies a .md symlink that points outside home (read escape)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  try {
    writeFileSync(pjoin(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(pjoin(outside, "secret.txt"), pjoin(home, "link.md"));
    const r = guardPath(pjoin(home, "link.md"), home);
    assert.equal(r.ok, false, "symlink to outside-home non-md must be denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guardPath denies writing through a symlinked directory (write escape)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  try {
    symlinkSync(outside, pjoin(home, "escape")); // dir symlink under home
    const r = guardPath(pjoin(home, "escape", "implanted.md"), home, { mode: "write" });
    assert.equal(r.ok, false, "write through a symlinked dir must be denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// The two symlink tests above both point at something that already exists, so
// realpath resolves them. A link whose target does NOT exist yet fails realpath
// with ENOENT, which used to read as "an ordinary new file inside home" and let
// a write land anywhere, under any extension. A cloned repo can carry one.
test("guardPath denies a DANGLING symlink that points outside home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  try {
    const target = pjoin(outside, "not-created-yet.plist");
    symlinkSync(target, pjoin(home, "notes.md"));
    assert.equal(existsSync(target), false, "target must not exist for this test");

    const w = guardPath(pjoin(home, "notes.md"), home, { mode: "write" });
    assert.equal(w.ok, false, "write through a dangling escape link must be denied");

    const r = guardPath(pjoin(home, "notes.md"), home);
    assert.equal(r.ok, false, "read through a dangling escape link must be denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guardPath resolves a dangling symlink that stays inside home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    mkdirSync(pjoin(home, "notes"));
    symlinkSync(pjoin(home, "notes", "real.md"), pjoin(home, "alias.md"));
    const r = guardPath(pjoin(home, "alias.md"), home, { mode: "write" });
    assert.equal(r.ok, true, "an in-home dangling link is legitimate");
    assert.equal(r.path, pjoin(home, "notes", "real.md"), "it resolves to its target");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath survives a cycle of dangling symlinks", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    symlinkSync(pjoin(home, "b.md"), pjoin(home, "a.md"));
    symlinkSync(pjoin(home, "a.md"), pjoin(home, "b.md"));
    const r = guardPath(pjoin(home, "a.md"), home);
    assert.equal(r.ok, false, "a link cycle must be refused, not hang");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath allows an ordinary real .md under a real home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    mkdirSync(pjoin(home, "notes"));
    writeFileSync(pjoin(home, "notes", "a.md"), "# hi");
    const r = guardPath(pjoin(home, "notes", "a.md"), home);
    assert.equal(r.ok, true, r.error);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath write-mode denies the allowlist skill roots (no agent-file implant)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    mkdirSync(pjoin(home, ".claude", "skills"), { recursive: true });
    const r = guardPath(pjoin(home, ".claude", "skills", "x.md"), home, { mode: "write" });
    assert.equal(r.ok, false, "writing under ~/.claude/skills must be denied");
    // but reading is still fine
    assert.equal(guardPath(pjoin(home, ".claude", "skills", "x.md"), home).ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("MCP stdio write/read keeps markdown writes fenced to safe home paths", async () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  const client = startMcpClient(home);
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "markie-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});

    const target = pjoin(home, "workspace", "agent-note.md");
    const body = "# MCP write\n\nLocal fenced markdown.";
    const write = await client.callTool("markie_write_md", { path: target, content: body });
    assert.equal(write.result.isError, undefined);
    assert.match(write.result.content[0].text, /^Wrote \d+ bytes to /);

    const read = await client.callTool("markie_read_md", { path: target });
    assert.equal(read.result.isError, undefined);
    assert.equal(read.result.content[0].text, body);

    const unsafeExtension = await client.callTool("markie_write_md", {
      path: pjoin(home, "workspace", "agent-note.txt"),
      content: "not markdown",
    });
    assert.equal(unsafeExtension.result.isError, true);
    assert.match(unsafeExtension.result.content[0].text, /only \.md, \.markdown, or \.mdx files are allowed/);

    symlinkSync(outside, pjoin(home, "escape"));
    const symlinkEscape = await client.callTool("markie_write_md", {
      path: pjoin(home, "escape", "implanted.md"),
      content: "# escape",
    });
    assert.equal(symlinkEscape.result.isError, true);
    assert.match(symlinkEscape.result.content[0].text, /path must be inside your home folder/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// mcp/scan.mjs is a deliberate copy of electron/mdindex.js's exclusion rules:
// the MCP server ships as an extraResource and must never reach into the app's
// asar. A copy only stays correct if something notices when the original moves.
test("scan.mjs exclusion rules and budget stay in sync with electron/mdindex.js", async () => {
  const { EXCLUDED_NAMES, BUNDLE_RE, DEFAULT_BUDGET } = await import("./scan.mjs");
  const { createRequire } = await import("node:module");
  const mdindex = createRequire(import.meta.url)("../electron/mdindex.js");

  assert.deepEqual(
    [...EXCLUDED_NAMES].sort(),
    [...mdindex.EXCLUDED_NAMES].sort(),
    "EXCLUDED_NAMES drifted; copy the list from electron/mdindex.js"
  );
  assert.equal(BUNDLE_RE.source, mdindex.BUNDLE_RE.source, "BUNDLE_RE drifted");
  assert.equal(BUNDLE_RE.flags, mdindex.BUNDLE_RE.flags, "BUNDLE_RE flags drifted");
  assert.deepEqual(
    DEFAULT_BUDGET,
    mdindex.DEFAULT_BUDGET,
    "the scan budget drifted; copy it from electron/mdindex.js"
  );
});

// ---- Agent-facing conventions (initialize instructions + the write path) ----

test("INSTRUCTIONS teach the organization conventions", () => {
  assert.ok(INSTRUCTIONS.length > 200);
  assert.match(INSTRUCTIONS, /markie_find_md/);
  assert.match(INSTRUCTIONS, /project/);
  assert.match(INSTRUCTIONS, /block/);
  assert.match(INSTRUCTIONS, /front matter/i);
});

test("INSTRUCTIONS stay client-agnostic and never recommend date-named blocks", () => {
  // Codex and any other MCP client read this same string, so nothing in it may
  // assume Claude Code.
  assert.doesNotMatch(INSTRUCTIONS, /claude code/i);
  assert.doesNotMatch(INSTRUCTIONS, /codex/i);
  // Phase 3B strips leading date stamps out of derived block names; the
  // instructions must not recommend what the engine deliberately undoes.
  assert.match(INSTRUCTIONS, /never after a date/i);
  // No em-dashes in prose the user reads.
  assert.doesNotMatch(INSTRUCTIONS, /—/);
});

test("applyMarkieFrontMatter adds front matter to a bare document", () => {
  const out = applyMarkieFrontMatter("# Doc\n", { project: "App", block: "auth" });
  assert.equal(
    out,
    "---\nmarkie:\n  project: App\n  block: auth\n---\n# Doc\n"
  );
});

test("applyMarkieFrontMatter merges into existing front matter, preserving other keys", () => {
  const src = "---\ntitle: T\nmarkie:\n  project: Old\n---\nbody\n";
  const out = applyMarkieFrontMatter(src, { project: "New", block: "b" });
  assert.match(out, /title: T/);
  assert.match(out, /project: New/);
  assert.match(out, /block: b/);
  assert.doesNotMatch(out, /project: Old/);
  assert.match(out, /^---\n/);
});

test("applyMarkieFrontMatter quotes values that need it and skips empties", () => {
  const out = applyMarkieFrontMatter("x\n", { project: "My: App", block: null });
  assert.match(out, /project: "My: App"/);
  assert.doesNotMatch(out, /block:/);
});

test("applyMarkieFrontMatter leaves a hyphenated block name unquoted", () => {
  // Every block name the instructions and the skill recommend is hyphenated
  // ("auth-flow", "checkout-redesign"). Quoting them would make the front
  // matter agents produce look nothing like the front matter we show them.
  const out = applyMarkieFrontMatter("x\n", { project: "markie", block: "auth-flow" });
  assert.match(out, /^ {2}block: auth-flow$/m);
});

test("applyMarkieFrontMatter with no declaration returns the content untouched", () => {
  // The parameters are additive: every existing call must produce the exact
  // bytes it always did.
  const src = "---\ntitle: T\n---\n# Doc\n";
  assert.equal(applyMarkieFrontMatter(src, {}), src);
  assert.equal(applyMarkieFrontMatter(src), src);
  assert.equal(applyMarkieFrontMatter(src, { project: null, block: null }), src);
});

test("the write path emits the exact shape the app's extractor reads", () => {
  const out = applyMarkieFrontMatter("# Plan\n", { project: "Markie", block: "organized-workspace" });
  assert.equal(
    out,
    "---\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\n# Plan\n"
  );
});

test("MCP initialize hands the client the conventions, and a declared write lands them on disk", async () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const client = startMcpClient(home);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "markie-test", version: "0.0.0" },
    });
    assert.equal(init.result.instructions, INSTRUCTIONS);
    client.notify("notifications/initialized", {});

    // The tool contract is additive: project/block are optional, path/content
    // are still the only required arguments.
    const tools = await client.request("tools/list");
    const write = tools.result.tools.find((t) => t.name === "markie_write_md");
    assert.deepEqual(write.inputSchema.required, ["path", "content"]);
    assert.equal(write.inputSchema.properties.project.type, "string");
    assert.equal(write.inputSchema.properties.block.type, "string");

    const target = pjoin(home, "notes", "plan.md");
    const res = await client.callTool("markie_write_md", {
      path: target,
      content: "# Plan\n",
      project: "Markie",
      block: "organized-workspace",
    });
    assert.equal(res.result.isError, undefined);
    assert.equal(
      readFileSync(target, "utf8"),
      "---\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\n# Plan\n"
    );
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("markie_list_skills classification hides plugin-cache noise like the app does", () => {
  // The bug: a skill cloned into ~/.codex/plugins/cache showed in MCP results
  // while the app's Skills panel hid it. On this machine that was 1,732 of the
  // 2,284 files markie_list_skills returned.
  assert.equal(
    classifyAgentFile("/home/u/.claude/plugins/cache/foo/SKILL.md", "SKILL.md"),
    null
  );
  assert.equal(
    classifyAgentFile("/home/u/.codex/plugins/cache/foo/SKILL.md", "SKILL.md"),
    null
  );
  assert.equal(
    classifyAgentFile("/home/u/.claude/skills/mine/SKILL.md", "SKILL.md"),
    "claude"
  );
});

test("classification normalizes Windows separators before matching", () => {
  // The app's copy replaced backslashes; the MCP copy did not, so a Windows
  // cache path escaped the filter on one side only.
  assert.equal(
    classifyAgentFile("C:\\Users\\u\\.codex\\plugins\\cache\\f\\SKILL.md", "SKILL.md"),
    null
  );
  assert.equal(classifyAgentFile("C:\\Users\\u\\.codex\\notes.md", "notes.md"), "openai");
});

test("isCachedAgentPath is exported from the MCP surface", () => {
  assert.equal(isCachedAgentPath("/h/.codex/plugins/cache/x/SKILL.md"), true);
  assert.equal(isCachedAgentPath("/h/.codex/skills/x/SKILL.md"), false);
});

// The MCP server ships as an extraResource, OUTSIDE the app's asar. An import
// that reaches up into ../electron or ../src resolves fine in the repo and is
// simply absent in the packaged app (that broke the app once; see the scan.mjs
// header). Tests may reach out, because tests are not packaged; runtime code
// may not. Globbing the directory rather than naming files keeps this honest
// when someone adds a module.
test("no runtime module in mcp/ imports anything outside mcp/", async () => {
  const { readdirSync, readFileSync: readSrc } = await import("node:fs");
  const runtime = readdirSync(MCP_DIR).filter(
    (f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")
  );
  assert.ok(runtime.length >= 4, `expected the mcp/ runtime modules, saw ${runtime}`);
  for (const file of runtime) {
    const src = readSrc(pjoin(MCP_DIR, file), "utf8");
    const specifiers = [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g),
      ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      const local = spec.startsWith("node:") || /^\.\/[^/]+$/.test(spec);
      assert.ok(local, `${file} imports "${spec}", which escapes mcp/`);
    }
  }
});

// ---- Scan budget (markie_find_md walks $HOME on first call) ----

test("walk stops at maxFiles and reports truncation", async () => {
  const root = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-scanbudget-")));
  try {
    for (let i = 0; i < 10; i++) writeFileSync(pjoin(root, `f${i}.md`), "x");
    const stats = {};
    const rows = await walk(root, { home: root, budget: { maxFiles: 3 }, stats });
    assert.equal(rows.length, 3);
    assert.equal(stats.truncated, true);
    assert.equal(stats.reason, "files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walk stops descending past maxDepth", async () => {
  const root = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-scandepth-")));
  try {
    let dir = root;
    for (let i = 0; i < 5; i++) {
      dir = pjoin(dir, `d${i}`);
      mkdirSync(dir);
      writeFileSync(pjoin(dir, `f${i}.md`), "x");
    }
    const stats = {};
    const rows = await walk(root, { home: root, budget: { maxDepth: 2 }, stats });
    assert.equal(rows.length, 2);
    assert.equal(stats.truncated, true);
    assert.equal(stats.reason, "depth");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walk stops when the clock budget is spent", async () => {
  const root = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-scantime-")));
  try {
    mkdirSync(pjoin(root, "a"));
    mkdirSync(pjoin(root, "a", "b"));
    writeFileSync(pjoin(root, "top.md"), "x");
    writeFileSync(pjoin(root, "a", "mid.md"), "x");
    writeFileSync(pjoin(root, "a", "b", "deep.md"), "x");
    // A clock that jumps past the budget after the first directory.
    let ticks = 0;
    const now = () => (ticks++ === 0 ? 0 : 999_999);
    const stats = {};
    const rows = await walk(root, { home: root, budget: { maxMs: 10 }, now, stats });
    assert.equal(rows.map((r) => r.name).join(","), "top.md");
    assert.equal(stats.truncated, true);
    assert.equal(stats.reason, "time");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unbudgeted walk reports that it finished", async () => {
  const root = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-scanfull-")));
  try {
    writeFileSync(pjoin(root, "a.md"), "x");
    mkdirSync(pjoin(root, "sub"));
    writeFileSync(pjoin(root, "sub", "b.md"), "x");
    const stats = {};
    const rows = await walk(root, { home: root, stats });
    assert.equal(rows.length, 2);
    assert.equal(stats.truncated, false);
    assert.equal(stats.reason, null);
    assert.equal(stats.dirs, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("markie_find_md says so when the real scan hits its depth cap", async () => {
  // A cap that returns half the disk without saying so is worse than a slow
  // scan: the agent concludes the document does not exist and writes a
  // duplicate, which is exactly what the instructions tell it to avoid.
  // No env override here: the fixture is genuinely deeper than DEFAULT_BUDGET
  // allows, so this exercises the shipped defaults through the shipped server.
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const client = startMcpClient(home);
  try {
    writeFileSync(pjoin(home, "shallow.md"), "x");
    let dir = home;
    for (let i = 0; i <= DEFAULT_BUDGET.maxDepth; i++) {
      dir = pjoin(dir, `d${i}`);
      mkdirSync(dir);
    }
    writeFileSync(pjoin(dir, "too-deep.md"), "x");
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "markie-test", version: "0.0.0" },
    });
    const res = await client.callTool("markie_find_md", {});
    const payload = JSON.parse(res.result.content[0].text);
    assert.deepEqual(payload.files.map((f) => f.name), ["shallow.md"]);
    assert.match(payload.truncated, /stopped early \(limit: depth\)/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a complete scan says nothing about truncation", async () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const client = startMcpClient(home);
  try {
    writeFileSync(pjoin(home, "a.md"), "x");
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "markie-test", version: "0.0.0" },
    });
    const res = await client.callTool("markie_find_md", {});
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.count, 1);
    assert.equal(payload.truncated, undefined);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
