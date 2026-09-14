import { describe, expect, it, vi, beforeEach } from "vitest";
import { installBridge, clearBridge } from "@/test/mock-bridge";
import { isDocHref, markDocLinks, NOT_SHARED } from "@/lib/doc-links";

function anchor(href: string, title?: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  if (title) a.title = title;
  a.textContent = href;
  return a;
}

describe("isDocHref", () => {
  it("accepts document extensions, with or without a fragment or query", () => {
    for (const h of ["plan.md", "./x/PLAN.MD", "a.markdown#top", "b.mdx?x=1", "c.txt"]) expect(isDocHref(h)).toBe(true);
    for (const h of ["spec.pdf", "shot.png", "plan", "https://x.test/a.md", "#top"]) expect(isDocHref(h)).toBe(false);
  });
});

describe("markDocLinks", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("asks main once for the document links and marks each anchor with its kind", async () => {
    const resolveDocLinks = vi.fn(async () => [
      { href: "plan.md", kind: "cloud" as const, target: "c1" },
      { href: "secret.md", kind: "none" as const },
      { href: "here.md", kind: "local" as const },
    ]);
    installBridge({ resolveDocLinks });
    const root = document.createElement("div");
    const plan = anchor("plan.md");
    const secret = anchor("secret.md");
    const secretTitled = anchor("secret.md", "kept");
    const here = anchor("here.md");
    const pdf = anchor("spec.pdf");
    const web = anchor("https://x.test/a.md");
    root.append(plan, secret, secretTitled, here, pdf, web);
    document.body.append(root);

    await markDocLinks(root, "/Users/me/report/notes.md");

    expect(resolveDocLinks).toHaveBeenCalledTimes(1);
    expect(resolveDocLinks).toHaveBeenCalledWith({ docPath: "/Users/me/report/notes.md", hrefs: ["plan.md", "secret.md", "here.md"] });
    expect(plan.dataset.docLink).toBe("cloud");
    expect(secret.dataset.docLink).toBe("none");
    expect(secret.title).toBe(NOT_SHARED);
    expect(secretTitled.dataset.docLink).toBe("none");
    expect(secretTitled.title).toBe("kept");
    expect(here.dataset.docLink).toBe("local");
    expect(pdf.dataset.docLink).toBeUndefined();
    expect(web.dataset.docLink).toBeUndefined();
  });

  it("clears a stale mark when the answer changes and does nothing without a document path or a bridge", async () => {
    const resolveDocLinks = vi.fn(async () => [{ href: "plan.md", kind: "unknown" as const }]);
    installBridge({ resolveDocLinks });
    const root = document.createElement("div");
    const plan = anchor("plan.md");
    plan.dataset.docLink = "none";
    root.append(plan);
    await markDocLinks(root, "/Users/me/report/notes.md");
    expect(plan.dataset.docLink).toBe("unknown");

    resolveDocLinks.mockClear();
    await markDocLinks(root, null);
    expect(resolveDocLinks).not.toHaveBeenCalled();

    clearBridge();
    await expect(markDocLinks(root, "/Users/me/report/notes.md")).resolves.toBeUndefined();
  });
});
