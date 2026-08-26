import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMarkieMeta } from "./frontmatter.js";

describe("extractMarkieMeta", () => {
  it("reads a block-style markie mapping", () => {
    const md =
      "---\ntitle: X\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\nbody\n";
    expect(extractMarkieMeta(md)).toEqual({
      project: "Markie",
      block: "organized-workspace",
    });
  });

  it("reads an inline markie mapping", () => {
    const md = "---\nmarkie: { project: \"My App\", block: 'auth flow' }\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "My App", block: "auth flow" });
  });

  it("reads project without block", () => {
    const md = "---\nmarkie:\n  project: Solo\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "Solo", block: null });
  });

  it("ignores markie keys nested under other mappings", () => {
    const md = "---\nouter:\n  markie:\n    project: Nope\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: null, block: null });
  });

  it("stops reading at the end of the markie block", () => {
    const md = "---\nmarkie:\n  project: Real\nother:\n  block: Nope\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "Real", block: null });
  });

  it("returns nulls with no front matter, unterminated fences, or no markie key", () => {
    expect(extractMarkieMeta("# Just a doc\n")).toEqual({ project: null, block: null });
    expect(extractMarkieMeta("---\nmarkie:\n  project: X\n")).toEqual({
      project: null,
      block: null,
    });
    expect(extractMarkieMeta("---\ntitle: X\n---\n")).toEqual({ project: null, block: null });
  });

  it("handles quotes, comments, and CRLF", () => {
    const md =
      "---\r\nmarkie:\r\n  # which project\r\n  project: \"Quoted Name\"\r\n  block: 'single'\r\n---\r\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "Quoted Name", block: "single" });
  });

  it("treats empty values as absent", () => {
    const md = "---\nmarkie:\n  project: \n  block: real\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: null, block: "real" });
  });

  it("reads nothing but nulls out of hostile input", () => {
    expect(extractMarkieMeta(undefined as unknown as string)).toEqual({
      project: null,
      block: null,
    });
    expect(extractMarkieMeta("")).toEqual({ project: null, block: null });
  });
});

// Both runtimes must agree on what a front matter block IS, or the app and the
// main-process extractor read different documents. Text-level parity, the
// ipc-contract style: pull each file's FRONT_MATTER_RE literal, erase plain
// (capturing) group parens so a body-capturing variant compares equal to the
// plain splitter, and compare what is left.
function stripCapturingGroups(source: string): string {
  let out = "";
  let inClass = false;
  const stack: boolean[] = []; // true = the open paren we erased
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      out += ch + (source[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (inClass) {
      out += ch;
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      continue;
    }
    if (ch === "(") {
      const plain = source[i + 1] !== "?";
      stack.push(plain);
      if (!plain) out += ch;
      continue;
    }
    if (ch === ")") {
      const plain = stack.pop();
      if (!plain) out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function frontMatterLiteral(rel: string): string {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const m = /FRONT_MATTER_RE = \/(.+)\/;/.exec(src);
  expect(m, `FRONT_MATTER_RE literal not found in ${rel}`).toBeTruthy();
  return stripCapturingGroups(m![1]);
}

describe("front matter boundary parity", () => {
  it("uses the same boundary as src/lib/front-matter.ts", () => {
    expect(frontMatterLiteral("./frontmatter.js")).toBe(
      frontMatterLiteral("../src/lib/front-matter.ts")
    );
  });

  it("erases only the capturing parens", () => {
    expect(stripCapturingGroups("^a(b)c(?:d|e)$")).toBe("^abc(?:d|e)$");
    expect(stripCapturingGroups("\\(literal\\)[(]")).toBe("\\(literal\\)[(]");
  });
});
