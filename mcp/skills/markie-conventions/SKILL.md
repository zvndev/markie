---
name: markie-conventions
description: How to find, read and write documents for Markie through its MCP server. Covers which document types each tool handles (markdown, text, CSV, JSON, YAML, XML, Word, RTF, OpenDocument, HTML), where a document is filed (project, block), and what Markie actually renders: pictures, video, audio, where those files have to live, and the inline HTML that survives a save. Use whenever writing documents for the user via markie_write_document or markie_write_md, or when the user asks to organize, file, search, or find their documents.
---

# Markie conventions

Markie is the user's local document workspace: markdown first, and also plain
text, CSV, JSON, YAML, XML, Darkmown, Word, RTF, OpenDocument and HTML. It
organizes files into projects (a repo or a product) containing blocks (units of
work). Files never move on disk; organization is metadata.

## Finding and reading documents

- `markie_find_documents` finds documents by name or path, newest first, and
  says each one's format. Pass `formats` (for example `["docx", "odt"]`) to
  narrow it. `markie_find_md` is the same search for markdown only.
- `markie_search_documents` finds documents by what they say. It reads inside
  markdown, text, data files, Word, OpenDocument, RTF and HTML, exactly as
  Markie's own global search does, and returns an excerpt around each hit.
- `markie_read_document` reads any of them. Text formats come back as written.
  Word, OpenDocument, RTF and HTML come back as extracted text, labelled
  read-only. A legacy `.doc` cannot be read this way: open it in Markie.

## Writing documents

1. Search before you write: `markie_find_documents` or `markie_find_md` with a
   few keywords, or `markie_search_documents` when you remember what the
   document says rather than what it is called. Update the document that
   already exists instead of creating `plan-v2-final.md` beside it. If the
   search says it was truncated, it did not see the whole disk, so do not read
   a miss as proof the document is new.
2. Declare where a markdown document belongs. Either pass `project` and `block`
   to `markie_write_document` or `markie_write_md`, or write the front matter
   yourself:

   ```yaml
   ---
   markie:
     project: bevrly
     block: checkout-redesign
   ---
   ```

3. One block per unit of work: a feature, an investigation, a report series.
   Reuse the block name across every document from that work.
4. Name blocks after the work, not the date: `auth-flow`, not `march-notes`.
   A date says when you filed something and never what it was, and Markie
   strips leading date stamps out of the names it derives for that reason.
5. Match existing project names. A document about a repo belongs to a project
   named like the repo folder.
6. Project, then block, then file is the whole tree. Do not invent deeper
   levels, and do not move, rename, or restructure files on disk to organize
   them. Declaring the project and block is the organizing.
7. `markie_write_document` also writes plain text, CSV, JSON, YAML, XML and
   Darkmown. JSON is checked before anything is written. It never writes Word,
   OpenDocument, RTF, legacy `.doc` or HTML, because plain text written over
   one of those destroys it. To change one, open it with
   `markie_open_in_markie` for the user, or write your changes into a new
   markdown document.

## Checking a document

`markie_check_md` reads a document back and reports what will not display: an
image or link target that is not where the document says it is, an embed of a
kind Markie cannot draw, a target outside the document's folder, and every tag
whose two fates differ, with line numbers. Rich and the export renderer do not
agree about every tag, so each finding says both halves, and only a tag that
renders in neither place counts as a failure. It is static analysis, so it costs
a read and one existence check per local file, and it never opens the app.

Run it whenever a document has a picture, a clip or inline HTML in it. A missing
picture is the failure with no symptom: the document opens with a hole and
nothing anywhere says why.

## Showing results

When the user asked for a document, finish with `markie_open_in_markie` on the
file you wrote, so it renders in front of them. It opens every type listed
above, not only markdown.

<!-- markdown-guide:start (one source: mcp/markdown-guide.mjs; lib.test.mjs fails when this drifts) -->

# What Markie renders

Markie reads ordinary markdown: GFM, plus the HTML every markdown renderer
already accepts. Write it the way you would write any .md file and it stays
portable, because nothing here is Markie-only.

Two things draw a document and they do not agree about everything, so the rules
below say both. Rich (Command-1) is the editor Markie opens with, and Source
(Command-2) is the file's own bytes. Export, print, PDF and a shared link go
through a second renderer, which parses the document's own HTML and then
sanitizes it.

## The short version

- A picture, a clip or a recording is all `![alt](path)`. Markdown has one
  embed syntax, and Markie decides by file extension what to draw.
- The file has to sit beside the document, or inside a folder the user has
  added to Markie as a workspace. A path anywhere else displays nothing at all,
  with no error. Never point a document at /tmp.
- To size a picture, write its tag alone on a line:
  `<img src="demo/shot.png" width="240">`. Width only, never height.
- To centre a line, write its tag alone on a line:
  `<p style="text-align: center;">middle</p>`, or the same on a heading. What
  is inside is HTML, not markdown.
- A YouTube or Vimeo link alone on a line becomes a card. Write the bare
  address and nothing else.
- `<mark>`, `<u>` and `<span style="color|font-family|font-size">` are the
  inline tags Rich keeps exactly as written. Other tags render in exports and
  shared pages, and Rich rewrites or unwraps them the next time it saves that
  paragraph.
- `<script>`, `<iframe>`, `<style>`, `<object>`, `<form>`, any `on...=`
  handler and a `javascript:` link render nowhere at all.
- Run `markie_check_md` on a document before handing it over. It names every
  target that will not display and every tag that will not render.

## Plain markdown

Headings, bold and italic, ordered and unordered lists, blockquotes, inline
code and fenced code with a language, thematic breaks, and links: all ordinary
markdown, all rendered in both views. Name a fence's language after its opening
backticks and exports, PDFs and shared links syntax highlight it.

GFM on top of that, in both views: tables (a header row, a `---` delimiter
row, then the rows), task lists (`- [ ] todo` and `- [x] done`),
strikethrough (`~~gone~~`), and a bare `https://example.com`, which becomes a
link on its own.

Column alignment, the colons in a delimiter row, renders in both views and stays
in the file. Editing that table in Rich is what drops the colons.

## Pictures, video and audio

One syntax for all three. Markie draws a player for a clip and a picture for a
picture, by extension:

```markdown
![the dashboard](demo/shot.png)
![the walkthrough](demo/clip.mp4)
![the voice memo](demo/memo.mp3)
```

- Pictures: `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.avif` `.bmp` `.ico`.
  An animated GIF animates.
- Video: `.mp4` `.m4v` `.webm` `.ogv` `.mov`. Deliberately narrower than what
  a converter accepts, because a player that draws a black rectangle is worse
  than a link.
- Audio: `.mp3` `.m4a` `.aac` `.wav` `.flac` `.oga` `.opus`.

Anything else is a link, not an embed. `![](report.pdf)` displays nothing;
write `[the report](report.pdf)` instead.

## Choosing how big a picture is

Markdown has nowhere to put a width, so a sized picture is written as the tag
itself, which is the one form that renders everywhere, GitHub included:

```markdown
<img src="demo/shot.png" alt="the dashboard" width="240">

<video src="demo/clip.mp4" width="320" controls></video>
```

Alone on its line, with nothing else on that line: that exact shape is the one
Rich reads back as its own picture, at that width and with drag handles on the
corners. Exports and shared pages honour the width too. Put words on the same
line and it stops being a picture to Rich and becomes ordinary raw HTML, held
aside (see below).

Only the width. A browser scales the height from the picture's own proportions,
and a stored height goes stale the moment the file behind it is recropped.
Audio has no width worth choosing, so leave a recording as `![](memo.mp3)`.

## Where the file has to live

A document may reach a file inside the folder it was opened from, or inside one
of the user's Markie workspace folders. Nothing else, ever: this is what stops
a document somebody sent you from displaying a picture off your disk and then
carrying it into a copy you send on. The `src` of an `<img>` or `<video>` tag
is held to exactly the same rule as `![](...)`.

```markdown
![beside the document](shot.png)
![in a folder beside it](assets/shot.png)
![up in a shared folder, only inside a workspace](../assets/logo.png)
```

So, in order of preference:

1. Write the file beside the document and reference it relatively. A relative
   pair travels: zip the two up, send them on, and the picture is still there.
2. An absolute path works only when the file is inside a Markie workspace. The
   MCP cannot see which folders those are, so it can never promise you this
   one, and neither should you.
3. `/tmp`, a system temp folder, or anywhere outside both: nothing displays,
   and nothing says why. Move the file next to the document first.

## A document that has to travel alone

Inline the picture as a data URI and the document carries it in its own text:

```markdown
![dot](data:image/png;base64,iVBORw0KGgo=)
```

That renders in Rich and in every export. It is the right answer for a report
that will be shared as one file, and the wrong answer for a clip: base64 of a
video makes a file nobody can email. Sharing a document sends only its text, so
a picture sitting beside it on disk does not go with it.

## Links to files beside the document

`[the spec](spec.pdf)` opens the file in whatever the user's system opens it
with. The same containment rule as the pictures applies: beside the document,
or inside a workspace. The document must have been saved, because an unsaved
document has no folder to be relative to.

A plain `https://` link needs nothing extra. Hovering one shows a preview card
with the page's title, summary and picture, fetched only on that hover.

## A video from YouTube or Vimeo

Put the bare address alone on its line and nothing else:

```markdown
https://youtu.be/dQw4w9WgXcQ
```

Rich draws a card with the thumbnail and the title, and loads the player only
when somebody clicks it. An export or a shared page draws the thumbnail linked
to the video (YouTube only, because Vimeo has no thumbnail address that can be
guessed; a Vimeo link stays a link there). The file keeps the bare URL and
nothing else, so any other renderer shows an ordinary link.

The address has to be the whole paragraph and its own words. A link inside a
sentence stays a link, and so does `[watch this](https://youtu.be/...)`, which
is somebody choosing words for it.

## Centring a line

Markdown has no alignment, so an aligned block is written as its tag, alone on
its line, opening and closing:

```markdown
<p style="text-align: center;">Signed off by the team</p>

<h2 style="text-align: right;">Appendix</h2>
```

`center`, `right`, `justify` and `left` on `<p>` and on `<h1>` through
`<h6>`. Rich draws these as the paragraph or heading they are, and exports and
shared pages render them too.

Two things to get right. What is inside the tag is HTML, not markdown, because
the content of an HTML block is not markdown to any renderer: write
`<strong>bold</strong>`, since `**bold**` in there shows up as asterisks.
And write the tag plainly, with double quotes and no other attributes: add a
`class`, or use single quotes, and Markie reads it as ordinary raw HTML
instead, which still exports but shows a placeholder in Rich.

## The inline HTML, and where it survives

Markdown has no syntax for highlighting, underline, colour, font or size, so
Markie writes those as inline HTML and reads them back. Rich only rewrites a
paragraph when that paragraph is edited, so until then the file keeps whatever
you wrote either way.

| Written | In Rich | In an export or a shared page |
| --- | --- | --- |
| `<mark>flagged</mark>` | kept | kept |
| `<u>underlined</u>` | kept | kept |
| `<span style="color: #b91c1c">red</span>` | kept | kept |
| `<span style="font-family: Georgia">` | kept | kept |
| `<span style="font-size: 24px">` | kept | kept |
| `<b>` `<i>` `<del>` `<code>` `<br>` `<a href>` | rewritten as the markdown that means the same | kept |
| `<span style="background-color: ...">` `<kbd>` `<sub>` `<sup>` `<ins>` | tag dropped, text kept | kept |
| `<small>` `<abbr>` | tag dropped, text kept | tag dropped, text kept |

Use `<mark>` for a background: `background-color` on a `<span>` is the one
that does not come back.

## A tag that starts a line

A tag at the start of a line makes an HTML block, and a block is not inline
markup. Markie lifts the whole block out before the editor sees it and puts the
original bytes back on save, so the file keeps exactly what you wrote, and Rich
shows a placeholder token where the block was. Exports, PDFs and shared pages
render it, sanitized: `<div>`, `<details>` and `<summary>`, `<table>`,
`<blockquote>`, `<section>`, `<pre>`, lists, and the ordinary text tags all
come out. A few do not, and lose the tag while keeping the text inside it:
`<figure>`, `<figcaption>`, `<center>`, `<header>`, `<footer>`, `<aside>`.

The two exceptions are the shapes above, which Rich has a node for and draws
properly: a lone picture or clip tag, and an aligned `<p>` or heading. Write
anything else that starts with `<` only when you want it in the export and can
live with a placeholder in the app.

## What renders nowhere

`<script>`, `<iframe>`, `<style>`, `<object>`, `<form>`, any `on...=` handler
attribute, and a `javascript:` link. The file keeps them and no reader ever
sees them, in either place, contents included.

## Math and footnotes

Both render in exports, PDFs, printing and shared links. Neither renders in
Rich, where they stay as the literal text you typed. Write them when the
document is going to be exported or shared, and expect to see the source in the
app. Editing a formula's own paragraph in Rich escapes its backslashes, so
change a formula in Source.

```markdown
Euler: $e^{i\pi} + 1 = 0$

$$
E = mc^2
$$

A claim that needs a source[^1]

[^1]: The source.
```

## Other document types

Markie opens more than markdown, and the tools follow it. Each type has a
format id, which is what the formats filter of `markie_find_documents` and
`markie_search_documents` takes.

| Format id | Files | Search reads its text | `markie_read_document` | `markie_write_document` |
| --- | --- | --- | --- | --- |
| `markdown` | `.md` `.markdown` `.mdx` | yes | as written | yes |
| `darkmown` | `.wd` | yes | as written | yes |
| `text` | `.txt` `.text` `.log` | yes | as written | yes |
| `csv` | `.csv` | yes | as written | yes |
| `json` | `.json` | yes | as written | yes, valid JSON only |
| `yaml` | `.yaml` `.yml` | yes | as written | yes |
| `xml` | `.xml` | yes | as written | yes |
| `html` | `.html` `.htm` | yes | extracted text | no |
| `docx` | `.docx` | yes | extracted text | no |
| `odt` | `.odt` | yes | extracted text | no |
| `rtf` | `.rtf` | yes | extracted text | no |
| `doc` | `.doc` | name and path only | no | no |

Extracted text is the words of a document without its formatting, pictures or
layout. It comes back labelled read-only, because writing plain text over a
Word, OpenDocument or RTF file would destroy everything else in it. To change
one of those, open it with `markie_open_in_markie` so the user edits it in
Markie, or put your changes in a new markdown document. Legacy .doc only gives
up its text to the reader Markie runs when the document is opened.

A file past its read limit (4 MB for text and HTML, 8 MB for RTF, 32 MB for
Word and OpenDocument) is still found by name and path, but its text is not
searched or read.

Everything above this section is about markdown. Pictures, embeds, inline HTML
and the project and block front matter do not apply to the other types.

<!-- markdown-guide:end -->
