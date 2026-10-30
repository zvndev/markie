// The rich pane's half of local comments: a ProseMirror plugin that paints
// commented passages, and the CommentTarget the panel talks to. Offsets are
// into the same stitched text the find bar uses (rich-find.ts), so a passage
// is found in Rich view the way a search would find it.
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { indexForDoc } from "./rich-find";
import { offsetToPos, rangesForMatches } from "./rich-search";
import type { CommentMark, CommentTarget } from "./comment-target";

export const commentPluginKey = new PluginKey<DecorationSet>("markieLocalComments");

function commentPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: commentPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, previous) {
        const meta = tr.getMeta(commentPluginKey) as
          | Array<{ from: number; to: number; id: string; active: boolean }>
          | undefined;
        if (meta) {
          return DecorationSet.create(
            tr.doc,
            meta.map((m) =>
              Decoration.inline(m.from, m.to, {
                class: m.active ? "markie-local-comment markie-local-comment--active" : "markie-local-comment",
                "data-local-comment-id": m.id,
              })
            )
          );
        }
        return previous.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return commentPluginKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

function ensurePlugin(editor: Editor): void {
  if (commentPluginKey.getState(editor.state) !== undefined) return;
  editor.registerPlugin(commentPlugin());
}

export function richCommentTarget(editor: Editor): CommentTarget {
  const index = () => indexForDoc(editor.state.doc);
  const toOffset = (pos: number): number | null => {
    for (const entry of index().entries) {
      if (pos >= entry.pos && pos <= entry.pos + entry.length) return entry.offset + (pos - entry.pos);
    }
    return null;
  };
  return {
    kind: "rich",
    text: () => index().text,
    selection() {
      const { from, to, empty } = editor.state.selection;
      if (empty) return null;
      const a = toOffset(from);
      const b = toOffset(to);
      return a !== null && b !== null && b > a ? { from: a, to: b } : null;
    },
    mark(marks: CommentMark[]) {
      if (editor.isDestroyed) return;
      ensurePlugin(editor);
      const idx = index();
      const ranges = marks.flatMap((m) => {
        const [range] = rangesForMatches(idx, [m]);
        return range ? [{ ...range, id: m.id, active: m.active }] : [];
      });
      editor.view.dispatch(editor.state.tr.setMeta(commentPluginKey, ranges).setMeta("addToHistory", false));
    },
    reveal(range) {
      if (editor.isDestroyed) return;
      const from = offsetToPos(index(), range.from);
      if (from === null || from > editor.state.doc.content.size) return;
      const { node } = editor.view.domAtPos(from);
      const element = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
      element?.scrollIntoView({ block: "center" });
    },
  };
}
