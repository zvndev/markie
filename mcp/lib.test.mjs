import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPath, matchQuery, classifyAgentFile, groupSkills, markieOpenCommand } from "./lib.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
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

test("markieOpenCommand uses a Windows file association opener without a Unix command", () => {
  assert.deepEqual(markieOpenCommand("C:\\Users\\u\\Notes\\a.md", "win32"), {
    ok: true,
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-Command",
      "Start-Process -LiteralPath $args[0]",
      "C:\\Users\\u\\Notes\\a.md",
    ],
    message: "Opening C:\\Users\\u\\Notes\\a.md with your system Markdown handler",
  });
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
