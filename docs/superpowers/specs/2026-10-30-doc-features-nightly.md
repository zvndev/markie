# Document features for super-nightly

2026-10-30. Kirby's list: a section rail, document tabs, comments driven by MCP, version history, branches and block versions, and a rethought Darkmown. All of it ships to super-nightly only, so Kirby can iterate before anyone else sees it. Markdown first. Other formats can wait.

## Do we need a versioned API?

No. A `/v2` API is not needed for this list.

Almost all of it is local. Tabs, the section rail, local comments, version history and branches all live on the Mac. None of them call the server.

The server already has the handshake we need:

- `GET /api/server-info` returns `apiVersion: 1`.
- The rule in `server/src/deployment.ts`: routes and fields are only ever added, never changed. Old apps ignore what they don't know.
- `apiVersion` is bumped only for a change an existing app cannot survive.

What we add, once a feature needs the cloud:

- **A capability list in `/api/server-info`**, for example `features: ["doc-tabs", "local-comments"]`. A nightly app turns on the cloud half of a feature only if the server lists it.
- **New routes gated to the owner**, the same way private releases are gated today. The server can deploy any day and stable users see nothing.
- **Formats that degrade on old apps.** Tabs are stored as HTML comments inside the markdown. An old app or the public share page shows one long document instead of breaking.

The one real risk is cloud documents. Their live editing runs on a shared Yjs schema. If tabs or branches change that schema, a stable app editing the same doc could damage it. Cloud docs therefore get these features last, behind the capability check.

## Ground rules

- Gated on the build: on when `privateReleaseStatus().channel === "super-nightly"`, plus a flag in `src/lib/features.ts`. Stable builds from the same `main` show nothing.
- Super-nightly is Mac arm64 only, so that is the only place to test.
- The `.md` file stays clean markdown that any other editor can open.

## 1. Section rail

What it is: the tick marks on the left edge of the T3 Code thread, applied to a document.

- One tick per heading, placed at the heading's position in the document. Longer ticks for H1, shorter for H2 and H3.
- The tick for the section on screen is highlighted while you scroll.
- Hover a tick: a card shows the heading and the first two lines of that section.
- Click a tick: the document scrolls to it.
- Shows up only when a document is long, for example more than a screen and a half with three or more headings.
- Works in the rich view and the source view.

No decisions needed. This is the first build.

## 2. Document tabs

What it is: Google Docs' "Document tabs" panel. One document, several pages, listed on the left.

- Panel on the left of the document, collapsible, with `+` to add a tab. Each tab's menu: rename, duplicate, delete, move.
- Storage: one `.md` file. A new tab starts at a marker line, `<!-- markie:tab "Recipes" -->`. Other editors, old Markie builds and share pages see one long document with the tabs in order.
- The section rail shows the current tab's headings.
- Search finds text in any tab and opens that tab.
- MCP: `markie_read_document` and `markie_write_document` take an optional `tab`.

## 3. Comments on local files, driven by MCP

Today comments exist only on cloud documents. They are stored on the server and anchored in the live Yjs document. Local `.md` files have none.

The plan:

- **Anchors by quoted text.** A comment stores the text it points at, plus a few words before and after. Markie finds it again after edits, including edits made by an agent or another editor. If the text is gone, the comment moves to a "detached" list instead of vanishing.
- **Storage:** a store per file kept by Markie, not inside the `.md`. See decision 1.
- **New MCP tools:**
  - `markie_list_comments`
  - `markie_add_comment` with `path`, `quote` and `body`
  - `markie_reply_comment`
  - `markie_resolve_comment`
- **Authors:** "You" for comments made in the app. The agent's name for comments made through MCP.
- **Live:** when an agent comments, the comment appears in the open document without a reload.

This pairs well with branches: an agent can leave comments, and you answer them in place.

## 4. Version history

Most of the history is already there. Every save is already kept on the Mac (`electron/history.js`):

- every version from the last 24 hours
- hourly versions for 7 days
- daily versions for 30 days
- at most 200 versions per file

Edits made outside Markie are already labelled "External edit". What is missing is the Google Docs view of it.

- A panel on the right, grouped by Today, Yesterday, This week and older. Each row shows the time and an author dot.
- Click a version: the document shows that version, read-only. "Highlight changes" marks added text in green and removed text in red.
- **Restore** puts the version into the document as unsaved changes, as the current dialog does. **Copy section** takes back just one part.
- **Name this version**, so an important point stands out from autosaves. Named versions are never pruned.
- Writes made through MCP are labelled with the agent's name, not "External edit".
- Cloud documents keep their last 20 versions on the server. Same panel, later.

## 5. Branches and block versions

This is the part we iterate on. The first nightly ships one design on purpose, then we change it from your screenshots.

**Branches of a whole document.**

- "New branch" makes a named copy, for example "Shorter pitch". It is listed under the document in the left tabs panel with a branch icon.
- Edit the branch freely. The main document is untouched.
- "Merge into main" compares the branch, main and the point where they split. You choose for each changed section: keep main, take the branch, or keep both.

**Versions of one block.**

- Click into a paragraph or a section, then "New version of this section". The text gets alternates.
- A margin badge says "3 versions". Click it to see them side by side and choose the one that goes into the main document. The others stay available.
- Through MCP, an agent can add alternates with `markie_propose_section_version`. Ask Claude for three rewrites of a paragraph, and they appear as versions to pick from.

**Storage.** Branches and alternates live in the same store as local comments, outside the `.md`. Only the chosen text is in the file.

## 6. Darkmown, rethought

Today Darkmown is a separate `.wd` format with its own syntax, edited in a two-pane source and preview editor.

The new direction: interactivity is added under the hood, in one pane, not edited as a second language. Both file types stay, and each has one job.

**`.md` with enhancements.** The file must still read well in GitHub, VS Code or Obsidian. So the content stays ordinary markdown, and every Markie addition is an invisible HTML comment beside it.

| In the file | In other editors | In Markie |
|---|---|---|
| a table, with `<!-- markie:chart bar -->` above it | the table | a chart, with the table one click away |
| a numbered list, with `<!-- markie:steps -->` | the list | a step-through |
| a list of costs, with `<!-- markie:total -->` | the list | the list with a live total |
| images in a row, with `<!-- markie:gallery -->` | the images | a gallery |

The rule: an enhancement is allowed in `.md` only if the document still makes sense without it.

**`.wd` for documents that are really small apps.** Buttons, state, forms, sliders that drive formulas. These have no honest plain-markdown fallback. When a conversion needs one of them, Markie saves the document as `.wd`. The extension then tells everyone the file needs Markie to work.

**Authoring is the same for both.** You select something and convert it ("Turn into chart", "Step-through", "Calculator"), or insert from a slash menu. An agent can do the same through MCP. Nobody has to write Darkmown syntax by hand, and the two-pane editor becomes an advanced view rather than the default.

**Under the hood:** the existing Darkmown compiler and sandboxed frame run the interactive parts, so the security work carries over.

This needs a design pass before code: which conversions come first, and how a converted block looks in the editor.

## Order

| Phase | What | Agent time |
|---|---|---|
| A | Section rail, local comments with MCP tools, version history panel | about half a day, then one nightly build |
| B | Document tabs | a few hours, next nightly |
| C | Branches and block versions, first design | most of a day, then rounds with you |
| D | Darkmown design doc, then the first interactive blocks | design in an hour, build after you pick |

Each super-nightly build has to be notarized, which takes about 30 to 40 minutes. The other limit is your review between rounds.

## Decisions

Settled with Kirby on 2026-10-30.

1. **Comments, branches and block versions** live in Markie's own data folder, never in or beside the user's files.
   - One folder per document under `userData/doc-meta/`, named the same way as the version history folder.
   - Markie is the only writer. MCP tools go through the agent bridge (`mcp/agent-client.mjs`), which launches Markie if it is closed.
   - Renames and moves done in Markie carry the record along. A file moved outside Markie is matched again by its content, and a match is offered before it is reattached.
2. **Tabs** are one `.md` file with invisible marker comments. That is the same rule as Darkmown enhancements: every Markie addition to a `.md` is an HTML comment, so other editors show clean markdown.
3. **Darkmown** keeps both types. `.md` gets enhancements that degrade to plain markdown, and `.wd` is for documents that are small apps. See section 6.
