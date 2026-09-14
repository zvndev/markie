import { describe, expect, it, vi, beforeEach } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { setAssetDocPath } from "@/lib/asset-url";
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
    setAssetDocPath("/Users/me/report/notes.md");
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

  it("shows the notice for a link the reader may not follow, without asking main", async () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    const openDocLink = vi.fn(async () => ({ ok: true }));
    installBridge({ openLocalFile, openDocLink });
    const a = anchor("secret.md");
    a.dataset.docLink = "none";
    document.body.append(a);
    const onError = vi.fn();
    const event = clickOn(a);
    expect(handleDocumentClick(event, onError)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(onError).toHaveBeenCalledWith("This document isn't shared with you.");
    expect(openLocalFile).not.toHaveBeenCalled();
    expect(openDocLink).not.toHaveBeenCalled();
  });

  it("opens a cloud link through main with the document's path, and reports a failure", async () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    const openDocLink = vi.fn(async () => ({ ok: false, error: "Couldn't open that document." }));
    installBridge({ openLocalFile, openDocLink });
    const a = anchor("plan.md#top");
    a.dataset.docLink = "cloud";
    document.body.append(a);
    const onError = vi.fn();
    expect(handleDocumentClick(clickOn(a), onError)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(openDocLink).toHaveBeenCalledWith({ href: "plan.md#top", docPath: "/Users/me/report/notes.md" });
    expect(openLocalFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Couldn't open that document.");
  });

  it("falls back to opening the file locally when a cloud-marked link has since landed on disk", async () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    const openDocLink = vi.fn(async () => ({ ok: false as const, kind: "local" as const, error: "That link does not point at a synced document." }));
    installBridge({ openLocalFile, openDocLink });
    const a = anchor("plan.md");
    a.dataset.docLink = "cloud";
    document.body.append(a);
    const onError = vi.fn();
    expect(handleDocumentClick(clickOn(a), onError)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(openDocLink).toHaveBeenCalledWith({ href: "plan.md", docPath: "/Users/me/report/notes.md" });
    expect(openLocalFile).toHaveBeenCalledOnce();
    expect(openLocalFile).toHaveBeenCalledWith({ href: "plan.md", docDir: "/Users/me/report" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("still opens a local or unmarked link the old way", async () => {
    const openLocalFile = vi.fn(async () => ({ ok: true }));
    const openDocLink = vi.fn(async () => ({ ok: true }));
    installBridge({ openLocalFile, openDocLink });
    const a = anchor("here.md");
    a.dataset.docLink = "local";
    document.body.append(a);
    expect(handleDocumentClick(clickOn(a), vi.fn())).toBe(true);
    expect(openLocalFile).toHaveBeenCalledWith({ href: "here.md", docDir: "/Users/me/report" });
    expect(openDocLink).not.toHaveBeenCalled();
  });
});
