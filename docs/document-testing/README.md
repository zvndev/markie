# Markie desktop test guide

This local preview extends the existing Markie app. It is not a public release or the completed document-platform roadmap. Use disposable copies while testing. Keep your installed Markie and important originals separate.

The full Word-like product and remaining acceptance journeys are defined in the repository's October 18 product contract and tracked under ENG-7025. This preview adds the first deterministic-input and shared-control improvements; it is not completion of the continuous document editor. The editing surface should no longer show a permanent generic print disclaimer. Open Export or Document details for output information; documents with review comments ask before producing output that excludes them.

Follow the [everyday writing checks](everyday-writing.md) for mixed formatting, input, narrow toolbars and contextual output information.

This preview includes original-engine RTF and ODT editing with same-format saving, supported native page setup and Print/PDF, plus a first offline interactive Darkmown milestone. Passive RTF information metadata and Word proofing/calculated-page markers have broader editing support. RTF/ODT are not secretly converted into Word files. Complex documents may remain read-only or be refused before they replace the current editor.

## Start here

1. Open this guide in the supplied Markie Preview app.
2. Open the supplied `samples/Editorial.rtf`, then `samples/Editorial.odt`, using Markie's Open button.
3. Change text and its font, bold/italic/underline, color, alignment and spacing. Use Save a Copy first.
4. Reopen the copy in Markie. It must still be RTF or ODT with the same text and supported formatting.
5. Return to an unsaved Markdown draft through Library. Its edits must still be there, without a second app shell or a Return to Markie button.

Next, open `samples/Counter.wd` and follow the [interactive Darkmown checks](darkmown.md). Test [media viewers and default-browser links](media-and-links.md) with the supplied media sample. See [document types](document-types.md), [editing and recovery](editing-and-recovery.md), and [connected documents and pending features](connected-documents.md). These are ordinary portable Markdown links. Complete in-app navigation between every document type is a separate pending feature; use Open if a relative link uses the operating system's default app.

## What to test now

| Type or feature | Expected behavior |
| --- | --- |
| DOCX | Supported rich editing and original package-preserving save. Unsupported Word content stays read-only. |
| RTF | Basic rich text and same-format save. Unsupported fields, pictures, tables and other unknown semantics are not flattened into editable content. |
| ODT | Bounded ODF 1.2/1.3 paragraph/span editing and same-format save. Complex layouts, unsupported styles, objects, protection and encryption are refused. |
| TXT, TEXT, LOG | Literal text; Unicode, supported encoding/BOM and line endings preserved. Viewing font/zoom does not alter file contents. |
| Markdown | Existing source/rich/split behavior; main modes belong in View. Markdown stays Markdown. |
| Darkmown WD | Literal source plus explicitly trusted, isolated offline state/buttons/calculations/local forms. Source changes revoke trust. Media, API connections and shared state are not enabled. |
| CSV | Literal source editing and table preview, not a spreadsheet calculation engine. |
| JSON, YAML, XML | Literal source editing, not schema-aware structured editing. |
| Legacy DOC | Explicit text-only copy; original DOC stays untouched. No native DOC writer. |
| HTML | Explicit text-only import with a loss warning. Rich HTML editing is still planned. |
| DOCX print/PDF | Supported-view output on light paper with document geometry. Comments are omitted; pending revisions block output. |
| Library | Search available fields, filter by actual format including RTF/ODT, sort and reset. Recovery, native and cloud copies remain distinct. |
| Cloud snapshots | Existing supported formats only. RTF/ODT/Darkmown cloud upload, live Office multiplayer and new people features are not enabled. |
| Protected vault | Experimental passphrase-based storage. Do not use irreplaceable sensitive originals; biometric keys are not implemented. |

## Report a problem

Include the file type, exact steps, expected result and actual result. Note whether the document came from local disk, local recovery or cloud, and whether a modal or save was active. Use a synthetic sample rather than sending private document contents. Preserve the original when reporting a fidelity issue.

Missing fonts and platform print settings can change appearance. Windows runtime, physical Intel Mac hardware, physical printers and non-Chromium browser behavior require separate acceptance. Local Mac previews are ad-hoc signed, not notarized releases.
