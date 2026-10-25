# Agent-written documents

[Back to the test guide](README.md) · [Interactive Darkmown checks](darkmown.md) · [Media and links](media-and-links.md)

Agents that connect to Markie read `markie_guide` before they write. It teaches them to pick a format, structure the document, use the elements Markie draws and, for anything the reader should click or calculate with, write Darkmown (`.wd`). These checks confirm the documents come out the way the guide promises. Use disposable copies.

## A rich markdown document

Open `samples/Rich-document.md`. In Rich (Command-1) you should see a table with a right-aligned numeric column, three checkboxes, two quoted notes with bold labels, a code block, a centred line and a highlighted phrase. The footnote and the formula appear as the text typed. Export a PDF (Shift-Command-E): the formula and the footnote now render, the code is syntax coloured and the checkboxes are read-only.

There are no callouts, diagrams, emoji shortcodes or heading anchors. A document that uses `> [!NOTE]` shows a plain quote that starts with the words in brackets. That is expected, and the guide tells agents not to write it.

## Darkmown samples

Open each `.wd` with Markie's Open button, choose Darkmown Source and Preview from View, and choose **Trust this document**.

| Sample | Do this | Expected |
| --- | --- | --- |
| `samples/Launch-checklist.wd` | Tick Design approved, then Copy written, then Shipped | Progress: 33%, then 66%, then 100%, never a long decimal. Untick one and it follows |
| `samples/Estimate.wd` | Move the Hours slider to 10 | Subtotal 1200, Discount 120, Total 1080 |
| `samples/Order-total.wd` | Pick 5 and 12.99, then 2 and 24.5, then 1 and 40 | Total 70.15, then 52.92, then 43.2. The quantity and price pickers feed the sum, tax is added by subtracting a negative, and the total rounds to the nearest cent |
| `samples/Step-through.wd` | Press Step 3, then Switch the stove | Step 3 of 4 with its text, Stove on: true |

Edit the source. Trust must be revoked at once, and ticks, slider positions and steps return to their starting values.

## Things the guide says do not work

Paste each into a new `.wd` and trust it. The source must stay as typed. They fail in three different ways, and the guide says which.

An error names the problem and the preview stops:

- A `:computed` line with `+`, a `{ price | money }` pipe, or an `@loop` or `@include` line.
- A `:computed` line that names a value declared later or never (WD234).

A notice says unsupported features were disabled, and the feature is switched off:

- `:if` with `:endif`: the branches do not switch when you press a button.
- `:state n = 0 persist` and `:store`: nothing is kept after a reload.
- A table with a right-aligned column (`---:`): the alignment is dropped.
- Links and pictures: links show as plain text and pictures are removed.

Nothing tells you. There is no notice and no error:

- `:input` and `:textarea` outside a form are disabled. Use `:bind`.
- A `- [ ]` task list keeps its literal brackets. Footnotes, math and raw HTML do not render.
- A `{ name }` that was never declared prints as `{ name }`.

Addition is not one of the failures. `:computed s = a - -b` adds, and the Order total sample uses it.

## Sending a document as a link

With Markie signed in to Markie Cloud and the Markie MCP connected, ask an agent for a short plan and a link to read it on your phone. The agent should write the file, call `markie_cloud_sync` and paste a ready-made markdown link (`markdownLink`) into the chat. The first sync asks you to allow it. The link is private: it opens only after you sign in, in the Markie app if it is installed and in a browser otherwise. A `.wd` opened in a browser shows its source, so for a document you will read in a browser ask for a `.md`. The agent must not make a public link unless you ask for one in so many words, and Markie confirms each public link with you.
