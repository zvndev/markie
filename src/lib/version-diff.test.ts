// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import {
  markDiffHtml,
  markMarkdownChanges,
  markSourceChanges,
  markedSpans,
  similarity,
  wordDiff,
} from "@/lib/version-diff";

// Render the way the history view does, and read back what is marked.
function rendered(before: string, after: string): HTMLElement {
  const merged = markMarkdownChanges(before, after);
  const host = document.createElement("div");
  host.innerHTML = markDiffHtml(renderMarkdownHTML(merged.text));
  return host;
}
const texts = (root: HTMLElement, sel: string) => Array.from(root.querySelectorAll(sel)).map((n) => n.textContent);

describe("wordDiff", () => {
  it("marks the changed words and keeps the rest", () => {
    expect(wordDiff("the quick fox", "the slow fox")).toEqual([
      { kind: "same", text: "the " },
      { kind: "del", text: "quick" },
      { kind: "ins", text: "slow" },
      { kind: "same", text: " fox" },
    ]);
  });

  it("reads a replaced phrase as one change, not alternating fragments", () => {
    const spans = wordDiff("a quick brown fox", "a slow red fox");
    expect(spans.filter((s) => s.kind !== "same")).toEqual([
      { kind: "del", text: "quick brown" },
      { kind: "ins", text: "slow red" },
    ]);
  });

  it("scores likeness by shared words", () => {
    expect(similarity("one two three", "one two three")).toBe(1);
    expect(similarity("one two three four", "one two three five")).toBeGreaterThan(0.7);
    expect(similarity("alpha beta", "gamma delta")).toBe(0);
  });
});

describe("markMarkdownChanges, rendered", () => {
  it("highlights inserted and removed words inside a paragraph", () => {
    const root = rendered("The cat sat on the mat.\n", "The cat slept on the warm mat.\n");
    expect(texts(root, "ins.markie-vh-ins")).toEqual(["slept", "warm"]);
    expect(texts(root, "del.markie-vh-del")).toEqual(["sat"]);
    expect(root.querySelector("p")?.textContent).toBe("The cat satslept on the warm mat.");
  });

  it("keeps a changed list item a list item, and a heading a heading", () => {
    const root = rendered("# Plan\n\n- eggs\n- milk\n", "# Plan B\n\n- eggs\n- oat milk\n- bread\n");
    expect(root.querySelector("h1 ins")?.textContent).toBe("B");
    const items = root.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[1].querySelector("ins")?.textContent).toBe("oat");
    expect(items[2].querySelector("ins")?.textContent).toBe("bread");
  });

  it("wraps a block only one side has", () => {
    const root = rendered("Intro.\n\nOld paragraph here.\n", "Intro.\n\n## A new section\n\nIntro.\n");
    expect(root.querySelector(".markie-vh-block.markie-vh-ins h2")?.textContent).toBe("A new section");
    expect(root.querySelector(".markie-vh-block.markie-vh-del p")?.textContent).toBe("Old paragraph here.");
  });

  it("marks changed lines inside a code fence without breaking the fence", () => {
    const root = rendered("```js\nconst a = 1;\nconst b = 2;\n```\n", "```js\nconst a = 1;\nconst b = 3;\n```\n");
    expect(root.querySelectorAll("pre")).toHaveLength(1);
    expect(root.querySelector("pre")?.textContent).toContain("const a = 1;");
    expect(texts(root, "pre ins")).toEqual(["3"]);
    expect(texts(root, "pre del")).toEqual(["2"]);
  });

  it("marks a changed table cell and keeps the table", () => {
    const before = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const after = "| a | b |\n| --- | --- |\n| 1 | 5 |\n| 3 | 4 |\n";
    const root = rendered(before, after);
    expect(root.querySelectorAll("table")).toHaveLength(1);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(texts(root, "td ins")).toEqual(["5", "3", "4"]);
  });

  it("leaves an unchanged document unmarked", () => {
    const res = markMarkdownChanges("# Same\n", "# Same\n");
    expect(res).toEqual({ text: "# Same\n", changed: false, skipped: false });
  });

  it("strips sentinel characters a document happened to contain", () => {
    const res = markMarkdownChanges("ab\n", "ab\n");
    expect(res.text).toBe("ab\n");
  });

  it("never lets an unclosed mark colour the next block", () => {
    const host = document.createElement("div");
    host.innerHTML = markDiffHtml("<p>one two</p><p>three</p>");
    expect(texts(host, "ins")).toEqual(["two"]);
    expect(host.querySelectorAll("p")[1].innerHTML).toBe("three");
  });

  it("drops sentinels that landed in an attribute", () => {
    const host = document.createElement("div");
    host.innerHTML = markDiffHtml('<p><a href="https://a.test/x">l</a></p>');
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://a.test/x");
  });
});

describe("markSourceChanges", () => {
  it("marks words in changed lines and whole added lines", () => {
    const res = markSourceChanges("a,b\n1,2\n", "a,b\n1,3\n4,5\n");
    const spans = markedSpans(res.text);
    expect(spans.filter((s) => s.kind === "del").map((s) => s.text)).toEqual(["2"]);
    expect(spans.filter((s) => s.kind === "ins").map((s) => s.text)).toEqual(["3", "4,5"]);
  });
});
