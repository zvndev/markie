# Document type checks

[Back to the test guide](README.md) · [Editing and recovery](editing-and-recovery.md)

## RTF and ODT

Open a supplied sample. Before editing, save a copy; its bytes should be unchanged. Open Font from the native Format menu, focus a field and close it without changing anything; another copy should still be unchanged.

Edit text including accented letters and an emoji. Change a selected run's font, size, color, bold, italic and underline. Change paragraph alignment/spacing, insert a paragraph with Enter, and paste several plain-text lines. Save a copy with the original extension and reopen it. Try Undo/Redo and Find/Replace.

Unsupported Word-only controls must not appear enabled: tables, pictures, lists, links, named Word styles, page setup, review and print/PDF are outside the current RTF/ODT subset. A complex RTF should stay read-only with original-byte export; an unsupported ODT should fail safely instead of replacing the current document with a flattened copy. Cloud sharing should explain its current limit without uploading the file.

ODT paragraph spacing is supported from 0 to 1000 points and line height from 50% to 500%. Other formatting and byte/text/node budgets also apply. Oversized edits or exports must report an error, never silently truncate content or mark it saved.

## DOCX

Open the supplied Word sample. Test selection formatting, imported style labels, theme typography, alignment, lists, basic rectangular tables, PNG/JPEG pictures, safe web links, explicit page breaks, comments and supported text revisions. Unsupported content is not a compatibility guarantee.

Test native Print and Export PDF with portrait/landscape and margins. Output must contain the document, not app chrome, and should not clear unsaved Word edits. Print/PDF currently omits comments and refuses pending revisions and unsupported structures. It uses Chromium fragmentation, not Word-identical pagination.

## Plain text and source formats

In TXT, type `# still literal`, `**not bold**`, Unicode, tabs and multiple lines. It must not turn into Markdown. Test Find/Replace, Undo/Redo, save/reopen and local recovery. Try the UTF-16 BOM/CRLF sample. Font and zoom are viewing settings only. Older encodings such as Windows-1252 and TXT-specific print/PDF remain pending.

For CSV, preserve quoted commas, quotes and line endings; use Table preview without rewriting the source. JSON, YAML and XML should keep their literal content. Do not expect a schema editor or code execution.

`README.md` is Markdown. Extensionless `README` and additional text aliases are still tracked separately. Darkmown `.wd` has its own source editor and trusted offline runtime; follow the [Darkmown checks](darkmown.md).

## Legacy and conversion-only formats

Use an expendable legacy DOC or HTML file. Import must explain that it creates a text-only copy. Never overwrite or relabel the original to claim rich-format support. RTF/ODT now use native codecs instead of this conversion path for their supported subset.
