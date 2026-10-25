# Interactive Darkmown checks

[Back to the test guide](README.md) · [Document types](document-types.md) · [Connected documents](connected-documents.md)

Open `samples/Counter.wd` using Markie's normal Open button. `.wd` is a separate document type; ordinary `.md` files remain Markdown. The existing Markie shell and source formatting controls stay in place. Choose Darkmown Source, Darkmown Preview or Darkmown Source and Preview from the native View menu or command palette, not a new top-bar mode toggle.

## Trust and real interaction

1. Before trusting, the preview is inactive. Its buttons must not update state.
2. Review the source, then choose **Trust this document**. This enables only the isolated local runtime for this exact source, not unrestricted document code or account access.
3. Click **Add one** twice. Count should become 2 and Double should become 4. Subtract one should update both values.
4. Choose **Reset state**. Count should return to the authored default of 0; the source must not change.
5. Change the source default to 5. Trust must be revoked immediately. Trust the changed source; Count should start at 5.
6. Choose **Revoke trust**, switch documents or open a blocking tool. The running preview must be destroyed. Reopening or recovering source must not restore trust or runtime state.

Open `samples/Local-form.wd`, trust it, enter a name and choose **Use this name**. The submitted name should update in the document without navigation or a network request.

## Saving and recovery

Save a Copy with the `.wd` extension, then reopen it. Authored directives/defaults and supported encoding/BOM/line endings must remain intact. Temporary counter/form values are not saved into source or shared state. Undo/Redo and Find edit the literal source, not the preview DOM. Local recovery keeps a separate Darkmown type, and Library can filter by Darkmown.

## Current boundaries

This milestone supports bounded single-source, offline interactive documents: state, buttons, supported inputs, numeric subtraction/multiplication/division/remainder and local forms. Computed addition/string concatenation, formatter pipelines, loops and includes are not available yet. Conditional blocks (`:if`), `:store`, persistence, timers, effects, fetches, media directives and button actions that change lists or objects are switched off with a notice, and column alignment colons in a table are dropped with a notice. The [agent-written document checks](agent-documents.md) try each one. These restrictions prevent small documents from expanding into unbounded intermediate data. Preview compilation is limited to 128,000 characters, 5,000 lines and a conservative complexity budget, with a disposable compiler worker and a ten-second time limit including cold worker startup. Larger or unsupported source remains editable/saveable. Preview errors must not replace or truncate source.

The sandbox does not permit network access, external files, account tokens, persistent storage, navigation, arbitrary JavaScript or embedded pages. Unsupported runtime features/resources are removed or refused with a notice. `.skin`, adjacent assets/includes, image/video permissions, API connectors, document-defined host-toolbar controls, persistent/personal/shared state and Darkmown cloud/vault integration remain pending. Do not put API keys or other secrets in portable source.

These limits are deliberate capability boundaries, not a claim that the complete interactive-document roadmap is finished.
