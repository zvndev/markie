import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LARGE_DOC_BYTES,
  MAX_DOC_BYTES,
  formatMegabytes,
  readDocumentTiered,
  statDocument,
  tierForSize,
} from "./doc-tiers.js";
import * as rendererTiers from "../src/lib/doc-tiers";

describe("document size tiers", () => {
  it("draws the two lines at 1 MB and 100 MB, inclusive", () => {
    expect(tierForSize(0)).toBe("ok");
    expect(tierForSize(LARGE_DOC_BYTES - 1)).toBe("ok");
    expect(tierForSize(LARGE_DOC_BYTES)).toBe("large");
    expect(tierForSize(MAX_DOC_BYTES - 1)).toBe("large");
    expect(tierForSize(MAX_DOC_BYTES)).toBe("tooLarge");
    expect(tierForSize(Number.NaN)).toBe("ok");
  });

  it("keeps the renderer's copy of the constants in step", () => {
    expect(rendererTiers.LARGE_DOC_BYTES).toBe(LARGE_DOC_BYTES);
    expect(rendererTiers.MAX_DOC_BYTES).toBe(MAX_DOC_BYTES);
  });

  it("draws the same lines and formats the same sizes as the renderer", () => {
    for (const size of [0, LARGE_DOC_BYTES - 1, LARGE_DOC_BYTES, MAX_DOC_BYTES - 1, MAX_DOC_BYTES, -1, Number.NaN]) {
      expect(rendererTiers.tierForSize(size)).toBe(tierForSize(size));
    }
    for (const size of [1_000_000, 4_400_000, 9_950_000, 143_000_000]) {
      expect(rendererTiers.formatMegabytes(size)).toBe(formatMegabytes(size));
    }
    expect(formatMegabytes(143_000_000)).toBe("143 MB");
  });

  it("measures text already in memory in UTF-8 bytes, like the stat would", () => {
    expect(rendererTiers.measureBytes("")).toBe(0);
    expect(rendererTiers.measureBytes("abc")).toBe(3);
    expect(rendererTiers.measureBytes("ü")).toBe(2);
    expect(rendererTiers.measureBytes("日本")).toBe(6);
    expect(rendererTiers.tierForSize(rendererTiers.measureBytes("ü".repeat(500_000)))).toBe("large");
  });

  // A fake descriptor: the read must come from the descriptor that was
  // measured, never from the path again.
  const fdIo = (size: number, bytes: string | Buffer) => ({
    openSync: vi.fn(() => 7),
    fstatSync: vi.fn(() => ({ size })),
    readFileSync: vi.fn(() => (typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : bytes)),
    closeSync: vi.fn(),
  });

  it("refuses a file over the cap without reading it, and still closes it", () => {
    const io = fdIo(143_000_000, "must not be read");
    expect(readDocumentTiered("/big/file.md", io)).toEqual({ tooLarge: true, size: 143_000_000 });
    expect(io.readFileSync).not.toHaveBeenCalled();
    expect(io.closeSync).toHaveBeenCalledWith(7);
  });

  it("reads and flags a large file through the descriptor it measured", () => {
    const io = fdIo(4_400_000, Buffer.alloc(4_400_000, "#"));
    expect(readDocumentTiered("/big/file.md", io)).toEqual({
      content: "#".repeat(4_400_000),
      size: 4_400_000,
      large: true,
    });
    expect(io.readFileSync).toHaveBeenCalledWith(7);
    expect(io.closeSync).toHaveBeenCalledWith(7);
  });

  it("reads an ordinary file and says it is not large", () => {
    const io = fdIo(8, "# small\n");
    expect(readDocumentTiered("/notes.md", io)).toEqual({ content: "# small\n", size: 8, large: false });
  });

  it("tiers the bytes it read, not the size it measured a moment earlier", () => {
    // Something appended in place between the stat and the read: the bytes
    // that came back are what the renderer would get, so they set the tier.
    const grownPastCap = fdIo(12, Buffer.alloc(143_000_000));
    expect(readDocumentTiered("/growing.md", grownPastCap)).toEqual({ tooLarge: true, size: 143_000_000 });
    expect(grownPastCap.closeSync).toHaveBeenCalledWith(7);

    const grownLarge = fdIo(12, Buffer.alloc(LARGE_DOC_BYTES, "x"));
    expect(readDocumentTiered("/growing.md", grownLarge)).toEqual({
      content: "x".repeat(LARGE_DOC_BYTES),
      size: LARGE_DOC_BYTES,
      large: true,
    });
  });

  it("reads the bytes of the file it measured, not whatever the path names by then", () => {
    // A real file, replaced by a rename between the measurement and the read.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-tiers-"));
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "first\n");
    const io = {
      ...fs,
      fstatSync: (fd: number) => {
        const st = fs.fstatSync(fd);
        fs.writeFileSync(path.join(dir, "other.md"), "second, and longer\n");
        fs.renameSync(path.join(dir, "other.md"), target);
        return st;
      },
    };
    expect(readDocumentTiered(target, io)).toEqual({ content: "first\n", size: 6, large: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers the tier from a stat alone", () => {
    const io = { statSync: vi.fn(() => ({ size: 143_000_000 })) };
    expect(statDocument("/big.md", io)).toEqual({ size: 143_000_000, tier: "tooLarge" });
    expect(statDocument("/big.md", { statSync: () => ({ size: 12 }) })).toEqual({ size: 12, tier: "ok" });
  });

  it("lets an open failure through as the read failure it is", () => {
    const io = {
      openSync: vi.fn(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      fstatSync: vi.fn(),
      readFileSync: vi.fn(),
      closeSync: vi.fn(),
    };
    expect(() => readDocumentTiered("/gone.md", io)).toThrow("ENOENT");
    expect(io.closeSync).not.toHaveBeenCalled();
  });
});
