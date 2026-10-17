// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx } from "./docx";
import { buildDocxPrintHTML, canPrintDocx } from "./docx-print";
import { printDocxFixture } from "./docx-print.fixture";
import { readZip, writeZip } from "./zip";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

async function packageWithMain(rewrite: (xml: string) => string, text = "BeforeAfter") {
  const parts = await readZip(await exportDocx(await createDocx(text)));
  const main = parts.find((part) => part.name === "word/document.xml")!;
  main.data = encoder.encode(rewrite(decoder.decode(main.data)));
  const bytes = writeZip(parts);
  return { document: await openDocx(bytes), bytes };
}

describe("original DOCX supported print projection", () => {
  it("prints ordered supported structures and resolved styles without mutating the original package", async () => {
    const { document, bytes } = await printDocxFixture();
    expect(document.canEdit).toBe(true);
    expect(canPrintDocx(document)).toBe(true);
    const html = buildDocxPrintHTML(document, "Editorial print proof"), output = parse(html);
    expect(output.title).toBe("Editorial print proof");
    expect(output.body.textContent).toContain("An editorial document");
    expect(output.body.textContent).toContain("First-page closing note.");
    expect(output.body.textContent).toContain("Second-page continuation");
    expect(output.body.textContent).not.toContain("Private review note");
    expect(output.querySelectorAll("table")).toHaveLength(1);
    expect(Array.from(output.querySelectorAll("td,th"), (cell) => cell.textContent)).toEqual(["Document", "Purpose", "Editorial draft", "Write and refine", "Local copy", "Keep ownership"]);
    const link = output.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/notes?edition=print&source=markie");
    expect(link.textContent).toBe("project notes");
    const image = output.querySelector("img")!;
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    expect(image.getAttribute("alt")).toBe('Editorial mark <&> "blue"');
    expect(output.querySelector("ul li")?.textContent).toBe("Local files, first");
    expect(Array.from(output.querySelectorAll("ol"), (list) => list.getAttribute("start"))).toEqual(["1", "2"]);
    expect(html).toContain("Georgia");
    expect(html).toMatch(/#336699/i);
    const heading = output.querySelector<HTMLElement>(".paragraph span")!;
    expect(heading.style.fontFamily).toContain("Georgia");
    expect(heading.style.fontSize).toBe("16pt");
    expect(heading.style.color).toBe("rgb(51, 102, 153)");
    expect(heading.style.fontWeight).toBe("700");
    expect(html).toMatch(/@page\s*\{/);
    expect(html).toContain(`${document.pageLayout.widthPoints}pt`);
    expect(html).toContain(`${document.pageLayout.heightPoints}pt`);
    for (const margin of [48, 54, 60, 66]) expect(html).toContain(`${margin}pt`);
    expect(await exportDocx(document)).toEqual(bytes);
    expect(document.modified).toBe(false);
  });

  it("keeps text and title inert instead of interpreting document strings as active HTML", async () => {
    const text = '<script>alert("document")</script><img src="https://example.com/tracker" onerror="alert(1)">& body';
    const document = await createDocx(text);
    const bytes = await exportDocx(document);
    const output = parse(buildDocxPrintHTML(document, '</title><script>alert("title")</script>'));
    expect(output.body.textContent).toBe(text);
    expect(output.title).toBe('</title><script>alert("title")</script>');
    expect(output.querySelectorAll("script,iframe,object,embed,link,form,input,button")).toHaveLength(0);
    expect(output.querySelectorAll("img")).toHaveLength(0);
    for (const element of output.querySelectorAll("*")) {
      expect(Array.from(element.attributes).some((attribute) => /^on/i.test(attribute.name))).toBe(false);
    }
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("captures unsaved formatting without acknowledging a save or changing the current snapshot", async () => {
    const document = applyDocxOperations(await createDocx("Unsaved work"), [{ type: "format-run", runId: "p0:r0", style: { italic: true } }]);
    const before = await exportDocx(document), revision = document.revision;
    expect(document.modified).toBe(true);
    const output = parse(buildDocxPrintHTML(document));
    expect(output.querySelector<HTMLElement>("span")!.style.fontStyle).toBe("italic");
    expect(await exportDocx(document)).toEqual(before);
    expect(document.modified).toBe(true);
    expect(document.revision).toBe(revision);
  });

  it("does not fetch document resources or emit file-path context", async () => {
    const { document } = await printDocxFixture();
    const html = buildDocxPrintHTML(document), output = parse(html);
    expect(output.querySelectorAll('script[src],link[href],iframe[src],source[src],video[src],audio[src],base')).toHaveLength(0);
    for (const image of output.querySelectorAll("img")) expect(image.getAttribute("src")).toMatch(/^data:image\/(?:png|jpeg);base64,/);
    expect(html).not.toMatch(/(?:url\s*\(|@import|file:\/\/|docPath|contenteditable)/i);
    expect(output.body.querySelectorAll("style")).toHaveLength(0);
  });

  it("quotes hostile imported font punctuation rather than permitting CSS or HTML injection", async () => {
    const document = applyDocxOperations(await createDocx("Quoted font"), [{ type: "format-run", runId: "p0:r0", style: { fontFamily: "Arial';background:url(https://evil.invalid);/*</style><script>" } }]);
    const bytes = await exportDocx(document);
    expect(canPrintDocx(document)).toBe(true);
    const output = parse(buildDocxPrintHTML(document));
    expect(output.querySelectorAll("script,img,link,iframe")).toHaveLength(0);
    expect(output.querySelectorAll("style")).toHaveLength(1);
    expect(output.querySelector("span")?.getAttribute("style")).not.toMatch(/url\s*\(|<\/style>|;background:/i);
    expect(output.body.textContent).toBe("Quoted font");
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it.each([
    ["leading", '<w:r><w:br w:type="page"/><w:t>BeforeAfter</w:t></w:r>', ["break", "BeforeAfter"]],
    ["trailing", '<w:r><w:t>BeforeAfter</w:t><w:br w:type="page"/></w:r>', ["BeforeAfter", "break", ""]],
    ["consecutive", '<w:r><w:t>Before</w:t><w:br w:type="page"/><w:br w:type="page"/></w:r><w:r><w:t>After</w:t></w:r>', ["Before", "break", "break", "After"]],
    ["mid-paragraph", '<w:r><w:t>Before</w:t><w:br w:type="page"/></w:r><w:r><w:t>After</w:t></w:r>', ["Before", "break", "After"]],
  ])("preserves %s explicit page breaks as block-level fragments, including blank pages", async (_name, content, sequence) => {
    const { document, bytes } = await packageWithMain((xml) => xml.replace('<w:r><w:t xml:space="preserve">BeforeAfter</w:t></w:r>', content));
    expect(document.canEdit).toBe(true);
    expect(document.pageBreaks).toHaveLength(sequence.filter((item) => item === "break").length);
    expect(canPrintDocx(document)).toBe(true);
    const output = parse(buildDocxPrintHTML(document));
    expect(Array.from(output.body.children, (element) => element.classList.contains("page-break") ? "break" : element.textContent)).toEqual(sequence);
    if (_name === "trailing") {
      const blank = output.body.lastElementChild!;
      expect(blank.className).toBe("blank-fragment");
      expect(blank.children).toHaveLength(0);
      expect(blank.textContent).toBe("");
      expect(blank.previousElementSibling?.className).toBe("page-break");
      expect(output.head.querySelector("style")!.textContent).toContain(".blank-fragment{display:block;height:1pt;margin:0;padding:0}");
    } else {
      expect(output.querySelectorAll(".blank-fragment")).toHaveLength(0);
    }
    expect(output.querySelectorAll("span[style*='break-before']")).toHaveLength(0);
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("rejects page breaks inside table cells instead of silently moving or losing them", async () => {
    const table = applyDocxOperations(await createDocx("Body"), [{ type: "insert-table", rows: 1, columns: 1, cells: [["Cell"]] }]);
    const cellId = table.tables[0].rows[0].cells[0].paragraphs[0].id;
    const document = applyDocxOperations(table, [{ type: "insert-page-break", paragraphId: cellId, offset: 2 }]);
    expect(document.canEdit).toBe(true);
    expect(document.pageBreaks).toHaveLength(1);
    expect(canPrintDocx(document)).toBe(false);
    expect(() => buildDocxPrintHTML(document)).toThrow();
  });

  it("rejects unsupported/read-only markup without changing its bytes", async () => {
    const { document, bytes } = await packageWithMain((xml) => xml.replace("<w:body>", '<w:body><w:altChunk/>'));
    expect(document.canEdit).toBe(false);
    expect(document.diagnostics.some((diagnostic) => diagnostic.severity === "warning")).toBe(true);
    expect(canPrintDocx(document)).toBe(false);
    expect(() => buildDocxPrintHTML(document)).toThrow();
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("fails closed on a warning even if an upstream snapshot still exposes canEdit", async () => {
    const original = await createDocx("Warning text");
    const document = { ...original, diagnostics: [...original.diagnostics, { code: "future-unsupported", severity: "warning" as const, message: "Print representation is incomplete." }] };
    expect(document.canEdit).toBe(true);
    expect(canPrintDocx(document)).toBe(false);
    expect(() => buildDocxPrintHTML(document)).toThrow();
  });

  it("rejects imported runs with multiple text nodes rather than flattening their mid-run break", async () => {
    const { document, bytes } = await packageWithMain((xml) => xml.replace('<w:t xml:space="preserve">BeforeAfter</w:t>', '<w:t>Before</w:t><w:br w:type="page"/><w:t>After</w:t>'));
    expect(document.canEdit).toBe(false);
    expect(canPrintDocx(document)).toBe(false);
    expect(() => buildDocxPrintHTML(document)).toThrow();
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("requires pending revisions to be resolved before printing either text view", async () => {
    const document = applyDocxOperations(await createDocx("OLD PRIVATE TEXT"), [{ type: "track-paragraph-text", paragraphId: "p0", text: "New final text", author: "Synthetic reviewer" }]);
    const bytes = await exportDocx(document);
    expect(document.canEdit).toBe(true);
    expect(document.revisions.length).toBeGreaterThan(0);
    expect(canPrintDocx(document)).toBe(false);
    expect(() => buildDocxPrintHTML(document)).toThrow();
    expect(await exportDocx(document)).toEqual(bytes);
    const accepted = applyDocxOperations(document, [{ type: "accept-all-revisions" }]);
    expect(canPrintDocx(accepted)).toBe(true);
    const output = parse(buildDocxPrintHTML(accepted));
    expect(output.body.textContent).toBe("New final text");
    expect(output.body.textContent).not.toContain("OLD PRIVATE TEXT");
  });
});
