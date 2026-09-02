import { describe, expect, it, vi, beforeEach } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { setAssetBaseDir } from "@/lib/asset-url";
import { handleDocumentClick, localLinkTarget } from "@/lib/local-link";

function anchor(href: string | null): HTMLAnchorElement {
  const a = document.createElement("a");
  if (href !== null) a.setAttribute("href", href);
  return a;
}

function clickOn(el: HTMLElement, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "target", { value: el });
  return event;
}

describe("localLinkTarget", () => {
  it("claims a plain relative path", () => {
    expect(localLinkTarget(anchor("spec.pdf"))).toBe("spec.pdf");
    expect(localLinkTarget(anchor("./docs/spec.pdf"))).toBe("./docs/spec.pdf");
    expect(localLinkTarget(anchor("/Users/me/spec.pdf"))).toBe("/Users/me/spec.pdf");
  });

  it("leaves alone everything the app already answers for", () => {
    for (const href of [
      "https://example.com",
      "http://example.com",
      "mailto:a@b.c",
      "markie://doc/1",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "#heading",
      "//example.com/x",
    ]) {
      expect(localLinkTarget(anchor(href))).toBeNull();
    }
  });

  it("is not confused by a missing href or a missing anchor", () => {
    expect(localLinkTarget(anchor(null))).toBeNull();
    expect(localLinkTarget(null)).toBeNull();
  });
});

describe("handleDocumentClick", () => {
  beforeEach(() => {
    setAssetBaseDir("/Users/me/report");
    document.body.innerHTML = "";
  });

  it("takes over a local link and asks main to open it", async () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    installBridge({ openLocalFile });
    const a = anchor("spec.pdf");
    document.body.append(a);

    const event = clickOn(a);
    expect(handleDocumentClick(event, vi.fn())).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(openLocalFile).toHaveBeenCalledWith({
      href: "spec.pdf",
      docDir: "/Users/me/report",
    });
  });

  it("says why when main refuses, because a silent click reads as breakage", async () => {
    const onError = vi.fn();
    installBridge({ openLocalFile: vi.fn(async () => ({ ok: false, error: "Nope." })) });
    const a = anchor("../../secret.pdf");
    document.body.append(a);

    handleDocumentClick(clickOn(a), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Nope."));
  });

  it("leaves an https link to the handler that already opens the browser", () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    installBridge({ openLocalFile });
    const a = anchor("https://example.com");
    document.body.append(a);

    const event = clickOn(a);
    expect(handleDocumentClick(event, vi.fn())).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(openLocalFile).not.toHaveBeenCalled();
  });

  it("leaves a modified click to the operating system", () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    installBridge({ openLocalFile });
    const a = anchor("spec.pdf");
    document.body.append(a);

    expect(handleDocumentClick(clickOn(a, { metaKey: true }), vi.fn())).toBe(false);
    expect(handleDocumentClick(clickOn(a, { button: 1 }), vi.fn())).toBe(false);
    expect(openLocalFile).not.toHaveBeenCalled();
  });

  it("finds the link when the click landed on something inside it", () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    installBridge({ openLocalFile });
    const a = anchor("spec.pdf");
    const strong = document.createElement("strong");
    a.append(strong);
    document.body.append(a);

    expect(handleDocumentClick(clickOn(strong), vi.fn())).toBe(true);
    expect(openLocalFile).toHaveBeenCalled();
  });
});
