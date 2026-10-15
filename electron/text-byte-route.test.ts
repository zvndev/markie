import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const load = createRequire(import.meta.url);
const { readDocumentTiered } = load("./doc-tiers.js");
const { writeFileAtomic } = load("./atomic-write.js");
const { hasUtf16Bom, needsBytePreservingText } = load("./text-byte-route.js");
const { createFileGrants } = load("./file-grants.js");
const { createDocumentFileService } = load("./document-files.cjs");
const folders: string[] = [];
function fixture(name: string, bytes: Buffer) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "markie-encoding-route-"));
  folders.push(folder);
  const target = path.join(folder, name);
  fs.writeFileSync(target, bytes);
  return target;
}
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });

describe("classic UTF-8 reader encoding boundary", () => {
  it("reproduces why UTF-16 BOM text must bypass the classic UTF-8 save path", () => {
    const original = Buffer.concat([Buffer.from([255, 254]), Buffer.from("Café\r\n", "utf16le")]);
    const target = fixture("synthetic.txt", original);
    const loaded = readDocumentTiered(target);
    expect(loaded.content).not.toBe("Café\r\n");
    expect(loaded.content).toContain("\uFFFD");
    writeFileAtomic(target, loaded.content, { platform: "linux" });
    expect(fs.readFileSync(target)).not.toEqual(original);
  });

  it.each(["le", "be"])("detects a UTF-16%s BOM using only a bounded prefix", (order) => {
    const content = Buffer.from("Café\r\n", "utf16le");
    if (order === "be") content.swap16();
    const target = fixture("synthetic.txt", Buffer.concat([Buffer.from(order === "le" ? [255, 254] : [254, 255]), content]));
    const readSync = vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number) => fs.readSync(fd, buffer, offset, length, position));
    const closeSync = vi.fn(fs.closeSync);
    expect(hasUtf16Bom(target, { ...fs, readSync, closeSync })).toBe(true);
    expect(readSync).toHaveBeenCalledOnce();
    expect(readSync.mock.calls[0][3]).toBe(2);
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it.each([Buffer.alloc(0), Buffer.from([255]), Buffer.from("# Café\r\n", "utf8"), Buffer.from([239, 187, 191, 65])])("keeps non-UTF-16 text on the existing path (%j)", (bytes) => {
    expect(hasUtf16Bom(fixture("normal.md", bytes))).toBe(false);
  });
});

describe("authorized classic entry routes UTF-16 to opaque byte grants", () => {
  function reader() {
    const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const start = source.indexOf("function readFilePayload(");
    const end = source.indexOf("// File passed as a CLI argument", start);
    const fileGrants = createFileGrants(), queueNativeDocumentOpen = vi.fn(() => true);
    const readDocumentTiered = vi.fn(load("./doc-tiers.js").readDocumentTiered);
    const remember = vi.fn(), setCurrentDoc = vi.fn();
    const read = runInNewContext(`(${source.slice(start, end).trim()})`, {
      fileGrants, path, hasUtf16Bom, needsBytePreservingText, queueNativeDocumentOpen,
      docTiers: { readDocumentTiered }, diskMemory: { remember }, setCurrentDoc, registry: { track: vi.fn() },
    }) as (target: string, options?: { grant?: boolean }) => unknown;
    return { read, queueNativeDocumentOpen, readDocumentTiered, remember, setCurrentDoc };
  }

  it.each(["txt", "md", "csv"])("does not decode, track or modify an authorized UTF-16 .%s source", async (extension) => {
    const original = Buffer.concat([Buffer.from([255, 254]), Buffer.from("Café\r\n", "utf16le")]);
    const target = fixture(`synthetic.${extension}`, original), f = reader();
    expect(f.read(target, { grant: true })).toBeNull();
    expect(f.queueNativeDocumentOpen).toHaveBeenCalledExactlyOnceWith(fs.realpathSync(target), { includeClassic: true });
    expect(f.readDocumentTiered).not.toHaveBeenCalled(); expect(f.remember).not.toHaveBeenCalled(); expect(f.setCurrentDoc).not.toHaveBeenCalled();
    const files = createDocumentFileService({ dialog: {}, platform: "linux" });
    expect(files.queueOsFile(target, { includeClassic: true }).ok).toBe(true);
    const initial = await files.takeInitial(1); expect(initial.ok).toBe(true);
    const read = await files.read(1, { leaseId: initial.value.leaseId });
    expect(read.ok).toBe(true); expect(read.value.bytes).toEqual(new Uint8Array(original));
    const saved = await files.write(1, { leaseId: initial.value.leaseId, baseRevision: read.value.descriptor.revision, bytes: read.value.bytes });
    expect(saved.ok).toBe(true); expect(fs.readFileSync(target)).toEqual(original);
  });

  it("preserves the classic UTF-8 Markdown payload and does not queue it", () => {
    const target = fixture("normal.md", Buffer.from("# Café\r\n", "utf8")), f = reader();
    expect(f.read(target, { grant: true })).toMatchObject({ name: "normal.md", content: "# Café\r\n", path: fs.realpathSync(target) });
    expect(f.queueNativeDocumentOpen).not.toHaveBeenCalled(); expect(f.readDocumentTiered).toHaveBeenCalledOnce();
    expect(f.remember).toHaveBeenCalledWith(fs.realpathSync(target), "# Café\r\n");
  });

  it("does not inspect or queue a path without a classic file grant", () => {
    const target = fixture("unauthorized.txt", Buffer.from([255, 254, 65, 0])), f = reader();
    expect(f.read(target)).toBeNull();
    expect(f.queueNativeDocumentOpen).not.toHaveBeenCalled(); expect(f.readDocumentTiered).not.toHaveBeenCalled();
  });

  it.each(["txt", "text", "log"])("preserves UTF-8 BOM and Windows or classic Mac newlines in literal .%s files", async (extension) => {
    for (const text of ["Café\r\nNext\r\n", "Café\rNext\r", "\uFEFFCafé\nNext\n"]) {
      const original = Buffer.from(text, "utf8"), target = fixture(`literal.${extension}`, original), f = reader();
      expect(f.read(target, { grant: true })).toBeNull();
      expect(f.queueNativeDocumentOpen).toHaveBeenCalledExactlyOnceWith(fs.realpathSync(target), { includeClassic: true });
      expect(f.remember).not.toHaveBeenCalled(); expect(f.setCurrentDoc).not.toHaveBeenCalled();
      const files = createDocumentFileService({ dialog: {}, platform: "linux" });
      expect(files.queueOsFile(target, { includeClassic: true }).ok).toBe(true);
      const initial = await files.takeInitial(1), read = await files.read(1, { leaseId: initial.value.leaseId });
      expect(read.ok).toBe(true); expect(read.value.bytes).toEqual(new Uint8Array(original));
      expect((await files.write(1, { leaseId: initial.value.leaseId, baseRevision: read.value.descriptor.revision, bytes: read.value.bytes })).ok).toBe(true);
      expect(fs.readFileSync(target)).toEqual(original);
    }
  });

  it.each(["txt", "text", "log"])("keeps ordinary UTF-8 LF .%s files on the classic path", (extension) => {
    const text = "Café\nNext\n", target = fixture(`literal.${extension}`, Buffer.from(text, "utf8")), f = reader();
    expect(f.read(target, { grant: true })).toMatchObject({ content: text, path: fs.realpathSync(target) });
    expect(f.queueNativeDocumentOpen).not.toHaveBeenCalled();
  });

  it.each(["md", "markdown", "mdx", "csv"])("does not change UTF-8 BOM or CRLF semantics for .%s", (extension) => {
    const text = "\uFEFFCafé\r\nNext\r\n", target = fixture(`classic.${extension}`, Buffer.from(text, "utf8")), f = reader();
    expect(f.read(target, { grant: true })).toMatchObject({ content: text, path: fs.realpathSync(target) });
    expect(f.queueNativeDocumentOpen).not.toHaveBeenCalled();
  });
});
