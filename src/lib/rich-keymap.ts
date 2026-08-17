import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";

// The rich editor's shortcuts that no TipTap extension binds for us.
//
// Three of these exist because the conventional chord was already taken by
// something more important: ⌘K is the command palette, and ⌘⇧S is Save As. The
// fourth (clear formatting) simply has no default. Everything else a document
// editor is expected to answer to (⌘B, ⌘I, ⌘U, ⌘E, ⌘⇧H, ⌘⇧7/8/9, ⌘⇧L/E/R)
// comes from the extensions themselves; see toolbar-shortcuts.ts, which is the
// table both this file and the tooltips are checked against.
//
// Distinct from editor-keymap.ts, which is about the *source* pane giving keys
// up to the application. This one hands keys to the rich pane.

// Shared by the toolbar button and the keyboard shortcut so the two can never
// drift into doing different things.
export function promptForLink(editor: Editor): boolean {
  const previous = editor.getAttributes("link").href as string | undefined;
  const url = window.prompt("Link URL", previous ?? "");
  // Cancel leaves the document alone; clearing the box removes the link.
  if (url === null) return false;
  if (url === "") return editor.chain().focus().unsetLink().run();
  return editor.chain().focus().setLink({ href: url }).run();
}

export function clearFormatting(editor: Editor): boolean {
  return editor.chain().focus().unsetAllMarks().clearNodes().run();
}

export const MarkieKeymap = Extension.create({
  name: "markieKeymap",

  addKeyboardShortcuts() {
    return {
      // Strike's own default is Mod-Shift-s, which the File menu consumes as
      // Save As before the editor ever sees it. ⌘⇧X is what Docs and Word use.
      "Mod-Shift-x": () => this.editor.commands.toggleStrike(),
      "Mod-Shift-k": () => promptForLink(this.editor as Editor),
      "Mod-\\": () => clearFormatting(this.editor as Editor),
    };
  },
});
