// Editing and starting documents on the phone, without a device: names,
// kinds, who may edit, the save hash, and the formatting buttons.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canEditDoc, formatFromName, markFormat, newDocId, newDocName, NEW_DOC_TYPES, parseCloudDoc, publicDocName, type CloudDoc } from "../src/lib/docs";
import { sha256Bytes, sha256Hex } from "../src/lib/sha256";
import { applyMarkdownAction } from "../src/lib/markdown-edits";
import { copyName } from "../src/screens/editor";

const ORIGIN = "https://api.markiedocs.com";
const markdown = NEW_DOC_TYPES.find((type) => type.id === "markdown")!;
const doc = (patch: Partial<CloudDoc>): CloudDoc => ({
  id: "d1", name: "Plan.md", format: "markdown", version: 3, content: "", updatedAt: null,
  origin: { kind: "app", agent: null }, privateLink: `${ORIGIN}/d/d1`, role: "owner", ...patch,
});

describe("who may edit", () => {
  it("offers Edit to owners, editors, and a server that didn't say", () => {
    expect(canEditDoc(doc({ role: "owner" }))).toBe(true);
    expect(canEditDoc(doc({ role: "editor" }))).toBe(true);
    expect(canEditDoc(doc({ role: null }))).toBe(true);
  });

  it("never offers it to viewers, public shares, or a document with no version", () => {
    expect(canEditDoc(doc({ role: "viewer" }))).toBe(false);
    expect(canEditDoc(doc({ publicToken: "t".repeat(20), role: null }))).toBe(false);
    expect(canEditDoc(doc({ version: null }))).toBe(false);
  });

  it("reads the caller's role from the server's document", () => {
    const parsed = parseCloudDoc({ doc: { id: "d1", name: "Plan.md", content: "x", version: 2, role: "viewer" } }, ORIGIN);
    expect(parsed.role).toBe("viewer");
    expect(parseCloudDoc({ doc: { id: "d1", name: "Plan.md", content: "x", version: 2 } }, ORIGIN).role).toBeNull();
  });
});

describe("new documents", () => {
  it("names a document from what was typed, with the kind's extension", () => {
    expect(newDocName("Trip plan", markdown)).toBe("Trip plan.md");
    expect(newDocName("  ", markdown)).toBe("Untitled.md");
    expect(newDocName("notes/../secret", markdown)).toBe("notes .. secret.md");
    expect(newDocName("budget.csv", markdown)).toBe("budget.csv");
  });

  it("starts every kind as text the cloud can hold", () => {
    for (const type of NEW_DOC_TYPES) expect(typeof type.starter("Title")).toBe("string");
    expect(markdown.starter("Trip")).toBe("# Trip\n\n");
    expect(NEW_DOC_TYPES.find((type) => type.id === "darkmown")!.starter("Count")).toContain(":button");
  });

  it("mints ids the server accepts", () => {
    expect(newDocId(() => "0b6f3c0e-8d7e-4c55-9d2b-0d7e1f7c9a11")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(() => newDocId(() => "not/an id")).toThrow();
  });

  it("shows data files as text, with their own glyph", () => {
    expect(formatFromName("budget.csv")).toBe("text");
    expect(formatFromName("config.yaml")).toBe("text");
    expect(formatFromName("Plan.wd")).toBe("darkmown");
    expect(formatFromName("Plan.md")).toBe("markdown");
    expect(markFormat({ name: "budget.csv", format: "text" })).toBe("csv");
    expect(markFormat({ name: "a.json", format: "text" })).toBe("json");
    // The server files a .csv under "markdown"; the phone still shows it as text.
    expect(parseCloudDoc({ doc: { id: "d1", name: "budget.csv", content: "a,b", version: 1, format: "markdown" } }, ORIGIN).format).toBe("text");
    expect(publicDocName("budget.csv.md")).toBe("budget.csv");
  });

  it("names a conflict's copy beside the original", () => {
    expect(copyName("Plan.md")).toBe("Plan (copy).md");
    expect(copyName("README")).toBe("README (copy)");
  });
});

describe("the save hash", () => {
  it("is the SHA-256 the desktop records, with or without Web Crypto", async () => {
    for (const text of ["", "abc", "# Plan\n\nÉmoji 🎉 and more\n", "x".repeat(1000)]) {
      const expected = createHash("sha256").update(text, "utf8").digest("hex");
      expect(await sha256Hex(text)).toBe(expected);
      expect(Buffer.from(sha256Bytes(new TextEncoder().encode(text))).toString("hex")).toBe(expected);
    }
  });
});

describe("formatting buttons", () => {
  it("wraps the selection, or a placeholder at the caret", () => {
    expect(applyMarkdownAction({ value: "make this bold", start: 10, end: 14 }, "bold")).toEqual({ value: "make this **bold**", start: 12, end: 16 });
    expect(applyMarkdownAction({ value: "", start: 0, end: 0 }, "italic")).toEqual({ value: "_italic_", start: 1, end: 7 });
  });

  it("toggles a heading, list or checklist on the caret's line", () => {
    const on = applyMarkdownAction({ value: "one\ntwo", start: 5, end: 5 }, "heading");
    expect(on.value).toBe("one\n## two");
    expect(on.start).toBe(8);
    expect(applyMarkdownAction({ value: on.value, start: on.start, end: on.end }, "heading").value).toBe("one\ntwo");
    expect(applyMarkdownAction({ value: "a\nb", start: 0, end: 3 }, "list").value).toBe("- a\n- b");
    expect(applyMarkdownAction({ value: "- a\n- b", start: 0, end: 7 }, "list").value).toBe("a\nb");
    expect(applyMarkdownAction({ value: "milk", start: 4, end: 4 }, "task").value).toBe("- [ ] milk");
  });

  it("leaves the caret ready for a link's address", () => {
    const next = applyMarkdownAction({ value: "see docs", start: 4, end: 8 }, "link");
    expect(next.value).toBe("see [docs](https://)");
    expect(next.value.slice(0, next.start)).toBe("see [docs](https://");
  });
});
