# Share role enforcement

**Status:** approved, ready to implement
**Scope:** subsystem A of three. B (sync-down and conflict resolution) and C (live
collaboration polish) get their own specs after this ships.

## Problem

Markie has two share roles, `viewer` and `editor`, and the data model has carried
them since sharing shipped. What it has never had is enforcement that matches the
words. Before this work:

- A viewer's socket could write into the shared document, because `canEdit` was
  computed once at upgrade and never re-read. Fixed server-side in `0f49c28`.
- The Markdown Source pane is `readOnly={!!collabCfg}`, so it locks for
  **everyone** in a live session, including the people who are allowed to edit.
  The role is not consulted at all.
- A viewer with the document synced locally can type into it. Nothing stops the
  edit, and nothing tells them it will never reach the owner.
- Nothing on screen says "you are a viewer".

The goal is that "read-only" means read-only everywhere, and that "editor" means
you can actually edit, in either pane.

## Model

Role is read from the server and never trusted from the client. The renderer's
copy exists only so the UI can avoid lying about what the server will accept.

| | Viewer | Editor |
|---|---|---|
| Yjs room | joins, receives updates, writes dropped | full read and write |
| Presence and cursors | sees others, broadcasts own | same |
| Rich pane | read-only | editable |
| Source pane | read-only | **editable** (new) |
| Escape hatch | Make a copy | not needed |

A viewer is never allowed to edit the shared document, in any pane, live or not.
Their route to editing is forking: `Make a copy` writes a new local file, tracked
`local-only` with no `cloud_doc_id`, which never syncs back.

There is therefore no "viewer with local changes" state. Typing is blocked before
it can create one.

## Components

### 1. Role resolution (`src/lib/share-role.ts`, new)

A pure module, tested in isolation, that answers three questions from the share
list and the current user:

```ts
export type ShareRole = "owner" | "editor" | "viewer";

export function roleFor(members, myUserId, ownerId): ShareRole
export function canEditDoc(role: ShareRole): boolean      // owner | editor
export function isReadOnlyShare(role: ShareRole): boolean // viewer
```

Extracting it keeps the rule in one place rather than repeating
`mine?.role === "viewer"` at each call site, which is how the Source pane came to
disagree with the Rich pane in the first place.

### 2. Role reaches both editors

`CollabConfig.readonly` already exists and already drives the rich editor's
`editable`. Two changes:

- `page.tsx` stops passing `readOnly={!!collabCfg}` to the source editor and
  passes the role-derived value instead, so editors can type in Source during a
  live session and viewers cannot type anywhere.
- The value is derived from `roleFor(...)` rather than computed inline.

### 3. Source pane during a live session: live, read-only

**Decided against `y-codemirror.next`.** TipTap's `Collaboration` binds
`ydoc.getXmlFragment("default")` (`extension-collaboration/dist/index.js:146`);
`y-codemirror.next` binds a `Y.Text`. A single Yjs document can hold both, but
they are independent CRDTs that never share state, so keeping the panes in step
would mean serializing XmlFragment to markdown to Y.Text and back on every
keystroke. That is exactly the lossy round trip that destroyed front matter, raw
HTML, footnotes and math, fixed in `3c439f7`, and running it continuously across
users would be strictly worse than the bug that was fixed.

So the rich pane owns the shared document. While a live session is active the
Source pane is a **live read-only mirror**: it keeps updating as other people
type, and it carries a banner saying `Live session. Edit in Rich.` Outside a live
session all three modes are fully editable as today.

This is close to the current behaviour, but the current behaviour is right for
the wrong reason (`readOnly={!!collabCfg}` ignores the role entirely). The role
still has to drive the rich pane, which is where the actual gap is.

### 3b. Superseded: Source pane joins the shared document (`y-codemirror.next`)

Making Source editable during a live session means its edits have to reach the
same Yjs document, or the two panes diverge and last-writer-wins silently
destroys work. This is the one genuinely new piece of plumbing.

- Add `y-codemirror.next` as a devDependency (renderer packages are bundled into
  `out/` by `next build`; only main-process runtime modules belong in
  `dependencies`, per `313041c`).
- In `editor.tsx`, when a collab session is present, install `yCollab(ytext,
  awareness)` and drop the local `onChange` path, exactly as the rich view drops
  local history in favour of the shared one.
- Both panes bind to the **same** `Y.Text`, so Split shows one document twice
  rather than two documents that agree by luck.

**Risk, stated plainly:** the rich view uses TipTap's `Collaboration` extension,
which maps a ProseMirror document onto a `Y.XmlFragment`. CodeMirror needs a flat
`Y.Text`. These are different representations of the same document, and binding
both to one Yjs document is not a matter of pointing them at the same handle.
Resolving this is the main implementation risk and the plan must address it
before any UI work. If it cannot be resolved cleanly, the fallback is the "Source
is a read-only view while live, labelled honestly" option, and that decision
comes back to Kirby rather than being made quietly.

### 4. The viewer banner (`src/components/share-banner.tsx`, new)

A single strip above the document, shown whenever the role is `viewer`:

```
👁  Shared with you by Kirby · view only            [ Make a copy ]
```

Not a modal, not dismissible, no icon-only mystery. It is the only thing on
screen that explains why typing does nothing, so it must always be visible when
the state is active.

### 5. Fork (`Make a copy`)

Writes `<name> (copy).md` next to the original, or into the workspace when the
original is cloud-only, tracks it `local-only`, opens it, and leaves the shared
document untouched. Reuses the existing `handleFork` path rather than adding a
second copy mechanism.

### 6. Sync refuses viewer pushes

`electron/sync.js` `push()` and `syncOn()` return early for a doc whose role is
`viewer`, instead of sending a request the server will refuse with 403. The
server check stays: this is about not lying to the user, not about security.

## Data flow

```
server share list ──► roleFor() ──┬──► CollabConfig.readonly ──► rich editable
                                  ├──► source editable
                                  ├──► ShareBanner visible
                                  └──► sync push allowed
```

One resolution, four consumers. Today each consumer decides for itself, which is
the bug.

## Error handling

- **Share list fails to load.** Fail closed: treat the role as `viewer` and show
  the banner with "Checking your access…". Never fail open into an editable state
  the server will reject.
- **Role changes while the document is open.** The server already hangs up the
  socket on revocation (`0f49c28`). The renderer must stop reconnecting on a 4403
  close, re-resolve the role, and drop to read-only rather than retrying 401s in
  a loop. This is the client-side follow-up the collab agent deliberately left.
- **Fork fails** (read-only volume, name collision). Surface the error rather
  than silently doing nothing. There is no toast primitive yet, so for now this
  reuses the existing notice channel.

## Testing

Unit, in `src/lib/share-role.test.ts`:
- owner, editor, viewer resolution from a member list
- missing member entry resolves to viewer, not editor (fail closed)
- empty or failed member list resolves to viewer

Integration, driving the packaged app with the Playwright `_electron` driver:
- a viewer cannot type in Rich, Source, or Split
- an editor can type in Source during a live session and the change reaches the
  shared document
- the banner appears for a viewer and not for an editor
- `Make a copy` produces an editable local file, and the original is unchanged

Server-side enforcement is already covered by `server/src/collab-access.test.ts`
(54 tests) and is not re-tested here.

## Out of scope

- Sync-down notification and conflict resolution (subsystem B)
- Live cursor polish, presence avatars, "sync often" cadence (subsystem C)
- Comment permissions
- Changing someone's role from inside the document
