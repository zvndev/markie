import { describe, expect, it } from "vitest";
import { MAX_DOC_BYTES } from "./doc-tiers.js";
const { createDiskMemory } = require("./disk-memory.js");

// A disk in memory: the bytes and mtime of each path, behind the io shape the
// memory reads through. No test here needs a real 100 MB file.
interface Entry {
  bytes: Buffer;
  mtimeMs: number;
}

function fakeDisk(files: Record<string, Entry>) {
  const handles = new Map<number, string>();
  const positions = new Map<number, number>();
  let nextFd = 3;
  const entry = (p: string) => {
    const f = files[p];
    if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return f;
  };
  return {
    files,
    statSync: (p: string) => {
      const f = entry(p);
      return { size: f.bytes.length, mtimeMs: f.mtimeMs };
    },
    openSync: (p: string) => {
      entry(p);
      handles.set(nextFd, p);
      positions.set(nextFd, 0);
      return nextFd++;
    },
    fstatSync: (fd: number) => ({ size: entry(handles.get(fd)!).bytes.length }),
    // Sequential reads from the descriptor, the way fs.readSync serves them.
    readSync: (fd: number, buf: Buffer, offset: number, length: number) => {
      const src = entry(handles.get(fd)!).bytes;
      const at = positions.get(fd) ?? 0;
      const n = src.copy(buf, offset, at, Math.min(src.length, at + length));
      positions.set(fd, at + n);
      return n;
    },
    closeSync: (fd: number) => {
      handles.delete(fd);
      positions.delete(fd);
    },
  };
}

const file = (text: string, mtimeMs: number): Entry => ({ bytes: Buffer.from(text, "utf-8"), mtimeMs });

// One buffer at the cap, shared: the cap is inclusive, and a 100 MB string
// per test would be the slow part.
const OVER_CAP = "x".repeat(MAX_DOC_BYTES);

describe("what Markie last saw on disk", () => {
  it("has nothing to say about a file it never read or wrote", () => {
    const disk = fakeDisk({ "/a.md": file("hello\n", 1) });
    const memory = createDiskMemory({ io: disk });
    expect(memory.changedSince("/a.md")).toBeNull();
  });

  it("hands back the newer text and size when something else rewrote the file", () => {
    const disk = fakeDisk({ "/a.md": file("hello\n", 1) });
    const memory = createDiskMemory({ io: disk });
    memory.remember("/a.md", "hello\n");
    disk.files["/a.md"] = file("hello, agent\n", 2);
    expect(memory.changedSince("/a.md")).toEqual({ content: "hello, agent\n", size: 13 });
  });

  it("sees nothing in a touch or a no-op rewrite", () => {
    const disk = fakeDisk({ "/a.md": file("hello\n", 1) });
    const memory = createDiskMemory({ io: disk });
    memory.remember("/a.md", "hello\n");
    disk.files["/a.md"] = file("hello\n", 2);
    expect(memory.changedSince("/a.md")).toBeNull();
  });

  it("says nothing for a file that is gone; the write reports that itself", () => {
    const disk = fakeDisk({ "/a.md": file("hello\n", 1) });
    const memory = createDiskMemory({ io: disk });
    memory.remember("/a.md", "hello\n");
    delete disk.files["/a.md"];
    expect(memory.changedSince("/a.md")).toBeNull();
    expect(memory.overCapOnDisk("/a.md")).toBeNull();
  });

  it("keeps the paths it saw most recently and forgets the oldest past the limit", () => {
    const disk = fakeDisk({ "/a.md": file("a", 1), "/b.md": file("b", 1), "/c.md": file("c", 1) });
    const memory = createDiskMemory({ io: disk, limit: 2 });
    memory.remember("/a.md", "a");
    memory.remember("/b.md", "b");
    memory.remember("/a.md", "a"); // seen again: newest now
    memory.remember("/c.md", "c"); // evicts /b.md, the least recently seen
    disk.files["/a.md"] = file("a2", 2);
    disk.files["/b.md"] = file("b2", 2);
    expect(memory.changedSince("/a.md")).toEqual({ content: "a2", size: 2 });
    expect(memory.changedSince("/b.md")).toBeNull();
  });

  describe("a file over the cap", () => {
    it("is not a change when it is Markie's own write: the poll is silent, the next save is accepted, and it re-records", () => {
      // Markie wrote a buffer edited past the cap (the renderer allows the
      // save), then recorded its own write with the file's stat.
      const disk = fakeDisk({ "/big.md": file(OVER_CAP, 1000) });
      const memory = createDiskMemory({ io: disk });
      memory.remember("/big.md", OVER_CAP, { ownWrite: true });

      // The watcher's next poll: nothing to report.
      expect(memory.changedSince("/big.md")).toBeNull();
      // The next save, whichever gate it goes through: accepted.
      expect(memory.overCapOnDisk("/big.md")).toBeNull();

      // That save wrote a longer file; recorded again, it is still ours.
      const longer = OVER_CAP + "more\n";
      disk.files["/big.md"] = file(longer, 2000);
      memory.remember("/big.md", longer, { ownWrite: true });
      expect(memory.changedSince("/big.md")).toBeNull();
      expect(memory.overCapOnDisk("/big.md")).toBeNull();
    });

    it("is refused when something else appended to Markie's write (size and mtime both moved)", () => {
      const disk = fakeDisk({ "/big.md": file(OVER_CAP, 1000) });
      const memory = createDiskMemory({ io: disk });
      memory.remember("/big.md", OVER_CAP, { ownWrite: true });
      disk.files["/big.md"] = file(OVER_CAP + "agent\n", 2000);
      expect(memory.changedSince("/big.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES + 6 });
      expect(memory.overCapOnDisk("/big.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES + 6 });
    });

    it("is refused after a same-size rewrite by something else, caught by the mtime", () => {
      const disk = fakeDisk({ "/big.md": file(OVER_CAP, 1000) });
      const memory = createDiskMemory({ io: disk });
      memory.remember("/big.md", OVER_CAP, { ownWrite: true });
      disk.files["/big.md"] = { bytes: disk.files["/big.md"].bytes, mtimeMs: 1001 };
      expect(memory.changedSince("/big.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES });
      expect(memory.overCapOnDisk("/big.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES });
    });

    it("is refused after a same-mtime rewrite of another size", () => {
      const disk = fakeDisk({ "/big.md": file(OVER_CAP, 1000) });
      const memory = createDiskMemory({ io: disk });
      memory.remember("/big.md", OVER_CAP, { ownWrite: true });
      disk.files["/big.md"] = file(OVER_CAP + "!", 1000);
      expect(memory.changedSince("/big.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES + 1 });
    });

    it("is refused when Markie only read the file before it grew: a read is never stamped", () => {
      const disk = fakeDisk({ "/a.md": file("small\n", 1) });
      const memory = createDiskMemory({ io: disk });
      memory.remember("/a.md", "small\n");
      disk.files["/a.md"] = file(OVER_CAP, 1);
      expect(memory.changedSince("/a.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES });
      expect(memory.overCapOnDisk("/a.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES });
    });

    it("is refused when the own write could not be stamped", () => {
      // The stat after the write failed (the file vanished for a moment);
      // without a stamp the file is like any other over the cap.
      const disk = fakeDisk({});
      const memory = createDiskMemory({ io: disk });
      memory.remember("/big.md", OVER_CAP, { ownWrite: true });
      disk.files["/big.md"] = file(OVER_CAP, 1000);
      expect(memory.changedSince("/big.md")).toEqual({ tooLarge: true, size: MAX_DOC_BYTES });
    });
  });
});
