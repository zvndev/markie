import { describe, expect, it } from "vitest";
import { richBaseExtensions } from "@/lib/rich-extensions";

const names = (opts?: { collab?: boolean }) =>
  richBaseExtensions(opts).map((e) => e.name);

describe("richBaseExtensions", () => {
  it("contains the full editing surface, in a stable order", () => {
    expect(names()).toEqual([
      "starterKit",
      // Paragraph and heading are ours, so an aligned one reaches the file.
      "paragraph",
      "heading",
      "tableKit",
      "taskList",
      "taskItem",
      "image",
      "embed",
      "placeholder",
      "markieKeymap",
      "highlight",
      "textStyle",
      "color",
      "fontFamily",
      "fontSize",
      "textAlign",
      "markdown",
    ]);
  });

  it("only differs in undo history between solo and collab", () => {
    // Same extension names either way; collab mode disables StarterKit's
    // undoRedo because the Yjs history replaces it.
    expect(names({ collab: true })).toEqual(names({ collab: false }));
  });
});
