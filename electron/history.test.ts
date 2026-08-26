import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createHistory, planRetention } = require("./history.js");

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-26T12:00:00Z");
const entry = (ageMs: number, bytes = 100) => ({
  stamp: new Date(NOW - ageMs).toISOString().replace(/:/g, "-"),
  ms: NOW - ageMs,
  bytes,
});

describe("planRetention", () => {
  it("keeps everything from the last 24h", () => {
    const entries = [entry(1 * HOUR), entry(2 * HOUR), entry(23 * HOUR)];
    expect(planRetention(entries, NOW, {})).toEqual([]);
  });

  it("thins 1-7 day old versions to one per hour", () => {
    // All three inside one clock hour. Buckets are absolute hours, not offsets
    // from the newest entry, so a fixture that straddles :00 keeps two.
    const entries = [
      entry(2 * DAY + 5 * 60_000),
      entry(2 * DAY + 10 * 60_000),
      entry(2 * DAY + 15 * 60_000),
    ];
    const drop = planRetention(entries, NOW, { keepNewest: 0 });
    expect(drop).toHaveLength(2); // one survivor per hour bucket
  });

  it("keeps one per hour across hours, not one in total", () => {
    const entries = [
      entry(2 * DAY),
      entry(2 * DAY + 30 * 60_000),
      entry(2 * DAY + 90 * 60_000),
    ];
    const drop = planRetention(entries, NOW, { keepNewest: 0 });
    // 12:00, 11:30 and 10:30 are three different hours: nothing is thinned.
    expect(drop).toHaveLength(0);
  });

  it("thins 7-30 day old versions to one per day and drops older than 30d", () => {
    const entries = [entry(10 * DAY), entry(10 * DAY + 2 * HOUR), entry(40 * DAY)];
    const drop = planRetention(entries, NOW, { keepNewest: 0 });
    expect(drop).toHaveLength(2);
  });

  it("never drops below the newest-5 floor, whatever the age", () => {
    const entries = [
      entry(40 * DAY),
      entry(41 * DAY),
      entry(42 * DAY),
      entry(43 * DAY),
      entry(44 * DAY),
    ];
    expect(planRetention(entries, NOW, {})).toEqual([]);
  });

  it("enforces the per-file cap oldest-first", () => {
    const entries = Array.from({ length: 205 }, (_, i) => entry(i * 60_000));
    const drop = planRetention(entries, NOW, { maxPerFile: 200 });
    expect(drop).toHaveLength(5);
    // The five it dropped are the five oldest.
    const oldest = entries.slice(200).map((e) => e.stamp);
    expect(drop.sort()).toEqual(oldest.sort());
  });

  it("an unparseable stamp is not treated as ancient", () => {
    // Two saves inside one millisecond get a "-2" suffix. Reading that back as
    // epoch zero would silently prune a version that is seconds old.
    const twin = { ...entry(60_000), stamp: entry(60_000).stamp + "-2" };
    expect(planRetention([entry(60_000), twin], NOW, { keepNewest: 0 })).toEqual([]);
  });
});

describe("createHistory", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "markie-history-"));
  // Injected so two captures never collide inside one millisecond.
  const ticking = (startIso = "2026-08-26T12:00:00Z") => {
    let t = Date.parse(startIso);
    return () => new Date((t += 1000));
  };

  it("captures with authorship and lists newest first", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "v1");
    const h = createHistory({ dir, now: ticking() });
    expect(h.capture(target, "v2", { author: "user" }).ok).toBe(true);
    fs.writeFileSync(target, "v2");
    expect(h.capture(target, "v3", { author: "user" }).ok).toBe(true);
    const list = h.list(target);
    expect(list).toHaveLength(2);
    expect(list[0].author).toBe("user");
    expect(h.read(target, list[1].stamp)).toBe("v1");
    expect(h.read(target, list[0].stamp)).toBe("v2");
  });

  it("captureExternal records the disk content once per distinct content", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "agent wrote this");
    const h = createHistory({ dir, now: ticking() });
    expect(h.captureExternal(target).ok).toBe(true);
    expect(h.captureExternal(target).skipped).toBe("duplicate");
    expect(h.list(target)[0].author).toBe("external");
  });

  it("does not record a second version for content already at the top", () => {
    // The watcher sees an external edit and records it; the user then saves
    // over it. Without the dedupe that pair is two identical versions.
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "theirs");
    const h = createHistory({ dir, now: ticking() });
    h.captureExternal(target);
    expect(h.capture(target, "mine", { author: "user" }).skipped).toBe("duplicate");
    expect(h.list(target)).toHaveLength(1);
  });

  it("reads legacy snapshots (no meta) as author unknown", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "v1");
    const { createSnapshots } = require("./snapshots.js");
    createSnapshots({ dir }).capture(target, "v2"); // a pre-0.5.0 snapshot
    const h = createHistory({ dir });
    expect(h.list(target)[0].author).toBe("unknown");
  });

  it("has() answers for the revert menu without reading every version", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "v1");
    const h = createHistory({ dir, now: ticking() });
    expect(h.has(target)).toBe(false);
    h.capture(target, "v2", { author: "user" });
    expect(h.has(target)).toBe(true);
  });

  it("keeps far more than the old flat 20-per-file cap", () => {
    // Autosave commits a version per burst; twenty would be an afternoon.
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    const h = createHistory({ dir, now: ticking() });
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(target, `v${i}`);
      h.capture(target, `v${i + 1}`, { author: "user" });
    }
    expect(h.list(target).length).toBe(40);
  });

  it("enforces a global byte cap across every document", () => {
    const dir = tmp();
    const h = createHistory({ dir, now: ticking(), caps: { maxTotalBytes: 3000 } });
    const body = "x".repeat(1000);
    for (const name of ["a", "b", "c", "d", "e"]) {
      const target = path.join(dir, `${name}.md`);
      fs.writeFileSync(target, body + name);
      h.capture(target, "next", { author: "user" });
    }
    const total = fs
      .readdirSync(path.join(dir, "snapshots"))
      .flatMap((slug: string) => {
        const folder = path.join(dir, "snapshots", slug);
        return fs
          .readdirSync(folder)
          .filter((n: string) => n.endsWith(".md"))
          .map((n: string) => fs.statSync(path.join(folder, n)).size);
      })
      .reduce((a: number, b: number) => a + b, 0);
    expect(total).toBeLessThanOrEqual(3000);
    // The newest document survived; an older one was pruned to make room.
    expect(h.has(path.join(dir, "e.md"))).toBe(true);
    expect(h.has(path.join(dir, "a.md"))).toBe(false);
  });

  it("survives two captures inside one millisecond", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    const frozen = () => new Date(NOW);
    const h = createHistory({ dir, now: frozen });
    fs.writeFileSync(target, "v1");
    h.capture(target, "v2", { author: "user" });
    fs.writeFileSync(target, "v2");
    h.capture(target, "v3", { author: "user" });
    const list = h.list(target);
    expect(list).toHaveLength(2);
    // Both are dated, not silently stamped as epoch zero and pruned as ancient.
    for (const item of list) expect(Date.parse(item.iso)).toBe(NOW);
    expect(new Set(list.map((v: { stamp: string }) => h.read(target, v.stamp)))).toEqual(
      new Set(["v1", "v2"])
    );
  });
});
