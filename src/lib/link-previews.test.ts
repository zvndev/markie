// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getLinkPreviewsEnabled, setLinkPreviewsEnabled } from "./link-previews";

beforeEach(() => localStorage.clear());

describe("the link preview switch", () => {
  it("is on for somebody who has never touched it", () => {
    expect(getLinkPreviewsEnabled()).toBe(true);
  });

  it("stays off once turned off", () => {
    setLinkPreviewsEnabled(false);
    expect(getLinkPreviewsEnabled()).toBe(false);
  });

  it("comes back on", () => {
    setLinkPreviewsEnabled(false);
    setLinkPreviewsEnabled(true);
    expect(getLinkPreviewsEnabled()).toBe(true);
  });

  it("reads a value it did not write as on, rather than off", () => {
    // Only an explicit "0" is off. A half-written or corrupted value must not
    // silently disable a feature somebody never turned off.
    localStorage.setItem("markie.linkPreviews.v1", "");
    expect(getLinkPreviewsEnabled()).toBe(true);
  });

  it("tells the open document at once, so the change does not need a reload", () => {
    let heard: unknown = null;
    window.addEventListener("markie:link-previews-changed", (e) => {
      heard = (e as CustomEvent).detail;
    });
    setLinkPreviewsEnabled(false);
    expect(heard).toBe(false);
  });
});
