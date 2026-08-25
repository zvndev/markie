import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CommonJS main-process module: load it the way main.js does.
const load = createRequire(import.meta.url);
const { writeFileAtomic, tempPathFor } = load("./atomic-write.js");

interface SpawnCall {
  cmd: string;
  args: string[];
}

interface SpawnResult {
  status: number;
  stdout: string;
  error?: Error;
}

// A stand-in for child_process.spawnSync that answers the two xattr questions
// the module asks: "which attributes does this file have" and "what is the
// value of this one".
function fakeXattr(
  attrs: Record<string, string>,
  calls: SpawnCall[]
): (cmd: string, args: string[]) => SpawnResult {
  return (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "-p" && args[1] === "-x") {
      const value = attrs[args[3]];
      if (value === undefined) return { status: 1, stdout: "" };
      return { status: 0, stdout: value };
    }
    if (args[0] === "-w") return { status: 0, stdout: "" };
    return { status: 0, stdout: Object.keys(attrs).join("\n") };
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-atomic-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tempPathFor", () => {
  it("stays in the original's directory so the rename is a rename", () => {
    const target = path.join(dir, "notes.md");
    const tmp = tempPathFor(target, path);
    expect(path.dirname(tmp)).toBe(dir);
    expect(path.basename(tmp).startsWith("notes.md")).toBe(true);
    expect(tmp).not.toBe(target);
  });

  it("never hands two writes the same name", () => {
    const target = path.join(dir, "notes.md");
    const names = new Set(
      Array.from({ length: 50 }, () => tempPathFor(target, path))
    );
    expect(names.size).toBe(50);
  });
});

describe("writeFileAtomic", () => {
  it("writes the file and leaves no temp behind", () => {
    const target = path.join(dir, "notes.md");
    writeFileAtomic(target, "hello\n", { platform: "linux" });
    expect(fs.readFileSync(target, "utf-8")).toBe("hello\n");
    expect(fs.readdirSync(dir)).toEqual(["notes.md"]);
  });

  it("replaces existing content", () => {
    const target = path.join(dir, "notes.md");
    fs.writeFileSync(target, "old\n", "utf-8");
    writeFileAtomic(target, "new\n", { platform: "linux" });
    expect(fs.readFileSync(target, "utf-8")).toBe("new\n");
    expect(fs.readdirSync(dir)).toEqual(["notes.md"]);
  });

  it("keeps the original's permission bits", () => {
    const target = path.join(dir, "private.md");
    fs.writeFileSync(target, "old\n", { encoding: "utf-8", mode: 0o600 });
    writeFileAtomic(target, "new\n", { platform: "linux" });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("leaves the original intact when the write fails", () => {
    const target = path.join(dir, "notes.md");
    fs.writeFileSync(target, "the only copy\n", "utf-8");
    const fakeFs = {
      ...fs,
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
    };
    expect(() =>
      writeFileAtomic(target, "new\n", { fs: fakeFs, platform: "linux" })
    ).toThrow("ENOSPC");
    expect(fs.readFileSync(target, "utf-8")).toBe("the only copy\n");
    expect(fs.readdirSync(dir)).toEqual(["notes.md"]);
  });

  it("removes the temp file when the rename fails", () => {
    const target = path.join(dir, "notes.md");
    fs.writeFileSync(target, "old\n", "utf-8");
    const fakeFs = {
      ...fs,
      renameSync: () => {
        throw new Error("EXDEV");
      },
    };
    expect(() =>
      writeFileAtomic(target, "new\n", { fs: fakeFs, platform: "linux" })
    ).toThrow("EXDEV");
    expect(fs.readFileSync(target, "utf-8")).toBe("old\n");
    expect(fs.readdirSync(dir)).toEqual(["notes.md"]);
  });

  it("fsyncs the temp file before renaming it", () => {
    const target = path.join(dir, "notes.md");
    const order: string[] = [];
    const fakeFs = {
      ...fs,
      writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        order.push("write");
        return fs.writeFileSync(...args);
      },
      fsyncSync: (fd: number) => {
        order.push("fsync");
        return fs.fsyncSync(fd);
      },
      renameSync: (...args: Parameters<typeof fs.renameSync>) => {
        order.push("rename");
        return fs.renameSync(...args);
      },
    };
    writeFileAtomic(target, "hello\n", { fs: fakeFs, platform: "linux" });
    // Two fsyncs: the temp file's data before the rename, the directory after
    // it — a power loss must not lose the rename either.
    expect(order).toEqual(["write", "fsync", "rename", "fsync"]);
  });

  it("skips the directory fsync on win32, which has none", () => {
    const target = path.join(dir, "notes.md");
    const order: string[] = [];
    const fakeFs = {
      ...fs,
      fsyncSync: (fd: number) => {
        order.push("fsync");
        return fs.fsyncSync(fd);
      },
      renameSync: (...args: Parameters<typeof fs.renameSync>) => {
        order.push("rename");
        return fs.renameSync(...args);
      },
    };
    writeFileAtomic(target, "hello\n", { fs: fakeFs, platform: "win32" });
    expect(order).toEqual(["fsync", "rename"]);
  });

  it("names the real file and folder when the folder refuses the write", () => {
    const target = path.join(dir, "notes.md");
    fs.writeFileSync(target, "the only copy\n", "utf-8");
    const denied = Object.assign(new Error("EACCES: permission denied, open '/x/y.tmp'"), {
      code: "EACCES",
    });
    const fakeFs = {
      ...fs,
      writeFileSync: () => {
        throw denied;
      },
    };
    let caught: unknown;
    try {
      writeFileAtomic(target, "new\n", { fs: fakeFs, platform: "linux" });
    } catch (err) {
      caught = err;
    }
    const e = caught as (Error & { code?: string }) | undefined;
    // The person saving has never heard of the temp file. The message must
    // name what they were saving and where.
    expect(e?.message).toContain("notes.md");
    expect(e?.message).toContain(dir);
    expect(e?.message).not.toContain(".tmp");
    expect(e?.code).toBe("EACCES");
    expect(fs.readFileSync(target, "utf-8")).toBe("the only copy\n");
  });

  it("carries macOS extended attributes across the rename", () => {
    const target = path.join(dir, "tagged.md");
    fs.writeFileSync(target, "old\n", "utf-8");
    const calls: SpawnCall[] = [];
    writeFileAtomic(target, "new\n", {
      platform: "darwin",
      spawn: fakeXattr({ "com.apple.metadata:_kMDItemUserTags": "62 70 6c" }, calls),
    });

    const written = calls.filter((c) => c.args[0] === "-w");
    expect(written).toHaveLength(1);
    expect(written[0].args).toEqual([
      "-w",
      "-x",
      "com.apple.metadata:_kMDItemUserTags",
      "62706c",
      // restored on the temp file, before it becomes the document
      expect.stringContaining("tagged.md.markie-"),
    ]);
    expect(fs.readFileSync(target, "utf-8")).toBe("new\n");
  });

  it("does not shell out on other platforms", () => {
    const target = path.join(dir, "notes.md");
    fs.writeFileSync(target, "old\n", "utf-8");
    const calls: SpawnCall[] = [];
    writeFileAtomic(target, "new\n", {
      platform: "win32",
      spawn: fakeXattr({ tag: "00" }, calls),
    });
    expect(calls).toEqual([]);
  });

  it("still writes when xattr is unavailable", () => {
    const target = path.join(dir, "notes.md");
    fs.writeFileSync(target, "old\n", "utf-8");
    writeFileAtomic(target, "new\n", {
      platform: "darwin",
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(fs.readFileSync(target, "utf-8")).toBe("new\n");
  });

  it("writes through a symlink instead of replacing it", () => {
    const real = path.join(dir, "real.md");
    const link = path.join(dir, "link.md");
    fs.writeFileSync(real, "old\n", "utf-8");
    fs.symlinkSync(real, link);
    writeFileAtomic(link, "new\n", { platform: "linux" });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf-8")).toBe("new\n");
  });
});
