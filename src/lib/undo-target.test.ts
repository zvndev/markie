import { describe, expect, it } from "vitest";
import { undoTargetFor } from "./undo-target";

// Minimal stand-ins: undoTargetFor only asks for tagName and closest(), so the
// test does not need a DOM to say what it means.
function el(tagName: string, ancestors: string[] = []): Element {
  return {
    tagName,
    closest: (selector: string) => (ancestors.includes(selector) ? ({} as Element) : null),
  } as unknown as Element;
}

const both = { hasRich: true, hasSource: true };

describe("where undo goes", () => {
  it("goes to the editor the caret is in", () => {
    expect(undoTargetFor(el("DIV", [".ProseMirror"]), both)).toBe("rich");
    expect(undoTargetFor(el("DIV", [".cm-editor"]), both)).toBe("source");
  });

  // Taking ⌘Z away from the find box to undo a paragraph would be its own bug.
  it("leaves plain fields to their own native history", () => {
    expect(undoTargetFor(el("INPUT"), both)).toBe("native");
    expect(undoTargetFor(el("TEXTAREA"), both)).toBe("native");
    expect(undoTargetFor(el("SELECT"), both)).toBe("native");
  });

  it("prefers the rich pane when focus is somewhere neutral", () => {
    expect(undoTargetFor(el("BUTTON"), both)).toBe("rich");
    expect(undoTargetFor(el("BODY"), both)).toBe("rich");
  });

  it("uses whichever pane is actually mounted", () => {
    expect(undoTargetFor(el("BODY"), { hasSource: true })).toBe("source");
    expect(undoTargetFor(el("BODY"), { hasRich: true })).toBe("rich");
  });

  it("has nowhere to send it when no editor is open", () => {
    expect(undoTargetFor(el("BODY"), {})).toBe("none");
    expect(undoTargetFor(null, {})).toBe("none");
  });

  it("still picks a pane when nothing at all is focused", () => {
    expect(undoTargetFor(null, both)).toBe("rich");
    expect(undoTargetFor(null, { hasSource: true })).toBe("source");
  });

  // A field inside the source pane is still a field: the shortcut belongs to
  // whatever the caret is actually editing.
  it("checks the element itself before its surroundings", () => {
    expect(undoTargetFor(el("INPUT", [".cm-editor"]), both)).toBe("native");
  });
});
