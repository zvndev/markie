# Everyday writing: source-safe document transactions

[Back to the guide](README.md) · [Document types](document-types.md)

The full Word-like editor is still being implemented under ENG-7025. These checks cover deterministic input, DOCX paragraph transactions and the shared controls, not complete Word compatibility.

## Mixed formatting and normal input

Use a disposable DOCX, RTF or ODT with several differently formatted runs in one paragraph. Select from the middle of a bold word into an italic word and type a replacement. Unselected fragments must retain their formatting. Delete an entire run, then undo and redo. Save a copy in the original format and reopen it; neither the original file nor its unrelated content should change.

Try emoji and combining characters. Backspace/Delete must not leave invalid Unicode. Pasting a single line replaces only the selection; HTML-only clipboard content must not erase selected text. Cut/paste source handling is covered by automated events, but real OS clipboard interoperability and physical IME input remain separate platform acceptance checks.

If a browser input cannot be represented safely, the document and both visible/logical selections must be restored. Applying Bold after that rejection must still format only the selected substring. Confirming an IME candidate with Enter must not accidentally split the paragraph.

## DOCX paragraph editing

Use a disposable DOCX with three ordinary paragraphs, including bold and italic text. Place the caret in a formatted word, press Enter, then type. Both sides must retain their original formatting. Press Enter twice at the end and type into the empty paragraph. Save and reopen: the blank paragraph and new text must survive.

At the start of a paragraph, press Backspace to join it to the previous paragraph. At the end, press Delete to join the next paragraph. Select across several paragraphs in both directions and type a replacement; repeat with Enter and multiline plain-text paste. Undo and redo must restore both text and the selection. Select `bc` in `abcd`, press Enter, undo, then apply Bold: only `bc` should become bold. Cmd+A/Ctrl+A inside DOCX selects the document body for replacement.

These transactions currently apply to ordinary DOCX paragraph/run content within one body or table cell. Paragraphs containing comments, revisions, hyperlinks, images or authored breaks remain protected from structural editing. Joining differently styled paragraphs is refused when it would change surviving text's inherited formatting. A selection cannot cross a table or cell boundary. Rejection must leave the source and visible document unchanged. RTF/ODT structural editing, rich clipboard interoperability, grouped typing history and richer tracked editing remain open. Existing supported plain-paragraph tracking and accept/reject should continue working.

Legacy `.doc` is a separate binary format. Its new compound-container writer and plain-story stream serializer are internal building blocks, not a conforming rich DOC exporter. The app's legacy DOC route remains text-only; do not expect native DOC editing in this preview.

## Existing controls, correctly fitted

At an ordinary desktop editor width, check styles, font, size, bold/italic/underline, color, lists and alignment without first opening every tool through More. Shrink the window: the real controls should move into More progressively, remain keyboard reachable, and return focus when it closes. Text/CSV Find and encoding/status controls must also fit without horizontal overflow. Test both themes.

## Contextual output information

A new or ordinarily editable document must not show a permanent generic Print/PDF disclaimer above the toolbar. Open Export to see output information, or Document details for applicable restrictions. A document with review comments asks before output that excludes them; canceling that question must leave edits and dirty state unchanged. Genuine unsupported/protected document restrictions must still prevent unsafe output or editing.
