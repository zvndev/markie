import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const load = createRequire(import.meta.url);
const { createSnapshots, slugFor, stampFor, DEFAULT_MAX_PER_FILE } =
  load("./snapshots.js");

let userData: string;
let docs: string;
let clock: number;

// Distinct, ordered timestamps without waiting a millisecond per save.
const tick = () => new Date(Date.UTC(2026, 7, 24, 12, 0, 0) + clock++ * 1000);

function makeDoc(name: string, content: string): string {
  const p = path.join(docs, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "markie-userdata-"));
  docs = fs.mkdtempSync(path.join(os.tmpdir(), "markie-docs-"));
  clock = 0;
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(docs, { recursive: true, force: true });
});

describe("slugFor", () => {
  it("keeps the basename and disambiguates by path", () => {
    const a = slugFor("/one/notes.md");
    const b = slugFor("/two/notes.md");
    expect(a.endsWith("-notes.md")).toBe(true);
    expect(b.endsWith("-notes.md")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.slice(0, 8)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable for the same absolute path", () => {
    expect(slugFor("/one/notes.md")).toBe(slugFor("/one/./notes.md"));
  });

  it("refuses characters a directory name cannot hold", () => {
    expect(slugFor("/one/we:ird/na*me.md")).not.toContain("*");
  });
});

describe("stampFor", () => {
  it("replaces the colons an ISO stamp cannot keep in a filename", () => {
    expect(stampFor(new Date("2026-08-24T12:30:05.123Z"))).toBe(
      "2026-08-24T12-30-05.123Z"
    );
  });
});

describe("capture", () => {
  it("stores the previous content, not the new one", () => {
    const snaps = createSnapshots({ dir: userData, now: tick });
    const doc = makeDoc("notes.md", "before\n");

    const res = snaps.capture(doc, "after\n");

    expect(res.ok).toBe(true);
    expect(fs.readFileSync(res.path, "utf-8")).toBe("before\n");
    expect(path.dirname(res.path)).toBe(snaps.dirFor(doc));
  });

  it("skips a file that does not exist yet, so Save As to a new name is free", () => {
    const snaps = createSnapshots({ dir: userData, now: tick });
    expect(snaps.capture(path.join(docs, "new.md"), "hello\n")).toEqual({
      skipped: "no-file",
    });
    expect(fs.existsSync(path.join(userData, "snapshots"))).toBe(false);
  });

  it("skips a save that changes nothing", () => {
    const snaps = createSnapshots({ dir: userData, now: tick });
    const doc = makeDoc("notes.md", "same\n");
    expect(snaps.capture(doc, "same\n")).toEqual({ skipped: "unchanged" });
    expect(snaps.list(doc)).toEqual([]);
  });

  it("suffixes the second snapshot when two saves share a millisecond", () => {
    const frozen = new Date("2026-08-24T12:00:00.000Z");
    const snaps = createSnapshots({ dir: userData, now: () => frozen });
    const doc = makeDoc("notes.md", "v1\n");

    const first = snaps.capture(doc, "v2\n");
    fs.writeFileSync(doc, "v2\n", "utf-8");
    const second = snaps.capture(doc, "v3\n");

    // Neither snapshot may be lost or overwritten.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.path).not.toBe(first.path);
    expect(second.path.endsWith("-2.md")).toBe(true);
    expect(fs.readFileSync(first.path, "utf-8")).toBe("v1\n");
    expect(fs.readFileSync(second.path, "utf-8")).toBe("v2\n");
  });

  it("keeps one snapshot per save, newest last", () => {
    const snaps = createSnapshots({ dir: userData, now: tick });
    const doc = makeDoc("notes.md", "v1\n");
    snaps.capture(doc, "v2\n");
    fs.writeFileSync(doc, "v2\n", "utf-8");
    snaps.capture(doc, "v3\n");

    const names = snaps.list(doc);
    expect(names).toHaveLength(2);
    const folder = snaps.dirFor(doc);
    expect(fs.readFileSync(path.join(folder, names[0]), "utf-8")).toBe("v1\n");
    expect(fs.readFileSync(path.join(folder, names[1]), "utf-8")).toBe("v2\n");
  });

  it("caps a single document at 20 and drops the oldest first", () => {
    const snaps = createSnapshots({ dir: userData, now: tick });
    const doc = makeDoc("notes.md", "v0\n");
    for (let i = 1; i <= 25; i++) {
      snaps.capture(doc, `v${i}\n`);
      fs.writeFileSync(doc, `v${i}\n`, "utf-8");
    }

    const names = snaps.list(doc);
    expect(names).toHaveLength(DEFAULT_MAX_PER_FILE);
    const folder = snaps.dirFor(doc);
    // v0..v4 pruned; the oldest survivor is what the 6th save replaced.
    expect(fs.readFileSync(path.join(folder, names[0]), "utf-8")).toBe("v5\n");
    expect(fs.readFileSync(path.join(folder, names[19]), "utf-8")).toBe("v24\n");
  });

  it("keeps separate documents in separate folders", () => {
    const snaps = createSnapshots({ dir: userData, now: tick });
    const a = makeDoc("a.md", "a1\n");
    const b = makeDoc("b.md", "b1\n");
    snaps.capture(a, "a2\n");
    snaps.capture(b, "b2\n");

    expect(snaps.list(a)).toHaveLength(1);
    expect(snaps.list(b)).toHaveLength(1);
    expect(snaps.dirFor(a)).not.toBe(snaps.dirFor(b));
  });

  it("prunes across documents once the total cap is passed", () => {
    const snaps = createSnapshots({ dir: userData, now: tick, maxTotalBytes: 40 });
    const a = makeDoc("a.md", "a".repeat(30));
    const b = makeDoc("b.md", "b".repeat(30));

    snaps.capture(a, "changed");
    snaps.capture(b, "changed");

    // 60 bytes over a 40-byte budget: the older document's snapshot goes.
    expect(snaps.list(a)).toEqual([]);
    expect(snaps.list(b)).toHaveLength(1);
  });

  it("reports a failed snapshot instead of throwing at the save", () => {
    const fakeFs = {
      ...fs,
      writeFileSync: () => {
        throw new Error("EACCES");
      },
    };
    const snaps = createSnapshots({ dir: userData, fs: fakeFs, now: tick });
    const doc = makeDoc("notes.md", "before\n");

    const res = snaps.capture(doc, "after\n");
    expect(res.ok).toBeUndefined();
    expect(res.skipped).toBe("write-failed");
    expect(res.error).toContain("EACCES");
  });

  it("has() answers the menu item's enabled state", () => {
    const snaps = createSnapshots({ dir: userData, now: tick });
    const doc = makeDoc("notes.md", "before\n");
    expect(snaps.has(doc)).toBe(false);
    snaps.capture(doc, "after\n");
    expect(snaps.has(doc)).toBe(true);
  });
});
