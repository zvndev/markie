// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDocx, getDocxEmbeddedFonts, applyDocxOperations, createDocx } from "@/lib/office/docx";
import { buildDocxPrintHTML } from "@/lib/office/docx-print";
import { embeddedFontDocx, FIXTURE_FONT_FAMILY } from "@/lib/office/docx-fonts.fixture";
import { createRichDocument } from "@/lib/office/rich-document";
import { WordDocumentEditor } from "./word-document-editor";
import { documentFontNames, embeddedFontAliases, printFontsFor, wordFontChoices, wordFontStack, WORD_FONT_GROUPS } from "./word-fonts";

// A free font (src/lib/office/fixtures/README.md). Tests run from the repo root.
const FONT = new Uint8Array(readFileSync(resolve(process.cwd(), "src/lib/office/fixtures/markie-fixture-hand.ttf")));

interface FakeFace { family: string; bytes: number; descriptors: { weight?: string; style?: string }; load: () => Promise<FakeFace> }
let loaded: Set<FakeFace>;
// jsdom writes a family name back with double quotes; a browser keeps the single ones.
const painted = (element: HTMLElement) => element.style.fontFamily.replace(/"/g, "'");

beforeEach(() => {
  loaded = new Set();
  class FakeFontFace {
    family: string; bytes: number; descriptors: FakeFace["descriptors"];
    constructor(family: string, source: ArrayBuffer, descriptors: FakeFace["descriptors"] = {}) { this.family = family; this.bytes = source.byteLength; this.descriptors = descriptors; }
    load() { return Promise.resolve(this as unknown as FakeFace); }
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: FakeFace) => loaded.add(face), delete: (face: FakeFace) => loaded.delete(face) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as unknown as { fonts?: unknown }).fonts;
});

describe("a Word file's fonts on screen", () => {
  it("loads an embedded font under a private alias and paints its runs with it first", async () => {
    const source = await openDocx(embeddedFontDocx(FONT));
    const view = render(<WordDocumentEditor document={source} onChange={vi.fn()} />);
    const alias = embeddedFontAliases(getDocxEmbeddedFonts(source)).get(FIXTURE_FONT_FAMILY.toLowerCase())!;
    expect(alias).toMatch(/^Markie Embedded \d+ 1$/);
    expect([...loaded].map((face) => [face.family, face.bytes, face.descriptors])).toEqual([[alias, FONT.length, { weight: "400", style: "normal" }]]);
    // Never under the document's own name, which could shadow an installed font or Markie's own.
    expect([...loaded].some((face) => face.family === FIXTURE_FONT_FAMILY)).toBe(false);
    const runs = view.container.querySelectorAll<HTMLElement>("[data-run-id]");
    expect(painted(runs[0])).toBe(`'${alias}', '${FIXTURE_FONT_FAMILY}'`);
    // The second run names Calibri: the real font, then the bundled stand-in.
    expect(painted(runs[1])).toBe("'Calibri', 'Carlito'");
    view.unmount();
    expect(loaded.size).toBe(0);
  });

  it("does not reload the font on every edit", async () => {
    const source = await openDocx(embeddedFontDocx(FONT));
    const view = render(<WordDocumentEditor document={source} onChange={vi.fn()} />);
    const first = [...loaded][0];
    view.rerender(<WordDocumentEditor document={applyDocxOperations(source, [{ type: "replace-paragraph", paragraphId: source.paragraphs[1].id, text: "Edited" }])} onChange={vi.fn()} />);
    expect([...loaded]).toEqual([first]);
  });

  it("offers the document's fonts first, then the bundled ones, then the installed ones", async () => {
    const source = await openDocx(embeddedFontDocx(FONT));
    expect(documentFontNames(source).sort()).toEqual(["Calibri", FIXTURE_FONT_FAMILY]);
    const choices = wordFontChoices(documentFontNames(source), [{ family: "Futura", kind: "sans", id: "local:inter:Futura" }, { family: "Calibri", kind: "sans", id: "local:carlito:Calibri" }]);
    const groups = [...new Set(choices.map((choice) => choice.group))];
    expect(groups).toEqual([WORD_FONT_GROUPS.document, WORD_FONT_GROUPS.bundled, WORD_FONT_GROUPS.local]);
    expect(choices.filter((choice) => choice.group === WORD_FONT_GROUPS.document).map((choice) => choice.id)).toEqual(["Calibri", FIXTURE_FONT_FAMILY]);
    expect(choices.filter((choice) => choice.group === WORD_FONT_GROUPS.bundled).map((choice) => choice.id)).toContain("Atkinson Hyperlegible Next");
    // Already listed under the document, so not repeated under installed.
    expect(choices.filter((choice) => choice.group === WORD_FONT_GROUPS.local).map((choice) => choice.id)).toEqual(["Futura"]);
    // The id is the real name: that is what a save writes.
    expect(choices.every((choice) => choice.id === choice.label)).toBe(true);
    // With no listing of installed fonts, the common Office names stand in.
    expect(wordFontChoices([], null).filter((choice) => choice.group === WORD_FONT_GROUPS.common).map((choice) => choice.id)).toContain("Times New Roman");
  });

  it("groups the font menu in the editor in that order", async () => {
    const source = await openDocx(embeddedFontDocx(FONT));
    render(<WordDocumentEditor document={source} onChange={vi.fn()} />);
    const menu = screen.getByLabelText("Font");
    expect(Array.from(menu.querySelectorAll("optgroup")).map((group) => group.label)).toEqual([WORD_FONT_GROUPS.document, WORD_FONT_GROUPS.bundled, WORD_FONT_GROUPS.common]);
    expect(Array.from(menu.querySelector("optgroup")!.querySelectorAll("option")).map((option) => option.value)).toEqual(["Calibri", FIXTURE_FONT_FAMILY]);
  });

  it("uses stand-ins for RTF and OpenDocument files too", async () => {
    for (const format of ["rtf", "odt"] as const) {
      const seed = await createRichDocument(format, "Hello");
      const { applyRichOperations } = await import("@/lib/office/rich-document");
      const rich = applyRichOperations(seed, [{ type: "format-run", runId: seed.paragraphs[0].runs[0].id, style: { fontFamily: "Times New Roman" } }]);
      const view = render(<WordDocumentEditor document={rich} onChange={vi.fn()} />);
      expect(painted(view.container.querySelector<HTMLElement>("[data-run-id]")!)).toBe("'Times New Roman', 'Tinos'");
      view.unmount();
    }
  });
});

describe("a Word file's fonts in print and PDF", () => {
  it("carries the embedded font and the stand-ins inside the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]))));
    const source = await openDocx(embeddedFontDocx(FONT));
    const fonts = (await printFontsFor(source))!;
    const alias = embeddedFontAliases(getDocxEmbeddedFonts(source)).get(FIXTURE_FONT_FAMILY.toLowerCase())!;
    expect(fonts.faces).toContain(`@font-face{font-family:'${alias}';font-weight:400;font-style:normal;src:url("data:font/ttf;base64,`);
    expect(fonts.faces).toContain(`font-family:'Carlito';font-style:normal;font-weight:400;font-display:swap;src:url("data:font/woff2;base64,d09GMgECAw==") format("woff2")`);
    // Nothing the print window would have to fetch.
    expect(fonts.faces).not.toMatch(/url\((?!"data:)/);
    const html = buildDocxPrintHTML(source, "Fonts", fonts);
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelector("meta[http-equiv]")!.getAttribute("content")).toContain("font-src data:;");
    expect(dom.querySelector("style")!.textContent).toContain(`font-family:'${alias}'`);
    const spans = dom.querySelectorAll("span");
    expect(spans[0].getAttribute("style")).toContain(`font-family:'${alias}', '${FIXTURE_FONT_FAMILY}'`);
    expect(spans[1].getAttribute("style")).toContain("font-family:'Calibri', 'Carlito'");
    expect(dom.querySelector("script,link,iframe,object")).toBeNull();
  });

  it("adds nothing, and waits for nothing, when a document needs no fonts", async () => {
    const plain = await createDocx("Plain");
    expect(printFontsFor(plain)).toBeNull();
    const html = buildDocxPrintHTML(plain, "Plain");
    expect(html).toContain("font-src 'none'");
    expect(html).not.toContain("@font-face");
  });

  it("keeps a hostile font name inert in the printed page", async () => {
    const seed = await createDocx("Hostile");
    const hostile = applyDocxOperations(seed, [{ type: "format-run", runId: seed.paragraphs[0].runs[0].id, style: { fontFamily: "x'; } body { display:none } @import 'y" } }]);
    const html = buildDocxPrintHTML(hostile, "Hostile", { faces: "", stack: wordFontStack([]) });
    const dom = new DOMParser().parseFromString(html, "text/html");
    const span = dom.querySelector("span")!;
    expect(span.textContent).toBe("Hostile");
    expect(span.getAttribute("style")).toMatch(/font-family:'[A-Za-z0-9 \\]*'(;|$)/);
    expect(dom.querySelectorAll("style")).toHaveLength(1);
  });
});
