import type { LibraryRecord } from "./document-library";
import type { EditableDocumentFormat } from "./document-session";

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
  create(format: EditableDocumentFormat): void;
  open(record: LibraryRecord): void;
  importFile(): void;
  save(asCopy?: boolean): void;
  share(): void;
  showVault(): void;
  prepareClose(): Promise<boolean>;
  prepareLeave(): Promise<boolean>;
}
