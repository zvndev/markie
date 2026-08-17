import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME, TITLE_MARKER, windowTitle } from "./window-title";

describe("the window title", () => {
  it("names the document", () => {
    expect(windowTitle("notes.md")).toBe("notes.md — Markie — Markdown Viewer");
  });

  it("marks unsaved changes", () => {
    expect(windowTitle("notes.md", true)).toBe("• notes.md — Markie — Markdown Viewer");
  });

  it("describes itself when nothing is open", () => {
    expect(windowTitle(null)).toBe("Markie — Markdown Viewer");
  });

  // The whole reason the marker is in every title. The packaging gate reads
  // the title to decide whether the renderer loaded, and an Electron window
  // with no page still reports the application name — so "Markie" alone
  // proves nothing.
  it("carries the marker in every state, since the packaging gate reads it", () => {
    for (const title of [windowTitle(null), windowTitle("a.md"), windowTitle("a.md", true)]) {
      expect(title).toContain(TITLE_MARKER);
      expect(title).toContain(APP_NAME);
    }
  });

  it("is not something an empty window could report by accident", () => {
    expect(windowTitle(null)).not.toBe(APP_NAME);
  });
});

describe("the packaging gate agrees with it", () => {
  const preflight = readFileSync(
    path.join(process.cwd(), "build", "preflight.cjs"),
    "utf-8"
  );

  // Two files, one constant. If someone shortens the title, this fails here
  // rather than by aborting a release.
  it("looks for the marker this module actually emits", () => {
    expect(preflight).toContain(`TITLE_NEEDLE = "${TITLE_MARKER}"`);
  });

  it("launches with document restore suppressed", () => {
    // Otherwise macOS reopening the last document renames the window and the
    // gate reads a title it was never going to match.
    expect(preflight).toContain("MARKIE_PREFLIGHT");
  });
});
