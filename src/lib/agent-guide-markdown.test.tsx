// The markdown half of what agents are taught (mcp/markdown-guide.mjs).
//
// The guide tells an agent which elements Markie draws and where the editor
// (Rich) and the export renderer (PDF, print, shared web page) differ. Each
// sentence about an element is a claim, and a claim nobody re-measures turns
// into the thing the guide's header warns about. So each one is pinned here,
// against the real editor extension list and the real export pipeline. The
// Darkmown half lives in src/lib/darkmown/agent-guide.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { extractHoldAsides } from "@/lib/rich-hold-aside";
import { splitFrontMatter } from "@/lib/front-matter";
import { isDocHref } from "@/lib/doc-links";
import { MARKDOWN_GUIDE } from "../../mcp/markdown-guide.mjs";
import { buildAppCsp } from "../../electron/csp.js";

/** What the Markie editor makes of a document: the same steps the rich pane takes. */
function rich(markdown: string): { html: string; markdown: string } {
  const { body } = splitFrontMatter(markdown);
  const { text } = extractHoldAsides(body);
  const editor = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
  try {
    editor.commands.setContent(text, { emitUpdate: false });
    const written = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
    return { html: editor.getHTML(), markdown: written };
  } finally {
    editor.destroy();
  }
}

const exported = (markdown: string) => renderMarkdownHTML(markdown);

/** Every fenced block in a markdown string, honouring fence length so a four backtick fence can hold a three backtick one. */
function fences(markdown: string): { info: string; body: string }[] {
  const out: { info: string; body: string }[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(`{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const ticks = open[1].length;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !new RegExp(`^\`{${ticks},}\\s*$`).test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    out.push({ info: open[2].trim(), body: body.join("\n") });
  }
  return out;
}

describe("every markdown example the guide shows", () => {
  const blocks = fences(MARKDOWN_GUIDE).filter((f) => f.info === "markdown");

  it("is there in strength", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(12);
  });

  it("renders in the export pipeline without falling back to source", () => {
    for (const { body } of blocks) {
      expect(exported(body), body).not.toContain("markie-render-error");
    }
  });

  it("parses in the editor", () => {
    for (const { body } of blocks) {
      expect(() => rich(body), body).not.toThrow();
    }
  });
});

describe("structure", () => {
  it("draws six heading levels in both places", () => {
    const md = "# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6\n";
    for (const html of [rich(md).html, exported(md)]) {
      for (const level of [1, 2, 3, 4, 5, 6]) expect(html).toContain(`<h${level}>`);
    }
  });

  it("gives headings no anchors, so a table of contents of #links goes nowhere", () => {
    const md = "[Jump](#section)\n\n## Section\n";
    expect(rich(md).html).toContain("<h2>Section</h2>");
    expect(exported(md)).toContain("<h2>Section</h2>");
    expect(exported(md)).not.toMatch(/<h2[^>]*\sid=/);
  });

  it("keeps front matter out of the editor and prints it as text in an export", () => {
    const md = "---\nmarkie:\n  project: bevrly\n  block: checkout-redesign\n---\n\n# Checkout redesign\n";
    expect(splitFrontMatter(md).frontMatter).toContain("project: bevrly");
    expect(rich(md).html).not.toContain("bevrly");
    expect(exported(md)).toContain("<hr>");
    expect(exported(md)).toContain("project: bevrly");
  });
});

describe("headings, emphasis, lists, tasks, tables", () => {
  it("draws bold, italic, strikethrough and code in both places", () => {
    const md = "**b** *i* ~~s~~ `c`\n";
    expect(rich(md).html).toMatch(/<strong>b<\/strong> <em>i<\/em> <s>s<\/s> <code>c<\/code>/);
    expect(exported(md)).toMatch(/<strong>b<\/strong> <em>i<\/em> <del>s<\/del> <code>c<\/code>/);
  });

  it("draws nested bullets and numbered steps in both places", () => {
    const md = "- a\n  - nested\n\n1. one\n2. two\n";
    expect(rich(md).html).toMatch(/<ul[^>]*>[\s\S]*<ul[^>]*>[\s\S]*nested[\s\S]*<\/ul>[\s\S]*<ol/);
    expect(exported(md)).toMatch(/<ul>[\s\S]*<ul>[\s\S]*nested[\s\S]*<\/ul>[\s\S]*<ol>/);
  });

  it("draws task lists as checkboxes, read-only in an export", () => {
    const md = "- [x] Draft the plan\n- [ ] Get review\n";
    expect(rich(md).html).toContain('data-type="taskList"');
    expect(rich(md).html).toContain('type="checkbox" checked="checked"');
    expect(exported(md)).toContain('<input type="checkbox" checked disabled>');
    expect(exported(md)).toContain('<input type="checkbox" disabled>');
  });

  it("aligns table columns by the colons in the delimiter row, in both places", () => {
    const md = "| Option | Cost |\n| :--- | ---: |\n| Rebuild | 12 days |\n";
    expect(rich(md).html).toContain('<th style="text-align: left;">');
    expect(rich(md).html).toContain('<th style="text-align: right;">');
    expect(exported(md)).toContain('<th align="left">');
    expect(exported(md)).toContain('<th align="right">');
  });

  it("keeps bold, code and links inside a table cell, but not a list", () => {
    const md = "| A |\n| - |\n| **b** `c` [d](e.md) |\n\n| A |\n| - |\n| - item |\n";
    expect(exported(md)).toContain("<td><strong>b</strong> <code>c</code> <a href=\"e.md\">d</a></td>");
    expect(exported(md)).not.toMatch(/<td>\s*<ul>/);
    expect(rich(md).html).toContain("<strong>b</strong>");
    expect(rich(md).html).toContain("<p>- item</p>");
    expect(rich(md).html).not.toContain("<li>");
  });

  it("drops the alignment colons when Rich rewrites a table", () => {
    const md = "| Option | Cost |\n| :--- | ---: |\n| Rebuild | 12 days |\n";
    expect(rich(md).markdown).not.toContain(":---");
  });
});

describe("notes, code and what does not exist", () => {
  it("draws a blockquote with a bold label in both places", () => {
    const md = "> **Note:** The export runs nightly.\n";
    expect(rich(md).html).toContain("<blockquote><p><strong>Note:</strong> The export runs nightly.</p></blockquote>");
    expect(exported(md)).toContain("<strong>Note:</strong> The export runs nightly.");
  });

  it("has no callouts: [!NOTE] is a plain quote with the literal words", () => {
    const md = "> [!NOTE]\n> A note.\n";
    expect(rich(md).html).toContain("<blockquote><p>[!NOTE] A note.</p></blockquote>");
    expect(exported(md)).toMatch(/<blockquote>\s*<p>\[!NOTE\]\s*A note\.<\/p>\s*<\/blockquote>/);
    expect(exported(md)).not.toMatch(/callout|admonition|markdown-alert/);
  });

  it("highlights fenced code in an export and shows it plain in the editor", () => {
    const md = "```ts\nconst total = items.length;\n```\n";
    expect(exported(md)).toContain('<code class="hljs language-ts">');
    expect(exported(md)).toContain("hljs-keyword");
    expect(rich(md).html).toContain('<code class="language-ts">');
    expect(rich(md).html).not.toContain("hljs");
  });

  it("draws no diagram for a mermaid block", () => {
    const md = "```mermaid\ngraph TD; A-->B;\n```\n";
    expect(exported(md)).toContain("language-mermaid");
    expect(exported(md)).not.toContain("<svg");
    expect(rich(md).html).toContain("language-mermaid");
    expect(rich(md).html).not.toContain("<svg");
  });

  it("leaves emoji shortcodes as text", () => {
    expect(rich("Hello :tada:\n").html).toContain("Hello :tada:");
    expect(exported("Hello :tada:\n")).toContain("Hello :tada:");
  });

  it("draws a rule and links, and turns a bare address into a link", () => {
    expect(rich("a\n\n---\n\nb\n").html).toContain("<hr>");
    expect(exported("a\n\n---\n\nb\n")).toContain("<hr>");
    expect(rich("see https://example.org\n").html).toContain('href="https://example.org"');
    expect(exported("see https://example.org\n")).toContain('<a href="https://example.org">');
  });
});

describe("links to other documents", () => {
  it("writes a relative link as an ordinary link, and follows .md .markdown .mdx .txt targets", () => {
    expect(rich("[the plan](plan.md)\n").html).toContain('href="plan.md"');
    expect(exported("[the plan](plan.md)\n")).toContain('<a href="plan.md">');
    for (const href of ["plan.md", "plan.markdown", "plan.mdx", "notes.txt", "sub/plan.md#part"]) expect(isDocHref(href), href).toBe(true);
    for (const href of ["spec.pdf", "board.wd", "https://example.com/plan.md", "#top"]) expect(isDocHref(href), href).toBe(false);
  });
});

describe("pictures, video and audio", () => {
  it("draws a picture, a player or a recording by extension, in both places", () => {
    expect(rich("![alt](shot.png)\n").html).toContain('<img src="shot.png" alt="alt">');
    expect(rich("![clip](clip.mp4)\n").html).toContain("<video");
    expect(rich("![memo](memo.mp3)\n").html).toContain("<audio");
    expect(exported("![alt](shot.png)\n")).toContain('<img src="shot.png" alt="alt">');
    expect(exported("![clip](clip.mp4)\n")).toContain("<video");
    expect(exported("![memo](memo.mp3)\n")).toContain("<audio");
    for (const ext of ["mp4", "m4v", "webm", "ogv", "mov"]) expect(exported(`![v](x.${ext})\n`), ext).toContain("<video");
    for (const ext of ["mp3", "m4a", "aac", "wav", "flac", "oga", "opus"]) expect(exported(`![a](x.${ext})\n`), ext).toContain("<audio");
  });

  it("embeds nothing for a PDF", () => {
    expect(exported("![](report.pdf)\n")).not.toContain("<video");
    expect(exported("![](report.pdf)\n")).not.toContain("<audio");
  });

  it("sizes a picture or clip by its own tag, width only, in both places", () => {
    const md = '<img src="demo/shot.png" alt="the dashboard" width="240">\n';
    expect(rich(md).html).toContain('width="240"');
    expect(exported(md)).toContain('width="240"');
    expect(rich(md).html).not.toContain("markie-hold");
    const clip = '<video src="demo/clip.mp4" width="320" controls></video>\n';
    expect(exported(clip)).toContain('width="320"');
  });

  it("carries a picture inline as a data URI in both places", () => {
    const md = "![dot](data:image/png;base64,iVBORw0KGgo=)\n";
    expect(rich(md).html).toContain("data:image/png;base64");
    expect(exported(md)).toContain("data:image/png;base64");
  });

  it("allows an https picture in the app, but plays video and audio only from local files", () => {
    const csp = buildAppCsp("missing-out-dir").split("; ");
    expect(csp.find((d: string) => d.startsWith("img-src "))).toContain(" https: ");
    const media = csp.find((d: string) => d.startsWith("media-src ")) ?? "";
    expect(media).not.toContain("https:");
    expect(media).toContain("markie-asset:");
  });

  it("turns a bare YouTube address alone on a line into a card, and leaves it a link in a sentence", () => {
    expect(rich("https://youtu.be/dQw4w9WgXcQ\n").html).toContain('data-markie-embed="https://youtu.be/dQw4w9WgXcQ"');
    expect(exported("https://youtu.be/dQw4w9WgXcQ\n")).toContain("i.ytimg.com/vi/dQw4w9WgXcQ");
    expect(rich("watch https://youtu.be/dQw4w9WgXcQ now\n").html).not.toContain("data-markie-embed");
    expect(exported("[watch this](https://youtu.be/dQw4w9WgXcQ)\n")).not.toContain("ytimg");
    // Vimeo: a card in the editor, a plain link in an export.
    expect(rich("https://vimeo.com/76979871\n").html).toContain("data-markie-embed");
    expect(exported("https://vimeo.com/76979871\n")).not.toContain("<img");
  });
});

describe("alignment, inline HTML and raw blocks", () => {
  it("centres a paragraph or heading written as its own tag, in both places", () => {
    for (const md of ['<p style="text-align: center;">middle</p>\n', '<h2 style="text-align: right;">Appendix</h2>\n']) {
      expect(rich(md).html).toContain("text-align");
      expect(rich(md).html).not.toContain("markie-hold");
      expect(exported(md)).toContain("text-align");
    }
  });

  it("keeps mark, underline and colour in both places", () => {
    const md = 'a <mark>flag</mark> and <u>under</u> and <span style="color: #b91c1c">red</span>\n';
    expect(rich(md).html).toContain("<mark>flag</mark>");
    expect(rich(md).html).toContain("<u>under</u>");
    expect(rich(md).html).toMatch(/<span style="color: rgb\(185, 28, 28\);">red<\/span>/);
    expect(exported(md)).toContain("<mark>flag</mark>");
    expect(exported(md)).toContain("<u>under</u>");
    expect(exported(md)).toContain('<span style="color: #b91c1c">red</span>');
  });

  it("keeps font and size in both places, drops a span's background in the editor, and drops small and abbr everywhere", () => {
    const font = 'a <span style="font-family: Georgia">F</span> <span style="font-size: 24px">S</span> z\n';
    expect(rich(font).html).toContain('<span style="font-family: Georgia;">F</span>');
    expect(rich(font).html).toContain('<span style="font-size: 24px;">S</span>');
    expect(exported(font)).toContain('<span style="font-family: Georgia">F</span>');
    const bg = 'a <span style="background-color: yellow">B</span> z\n';
    expect(rich(bg).html).toContain("<span>B</span>");
    expect(exported(bg)).toContain('style="background-color: yellow"');
    const marks = "a <kbd>K</kbd> <sub>s</sub> <sup>p</sup> <ins>i</ins> z\n";
    expect(rich(marks).html).toContain("a K s p i z");
    expect(exported(marks)).toContain("<kbd>K</kbd> <sub>s</sub> <sup>p</sup> <ins>i</ins>");
    const small = 'a <small>sm</small> <abbr title="x">ab</abbr> z\n';
    expect(rich(small).html).toContain("a sm ab z");
    expect(exported(small)).toContain("a sm ab z");
    const rewritten = 'a <b>b</b> <i>i</i> <del>d</del> <code>c</code> <a href="https://x.com">l</a> z\n';
    expect(rich(rewritten).markdown).toBe("a **b** *i* ~~d~~ `c` [l](https://x.com) z");
    expect(exported(rewritten)).toContain("<b>b</b> <i>i</i> <del>d</del>");
  });

  it("drops the tag and keeps the text for figure, figcaption, center, header, footer and aside in an export", () => {
    for (const tag of ["figure", "figcaption", "center", "header", "footer", "aside"]) {
      const html = exported(`<${tag}>kept text</${tag}>\n`);
      expect(html, tag).toContain("kept text");
      expect(html, tag).not.toContain(`<${tag}`);
    }
    for (const tag of ["div", "details", "table", "blockquote", "section", "pre"]) {
      expect(exported(`<${tag}>x</${tag}>\n`), tag).toContain(`<${tag}`);
    }
  });

  it("reads an aligned paragraph only when it is written plainly, and keeps markdown out of it", () => {
    expect(rich('<p class="x" style="text-align: center;">c</p>\n').html).toMatch(/markie-hold/);
    expect(rich("<p style='text-align: center;'>c</p>\n").html).toMatch(/markie-hold/);
    expect(exported('<p style="text-align: center;">**bold**</p>\n')).toContain("**bold**");
    expect(exported('<p style="text-align: center;"><strong>bold</strong></p>\n')).toContain("<strong>bold</strong>");
  });

  it("shows a placeholder token in the editor for a block that starts with another tag", () => {
    const md = "<details>\n<summary>More</summary>\n\nHidden text.\n\n</details>\n";
    expect(exported(md)).toContain("<details>");
    expect(exported(md)).toContain("<summary>More</summary>");
    expect(rich(md).html).toMatch(/markie-hold-\d+-[0-9a-f]{8}/);
    expect(rich(md).html).not.toContain("<details");
  });

  it("renders script, iframe, style, object, form, handlers and javascript: links nowhere", () => {
    const md = [
      "<script>alert(1)</script>",
      "",
      '<iframe src="https://example.com"></iframe>',
      "",
      "<style>p { color: red }</style>",
      "",
      '<object data="x.swf"></object>',
      "",
      '<form action="/x"><input name="a"></form>',
      "",
      '<img src="x.png" onerror="alert(1)">',
      "",
      "[click](javascript:alert(1))",
      "",
    ].join("\n");
    const html = exported(md);
    for (const bad of ["<script", "<iframe", "<style", "<object", "<form", "onerror", "javascript:", "alert(1)", "color: red"]) {
      expect(html, bad).not.toContain(bad);
    }
  });
});

describe("math and footnotes", () => {
  it("render in an export and stay literal text in the editor", () => {
    const md = "Euler: $e^{i\\pi} + 1 = 0$\n\n$$\nE = mc^2\n$$\n\nA claim[^1]\n\n[^1]: The source.\n";
    const html = exported(md);
    expect(html).toContain('class="katex"');
    expect(html).toContain("data-footnotes");
    const editor = rich(md).html;
    expect(editor).not.toContain("katex");
    expect(editor).toContain("$e^{i\\pi} + 1 = 0$");
    expect(editor).toContain("[^1]");
  });
});

describe("the markdown samples shipped with the test guide", () => {
  const dir = path.resolve(__dirname, "../../docs/document-testing/samples");
  const samples = readdirSync(dir).filter((name) => name.endsWith(".md"));

  it("include the agent-guide one", () => {
    expect(samples).toEqual(expect.arrayContaining(["Media-and-links.md", "Rich-document.md"]));
  });

  for (const name of samples) {
    it(`${name} renders in both places without falling back to source`, () => {
      const source = readFileSync(path.join(dir, name), "utf8");
      expect(exported(source)).not.toContain("markie-render-error");
      expect(() => rich(source)).not.toThrow();
    });
  }

  it("Rich-document.md draws what the test guide says it does", () => {
    const source = readFileSync(path.join(dir, "Rich-document.md"), "utf8");
    const editor = rich(source).html;
    expect(editor).toContain('data-type="taskList"');
    expect(editor).toContain('<th style="text-align: right;">');
    expect(editor).toContain("<mark>flagged</mark>");
    expect(editor).toContain("$g = (n - b) / b$");
    const html = exported(source);
    expect(html).toContain('class="katex"');
    expect(html).toContain("data-footnotes");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain('<input type="checkbox" checked disabled>');
  });
});
