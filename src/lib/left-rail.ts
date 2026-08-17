// What the left edge shows.
//
// The activity bar picks between four side panels (library, browse, shared,
// skills) and now a fifth thing that is not a panel at all: the formatting
// rail. They are mutually exclusive because they occupy the same strip of
// screen, so "which one is showing" is a single choice rather than two
// independent booleans that can both be true.
//
// Before this, the rail was always on whenever the rich pane was, which meant
// a column of H1/H2/B sat next to the file browser while you were picking a
// file, and stayed there on a document you had no permission to change.

// The views that own a side panel...
export type PanelView = "library" | "browse" | "shared" | "skills";
// ...and everything the activity bar can select, which includes one that does
// not: the formatting rail.
export type LeftView = PanelView | "edit";

export const PANEL_VIEWS: PanelView[] = ["library", "browse", "shared", "skills"];

export function isPanelView(view: LeftView): view is PanelView {
  return (PANEL_VIEWS as LeftView[]).includes(view);
}

export interface LeftState {
  view: LeftView;
  // Whether the side panel has been toggled open. Meaningless for "edit",
  // which has no panel.
  panelOpen: boolean;
  // The rich pane is on screen: split or preview, not source-only.
  richVisible: boolean;
  canEdit: boolean;
}

// The rail appears only when the pencil is the chosen view, and only where
// there is a rich editor for it to act on.
export function showFormatRail(state: LeftState): boolean {
  return state.view === "edit" && state.richVisible;
}

// Shown but inert, rather than hidden, when the document is read-only: a
// control that vanishes leaves you wondering where it went, one that is
// visibly greyed tells you the document is not yours to change.
export function formatRailDisabled(state: LeftState): boolean {
  return !state.canEdit;
}

export function showSidePanel(state: LeftState): boolean {
  return state.panelOpen && isPanelView(state.view);
}

// Clicking an activity-bar item. Clicking the current panel again closes it,
// which is how every editor's sidebar behaves; the pencil has no panel to
// close, so clicking it again returns you to whichever panel you last had.
export function selectLeftView(
  current: LeftState,
  clicked: LeftView,
  previousPanel: LeftView = "library"
): { view: LeftView; panelOpen: boolean } {
  if (clicked === "edit") {
    if (current.view === "edit") return { view: previousPanel, panelOpen: true };
    return { view: "edit", panelOpen: false };
  }
  const closing = current.panelOpen && current.view === clicked;
  return { view: clicked, panelOpen: !closing };
}
