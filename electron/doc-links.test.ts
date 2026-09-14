import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { extractLinks, resolveLinks, linkFingerprint, isDocRef, MAX_DOC_LINKS } =
  require("./doc-links") as typeof import("./doc-links");

describe("extractLinks", () => {
  it("finds inline links, reference definitions and raw anchors, local documents only, once each, decoded", () => {
    const md = [
      "[plan](plan.md)",
      "[again](plan.md)",
      '[sp](<my plan.md> "title")',
      "[enc](my%20notes.md#top)",
      "[q](notes/q.md?x=1)",
      "![pic](shot.png)",
      "![pic that looks like a doc](diagram.md)",
      "[web](https://x.test/a.md)",
      "[proto](//cdn.test/b.md)",
      "[anchor](#heading)",
      "[pdf](spec.pdf)",
      "[noext](plan)",
      '<a href="raw.md">raw</a>',
      "<a href='raw2.markdown'>raw</a>",
      "[ref]: defs/ref.mdx",
      "  [spaced]: <def with space.txt>",
      "```",
      "[fenced](fenced.md)",
      "```",
      "`[inline](inline.md)`",
    ].join("\n");
    expect(extractLinks(md)).toEqual([
      "plan.md",
      "my plan.md",
      "my notes.md",
      "notes/q.md",
      "raw.md",
      "raw2.markdown",
      "defs/ref.mdx",
      "def with space.txt",
    ]);
  });

  it("does not treat an image as a link even when its file is named like a document", () => {
    expect(extractLinks("![](a.md)\n![x](b.md)")).toEqual([]);
  });

  it("keeps the first 500 in document order and drops malformed references", () => {
    const many = Array.from({ length: MAX_DOC_LINKS + 5 }, (_, i) => `[d${i}](d${i}.md)`).join("\n");
    const out = extractLinks(many);
    expect(out).toHaveLength(MAX_DOC_LINKS);
    expect(out[0]).toBe("d0.md");
    expect(out[MAX_DOC_LINKS - 1]).toBe(`d${MAX_DOC_LINKS - 1}.md`);
    expect(extractLinks(`[c](a%00b.md)`)).toEqual([]);
    expect(extractLinks(`[long](${"x".repeat(2100)}.md)`)).toEqual([]);
  });

  it("gives up on a document over the extraction ceiling", () => {
    expect(extractLinks("[a](a.md)\n" + "x".repeat(4 * 1024 * 1024 + 1))).toEqual([]);
  });
});

describe("isDocRef", () => {
  it("accepts the four document extensions and nothing else", () => {
    for (const ref of ["a.md", "A.MD", "b.markdown", "c.mdx", "d.txt", "dir/e.md"]) expect(isDocRef(ref)).toBe(true);
    for (const ref of ["a.pdf", "a.png", "a", "a.md/", ".md.bak"]) expect(isDocRef(ref)).toBe(false);
  });
});

describe("resolveLinks", () => {
  function fixture() {
    const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "markie-doc-links-")));
    mkdirSync(path.join(dir, "notes"));
    writeFileSync(path.join(dir, "plan.md"), "# plan");
    writeFileSync(path.join(dir, "notes", "q.md"), "# q");
    symlinkSync(path.join(dir, "plan.md"), path.join(dir, "alias.md"));
    return { dir, docPath: path.join(dir, "doc.md") };
  }

  it("maps each ref to the registry's cloud id for the real file, and skips the rest", () => {
    const { dir, docPath } = fixture();
    const rows = new Map<string, { cloud_doc_id: string | null }>([
      [path.join(dir, "plan.md"), { cloud_doc_id: "c-plan" }],
      [path.join(dir, "notes", "q.md"), { cloud_doc_id: null }],
    ]);
    const registry = { get: (p: string) => rows.get(p) ?? null };
    const { links, fingerprint } = resolveLinks(["plan.md", "alias.md", "notes/q.md", "missing.md", "../outside.md"], { docPath, registry });
    expect(links).toEqual([
      { ref: "plan.md", target: "c-plan" },
      { ref: "alias.md", target: "c-plan" },
    ]);
    expect(fingerprint).toBe(linkFingerprint(links));
  });

  it("looks a missing file up under its unresolved path so a synced file that is not on disk still counts", () => {
    const { dir, docPath } = fixture();
    const registry = { get: (p: string) => (p === path.join(dir, "gone.md") ? { cloud_doc_id: "c-gone" } : null) };
    expect(resolveLinks(["gone.md"], { docPath, registry }).links).toEqual([{ ref: "gone.md", target: "c-gone" }]);
  });
});

describe("linkFingerprint", () => {
  it("ignores order, changes with a target, and has one value for no links", () => {
    const a = linkFingerprint([{ ref: "a.md", target: "1" }, { ref: "b.md", target: "2" }]);
    const b = linkFingerprint([{ ref: "b.md", target: "2" }, { ref: "a.md", target: "1" }]);
    const c = linkFingerprint([{ ref: "a.md", target: "9" }, { ref: "b.md", target: "2" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(linkFingerprint([])).toBe(linkFingerprint([]));
    expect(linkFingerprint([])).not.toBe(a);
  });
});
