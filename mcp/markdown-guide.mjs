// How to write a document for Markie, for the agent that is about to write one.
//
// The filing conventions in conventions.mjs say where a document belongs. This
// says what to write and what will actually appear when somebody opens it,
// which is a different question and the one that goes wrong silently. An agent
// that does not know a picture has to sit beside the document saves a
// screenshot to /tmp, references it by absolute path, and produces a report
// with a hole in it and no error anywhere. An agent that does not know Markie
// draws tables, task lists and live Darkmown documents writes a wall of
// plain paragraphs.
//
// ONE source, four surfaces: the essentials are folded into the MCP
// initialize instructions (every client hands those to the model), the whole
// text is served as the markie://guide/markdown resource and by the
// markie_guide tool, the plugin skill points here, and the hosted MCP on the
// Markie server serves a generated copy of this string (server/ has a test
// that fails when the two differ).
//
// Every claim below was measured against the real code by running it: the
// markdown through src/lib/rich-extensions.ts (the editor's own extension
// list) and src/lib/markdown-html.ts (the export, print, PDF and share
// renderer), and every ```wd example through compileDarkmownPreview, the same
// compile, sanitize and runtime path the app's preview uses.
// src/lib/darkmown/agent-guide.test.ts does that on every test run and fails
// when an example stops compiling or an element stops rendering. Re-measure
// rather than re-read: several claims here were the opposite of what the code
// comments said at the time. The "Other document types" table at the end
// restates what doc-text.cjs and lib.mjs (READ_FORMATS, WRITE_FORMATS)
// enforce; lib.test.mjs checks each row against them.
//
// Prose rules: short sentences, plain labels, examples over adjectives, and no
// em-dash character anywhere in the text (lib.test.mjs fails on one).
// Template literal rules: a backtick is written \` and a dollar sign followed
// by a brace is never written, so Darkmown examples avoid a leading dollar.
// Self-contained: no imports from outside mcp/ (see the scan.mjs header).

export const MARKDOWN_GUIDE = `# Writing documents for Markie

Markie draws much more than plain markdown. Tables, task lists, pictures,
video, audio and live Darkmown documents all render in the editor, and math and
footnotes render in exports and shared pages. Use them. A document with a clear
structure and the right element for each job reads better than a wall of
paragraphs.

This guide says which format to pick, what to write, what appears on screen,
and how to get the result to the user. Every example in it is checked against
Markie's own renderer when Markie is built.

## The short version

- Pick the format. \`.md\` is for reading. \`.wd\` (Darkmown) is for a document
  the reader clicks, ticks, slides or calculates with. \`.csv\` is for plain rows.
- Structure it: one \`#\` title, a one or two sentence summary, \`##\` sections,
  short paragraphs, the answer first. Use the element that fits: a table for
  items with attributes, a task list for to-dos, a blockquote with a bold label
  for a note, a fenced block with a language for code.
- These do not exist: callouts (\`> [!NOTE]\` shows as a plain quote), diagrams
  (a \`mermaid\` block stays code), emoji shortcodes, and heading anchors
  (\`[Jump](#section)\` goes nowhere).
- A picture, clip or recording is \`![alt](path)\`. The file has to sit beside the
  document, or inside a folder the user added to Markie as a workspace. Any
  other path displays nothing, with no error. Never point at /tmp.
- Size a picture with its tag alone on a line:
  \`<img src="shot.png" width="240">\`. Centre a line with
  \`<p style="text-align: center;">middle</p>\`. A YouTube or Vimeo address alone
  on a line becomes a video card.
- Other HTML at the start of a line shows as a placeholder token in the Markie
  editor, so skip it. \`<script>\`, \`<iframe>\`, \`<style>\`, \`<object>\`, \`<form>\`,
  \`on...=\` handlers and \`javascript:\` links render nowhere.
- Math and footnotes render in exports and shared web pages. The Markie editor
  shows their source.
- Darkmown preview runs \`:state\`, \`:computed\` (\`-\` \`*\` \`/\` \`%\` only),
  \`:button\`, \`:slider\`, \`:bind\`, bound \`:select\` \`:checkbox\` \`:radio\`, and
  \`:form into\`. It does not run \`:if\`, loops, includes, \`:store\`, \`persist\`,
  \`:fetch\`, \`+\` or format pipes. Copy the shapes in the Darkmown section.
- Run \`markie_check_md\` on a \`.md\` before handing it over.
- Give the user a link: write with \`markie_write_document\`, call
  \`markie_cloud_sync\`, and paste the \`markdownLink\` it returns. With only the
  hosted tools, call \`markie_create_document\` and paste its \`markdownLink\`.
  Make a public link only when the user asked for one.

## Choosing a format

| You are writing | Use | Why |
| --- | --- | --- |
| A report, plan, spec, notes, README | \`.md\` | Every element in this guide, and it opens in any editor |
| A calculator, an estimate, a checklist that counts, a small dashboard, a switchable view, a step-through, a short form | \`.wd\` | Darkmown: values the reader changes, and the page updates |
| Rows and columns of data | \`.csv\` | Markie shows a table preview of the file. It is not a spreadsheet |
| Literal text, a log | \`.txt\` | Nothing is formatted, nothing is interpreted |
| Config or data | \`.json\` \`.yaml\` \`.xml\` | JSON is checked for validity before it is written |

Default to \`.md\`. Write \`.wd\` when the reader would otherwise need a second
document to try a number or tick a box. Do not write \`.wd\` only to look
clever: inside Darkmown preview, links, pictures, task lists, footnotes, math
and raw HTML do not render the way they do in \`.md\` (see "What does not work
in Darkmown preview"), and outside Markie a \`.wd\` file is just text.

Headings, bold, lists, tables, quotes and code all work inside a \`.wd\`. The
reverse does not: a \`.md\` never runs a directive, so \`:state x = 1\` in a
\`.md\` is plain text.

The tools read Word, RTF, OpenDocument and HTML but never write them. The last
section lists every type and what each tool does with it.

## Structure

- One \`#\` title. Right under it, one or two sentences: what this is, and what
  the reader should do or decide.
- Answer first, background after. A reader who stops after the first screen
  should still have the point.
- \`##\` for sections and \`###\` for parts of a section. Stop there. Headings are
  labels of two to five words, not sentences.
- Paragraphs of one to three sentences. One idea each.
- Steps go in a numbered list. Parallel items go in a bullet list. Anything
  with two or more attributes per item goes in a table.
- Headings have no anchors, so do not write a table of contents of
  \`[Jump](#section)\` links. They go nowhere.

A document can start with a front matter block. Markie keeps it out of the
way in the editor and writes it back byte for byte:

\`\`\`markdown
---
markie:
  project: bevrly
  block: checkout-redesign
---

# Checkout redesign
\`\`\`

\`markie_write_document\` writes this for you when you pass \`project\` and
\`block\`. Exports, print and the web page for a document in Markie Cloud print
the front matter as text at the top. When the document is mainly to be read
through a link or exported, leave \`project\` and \`block\` out.

## Elements that render

Two things draw a document and they do not agree about everything, so the rules
below say both. Rich (Command-1) is the editor Markie opens with, and Source
(Command-2) is the file's own bytes. Export, print, PDF and a shared link go
through a second renderer, which parses the document's own HTML and then
sanitizes it.

### Headings, emphasis, lists

\`\`\`markdown
## Results

**Bold**, *italic*, ~~struck~~, \`code\`, and ***both***.

- A bullet
  - A nested bullet

1. A numbered step
2. Another step
\`\`\`

Six heading levels exist. Use two or three.

### Tables

\`\`\`markdown
| Option | Cost | Risk |
| :--- | ---: | --- |
| Rebuild | 12 days | **High** |
| Patch | 3 days | Low, see [the notes](notes.md) |
\`\`\`

A header row, a \`---\` delimiter row, then the rows. Colons in the delimiter row
align a column: \`:---\` left, \`---:\` right. Cells hold one line of inline
markup (bold, code, links). A cell cannot hold a list or a second paragraph.
Alignment colons render in both views and stay in the file. Editing that table
in Rich is what drops them.

### Task lists

\`\`\`markdown
- [x] Draft the plan
- [ ] Get review
- [ ] Ship
\`\`\`

Rich draws checkboxes. Exports and shared pages draw them read-only. For a
checklist that counts what is done, write Darkmown (see "A checklist that
counts").

### Notes and warnings

There are no callout boxes. Use a blockquote with a bold label:

\`\`\`markdown
> **Note:** The export runs nightly.

> **Warning:** This deletes the cache.
\`\`\`

\`> [!NOTE]\` does not become a callout. It shows as a quote that starts with the
literal text [!NOTE].

### Code

Name the language after the opening backticks:

\`\`\`\`markdown
\`\`\`ts
const total = items.length;
\`\`\`
\`\`\`\`

Exports, PDFs and shared pages syntax highlight it. The editor shows the code
plain. A \`mermaid\` block is code like any other and draws no diagram. To show a
diagram, put a \`.png\` or \`.svg\` beside the document and embed it (see below),
or describe the flow in a numbered list.

### Rules and links

\`---\` on its own line is a horizontal rule. A bare \`https://example.com\`
becomes a link on its own. Hovering a web link in Markie shows a preview card
with the page's title, summary and picture.

### Links to other documents

\`[the plan](plan.md)\` links to a file beside this document. In Markie, clicking
it opens that file in the user's default app for the type. When the target ends
in \`.md\`, \`.markdown\`, \`.mdx\` or \`.txt\` and both documents are in the user's
Markie Cloud, readers who may open the target can follow the link on the web
page. Everyone else sees the link muted.

A document made with the hosted tools has no neighbouring files, so a relative
link in it goes nowhere. To point at another document made there, use its
\`markdownLink\` or \`privateLink\`.

### Pictures, video and audio

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

A picture can also be an https address: \`![logo](https://example.com/logo.png)\`.
Video and audio must be local files, because the app does not play them from
the web.

### Choosing how big a picture is

Markdown has nowhere to put a width, so a sized picture is written as the tag
itself, which is the one form that renders everywhere, GitHub included:

\`\`\`markdown
<img src="demo/shot.png" alt="the dashboard" width="240">

<video src="demo/clip.mp4" width="320" controls></video>
\`\`\`

Alone on its line, with nothing else on that line: that exact shape is the one
Rich reads back as its own picture, at that width and with drag handles on the
corners. Exports and shared pages honour the width too. Put words on the same
line and it stops being a picture to Rich and becomes ordinary raw HTML, held
aside (see "A tag that starts a line").

Only the width. A browser scales the height from the picture's own proportions,
and a stored height goes stale the moment the file behind it is recropped.
Audio has no width worth choosing, so leave a recording as \`![](memo.mp3)\`.

### Where the file has to live

A document may reach a file inside the folder it was opened from, or inside one
of the user's Markie workspace folders. Nothing else, ever: this is what stops
a document somebody sent you from displaying a picture off your disk and then
carrying it into a copy you send on. The \`src\` of an \`<img>\` or \`<video>\` tag
is held to exactly the same rule as \`![](...)\`.

\`\`\`markdown
![beside the document](shot.png)
![in a folder beside it](assets/shot.png)
![up in a shared folder, only inside a workspace](../assets/logo.png)
\`\`\`

So, in order of preference:

1. Write the file beside the document and reference it relatively. A relative
   pair travels: zip the two up, send them on, and the picture is still there.
   When you sync the document to Markie Cloud, the pictures, clips and
   recordings it references go up with it.
2. An absolute path works only when the file is inside a Markie workspace. The
   MCP cannot see which folders those are, so it can never promise you this
   one, and neither should you.
3. \`/tmp\`, a system temp folder, or anywhere outside both: nothing displays,
   and nothing says why. Move the file next to the document first.

Documents made with the hosted tools cannot carry a file beside them. Use an
https picture address or a data URI there.

### A document that has to travel alone

Inline the picture as a data URI and the document carries it in its own text:

\`\`\`markdown
![dot](data:image/png;base64,iVBORw0KGgo=)
\`\`\`

That renders in Rich and in every export. It is the right answer for a report
that will be sent as one file, and the wrong answer for a clip: base64 of a
video makes a file nobody can email.

### Links to files beside the document

\`[the spec](spec.pdf)\` opens the file in whatever the user's system opens it
with. The same containment rule as the pictures applies: beside the document,
or inside a workspace. The document must have been saved, because an unsaved
document has no folder to be relative to.

### A video from YouTube or Vimeo

Put the bare address alone on its line and nothing else:

\`\`\`markdown
https://youtu.be/dQw4w9WgXcQ
\`\`\`

Rich draws a card with the thumbnail and the title, and loads the player only
when somebody clicks it. An export or a shared page draws the thumbnail linked
to the video (YouTube only, because Vimeo has no thumbnail address that can be
guessed; a Vimeo link stays a link there). The file keeps the bare URL and
nothing else, so any other renderer shows an ordinary link.

The address has to be the whole paragraph and its own words. A link inside a
sentence stays a link, and so does \`[watch this](https://youtu.be/...)\`, which
is somebody choosing words for it.

### Centring a line

Markdown has no alignment, so an aligned block is written as its tag, alone on
its line, opening and closing:

\`\`\`markdown
<p style="text-align: center;">Signed off by the team</p>

<h2 style="text-align: right;">Appendix</h2>
\`\`\`

\`center\`, \`right\`, \`justify\` and \`left\` on \`<p>\` and on \`<h1>\` through
\`<h6>\`. Rich draws these as the paragraph or heading they are, and exports and
shared pages render them too.

Two things to get right. What is inside the tag is HTML, not markdown, because
the content of an HTML block is not markdown to any renderer: write
\`<strong>bold</strong>\`, since \`**bold**\` in there shows up as asterisks.
And write the tag plainly, with double quotes and no other attributes: add a
\`class\`, or use single quotes, and Markie reads it as ordinary raw HTML
instead, which still exports but shows a placeholder in Rich.

### Highlight, underline, colour and size

Markdown has no syntax for these, so Markie writes them as inline HTML and
reads them back. Rich only rewrites a paragraph when that paragraph is edited,
so until then the file keeps whatever you wrote either way.

| Written | In Rich | In an export or a shared page |
| --- | --- | --- |
| \`<mark>flagged</mark>\` | kept | kept |
| \`<u>underlined</u>\` | kept | kept |
| \`<span style="color: #b91c1c">red</span>\` | kept | kept |
| \`<span style="font-family: Georgia">\` | kept | kept |
| \`<span style="font-size: 24px">\` | kept | kept |
| \`<b>\` \`<i>\` \`<del>\` \`<code>\` \`<br>\` \`<a href>\` | rewritten as the markdown that means the same | kept |
| \`<span style="background-color: ...">\` | style dropped, text kept | kept |
| \`<kbd>\` \`<sub>\` \`<sup>\` \`<ins>\` | tag dropped, text kept | kept |
| \`<small>\` \`<abbr>\` | tag dropped, text kept | tag dropped, text kept |

Use \`<mark>\` for a background: \`background-color\` on a \`<span>\` is the one
that does not come back.

### A tag that starts a line

A tag at the start of a line makes an HTML block, and a block is not inline
markup. Markie lifts the whole block out before the editor sees it and puts the
original bytes back on save, so the file keeps exactly what you wrote, and Rich
shows a placeholder token where the block was. Exports, PDFs and shared pages
render it, sanitized: \`<div>\`, \`<details>\` and \`<summary>\`, \`<table>\`,
\`<blockquote>\`, \`<section>\`, \`<pre>\`, lists, and the ordinary text tags all
come out. A few do not, and lose the tag while keeping the text inside it:
\`<figure>\`, \`<figcaption>\`, \`<center>\`, \`<header>\`, \`<footer>\`, \`<aside>\`.

The two exceptions are the shapes above, which Rich has a node for and draws
properly: a lone picture or clip tag, and an aligned \`<p>\` or heading. Write
anything else that starts with \`<\` only when you want it in the export and can
live with a placeholder in the app. That includes \`<details>\`: there is no
collapsible section in Rich.

### What renders nowhere

\`<script>\`, \`<iframe>\`, \`<style>\`, \`<object>\`, \`<form>\`, any \`on...=\` handler
attribute, and a \`javascript:\` link. The file keeps them and no reader ever
sees them, in either place, contents included.

### Math and footnotes

Both render in exports, PDFs, printing and shared web pages. Neither renders in
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

## Darkmown (.wd)

Darkmown is markdown with live state. A line that starts with a colon
declares a value or a control, and \`{ name }\` prints a value. The reader
changes something and the page updates. Markie runs it in a sandbox with no
network, files or accounts.

How a reader meets a \`.wd\` in Markie:

- The preview starts switched off. Buttons and inputs are disabled and the
  page shows its starting values. The user chooses **Trust this document** to
  turn the controls on.
- Any edit to the source takes the trust away again.
- State is temporary. Counts, slider positions and form answers are not saved
  into the file and reset when the document is reopened. Only the source is
  saved.
- The same file is plain text anywhere else. On the web, a \`.wd\` is a static
  page without controls. It is interactive in the Markie apps.

Limits of the preview:

- At most 128,000 characters and 5,000 lines. Past that, Markie still saves
  and edits the file but will not preview it.
- A work budget: the length of the source times the number of \`{\` characters
  and \`:computed\` lines may not pass 1,000,000. A few thousand characters with
  a few dozen values is far inside it.
- Directives only work at the very start of a line. Inside a list, a quote or
  indented text they are plain text, and so are directives inside a code
  fence.
- No loops, no includes. \`@loop\` and \`@include\` are refused.
- Numbers print the way JavaScript prints them, so \`0.1 * 3\` shows
  \`0.30000000000000004\`. Format pipes are not available. Keep to whole numbers
  and sums that divide cleanly.
- If a line is wrong, the preview shows the error, for example \`[WD201]
  Malformed :state\`. The source is never changed. Copy the shapes below
  exactly, because you cannot run the preview yourself.

### A counter: :state, :computed, :button

\`\`\`wd
---
title: Water tracker
---

# Water tracker

:state cups = 0
:computed ounces = cups * 8

Today: { cups } cups, about { ounces } ounces.

:button "Add a cup" -> cups++
:button "Remove a cup" -> cups--
:button "Start over" -> cups reset
\`\`\`

- \`:state name = value\` declares a value: a number, a string in double quotes,
  \`true\` or \`false\`, or an object such as \`{"count": 0, "total": 0}\`.
- \`{ name }\` prints it, in a paragraph, a heading, a list, a quote or a table
  cell. \`{ cart.count }\` reaches into an object.
- \`:computed name = expression\` derives a value. Allowed: names, numbers,
  \`-\` \`*\` \`/\` \`%\`, a leading minus, and parentheses. A computed value may
  use another computed value. Not allowed: \`+\`, comparisons, \`sum()\` and the
  other aggregates.
- A button action changes one state value. These work: \`n++\`, \`n--\`,
  \`n += 5\`, \`n -= 2\`, \`n = 10\`, \`label = "Done"\`, \`on = true\`, \`on toggle\`, \`n reset\`.
  \`reset\` goes back to the value in \`:state\`.
- Chain actions with a semicolon: \`:button "Add" -> cart.count++ ; cart.total += 9\`.
  Do not put a semicolon inside a quoted value.
- The front matter \`title:\` is optional and shows nowhere on the page.

### A calculator: :slider, :computed

\`\`\`wd
# Project estimate

:slider hours = 20 min=1 max=200 step=1
:slider rate = 120 min=50 max=300 step=10
:state discount = 10

:computed subtotal = hours * rate
:computed saved = subtotal * discount / 100
:computed total = subtotal - saved

| Item | Amount |
| --- | --- |
| Hours | { hours } |
| Rate | { rate } |
| Subtotal | { subtotal } |
| Discount | { saved } |
| **Total** | **{ total }** |
\`\`\`

- \`:slider name = start min=.. max=.. step=..\` declares the value and draws a
  range input. If the value is already declared, write \`:slider name min=1 max=40\`.
- A table cell can hold \`{ name }\`, so a table is the way to build a small
  dashboard. Leave out alignment colons (\`---:\`) in a \`.wd\` table: Markie
  switches the alignment off and shows a notice.
- Keep money in whole units or cents. Decimals can print with stray digits.

### Text input: :bind

\`\`\`wd
# Greeting

:state who = ""
:bind who placeholder="Your name"

Hello { who }.
\`\`\`

\`:bind name\` draws a text input tied to a declared state. It accepts
\`placeholder\` and nothing else (no \`min\` or \`max\`). Digits typed into it
still work in arithmetic with \`:computed\`. Use \`:slider\` for numbers when you
can.

### Choices: bound :select, :checkbox, :radio

\`\`\`wd
# Plan picker

:state seats = 5
:state plan = "Basic"
:state region = "Europe"
:state annual = false

:slider seats min=1 max=50 step=1

:radio plan
- Basic
- Pro

:select region
- Europe
- Americas
- Asia

:checkbox annual
- Pay yearly

Plan: { plan }. Region: { region }. Seats: { seats }. Pay yearly: { annual }.
\`\`\`

Outside a form, \`:select\`, \`:radio\` and \`:checkbox\` tie to a state of the same
name, which must be declared first. A \`:checkbox\` is one true or false value and
takes exactly one \`- Label\` line. A \`:radio\` or \`:select\` holds the chosen
option's text. A state printed as \`{ annual }\` shows \`true\` or \`false\`.

### A checklist that counts

\`\`\`wd
# Launch checklist

:state design = false
:state copy = false
:state review = false
:state ship = false

:checkbox design
- Design approved

:checkbox copy
- Copy written

:checkbox review
- Review done

:checkbox ship
- Shipped

:computed left = 4 - design - copy - review - ship
:computed percent = (4 - left) * 25

Left to do: { left } of 4. Progress: { percent }%.
\`\`\`

\`:computed\` has no \`+\`, but subtraction counts. A checked box is 1 and an
unchecked box is 0, so \`4 - design - copy - review - ship\` is the number
still to do. Chain a second computed value for a percentage.

### Toggles and step-throughs

\`\`\`wd
# Make pasta

:state step = 1
:state now = "Boil salted water."
:state hot = false

:button "Step 1" -> step = 1 ; now = "Boil salted water."
:button "Step 2" -> step = 2 ; now = "Add the pasta and cook for nine minutes."
:button "Step 3" -> step = 3 ; now = "Drain, and keep a cup of the water."
:button "Step 4" -> step = 4 ; now = "Toss with the sauce and serve."

**Step { step } of 4:** { now }

:button "Switch the stove" -> hot toggle

Stove on: { hot }
\`\`\`

Conditional blocks (\`:if\`) are not available, so a step-through sets a text
state and prints it. One button per step is the pattern. \`toggle\` flips a
true or false value, and \`{ hot }\` prints it.

### A form: :form into

\`\`\`wd
# RSVP

:form into rsvp
:input name placeholder="Your name"
:select meal
- Chicken
- Fish
- Vegetarian
:radio seat
- Aisle
- Window
:textarea note placeholder="Allergies or notes"
:submit "Send RSVP"
:endform

Last answer: { rsvp.name } wants the { rsvp.meal }, { rsvp.seat } seat. { rsvp.note }
\`\`\`

A form puts what was typed into the state named after \`into\` when the reader
presses the submit button or Enter. It sends nothing anywhere. The answers
live in the page until it is closed. Inside a form, \`:input\`, \`:textarea\`,
\`:select\` and \`:radio\` name their own fields, and \`{ rsvp.name }\` reads one back.
Do not use a checkbox group inside a form: its values are not collected as a
list. Use a bound \`:checkbox\` outside a form instead.

### Grouping: :::

\`\`\`wd
# Notes

::: summary
**Heads up:** the totals below update as you move the sliders.
:::
\`\`\`

\`::: name\` opens a block and a bare \`:::\` closes it. In Markie it is a plain
group of content. Style classes such as \`.card\` are dropped, so it adds no box
or colour.

### What does not work in Darkmown preview

These either stop the preview with an error or are switched off, with a
notice in the preview pane. Do not use them.

- \`:if\`, \`:else if\`, \`:else\`, \`:endif\`: the conditional markup is removed and
  the branches no longer switch. Show state with \`{ name }\` instead.
- \`@loop\`, \`@include\`: refused with an error.
- \`+\` in \`:computed\`: refused with an error. Comparisons, \`sum()\`, \`avg()\`,
  \`count()\`: the computed value is switched off.
- Format pipes such as \`{ price | money }\`: refused with an error.
- \`:store\` and \`persist\`: Markie shows a notice and keeps nothing between
  sessions. \`:store\` also loses its starting value. Use \`:state\`.
- \`:every\`, \`:effect\`, \`:fetch\`, \`:theme\`, \`:carousel\`, \`:video\`, \`:audio\`, \`:embed\`:
  switched off.
- Button actions that change lists or objects: \`append\`, \`prepend\`, \`remove\`,
  \`clear\`, \`merge\`, \`delete\`. Only the actions listed above work.
- \`:input\` outside a form: the input is disabled. Use \`:bind\`.
- Inside a \`.wd\`: links lose their address and show as plain text, pictures
  are removed, \`- [ ]\` task lists show the literal brackets (use \`:checkbox\`),
  and footnotes, math and raw HTML do not render. Fenced code shows without
  colour.

## Sending the document to the user

When the user wants to read the document away from this computer, or asks for
a link, hand them a link, not a path.

With the local Markie tools:

1. Write the file with \`markie_write_document\`. Use \`~/Documents/Markie/\` when
   the user did not say where. It writes \`.md\`, \`.txt\`, \`.csv\`, \`.json\`,
   \`.yaml\`, \`.xml\` and \`.wd\`.
2. For a \`.md\`, run \`markie_check_md\` and fix what it reports.
3. If the user asked to see it now, call \`markie_open_in_markie\`.
4. If the user wants a link, a hosted copy, or to read it away from this
   computer, call \`markie_cloud_sync\` with the file's path. It syncs
   \`.md\`, \`.markdown\`, \`.mdx\`, \`.txt\`, \`.text\` and \`.wd\`. The result
   carries \`markdownLink\`.
5. Paste \`markdownLink\` into your reply exactly as returned. It looks like
   \`[Plan.wd](https://api.markiedocs.com/d/abc123)\`. Do not rebuild it from
   the name and the address: the name inside is already escaped. The result
   also carries \`privateLink\`, the bare address.

Call \`markie_cloud_sync\` again after you change the file. It pushes the latest
text to the same link. \`markie_cloud_status\` reports whether a file is synced
and returns its links without uploading.

What the user sees:

- The Markie app does the upload with the user's own sign-in. The first time,
  it asks the user to allow it, so the call can wait on them.
- If the call fails with "Sign in to Markie Cloud in the Markie app first", tell
  the user to sign in, then ask again. Do not retry in a loop.
- The link is private. It opens for the user, and for people they share the
  document with, after sign-in. On a phone it opens in the Markie app. In a
  browser it opens the web page.

With only the hosted Markie tools (no desktop app on this machine):

1. Call \`markie_create_document\` with \`name\` and \`content\`. Give the name a
   real extension: \`.md\`, \`.markdown\`, \`.mdx\`, \`.wd\` or \`.txt\`. A \`.wd\` may be
   up to 128,000 characters. Anything else may be up to 2 MB.
2. Paste the \`markdownLink\` in the result into your reply, exactly as returned.
3. To change the document, call \`markie_update_document\` with its \`id\` and the
   full new \`content\`. The link stays the same. \`markie_list_my_documents\` and
   \`markie_read_my_document\` find the documents this token created, and
   nothing else the user owns.
4. Do not add front matter, relative links, or pictures that sit beside the
   document. Use https addresses or data URIs for pictures.

Public links:

- A public link opens for anyone who holds it, with no account.
- Only make one when the user asked for a public link in so many words.
  \`markie_cloud_public_link\` with \`create: true\` makes it for a file that is
  already synced, and Markie asks the user to confirm each one. Otherwise give
  the private link.
- \`markie_cloud_revoke_public_link\` turns one off.

## Other document types

Markie opens more than markdown, and the tools follow it. Each type has a
format id, which is what the formats filter of \`markie_find_documents\` and
\`markie_search_documents\` takes.

| Format id | Files | Search reads its text | \`markie_read_document\` | \`markie_write_document\` |
| --- | --- | --- | --- | --- |
| \`markdown\` | \`.md\` \`.markdown\` \`.mdx\` | yes | as written | yes |
| \`darkmown\` | \`.wd\` | yes | as written | yes |
| \`text\` | \`.txt\` \`.text\` \`.log\` | yes | as written | yes |
| \`csv\` | \`.csv\` | yes | as written | yes |
| \`json\` | \`.json\` | yes | as written | yes, valid JSON only |
| \`yaml\` | \`.yaml\` \`.yml\` | yes | as written | yes |
| \`xml\` | \`.xml\` | yes | as written | yes |
| \`html\` | \`.html\` \`.htm\` | yes | extracted text | no |
| \`docx\` | \`.docx\` | yes | extracted text | no |
| \`odt\` | \`.odt\` | yes | extracted text | no |
| \`rtf\` | \`.rtf\` | yes | extracted text | no |
| \`doc\` | \`.doc\` | name and path only | no | no |

Extracted text is the words of a document without its formatting, pictures or
layout. It comes back labelled read-only, because writing plain text over a
Word, OpenDocument or RTF file would destroy everything else in it. To change
one of those, open it with \`markie_open_in_markie\` so the user edits it in
Markie, or put your changes in a new markdown document. Legacy .doc only gives
up its text to the reader Markie runs when the document is opened.

A file past its read limit (4 MB for text and HTML, 8 MB for RTF, 32 MB for
Word and OpenDocument) is still found by name and path, but its text is not
searched or read.

Everything above the Darkmown section is about markdown. Pictures, embeds,
inline HTML and the project and block front matter do not apply to the other
types.
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
