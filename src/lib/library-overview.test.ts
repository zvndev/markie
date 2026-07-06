import { describe, expect, it } from "vitest";
import type { LibraryItem } from "./electron";
import {
  libraryItemNeedsAttention,
  organizeLibraryItems,
  summarizeLibrary,
} from "./library-overview";

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

  it("organizes library groups by attention, recency, then natural name", () => {
    const organized = organizeLibraryItems([
      item({
        path: "/docs/note-10.md",
        name: "note-10.md",
        lastOpenedAt: "2026-07-04T08:00:00.000Z",
      }),
      item({
        path: "/docs/note-2.md",
        name: "note-2.md",
        lastOpenedAt: "2026-07-04T08:00:00.000Z",
      }),
      item({
        path: "/docs/recent.md",
        name: "recent.md",
        lastOpenedAt: "2026-07-05T08:00:00.000Z",
      }),
      item({
        path: "/docs/missing.md",
        name: "missing.md",
        exists: false,
        lastOpenedAt: "2026-07-01T08:00:00.000Z",
      }),
      item({
        path: "/docs/behind.md",
        name: "behind.md",
        state: "behind",
        lastOpenedAt: "2026-07-02T08:00:00.000Z",
      }),
      item({
        path: "/docs/conflict.md",
        name: "conflict.md",
        state: "conflict",
        lastOpenedAt: "2026-07-03T08:00:00.000Z",
      }),
    ]);

    expect(organized.localFiles.map((entry) => entry.name)).toEqual([
      "conflict.md",
      "behind.md",
      "missing.md",
      "recent.md",
      "note-2.md",
      "note-10.md",
    ]);
  });

  it("separates local, personal cloud, and shared documents", () => {
    const organized = organizeLibraryItems([
      item({ path: "/docs/local.md", name: "local.md" }),
      item({
        kind: "cloud-only",
        path: null,
        name: "cloud.md",
        state: "cloud-only",
        cloudId: "doc-cloud",
        exists: false,
      }),
      item({
        kind: "shared",
        path: null,
        name: "shared.md",
        state: "cloud-only",
        cloudId: "doc-shared",
        exists: false,
        shared: true,
        role: "viewer",
      }),
      item({
        path: "/docs/shared-local.md",
        name: "shared-local.md",
        state: "synced",
        cloudId: "doc-shared-local",
        shared: true,
        role: "editor",
      }),
    ]);

    expect(organized.localFiles.map((entry) => entry.name)).toEqual([
      "local.md",
      "shared-local.md",
    ]);
    expect(organized.myCloudOnly.map((entry) => entry.name)).toEqual(["cloud.md"]);
    expect(organized.sharedItems.map((entry) => entry.name)).toEqual([
      "shared-local.md",
      "shared.md",
    ]);
  });

  it("detects library items that need user attention", () => {
    expect(libraryItemNeedsAttention(item({ state: "conflict" }))).toBe(true);
    expect(libraryItemNeedsAttention(item({ state: "behind" }))).toBe(true);
    expect(libraryItemNeedsAttention(item({ exists: false }))).toBe(true);
    expect(libraryItemNeedsAttention(item({ state: "synced" }))).toBe(false);
  });
});
