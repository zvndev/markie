// @vitest-environment jsdom
// The rich editor drew a cloud document's synced pictures broken: their
// relative src resolved against the app's own address. The editor now
// fetches them as the reader does and resolves each reference to its bytes.
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAssetSrc } from "@/lib/asset-url";
import { pictureRefs, useEditorPictures } from "../src/lib/editor-pictures";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:picture-${++n}`);
  URL.revokeObjectURL = vi.fn();
});

const DOC = "# Report\n\n![chart](charts/opened%20per%20day.png)\n\n![web](https://example.com/a.png)\n\n![missing](charts/gone.png)\n";

let unmount: (() => void) | null = null;
afterEach(() => { act(() => unmount?.()); unmount = null; });

describe("a cloud document's pictures in the rich editor", () => {
  it("finds the same references the reader fetches", () => {
    expect(pictureRefs(DOC)).toEqual(["charts/opened per day.png", "charts/gone.png"]);
  });

  it("holds the first draw until they arrive, then resolves each one to its bytes", async () => {
    const load = vi.fn(async (ref: string) => (ref === "charts/gone.png" ? null : new Blob(["png"], { type: "image/png" })));
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useEditorPictures(load, DOC));
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    unmount = () => root.unmount();
    await act(async () => { root.render(createElement(Probe)); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });

    expect(seen[0]).toBe(false);
    expect(seen[seen.length - 1]).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(resolveAssetSrc("charts/opened%20per%20day.png")).toMatch(/^blob:picture-/);
    // One that never came is drawn as written, and a web picture is untouched.
    expect(resolveAssetSrc("charts/gone.png")).toBe("charts/gone.png");
    expect(resolveAssetSrc("https://example.com/a.png")).toBe("https://example.com/a.png");

    act(() => unmount?.());
    unmount = null;
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    // Gone with the screen: nothing else resolves through it.
    expect(resolveAssetSrc("charts/opened%20per%20day.png")).toBe("charts/opened%20per%20day.png");
  });

  it("does not wait at all for a document with no pictures of its own", async () => {
    const load = vi.fn(async () => null);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useEditorPictures(load, "# Plain\n\nNo pictures.\n"));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    unmount = () => root.unmount();
    await act(async () => { root.render(createElement(Probe)); });
    expect(seen.every(Boolean)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
});
