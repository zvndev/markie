import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createDrafts, keyFor } = require("./drafts.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "markie-drafts-"));

describe("drafts", () => {
  it("saves, lists, reads, and discards a pathful draft", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: "/notes/a.md", name: "a.md" }, "draft body");
    const entries = d.check({ fileMtime: () => 0 }); // file older than draft
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/notes/a.md");
    expect(d.read(entries[0].key)).toBe("draft body");
    d.discard(entries[0].key);
    expect(d.check({ fileMtime: () => 0 })).toHaveLength(0);
  });

  it("hides a draft older than the file (the save landed)", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: "/notes/a.md", name: "a.md" }, "old draft");
    const entries = d.check({ fileMtime: () => Date.now() + 60_000 });
    expect(entries).toHaveLength(0);
  });

  it("keeps a draft whose file is gone entirely", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: "/notes/deleted.md", name: "deleted.md" }, "the only copy left");
    expect(d.check({ fileMtime: () => null })).toHaveLength(1);
  });

  it("keeps one untitled draft, recoverable while non-empty", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: null, name: null }, "untitled work");
    const entries = d.check({ fileMtime: () => null });
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBeNull();
  });

  it("an empty save clears the draft instead of storing emptiness", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: null, name: null }, "something");
    d.save({ path: null, name: null }, "");
    expect(d.check({ fileMtime: () => null })).toHaveLength(0);
  });

  it("clearing a draft that was never written is not an error", () => {
    const d = createDrafts({ dir: tmp() });
    expect(d.save({ path: "/notes/never.md", name: "never.md" }, "").ok).toBe(true);
    expect(d.check({ fileMtime: () => 0 })).toHaveLength(0);
  });

  it("prunes drafts past maxAgeDays", () => {
    let t = Date.parse("2026-08-01T00:00:00Z");
    const d = createDrafts({ dir: tmp(), now: () => new Date(t), maxAgeDays: 7 });
    d.save({ path: "/notes/a.md", name: "a.md" }, "x");
    t = Date.parse("2026-08-20T00:00:00Z");
    d.save({ path: "/notes/b.md", name: "b.md" }, "y"); // triggers prune
    const entries = d.check({ fileMtime: () => 0 });
    expect(entries.map((e: { path: string }) => e.path)).toEqual(["/notes/b.md"]);
  });

  it("drops oldest first once the store is over its byte cap", () => {
    let t = Date.parse("2026-08-01T00:00:00Z");
    const d = createDrafts({ dir: tmp(), now: () => new Date(t), maxTotalBytes: 40 });
    for (const name of ["a", "b", "c"]) {
      d.save({ path: `/notes/${name}.md`, name: `${name}.md` }, "x".repeat(30));
      t += 1000;
    }
    const kept = d.check({ fileMtime: () => 0 }).map((e: { path: string }) => e.path);
    expect(kept).toContain("/notes/c.md");
    expect(kept).not.toContain("/notes/a.md");
  });

  it("newest first, so the boot strip offers the most recent loss", () => {
    let t = Date.parse("2026-08-01T00:00:00Z");
    const d = createDrafts({ dir: tmp(), now: () => new Date(t) });
    d.save({ path: "/notes/a.md", name: "a.md" }, "older");
    t += 60_000;
    d.save({ path: "/notes/b.md", name: "b.md" }, "newer");
    expect(d.check({ fileMtime: () => 0 }).map((e: { path: string }) => e.path)).toEqual([
      "/notes/b.md",
      "/notes/a.md",
    ]);
  });

  it("two files with the same basename never share a draft", () => {
    expect(keyFor("/one/notes.md")).not.toBe(keyFor("/two/notes.md"));
    const d = createDrafts({ dir: tmp() });
    d.save({ path: "/one/notes.md", name: "notes.md" }, "from one");
    d.save({ path: "/two/notes.md", name: "notes.md" }, "from two");
    const entries = d.check({ fileMtime: () => 0 });
    expect(entries).toHaveLength(2);
  });

  it("reading or discarding a key that is not there answers rather than throwing", () => {
    const d = createDrafts({ dir: tmp() });
    expect(d.read("nope")).toBeNull();
    expect(d.discard("nope").ok).toBe(true);
  });
});
