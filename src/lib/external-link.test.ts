// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { externalWebTarget, handleExternalLinkClick } from "./external-link";

beforeEach(() => { document.body.innerHTML = ""; });
describe("document web links", () => {
  it.each(["javascript:alert(1)", "data:text/html,hi", "file:///tmp/note", "https:example.com", "//example.com", "https://user:secret@example.com", "https://example.com/\nsecret", "https://example.com\\evil", "https://"]) ("does not hand an unsafe or ambiguous destination to the OS: %s", (value) => {
    expect(externalWebTarget(value)).toBeNull();
  });
  it("bounds web destinations", () => { expect(externalWebTarget("https://" + "x".repeat(8192))).toBeNull(); });
  it("keeps ordinary browser anchor behavior when there is no desktop bridge", () => {
    Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: undefined });
    const link = document.createElement("a"); link.href = "https://example.com/post"; document.body.append(link);
    const event = new MouseEvent("click", { cancelable: true }); Object.defineProperty(event, "target", { value: link });
    expect(handleExternalLinkClick(event)).toBe(false); expect(event.defaultPrevented).toBe(false);
  });
  it("suppresses malformed HTTP URLs rather than falling through to navigation", () => {
    const openExternal = vi.fn(async () => {}); installBridge({ openExternal });
    const link = document.createElement("a"); link.setAttribute("href", "https://user:secret@example.com"); document.body.append(link);
    const event = new MouseEvent("click", { cancelable: true }); Object.defineProperty(event, "target", { value: link });
    expect(handleExternalLinkClick(event)).toBe(true); expect(event.defaultPrevented).toBe(true); expect(openExternal).not.toHaveBeenCalled();
  });
});
