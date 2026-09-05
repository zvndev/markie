// What Markie draws, written for the agent that is about to write a document.
//
// The filing conventions in conventions.mjs say where a document belongs. This
// says what will actually appear when somebody opens it, which is a different
// question and the one that goes wrong silently. An agent that does not know a
// picture has to sit beside the document saves a screenshot to /tmp, references
// it by absolute path, and produces a report with a hole in it and no error
// anywhere.
//
// ONE source, three surfaces: the essentials are folded into the MCP
// initialize instructions (every client hands those to the model), the whole
// text is served as the markie://guide/markdown resource and by the
// markie_guide tool, and skills/markie-conventions/SKILL.md embeds it between
// markers. lib.test.mjs fails if the copy in SKILL.md drifts from this string.
//
// Every claim below was measured against the real code on 2026-09-05, by
// round-tripping documents through src/lib/rich-extensions.ts (the editor's own
// extension list) and through src/lib/markdown-html.ts (the export, print, PDF
// and share renderer). Nothing here is written from memory, and a claim that
// stops being true is a bug in the guide.
// Self-contained: no imports from outside mcp/ (see the scan.mjs header).

export const MARKDOWN_GUIDE = `# What Markie renders

Markie reads ordinary markdown: GFM, plus the handful of inline HTML tags every
markdown renderer already accepts. Write it the way you would write any .md
file and it stays portable, because nothing here is Markie-only.

Markie shows a document two ways, and a few things render in one and not the
other. Rich (Command-1) is the view it opens with, an editor over the file.
Source (Command-2) is the file's own bytes. Export, print, PDF and a shared link
go through a second renderer, and where the two disagree it is said below.

## The short version

- A picture, a clip or a recording is all \`![alt](path)\`. Markdown has one
  embed syntax, and Markie decides by file extension what to draw.
- The file has to sit beside the document, or inside a folder the user has
  added to Markie as a workspace. A path anywhere else displays nothing at all,
  with no error. Never point a document at /tmp.
- \`<mark>\`, \`<u>\` and \`<span style="color|font-family|font-size">\` render in
  Rich and survive a save. Every other tag is dropped.
- No raw HTML survives an export, a PDF or a shared link: that renderer drops
  it. An inline tag keeps its text and loses its formatting. A tag that starts
  a line loses the whole block, contents and all.
- Math and footnotes are the other way round. They render in exports, PDFs and
  shared links, and stay as literal text in Rich.
- Run \`markie_check_md\` on a document before handing it over. It names every
  target that will not display and every tag that will not render.

## Plain markdown

Headings, bold and italic, ordered and unordered lists, blockquotes, inline
code and fenced code with a language, thematic breaks, and links: all ordinary
markdown, all rendered in both views. Name a fence's language after its opening
backticks and exports, PDFs and shared links syntax highlight it.

GFM on top of that, in both views: tables (a header row, a \`---\` delimiter
row, then the rows), task lists (\`- [ ] todo\` and \`- [x] done\`),
strikethrough (\`~~gone~~\`), and a bare \`https://example.com\`, which becomes a
link on its own.

Column alignment, the colons in a delimiter row, renders in both views and stays
in the file. Editing that table in Rich is what drops the colons.

## Pictures, video and audio

One syntax for all three. Markie draws a player for a clip and a picture for a
picture, by extension:

\`\`\`markdown
![the dashboard](demo/shot.png)
![the walkthrough](demo/clip.mp4)
![the voice memo](demo/memo.mp3)
\`\`\`

- Pictures: \`.png\` \`.jpg\` \`.jpeg\` \`.gif\` \`.webp\` \`.svg\` \`.avif\` \`.bmp\` \`.ico\`.
  An animated GIF animates.
- Video: \`.mp4\` \`.m4v\` \`.webm\` \`.ogv\` \`.mov\`. Deliberately narrower than what
  a converter accepts, because a player that draws a black rectangle is worse
  than a link.
- Audio: \`.mp3\` \`.m4a\` \`.aac\` \`.wav\` \`.flac\` \`.oga\` \`.opus\`.

Anything else is a link, not an embed. \`![](report.pdf)\` displays nothing;
write \`[the report](report.pdf)\` instead.

## Where the file has to live

A document may reach a file inside the folder it was opened from, or inside one
of the user's Markie workspace folders. Nothing else, ever: this is what stops
a document somebody sent you from displaying a picture off your disk and then
carrying it into a copy you send on.

\`\`\`markdown
![beside the document](shot.png)
![in a folder beside it](assets/shot.png)
![up in a shared folder, only inside a workspace](../assets/logo.png)
\`\`\`

So, in order of preference:

1. Write the file beside the document and reference it relatively. A relative
   pair travels: zip the two up, send them on, and the picture is still there.
2. An absolute path works only when the file is inside a Markie workspace. The
   MCP cannot see which folders those are, so it can never promise you this
   one, and neither should you.
3. \`/tmp\`, a system temp folder, or anywhere outside both: nothing displays,
   and nothing says why. Move the file next to the document first.

## A document that has to travel alone

Inline the picture as a data URI and the document carries it in its own text:

\`\`\`markdown
![dot](data:image/png;base64,iVBORw0KGgo=)
\`\`\`

That renders in Rich and in every export. It is the right answer for a report
that will be shared as one file, and the wrong answer for a clip: base64 of a
video makes a file nobody can email. Sharing a document sends only its text, so
a picture sitting beside it on disk does not go with it.

## Links to files beside the document

\`[the spec](spec.pdf)\` opens the file in whatever the user's system opens it
with. The same containment rule as the pictures applies: beside the document,
or inside a workspace. The document must have been saved, because an unsaved
document has no folder to be relative to.

A plain \`https://\` link needs nothing extra. Hovering one shows a preview card
with the page's title, summary and picture, fetched only on that hover.

## The inline HTML that survives

Markdown has no syntax for highlighting, underline, colour, font or size, so
Markie writes those as inline HTML and reads them back:

| Formatting | Write it |
| --- | --- |
| Highlight | \`<mark>flagged</mark>\` |
| Underline | \`<u>underlined</u>\` |
| Colour | \`<span style="color: #b91c1c">red</span>\` |
| Font | \`<span style="font-family: Georgia">serif</span>\` |
| Size | \`<span style="font-size: 24px">big</span>\` |

Keep them inline, in the middle of a line of prose. That is the whole surviving
set, measured. In particular:

- \`<span style="background-color: ...">\` does NOT survive. Use \`<mark>\` for a
  background.
- \`text-align\` does NOT survive a save. Markie can centre a paragraph on
  screen, and the alignment is gone the moment the file is written, so do not
  write centred text and expect it to come back.
- \`<sub>\`, \`<sup>\`, \`<kbd>\`, \`<abbr>\`, \`<small>\` and friends are unwrapped:
  the text stays, the tag goes.
- \`<div>\`, \`<details>\`, \`<iframe>\`, \`<style>\` and \`<script>\` are not markup
  Markie renders at all.

## What a tag on its own line does

A tag at the start of a line is a block, and blocks are treated differently
from inline tags. Markie lifts the whole block out before the editor sees it
and puts the original bytes back on save, so nothing is corrupted: the file
keeps exactly what you wrote. What it does not do is render. Rich shows a
placeholder token where the block was, and the export renderer drops the block
entirely, contents included. An HTML comment is held the same way, which is
what you want from a comment.

The practical rule: never start a line with \`<\`.

## Math and footnotes

Both render in exports, PDFs, printing and shared links. Neither renders in
Rich, where they stay as the literal text you typed. Write them when the
document is going to be exported or shared, and expect to see the source in the
app. Editing a formula's own paragraph in Rich escapes its backslashes, so
change a formula in Source.

\`\`\`markdown
Euler: $e^{i\\pi} + 1 = 0$

$$
E = mc^2
$$

A claim that needs a source[^1]

[^1]: The source.
\`\`\`
`;

// The digest that goes into the MCP initialize instructions. Sliced out of the
// guide above rather than written twice, so the short version can never drift
// from the long one. The heading it starts at is part of the contract, and
// guideEssentials() throws if it moves.
const SHORT_HEADING = "## The short version\n";

export function guideEssentials() {
  const start = MARKDOWN_GUIDE.indexOf(SHORT_HEADING);
  if (start === -1) {
    throw new Error(`markdown-guide: "${SHORT_HEADING.trim()}" section is gone`);
  }
  const from = start + SHORT_HEADING.length;
  const next = MARKDOWN_GUIDE.indexOf("\n## ", from);
  return MARKDOWN_GUIDE.slice(from, next === -1 ? undefined : next).trim();
}

// The URI the guide is served under. Named as a constant because the resource
// list and the resource read both have to agree, and a typo in one of them
// looks exactly like a client bug.
export const GUIDE_URI = "markie://guide/markdown";
