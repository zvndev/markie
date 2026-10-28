// The editor's formatting buttons: each one turns the selected text (or the
// caret's line) into a new value and a new selection. Pure, so it is tested
// without a text box.

export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

export type MarkdownAction = "heading" | "bold" | "italic" | "list" | "task" | "link" | "code";

function wrap(edit: TextEdit, before: string, after: string, placeholder: string): TextEdit {
  const selected = edit.value.slice(edit.start, edit.end) || placeholder;
  const value = edit.value.slice(0, edit.start) + before + selected + after + edit.value.slice(edit.end);
  const start = edit.start + before.length;
  return { value, start, end: start + selected.length };
}

function prefixLines(edit: TextEdit, prefix: string, toggle: RegExp): TextEdit {
  const lineStart = edit.value.lastIndexOf("\n", edit.start - 1) + 1;
  const nextBreak = edit.value.indexOf("\n", edit.end);
  const lineEnd = nextBreak === -1 ? edit.value.length : nextBreak;
  const lines = edit.value.slice(lineStart, lineEnd).split("\n");
  const allHave = lines.every((line) => toggle.test(line));
  const changed = lines.map((line) => (allHave ? line.replace(toggle, "") : `${prefix}${line.replace(toggle, "")}`)).join("\n");
  const value = edit.value.slice(0, lineStart) + changed + edit.value.slice(lineEnd);
  const delta = changed.length - (lineEnd - lineStart);
  if (lines.length > 1) return { value, start: lineStart, end: lineEnd + delta };
  return { value, start: Math.max(lineStart, edit.start + delta), end: Math.max(lineStart, edit.end + delta) };
}

export function applyMarkdownAction(edit: TextEdit, action: MarkdownAction): TextEdit {
  switch (action) {
    case "heading": return prefixLines(edit, "## ", /^#{1,6} /);
    case "bold": return wrap(edit, "**", "**", "bold");
    case "italic": return wrap(edit, "_", "_", "italic");
    case "list": return prefixLines(edit, "- ", /^- (?!\[[ x]\] )/);
    case "task": return prefixLines(edit, "- [ ] ", /^- \[[ x]\] /);
    case "code": return wrap(edit, "`", "`", "code");
    case "link": {
      const selected = edit.value.slice(edit.start, edit.end) || "link text";
      const value = `${edit.value.slice(0, edit.start)}[${selected}](https://)${edit.value.slice(edit.end)}`;
      // The caret lands after "https://", ready for the address.
      const caret = edit.start + selected.length + 11;
      return { value, start: caret, end: caret };
    }
  }
}
