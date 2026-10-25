// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DARKMOWN_THEME_MESSAGE, darkmownFrameSandbox, projectDarkmownTheme } from "./frame";

describe("darkmown frame policy", () => {
  it("runs scripts only when trusted, and grants nothing else", () => {
    expect(darkmownFrameSandbox(true)).toBe("allow-scripts");
    expect(darkmownFrameSandbox(false)).toBe("");
    expect(darkmownFrameSandbox(true)).not.toMatch(/same-origin|forms|popups|top-navigation|modals|downloads/);
  });

  it("projects only a literal light or dark into the frame, matching the bootstrap's message type", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    projectDarkmownTheme(frame, "dark");
    expect(post).toHaveBeenLastCalledWith({ type: "markie:preview-theme", theme: "dark" }, "*");
    projectDarkmownTheme(frame, "url(x)" as "dark");
    expect(post).toHaveBeenLastCalledWith({ type: DARKMOWN_THEME_MESSAGE, theme: "light" }, "*");
    expect(() => projectDarkmownTheme(null, "dark")).not.toThrow();
    frame.remove();
  });
});
