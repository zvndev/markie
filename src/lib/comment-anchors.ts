// Comment anchors are relative positions into the shared Yjs document, so
// they survive concurrent edits; they round-trip through the server as
// opaque JSON. This is the half of the comments module that needs yjs and
// the ProseMirror binding, kept apart from the client and the types
// (src/lib/comments.ts) so that only the live-session chunk
// (src/lib/collab-runtime.ts) carries them.
import type { Editor } from "@tiptap/react";
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

type YMapping = Parameters<typeof absolutePositionToRelativePosition>[2];

interface YSyncState {
  type: Y.XmlFragment;
  binding?: { mapping: YMapping } | null;
}

function syncState(editor: Editor): YSyncState | null {
  const state = ySyncPluginKey.getState(editor.state) as YSyncState | null;
  return state?.binding ? state : null;
}

// Editor selection → serializable anchor
export function selectionToAnchor(
  editor: Editor,
  from: number,
  to: number
): { from: unknown; to: unknown } | null {
  const ystate = syncState(editor);
  if (!ystate) return null;
  const relFrom = absolutePositionToRelativePosition(
    from,
    ystate.type,
    ystate.binding!.mapping
  );
  const relTo = absolutePositionToRelativePosition(
    to,
    ystate.type,
    ystate.binding!.mapping
  );
  if (!relFrom || !relTo) return null;
  return {
    from: Y.relativePositionToJSON(relFrom),
    to: Y.relativePositionToJSON(relTo),
  };
}

// Anchor → current absolute positions; null when the text was deleted
export function anchorToAbsolute(
  editor: Editor,
  ydoc: Y.Doc,
  anchor: { from: unknown; to: unknown }
): { from: number; to: number } | null {
  const ystate = syncState(editor);
  if (!ystate) return null;
  try {
    const from = relativePositionToAbsolutePosition(
      ydoc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.from),
      ystate.binding!.mapping
    );
    const to = relativePositionToAbsolutePosition(
      ydoc,
      ystate.type,
      Y.createRelativePositionFromJSON(anchor.to),
      ystate.binding!.mapping
    );
    if (from == null || to == null) return null;
    return { from, to };
  } catch {
    return null;
  }
}
