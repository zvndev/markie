# Sync-down notification and conflict resolution

**Status:** approved, ready to implement
**Scope:** subsystem B of three. A (share role enforcement) shipped in `f73d88f`.
C (live collaboration polish) gets its own spec.

## Problem

Markie already knows when the server has a newer snapshot. `libraryState()`
computes `state = "behind"` whenever `remote.version > local.cloud_version`.
Three things are wrong with what it does next.

**The open document never says anything.** `behind` is only rendered as a row in
the Library, and only when the Library happens to refresh. Someone editing a
document their other machine already changed gets no signal at all. They keep
typing, save, and the push comes back 409.

**Nothing checks on its own.** `libraryState()` runs when the Library mounts or
its refresh key changes. A document can sit open for an hour with a newer copy
on the server and nothing will look.

**The choices are unlabelled and one of them is missing.** The Library offers
`Pull latest`, `Keep local`, `Take cloud`. None of them says what is about to
happen. `Take cloud` silently destroys every local line the server never
received. And the option people actually want is not there: keep both, mine
under a different name.

## Model

Two distinct situations, which the current UI conflates:

| | Server is ahead | Server is ahead **and** I have local changes |
|---|---|---|
| Registry | `behind` | `behind` with a dirty buffer, or `conflict`, or `unpushed` |
| What to do | just pull, nothing is at risk | ask, because something will be lost |
| Surface | one-line strip, one button | dialog with counts and three ways out |

The first case must not be a dialog. Interrupting someone to confirm an
update that cannot lose anything is how people learn to dismiss dialogs without
reading them.

## Line counts

The user asked to be told how many lines changed. Markie stores
`content_hash` but never the last-synced content, so there is no base to
three-way diff against, and adding one means storing a second copy of every
synced document.

Instead, diff **local against remote directly** and report the two numbers that
drive the decision:

```
Pulling replaces 8 of your lines and brings in 12 from the server.
```

`8` is what you lose, `12` is what you gain. That is exactly the information the
choice needs, and it needs no base and no new storage. It deliberately does not
claim authorship of any line, because without a base it cannot know.

### `src/lib/line-diff.ts` (new)

```ts
export interface LineDiff {
  added: number;    // lines in remote that are not in local
  removed: number;  // lines in local that are not in remote
  same: number;
}
export function lineDiff(local: string, remote: string): LineDiff
export function describeDiff(d: LineDiff): string
```

A standard LCS over lines, dependency-free, with a size guard: past
`MAX_DIFF_LINES` (5000) the quadratic table is not worth building, so it falls
back to a multiset count of differing lines. The fallback is a slightly looser
number, never a wrong-direction one, and the wording stays honest either way.

Identical content returns all zeros, which is how the caller knows a `behind`
flag was stale and no prompt is needed.

## Detection

### `sync.checkUpdates()` (new, `electron/sync.js`)

One `GET /api/docs` returns every doc's version, so a single request covers all
tracked files. It reuses the same call `libraryState()` already makes and
returns just the rows whose remote version leads the local one:

```js
// [{ path, cloudId, name, localVersion, remoteVersion }]
```

No document content is fetched here. Content is only pulled when the user opens
the prompt, so a poll costs one small request regardless of library size.

### When it runs

- on file open
- on window focus (the common case: you edited elsewhere and came back)
- after a successful push (the server may have moved on)
- every 60s while signed in and the window is focused

A poll while the window is hidden buys nothing, because the answer is only ever
acted on by someone looking at the screen. `setInterval` is cleared on blur and
restarted on focus so a backgrounded Markie makes no network requests at all.

## Surfaces

### 1. Update strip (clean case)

Reuses the banner slot subsystem A put above the document, so there is one place
that explains the document's state rather than two competing strips.

```
↓  Updated on the server.                              [ Update ]
```

Shown when the open document is `behind` and the buffer is clean. `Update`
pulls, replaces the buffer, and the strip disappears. No dialog, because nothing
can be lost.

### 2. Conflict dialog (`src/components/conflict-dialog.tsx`, new)

Shown when the open document is behind **and** the buffer is dirty, or the
registry state is `conflict` or `unpushed`. Opened from the strip's button
(`Review changes…`), from the Library rows, and from a failed push.

```
Both copies changed

  Pulling replaces 8 of your lines and brings in 12 from the server.

  [ Keep both ]   [ Pull and overwrite ]   [ Cancel ]

  Keep both saves your version as "notes (my version).md" and
  then pulls the server copy into notes.md.
```

`Keep both` is first and is the default focus. It is the only option that cannot
lose work, so it is the one a person hitting Return in a hurry should get.

### 3. Library rows

The existing `Pull latest` / `Keep local` / `Take cloud` buttons collapse to a
single `Review changes…` that opens the same dialog. Three unlabelled buttons
that quietly destroy data are worse than one that explains itself.

## Resolution

### `sync.resolveKeepBoth(filePath)` (new)

1. Read the local file.
2. Fetch the server copy. If that fails, stop and report; nothing has been
   touched yet.
3. Write the local content to `<name> (my version).md` beside the original,
   with a numeric suffix on collision. Track it `local-only` with no
   `cloud_doc_id`, so it never syncs back and never becomes a second window on
   the same cloud document.
4. Only once that file exists on disk, overwrite the original with the server
   copy and mark it `synced` at the server's version.

The order is the whole point: the local copy is durable before anything
overwrites it. A failure at step 2 or 3 leaves the original untouched.

`resolve(filePath, "cloud")` keeps its existing refusal for `unpushed` rows and
is what `Pull and overwrite` calls. `resolve(filePath, "local")` stays for the
Library's force-push path.

## Error handling

- **Poll fails.** Silent. It is a background check; a failed one means the
  strip does not appear, which is the same as the state before the check. It
  must never surface an error over a document.
- **Pull fails during `Update`.** The strip shows the failure in place and keeps
  its button so it can be retried. The buffer is not touched.
- **`Keep both` fails to write the copy.** Reported in the dialog, and the
  original is left exactly as it was. Verified by test, not by inspection.
- **Document is deleted on the server mid-check.** `checkUpdates` only reports
  rows present in the list, so a deleted doc produces no update prompt.
  `libraryState` continues to handle it as `paused`.

## Testing

Unit (`src/lib/line-diff.test.ts`):
- identical content is all zeros
- pure insertion counts added only, pure deletion counts removed only
- a replaced line counts as one added and one removed
- empty local, empty remote, trailing-newline differences
- past the size guard the fallback still returns a sane non-negative count

Unit (`electron/sync.test.ts`, extending the existing 33):
- `checkUpdates` reports only rows whose remote version leads
- `checkUpdates` ignores local-only rows and rows absent from the list
- a failed list request reports nothing rather than reporting everything
- `resolveKeepBoth` writes the copy before overwriting the original
- `resolveKeepBoth` leaves the original untouched when the fetch fails
- `resolveKeepBoth` leaves the original untouched when the copy cannot be written
- the copy is tracked `local-only` with no `cloud_doc_id`
- a name collision gets a numeric suffix rather than overwriting

## Out of scope

- Live cursors, presence, and sync cadence during a session (subsystem C)
- Three-way merge or per-hunk resolution. The user asked for keep-mine-separately
  or pull-and-overwrite; a merge UI is a different product.
- Storing base content to enable a true three-way diff.
