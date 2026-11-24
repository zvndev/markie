// A link to a document that is already on screen: nothing is stacked twice,
// and a notification about another thread of it still gets shown.
import { describe, expect, it } from "vitest";
import { openDecision, sameTarget, threadOf } from "../src/lib/doc-stack";
import { parseMarkieLink, type LinkTarget } from "../src/lib/deep-links";

const ORIGIN = "https://api.markiedocs.com";
const T1 = "0b0e1f6e-3a53-4c0b-9d0a-5a6f6f0e7a11";
const T2 = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const doc = (id: string, thread?: string): LinkTarget => ({ kind: "doc", id, origin: ORIGIN, ...(thread ? { thread } : {}) });

describe("opening a link onto the stack", () => {
  it("puts a document on the stack when a different one, or none, is on top", () => {
    expect(openDecision(null, doc("doc-1"))).toBe("push");
    expect(openDecision(doc("doc-2"), doc("doc-1"))).toBe("push");
    expect(openDecision(doc("doc-2", T1), doc("doc-1", T1))).toBe("push");
    expect(openDecision({ kind: "public", token: "a".repeat(32), origin: ORIGIN }, doc("doc-1"))).toBe("push");
    // The same id on another server is another document.
    expect(openDecision({ kind: "doc", id: "doc-1", origin: "https://docs.example.com" }, doc("doc-1"))).toBe("push");
  });

  it("keeps the screen when the same document is tapped again", () => {
    expect(openDecision(doc("doc-1"), doc("doc-1"))).toBe("keep");
    expect(openDecision(doc("doc-1", T1), doc("doc-1", T1))).toBe("keep");
    // A plain link to it does not close the thread being read.
    expect(openDecision(doc("doc-1", T1), doc("doc-1"))).toBe("keep");
  });

  it("hands the open document a notification's thread when it names a different one", () => {
    expect(openDecision(doc("doc-1"), doc("doc-1", T1))).toBe("retarget");
    expect(openDecision(doc("doc-1", T1), doc("doc-1", T2))).toBe("retarget");
  });

  it("works on the links a notification really carries", () => {
    const first = parseMarkieLink(`${ORIGIN}/d/doc-1?thread=${T1}`)!;
    const second = parseMarkieLink(`${ORIGIN}/d/doc-1?thread=${T2}`)!;
    expect(sameTarget(first, second)).toBe(true);
    expect(threadOf(second)).toBe(T2);
    expect(openDecision(first, second)).toBe("retarget");
    // A thread id that is not one is dropped by the router, so nothing moves.
    expect(openDecision(first, parseMarkieLink(`${ORIGIN}/d/doc-1?thread=../../x`)!)).toBe("keep");
  });
});
