import { describe, expect, it } from "vitest";
import type { LibraryItem } from "./electron";
import { summarizeLibrary } from "./library-overview";

const item = (overrides: Partial<LibraryItem>): LibraryItem => ({
  kind: "local",
  path: "/docs/note.md",
  name: "note.md",
  cloudId: null,
  state: "local-only",
  lastOpenedAt: null,
  remoteVersion: null,
  exists: true,
  ...overrides,
});

describe("library overview", () => {
  it("summarizes local, synced, cloud, shared, and attention states", () => {
    expect(
      summarizeLibrary([
        item({ path: "/docs/local.md", name: "local.md", state: "local-only" }),
        item({ path: "/docs/synced.md", name: "synced.md", state: "synced", cloudId: "doc-1" }),
        item({ path: "/docs/behind.md", name: "behind.md", state: "behind", cloudId: "doc-2" }),
        item({ path: "/docs/conflict.md", name: "conflict.md", state: "conflict", cloudId: "doc-3" }),
        item({ path: "/docs/missing.md", name: "missing.md", exists: false }),
        item({
          kind: "cloud-only",
          path: null,
          name: "cloud.md",
          state: "cloud-only",
          cloudId: "doc-4",
          exists: false,
        }),
        item({
          kind: "shared",
          path: null,
          name: "shared.md",
          state: "cloud-only",
          cloudId: "doc-5",
          exists: false,
          shared: true,
          role: "viewer",
        }),
      ])
    ).toEqual({
      total: 7,
      onDevice: 4,
      synced: 1,
      shared: 1,
      cloudOnly: 2,
      missing: 1,
      needsAttention: 3,
    });
  });

  it("returns zeroes for an empty library", () => {
    expect(summarizeLibrary([])).toEqual({
      total: 0,
      onDevice: 0,
      synced: 0,
      shared: 0,
      cloudOnly: 0,
      missing: 0,
      needsAttention: 0,
    });
  });
});
