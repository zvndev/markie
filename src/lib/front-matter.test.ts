import { describe, expect, it } from "vitest";
import { splitFrontMatter, joinFrontMatter } from "@/lib/front-matter";

describe("splitFrontMatter", () => {
  it("splits a leading front matter block verbatim", () => {
    const md = "---\ntitle: X\nmarkie:\n  project: P\n---\n# Body\n";
    const { frontMatter, body } = splitFrontMatter(md);
    expect(frontMatter).toBe("---\ntitle: X\nmarkie:\n  project: P\n---\n");
    expect(body).toBe("# Body\n");
    expect(joinFrontMatter(frontMatter, body)).toBe(md);
  });

  it("requires the block to start at byte zero", () => {
    const md = "\n---\nkey: v\n---\nbody\n";
    expect(splitFrontMatter(md)).toEqual({ frontMatter: "", body: md });
  });

  it("does not treat an unterminated --- as front matter", () => {
    const md = "---\nkey: v\nno closer\n";
    expect(splitFrontMatter(md)).toEqual({ frontMatter: "", body: md });
  });

  it("ignores a thematic break later in the document", () => {
    const md = "# T\n\n---\n\nafter\n";
    expect(splitFrontMatter(md).frontMatter).toBe("");
  });

  it("handles CRLF and the ... terminator", () => {
    const md = "---\r\nkey: v\r\n...\r\nbody\r\n";
    const { frontMatter, body } = splitFrontMatter(md);
    expect(frontMatter).toBe("---\r\nkey: v\r\n...\r\n");
    expect(body).toBe("body\r\n");
  });

  it("does not match a longer dash run", () => {
    const md = "----\nnot front matter\n";
    expect(splitFrontMatter(md).frontMatter).toBe("");
  });
});
