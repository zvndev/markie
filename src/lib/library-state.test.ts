import { describe, expect, it } from "vitest";
import { libraryLoadErrorMessage, readLibrarySnapshot } from "./library-state";

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
