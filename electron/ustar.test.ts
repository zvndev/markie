import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseTar } = require("./ustar.js") as {
  parseTar: (
    buffer: Buffer
  ) => { path: string; size: number; mode: number; type: string; data: Buffer }[];
};

// A header written by hand, for the shapes the system `tar` will not produce on
// request: a path that escapes the archive, and the GNU long-name escape.
function header(name: string, size: number, typeflag: string, mode = 0o644): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(mode.toString(8).padStart(7, "0") + "\0", 100, "utf8");
  block.write("0000000\0", 108, "utf8"); // uid
  block.write("0000000\0", 116, "utf8"); // gid
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  block.write("00000000000\0", 136, "utf8"); // mtime
  block.write("        ", 148, "utf8"); // checksum field, blank while summing
  block.write(typeflag, 156, "utf8");
  block.write("ustar\0", 257, "utf8");
  block.write("00", 263, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  return block;
}

function entry(name: string, body: string, typeflag = "0", mode = 0o644): Buffer {
  const data = Buffer.from(body, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([header(name, data.length, typeflag, mode), padded]);
}

const longRelative = path.join(
  "a-directory-with-a-deliberately-long-name",
  "and-another-one-just-as-long-so-the-path-is-over-a-hundred-characters",
  "deep-note.md"
);

describe("parseTar", () => {
  let tmp = "";
  let files: ReturnType<typeof parseTar> = [];

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "markie-ustar-"));
    const tree = path.join(tmp, "tree");
    fs.mkdirSync(path.join(tree, path.dirname(longRelative)), { recursive: true });
    fs.writeFileSync(path.join(tree, "SKILL.md"), "---\nname: demo\n---\n", "utf8");
    fs.writeFileSync(path.join(tree, longRelative), "deep\n", "utf8");
    fs.mkdirSync(path.join(tree, "scripts"));
    fs.writeFileSync(path.join(tree, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
    fs.chmodSync(path.join(tree, "scripts", "run.sh"), 0o755);
    fs.symlinkSync("SKILL.md", path.join(tree, "alias.md"));

    const archive = path.join(tmp, "tree.tar.gz");
    // COPYFILE_DISABLE keeps macOS's tar from adding an AppleDouble `._name`
    // sidecar beside every file, which is real archive content and would make
    // this assert the platform rather than the reader.
    execFileSync("tar", ["-czf", archive, "-C", tree, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    files = parseTar(zlib.gunzipSync(fs.readFileSync(archive)));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads every regular file out of a tarball the system tar wrote", () => {
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["SKILL.md", longRelative.split(path.sep).join("/"), "scripts/run.sh"].sort());
  });

  it("carries the file's bytes", () => {
    const skill = files.find((f) => f.path === "SKILL.md");
    expect(skill?.data.toString("utf8")).toBe("---\nname: demo\n---\n");
    expect(skill?.size).toBe(19);
  });

  it("keeps the executable bit, which is the whole reason mode is reported", () => {
    const script = files.find((f) => f.path === "scripts/run.sh");
    expect(script && script.mode & 0o111).toBeTruthy();
    expect(files.find((f) => f.path === "SKILL.md")!.mode & 0o111).toBe(0);
  });

  it("reads a path over 100 characters, however tar chose to encode it", () => {
    const deep = files.find((f) => f.path.endsWith("deep-note.md"));
    expect(deep?.path.length).toBeGreaterThan(100);
    expect(deep?.data.toString("utf8")).toBe("deep\n");
  });

  it("drops directories, symlinks and anything else that is not a file", () => {
    expect(files.some((f) => f.path === "alias.md")).toBe(false);
    expect(files.every((f) => f.type === "file")).toBe(true);
  });

  it("reads a GNU long name from its @LongLink entry", () => {
    const name = `${"n".repeat(120)}.md`;
    const archive = Buffer.concat([
      entry("././@LongLink", `${name}\0`, "L"),
      entry(name.slice(0, 100), "long\n"),
      Buffer.alloc(1024, 0),
    ]);
    const parsed = parseTar(archive);
    expect(parsed.map((f) => f.path)).toEqual([name]);
    expect(parsed[0].data.toString("utf8")).toBe("long\n");
  });

  it("reads a path out of a pax extended header", () => {
    const name = `pax/${"p".repeat(110)}.md`;
    const record = `${`path=${name}\n`.length + 4} path=${name}\n`;
    const archive = Buffer.concat([
      entry("PaxHeaders/0", record, "x"),
      entry("short.md", "pax\n"),
      Buffer.alloc(1024, 0),
    ]);
    expect(parseTar(archive).map((f) => f.path)).toEqual([name]);
  });

  it("refuses an entry that would write outside the archive", () => {
    const archive = Buffer.concat([
      entry("../escape.md", "no\n"),
      entry("nested/../../escape.md", "no\n"),
      entry("/etc/passwd", "no\n"),
      entry("C:/Windows/system.ini", "no\n"),
      entry("kept.md", "yes\n"),
      Buffer.alloc(1024, 0),
    ]);
    expect(parseTar(archive).map((f) => f.path)).toEqual(["kept.md"]);
  });

  it("stops at the end-of-archive blocks and answers for an empty buffer", () => {
    const archive = Buffer.concat([entry("one.md", "1\n"), Buffer.alloc(1024, 0), entry("after.md", "2\n")]);
    expect(parseTar(archive).map((f) => f.path)).toEqual(["one.md"]);
    expect(parseTar(Buffer.alloc(0))).toEqual([]);
  });
});
