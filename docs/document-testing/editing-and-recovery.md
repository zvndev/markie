# Editing and recovery checks

[Back to the test guide](README.md) · [Document types](document-types.md)

## One workspace

Create an unsaved Markdown draft. Open a Word, RTF, ODT or text sample, edit it, then select the Markdown draft in Library. Its changes must survive. There should still be one Markie toolbar and activity rail, with no Office ribbon, replacement dashboard or switch-back action.

Repeat in light/dark mode and with a narrow window. Format controls should match the active format, stay reachable and retain visible keyboard focus. Open a Font dialog, press Escape, and confirm that focus returns sensibly. Unsupported menu commands must also refuse direct shortcut execution.

## Saving is not recovery

Local recovery, file saving and downloaded copies are different outcomes. Edit immediately before Save. Reopen the file and check that the newest text was included. An edit made while an earlier revision saves must remain dirty. Cancel a save dialog; it must not claim success.

Recover a revision, switch documents, close and reopen the preview. Restoring recovery must not silently overwrite an external file. Before closing, a recovery failure should keep unsaved work open with an export path.

On a disposable file, make an external change after opening it in Markie. Saving should report a conflict rather than overwrite the external revision. Use Save a Copy to retain your work.

## Library and protected content

Search a recovery document by text, tag or collection. Native rows only search metadata they actually provide; cloud lists should not download every body while filtering. Filter RTF and ODT independently, change sort order and reset it.

Enter the experimental vault only with synthetic material. Lock it and ensure private titles/text are absent from ordinary Library search and the retained editor. Do not mistake passphrase protection for biometric unlock or production security certification.
