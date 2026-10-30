// The source pane's half of local comments: highlights for commented passages
// and the CommentTarget the panel talks to. Lives beside source-find.ts and,
// like it, is imported only by the lazily loaded editor
// (src/components/editor.tsx), so CodeMirror stays out of the entry bundle.
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { CommentMark, CommentTarget } from "./comment-target";

const setCommentMarks = StateEffect.define<CommentMark[]>();

export const commentHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setCommentMarks)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      const limit = tr.state.doc.length;
      const sorted = [...effect.value].sort((a, b) => a.from - b.from || a.to - b.to);
      for (const m of sorted) {
        if (m.from < 0 || m.to > limit || m.to <= m.from) continue;
        builder.add(
          m.from,
          m.to,
          Decoration.mark({
            class: m.active ? "markie-local-comment markie-local-comment--active" : "markie-local-comment",
            attributes: { "data-local-comment-id": m.id },
          })
        );
      }
      return builder.finish();
    }
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function sourceCommentTarget(view: EditorView): CommentTarget {
  return {
    kind: "source",
    text: () => view.state.doc.toString(),
    selection() {
      const { from, to } = view.state.selection.main;
      return to > from ? { from, to } : null;
    },
    mark(marks) {
      view.dispatch({ effects: setCommentMarks.of(marks) });
    },
    reveal(range) {
      if (range.to > view.state.doc.length) return;
      view.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: "center" }) });
    },
  };
}
