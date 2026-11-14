// The Live Docs area's editor tabs (super-nightly, step M3): one entry per
// open project file, what is in the editor, what is on disk, and what changed
// on disk that the editor has not taken in yet.
//
// A tab is dirty when its text differs from the text it was last read or
// saved as. `revision` is main's hash of the file's bytes at that moment, and
// every save sends it back, so main refuses a save over an outside edit the
// person has not seen.

export interface LiveDocsTab {
  path: string;
  text: string;
  /** The file's text as of `revision`. */
  savedText: string;
  revision: string;
  saving: boolean;
  /** An outside change waiting for a decision: reload it, or keep the editor's text. */
  disk: null | { kind: "changed"; text: string; revision: string } | { kind: "deleted" };
  error: string | null;
}

export interface LiveDocsTabsState {
  tabs: LiveDocsTab[];
  active: string | null;
  /** Set when a file could not get a tab because every open tab has unsaved changes. */
  refused: string | null;
}

/** Each open tab keeps its editor, and its undo history, mounted. */
export const MAX_TABS = 12;

export const emptyTabs: LiveDocsTabsState = { tabs: [], active: null, refused: null };

export const isDirty = (tab: LiveDocsTab) => tab.text !== tab.savedText;

export type LiveDocsTabsAction =
  | { type: "opened"; path: string; text: string; revision: string }
  | { type: "activate"; path: string }
  | { type: "close"; path: string }
  | { type: "edit"; path: string; text: string }
  | { type: "saving"; path: string }
  | { type: "saved"; path: string; text: string; revision: string }
  | { type: "save-failed"; path: string; message: string }
  | { type: "disk-read"; path: string; text: string; revision: string }
  | { type: "disk-missing"; path: string }
  | { type: "reload"; path: string }
  | { type: "keep-mine"; path: string }
  | { type: "reset" };

function update(state: LiveDocsTabsState, path: string, change: (tab: LiveDocsTab) => LiveDocsTab): LiveDocsTabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.path !== path) return tab;
    const next = change(tab);
    if (next !== tab) changed = true;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

export function tabsReducer(state: LiveDocsTabsState, action: LiveDocsTabsAction): LiveDocsTabsState {
  switch (action.type) {
    case "opened": {
      if (state.tabs.some((tab) => tab.path === action.path)) return { ...state, active: action.path, refused: null };
      let tabs = state.tabs;
      if (tabs.length >= MAX_TABS) {
        // Make room by closing the oldest tab with nothing unsaved.
        const evict = tabs.find((tab) => tab.path !== state.active && !isDirty(tab) && !tab.saving && !tab.disk)
          ?? tabs.find((tab) => !isDirty(tab) && !tab.saving && !tab.disk);
        if (!evict) return { ...state, refused: action.path };
        tabs = tabs.filter((tab) => tab !== evict);
      }
      const tab: LiveDocsTab = { path: action.path, text: action.text, savedText: action.text, revision: action.revision, saving: false, disk: null, error: null };
      return { tabs: [...tabs, tab], active: action.path, refused: null };
    }
    case "activate":
      return state.tabs.some((tab) => tab.path === action.path) ? { ...state, active: action.path } : state;
    case "close": {
      const at = state.tabs.findIndex((tab) => tab.path === action.path);
      if (at < 0) return state;
      const tabs = state.tabs.filter((_, index) => index !== at);
      const active = state.active !== action.path ? state.active : (tabs[at] ?? tabs[at - 1] ?? null)?.path ?? null;
      return { ...state, tabs, active };
    }
    case "edit":
      return update(state, action.path, (tab) => (tab.text === action.text ? tab : { ...tab, text: action.text, error: null }));
    case "saving":
      return update(state, action.path, (tab) => ({ ...tab, saving: true, error: null }));
    case "saved":
      // `text` is what was written; anything typed during the save stays dirty.
      return update(state, action.path, (tab) => ({ ...tab, saving: false, savedText: action.text, revision: action.revision, disk: null, error: null }));
    case "save-failed":
      return update(state, action.path, (tab) => ({ ...tab, saving: false, error: action.message }));
    case "disk-read":
      return update(state, action.path, (tab) => {
        // A read that raced a save in flight says nothing the save will not.
        if (tab.saving) return tab;
        if (action.revision === tab.revision) return tab.disk ? { ...tab, disk: null } : tab;
        // The editor already says what the disk now says.
        if (action.text === tab.text) return { ...tab, savedText: action.text, revision: action.revision, disk: null };
        // Nothing unsaved to lose: take the outside edit in.
        if (!isDirty(tab)) return { ...tab, text: action.text, savedText: action.text, revision: action.revision, disk: null };
        return { ...tab, disk: { kind: "changed", text: action.text, revision: action.revision } };
      });
    case "disk-missing":
      return update(state, action.path, (tab) => (tab.saving || tab.disk?.kind === "deleted" ? tab : { ...tab, disk: { kind: "deleted" } }));
    case "reload":
      return update(state, action.path, (tab) => (tab.disk?.kind === "changed"
        ? { ...tab, text: tab.disk.text, savedText: tab.disk.text, revision: tab.disk.revision, disk: null, error: null }
        : tab));
    case "keep-mine":
      // The next save replaces the outside edit, on purpose: the editor now
      // counts its text as a change from what is on disk.
      return update(state, action.path, (tab) => (tab.disk?.kind === "changed"
        ? { ...tab, savedText: tab.disk.text, revision: tab.disk.revision, disk: null, error: null }
        : tab.disk ? { ...tab, disk: null } : tab));
    case "reset":
      return emptyTabs;
  }
}
