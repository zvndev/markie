import { describe, expect, it } from "vitest";
import {
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

  it("defaults new users to Recent, which is what the Library is for", () => {
    expect(initialLibTab(store({}))).toBe("recent");
  });

  it("keeps a v3 choice", () => {
    expect(initialLibTab(store({ "markie.libtab.v3": "folders" }))).toBe("folders");
    expect(initialLibTab(store({ "markie.libtab.v3": "recent" }))).toBe("recent");
  });

  it("keeps someone who was on the folder tree on the folder tree", () => {
    // Files + Folders is the same content under a new label. Nothing about
    // that tab moved, so nothing about their landing should.
    expect(
      initialLibTab(store({ "markie.libtab.v2": "files", "markie.filesview.v1": "folders" }))
    ).toBe("folders");
  });

  it("lands someone who was on Files + Projects on Recent, not on a dead tab", () => {
    // The thing they picked left this panel entirely and became its own rail
    // destination. Recent is the Library's own answer; stranding them on a tab
    // that no longer exists is the one option that is not available.
    expect(
      initialLibTab(store({ "markie.libtab.v2": "files", "markie.filesview.v1": "projects" }))
    ).toBe("recent");
    expect(initialLibTab(store({ "markie.libtab.v2": "files" }))).toBe("recent");
  });

  it("keeps an explicit v2 recent choice", () => {
    expect(initialLibTab(store({ "markie.libtab.v2": "recent" }))).toBe("recent");
  });

  it("v3 wins over everything older", () => {
    expect(
      initialLibTab(
        store({
          "markie.libtab.v1": "files",
          "markie.libtab.v2": "files",
          "markie.filesview.v1": "folders",
          "markie.libtab.v3": "recent",
        })
      )
    ).toBe("recent");
  });

  it("ignores a value no version recognises", () => {
    expect(initialLibTab(store({ "markie.libtab.v3": "nonsense" }))).toBe("recent");
    expect(initialLibTab(store({ "markie.libtab.v2": "nonsense" }))).toBe("recent");
  });

  it("survives storage that refuses to answer", () => {
    expect(
      initialLibTab(() => {
        throw new Error("blocked");
      })
    ).toBe("recent");
  });
});
