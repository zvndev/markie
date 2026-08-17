// Where ⌘Z should go.
//
// Markie has three things on screen that keep their own undo history: the rich
// editor (ProseMirror), the source editor (CodeMirror), and ordinary text
// inputs like the find box and the rename field. Each has its own stack, and
// none of them can undo the others.
//
// The Edit menu used to use Electron's { role: "undo" }, which runs the
// webContents' native undo. That knows about form fields and nothing else, so
// in a document it either did nothing or undid something the editor had no
// record of — which is exactly what "⌘Z doesn't work properly" felt like.

export type UndoTarget = "rich" | "source" | "native" | "none";

// Decided from where focus actually is, because that is what the user means by
// "undo my last thing". Walking up from the focused element rather than asking
// each editor whether it thinks it has focus: only one element is focused, and
// the DOM already knows which.
export function undoTargetFor(
  active: Element | null,
  options: { hasRich?: boolean; hasSource?: boolean } = {}
): UndoTarget {
  if (!active) return options.hasRich ? "rich" : options.hasSource ? "source" : "none";

  // A plain input or textarea keeps its own native history, and taking ⌘Z away
  // from the find box to undo a paragraph would be its own bug.
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "native";

  if (active.closest(".cm-editor")) return "source";
  if (active.closest(".ProseMirror")) return "rich";

  // Focus is somewhere neutral — a button, the body. Fall back to the pane
  // that is showing, preferring rich because that is the mode Markie opens in.
  if (options.hasRich) return "rich";
  if (options.hasSource) return "source";
  return "none";
}
