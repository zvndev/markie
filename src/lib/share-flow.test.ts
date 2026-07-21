import { describe, expect, it } from "vitest";
import { shareActionFor } from "./share-flow";

describe("share button flow", () => {
  it("opens the dialog for a synced doc", () => {
    expect(shareActionFor({ cloudDocId: "abc", signedIn: true })).toBe(
      "open-dialog"
    );
  });

  it("opens the dialog for a doc synced after the page last looked", () => {
    // Regression: canShare was computed once per file open, so syncing from
    // the Library left Share pointing at "sync first" forever. The action must
    // come from the click-time registry entry, not mounted state.
    expect(shareActionFor({ cloudDocId: "fresh-id", signedIn: true })).toBe(
      "open-dialog"
    );
  });

  it("guides through sign-in before anything else", () => {
    expect(shareActionFor({ cloudDocId: "abc", signedIn: false })).toBe(
      "sign-in"
    );
    expect(shareActionFor({ cloudDocId: null, signedIn: false })).toBe(
      "sign-in"
    );
  });

  it("guides a signed-in user to sync an unsynced doc", () => {
    expect(shareActionFor({ cloudDocId: null, signedIn: true })).toBe(
      "sync-first"
    );
    expect(shareActionFor({ cloudDocId: undefined, signedIn: true })).toBe(
      "sync-first"
    );
  });
});
