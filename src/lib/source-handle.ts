// What the page needs from the source editor, without the editor.
//
// CodeMirror and its markdown grammar are loaded when the source pane first
// mounts (src/components/source-editor.tsx), not at launch, so nothing outside
// that pane may import from @codemirror. The page used to hold the EditorView
// itself and call CodeMirror's undo and find on it; now the editor hands over
// this handle, built on its side of the line, and the page never learns what
// is behind it.
import type { FindTarget } from "@/lib/find-target";

export interface SourceHandle {
  undo(): void;
  redo(): void;
  focus(): void;
  /** The find bar's view of this pane; see src/lib/source-find.ts. */
  findTarget(): FindTarget;
}
