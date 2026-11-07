import type { LibraryRecord } from "./document-library";
import type { EditableDocumentFormat } from "./document-session";
import type { DocumentCommandTarget } from "./document-commands";

/** What Make interactive hands the workspace: a new, unsaved .wd. */
export interface InteractiveDraft {
  /** The suggested file name, ending in .wd. */
  name: string;
  /** The Markdown exactly as it stands, unsaved edits included. */
  text: string;
  /** The Markdown file it came from, so its pictures show until the copy is saved. */
  pictureOrigin: string | null;
}

/** Format-specific content plugs into Markie's existing app controls. */
export interface DocumentShellState {
  name: string | null;
  dirty: boolean;
  hasSession: boolean;
  private: boolean;
  ready: boolean;
  busy: boolean;
  records: readonly LibraryRecord[];
  selectedId?: string;
  renderer?: "word" | "text" | "none";
  commands?: DocumentCommandTarget;
  create(format: EditableDocumentFormat): void;
  open(record: LibraryRecord): void;
  importFile(): void;
  save(asCopy?: boolean): void;
  share(): void;
  /**
   * Make interactive (Live Docs, super-nightly): open a new, unsaved .wd with
   * this text. False when the workspace cannot take it right now.
   */
  createFrom?(draft: InteractiveDraft): boolean;
  /** Open an existing ordinary cloud snapshot, without creating a local file. */
  openCloudDocument?(id: string): void;
  /** Complete queued native imports before opening the next file in a mixed drop. */
  settleIncomingDocuments?(): Promise<boolean>;
  showVault(): void;
  prepareClose(): Promise<boolean>;
  prepareLeave(): Promise<boolean>;
}
