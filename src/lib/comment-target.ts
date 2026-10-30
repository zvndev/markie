// What the local comments panel needs from a pane, and nothing more.
//
// Shaped like find-target.ts: everything is in offsets into the pane's own
// text. The source pane's text is the markdown; the rich pane's is what is on
// screen, and src/lib/local-comments.ts maps between the two.

export interface CommentMark {
  from: number;
  to: number;
  id: string;
  active: boolean;
}

export interface CommentTarget {
  /** Which pane this is: "source" offsets are markdown, "rich" are visible text. */
  kind: "source" | "rich";
  text(): string;
  /** The current non-empty selection, or null. */
  selection(): { from: number; to: number } | null;
  /** Draw every commented passage. Called again whenever threads or text change. */
  mark(marks: CommentMark[]): void;
  /** Scroll a passage into view. The panel marks it active; the selection is left alone. */
  reveal(range: { from: number; to: number }): void;
}

/** The thread a click landed on, from the data attribute both panes paint. */
export function commentIdAt(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest("[data-local-comment-id]") : null;
  return el ? el.getAttribute("data-local-comment-id") : null;
}
