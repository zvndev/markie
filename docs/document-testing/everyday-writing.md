# Everyday writing: first transaction batch

[Back to the guide](README.md) · [Document types](document-types.md)

The full Word-like editor is still being implemented under ENG-7025. These checks cover the first deterministic-input and control-layout batch, not completion of continuous cross-paragraph writing.

## Mixed formatting and normal input

Use a disposable DOCX, RTF or ODT with several differently formatted runs in one paragraph. Select from the middle of a bold word into an italic word and type a replacement. Unselected fragments must retain their formatting. Delete an entire run, then undo and redo. Save a copy in the original format and reopen it; neither the original file nor its unrelated content should change.

Try emoji and combining characters. Backspace/Delete must not leave invalid Unicode. Pasting a single line replaces only the selection; HTML-only clipboard content must not erase selected text. Cut/paste source handling is covered by automated events, but real OS clipboard interoperability and physical IME input remain separate platform acceptance checks.

If a browser input cannot be represented safely, the document and both visible/logical selections must be restored. Applying Bold after that rejection must still format only the selected substring. Confirming an IME candidate with Enter must not accidentally split the paragraph.

Mixed-format structural split/join, cross-paragraph selection, rich clipboard, grouped caret-aware history and richer tracked editing remain part of the next transaction/model phase. The first batch protects unrepresented structural operations instead of flattening formatting. Existing supported plain-paragraph tracking and accept/reject should continue working.

## Existing controls, correctly fitted

At an ordinary desktop editor width, check styles, font, size, bold/italic/underline, color, lists and alignment without first opening every tool through More. Shrink the window: the real controls should move into More progressively, remain keyboard reachable, and return focus when it closes. Text/CSV Find and encoding/status controls must also fit without horizontal overflow. Test both themes.

## Contextual output information

A new or ordinarily editable document must not show a permanent generic Print/PDF disclaimer above the toolbar. Open Export to see output information, or Document details for applicable restrictions. A document with review comments asks before output that excludes them; canceling that question must leave edits and dirty state unchanged. Genuine unsupported/protected document restrictions must still prevent unsafe output or editing.
