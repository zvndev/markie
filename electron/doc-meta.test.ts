import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createDocMeta } = require("./doc-meta.js");
const { slugFor } = require("./snapshots.js");

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "markie-docmeta-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("doc-meta store", () => {
  it("keeps each document's records in a folder named like its version history", () => {
    const userData = tmp();
    const store = createDocMeta({ dir: userData });
    const doc = path.join(tmp(), "notes", "plan.md");
    store.write(doc, "comments", { version: 1, threads: [] });
    const folder = path.join(userData, "doc-meta", slugFor(doc));
    expect(store.dirFor(doc)).toBe(folder);
    expect(JSON.parse(fs.readFileSync(path.join(folder, "comments.json"), "utf8"))).toEqual({ version: 1, threads: [] });
    expect(JSON.parse(fs.readFileSync(path.join(folder, "doc.json"), "utf8")).path).toBe(path.resolve(doc));
    expect(store.read(doc, "comments")).toEqual({ version: 1, threads: [] });
    // A branches.json fits beside it later without touching comments.
    store.write(doc, "branches", { version: 1, branches: [] });
    expect(store.read(doc, "comments")).toEqual({ version: 1, threads: [] });
  });

  it("never writes beside the user's file", () => {
    const docsDir = tmp();
    const doc = path.join(docsDir, "plan.md");
    fs.writeFileSync(doc, "# Plan\n");
    createDocMeta({ dir: tmp() }).write(doc, "comments", { threads: [] });
    expect(fs.readdirSync(docsDir)).toEqual(["plan.md"]);
  });

  it("writes atomically: a failed write leaves the previous record and no temp file", () => {
    const userData = tmp();
    const doc = path.join(tmp(), "a.md");
    const store = createDocMeta({ dir: userData });
    store.write(doc, "comments", { n: 1 });
    // A filesystem whose rename fails after the temp file is written.
    const failing = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error("disk gone"), { code: "EIO" });
      },
    };
    const broken = createDocMeta({ dir: userData, fs: failing });
    expect(() => broken.write(doc, "comments", { n: 2 })).toThrow(/disk gone/);
    expect(store.read(doc, "comments")).toEqual({ n: 1 });
    expect(fs.readdirSync(store.dirFor(doc)).filter((f: string) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a record kind that could escape its folder", () => {
    const store = createDocMeta({ dir: tmp() });
    expect(() => store.write("/x/a.md", "../evil", {})).toThrow();
    expect(() => store.read("/x/a.md", "a/b")).toThrow();
  });

  it("carries records along when Markie renames a file", () => {
    const store = createDocMeta({ dir: tmp() });
    const from = path.join(tmp(), "old.md");
    const to = path.join(path.dirname(from), "new.md");
    store.write(from, "comments", { threads: ["x"] });
    expect(store.move(from, to)).toBe(1);
    expect(store.read(from, "comments")).toBeNull();
    expect(store.read(to, "comments")).toEqual({ threads: ["x"] });
    expect(JSON.parse(fs.readFileSync(path.join(store.dirFor(to), "doc.json"), "utf8")).path).toBe(path.resolve(to));
  });

  it("carries every document under a moved folder", () => {
    const store = createDocMeta({ dir: tmp() });
    const root = tmp();
    const a = path.join(root, "proj", "a.md");
    const b = path.join(root, "proj", "deep", "b.md");
    const other = path.join(root, "projector.md"); // shares a prefix, not a parent
    store.write(a, "comments", { a: 1 });
    store.write(b, "comments", { b: 1 });
    store.write(other, "comments", { o: 1 });
    expect(store.move(path.join(root, "proj"), path.join(root, "archive", "proj"))).toBe(2);
    expect(store.read(path.join(root, "archive", "proj", "a.md"), "comments")).toEqual({ a: 1 });
    expect(store.read(path.join(root, "archive", "proj", "deep", "b.md"), "comments")).toEqual({ b: 1 });
    expect(store.read(other, "comments")).toEqual({ o: 1 });
  });

  it("sets aside, never overwrites, records already at the destination", () => {
    const store = createDocMeta({ dir: tmp() });
    const root = tmp();
    const from = path.join(root, "a.md");
    const to = path.join(root, "b.md");
    store.write(from, "comments", { from: true });
    store.write(to, "comments", { to: true });
    store.move(from, to);
    expect(store.read(to, "comments")).toEqual({ from: true });
    const kept = fs.readdirSync(store.root).filter((n: string) => n.includes(".replaced-"));
    expect(kept).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(store.root, kept[0], "comments.json"), "utf8"))).toEqual({ to: true });
  });

  it("leaves a record alone when its file disappears outside Markie", () => {
    const store = createDocMeta({ dir: tmp() });
    const doc = path.join(tmp(), "gone.md");
    store.write(doc, "comments", { threads: [1] });
    // Nothing in the store reacts to a missing file; the record and the path
    // it names are still there for a later reattach.
    expect(store.all()).toEqual([{ folder: store.dirFor(doc), path: path.resolve(doc) }]);
    expect(store.move(path.join(tmp(), "unrelated.md"), path.join(tmp(), "x.md"))).toBe(0);
    expect(store.read(doc, "comments")).toEqual({ threads: [1] });
  });
});
