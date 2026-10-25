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
// list), src/lib/markdown-html.ts (the export, print and PDF renderer) and
// server/src/render.ts (the renderer behind shared web pages), and every
// ```wd example through compileDarkmownPreview, the same compile, sanitize and
// runtime path the app's preview uses. src/lib/agent-guide-markdown.test.tsx,
// src/lib/darkmown/agent-guide.test.ts and server/src/agent-guide-render.test.ts
// do that on every test run and fail when an example stops compiling or an
// element stops rendering. Re-measure rather than re-read: several claims here
// were the opposite of what the code comments said at the time. The "Other
// document types" table at the end restates what doc-text.cjs and lib.mjs
// (READ_FORMATS, WRITE_FORMATS) enforce, and the extensions the "Sending"
// section lists for markie_cloud_sync must pass the desktop's SYNCABLE and the
// cloud-tool format guard in markie-mcp.mjs. lib.test.mjs checks both.
//
// Prose rules: short sentences, plain labels, examples over adjectives, and no
// em-dash character anywhere in the text (lib.test.mjs fails on one).
// Template literal rules: a backtick is written \` and a dollar sign followed
// by a brace is never written, so Darkmown examples avoid a leading dollar.
// Self-contained: no imports from outside mcp/ (see the scan.mjs header).

export const MARKDOWN_GUIDE = `# Writing documents for Markie

Markie draws much more than plain markdown: tables, task lists, pictures, video, audio and live Darkmown documents. Use them. Every example below is checked against Markie's own renderer when Markie is built.

Agents using only the hosted tools can skip: markie_check_md, workspace folders, the Other document types table, front-matter filing.

## The short version

- Pick the format. \`.md\` is for reading. \`.wd\` (Darkmown) is for a document the reader clicks, ticks, slides or calculates with. \`.csv\` is for plain rows. If the reader will mostly open it through a link in a browser, prefer \`.md\`: a \`.wd\` on the web shows its source.
- Structure it: one \`#\` title, a one or two sentence summary, \`##\` sections, short paragraphs, the answer first. Use a table for items with attributes, a task list for to-dos, a blockquote with a bold label for a note, a fenced block with a language for code.
- These do not exist: callouts (\`> [!NOTE]\` shows as a plain quote), diagrams (a \`mermaid\` block stays code), emoji shortcodes, and heading anchors (\`[Jump](#section)\` goes nowhere).
- A picture, clip or recording is \`![alt](path)\`. The file has to sit beside the document, or inside a folder the user added to Markie as a workspace. Any other path displays nothing, with no error. Never point at /tmp.
- Math and footnotes render in exports and shared web pages, not in the Markie editor. HTML at the start of a line shows as a placeholder token in the editor, and \`<script>\`, \`<iframe>\` and \`<form>\` render nowhere.
- Darkmown runs \`:state\`, \`:computed\` (\`-\` \`*\` \`/\` \`%\` only, so add with \`a - -b\`), \`:button\`, \`:slider\`, \`:bind\`, bound \`:select\` \`:checkbox\` \`:radio\`, and \`:form into\`. It does not run \`:if\`, loops, includes, \`:store\`, \`persist\`, \`:fetch\`, \`+\` or format pipes. Declare a name before you use it: an undeclared \`{ name }\` prints as \`{ name }\`, and \`:input\` and \`:textarea\` outside a form are disabled silently.
- Give the user a link: write with \`markie_write_document\`, call \`markie_cloud_sync\`, and paste the \`markdownLink\` it returns. With only the hosted tools, call \`markie_create_document\` and paste its \`markdownLink\`. Leave \`project\` and \`block\` out of a document you send as a link. Make a public link only when the user asked for one.

## Choosing a format

| You are writing | Use |
| --- | --- |
| A report, plan, spec, notes, README | \`.md\` |
| A calculator, an estimate, a checklist that counts, a small dashboard, a step-through, a short form | \`.wd\` |
| Rows and columns of data | \`.csv\` |
| Literal text, a log | \`.txt\` |
| Config or data | \`.json\` \`.yaml\` \`.xml\` |

Default to \`.md\`. Write \`.wd\` when the reader would otherwise need a second document to try a number or tick a box. A \`.wd\` is live only in the Markie app. On the web, and in any other editor, it shows its source. A \`.md\` never runs a directive.

## Structure

- One \`#\` title, then one or two sentences: what this is, and what the reader should do or decide. Answer first, background after.
- \`##\` for sections, \`###\` for parts. Stop there. Headings are labels of two to five words.
- Paragraphs of one to three sentences. Steps in a numbered list, parallel items in a bullet list.
- No table of contents of \`[Jump](#section)\` links. Headings have no anchors.

A document can start with front matter, which the editor writes back byte for byte. \`markie_write_document\` writes it when you pass \`project\` and \`block\`:

\`\`\`markdown
---
markie:
  project: bevrly
  block: checkout-redesign
---

# Checkout redesign
\`\`\`

Exports print front matter as text at the top. For a document you send as a link or export, leave \`project\` and \`block\` out.

## Elements that render

Rich (Command-1) is the editor, and Source (Command-2) is the file's own bytes. Export, print, PDF and shared web pages use a second renderer. The rules below say where they differ.

### Tables

\`\`\`markdown
| Option | Cost | Risk |
| :--- | ---: | --- |
| Rebuild | 12 days | **High** |
| Patch | 3 days | Low, see [the notes](notes.md) |
\`\`\`

Colons in the delimiter row align a column. Cells hold one line of inline markup, never a list. Editing a table in Rich drops the colons.

### Task lists

\`\`\`markdown
- [x] Draft the plan
- [ ] Get review
- [ ] Ship
\`\`\`

Rich draws checkboxes, and exports and shared pages draw them read-only. A checklist that counts needs Darkmown.

### Notes and warnings

\`\`\`markdown
> **Note:** The export runs nightly.
\`\`\`

There are no callout boxes: \`> [!NOTE]\` shows as a quote that starts with the literal text [!NOTE].

### Code

\`\`\`\`markdown
\`\`\`ts
const total = items.length;
\`\`\`
\`\`\`\`

Exports, PDFs and shared pages syntax highlight it, and the editor shows it plain. A \`mermaid\` block draws no diagram: embed a \`.png\` or \`.svg\`, or describe the flow in a numbered list.

### Links to other documents

\`[the plan](plan.md)\` links to a file beside this document. When both documents are in the user's Markie Cloud and the target ends in \`.md\`, \`.markdown\`, \`.mdx\` or \`.txt\`, readers who may open the target can follow it on the web page, and everyone else sees it muted. Hosted documents have no neighbouring files: link to another document there with its \`markdownLink\`.

### Pictures, video and audio

One syntax for all three. Markie picks the player or picture by extension:

\`\`\`markdown
![the dashboard](demo/shot.png)
![the walkthrough](demo/clip.mp4)
![the voice memo](demo/memo.mp3)
\`\`\`

- Pictures: \`.png\` \`.jpg\` \`.jpeg\` \`.gif\` \`.webp\` \`.svg\` \`.avif\` \`.bmp\` \`.ico\`.
- Video: \`.mp4\` \`.m4v\` \`.webm\` \`.ogv\` \`.mov\`.
- Audio: \`.mp3\` \`.m4a\` \`.aac\` \`.wav\` \`.flac\` \`.oga\` \`.opus\`.

Anything else is a link: \`![](report.pdf)\` displays nothing, so write \`[the report](report.pdf)\`. A picture can be an https address. Video and audio must be local files.

### Where the file has to live

A document may reach a file inside its own folder or one of the user's workspace folders, and nothing else. \`<img>\` and \`<video>\` tags and links such as \`[the spec](spec.pdf)\` follow the same rule. The document must be saved.

\`\`\`markdown
![beside the document](shot.png)
![in a folder beside it](assets/shot.png)
![up in a shared folder, only inside a workspace](../assets/logo.png)
\`\`\`

Write the file beside the document and reference it relatively. When you sync to Markie Cloud, the pictures, clips and recordings it references go up with it. An absolute path works only inside a workspace, which you cannot see. \`/tmp\` or any other place displays nothing, and nothing says why: move the file first.

Hosted documents cannot carry a file beside them. Use an https picture address, or inline a small picture as a data URI:

\`\`\`markdown
![dot](data:image/png;base64,iVBORw0KGgo=)
\`\`\`

That renders in Rich and in every export. It is the wrong answer for a clip.

### Sizing a picture

Markdown has no width, so a sized picture is its own tag, alone on its line:

\`\`\`markdown
<img src="demo/shot.png" alt="the dashboard" width="240">

<video src="demo/clip.mp4" width="320" controls></video>
\`\`\`

Rich reads that exact shape back as a picture with drag handles, and exports and shared pages honour the width. Words on the same line make it raw HTML, held aside. Set only the width.

### A video from YouTube or Vimeo

\`\`\`markdown
https://youtu.be/dQw4w9WgXcQ
\`\`\`

The bare address, alone on its line. Rich draws a card and loads the player on click. An export or shared page draws the thumbnail linked to the video, for YouTube only. A Vimeo link stays a link there, and so does a link inside a sentence.

### Centring a line

\`\`\`markdown
<p style="text-align: center;">Signed off by the team</p>

<h2 style="text-align: right;">Appendix</h2>
\`\`\`

\`center\`, \`right\`, \`justify\` and \`left\` work on \`<p>\` and \`<h1>\` through \`<h6>\`, in Rich, exports and shared pages. Use double quotes and no other attributes: a \`class\` or single quotes make it raw HTML, which shows a placeholder in Rich. Inside the tag write HTML (\`<strong>\`), because \`**bold**\` shows its asterisks.

### Inline HTML and raw HTML

Kept everywhere: \`<mark>flagged</mark>\`, \`<u>underlined</u>\`, \`<span style="color: #b91c1c">red</span>\`, \`<span style="font-family: Georgia">\` and \`<span style="font-size: 24px">\`. A span's \`background-color\` is dropped in Rich (use \`<mark>\`), \`<kbd>\` \`<sub>\` \`<sup>\` \`<ins>\` lose the tag there, and \`<small>\` and \`<abbr>\` lose it everywhere.

A tag at the start of a line makes an HTML block. Markie keeps the original bytes, and Rich shows a placeholder token where the block was. Exports, PDFs and shared pages render it, sanitized. \`<div>\`, \`<details>\`, \`<summary>\`, \`<table>\`, \`<blockquote>\`, \`<section>\`, \`<pre>\` and lists come out, while \`<figure>\`, \`<figcaption>\`, \`<center>\`, \`<header>\`, \`<footer>\` and \`<aside>\` lose the tag and keep the text. Only the lone picture or clip tag and the aligned \`<p>\` or heading above are drawn properly in Rich, so write other blocks only when the export matters more than the app.

\`<script>\`, \`<iframe>\`, \`<style>\`, \`<object>\`, \`<form>\`, any \`on...=\` handler and a \`javascript:\` link: each renders nowhere, contents included.

### Math and footnotes

\`\`\`markdown
Euler: $e^{i\\pi} + 1 = 0$

$$
E = mc^2
$$

A claim that needs a source[^1]

[^1]: The source.
\`\`\`

Both render in exports, PDFs, print and shared web pages. Rich shows the literal text, and editing a formula there escapes its backslashes, so change formulas in Source.

## Darkmown (.wd)

Darkmown is markdown with live state. A line that starts with a colon declares a value or a control, and \`{ name }\` prints a value. Markie runs it in a sandbox with no network, files or accounts.

- The preview starts switched off: controls are disabled and the page shows starting values. The user chooses **Trust this document** to turn them on, and any edit to the source takes the trust away.
- State is temporary and resets when the document is reopened. Only the source is saved.
- It is live only in the Markie app, if installed. On the web a \`.wd\` shows its source.

Limits:

- At most 128,000 characters and 5,000 lines (a final newline counts as a line). Past that, Markie saves the file but will not preview it.
- Source length times the number of \`{\` characters and \`:computed\` lines may not pass 1,000,000.
- Directives only work at the very start of a line. In a list, a quote, indented text or a code fence they are plain text.
- Declare before use. A \`:computed\` or bound control that names an undeclared value stops the preview (WD234, WD406, WD450). A plain \`{ name }\` for an undeclared name prints as \`{ name }\`, with no error.
- A wrong line shows an error such as \`[WD201] Malformed :state\`, and the source is never changed. You cannot run the preview, so copy the shapes below.

### A counter: :state, :computed, :button

\`\`\`wd
# Water tracker

:state cups = 0
:computed ounces = cups * 8

Today: { cups } cups, about { ounces } ounces.

:button "Add a cup" -> cups++
:button "Remove a cup" -> cups--
:button "Start over" -> cups reset
\`\`\`

- \`:state name = value\` declares a number, a string in double quotes, \`true\` or \`false\`, or an object such as \`{"count": 0, "total": 0}\`.
- \`{ name }\` prints it, in a paragraph, heading, list, quote or table cell. \`{ cart.count }\` reaches into an object.
- \`:computed name = expression\` derives a value from names, numbers, \`-\` \`*\` \`/\` \`%\`, a leading minus and parentheses. It may use another computed value.
- **There is no \`+\`, but you can add: subtract a negative.** \`total = subtotal - -tax\` and \`total = subtotal - (0 - tax)\` both work and update live. Comparisons, \`sum()\` and the other aggregates are not available.
- Button actions: \`n++\`, \`n--\`, \`n += 5\`, \`n -= 2\`, \`n = 10\`, \`label = "Done"\`, \`on = true\`, \`on toggle\`, \`n reset\` (back to the \`:state\` value).
- Chain actions with a semicolon: \`:button "Add" -> cart.count++ ; cart.total += 9\`. Never put one inside a quoted value.

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

- \`:slider name = start min=.. max=.. step=..\` declares the value and draws a range input. For a value already declared, write \`:slider name min=1 max=40\`.
- A table cell can hold \`{ name }\`, which builds a small dashboard. Leave alignment colons (\`---:\`) out of a \`.wd\` table: Markie drops them with a notice.

### Text input: :bind

\`\`\`wd
# Greeting

:state who = ""
:bind who placeholder="Your name"

Hello { who }.
\`\`\`

\`:bind name\` draws a text input tied to a declared state. It accepts \`placeholder\` and nothing else. Typed digits work in arithmetic, but \`:slider\` suits numbers better.

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

Outside a form, \`:select\`, \`:radio\` and \`:checkbox\` tie to a state of the same name, declared first. A \`:checkbox\` is one true or false value with exactly one \`- Label\` line. A \`:radio\` or \`:select\` holds the chosen option's text.

### Money: numeric choices, adding, rounding

\`\`\`wd
# Order total

:state qty = 1
:state price = 12.99
:state taxrate = 8

:select qty
- 1
- 2
- 5

:radio price
- 12.99
- 24.5
- 40

:computed exact = qty * price * (100 - -taxrate)
:computed half = exact - -0.5
:computed cents = half - half % 1
:computed total = cents / 100

Total with tax: { total } for { qty } at { price } each.
\`\`\`

- \`:radio\` and \`:select\` options that are numbers feed straight into \`:computed\`, which suits quantity and tier pickers. Declare the state as a number matching one option.
- \`price * (100 - -taxrate)\` is the price plus tax, in cents.
- Round with \`%\`: \`x % 1\` is the fractional part, so \`x - x % 1\` drops it. Add one half first (\`x - -0.5\`) to round to the nearest. Round cents, then divide by 100.
- Numbers print as JavaScript prints them: \`0.1 * 3\` shows \`0.30000000000000004\`, and 70.50 shows \`70.5\`. There are no format pipes.

### A checklist that counts

\`\`\`wd
# Launch checklist

:state design = false
:state copy = false
:state ship = false

:checkbox design
- Design approved

:checkbox copy
- Copy written

:checkbox ship
- Shipped

:computed left = 3 - design - copy - ship
:computed raw = (3 - left) * 100 / 3
:computed percent = raw - raw % 1

Left to do: { left } of 3. Progress: { percent }%.
\`\`\`

A checked box is 1 and an unchecked box is 0, so \`3 - design - copy - ship\` is what is left. One of three is 33.333333333333336 percent, so \`raw - raw % 1\` rounds it down to 33. When the count divides 100 (2, 4, 5, 10), no rounding is needed.

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

There is no \`:if\`, so a step-through sets a text state and prints it, one button per step.

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

On submit or Enter, a form puts what was typed into the state named after \`into\`. It sends nothing anywhere, and the answers live in the page until it is closed. Inside a form, \`:input\`, \`:textarea\`, \`:select\` and \`:radio\` name their own fields, and \`{ rsvp.name }\` reads one back. A checkbox group in a form is switched off: use a bound \`:checkbox\` outside.

### Grouping: :::

\`\`\`wd
# Notes

::: summary
**Heads up:** the totals below update as you move the sliders.
:::
\`\`\`

\`::: name\` opens a block and a bare \`:::\` closes it. It is a plain group: classes such as \`.card\` are dropped, so it adds no box or colour.

### What does not work in Darkmown preview

An error stops the preview:

- \`@loop\` and \`@include\`.
- \`+\` in \`:computed\`. To add numbers, subtract a negative. Text cannot be joined: print the values side by side, \`{ first } { last }\`.
- Format pipes such as \`{ price | money }\`.
- A \`:computed\` or bound control naming an undeclared value (WD234, WD406, WD450), a \`:bind\` attribute other than \`placeholder\`, a \`:checkbox\` with several labels, a semicolon inside a quoted action value.

A notice appears in the preview pane and the feature is switched off:

- \`:if\`, \`:else if\`, \`:else\`, \`:endif\`: the branches never switch. Show state with \`{ name }\`.
- Comparisons, \`sum()\`, \`avg()\` and \`count()\` in \`:computed\`.
- \`:store\` and \`persist\`: nothing is kept, and \`:store\` loses its starting value. Use \`:state\`.
- \`:every\`, \`:effect\`, \`:fetch\`, \`:theme\`, \`:carousel\`, \`:video\`, \`:audio\`, \`:embed\`.
- Button actions that change lists or objects: \`append\`, \`prepend\`, \`remove\`, \`clear\`, \`merge\`, \`delete\`.
- Links and pictures inside a \`.wd\` (links become plain text, pictures vanish), a checkbox group in a form, and table alignment colons.

Nothing tells you about these:

- \`:input\` and \`:textarea\` outside a form are disabled silently. Use \`:bind\`.
- \`- [ ]\` task lists show the literal brackets. Use \`:checkbox\`.
- Subtracting a negative from text, such as \`first - -last\`, prints \`NaN\`.
- Footnotes, math and raw HTML do not render, and fenced code has no colour.

## Sending the document to the user

When the user wants to read the document away from this computer, or asks for a link, give them a link, not a path.

With the local Markie tools:

1. Write the file with \`markie_write_document\`, under \`~/Documents/Markie/\` when the user did not say where. It writes \`.md\`, \`.txt\`, \`.csv\`, \`.json\`, \`.yaml\`, \`.xml\` and \`.wd\`.
2. Run \`markie_check_md\` when the document has a picture, a clip or inline HTML, and fix what it reports.
3. If the user asked to see it now, call \`markie_open_in_markie\`.
4. For a link, a hosted copy, or reading away from this computer, call \`markie_cloud_sync\` with the file's path. It syncs \`.md\`, \`.markdown\`, \`.mdx\`, \`.txt\`, \`.text\` and \`.wd\`, and the result carries \`markdownLink\`.
5. Paste \`markdownLink\` into your reply exactly as returned, for example \`[Plan.wd](https://api.markiedocs.com/d/abc123)\`. Do not rebuild it: the name inside is already escaped. \`privateLink\` is the bare address.

Call \`markie_cloud_sync\` again after you change the file, and it pushes the latest text to the same link. \`markie_cloud_status\` returns the links without uploading.

- The Markie app uploads with the user's own sign-in and asks them to allow it the first time, so the call can wait on them. If it fails with "Sign in to Markie Cloud in the Markie app first", tell the user to sign in, then ask again. Do not retry in a loop.
- The link is private. It opens, after sign-in, for the user and the people they share the document with, in the Markie app if it is installed and in a browser otherwise.

With only the hosted Markie tools (no desktop app on this machine):

1. Call \`markie_create_document\` with \`name\` and \`content\`. Give the name a real extension: \`.md\`, \`.markdown\`, \`.mdx\`, \`.wd\` or \`.txt\`. A \`.wd\` may be up to 128,000 characters, anything else up to 2 MB.
2. Paste the \`markdownLink\` in the result into your reply, exactly as returned.
3. To change the document, call \`markie_update_document\` with its \`id\` and the full new \`content\`. The link stays the same. \`markie_list_my_documents\` and \`markie_read_my_document\` find only the documents this token created.
4. Batch your edits. Writes are rate limited (60 an hour per token, 200 an hour per user, 50 MB a day per user), so finish the document and write it once.
5. If the user shared the document or made it public, an update fails with \`shared\`. Create a new document with \`markie_create_document\` and give the new link.
6. No front matter, relative links or pictures beside the document. Use https addresses or data URIs for pictures.

Public links:

- A public link opens for anyone who holds it, with no account. Make one only when the user asked for it in so many words. \`markie_cloud_public_link\` with \`create: true\` makes it for a synced file, and Markie asks the user to confirm each one. \`markie_cloud_revoke_public_link\` turns one off.
- The hosted tools cannot make a public link.

## Other document types

The format id is what the formats filter of \`markie_find_documents\` and \`markie_search_documents\` takes.

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

Extracted text drops formatting, pictures and layout, and is labelled read-only. To change a Word, OpenDocument or RTF file, open it with \`markie_open_in_markie\`, or put your changes in a new markdown document.
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
