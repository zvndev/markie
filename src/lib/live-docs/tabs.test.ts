import { describe, expect, it } from "vitest";
import { emptyTabs, isDirty, MAX_TABS, tabsReducer, type LiveDocsTabsAction, type LiveDocsTabsState } from "./tabs";

const run = (actions: LiveDocsTabsAction[], from: LiveDocsTabsState = emptyTabs) => actions.reduce(tabsReducer, from);
const open = (path: string, text = `# ${path}\n`, revision = `r-${path}`): LiveDocsTabsAction => ({ type: "opened", path, text, revision });
const tab = (state: LiveDocsTabsState, path: string) => state.tabs.find((item) => item.path === path)!;

describe("tabsReducer", () => {
  it("opens, focuses an already open file, and closes to the neighbour", () => {
    let state = run([open("a.wd"), open("b.skin"), open("c.js")]);
    expect(state.active).toBe("c.js");
    state = tabsReducer(state, open("a.wd", "ignored"));
    expect(state.active).toBe("a.wd");
    expect(state.tabs).toHaveLength(3);
    expect(tab(state, "a.wd").text).toBe("# a.wd\n");
    state = tabsReducer(state, { type: "close", path: "a.wd" });
    expect(state.active).toBe("b.skin");
    state = run([{ type: "activate", path: "c.js" }, { type: "close", path: "c.js" }], state);
    expect(state.active).toBe("b.skin");
  });

  it("tracks unsaved text, and a save that lands while typing continues", () => {
    let state = run([open("a.wd", "one"), { type: "edit", path: "a.wd", text: "two" }]);
    expect(isDirty(tab(state, "a.wd"))).toBe(true);
    state = run([{ type: "saving", path: "a.wd" }, { type: "edit", path: "a.wd", text: "three" }, { type: "saved", path: "a.wd", text: "two", revision: "r2" }], state);
    expect(tab(state, "a.wd")).toMatchObject({ text: "three", savedText: "two", revision: "r2", saving: false });
    expect(isDirty(tab(state, "a.wd"))).toBe(true);
  });

  it("takes an outside edit straight into a clean tab", () => {
    const state = run([open("a.wd", "one", "r1"), { type: "disk-read", path: "a.wd", text: "outside", revision: "r2" }]);
    expect(tab(state, "a.wd")).toMatchObject({ text: "outside", savedText: "outside", revision: "r2", disk: null });
  });

  it("asks before replacing unsaved text with an outside edit, and does what the answer says", () => {
    const changed = run([open("a.wd", "one", "r1"), { type: "edit", path: "a.wd", text: "mine" }, { type: "disk-read", path: "a.wd", text: "outside", revision: "r2" }]);
    expect(tab(changed, "a.wd")).toMatchObject({ text: "mine", revision: "r1", disk: { kind: "changed", text: "outside", revision: "r2" } });
    const reloaded = tabsReducer(changed, { type: "reload", path: "a.wd" });
    expect(tab(reloaded, "a.wd")).toMatchObject({ text: "outside", savedText: "outside", revision: "r2", disk: null });
    const kept = tabsReducer(changed, { type: "keep-mine", path: "a.wd" });
    expect(tab(kept, "a.wd")).toMatchObject({ text: "mine", savedText: "outside", revision: "r2", disk: null });
    expect(isDirty(tab(kept, "a.wd"))).toBe(true);
  });

  it("ignores a read of its own save, and a read that raced a save in flight", () => {
    let state = run([open("a.wd", "one", "r1"), { type: "disk-read", path: "a.wd", text: "one", revision: "r1" }]);
    expect(tab(state, "a.wd").disk).toBeNull();
    state = run([{ type: "edit", path: "a.wd", text: "two" }, { type: "saving", path: "a.wd" }, { type: "disk-read", path: "a.wd", text: "two", revision: "r2" }], state);
    expect(tab(state, "a.wd")).toMatchObject({ saving: true, disk: null, revision: "r1" });
  });

  it("marks a file deleted outside Markie and keeps its text", () => {
    const state = run([open("a.wd", "one"), { type: "edit", path: "a.wd", text: "mine" }, { type: "disk-missing", path: "a.wd" }]);
    expect(tab(state, "a.wd")).toMatchObject({ text: "mine", disk: { kind: "deleted" } });
  });

  it("makes room by closing the oldest clean tab, and refuses when every tab is unsaved", () => {
    let state = emptyTabs;
    for (let i = 0; i < MAX_TABS; i += 1) state = tabsReducer(state, open(`f${i}.wd`));
    state = tabsReducer(state, open("extra.wd"));
    expect(state.tabs).toHaveLength(MAX_TABS);
    expect(state.tabs.some((item) => item.path === "f0.wd")).toBe(false);
    for (const item of state.tabs) state = tabsReducer(state, { type: "edit", path: item.path, text: "dirty" });
    state = tabsReducer(state, open("one-more.wd"));
    expect(state.refused).toBe("one-more.wd");
    expect(state.tabs.some((item) => item.path === "one-more.wd")).toBe(false);
  });
});
