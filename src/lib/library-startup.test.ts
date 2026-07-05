import { describe, expect, it } from "vitest";
import { readLibraryStartupSnapshot } from "./library-startup";

describe("library startup", () => {
  it("creates the default workspace while loading the library snapshot", async () => {
    let created = false;
    const result = await readLibraryStartupSnapshot({
      libraryState: async () => ({ signedIn: false, items: [] }),
      wsRoots: async () => (created ? ["/Users/me/Documents/Markie"] : []),
      wsDefaultPath: async () => "/Users/me/Documents/Markie",
      wsCreateDefault: async () => {
        created = true;
        return { ok: true, path: "/Users/me/Documents/Markie" };
      },
    });

    expect(result).toEqual({
      signedIn: false,
      items: [],
      error: null,
      workspace: {
        roots: ["/Users/me/Documents/Markie"],
        defaultPath: "/Users/me/Documents/Markie",
        created: true,
      },
    });
  });

  it("keeps the library usable when workspace creation fails", async () => {
    const result = await readLibraryStartupSnapshot({
      libraryState: async () => ({
        signedIn: false,
        items: [
          {
            kind: "local",
            path: "/tmp/loose.md",
            name: "loose.md",
            cloudId: null,
            state: "local-only",
            lastOpenedAt: "2026-07-04T22:00:00.000Z",
            remoteVersion: null,
            exists: true,
          },
        ],
      }),
      wsRoots: async () => [],
      wsDefaultPath: async () => "/Users/me/Documents/Markie",
      wsCreateDefault: async () => ({ error: "permission denied" }),
    });

    expect(result.items).toHaveLength(1);
    expect(result.workspace).toEqual({
      roots: [],
      defaultPath: "/Users/me/Documents/Markie",
      created: false,
      error: "permission denied",
    });
    expect(result.error).toBe("permission denied");
  });

  it("falls back to library-only loading outside Electron", async () => {
    const result = await readLibraryStartupSnapshot({
      libraryState: async () => ({ signedIn: false, items: [] }),
    });

    expect(result).toEqual({
      signedIn: false,
      items: [],
      error: null,
      workspace: null,
    });
  });
});
