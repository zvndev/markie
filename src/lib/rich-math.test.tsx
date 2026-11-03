import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { mathSpanEnd, splitMath } from "@/lib/rich-math";

// Parse then serialize through the real rich configuration: the path every
// edited block takes, solo and live.
function roundTrip(markdown: string, edit?: (editor: Editor) => void): string {
  const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    edit?.(editor);
    return (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
  } finally {
    editor.destroy();
  }
}

const appendToEnd = (text: string) => (editor: Editor) => {
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, { type: "text", text });
};

describe("math in the rich editor", () => {
  it("writes inline TeX back as written, not with its backslashes doubled", () => {
    expect(roundTrip("Euler: $e^{i\\pi} + 1 = 0$.", appendToEnd(" Bob"))).toBe("Euler: $e^{i\\pi} + 1 = 0$. Bob");
  });

  it("keeps TeX's own escapes, a thin space `\\,` and braces among them", () => {
    expect(roundTrip("Area $\\int x \\, dx$ and $\\{a\\}$ here.", appendToEnd("!"))).toBe("Area $\\int x \\, dx$ and $\\{a\\}$ here.!");
  });

  it("keeps markdown's characters inside math out of emphasis and escaping", () => {
    expect(roundTrip("Product $a_1 * b_2 * c$ done.", appendToEnd(" x"))).toBe("Product $a_1 * b_2 * c$ done. x");
  });

  it("writes an edited display block as display math, its TeX intact", () => {
    const display = "$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$";
    expect(roundTrip(display)).toBe(display);
    const edited = roundTrip(display, (editor) => {
      // Inside the formula, before the closing `$$`.
      editor.commands.insertContentAt(editor.state.doc.content.size - 4, { type: "text", text: " + C" });
    });
    expect(edited).toBe("$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3} + C\n$$");
  });

  it("leaves prices as prices, escaping around them as before", () => {
    expect(roundTrip("It cost $5 and then $10 *more*.", appendToEnd("!"))).toBe("It cost $5 and then $10 *more*.!");
    expect(roundTrip("A \\*literal\\* star and $6.", appendToEnd("!"))).toBe("A \\*literal\\* star and $6.!");
  });

  it("finds spans by the read view's rule", () => {
    expect(mathSpanEnd("$x$", 0)).toBe(3);
    expect(mathSpanEnd("$ x$", 0)).toBe(-1); // opens on whitespace
    expect(mathSpanEnd("$x $", 0)).toBe(-1); // closes after whitespace
    expect(mathSpanEnd("$5 and $10", 0)).toBe(-1); // closer followed by a digit
    expect(mathSpanEnd("$$ a b $$", 0)).toBe(9);
    expect(mathSpanEnd("$$$$", 0)).toBe(-1);
    expect(splitMath("a $x$ b $$y$$")).toEqual([
      { math: false, text: "a " },
      { math: true, text: "$x$" },
      { math: false, text: " b " },
      { math: true, text: "$$y$$" },
    ]);
  });
});
