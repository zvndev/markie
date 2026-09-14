# Document links: a link to another document follows the reader

Date: 2026-09-13. Builds on the cloud assets design (2026-09-11), which shipped in 0.7.0.

## Where we start

A document can say `[the plan](plan.md)`. On the author's machine that opens the file beside the document (src/lib/local-link.ts, the `open-local-file` handler in electron/main.js). Everywhere else it is dead: a reader who opened the shared copy in Markie has no `plan.md` beside their landed file, the web page at `/d/:id` leaves the relative href as written, and a public page does the same.

The server knows a document by id, owner, name and content. It does not know where the file sits on the author's disk, so it cannot resolve `plan.md` on its own. The author's Markie can: its registry (electron/registry.js, table `files`) maps every tracked path to its cloud document id.

Media already travels by a similar shape: the client extracts references (electron/doc-assets.js), pushes them after the text (electron/asset-sync.js), the server keeps a per document reference table (`doc_assets`) and rewrites the web page through a rehype plugin (server/src/rehype-cloud-assets.ts). This design mirrors that shape with pointers instead of bytes.

## Decisions Kirby made

1. **Pointer only.** A link never causes the target to be synced or shared. It resolves against whatever the target's owner has already chosen.
2. **Quiet refusal.** A reader who cannot read the target sees the link muted, and a click says "This document isn't shared with you." Nothing else is revealed.
3. **Markie and the web.** Links resolve in Markie, on the shared page at `/d/:id`, and on a public page at `/s/:token`. On a public page a link resolves only when the target has a public link of its own; otherwise it is muted.
4. **Land once, then reuse.** In Markie, an allowed link opens the reader's existing copy of the target when the registry knows one. Otherwise it lands a view-only copy once, the way a `markie://doc` link does today, and later clicks open that same file.

## Decisions made here (say so to change them)

- **What counts as a document link.** A local href (no scheme, not `//`, not `#`) whose reference, after the query and fragment are dropped and it is percent decoded, ends in `.md`, `.markdown`, `.mdx` or `.txt`. That is the set Markie opens and lands. Anything else keeps today's behaviour.
- **Resolution happens on the author's machine at push time.** The pushing client turns each document link into a `(ref, targetId)` pair by resolving the ref against the document's folder and looking the path up in its registry. Only refs that resolve to a tracked cloud document are sent. The server stores pairs and decides at read time who may follow each.
- **No access check when a pointer is stored.** A pointer's target is checked against the reader, never against the pusher. Checking existence at store time would let the route confirm which ids exist, which `/d/:id` deliberately does not (its 403 covers both cases).
- **Refs may climb out of the folder.** `../notes/plan.md` is a fine pointer. The asset rule against escaping refs exists because an escaping ref moved the owner's bytes; a pointer moves nothing and the reader's own access gates the target.
- **Cap of 500 links per document**, the first 500 in document order. Same 4 MB extraction ceiling and 2048 byte reference limit as media.
- **The rollout order is server first, then app.** An old app sends nothing new, so an old app against a new server changes nothing. A new app against an old server gets 404 from the link route and keeps the row pending until the server catches up.
- **No new UI for link state.** The registry remembers what was last pushed so the client does not resend an unchanged map. Nothing on the Cloud page reports it.

## Architecture

```
author's Markie                          server                                 reader
--------------                           ------                                 ------
push text  ──PUT /api/docs/:id──────▶   docs
extract links from markdown              
resolve refs via registry                
push pairs ──PUT /api/docs/:id/links─▶  doc_links (doc_id, ref, target_id)
                                         /d/:id  ── rehypeDocLinks ──▶ href=/d/<target> or muted
                                         /s/:tok ── rehypeDocLinks ──▶ href=/s/<target token> or muted
                                         GET /api/docs/:id/links ─────────────▶ Markie marks anchors,
                                            {ref, target?} per reader            opens or lands on click
```

Four new units, each testable alone:

| Unit | Does | Depends on |
|---|---|---|
| `electron/doc-links.js` | extract document links from markdown; resolve refs to cloud ids through the registry; fingerprint the map | registry, fs |
| `electron/link-sync.js` | push the map after a text push and during reconciliation, remembering what landed | sync.api, registry, doc-links |
| `server/src/doc-links.ts` | the `doc_links` table, the two routes, the per reader resolver, the rehype plugin's lookup functions | docs, shares, public-links |
| `electron/doc-link-open.js` | for a rendered document, say what each link is (local, cloud, none, unknown) and open one | registry, sync, local-assets, file-grants |

## Server

### Schema (`server/src/doc-links.ts`, created on boot like the other tables)

```sql
CREATE TABLE IF NOT EXISTS doc_links (
  doc_id    TEXT NOT NULL,
  ref       TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (doc_id, ref)
);
```

`ref` is stored exactly as the asset table stores a reference: the written destination with query and fragment dropped, percent decoded once. `target_id` is another row of `docs`, which may since have been deleted; that is resolved at read time, never enforced at write time.

Deleting a document removes its `doc_links` rows (called from the delete route beside `unlinkDocAssets`). Rows in other documents that point at it stay and resolve to nothing.

### Routes (bearer token, same gates as the asset routes)

`PUT /api/docs/:id/links` body `{ links: [{ ref, target }], baseVersion? }`

- Gate: the caller must be able to edit the document (owner or editor), else 401, 404 (missing or no access, indistinguishable), 403 (viewer). Same as the asset link route.
- `links` not an array: 400. More than 500 entries: 413 with `{ cap: 500 }`, checked before the array is walked. A ref longer than 2048 bytes or carrying a control character: 400. A `target` that does not match `/^[A-Za-z0-9_-]{1,64}$/`: 400. Two entries with the same ref: 400 (the client dedupes, so this is a client bug).
- `baseVersion`, when present, must be a non negative integer, else 400. In one transaction: if the document's version is not `baseVersion`, 409 `{ serverVersion }` and nothing changes; otherwise every existing row for the document is replaced by the body's set.
- Response 200 `{ linked: n }`.

`GET /api/docs/:id/links`

- Gate: the caller must be able to read the document (owner, editor or viewer), else 401 or 404.
- Response 200 `{ links: [{ ref, target? }] }`, one entry per stored row. `target` is present only when the target document exists, is not deleted, and the caller can read it. Every other case, including a target that never existed, is the bare `{ ref }`.

### Web rendering (`server/src/rehype-doc-links.ts`, wired in `server/src/render.ts`)

A plugin shaped like `rehypeCloudAssets`, given a function `linkFor(ref)` that returns one of `{ href }`, `{ muted: true }`, or `null`. It visits `a` elements whose href is local, computes the ref with the same `refOf` as the assets plugin, and:

- `null` (the document has no stored pointer for this ref): leaves the anchor as written.
- `{ href }`: replaces the href.
- `{ muted: true }`: removes the href, adds class `doc-link-muted` and `title="This document isn't shared with you"`. The page styles draw it in the muted colour with a dotted underline and a not-allowed cursor.

The plugin runs before sanitize, which already lets `className` and `title` through on every element.

`/d/:id` builds `linkFor` from the document's rows and the viewer: a stored target the viewer can read becomes `/d/<target>`, anything else is muted. For that, `resolveViewer` learns the viewer's user id when it has one (a member token maps to a user, a session has one, a pending invite has none). A viewer with no user id sees every stored link muted, because the target page could not be opened with the credential they hold anyway.

`/s/:token` builds `linkFor` from the rows and `getPublicLinkToken(target)`: a target with a public link becomes `/s/<its token>`, anything else is muted.

## Markie

### Extracting and resolving (`electron/doc-links.js`)

`extractLinks(markdown)` returns the document's link refs in written order, deduplicated, at most 500. Sources, after the same fence and inline code strip as media:

- inline links `[text](dest)` and `[text](<dest with spaces>)`, not preceded by `!`;
- reference definitions `[label]: dest` at line start;
- HTML `<a href="...">`.

A destination is kept when it is local, its ref is well formed (the asset rules), and the ref ends in a document extension.

`resolveLinks(refs, { docPath, registry })` returns `{ links: [{ ref, target }], fingerprint }`. Each ref is resolved against the document's folder, taken through `realpath` when the file exists, and looked up in the registry. A row with a `cloud_doc_id` yields a pair; anything else yields nothing. The fingerprint is a sha256 over the sorted pairs, so it changes when the document's links change and when a linked file becomes synced later.

### Pushing (`electron/link-sync.js`)

`pushLinks(filePath, cloudId, content, { baseVersion })`:

1. Extract and resolve. If the registry row already says `links_state = synced` at this fingerprint, answer `{ unchanged: true }` and send nothing.
2. `PUT /api/docs/:cloudId/links` with the pairs and `baseVersion`.
3. 200: write `links_state = synced`, `links_fingerprint`. Answer `{ ok: true, linked }`.
4. 409: leave the row `pending`; answer `{ conflict: true }`. Reconciliation retries.
5. 400 or 413: settle the row at this fingerprint with `links_state = refused` so the same body is not resent until the links change. Answer `{ refused: status }`.
6. Anything else (network failure, 401, 403, 404, 429, 5xx): `links_state = pending`, answer `{ error }`.

Two new registry columns on `files`: `links_state` (`synced`, `pending` or `refused`) and `links_fingerprint`, added like the `assets_*` columns.

`sync.push` calls `pushLinks` after a successful text PUT and after the media link, with the version the PUT returned, and reports the result under `links` in its return value. A viewer copy never gets here: the existing refusal comes first.

### Reconciliation (`electron/reconcile.js`)

After the media step for a row whose text is current, call `pushLinks` with the listing's version. Count `linksPushed`, `linksUnchanged`, and errors in the pass result. A row whose text needed a push is done already, because `sync.push` pushed its links. Viewer rows are skipped before either step, as today.

### Showing and opening (`electron/doc-link-open.js`, `electron/main.js`, `src/lib/doc-links.ts`, `src/lib/local-link.ts`)

`resolve(docPath, hrefs)` answers one of four kinds per href:

- `unknown`: not a document link, or nothing to say. Today's behaviour applies.
- `local`: the file exists on disk at the ref's place beside the document. Opened through the existing local file path.
- `cloud`: the document is a cloud document and the server's link list carries a target the reader may read. Carries the target id.
- `none`: the document is a cloud document and the server's list has this ref without a target.

Order of checks: document extension, then disk, then the registry row's `cloud_doc_id`, then `GET /api/docs/:id/links` (one fetch per document id, remembered for sixty seconds). Not signed in, offline, or a failed fetch all answer `unknown`.

`open(docPath, href)`, for a `cloud` answer: a live registry row with that `cloud_doc_id` whose file exists is opened directly. Otherwise the document is landed once into Downloads under its own name, exactly as `openCloudDocFromDeepLink` does today (that landing is factored into a function both share), and opened. A failed landing answers "Couldn't open that document. Check your connection, or ask for it to be shared again."

Two IPC handlers, `resolve-doc-links` and `open-doc-link`, exposed by the preload as `resolveDocLinks` and `openDocLink`.

In the renderer, after the rich view renders a document, `markDocLinks` gathers the anchors whose href is a document link, asks main once, and sets `data-doc-link` on each anchor (`none` links also get the title text). The stylesheet mutes `a[data-doc-link="none"]` the same way the web page does. The existing click handler branches on that attribute: `none` shows the notice through the existing link error toast; `cloud` calls `openDocLink`; everything else goes through `openLocalFile` as today. A modified click is still left to the OS.

## Security

- **Nothing moves but a pointer.** No bytes are uploaded and no document is shared by linking. The reader's own access to the target, checked by the same `accessLevel` and public link lookups every other route uses, decides what a link does.
- **No enumeration.** The store route never confirms whether a target exists. The read route answers 404 for a document the caller cannot read, the same as for one that does not exist. A stored target is disclosed only to a caller who can read it; everyone else gets the bare ref, which the document's own text already shows.
- **A hostile editor gains nothing.** An editor can plant a pointer at any id, but a reader who follows it must already be able to read the target, so the link opens only what they could open by hand.
- **Bounded input.** 500 entries, 2048 byte refs, no control characters, ids by shape, and the existing 2 MB body limit on the API.
- **The renderer never sees a path it did not have.** `resolve` answers kinds and the target id; opening goes through the same grants as every other file Markie opens.

## Rollout

1. Server: table created on boot, routes mounted at `/api` beside the asset routes, rendering wired. Nothing is served differently until a client stores pointers.
2. App: the next release. On first launch every synced document is visited by reconciliation, which now pushes its link map, so existing documents gain their links within the ten minute cycle without a text change.

## Testing

- Server (`node:test`): the store route's every refusal and the 409; replace semantics; the read route's disclosure rule for owner, editor, viewer, stranger, deleted target, unknown target; `/d/:id` rewriting for a signed in member and muting for a pending invite; `/s/:token` resolving a public target and muting a private one; deletion removing rows.
- Electron (vitest): extraction across the three syntaxes, fences, images excluded, extension rule, cap and dedupe; resolution through a fake registry with realpath; fingerprint stability; `pushLinks` per status; reconciliation counting; `resolve` kinds in order and the sixty second memo; `open` reusing a live row, landing once, and reporting a failed landing.
- Renderer (vitest, jsdom): `markDocLinks` attribute setting; click branches for `none`, `cloud`, and the untouched local path.
- Window check: a script modelled on `scripts/asset-web-check.mjs` that pushes two documents, links one to the other, shares only the first with a second account, and asserts the web page's href for the owner and the muted anchor for the member, then adds a public link to the target and asserts the public page resolves. Runs with `MARKIE_ALLOW_E2E=1`, never alongside vitest.

## Not in scope

- Links to non document files (a PDF beside the document) on the web or on another machine. They keep working locally as today.
- Backlinks, a "linked from" list, or any link index UI.
- Editing a landed target. It lands view only; "Make a copy" already covers the rest.
- Resolving links in the collaborative editor's live view. The rich view is where reading happens.
- Rewriting the markdown on disk. Every link stays exactly as the author wrote it.
