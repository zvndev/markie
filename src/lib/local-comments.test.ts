import { describe, expect, it } from "vitest";
import {
  anchorFor,
  authorName,
  isCommentableDoc,
  markdownToVisible,
  placeThreads,
  projectMarkdown,
  visibleToMarkdown,
  type LocalCommentThread,
} from "./local-comments";

// What the rich pane's text index holds for MD: one line per textblock, no
// markdown syntax (src/lib/rich-search.ts indexSegments).
const MD = [
  "---",
  "title: Plan",
  "---",
  "# The **plan**",
  "",
  "Ship the [comments panel](https://example.com) this *week*.",
  "",
  "- first `item`",
  "- second item <!-- hidden -->",
  "",
  "| a | b |",
  "|---|---|",
  "| ship | it |",
  "",
].join("\n");
const VISIBLE = ["The plan", "Ship the comments panel this week.", "first item", "second item", "a", "b", "ship", "it"].join("\n");

const range = (text: string, quote: string, nth = 0) => {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(quote, at + 1);
  return { from: at, to: at + quote.length };
};

describe("projectMarkdown", () => {
  it("drops front matter, block markers, emphasis, link targets, tags and comments", () => {
    const { text, map } = projectMarkdown(MD);
    expect(text).toContain("The plan");
    expect(text).toContain("Ship the comments panel this week.");
    expect(text).toContain("first item");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("title:");
    // Every projected character points at the same character in the markdown.
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== " " && text[i] !== "\n") expect(MD[map[i]]).toBe(text[i]);
    }
  });

  it("keeps snake_case underscores and code fence contents", () => {
    const { text } = projectMarkdown("call my_func\n\n```\n**raw**\n```\n");
    expect(text).toContain("my_func");
    expect(text).toContain("**raw**");
  });
});

describe("markdown range to rich text", () => {
  it("maps a passage with link syntax inside it", () => {
    const r = markdownToVisible(MD, range(MD, "[comments panel](https://example.com) this"), VISIBLE)!;
    expect(VISIBLE.slice(r.from, r.to)).toBe("comments panel this");
  });

  it("maps emphasis and picks the right copy of repeated words", () => {
    const r = markdownToVisible(MD, range(MD, "ship", 0), VISIBLE)!;
    expect(VISIBLE.slice(r.from, r.to)).toBe("ship");
    expect(r.from).toBe(VISIBLE.indexOf("\nship") + 1);
    const plan = markdownToVisible(MD, range(MD, "**plan**"), VISIBLE)!;
    expect(VISIBLE.slice(plan.from, plan.to)).toBe("plan");
  });

  it("gives null for a range that is only syntax", () => {
    expect(markdownToVisible(MD, range(MD, "|---|---|"), VISIBLE)).toBeNull();
  });
});

describe("rich selection to markdown range", () => {
  it("finds the markdown behind a selection that crosses formatting", () => {
    const r = visibleToMarkdown(MD, VISIBLE, range(VISIBLE, "panel this week"))!;
    expect(MD.slice(r.from, r.to)).toBe("panel](https://example.com) this *week");
  });

  it("keeps the occurrence: the second 'item' maps to the second list line", () => {
    const r = visibleToMarkdown(MD, VISIBLE, range(VISIBLE, "item", 1))!;
    expect(r.from).toBe(MD.indexOf("second item") + "second ".length);
  });

  it("round-trips through an anchor and back onto the rich text", () => {
    const sel = range(VISIBLE, "comments panel");
    const md = visibleToMarkdown(MD, VISIBLE, sel)!;
    const anchor = anchorFor(MD, md)!;
    const [placed] = placeThreads(MD, [thread(anchor)]);
    const back = markdownToVisible(MD, placed.range!, VISIBLE)!;
    expect(back).toEqual(sel);
  });
});

function thread(anchor: LocalCommentThread["anchor"]): LocalCommentThread {
  return { id: "t1", anchor, status: "open", createdAt: "", comments: [] };
}

describe("placeThreads", () => {
  it("re-finds threads after an edit and detaches the deleted ones", () => {
    const keep = anchorFor(MD, range(MD, "this *week*"))!;
    const gone = anchorFor(MD, range(MD, "second item"))!;
    const edited = "Intro.\n\n" + MD.replace("second item", "another");
    const placed = placeThreads(edited, [thread(keep), { ...thread(gone), id: "t2" }]);
    expect(edited.slice(placed[0].range!.from, placed[0].range!.to)).toBe("this *week*");
    expect(placed[1].range).toBeNull();
  });
});

describe("labels", () => {
  it("names the user You and an agent by its name", () => {
    expect(authorName({ kind: "user" })).toBe("You");
    expect(authorName({ kind: "agent", name: "Claude Code" })).toBe("Claude Code");
  });

  it("offers comments on markdown files only", () => {
    expect(isCommentableDoc("/a/b.md")).toBe(true);
    expect(isCommentableDoc("/a/b.MDX")).toBe(true);
    expect(isCommentableDoc("/a/b.txt")).toBe(false);
    expect(isCommentableDoc(null)).toBe(false);
  });
});
