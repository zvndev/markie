// What the find bar needs from a pane, and nothing more.
//
// The two panes are completely different editors showing the same document, so
// the bar talks to both through this. Everything it does is expressed in
// offsets into the pane's own text: the bar never learns what a ProseMirror
// position or a CodeMirror range is.

import type { Match } from "./doc-search";

export interface FindTarget {
  // The pane's searchable text. The source pane returns markdown; the rich pane
  // returns what is actually on screen, so the two legitimately disagree about
  // how many times "**" appears. Each is right about what it is showing.
  text(): string;
  // Where the caret is, so a fresh search starts from what you were reading
  // instead of the top of the file.
  caret(): number;
  // Draw every match, with one of them marked current. Called again on every
  // keystroke in the search box, so it has to be cheap and idempotent.
  highlight(matches: Match[], current: number): void;
  // Bring a match into view. Separate from highlight because stepping between
  // matches scrolls and retyping the query should not.
  reveal(match: Match): void;
  // Replace the given matches in one undoable step. Never called when the
  // document is read-only.
  replace(matches: Match[], replacement: string): void;
  // Put the caret on a match and hand focus back to the pane, so closing the
  // bar leaves you where you searched to.
  release(match: Match | null): void;
}
