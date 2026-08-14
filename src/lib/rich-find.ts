// The rich pane's half of find and replace.
//
// Everything here is the ProseMirror-specific glue: walking the document for
// text, painting highlights, and rewriting ranges. The arithmetic that decides
// which characters matched lives in doc-search.ts and rich-search.ts, where it
// can be tested without an editor.

import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import type { Match } from "./doc-search";
import type { FindTarget } from "./find-target";
import {
  indexSegments,
  offsetToPos,
  rangesForMatches,
  type PosRange,
  type TextSegment,
} from "./rich-search";

// Walk the document for its text, one textblock at a time.
//
// Textblocks do not nest, so descending into one and stopping there collects
// every inline run in it and gives each run the block it belongs to. That
// grouping is what keeps a search from matching across a paragraph break.
export function collectSegments(doc: PMNode): TextSegment[] {
  const segments: TextSegment[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let at = pos + 1;
    node.forEach((child) => {
      if (child.isText && child.text) {
        segments.push({ pos: at, text: child.text, block: pos });
      }
      at += child.nodeSize;
    });
    return false;
  });
  return segments;
}

export const findPluginKey = new PluginKey<DecorationSet>("markieFind");

interface FindMeta {
  ranges: PosRange[];
  current: number;
}

// Highlights live in a plugin rather than in the document, so nothing about
// searching can end up saved to the file.
export function findHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: findPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, previous) {
        const meta = tr.getMeta(findPluginKey) as FindMeta | undefined;
        if (meta) {
          return DecorationSet.create(
            tr.doc,
            meta.ranges.map((range, i) =>
              Decoration.inline(range.from, range.to, {
                class:
                  i === meta.current
                    ? "markie-find-hit markie-find-hit--current"
                    : "markie-find-hit",
              })
            )
          );
        }
        // Map through edits so a highlight follows the text it was drawn on
        // instead of sliding onto whatever ends up at that position.
        return previous.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return findPluginKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

function scrollTo(editor: Editor, pos: number): void {
  const view = editor.view;
  if (pos < 0 || pos > view.state.doc.content.size) return;
  const { node } = view.domAtPos(pos);
  const element = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  element?.scrollIntoView({ block: "center" });
}

export function richFindTarget(editor: Editor): FindTarget {
  // Rebuilt per call rather than cached: the document changes under the find
  // bar constantly, and a stale index maps matches onto the wrong characters.
  const index = () => indexSegments(collectSegments(editor.state.doc));

  const send = (matches: Match[], current: number) => {
    const idx = index();
    const ranges = rangesForMatches(idx, matches);
    editor.view.dispatch(
      editor.state.tr.setMeta(findPluginKey, {
        ranges,
        current,
      } satisfies FindMeta)
    );
    return ranges;
  };

  return {
    text: () => index().text,

    // The editor's caret is a document position; the bar works in offsets, and
    // scanning the runs converts back. Falls back to the start of the document
    // rather than guessing when the caret is somewhere with no text.
    caret() {
      const idx = index();
      const head = editor.state.selection.head;
      let last = 0;
      for (const entry of idx.entries) {
        if (entry.pos > head) break;
        if (head <= entry.pos + entry.length) {
          return entry.offset + (head - entry.pos);
        }
        last = entry.offset + entry.length;
      }
      return last;
    },

    highlight(matches, current) {
      send(matches, current);
    },

    reveal(match) {
      const idx = index();
      const [range] = rangesForMatches(idx, [match]);
      if (range) scrollTo(editor, range.from);
    },

    // One transaction for the whole set, applied right to left so the
    // positions computed from the current document all stay valid.
    replace(matches, replacement) {
      const idx = index();
      const ranges = rangesForMatches(idx, matches);
      if (ranges.length === 0) return;
      const { state } = editor.view;
      const tr = state.tr;
      for (let i = ranges.length - 1; i >= 0; i -= 1) {
        const { from, to } = ranges[i];
        if (replacement) {
          // Carry the marks of the text being replaced, so replacing a word
          // inside a bold run does not leave a plain word in the middle of it.
          const marks = state.doc.resolve(from).marks();
          tr.replaceWith(from, to, state.schema.text(replacement, marks));
        } else {
          tr.delete(from, to);
        }
      }
      editor.view.dispatch(tr);
    },

    release(match) {
      editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, {
        ranges: [],
        current: -1,
      } satisfies FindMeta));
      if (match) {
        const idx = index();
        const pos = offsetToPos(idx, match.from);
        if (pos !== null) {
          const { state } = editor.view;
          const to = Math.min(pos, state.doc.content.size);
          editor.view.dispatch(
            state.tr.setSelection(TextSelection.create(state.doc, to))
          );
        }
      }
      editor.view.focus();
    },
  };
}
