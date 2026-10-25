---
name: markie-conventions
description: How to write rich documents for Markie, the user's local document workspace, and hand them over as a link. Covers choosing a format (markdown, Darkmown .wd for live state, CSV), the elements Markie renders (tables, task lists, pictures, video, math), where a document is filed (project, block), finding and reading documents, and sending the user a markdownLink with markie_cloud_sync. Use whenever writing documents for the user via markie_write_document or markie_write_md, or when the user asks to organize, search, find or share their documents.
---

# Markie conventions

Markie is the user's document workspace. It draws much more than plain
markdown: tables, task lists, pictures, video, math, and Darkmown (`.wd`), a
markdown dialect with live state. Write documents that use them. Call
`markie_guide` before you write anything beyond a few paragraphs. It has a
tested example of every element and every Darkmown directive, and it is also
the `markie://guide/markdown` resource.

## Choose the format

- `.md` for anything to read: reports, plans, specs, notes.
- `.wd` when the reader should click, tick, slide or calculate: a calculator, an
  estimate, a checklist that counts, a small dashboard, a step-through, a short
  form. A `.md` never runs directives.
- If the reader will mostly open it through a link in a browser, prefer `.md`:
  a `.wd` on the web shows its source.
- `.csv` for plain rows and columns. `.txt` for literal text.
- Word, RTF, OpenDocument and HTML are never written by the tools. Write a new
  `.md` instead, or open the file with `markie_open_in_markie`.

## Make it rich

- One `#` title, a one or two sentence summary, `##` sections, short
  paragraphs, the answer first.
- A table for items with attributes. A task list (`- [ ]`) for to-dos. A
  blockquote with a bold label (`> **Note:** ...`) for a note. A fenced block
  with a language for code.
- A picture, clip or recording is `![alt](path)`, with the file beside the
  document. Never a path in `/tmp`: it displays nothing and says nothing.
- Math (`$x^2$`) and footnotes render in exports and shared pages. The editor
  shows their source.
- These do not exist, so do not write them: `> [!NOTE]` callouts, `mermaid`
  diagrams, `:emoji:` shortcodes, `[Jump](#section)` anchor links.
- Run `markie_check_md` when the document has a picture, a clip or inline HTML.

## Darkmown in one screen

```wd
# Launch checklist

:state design = false
:state ship = false

:checkbox design
- Design approved

:checkbox ship
- Shipped

:computed left = 2 - design - ship

Left to do: { left } of 2.
```

- Works: `:state`, `:computed` (with `-` `*` `/` `%` only), `:button`
  (`n++`, `n--`, `n += 5`, `n = 10`, `x = "text"`, `flag toggle`, `n reset`),
  `:slider`, `:bind`, bound `:select` `:checkbox` `:radio`, and `:form into`.
- There is no `+`. To add, subtract a negative: `total = subtotal - -tax`.
- Round with `%`: `percent = raw - raw % 1` drops the fraction (a checklist of
  3 otherwise prints 33.333333333333336). Radio and select options that are
  numbers feed straight into `:computed`. `markie_guide` has money and
  checklist examples.
- Does not work in the preview: `:if`, `@loop`, `@include`, `:store`,
  `persist`, `:fetch`, `+`, format pipes, links, pictures and `- [ ]` lists
  inside a `.wd`. `:input` and `:textarea` outside a form are disabled with no
  notice.
- Declare a name before you use it: an undeclared `{ name }` prints as itself.
- The user must choose Trust this document before the controls turn on, and an
  edit takes the trust away. State is not saved. A `.wd` stays under 128,000
  characters and 5,000 lines.
- Copy the shapes in `markie_guide`. You cannot run the preview yourself.

## Give the user the document

1. Write it with `markie_write_document` (under `~/Documents/Markie/` when the
   user did not say where).
2. If they asked to see it, call `markie_open_in_markie`.
3. If they want a link, a hosted copy, or to read it away from this computer,
   call `markie_cloud_sync` and paste the `markdownLink` from the result into
   your reply. It opens in the Markie app if it is installed, and in a browser
   after sign-in otherwise. Call it again after edits to update the same link.
4. With only the hosted tools, call `markie_create_document` and paste its
   `markdownLink`. Batch edits, because writes are rate limited. If the user
   shared the document or made it public, an update fails with `shared`:
   create a new document and give the new link.
5. Make a public link only when the user asked for one in so many words.
   `markie_cloud_public_link` confirms each one with them. The hosted tools
   cannot make a public link.

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

## Filing documents

1. Search before you write, so you update the document that already exists
   instead of creating `plan-v2-final.md` beside it. If the search says it was
   truncated, it did not see the whole disk, so a miss does not prove the
   document is new.
2. Declare where a markdown document belongs. Pass `project` and `block` to
   `markie_write_document` or `markie_write_md`, or write the front matter
   yourself:

   ```yaml
   ---
   markie:
     project: bevrly
     block: checkout-redesign
   ---
   ```

   Exports print front matter as text. For a document you send as a link or
   export, leave `project` and `block` out.

3. One block per unit of work: a feature, an investigation, a report series.
   Reuse the block name across every document from that work.
4. Name blocks after the work, not the date: `auth-flow`, not `march-notes`.
   A date says when you filed something and never what it was.
5. Match existing project names. A document about a repo belongs to a project
   named like the repo folder.
6. Project, then block, then file is the whole tree. Do not move, rename or
   restructure files on disk to organize them. Declaring the project and block
   is the organizing.
