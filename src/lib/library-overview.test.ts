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
  // Most fixtures are the account's own documents; the ones about ownership
  // say otherwise for themselves.
  owned: true,
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

  it("counts an unpushed doc as needing attention and not as synced", () => {
    expect(
      summarizeLibrary([
        item({ path: "/docs/synced.md", name: "synced.md", state: "synced", cloudId: "doc-1" }),
        item({ path: "/docs/unpushed.md", name: "unpushed.md", state: "unpushed", cloudId: "doc-2" }),
      ])
    ).toMatchObject({ total: 2, synced: 1, needsAttention: 1 });
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
    expect(organized.sharedCloudOnly.map((entry) => entry.name)).toEqual([
      "shared.md",
    ]);
  });

  it("keeps a file the cloud never heard of out of the synced group", () => {
    const organized = organizeLibraryItems([
      item({ path: "/docs/local.md", name: "local.md", state: "local-only" }),
      item({ path: "/docs/synced.md", name: "synced.md", state: "synced", cloudId: "c1" }),
      item({ path: "/docs/paused.md", name: "paused.md", state: "paused", cloudId: "c2" }),
      item({ path: "/docs/behind.md", name: "behind.md", state: "behind", cloudId: "c3" }),
      item({ path: "/docs/unpushed.md", name: "unpushed.md", state: "unpushed", cloudId: "c4" }),
      item({ path: "/docs/conflict.md", name: "conflict.md", state: "conflict", cloudId: "c5" }),
      item({
        kind: "cloud-only",
        path: null,
        name: "cloud.md",
        state: "cloud-only",
        cloudId: "c6",
        exists: false,
      }),
    ]);

    // Attention order, the same one the Library rows use.
    expect(organized.syncedFromDevice.map((entry) => entry.name)).toEqual([
      "unpushed.md",
      "conflict.md",
      "behind.md",
      "paused.md",
      "synced.md",
    ]);
  });

  it("counts someone else's document as theirs even with a copy on this device", () => {
    // Ownership decides the group. A local copy only decides what the row can
    // do with it, and listing it as one of mine says the wrong thing about who
    // the document belongs to.
    const organized = organizeLibraryItems([
      item({ path: "/docs/mine.md", name: "mine.md", state: "synced", cloudId: "c1" }),
      item({
        path: "/docs/theirs.md",
        name: "theirs.md",
        state: "synced",
        cloudId: "c2",
        owned: false,
        shared: true,
        sharedBy: "Grace",
        role: "viewer",
      }),
    ]);

    expect(organized.syncedFromDevice.map((entry) => entry.name)).toEqual(["mine.md"]);
    expect(organized.sharedItems.map((entry) => entry.name)).toEqual(["theirs.md"]);
  });

  it("keeps a revoked or offline row out of my own documents", () => {
    // The server did not answer, so nothing in this row says "shared": the last
    // role it confirmed is all there is, and it says the document is not mine.
    // Reading the missing list as ownership is what put someone else's file
    // under my own with owner's actions beside it.
    const organized = organizeLibraryItems([
      item({
        path: "/docs/theirs.md",
        name: "theirs.md",
        state: "synced",
        cloudId: "c1",
        owned: false,
      }),
    ]);

    expect(organized.syncedFromDevice).toEqual([]);
    // It is still on this device, so the Library still lists it.
    expect(organized.localFiles.map((entry) => entry.name)).toEqual(["theirs.md"]);
  });

  it("keeps a row nobody has vouched for out of my own documents too", () => {
    // No remote record and no confirmed role: unknown, which is not "mine".
    // It joins the group the moment the server's list says it belongs there.
    const unknown = item({
      path: "/docs/unknown.md",
      name: "unknown.md",
      state: "synced",
      cloudId: "c1",
      owned: null,
    });

    expect(organizeLibraryItems([unknown]).syncedFromDevice).toEqual([]);
    expect(organizeLibraryItems([unknown]).localFiles.map((e) => e.name)).toEqual([
      "unknown.md",
    ]);
    expect(
      organizeLibraryItems([{ ...unknown, owned: true }]).syncedFromDevice.map((e) => e.name)
    ).toEqual(["unknown.md"]);
  });

  it("sorts an unpushed doc above every other attention state", () => {
    // It is the only state where the newest copy of the edit exists in exactly
    // one place, so it has to be the first row the user sees.
    const organized = organizeLibraryItems([
      item({ path: "/docs/conflict.md", name: "conflict.md", state: "conflict" }),
      item({ path: "/docs/unpushed.md", name: "unpushed.md", state: "unpushed" }),
      item({ path: "/docs/behind.md", name: "behind.md", state: "behind" }),
    ]);

    expect(organized.localFiles.map((entry) => entry.name)).toEqual([
      "unpushed.md",
      "conflict.md",
      "behind.md",
    ]);
  });

  it("detects library items that need user attention", () => {
    expect(libraryItemNeedsAttention(item({ state: "unpushed" }))).toBe(true);
    expect(libraryItemNeedsAttention(item({ state: "conflict" }))).toBe(true);
    expect(libraryItemNeedsAttention(item({ state: "behind" }))).toBe(true);
    expect(libraryItemNeedsAttention(item({ exists: false }))).toBe(true);
    expect(libraryItemNeedsAttention(item({ state: "synced" }))).toBe(false);
  });
});
