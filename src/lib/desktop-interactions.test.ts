import { describe, expect, it } from "vitest";
import {
  compactWorkspacePath,
  pathBasename,
  pathDirname,
} from "./path-utils";
import { shouldDismissLayer } from "./use-dismissible-layer";
import { openedPathAfterWorkspaceEdit } from "./workspace-edit";

describe("desktop path handling", () => {
  it("finds parent folders and file names on macOS and Windows", () => {
    expect(pathDirname("/Users/me/Documents/Markie/note.md")).toBe(
      "/Users/me/Documents/Markie"
    );
    expect(pathBasename("/Users/me/Documents/Markie/note.md")).toBe("note.md");
    expect(pathDirname("C:\\Users\\me\\Documents\\Markie\\note.md")).toBe(
      "C:\\Users\\me\\Documents\\Markie"
    );
    expect(pathBasename("C:\\Users\\me\\Documents\\Markie\\note.md")).toBe(
      "note.md"
    );
    expect(pathDirname("C:\\note.md")).toBe("C:\\");
  });

  it("keeps the default workspace label compact on both platforms", () => {
    expect(compactWorkspacePath("/Users/me/Documents/Markie")).toBe(
      "~/Documents/Markie"
    );
    expect(compactWorkspacePath("C:\\Users\\me\\Documents\\Markie")).toBe(
      "~/Documents/Markie"
    );
  });
});

describe("workspace file creation", () => {
  it("opens a successfully created file, but not folders or failed edits", () => {
    expect(
      openedPathAfterWorkspaceEdit("new-file", {
        ok: true,
        path: "C:\\Users\\me\\Documents\\Markie\\new.md",
      })
    ).toBe("C:\\Users\\me\\Documents\\Markie\\new.md");
    expect(
      openedPathAfterWorkspaceEdit("new-folder", { ok: true, path: "/tmp/folder" })
    ).toBeNull();
    expect(
      openedPathAfterWorkspaceEdit("new-file", { error: "Already exists" })
    ).toBeNull();
  });
});

describe("dismissible menus", () => {
  it("stays open for inside clicks and dismisses for outside clicks", () => {
    const inside = {} as Node;
    const outside = {} as Node;
    const layer = { contains: (target: Node | null) => target === inside };

    expect(shouldDismissLayer(layer, inside)).toBe(false);
    expect(shouldDismissLayer(layer, outside)).toBe(true);
  });
});
