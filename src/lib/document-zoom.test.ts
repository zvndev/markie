import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinchZoom, readDocumentZoom, writeDocumentZoom, zoomForCommand } from "./document-zoom";

afterEach(() => localStorage.clear());

describe("document zoom", () => {
  it("remembers one zoom for every document editor and clamps what it reads", () => {
    expect(readDocumentZoom()).toBe(1);
    writeDocumentZoom(1.25);
    expect(readDocumentZoom()).toBe(1.25);
    localStorage.setItem("markie.documents.zoom.v1", "9");
    expect(readDocumentZoom()).toBe(2);
    localStorage.setItem("markie.documents.zoom.v1", "nope");
    expect(readDocumentZoom()).toBe(1);
  });

  it("steps through the same zoom levels as the toolbar", () => {
    expect(zoomForCommand(1, "zoom-in")).toBe(1.1);
    expect(zoomForCommand(1, "zoom-out")).toBe(0.9);
    expect(zoomForCommand(2, "zoom-in")).toBe(2);
    expect(zoomForCommand(1.5, "view-zoom-reset")).toBe(1);
    expect(zoomForCommand(1, "find")).toBeNull();
  });

  it("turns a pinch into a few steps, not one per wheel event", () => {
    const onStep = vi.fn();
    const pinch = createPinchZoom(onStep);
    for (let i = 0; i < 10; i++) pinch({ ctrlKey: true, deltaY: -8, deltaMode: 0, timeStamp: i * 10 });
    expect(onStep.mock.calls).toEqual([[1]]);
    pinch({ ctrlKey: true, deltaY: 130, deltaMode: 0, timeStamp: 1000 });
    expect(onStep.mock.calls.slice(1)).toEqual([[-1], [-1]]);
    expect(pinch({ ctrlKey: false, deltaY: -500, deltaMode: 0, timeStamp: 1100 })).toBe(false);
    expect(onStep).toHaveBeenCalledTimes(3);
  });
});
