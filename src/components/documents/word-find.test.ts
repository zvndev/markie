import { describe, expect, it } from "vitest";
import { createDocx, exportDocx, openDocx } from "@/lib/office/docx";
import { readZip, writeZip } from "@/lib/office/zip";
import { findWordText, replaceWordText } from "./word-find";

async function styledDocument() {
  const parts = await readZip(await exportDocx(await createDocx("")));
  const main = parts.find((part) => part.name === "word/document.xml")!;
  main.data = new TextEncoder().encode(new TextDecoder().decode(main.data).replace(/<w:body>[\s\S]*<\/w:body>/,
    '<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>red gr</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>een red</w:t></w:r></w:p></w:body>'));
  return openDocx(writeZip(parts));
}
describe("literal Word find and replace", () => {
  it("finds exact offsets in each paragraph", async () => {
    const document = await createDocx("one one\ntwo one");
    expect(findWordText(document, "one")).toEqual([
      { paragraphId: document.paragraphs[0].id, start: 0, end: 3 },
      { paragraphId: document.paragraphs[0].id, start: 4, end: 7 },
      { paragraphId: document.paragraphs[1].id, start: 4, end: 7 },
    ]);
    expect(findWordText(document, "")).toEqual([]);
  });
  it("replaces a match across styled runs without flattening the rest", async () => {
    const original = await styledDocument();
    const result = replaceWordText(original, "green", "blue");
    expect(result.count).toBe(1);
    const reopened = await openDocx(await exportDocx(result.document));
    expect(reopened.text).toBe("red blue red");
    expect(reopened.paragraphs[0].runs[0].style.bold).toBe(true);
    expect(reopened.paragraphs[0].runs[1].style.italic).toBe(true);
    expect(reopened.paragraphs[0].runs[1].text).toBe(" red");
    expect(original.text).toBe("red green red");
  });
  it("replaces repeated text from right to left without offset drift", async () => {
    const original = await styledDocument();
    expect(replaceWordText(original, "red", "pink").document.text).toBe("pink green pink");
    expect(replaceWordText(original, "red", "", 1).document.text).toBe("red green ");
    expect(replaceWordText(original, "missing", "x")).toEqual({ document: original, count: 0 });
    expect(() => replaceWordText(original, "red", "paragraph\nbreak")).toThrow(/paragraph breaks/);
  });
});
