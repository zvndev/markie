import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { RichView } from "@/components/rich-view";

// Opens a document in the real rich pane, runs one edit through the real
// editor, and returns the markdown the component emitted. This is the wiring
// test: the layer modules have their own suites, but only this proves the
// component actually routes a save through them.
async function editAndSerialize(
  value: string,
  edit: (editor: Editor) => void
): Promise<string> {
  const onChange = vi.fn();
  let editor: Editor | null = null;
  render(
    <RichView
      value={value}
      onChange={onChange}
      onEditorReady={(e) => {
        if (e) editor = e;
      }}
    />
  );
  await waitFor(() => expect(editor).not.toBeNull());
  const ready = editor as unknown as Editor;
  edit(ready);
  await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
}

const appendToFirstBlock = (text: string) => (editor: Editor) => {
  editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize - 1, text);
};

describe("RichView serialization", () => {
  it("leaves every line the user did not touch byte-identical", async () => {
    const value = [
      "First paragraph is wrapped",
      "by hand across two lines.",
      "",
      "Second paragraph is also",
      "wrapped by hand.",
      "",
      "| left | right |",
      "| :--- | ---: |",
      "| 1 | 2 |",
      "",
      "- [x] a tight task list",
      "- [ ] that serializes loose",
      "",
      "Closing paragraph wrapped",
      "across lines as well.",
      "",
    ].join("\n");

    const out = await editAndSerialize(value, appendToFirstBlock(" EDITED"));

    const before = value.split("\n");
    const after = out.split("\n");
    // The edited block collapsed its two wrapped lines into the one the
    // serializer produced; everything below it is untouched.
    expect(after[0]).toBe("First paragraph is wrapped by hand across two lines. EDITED");
    expect(after.slice(1)).toEqual(before.slice(2));
  });

  it("restores front matter, HTML comments, and raw HTML around an edit", async () => {
    const value = [
      "---",
      "title: Held aside",
      "markie:",
      "  project: Markie",
      "---",
      "Opening paragraph.",
      "",
      "<!-- a comment the editor would delete -->",
      "",
      "<div class=\"note\">",
      "<b>raw html</b>",
      "</div>",
      "",
      "Closing line.",
      "",
    ].join("\n");

    const out = await editAndSerialize(value, appendToFirstBlock(" EDITED"));

    expect(out).toContain("---\ntitle: Held aside\nmarkie:\n  project: Markie\n---\n");
    expect(out).toContain("<!-- a comment the editor would delete -->");
    expect(out).toContain("<div class=\"note\">\n<b>raw html</b>\n</div>");
    expect(out).toContain("Opening paragraph. EDITED");
    expect(out).not.toContain("markie-hold-");
  });
});
