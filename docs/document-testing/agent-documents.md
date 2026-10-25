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
| `samples/Launch-checklist.wd` | Tick Design approved and Shipped | Left to do: 2 of 4. Progress: 50%. Untick one and it follows |
| `samples/Estimate.wd` | Move the Hours slider to 10 | Subtotal 1200, Discount 120, Total 1080 |
| `samples/Step-through.wd` | Press Step 3, then Switch the stove | Step 3 of 4 with its text, Stove on: true |

Edit the source. Trust must be revoked at once, and ticks, slider positions and steps return to their starting values.

## Things the guide says do not work

Paste each into a new `.wd` and trust it. Each one should show a notice in the preview pane that unsupported features were disabled, or an error naming the problem. The source must stay as typed.

- `:if` with `:endif`: the branches do not switch when you press a button.
- `:state n = 0 persist` and `:store`: nothing is kept after a reload.
- A `:computed` line with `+`, or a `{ price | money }` pipe, or an `@loop` or `@include` line: the preview refuses with an explanation.
- A table with a right-aligned column (`---:`) in a `.wd`: a notice appears and the alignment is dropped.
- Links, pictures and `- [ ]` lists inside a `.wd`: links show as plain text, pictures are removed and the brackets stay literal.

## Sending a document as a link

With Markie signed in to Markie Cloud and the Markie MCP connected, ask an agent for a short plan and a link to read it on your phone. The agent should write the file, call `markie_cloud_sync` and paste a ready-made markdown link (`markdownLink`) into the chat. The first sync asks you to allow it. The link is private: it opens only after you sign in. The agent must not make a public link unless you ask for one in so many words, and Markie confirms each public link with you.
