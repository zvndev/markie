// What the editor needs to save a file on this phone back in place. It is the
// whole of the editor's knowledge of local files: no server call is in it.
import { LocalFileError, type LocalDocument, type LocalFiles } from "./local-files";

export interface LocalEditing {
  /** Writes the text back to the file. Throws LocalFileError; "changed" means the person is asked first. */
  save(text: string, options?: { overwrite?: boolean }): Promise<void>;
  /** The file's text as it is on the device now, to compare with. */
  current(): Promise<string>;
  /** In a folder: saves the text as a second file beside the first. Null for a file opened on its own. */
  keepBoth: ((text: string) => Promise<{ name: string }>) | null;
  /** Closes the editor on the file's own version, dropping the text typed here. */
  takeFile(): Promise<void>;
  /** Closes the editor and the file: it is gone from the device. */
  leave(): void;
}

/** `saved` gets the document as it now stands on the device; `gone` when it is no longer there. */
export function localEditing(files: LocalFiles, doc: LocalDocument, on: { saved: (doc: LocalDocument) => void; gone: () => void }): LocalEditing {
  return {
    async save(text, options) {
      on.saved(await files.save(doc, text, options));
    },
    current: async () => (await files.open(doc.ref)).content,
    keepBoth: doc.ref.entry !== null && doc.ref.parent !== undefined ? (text) => files.saveBeside(doc, text) : null,
    async takeFile() {
      on.saved(await files.open(doc.ref));
    },
    leave: on.gone,
  };
}

/** The file holds something other than what the editor opened. */
export function isChangedUnderneath(error: unknown): boolean {
  return error instanceof LocalFileError && (error.code === "changed" || error.code === "missing");
}
