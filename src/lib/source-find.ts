// The source pane's half of find and replace.
//
// CodeMirror ships its own search panel, and Markie deliberately does not use
// it: two panes with two different search UIs, two different sets of options
// and two different match counts is worse than one bar that behaves the same
// wherever you are. The panel is suppressed in editor-keymap.ts and this
// replaces it.

import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { Match } from "./doc-search";
import type { FindTarget } from "./find-target";

export const setFindHits = StateEffect.define<{
  matches: Match[];
  current: number;
}>();

const hit = Decoration.mark({ class: "markie-find-hit" });
const currentHit = Decoration.mark({
  class: "markie-find-hit markie-find-hit--current",
});

export const findHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setFindHits)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      const limit = tr.state.doc.length;
      for (let i = 0; i < effect.value.matches.length; i += 1) {
        const { from, to } = effect.value.matches[i];
        // A match computed against a document that has since changed would
        // throw when added out of range; drop it and let the next search pass
        // put it back.
        if (from < 0 || to > limit || to <= from) continue;
        builder.add(from, to, i === effect.value.current ? currentHit : hit);
      }
      return builder.finish();
    }
    // Follow the text through edits rather than sitting at fixed offsets.
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function sourceFindTarget(view: EditorView): FindTarget {
  const send = (matches: Match[], current: number) => {
    view.dispatch({ effects: setFindHits.of({ matches, current }) });
  };

  return {
    text: () => view.state.doc.toString(),
    caret: () => view.state.selection.main.head,

    highlight(matches, current) {
      send(matches, current);
    },

    reveal(match) {
      if (match.to > view.state.doc.length) return;
      view.dispatch({
        effects: EditorView.scrollIntoView(match.from, { y: "center" }),
      });
    },

    // One dispatch for the whole set. CodeMirror expects the ranges in the
    // coordinates of the document it currently holds and shifts them itself,
    // so unlike a string rewrite these do not have to be applied backwards.
    replace(matches, replacement) {
      if (matches.length === 0) return;
      view.dispatch({
        changes: matches.map((m) => ({
          from: m.from,
          to: m.to,
          insert: replacement,
        })),
      });
    },

    release(match) {
      send([], -1);
      if (match && match.to <= view.state.doc.length) {
        view.dispatch({ selection: { anchor: match.from, head: match.to } });
      }
      view.focus();
    },
  };
}
