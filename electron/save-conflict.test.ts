import { describe, expect, it } from "vitest";
const { saveConflictAction } = require("./save-conflict.js");

describe("saveConflictAction", () => {
  it("proceeds when the disk is unchanged", () => {
    expect(saveConflictAction({ autosave: false, force: false, changed: null })).toBe("proceed");
    expect(saveConflictAction({ autosave: true, force: false, changed: null })).toBe("proceed");
  });
  it("force always proceeds (the user already answered in-app)", () => {
    expect(saveConflictAction({ autosave: false, force: true, changed: "x" })).toBe("proceed");
    expect(saveConflictAction({ autosave: true, force: true, changed: "x" })).toBe("proceed");
  });
  it("a manual save over a changed disk asks", () => {
    expect(saveConflictAction({ autosave: false, force: false, changed: "x" })).toBe("ask");
  });
  it("an autosave over a changed disk refuses without asking", () => {
    expect(saveConflictAction({ autosave: true, force: false, changed: "x" })).toBe("refuse");
  });
  it("treats an empty disk file as a real change, not as nothing", () => {
    // "" is falsy; a file an agent truncated must still stop an autosave.
    expect(saveConflictAction({ autosave: true, force: false, changed: "" })).toBe("refuse");
    expect(saveConflictAction({ autosave: false, force: false, changed: "" })).toBe("ask");
  });
  it("defaults to the old manual behavior when called with nothing", () => {
    expect(saveConflictAction()).toBe("proceed");
  });
});
