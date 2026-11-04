import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { isMathSource, mathSpanEnd, splitMath, texOf } from "@/lib/rich-math";

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

// The n-th math node's source, changed the way its source field changes it.
const editSource = (n: number, change: (source: string) => string) => (editor: Editor) => {
  const found: Array<{ pos: number; source: string }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "mathBlock" || node.type.name === "mathInline") found.push({ pos, source: node.attrs.source });
  });
  const target = found[n];
  editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, undefined, { source: change(target.source) }));
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
    // Inside the formula: its source, as the click-to-edit field changes it.
    const edited = roundTrip(display, editSource(0, (source) => source.replace("\n$$", () => " + C\n$$")));
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

// ── math as nodes: parse, serialize, render, edit ──

const nodesOf = (markdown: string) => {
  const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    const found: Array<{ type: string; source: string }> = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mathBlock" || node.type.name === "mathInline") found.push({ type: node.type.name, source: node.attrs.source });
    });
    return found;
  } finally {
    editor.destroy();
  }
};

describe("math nodes", () => {
  it("reads display math on lines of its own as one block holding its source verbatim", () => {
    const display = "$$\n\\begin{aligned}\n  a &= b \\\\\n  c &= d\n\\end{aligned}\n$$";
    expect(nodesOf(display)).toEqual([{ type: "mathBlock", source: display }]);
    expect(nodesOf("$$x^2$$")).toEqual([{ type: "mathBlock", source: "$$x^2$$" }]);
  });

  it("reads every other span as inline math, a `$$` one in a sentence included", () => {
    expect(nodesOf("Euler $e^{i\\pi}$ and $$a\nb$$ end.")).toEqual([
      { type: "mathInline", source: "$e^{i\\pi}$" },
      { type: "mathInline", source: "$$a\nb$$" },
    ]);
    // A `$$` line straight after a paragraph's text belongs to the paragraph.
    expect(nodesOf("text\n$$\nx\n$$")).toEqual([{ type: "mathInline", source: "$$\nx\n$$" }]);
  });

  it("leaves prices, escaped dollars and code alone", () => {
    expect(nodesOf("It cost $5 and then $10.")).toEqual([]);
    expect(nodesOf("Not \\$x$ math.")).toEqual([]);
    expect(nodesOf("Code `$x$` and\n\n```\n$$\ny\n$$\n```")).toEqual([]);
  });

  it.each([
    ["a multi-line display block", "Before.\n\n$$\n\\int_0^1 x^2\n  \\, dx\n$$\n\nAfter.\n"],
    ["display math in a blockquote", "> $$\n> a\n> b\n> $$\n"],
    ["display math in a list item", "- item\n\n  $$\n  a\n    b\n  $$\n"],
    ["a one-line display block", "Intro.\n\n$$x^2 + y^2$$\n\nOutro.\n"],
    ["inline math with markdown characters inside", "Product $a_1 * b_2 * c$ and $\\{a\\}$ and $a<b$.\n"],
    ["inline math in bold", "**bold $x$** text\n"],
    ["inline math in a table cell", "| m | n |\n| --- | --- |\n| $a \\| b$ | $c$ |\n"],
  ])("writes %s back byte for byte, untouched and after an edit beside it", (_label, markdown) => {
    expect(roundTrip(markdown).replace(/\n*$/, "\n")).toBe(markdown);
    // An edit elsewhere in the document: every formula comes out as it went in.
    const edited = roundTrip(markdown, appendToEnd(" Z"));
    expect(edited).toContain("Z");
    const sources = nodesOf(edited).map((n) => n.source);
    expect(sources).toEqual(nodesOf(markdown).map((n) => n.source));
  });

  it("keeps a formula exact when the paragraph around it is edited", () => {
    const md = "Euler: $e^{i\\pi} + 1 = 0$ and $$a\nb$$.";
    expect(roundTrip(md, appendToEnd(" Done"))).toBe("Euler: $e^{i\\pi} + 1 = 0$ and $$a\nb$$. Done");
  });

  it("keeps the word after a formula that ends a line apart from it", () => {
    expect(roundTrip("$$\nx\n$$\nmore")).toBe("$$\nx\n$$ more");
  });

  it("writes what was typed into a formula's source, and removes a formula emptied", () => {
    expect(roundTrip("A $x$ b.", editSource(0, () => "$x^2$"))).toBe("A $x^2$ b.");
    const removed = roundTrip("A $x$ b.", (editor) => {
      let pos = -1;
      editor.state.doc.descendants((node, p) => { if (node.type.name === "mathInline") pos = p; });
      editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
    });
    expect(removed).toBe("A  b.");
  });

  it("finds the TeX in a source the way the read view draws it", () => {
    expect(texOf("$x$", false)).toEqual({ tex: "x", display: false });
    expect(texOf("$$a\nb$$", false)).toEqual({ tex: "a\nb", display: false });
    expect(texOf("$$\n a \n$$", true)).toEqual({ tex: "a", display: true });
    expect(isMathSource("$x$")).toBe(true);
    expect(isMathSource("$x")).toBe(false);
  });
});

describe("math in the rich view", () => {
  async function mounted(markdown: string, editable = true) {
    const { render, waitFor } = await import("@testing-library/react");
    const { EditorContent, useEditor } = await import("@tiptap/react");
    let handle: import("@tiptap/react").Editor | null = null;
    function View() {
      const editor = useEditor({ extensions: richBaseExtensions(), content: markdown, editable, immediatelyRender: true });
      handle = editor;
      return <EditorContent editor={editor} />;
    }
    const view = render(<View />);
    await waitFor(() => expect(view.container.querySelector(".markie-math .katex")).not.toBeNull(), { timeout: 5000 });
    return { view, editor: () => handle!, waitFor };
  }

  it("draws inline and display math with KaTeX, not as raw `$…$`", async () => {
    const { view } = await mounted("Euler $e^{i\\pi}$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n");
    const inline = view.container.querySelector(".markie-math-inline")!;
    const block = view.container.querySelector(".markie-math-block")!;
    expect(inline.querySelector(".katex")).not.toBeNull();
    expect(inline.querySelector(".katex-display")).toBeNull();
    expect(block.querySelector(".katex-display")).not.toBeNull();
    expect(view.container.textContent).not.toContain("$e^{i");
    view.unmount();
  });

  it("opens the source on a click while editing, and keeps the change on Enter", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { view, editor, waitFor } = await mounted("A $x$ b.\n");
    const inline = view.container.querySelector(".markie-math-inline") as HTMLElement;
    fireEvent.mouseDown(inline);
    const field = inline.querySelector("input.markie-math-field") as HTMLInputElement;
    expect(field.value).toBe("$x$");
    fireEvent.input(field, { target: { value: "$x^2$" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect((editor().storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown()).toBe("A $x^2$ b."));
    view.unmount();
  });

  it("puts the source back on Escape, and opens nothing when read-only", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const first = await mounted("$$\na\n$$\n");
    const block = first.view.container.querySelector(".markie-math-block") as HTMLElement;
    fireEvent.mouseDown(block);
    const area = block.querySelector("textarea.markie-math-field") as HTMLTextAreaElement;
    expect(area.value).toBe("$$\na\n$$");
    fireEvent.input(area, { target: { value: "$$\nchanged\n$$" } });
    fireEvent.keyDown(area, { key: "Escape" });
    expect((first.editor().storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown()).toBe("$$\na\n$$");
    first.view.unmount();

    const readOnly = await mounted("A $x$ b.\n", false);
    const inline = readOnly.view.container.querySelector(".markie-math-inline") as HTMLElement;
    fireEvent.mouseDown(inline);
    expect(inline.querySelector("input")).toBeNull();
    readOnly.view.unmount();
  });
});
