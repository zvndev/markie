import { describe, expect, it, vi } from "vitest";
import {
  LARGE_DOC_BYTES,
  MAX_DOC_BYTES,
  readDocumentTiered,
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

  it("refuses a file over the cap without reading it", () => {
    const io = {
      statSync: vi.fn(() => ({ size: 143_000_000 })),
      readFileSync: vi.fn(() => {
        throw new Error("must not read");
      }),
    };
    expect(readDocumentTiered("/big/file.md", io)).toEqual({ tooLarge: true, size: 143_000_000 });
    expect(io.readFileSync).not.toHaveBeenCalled();
  });

  it("reads and flags a large file", () => {
    const io = {
      statSync: vi.fn(() => ({ size: 4_400_000 })),
      readFileSync: vi.fn(() => "# big\n"),
    };
    expect(readDocumentTiered("/big/file.md", io)).toEqual({
      content: "# big\n",
      size: 4_400_000,
      large: true,
    });
    expect(io.readFileSync).toHaveBeenCalledWith("/big/file.md", "utf-8");
  });

  it("reads an ordinary file and says it is not large", () => {
    const io = {
      statSync: vi.fn(() => ({ size: 12 })),
      readFileSync: vi.fn(() => "# small\n"),
    };
    expect(readDocumentTiered("/notes.md", io)).toEqual({ content: "# small\n", size: 12, large: false });
  });

  it("lets a stat failure through as the read failure it is", () => {
    const io = {
      statSync: vi.fn(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      readFileSync: vi.fn(),
    };
    expect(() => readDocumentTiered("/gone.md", io)).toThrow("ENOENT");
  });
});
