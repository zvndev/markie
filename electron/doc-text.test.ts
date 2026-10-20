import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDocx, exportDocx } from "../src/lib/office/docx";
import { odtFixture } from "../src/lib/office/odt.fixture";
import { basicRtfFixture } from "../src/lib/office/rtf.fixture";
import { writeZip } from "../src/lib/office/zip";
import { createTextCache, excerpt, extractSearchText, htmlText, rtfText, searchDocuments, textFromBytes } from "./doc-text.js";

type Row = { path: string; name: string; dir: string; mtimeMs: number; format: string };

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "markie-doc-text-"));
}

function write(dir: string, name: string, bytes: Uint8Array | string, mtimeMs = Date.now()): Row {
  const full = path.join(dir, name);
  fs.writeFileSync(full, bytes);
  fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  const ext = name.split(".").pop()!;
  const format = ({ md: "markdown", txt: "text", docx: "docx", odt: "odt", rtf: "rtf", html: "html", doc: "doc", json: "json" } as Record<string, string>)[ext];
  return { path: full, name, dir, mtimeMs, format };
}

describe("search text extraction", () => {
  it("reads the words out of a real DOCX package", async () => {
    const bytes = await exportDocx(await createDocx("Quarterly revenue grew\nacross every region"));
    const text = textFromBytes(Buffer.from(bytes), "docx");
    expect(text).toContain("Quarterly revenue grew");
    expect(text).toContain("across every region");
    expect(text).not.toContain("<w:");
  });

  it("reads ODT paragraphs, spaces, tabs and line breaks", () => {
    const text = textFromBytes(Buffer.from(odtFixture()), "odt");
    expect(text).toContain("OpenDocument editing works.");
    expect(text).toContain("café, Ελληνικά, 日本語, 👋");
    expect(text).not.toMatch(/Editorial|Centered/);
  });

  it("strips RTF control words and tables but keeps Unicode body text", () => {
    const text = rtfText(Buffer.from(basicRtfFixture()).toString("latin1"));
    expect(text).toContain("Rich text in Markie");
    expect(text).toContain("Plain, italic, underline, Unicode é");
    expect(text).not.toMatch(/Georgia|Arial|generator|\\/);
  });

  it("decodes RTF code-page escapes", () => {
    expect(rtfText(String.raw`{\rtf1\ansi caf\'e9 \'93quoted\'94\par}`)).toBe("café “quoted”");
  });

  it("drops script and style from HTML", () => {
    expect(htmlText("<style>p{}</style><p>Hello&nbsp;<b>world</b></p><script>alert(1)</script>")).toBe("Hello world");
  });

  it("refuses to scrape text out of legacy DOC bytes", () => {
    expect(textFromBytes(Buffer.from("word soup"), "doc")).toBeNull();
  });

  it("treats a NUL-bearing text file as binary", () => {
    expect(textFromBytes(Buffer.from([0x61, 0, 0x62]), "text")).toBeNull();
  });

  it("refuses a ZIP part that would inflate past its ceiling", () => {
    const huge = new Uint8Array(30 * 1024 * 1024).fill(0x41);
    const bytes = writeZip([{ name: "word/document.xml", data: huge }], { maxEntryBytes: huge.length + 1, maxExpandedBytes: huge.length + 1, maxArchiveBytes: 64 * 1024 * 1024 });
    expect(textFromBytes(Buffer.from(bytes), "docx")).toBeNull();
  });

  it("caches by path, mtime and size", async () => {
    const dir = tempDir();
    const row = write(dir, "note.txt", "first draft");
    const cache = createTextCache();
    expect(await extractSearchText(row.path, "text", { cache })).toBe("first draft");
    fs.writeFileSync(row.path, "second draft!");
    expect(await extractSearchText(row.path, "text", { cache })).toBe("second draft!");
    expect(cache.size).toBe(1);
  });

  it("evicts the oldest entries past its budget", () => {
    const cache = createTextCache({ budget: 10 });
    cache.set("a", "1", "123456");
    cache.set("b", "1", "123456");
    expect(cache.get("a", "1")).toBeUndefined();
    expect(cache.get("b", "1")).toBe("123456");
  });
});

describe("excerpt", () => {
  it("windows the first hit and marks every term", () => {
    const text = `${"x ".repeat(100)}the launch plan is ready for the launch review`;
    const result = excerpt(text, ["launch"], 40)!;
    expect(result.text.startsWith("…")).toBe(true);
    const marked = result.marks.map(([start, end]) => result.text.slice(start, end).toLowerCase());
    expect(marked).toEqual(["launch", "launch"]);
  });
});

describe("searchDocuments", () => {
  it("finds a phrase inside a DOCX, RTF and Markdown file and filters by type", async () => {
    const dir = tempDir();
    const docx = write(dir, "board.docx", await exportDocx(await createDocx("Northwind budget approved")), 3000);
    const rtf = write(dir, "memo.rtf", String.raw`{\rtf1\ansi The Northwind budget memo\par}`, 2000);
    const md = write(dir, "notes.md", "# Notes\nNorthwind budget follow-ups", 1000);
    const other = write(dir, "unrelated.txt", "nothing to see", 4000);
    const cache = createTextCache();

    const all = await searchDocuments([docx, rtf, md, other], "northwind budget", { cache });
    expect(all.results.map((hit: { name: string }) => hit.name)).toEqual(["board.docx", "memo.rtf", "notes.md"]);
    expect(all.results[0].excerpt).toContain("Northwind budget approved");

    const onlyRtf = await searchDocuments([docx, rtf, md, other], "northwind", { formats: ["rtf"], cache });
    expect(onlyRtf.results.map((hit: { name: string }) => hit.name)).toEqual(["memo.rtf"]);
  });

  it("ranks a name match above a body match", async () => {
    const dir = tempDir();
    const body = write(dir, "a.md", "roadmap details", 5000);
    const named = write(dir, "roadmap.md", "nothing", 1000);
    const result = await searchDocuments([body, named], "roadmap", { cache: createTextCache() });
    expect(result.results.map((hit: { name: string }) => hit.name)).toEqual(["roadmap.md", "a.md"]);
    expect(result.results[0].nameHit).toBe(true);
  });

  it("lists recent files of the chosen types when the query is empty", async () => {
    const rows: Row[] = [
      { path: "/a.md", name: "a.md", dir: "/", mtimeMs: 1, format: "markdown" },
      { path: "/b.docx", name: "b.docx", dir: "/", mtimeMs: 2, format: "docx" },
    ];
    const result = await searchDocuments(rows, "  ", { formats: ["docx"] });
    expect(result.results.map((hit: { path: string }) => hit.path)).toEqual(["/b.docx"]);
  });

  it("stops reading bodies when its time budget runs out but still matches names", async () => {
    const dir = tempDir();
    const rows = [write(dir, "alpha plan.md", "x", 3), write(dir, "beta.md", "plan inside", 2)];
    let clock = 0;
    const result = await searchDocuments(rows, "plan", { maxMs: 5, now: () => (clock += 10), cache: createTextCache() });
    expect(result.partial).toBe(true);
    expect(result.results.map((hit: { name: string }) => hit.name)).toEqual(["alpha plan.md"]);
  });

  it("abandons a search a newer one superseded", async () => {
    const dir = tempDir();
    const rows = [write(dir, "one.md", "plan"), write(dir, "two.md", "plan")];
    const cache = createTextCache();
    const first = searchDocuments(rows, "plan", { cache });
    const second = searchDocuments(rows, "plan", { cache });
    expect((await first).superseded).toBe(true);
    expect((await second).results).toHaveLength(2);
  });
});
