// The first document a new user sees.
//
// Markie's onboarding is a markdown file, because Markie is a markdown app: the
// document that explains the product is also the demo of it. Every feature it
// names is visible in the same screen that names it, and reading it to the end
// requires nothing but reading.
//
// It never asks for an account. Sharing and sync are mentioned as things that
// exist and will ask when they're needed, which is the whole local-first
// bargain stated once, plainly, at the only moment the user is looking for it.
//
// Keep the shortcuts here honest: they are checked against the real command
// list in welcome-doc.test.ts, so a renamed accelerator fails the suite rather
// than quietly lying to every new user.

export const WELCOME_DOC = `# Welcome to Markie

This is a real markdown file, and what you're looking at is Markie rendering it.
Nothing here is a screenshot.

## Three ways to see a document

| Press | You get |
| --- | --- |
| \`⌘1\` | **Rich** — formatted, the way it will look to a reader |
| \`⌘2\` | **Source** — the raw markdown, syntax highlighted |
| \`⌘3\` | **Split** — both, side by side, scrolling together |

Try \`⌘2\` right now and you'll see the markdown behind this page.

## Try it here

These are real checkboxes. Click one.

- [x] Open Markie
- [ ] Click this box
- [ ] Press \`⌘K\` and type something

Code keeps its highlighting, and tables stay aligned:

\`\`\`typescript
const welcome = (reader: string) => \`Nice to meet you, \${reader}.\`;
\`\`\`

Math renders too: $E = mc^2$

## \`⌘K\` is the whole app

One palette, everything in it. If you only remember one shortcut, remember that
one. \`⌘/\` lists the rest.

A few worth knowing now:

- \`⌘L\` — your **Library**, every document Markie knows about
- \`⌘F\` — find, with replace on \`⌥⌘F\`
- \`⌘N\` — a new file
- \`⇧⌘E\` — export a PDF that looks like this

## Your files stay yours

Markie reads and writes ordinary \`.md\` files in ordinary folders. There is no
import step and no lock-in: delete Markie tomorrow and every document you wrote
is still sitting there, still readable in any editor.

You do not need an account. Markie works completely without one.

> Sync and sharing do need an account, because another device or another person
> has to be able to reach the document. Markie will ask you then, and not before.

---

That's the tour. Open something of your own with \`⌘O\`, or press \`⌘N\` and start
writing.
`;
