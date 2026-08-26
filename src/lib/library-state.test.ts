import { describe, expect, it } from "vitest";
import {
  initialFilesSubView,
  initialLibTab,
  libraryLoadErrorMessage,
  readLibrarySnapshot,
} from "./library-state";

describe("library state loader", () => {
  it("returns library state when the desktop IPC call succeeds", async () => {
    await expect(
      readLibrarySnapshot({
        libraryState: async () => ({
          signedIn: true,
          items: [
            {
              kind: "local",
              path: "/Users/me/Documents/Markie/readme.md",
              name: "readme.md",
              cloudId: null,
              state: "local-only",
              lastOpenedAt: null,
              remoteVersion: null,
              exists: true,
            },
          ],
        }),
      })
    ).resolves.toMatchObject({
      signedIn: true,
      items: [{ name: "readme.md" }],
      error: null,
    });
  });

  it("turns desktop IPC failures into an empty snapshot and user-visible notice", async () => {
    await expect(
      readLibrarySnapshot({
        libraryState: async () => {
          throw new Error("native module failed to load");
        },
      })
    ).resolves.toEqual({
      signedIn: false,
      items: [],
      error: "Library couldn't load: native module failed to load",
    });
  });

  it("keeps long native-loader failures readable", () => {
    const message = libraryLoadErrorMessage(new Error("x".repeat(300)));

    expect(message).toMatch(/^Library couldn't load: x+/);
    expect(message.length).toBeLessThanOrEqual(205);
  });
});

describe("initialLibTab", () => {
  const store = (m: Record<string, string>) => (k: string) => m[k] ?? null;

  it("defaults new users to files", () => {
    expect(initialLibTab(store({}))).toBe("files");
  });

  it("keeps an explicit legacy recent choice", () => {
    expect(initialLibTab(store({ "markie.libtab.v1": "recent" }))).toBe("recent");
  });

  it("migrates a legacy files choice to files", () => {
    expect(initialLibTab(store({ "markie.libtab.v1": "files" }))).toBe("files");
  });

  it("v2 always wins", () => {
    expect(
      initialLibTab(store({ "markie.libtab.v1": "files", "markie.libtab.v2": "recent" }))
    ).toBe("recent");
    expect(
      initialLibTab(store({ "markie.libtab.v1": "recent", "markie.libtab.v2": "files" }))
    ).toBe("files");
  });

  it("ignores a value neither version recognises", () => {
    expect(initialLibTab(store({ "markie.libtab.v2": "nonsense" }))).toBe("files");
  });

  it("survives storage that refuses to answer", () => {
    expect(
      initialLibTab(() => {
        throw new Error("blocked");
      })
    ).toBe("files");
  });
});

describe("initialFilesSubView", () => {
  const store = (m: Record<string, string>) => (k: string) => m[k] ?? null;

  it("shows projects unless the user asked for folders", () => {
    expect(initialFilesSubView(store({}))).toBe("projects");
    expect(initialFilesSubView(store({ "markie.filesview.v1": "folders" }))).toBe("folders");
    expect(initialFilesSubView(store({ "markie.filesview.v1": "projects" }))).toBe("projects");
  });
});
