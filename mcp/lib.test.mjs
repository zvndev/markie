import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPath, matchQuery, classifyAgentFile, isCachedAgentPath, groupSkills, markieOpenCommand } from "./lib.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, rmSync, existsSync } from "node:fs";
import { INSTRUCTIONS, applyMarkieFrontMatter } from "./conventions.mjs";
import { MARKDOWN_GUIDE, GUIDE_URI, guideEssentials } from "./markdown-guide.mjs";
import { checkMarkdown } from "./check-md.mjs";
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

// ---- What Markie renders (the guide, and the static check that enforces it) ----

test("the guide states the rules an agent gets wrong, in one place", () => {
  // Extension lists, because "which extensions" is exactly the question an
  // agent cannot answer from the markdown spec.
  for (const ext of [".png", ".gif", ".svg", ".mp4", ".mov", ".mp3", ".opus"]) {
    assert.ok(MARKDOWN_GUIDE.includes(ext), `guide never mentions ${ext}`);
  }
  // The trap: a picture written to a temp folder displays nothing, silently.
  assert.match(MARKDOWN_GUIDE, /\/tmp/);
  assert.match(MARKDOWN_GUIDE, /<mark>/);
  assert.match(MARKDOWN_GUIDE, /font-size/);
  assert.match(MARKDOWN_GUIDE, /data:image\/png;base64/);
  assert.match(MARKDOWN_GUIDE, /footnote/i);
  assert.match(MARKDOWN_GUIDE, /markie_check_md/);
  // The three shapes an agent cannot invent: a width, an alignment, a video.
  assert.match(MARKDOWN_GUIDE, /<img src="demo\/shot\.png" alt="the dashboard" width="240">/);
  assert.match(MARKDOWN_GUIDE, /<p style="text-align: center;">/);
  assert.match(MARKDOWN_GUIDE, /youtu\.be/);
  // And the one thing that is true of nothing else: dropped in both places.
  assert.match(MARKDOWN_GUIDE, /renders nowhere/i);
});

// Exports parse and sanitize the document's own HTML (src/lib/markdown-html.ts
// runs remark-rehype with allowDangerousHtml, then rehype-raw). The guide said
// the opposite before that landed, which is the kind of claim that has to be
// re-measured rather than re-read.
test("the guide does not claim raw HTML is lost in an export", () => {
  assert.doesNotMatch(MARKDOWN_GUIDE, /No raw HTML survives/i);
  assert.match(MARKDOWN_GUIDE, /Exports, PDFs and shared pages\s+render it/);
});

test("the guide stays client-agnostic prose, like the instructions it folds into", () => {
  assert.doesNotMatch(MARKDOWN_GUIDE, /claude code/i);
  assert.doesNotMatch(MARKDOWN_GUIDE, /codex/i);
  assert.doesNotMatch(MARKDOWN_GUIDE, /—/);
});

test("the short version is a slice of the guide, and reaches the handshake", () => {
  const essentials = guideEssentials();
  assert.ok(essentials.length > 200);
  assert.ok(MARKDOWN_GUIDE.includes(essentials), "the digest is not part of the guide");
  // No second copy: the instructions interpolate the same slice.
  assert.ok(INSTRUCTIONS.includes(essentials), "the handshake lost the short version");
  assert.match(INSTRUCTIONS, /markie_check_md/);
  assert.match(INSTRUCTIONS, /markie_guide/);
});

// SKILL.md is the copy an agent reads without ever calling a tool, so it holds
// the whole guide rather than a pointer to it. A copy only stays correct if
// something notices when the original moves.
test("SKILL.md embeds the guide byte for byte", async () => {
  const { readFileSync: readSrc } = await import("node:fs");
  const skill = readSrc(pjoin(MCP_DIR, "skills", "markie-conventions", "SKILL.md"), "utf8");
  const start = skill.indexOf("-->", skill.indexOf("<!-- markdown-guide:start"));
  const end = skill.indexOf("<!-- markdown-guide:end -->");
  assert.ok(start !== -1 && end !== -1, "the markdown-guide markers are gone from SKILL.md");
  assert.equal(
    skill.slice(start + 3, end).trim(),
    MARKDOWN_GUIDE.trim(),
    "SKILL.md drifted; re-copy MARKDOWN_GUIDE from mcp/markdown-guide.mjs between the markers"
  );
  // And the skill teaches the tool that enforces it.
  assert.match(skill, /markie_check_md/);
});

// ---- markie_check_md (mcp/check-md.mjs) ----

const DOC = "/home/u/notes/report.md";
// A stub filesystem: only these paths exist, so a test says what it means.
const present = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};
const checkOpts = (...paths) => ({ exists: present(...paths) });

test("check-md names the kind of every target it finds", () => {
  const md = [
    "![a](shot.png)",
    "![b](clip.mp4)",
    "![c](memo.mp3)",
    "[d](archive.zip)",
    "[e](https://example.com)",
    "![f](data:image/png;base64,iVBORw0KGgo=)",
    "[g](#section)",
    "[h](other.md)",
  ].join("\n\n");
  const r = checkMarkdown(md, DOC, checkOpts(
    "/home/u/notes/shot.png",
    "/home/u/notes/clip.mp4",
    "/home/u/notes/memo.mp3",
    "/home/u/notes/archive.zip",
    "/home/u/notes/other.md"
  ));
  assert.deepEqual(
    r.targets.map((t) => t.kind),
    ["image", "video", "audio", "file", "remote", "data", "anchor", "document"]
  );
  // Local targets carry a resolved path; the ones that name where they live do not.
  assert.equal(r.targets[0].resolved, "/home/u/notes/shot.png");
  assert.equal(r.targets[4].resolved, undefined);
  assert.equal(r.targets[5].resolved, undefined);
  assert.equal(r.targets[6].resolved, undefined);
  assert.equal(r.ok, true);
});

test("check-md follows a file: URL to the path it names", () => {
  // The absolute-path mistake in its other costume: an agent that saved a
  // screenshot to a temp folder and linked to it by URL.
  const r = checkMarkdown("![a](file:///tmp/shot.png)\n", DOC, checkOpts("/tmp/shot.png"));
  assert.equal(r.targets[0].kind, "image");
  assert.equal(r.targets[0].resolved, "/tmp/shot.png");
  assert.equal(r.targets[0].exists, true);
  assert.equal(r.targets[0].insideDocFolder, false);
  assert.equal(r.counts.outsideFolder, 1);
});

test("check-md fails a document whose picture is not there", () => {
  const r = checkMarkdown("![a](shot.png)\n", DOC, checkOpts());
  assert.equal(r.ok, false);
  assert.equal(r.counts.missing, 1);
  assert.equal(r.targets[0].exists, false);
  assert.match(r.targets[0].warnings[0], /No file at this path/);
  assert.match(r.summary, /shot\.png/);
});

test("check-md fails an embed of a kind Markie cannot draw, and passes the link form", () => {
  const embed = checkMarkdown("![the report](report.pdf)\n", DOC, checkOpts("/home/u/notes/report.pdf"));
  assert.equal(embed.ok, false);
  assert.equal(embed.counts.undisplayable, 1);
  assert.equal(embed.targets[0].kind, "file");
  assert.equal(embed.targets[0].displayable, false);
  assert.match(embed.targets[0].warnings[0], /embeds pictures, video and audio only/);

  const link = checkMarkdown("[the report](report.pdf)\n", DOC, checkOpts("/home/u/notes/report.pdf"));
  assert.equal(link.ok, true);
  assert.equal(link.counts.undisplayable, 0);
});

test("check-md warns about a target outside the document's folder without guessing", () => {
  const md = "![a](/Users/somebody/Desktop/shot.png)\n\n![b](../assets/logo.png)\n";
  const r = checkMarkdown(md, DOC, checkOpts("/Users/somebody/Desktop/shot.png", "/home/u/assets/logo.png"));
  assert.equal(r.counts.outsideFolder, 2);
  assert.equal(r.targets[0].insideDocFolder, false);
  for (const t of r.targets) {
    assert.match(t.warnings[0], /Markie workspace folders/);
    assert.match(t.warnings[0], /cannot see which folders those are/);
  }
  // A warning, never a verdict: the MCP does not know the workspace folders,
  // so it must not fail a document that is very likely fine.
  assert.equal(r.ok, true);
  assert.match(r.summary, /outside the document's folder/);
});

// A sized picture is written as its tag (src/lib/rich-media-html.ts), so the
// file behind it is exactly as missing as one written with markdown syntax.
test("check-md checks the src of a lone picture or clip tag, and never flags the tag", () => {
  const md = [
    '<img src="demo/shot.png" alt="beside" width="240">',
    "",
    '<video src="demo/clip.mp4" width="320" controls></video>',
  ].join("\n");
  const ok = checkMarkdown(md, DOC, checkOpts("/home/u/notes/demo/shot.png", "/home/u/notes/demo/clip.mp4"));
  assert.deepEqual(ok.html, []);
  assert.deepEqual(ok.targets.map((t) => [t.kind, t.embed, t.exists]), [
    ["image", true, true],
    ["video", true, true],
  ]);
  assert.equal(ok.ok, true);

  const missing = checkMarkdown(md, DOC, checkOpts());
  assert.equal(missing.ok, false);
  assert.equal(missing.counts.missing, 2);
  assert.deepEqual(missing.html, []);
});

// An aligned paragraph or heading is the other block the editor owns.
test("check-md leaves an aligned block alone, and holds one that is written loosely", () => {
  const clean = [
    '<p style="text-align: center;">Signed off</p>',
    "",
    '<h2 style="text-align: right;">Appendix</h2>',
    "",
    '<p style="text-align: center">no semicolon is fine</p>',
  ].join("\n");
  assert.deepEqual(checkMarkdown(clean, DOC, checkOpts()).html, []);

  // A class, or single quotes, and it is ordinary raw HTML again: still fine in
  // an export, a placeholder in Rich.
  const loose = "<p class=\"x\" style=\"text-align: center;\">centered</p>\n";
  const r = checkMarkdown(loose, DOC, checkOpts());
  assert.deepEqual(r.html.map((h) => [h.tag, h.effect]), [["p", "held"]]);
  assert.match(r.html[0].note, /placeholder/);
  assert.match(r.html[0].note, /render it/);
  assert.equal(r.ok, true);
});

test("check-md says both halves for an inline tag Rich does not keep", () => {
  const md = [
    "Press <kbd>Cmd</kbd> and H<sub>2</sub>O.",       // 1
    "",                                                // 2
    "A <b>bold</b> word.",                             // 3
    "",                                                // 4
    "A <small>small</small> word.",                    // 5
    "",                                                // 6
    'A <span style="background-color: #fee">bg</span> word.', // 7
  ].join("\n");
  const r = checkMarkdown(md, DOC, checkOpts());
  assert.deepEqual(
    r.html.map((h) => [h.tag, h.line, h.effect]),
    [
      ["kbd", 1, "unwrapped"],
      ["sub", 1, "unwrapped"],
      ["b", 3, "rewritten"],
      ["small", 5, "unwrapped"],
      ["span", 7, "unwrapped"],
    ]
  );
  // A kbd renders in an export; a small does not. Both halves, every time.
  assert.match(r.html[0].note, /renders in exports and shared pages/);
  assert.match(r.html[0].note, /Rich drops the tag/);
  assert.match(r.html[3].note, /dropped by exports/);
  assert.match(r.html[2].note, /Nothing is lost/);
  // None of this is a broken document.
  assert.equal(r.ok, true);
  assert.equal(r.counts.htmlDropped, 0);
  assert.match(r.summary, /render differently in Rich and in exports/);
});

test("check-md leaves the tags Rich keeps exactly as written alone", () => {
  const md = [
    "A <mark>flagged</mark> word.",
    "",
    "An <u>underlined</u> word.",
    "",
    'A <span style="color: #b91c1c">red</span> word.',
    "",
    'A <span style="font-family: Georgia">serif</span> word.',
    "",
    'A <span style="font-size: 24px">big</span> word.',
    "",
    '<mark data-color="#fde68a" style="background-color: rgb(253, 230, 138); color: inherit;">as Markie writes it</mark>',
  ].join("\n");
  const r = checkMarkdown(md, DOC, checkOpts());
  // The last one starts its line, which makes it a block whatever the tag is.
  assert.deepEqual(r.html.map((h) => [h.tag, h.form, h.effect]), [["mark", "block", "held"]]);
  assert.equal(r.ok, true);
});

test("check-md fails a document carrying markup that renders nowhere", () => {
  const md = [
    "# Report",                                  // 1
    "",                                          // 2
    "<script>alert(1)</script>",                 // 3
    "",                                          // 4
    '<iframe src="https://example.com"></iframe>', // 5
    "",                                          // 6
    "<style>p{color:red}</style>",               // 7
    "",                                          // 8
    '<img src="shot.png" onerror="alert(1)">',   // 9
  ].join("\n");
  const r = checkMarkdown(md, DOC, checkOpts("/home/u/notes/shot.png"));
  assert.deepEqual(
    r.html.map((h) => [h.tag, h.line, h.effect]),
    [
      ["script", 3, "dropped"],
      ["iframe", 5, "dropped"],
      ["style", 7, "dropped"],
      ["img", 9, "dropped"],
    ]
  );
  assert.match(r.html[3].note, /on\.\.\.= handler/);
  // The CSS in a <style> comes out as visible text, which is worse than losing it.
  assert.match(r.html[2].note, /visible text/);
  assert.equal(r.counts.htmlDropped, 4);
  assert.equal(r.ok, false);
  assert.match(r.summary, /renders nowhere/);
});

test("check-md finds a script hiding inside a block it would otherwise just hold", () => {
  const md = ['<div class="wrap">', "<script>alert(1)</script>", "</div>"].join("\n");
  const r = checkMarkdown(md, DOC, checkOpts());
  assert.deepEqual(
    r.html.map((h) => [h.tag, h.line, h.effect]),
    [["div", 1, "held"], ["script", 2, "dropped"]]
  );
  assert.equal(r.ok, false);
});

test("check-md fails a javascript: link, which works in neither place", () => {
  const r = checkMarkdown("[click](javascript:alert(1))\n", DOC, checkOpts());
  assert.equal(r.targets[0].unsafe, true);
  assert.equal(r.counts.unsafe, 1);
  assert.match(r.targets[0].warnings[0], /works nowhere/);
  assert.equal(r.ok, false);
});

test("check-md ignores comments and anything inside code", () => {
  const md = [
    "<!-- a note to nobody -->",
    "",
    "Inline `<div>` and `![x](nope.png)` are code, not markup.",
    "",
    "```markdown",
    "![example](example.png)",
    "<section>",
    "```",
    "",
    "Real text.",
  ].join("\n");
  const r = checkMarkdown(md, DOC, checkOpts());
  assert.deepEqual(r.html, []);
  assert.deepEqual(r.targets, []);
  assert.equal(r.ok, true);
});

test("check-md reads the angle-bracket target form, and resolves a nested folder", () => {
  const md = "![a](<demo/my shot.png>)\n\n![b](assets/logo.svg)\n";
  const r = checkMarkdown(md, DOC, checkOpts("/home/u/notes/demo/my shot.png", "/home/u/notes/assets/logo.svg"));
  assert.equal(r.targets[0].raw, "demo/my shot.png");
  assert.equal(r.targets[0].exists, true);
  assert.equal(r.targets[0].insideDocFolder, true);
  assert.equal(r.targets[1].kind, "image");
  // The angle-bracket form is a link target, never a <demo> tag.
  assert.deepEqual(r.html, []);
  assert.equal(r.ok, true);
});

test("check-md says nothing is wrong with a document that is fine", () => {
  const md = [
    "# Report",
    "",
    "Some **bold** text with a <mark>flagged</mark> phrase and a [link](https://example.com).",
    "",
    "![the dashboard](demo/shot.png)",
    "",
    '<img src="demo/detail.png" alt="detail" width="240">',
    "",
    '<p style="text-align: center;">Signed off by the team</p>',
    "",
    "https://youtu.be/dQw4w9WgXcQ",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
  ].join("\n");
  const r = checkMarkdown(md, DOC, checkOpts("/home/u/notes/demo/shot.png", "/home/u/notes/demo/detail.png"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.html, []);
  assert.equal(r.counts.missing, 0);
  // Two pictures and one link. A bare address is not a target: it names where
  // it lives, exactly as localAssetCount treats it.
  assert.equal(r.counts.targets, 3);
  assert.match(r.summary, /Everything in this document displays/);
});

test("check-md needs the document's path, because relative targets have nothing else", () => {
  assert.throws(() => checkMarkdown("![a](x.png)", ""), /absolute path/);
});


test("MCP serves the guide as a resource and as a tool, and checks a real file", async () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const client = startMcpClient(home);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "markie-test", version: "0.0.0" },
    });
    assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} });

    const tools = await client.request("tools/list");
    const names = tools.result.tools.map((t) => t.name);
    assert.ok(names.includes("markie_check_md"), names.join(","));
    assert.ok(names.includes("markie_guide"), names.join(","));

    const resources = await client.request("resources/list");
    assert.deepEqual(resources.result.resources.map((r) => r.uri), [GUIDE_URI]);
    const read = await client.request("resources/read", { uri: GUIDE_URI });
    assert.equal(read.result.contents[0].text, MARKDOWN_GUIDE);
    const missing = await client.request("resources/read", { uri: "markie://guide/nope" });
    assert.match(missing.error.message, /Unknown resource/);

    const guide = await client.callTool("markie_guide", {});
    assert.equal(guide.result.content[0].text, MARKDOWN_GUIDE);

    // A real document, on disk: one picture that exists, one that does not, a
    // block that renders in an export but not in Rich, and one that renders
    // nowhere.
    mkdirSync(pjoin(home, "notes"), { recursive: true });
    writeFileSync(pjoin(home, "notes", "here.png"), "not really a png");
    const doc = pjoin(home, "notes", "report.md");
    writeFileSync(
      doc,
      "![a](here.png)\n\n<img src=\"gone.png\" width=\"240\">\n\n<div>x</div>\n\n<script>x</script>\n"
    );
    const res = await client.callTool("markie_check_md", { path: doc });
    const report = JSON.parse(res.result.content[0].text);
    assert.equal(report.ok, false);
    assert.equal(report.counts.missing, 1);
    assert.equal(report.counts.html, 2);
    assert.equal(report.counts.htmlDropped, 1);
    assert.equal(report.targets[0].exists, true);
    // The width tag's src is checked exactly like the markdown form's.
    assert.equal(report.targets[1].raw, "gone.png");
    assert.equal(report.targets[1].exists, false);

    // The read guard is the same one markie_read_md uses.
    const outside = await client.callTool("markie_check_md", { path: "/etc/hosts" });
    assert.match(outside.result.content[0].text, /only \.md, \.markdown, or \.mdx/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
