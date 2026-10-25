// What the guide tells agents about a shared web page, measured against the
// renderer that draws it.
//
// mcp/markdown-guide.mjs makes claims about markdown in two places: the editor
// and the export (src/lib/markdown-html.ts), which src/lib/agent-guide-markdown
// .test.tsx pins, and the web page a link opens, which is this file's
// renderer (render.ts, a copy of the export pipeline with its own sanitize
// schema). The two are meant to agree, and a claim proven only against the
// first says nothing about the second. Every shape the guide shows and every
// sentence it writes about "shared pages" is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownHTML, renderSharedDocPage } from "./render.ts";
import { MARKDOWN_GUIDE } from "../../mcp/markdown-guide.mjs";

const html = (markdown: string, opts = {}) => renderMarkdownHTML(markdown, opts);

/** Every fenced block in a string, honouring fence length so four backticks can hold three. */
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

test("every markdown example in the guide renders on a shared page, and nothing in it can run", () => {
  const blocks = fences(MARKDOWN_GUIDE).filter((f) => f.info === "markdown");
  assert.ok(blocks.length >= 12, `expected the guide's markdown examples, found ${blocks.length}`);
  for (const { body } of blocks) {
    const out = html(body);
    assert.ok(out.trim().length > 0, body);
    assert.doesNotMatch(out, /<script|<iframe|<style|<object|<form|\son\w+=|javascript:/i, body);
  }
  // And through the page itself, which wraps the same content.
  const page = renderSharedDocPage({
    title: "Plan",
    markdown: blocks.map((b) => b.body).join("\n\n"),
    docId: "doc-1",
    siteUrl: "https://markie.example.com",
    canEdit: false,
  });
  assert.match(page, /<main>/);
});

test("headings have no anchors, so a table of contents of #links goes nowhere", () => {
  const out = html("[Jump](#section)\n\n## Section\n");
  assert.match(out, /<h2>Section<\/h2>/);
  assert.doesNotMatch(out, /<h2[^>]*\sid=/);
});

test("six heading levels, bold, italic, strikethrough, code, nested bullets and numbered steps", () => {
  const out = html("# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6\n\n**b** *i* ~~s~~ `c`\n\n- a\n  - nested\n\n1. one\n2. two\n");
  for (const level of [1, 2, 3, 4, 5, 6]) assert.match(out, new RegExp(`<h${level}>`));
  assert.match(out, /<strong>b<\/strong> <em>i<\/em> <del>s<\/del> <code>c<\/code>/);
  assert.match(out, /<ul>[\s\S]*<ul>[\s\S]*nested[\s\S]*<\/ul>[\s\S]*<ol>/);
});

test("tables keep column alignment, and a cell holds inline markup but not a list", () => {
  const aligned = html("| Option | Cost |\n| :--- | ---: |\n| Rebuild | 12 days |\n");
  assert.match(aligned, /<th align="left">/);
  assert.match(aligned, /<th align="right">/);
  const cells = html("| A |\n| - |\n| **b** `c` [d](e.md) |\n\n| A |\n| - |\n| - item |\n");
  assert.match(cells, /<td><strong>b<\/strong> <code>c<\/code> <a href="e\.md">d<\/a><\/td>/);
  assert.doesNotMatch(cells, /<td>\s*<ul>/);
});

test("task lists are read-only checkboxes", () => {
  const out = html("- [x] Draft the plan\n- [ ] Get review\n");
  assert.match(out, /<input type="checkbox" checked disabled>/);
  assert.match(out, /<input type="checkbox" disabled>/);
});

test("a blockquote with a bold label is the note, and [!NOTE] is only a quote with the literal words", () => {
  assert.match(html("> **Note:** The export runs nightly.\n"), /<blockquote>\s*<p><strong>Note:<\/strong> The export runs nightly\.<\/p>\s*<\/blockquote>/);
  const callout = html("> [!NOTE]\n> A note.\n");
  assert.match(callout, /<blockquote>\s*<p>\[!NOTE\]\s*A note\.<\/p>\s*<\/blockquote>/);
  assert.doesNotMatch(callout, /callout|admonition|markdown-alert/);
});

test("fenced code is syntax highlighted, and a mermaid block is code that draws no diagram", () => {
  const ts = html("```ts\nconst total = items.length;\n```\n");
  assert.match(ts, /<code class="hljs language-ts">/);
  assert.match(ts, /hljs-keyword/);
  const mermaid = html("```mermaid\ngraph TD; A-->B;\n```\n");
  assert.match(mermaid, /language-mermaid/);
  assert.doesNotMatch(mermaid, /<svg/);
});

test("emoji shortcodes stay text, a rule is a rule, and a bare address becomes a link", () => {
  assert.match(html("Hello :tada:\n"), /Hello :tada:/);
  assert.match(html("a\n\n---\n\nb\n"), /<hr>/);
  assert.match(html("see https://example.org\n"), /<a href="https:\/\/example\.org">/);
});

test("a relative link to another document is a plain link, followable or muted by what the reader may open", () => {
  assert.match(html("[the plan](plan.md)\n"), /<a href="plan\.md">/);
  const followed = html("[the plan](plan.md)\n", { docLinkFor: (ref: string) => (ref === "plan.md" ? { href: "/d/target-1" } : null) });
  assert.match(followed, /<a href="\/d\/target-1">the plan<\/a>/);
  const muted = html("[the plan](plan.md)\n", { docLinkFor: () => ({ muted: true }) });
  assert.match(muted, /class="doc-link-muted"/);
  // A link to a file that is not a document is left alone.
  assert.match(html("[the spec](spec.pdf)\n"), /<a href="spec\.pdf">/);
});

test("a picture, a player or a recording is drawn by extension, and anything else embeds nothing", () => {
  assert.match(html("![alt](shot.png)\n"), /<img src="shot\.png" alt="alt">/);
  for (const ext of ["mp4", "m4v", "webm", "ogv", "mov"]) assert.match(html(`![v](x.${ext})\n`), /<video/, ext);
  for (const ext of ["mp3", "m4a", "aac", "wav", "flac", "oga", "opus"]) assert.match(html(`![a](x.${ext})\n`), /<audio/, ext);
  const pdf = html("![](report.pdf)\n");
  assert.doesNotMatch(pdf, /<video|<audio/);
});

test("a picture beside the document reaches the page only through the document's own assets", () => {
  const withAssets = html("![the dashboard](demo/shot.png)\n\n![clip](demo/clip.mp4)\n", {
    assetUrlFor: (ref: string) => `/d/doc-1/assets/${ref}`,
  });
  assert.match(withAssets, /<img src="\/d\/doc-1\/assets\/demo\/shot\.png"/);
  assert.match(withAssets, /<video src="\/d\/doc-1\/assets\/demo\/clip\.mp4"/);
  // Nothing uploaded, nothing to rewrite: the relative path stays and shows nothing.
  assert.match(html("![the dashboard](demo/shot.png)\n"), /<img src="demo\/shot\.png"/);
  // A file outside the document's reach has no asset, so it is left as written.
  const missing = html("![logo](../assets/logo.png)\n", { assetUrlFor: () => null });
  assert.match(missing, /<img src="\.\.\/assets\/logo\.png"/);
});

test("an https picture and a data URI picture both survive", () => {
  assert.match(html("![logo](https://example.com/logo.png)\n"), /<img src="https:\/\/example\.com\/logo\.png"/);
  assert.match(html("![dot](data:image/png;base64,iVBORw0KGgo=)\n"), /<img src="data:image\/png;base64,iVBORw0KGgo="/);
});

test("a picture or clip sized by its own tag keeps its width", () => {
  assert.match(html('<img src="demo/shot.png" alt="the dashboard" width="240">\n'), /width="240"/);
  assert.match(html('<video src="demo/clip.mp4" width="320" controls></video>\n'), /width="320"/);
});

test("a bare YouTube address alone on a line is a thumbnail linked to the video, and Vimeo stays a link", () => {
  const youtube = html("https://youtu.be/dQw4w9WgXcQ\n");
  assert.match(youtube, /i\.ytimg\.com\/vi\/dQw4w9WgXcQ/);
  assert.match(youtube, /<a href="https:\/\/youtu\.be\/dQw4w9WgXcQ"/);
  assert.doesNotMatch(html("[watch this](https://youtu.be/dQw4w9WgXcQ)\n"), /ytimg/);
  assert.doesNotMatch(html("watch https://youtu.be/dQw4w9WgXcQ now\n"), /ytimg/);
  const vimeo = html("https://vimeo.com/76979871\n");
  assert.match(vimeo, /<a href="https:\/\/vimeo\.com\/76979871"/);
  assert.doesNotMatch(vimeo, /<img/);
});

test("an aligned paragraph or heading keeps its alignment, and its inside is HTML, not markdown", () => {
  for (const md of ['<p style="text-align: center;">middle</p>\n', '<h2 style="text-align: right;">Appendix</h2>\n']) {
    assert.match(html(md), /text-align/);
  }
  const inside = html('<p style="text-align: center;">**bold**</p>\n');
  assert.match(inside, /\*\*bold\*\*/);
  assert.match(html('<p style="text-align: center;"><strong>bold</strong></p>\n'), /<strong>bold<\/strong>/);
});

test("highlight, underline, colour, font and size are kept, and small and abbr lose their tag", () => {
  const kept = html('a <mark>flag</mark> <u>under</u> <span style="color: #b91c1c">red</span> <span style="font-family: Georgia">F</span> <span style="font-size: 24px">S</span> z\n');
  assert.match(kept, /<mark>flag<\/mark>/);
  assert.match(kept, /<u>under<\/u>/);
  assert.match(kept, /<span style="color: #b91c1c">red<\/span>/);
  assert.match(kept, /<span style="font-family: Georgia">F<\/span>/);
  assert.match(kept, /<span style="font-size: 24px">S<\/span>/);
  assert.match(html('a <span style="background-color: yellow">B</span> z\n'), /background-color: yellow/);
  assert.match(html("a <kbd>K</kbd> <sub>s</sub> <sup>p</sup> <ins>i</ins> z\n"), /<kbd>K<\/kbd> <sub>s<\/sub> <sup>p<\/sup> <ins>i<\/ins>/);
  const dropped = html('a <small>sm</small> <abbr title="x">ab</abbr> z\n');
  assert.match(dropped, /a sm ab z/);
  assert.doesNotMatch(dropped, /<small|<abbr/);
  assert.match(html('a <b>b</b> <i>i</i> <del>d</del> z\n'), /<b>b<\/b> <i>i<\/i> <del>d<\/del>/);
});

test("figure, figcaption, center, header, footer and aside lose the tag and keep the text, while div, details, table, blockquote, section and pre stay", () => {
  for (const tag of ["figure", "figcaption", "center", "header", "footer", "aside"]) {
    const out = html(`<${tag}>kept text</${tag}>\n`);
    assert.match(out, /kept text/, tag);
    assert.doesNotMatch(out, new RegExp(`<${tag}`), tag);
  }
  for (const tag of ["div", "details", "table", "blockquote", "section", "pre"]) {
    assert.match(html(`<${tag}>x</${tag}>\n`), new RegExp(`<${tag}`), tag);
  }
  assert.match(html("<details>\n<summary>More</summary>\n\nHidden text.\n\n</details>\n"), /<details>[\s\S]*<summary>More<\/summary>/);
});

test("script, iframe, style, object, form, event handlers and javascript: links render nowhere", () => {
  const out = html(
    [
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
    ].join("\n"),
  );
  for (const bad of ["<script", "<iframe", "<style", "<object", "<form", "onerror", "javascript:", "alert(1)", "color: red"]) {
    assert.ok(!out.includes(bad), `${bad} survived: ${out}`);
  }
});

test("math and footnotes render on a shared page", () => {
  const out = html("Euler: $e^{i\\pi} + 1 = 0$\n\n$$\nE = mc^2\n$$\n\nA claim[^1]\n\n[^1]: The source.\n");
  assert.match(out, /class="katex"/);
  assert.match(out, /data-footnotes/);
});

test("a Darkmown document is source on the web: the page never gets a button, an input or a script from a .wd", () => {
  // A .wd opened on the web is source. The server renderer has no Darkmown
  // runtime, so a counter shows its directive lines as ordinary text and none
  // of its controls exist. The guide tells agents a .wd is live only in the
  // Markie app and that a browser reader should get .md.
  const wd = [...MARKDOWN_GUIDE.matchAll(/^```wd\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
  assert.ok(wd.length >= 9, `expected the guide's Darkmown examples, found ${wd.length}`);
  for (const source of wd) {
    const out = html(source);
    assert.doesNotMatch(out, /<button|<input|<select|<textarea|<script/i, source);
  }
  const counter = html(wd.find((w) => w.startsWith("# Water tracker")) ?? "");
  assert.match(counter, /:state cups = 0/);
  assert.match(counter, /:button/);
  assert.match(MARKDOWN_GUIDE, /a `\.wd` on the web shows its source/);
});
