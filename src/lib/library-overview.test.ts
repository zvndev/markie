import { describe, expect, it } from "vitest";
import type { LibraryItem } from "./electron";
import {
  cloudCopyOnly,
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

  it("keeps a file whose first sync never landed out of the cloud sections", () => {
    // docSyncOn failed, so the row is unpushed with no cloud document behind
    // it. Saying it is synced from this device describes a copy that was never
    // created; the Library still lists it, because the file is right there.
    const neverLanded = item({
      path: "/docs/orphan.md",
      name: "orphan.md",
      state: "unpushed",
      cloudId: null,
    });

    expect(organizeLibraryItems([neverLanded]).syncedFromDevice).toEqual([]);
    expect(organizeLibraryItems([neverLanded]).localFiles.map((e) => e.name)).toEqual([
      "orphan.md",
    ]);
    expect(
      organizeLibraryItems([{ ...neverLanded, cloudId: "c1" }]).syncedFromDevice.map(
        (e) => e.name
      )
    ).toEqual(["orphan.md"]);
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

  it("moves my document into my cloud once its file is gone from this device", () => {
    // The cloud copy is the only one left. Under "Synced from this device" the
    // row would open nothing and offer nothing; under "In your cloud" it
    // offers the copy back, which is what the heading is for.
    const gone = item({
      path: "/docs/gone.md",
      name: "gone.md",
      state: "synced",
      cloudId: "c1",
      exists: false,
    });

    const organized = organizeLibraryItems([gone]);
    expect(organized.syncedFromDevice).toEqual([]);
    expect(organized.myCloudOnly.map((e) => e.name)).toEqual(["gone.md"]);
    // The Library still lists it, marked missing, because the row is a path
    // on this device that somebody may want to know is dead.
    expect(organized.localFiles.map((e) => e.name)).toEqual(["gone.md"]);

    // The same row with its file present is synced from here.
    const present = organizeLibraryItems([{ ...gone, exists: true }]);
    expect(present.syncedFromDevice.map((e) => e.name)).toEqual(["gone.md"]);
    expect(present.myCloudOnly).toEqual([]);
  });

  it("does not put a gone file in my cloud unless the cloud is known to hold it", () => {
    // Nobody has vouched for the first; the second was never in the cloud.
    // Neither has a copy the page can promise to bring back.
    const unvouched = item({
      path: "/docs/unknown.md",
      name: "unknown.md",
      state: "synced",
      cloudId: "c1",
      exists: false,
      owned: null,
    });
    const neverSynced = item({ path: "/docs/local.md", name: "local.md", exists: false });

    const organized = organizeLibraryItems([unvouched, neverSynced]);
    expect(organized.myCloudOnly).toEqual([]);
    expect(organized.syncedFromDevice).toEqual([]);
    expect(organized.localFiles.map((e) => e.name)).toEqual(["local.md", "unknown.md"]);
  });

  it("keeps a document remembered as shared with me under theirs while offline", () => {
    // The list did not load, so nobody can say who shared it. The remembered
    // role still says it is shared, and that is the section it belongs in.
    const remembered = item({
      path: "/docs/theirs.md",
      name: "theirs.md",
      state: "synced",
      cloudId: "c1",
      owned: false,
      shared: true,
      role: "editor",
      sharedBy: null,
    });

    const organized = organizeLibraryItems([remembered]);
    expect(organized.sharedItems.map((e) => e.name)).toEqual(["theirs.md"]);
    expect(organized.syncedFromDevice).toEqual([]);
    expect(organized.myCloudOnly).toEqual([]);
  });

  it("knows which rows the cloud holds a copy of and this device does not", () => {
    const cloud = item({
      kind: "cloud-only",
      path: null,
      name: "cloud.md",
      state: "cloud-only",
      cloudId: "c1",
      exists: false,
    });
    const gone = item({ path: "/docs/gone.md", state: "synced", cloudId: "c2", exists: false });

    expect(cloudCopyOnly(cloud)).toBe(true);
    expect(cloudCopyOnly(gone)).toBe(true);
    // Still here: nothing to bring back.
    expect(cloudCopyOnly({ ...gone, exists: true })).toBe(false);
    // Gone, but nobody has said the cloud holds it for this account.
    expect(cloudCopyOnly({ ...gone, owned: null })).toBe(false);
    // Gone, and never in the cloud at all.
    expect(cloudCopyOnly(item({ exists: false }))).toBe(false);
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
