import { describe, expect, it } from "vitest";
import {
  formatRailDisabled,
  isPanelView,
  selectLeftView,
  showFormatRail,
  showSidePanel,
  type LeftState,
} from "./left-rail";

const state = (over: Partial<LeftState> = {}): LeftState => ({
  view: "library",
  panelOpen: true,
  richVisible: true,
  canEdit: true,
  ...over,
});

describe("when the formatting rail shows", () => {
  it("shows on the pencil", () => {
    expect(showFormatRail(state({ view: "edit", panelOpen: false }))).toBe(true);
  });

  // The complaint that prompted this: a column of H1/H2/B beside the file
  // browser, while you were browsing files.
  it("stays away while a panel is selected", () => {
    for (const view of ["library", "browse", "shared", "skills"] as const) {
      expect(showFormatRail(state({ view }))).toBe(false);
    }
  });

  it("stays away when there is no rich editor to act on", () => {
    expect(showFormatRail(state({ view: "edit", richVisible: false }))).toBe(false);
  });

  it("is inert rather than absent on a document you cannot change", () => {
    const readOnly = state({ view: "edit", panelOpen: false, canEdit: false });
    expect(showFormatRail(readOnly)).toBe(true);
    expect(formatRailDisabled(readOnly)).toBe(true);
  });

  it("is live on a document you can", () => {
    expect(formatRailDisabled(state({ view: "edit", canEdit: true }))).toBe(false);
  });
});

describe("when the side panel shows", () => {
  it("shows for the panel views and not for the pencil", () => {
    expect(showSidePanel(state({ view: "library" }))).toBe(true);
    expect(showSidePanel(state({ view: "edit", panelOpen: true }))).toBe(false);
  });

  it("stays closed once closed", () => {
    expect(showSidePanel(state({ panelOpen: false }))).toBe(false);
  });

  it("knows which views own a panel", () => {
    expect(isPanelView("skills")).toBe(true);
    expect(isPanelView("edit")).toBe(false);
  });
});

describe("clicking the activity bar", () => {
  it("opens a panel and puts the rail away", () => {
    const next = selectLeftView(state({ view: "edit", panelOpen: false }), "browse");
    expect(next).toEqual({ view: "browse", panelOpen: true });
    expect(showFormatRail({ ...state(), ...next })).toBe(false);
  });

  it("shows the rail and puts the panel away", () => {
    const next = selectLeftView(state({ view: "library" }), "edit");
    expect(next).toEqual({ view: "edit", panelOpen: false });
    expect(showSidePanel({ ...state(), ...next })).toBe(false);
  });

  it("closes a panel when its own icon is clicked again", () => {
    expect(selectLeftView(state({ view: "library", panelOpen: true }), "library")).toEqual({
      view: "library",
      panelOpen: false,
    });
  });

  it("reopens a closed panel rather than toggling it off twice", () => {
    expect(selectLeftView(state({ view: "library", panelOpen: false }), "library")).toEqual({
      view: "library",
      panelOpen: true,
    });
  });

  // The pencil has no panel to collapse, so clicking it twice has to mean
  // something: it goes back where you were.
  it("returns to the last panel when the pencil is clicked again", () => {
    expect(selectLeftView(state({ view: "edit", panelOpen: false }), "edit", "skills")).toEqual({
      view: "skills",
      panelOpen: true,
    });
  });
});
