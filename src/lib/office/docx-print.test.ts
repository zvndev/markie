// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx } from "./docx";
import { canPrintDocx, buildDocxPrintHTML } from "./docx-print";
import { themedDocxFixture } from "./docx-theme.fixture";
import { readZip, writeZip } from "./zip";
import type { DocxDocument } from "./docx-types";

describe("original supported DOCX print view", () => {
  it("uses the existing Word canvas serif, size and empty paragraph height as its fallback", async () => {
    const html = buildDocxPrintHTML(await createDocx(""));
    expect(html).toContain('font-family:Georgia,"Times New Roman",serif;font-size:12pt');
    expect(html).toContain("min-height:1.4em");
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelectorAll(".paragraph")).toHaveLength(1);
  });
  it("projects themed typography and paper without changing a byte", async () => {
    const { document, bytes } = await themedDocxFixture();
    const html = buildDocxPrintHTML(document, "Editorial <&> \"title\"");
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(canPrintDocx(document)).toBe(true);
    expect(dom.title).toBe('Editorial <&> "title"');
    expect(dom.body.textContent).toContain("Themed heading");
    expect(dom.querySelector("span")!.style.fontFamily).toBe('"Georgia"');
    expect(dom.querySelector("span")!.style.fontSize).toBe("16pt");
    expect(dom.querySelector("span")!.style.color).toBe("rgb(51, 102, 153)");
    expect(html).toContain("size:612pt 792pt;margin:72pt 72pt 72pt 72pt");
    expect(html).toContain("background:#fff;color:#000;color-scheme:light");
    expect(await exportDocx(document)).toEqual(bytes);
    expect(document.modified).toBe(false);
  });

  it("escapes all text, title and hostile CSS font syntax without active content", async () => {
    const seed = await createDocx('<script>alert(1)</script> & <img src="file:///etc/passwd">');
    const document = applyDocxOperations(seed, [{ type: "format-run", runId: seed.paragraphs[0].runs[0].id,
      style: { fontFamily: `Bad';color:red;background:url(https://evil.test);/*</style><script>x</script>` } }]);
    const html = buildDocxPrintHTML(document, "</title><script>x</script>");
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelector("script,img,iframe,object,link,base,form")).toBeNull();
    expect(dom.body.textContent).toBe(seed.text);
    expect(dom.querySelector("span")!.getAttribute("style")).not.toContain("background:url");
    expect(dom.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content"))
      .toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'");
  });

  it("preserves paragraph alignment, spacing, semantic list numbering and rectangular tables in block order", async () => {
    const document = applyDocxOperations(await createDocx("Heading\nOne\nBullet\nAfter"), [
      { type: "format-paragraph", paragraphId: "p0", format: { alignment: "center", spacingBeforePoints: 12, spacingAfterPoints: 6, lineSpacingMultiple: 1.5 } },
      { type: "set-list", paragraphId: "p1", kind: "numbered" },
      { type: "set-list", paragraphId: "p2", kind: "bullet" },
      { type: "insert-table", afterParagraphId: "p2", rows: 2, columns: 2, cells: [["A", "B"], ["C", "D"]] },
    ]);
    const dom = new DOMParser().parseFromString(buildDocxPrintHTML(document), "text/html");
    expect(dom.body.firstElementChild!.getAttribute("style")).toContain("text-align:center;margin-top:12pt;margin-bottom:6pt;line-height:1.5");
    expect(dom.querySelector("ol")!.getAttribute("start")).toBe("1");
    expect(dom.querySelector("ul li")!.textContent).toBe("Bullet");
    expect([...dom.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["A", "B", "C", "D"]);
    expect([...dom.body.children].map((child) => child.tagName)).toEqual(["DIV", "OL", "UL", "TABLE", "DIV"]);
  });

  it("splits explicit breaks into top-level block fragments, preserving both sides and run styles", async () => {
    const document = applyDocxOperations(await createDocx("BeforeAfter\nEnd"), [
      { type: "format-run", runId: "p0:r0", style: { bold: true } },
      { type: "insert-page-break", paragraphId: "p0", offset: 6 },
    ]);
    const dom = new DOMParser().parseFromString(buildDocxPrintHTML(document), "text/html");
    expect([...dom.body.children].map((child) => [child.className, child.textContent])).toEqual([
      ["paragraph", "Before"], ["page-break", ""], ["paragraph", "After"], ["paragraph", "End"],
    ]);
    expect(dom.querySelector("span .page-break")).toBeNull();
    expect([...dom.querySelectorAll("span")].slice(0, 2).every((span) => span.style.fontWeight === "700")).toBe(true);
  });

  it("represents leading, trailing and adjacent page breaks as separate block markers without fake lines", async () => {
    const document = applyDocxOperations(await createDocx("Text"), [
      { type: "insert-page-break", paragraphId: "p0", offset: 0 },
      { type: "insert-page-break", paragraphId: "p0", offset: 4 },
      { type: "insert-page-break", paragraphId: "p0", offset: 4 },
    ]);
    const dom = new DOMParser().parseFromString(buildDocxPrintHTML(document), "text/html");
    expect(dom.querySelectorAll(".page-break")).toHaveLength(3);
    expect(dom.querySelectorAll(".paragraph")).toHaveLength(1);
    expect(dom.body.textContent).toBe("Text");
    expect(dom.body.lastElementChild!.className).toBe("blank-fragment");
    expect(dom.body.lastElementChild!.textContent).toBe("");
    expect(dom.body.lastElementChild!.childElementCount).toBe(0);
  });

  it.each(["", "Text"])("keeps a glyph-free trailing layout box after the final break for %j", async (text) => {
    const document = applyDocxOperations(await createDocx(text), [{ type: "insert-page-break", paragraphId: "p0", offset: text.length }]);
    const html = buildDocxPrintHTML(document);
    const dom = new DOMParser().parseFromString(html, "text/html");
    const last = dom.body.lastElementChild!;
    expect(last.className).toBe("blank-fragment");
    expect(last.previousElementSibling!.className).toBe("page-break");
    expect(last.textContent).toBe("");
    expect(last.childElementCount).toBe(0);
    expect(html).toContain(".blank-fragment{display:block;height:1pt;margin:0;padding:0}");
    expect(dom.body.textContent).toBe(text);
  });

  it.each(["bullet", "numbered"] as const)("retains the %s marker after leading breaks without repeating it on a mid-item continuation", async (kind) => {
    const document = applyDocxOperations(await createDocx("First item"), [
      { type: "set-list", paragraphId: "p0", kind },
      { type: "insert-page-break", paragraphId: "p0", offset: 0 },
      { type: "insert-page-break", paragraphId: "p0", offset: 0 },
      { type: "insert-page-break", paragraphId: "p0", offset: 6 },
    ]);
    expect(canPrintDocx(document)).toBe(true);
    const dom = new DOMParser().parseFromString(buildDocxPrintHTML(document), "text/html");
    const tag = kind === "numbered" ? "ol" : "ul";
    expect(dom.querySelectorAll(tag)).toHaveLength(1);
    expect(dom.querySelectorAll("li")).toHaveLength(1);
    expect(dom.querySelector("li")!.textContent).toBe("First ");
    if (kind === "numbered") expect(dom.querySelector("ol")!.getAttribute("start")).toBe("1");
    expect([...dom.body.children].map((element) => element.className === "page-break" ? "break" : element.tagName))
      .toEqual(["break", "break", tag.toUpperCase(), "break", "DIV"]);
    expect(dom.body.lastElementChild!.textContent).toBe("item");
    expect((dom.body.lastElementChild as HTMLElement).style.paddingLeft).toBe("18pt");
  });

  it("retains validated hyperlinks as inert capture markup and omits private comment content", async () => {
    const document = applyDocxOperations(await createDocx("Example"), [
      { type: "set-hyperlink", paragraphId: "p0", start: 0, end: 7, target: "https://example.test/?a=1&b=2" },
      { type: "add-comment", paragraphId: "p0", text: "Private review note", author: "Private author" },
    ]);
    const html = buildDocxPrintHTML(document);
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelector("a")!.getAttribute("href")).toBe("https://example.test/?a=1&b=2");
    expect(html).not.toContain("Private review");
    expect(html).not.toContain("Private author");
  });

  it.each(["file:///private/file", "javascript:alert(1)", "data:text/html,test"])("rejects unsafe link target %s", async (target) => {
    const seed = await createDocx("Text");
    const paragraph = { ...seed.paragraphs[0], runs: [{ ...seed.paragraphs[0].runs[0], target }] };
    const document = { ...seed, paragraphs: [paragraph] };
    expect(canPrintDocx(document)).toBe(false);
    expect(() => buildDocxPrintHTML(document)).toThrow(/supported print/);
  });

  it.each([
    { widthPoints: NaN }, { heightPoints: Infinity }, { widthPoints: 0 }, { widthPoints: 5000 },
    { marginTopPoints: -1 }, { marginBottomPoints: -1 }, { marginLeftPoints: 600 }, { marginRightPoints: Infinity },
  ])("rejects unsafe or unrepresentable paper geometry %j", async (change) => {
    const seed = await createDocx("Text");
    const document = { ...seed, pageLayout: { ...seed.pageLayout, ...change } };
    expect(canPrintDocx(document)).toBe(false);
    expect(() => buildDocxPrintHTML(document)).toThrow(/supported print/);
  });

  it("rejects warnings, readonly content and all pending revisions rather than flattening review state", async () => {
    const seed = await createDocx("Text");
    const documents: DocxDocument[] = [
      { ...seed, canEdit: false },
      { ...seed, diagnostics: [{ code: "unsupported", severity: "warning", message: "Unsupported" }] },
      applyDocxOperations(seed, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Edited", author: "A" }]),
    ];
    for (const document of documents) {
      expect(canPrintDocx(document)).toBe(false);
      expect(() => buildDocxPrintHTML(document)).toThrow();
    }
  });

  it("fails closed on table-contained explicit breaks and malformed block coverage", async () => {
    const seed = applyDocxOperations(await createDocx("Before"), [{ type: "insert-table", rows: 1, columns: 1, cells: [["Cell"]] }]);
    const parts = await readZip(await exportDocx(seed));
    const main = parts.find((part) => part.name === "word/document.xml")!;
    main.data = new TextEncoder().encode(new TextDecoder().decode(main.data).replace("Cell</w:t>", 'Cell</w:t><w:br w:type="page"/>'));
    const document = await openDocx(writeZip(parts));
    expect(document.canEdit).toBe(true);
    expect(document.pageBreaks).toHaveLength(1);
    expect(canPrintDocx(document)).toBe(false);
    expect(canPrintDocx({ ...seed, blocks: [] })).toBe(false);
    expect(canPrintDocx({ ...seed, blocks: [...seed.blocks, seed.blocks[0]] })).toBe(false);
  });

  it("rejects invalid style values and bounds encoded HTML expansion", async () => {
    const seed = await createDocx("Text");
    for (const style of [{ fontSizePoints: Infinity }, { color: "red;background:url(evil)" }, { fontFamily: "Bad\nfont" }]) {
      const paragraph = { ...seed.paragraphs[0], runs: [{ ...seed.paragraphs[0].runs[0], resolvedStyle: style }] };
      const document = { ...seed, paragraphs: [paragraph] };
      expect(canPrintDocx(document)).toBe(false);
      expect(() => buildDocxPrintHTML(document)).toThrow();
    }
    const text = '"'.repeat(4 * 1024 * 1024);
    const paragraph = { ...seed.paragraphs[0], text, runs: [{ ...seed.paragraphs[0].runs[0], text }] };
    const document = { ...seed, text, paragraphs: [paragraph] };
    expect(canPrintDocx(document)).toBe(true);
    expect(() => buildDocxPrintHTML(document)).toThrow(/supported print/);
  });
});
