import type { LibraryRecord } from "./document-library";
import type { EditableDocumentFormat } from "./document-session";
import type { DocumentCommandTarget } from "./document-commands";

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
  /** Open an existing ordinary cloud snapshot, without creating a local file. */
  openCloudDocument?(id: string): void;
  /** Complete queued native imports before opening the next file in a mixed drop. */
  settleIncomingDocuments?(): Promise<boolean>;
  showVault(): void;
  prepareClose(): Promise<boolean>;
  prepareLeave(): Promise<boolean>;
}
