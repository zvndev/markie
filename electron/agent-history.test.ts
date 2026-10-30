import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createAgentHistory } = require("./agent-history.js");
const { createHistory } = require("./history.js");

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function setup({ unlocked = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markie-agent-history-")));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "markie-agent-history-data-"));
  let t = Date.parse("2026-10-30T12:00:00Z");
  const history = createHistory({ dir: userData, now: () => new Date((t += 1000)) });
  const { handlers } = createAgentHistory({ history, home, unlocked: () => unlocked });
  const file = (name: string, body: string) => {
    const p = path.join(home, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  return { home, history, note: handlers.history_note_write, file };
}

describe("agent history: an MCP write announced over the bridge", () => {
  it("keeps the old text and names the agent as author of the new text", async () => {
    const t = setup();
    const p = t.file("notes/plan.md", "old\n");
    expect(await t.note({ path: p, agent: "claude-code", sha256: sha("new\n") })).toEqual({ noted: true });
    fs.writeFileSync(p, "new\n");
    t.history.captureExternal(p);
    const [newest, older] = t.history.list(p);
    expect(newest).toMatchObject({ author: "agent", agent: "claude-code" });
    expect(t.history.read(p, older.stamp)).toBe("old\n");
  });

  it("records the author of a file the agent is creating", async () => {
    const t = setup();
    const p = path.join(t.home, "fresh.md");
    expect(await t.note({ path: p, agent: "Codex", sha256: sha("hello") })).toEqual({ noted: true });
    fs.writeFileSync(p, "hello");
    expect(t.history.head(p)).toMatchObject({ author: "agent", agent: "Codex" });
  });

  it("refuses paths outside home, relative paths and missing hashes", async () => {
    const t = setup();
    await expect(t.note({ path: "/etc/hosts", agent: "x", sha256: sha("a") })).rejects.toThrow(/home folder/);
    await expect(t.note({ path: "notes.md", agent: "x", sha256: sha("a") })).rejects.toThrow(/absolute/);
    const p = t.file("a.md", "a");
    await expect(t.note({ path: p, agent: "x" })).rejects.toThrow(/sha256/);
  });

  it("cleans the agent name the client chose for itself", async () => {
    const t = setup();
    const p = t.file("a.md", "a");
    await t.note({ path: p, agent: "evil\u0000name\nwith lines", sha256: sha("b") });
    fs.writeFileSync(p, "b");
    expect(t.history.head(p)).toMatchObject({ agent: "evil name with lines" });
  });

  it("says nothing while a private build is locked", async () => {
    const t = setup({ unlocked: false });
    const p = t.file("a.md", "a");
    const spy = vi.spyOn(t.history, "noteAgentWrite");
    expect(await t.note({ path: p, agent: "x", sha256: sha("b") })).toEqual({ noted: false });
    expect(spy).not.toHaveBeenCalled();
  });
});
