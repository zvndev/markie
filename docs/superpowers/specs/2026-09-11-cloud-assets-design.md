# Cloud assets: media that travels with a synced document

Design for the work Kirby asked for on 2026-09-11: when a synced document embeds images, video or audio, those files are hosted with the document, shown only to people who may read the document (in Markie or on the web, including holders of a public link), and a reconciliation pass repairs anything that was told to sync and never landed.

## Where we start

- Sync pushes the markdown text only (`electron/sync.js` `syncOn`/`push`: `PUT /api/docs/:id` with `{ name, content, hash, baseVersion }`). Nothing about a document's media leaves the machine.
- The server has no blob storage, no S3 client and no asset table. Backblaze B2 is used for Litestream and for release artifacts only, through `B2_ENDPOINT`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY`.
- In Markie a relative reference such as `![](shots/a.png)` renders through the `markie-asset://` protocol (`electron/main.js` `registerAssetProtocol`), which serves a local file only when `electron/local-assets.js` says the document may show it (realpath inside the document's folder, a workspace root, or a file dragged in). Extensions are allow-listed there: png, jpg, jpeg, gif, webp, svg, avif, bmp, ico, mp4, m4v, webm, ogv, mov, mp3, m4a, aac, wav, flac, oga, opus.
- On the web (`/d/:id` for members and invitees, `/s/:token` for public links) the same reference is emitted unchanged, so it is a broken image. Access to a document is decided by `resolveViewer` in `server/src/doc-view.ts` and `resolvePublicToken` in `server/src/public-links.ts`.
- The registry (`electron/registry.js`, table `files`) tracks `sync_state` (`local-only`, `unpushed`, `synced`, `conflict`, `paused`), `cloud_doc_id`, `cloud_version`, `content_hash`, `last_synced_at`. `checkUpdates()` runs a `GET /api/docs` listing on mount, on focus, on Library refresh and every 60 s while focused.

## Decisions Kirby made

1. Media follows the document. Whoever may read the text may fetch its media, public-link holders included. Revoking access revokes the media.
2. The reconciliation pass covers both: documents flagged for sync whose cloud copy is missing or stale, and media for documents already synced.
3. Bytes live in a private B2 bucket with the server as the only gate (approach A). Not SQLite blobs, not presigned direct links.

## Decisions made here (say so to change them)

- Caps: 100 MB per file, 500 MB of media per document, 5 GB of media per account. Over the cap the file is skipped, the document still syncs, and the Cloud page says which file was too large.
- Only local references are handled. `http(s):`, `data:` and protocol-relative references are left alone on both sides.
- What travels is what Markie would show, bounded by who can read the document. The allow-list and the containment rules are the local asset protocol's, so a reference Markie refuses to render locally is never uploaded. On top of that sits the exposure rule, because "what this machine may draw" is the wrong question for a document a second party can write text into. A cloud document is **exposed** when the listing marks it `shared`, or when it is mine and the listing marks it `sharedOut` (it has a member, an invite waiting for an address, or a public link); a document the client has been told nothing about is read as exposed. For an exposed document only a reference resolving inside the document's own folder is staged, and every other resolved reference is recorded as `{ ref, reason: "outside" }` and linked with no hash, so the server keeps nothing for it. A private document keeps the repository pattern, where `../assets/logo.png` is the point and there is nobody else to have written it.
- Storage is deduplicated by content hash within one uploader's scope, never across accounts, so no account can learn whether another holds a given file.
- The document text is never rewritten. Markie fetches missing media on demand; the web viewer rewrites `src` at render time only.
- SVG is stored and served, with a response policy that prevents it running scripts when opened directly.

## Architecture

```
Markie (main process)                       Server (Hono)                    B2 (private bucket)
 doc-assets.js   extract refs, hash, cap     assets.ts   tables, routes        <uploader>/<sha256>
 asset-sync.js   missing -> upload -> link   storage.ts  S3 SigV4 client
 sync.js         assets first, then text     doc-view.ts /d/:id/assets
 reconcile.js    launch + periodic repair    public.ts   /s/:token/assets
 main.js         markie-asset:// fallback    render.ts   rehypeCloudAssets
 asset-cache.js  on-disk cache by hash
```

## Server

### Storage (`server/src/storage.ts`)

One interface, two implementations:

```ts
interface AssetStore {
  put(key: string, body: ReadableStream | Buffer, size: number, mime: string): Promise<void>;
  get(key: string, range?: { start: number; end?: number }): Promise<{ stream: ReadableStream; size: number; start: number; end: number; total: number } | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
}
```

- `s3Store(config)`: an in-house SigV4 signer over Node `fetch` (PUT, GET with Range, HEAD, DELETE). About 150 lines, no dependency, tested against the AWS signature known-answer vectors and, behind `ASSETS_LIVE_TEST=1`, against the real bucket. Switching to `@aws-sdk/client-s3` later is a change to this one file.
- `fsStore(dir)`: files under a directory. Used by every server test and by local development. Selected when `ASSETS_DIR` is set.
- Configuration: `ASSETS_BUCKET`, `ASSETS_ENDPOINT`, `ASSETS_KEY_ID`, `ASSETS_APP_KEY` (a key scoped to the assets bucket only; falls back to the `B2_*` names when unset so a single key can serve both during rollout). When neither store is configured every asset route answers `503 { error: "assets not configured" }` and the client treats that as pending, so the server can deploy before the bucket exists.
- Object key: `<uploader_id>/<sha256>`. Reference strings are never used in a key or a path.

### Schema (`server/src/assets.ts`, created on boot like the other tables)

```
assets(owner_id TEXT, hash TEXT, size INTEGER, mime TEXT, created_at TEXT, PRIMARY KEY (owner_id, hash))
doc_assets(doc_id TEXT, ref TEXT, owner_id TEXT, hash TEXT, PRIMARY KEY (doc_id, ref))
```

`owner_id` in both tables is the uploader. `ref` is the reference exactly as written in the markdown, after percent-decoding and nothing else. The per-account usage is `SELECT SUM(size) FROM assets WHERE owner_id = ?`.

### Routes (bearer token, `requireUser`)

| Route | Who | Does |
|---|---|---|
| `POST /api/docs/:id/assets/missing` `{ hashes }` | owner or editor of the doc | Returns `{ missing: [...] }` from the caller's own scope, plus `{ usage, cap }`. |
| `PUT /api/assets/:hash` raw body, `Content-Type`, `Content-Length` | any signed-in user | Streams to a temp file while hashing; refuses a mismatched hash (400), a mime outside the allow-list (415), a file over 100 MB or an account over 5 GB (413 with `{ error, cap }`); then `put`s to storage and inserts the `assets` row. Idempotent for a hash the caller already holds. |
| `PUT /api/docs/:id/assets` `{ refs: [{ ref, hash? }] }` | owner or editor | Replaces the document's full reference set. An entry with a hash must name an asset in the caller's scope. An entry without a hash keeps the existing link for that ref if there is one (an editor pushing text whose images the owner uploaded), otherwise it is dropped. Refuses a set whose total exceeds 500 MB, and one longer than 2000 entries with 413 `{ error: "too many references", cap }`. Refuses the whole body with 400 `{ error: "bad ref" }` when any ref is empty, over 2048 bytes or carries a control character, and, for every caller but the owner of a document nobody else can reach, when any ref leaves the document's folder (a `.` or `..` segment, a leading `/` or `\`, a drive prefix, a UNC form). Returns `{ linked, kept, dropped }`. Rows no longer referenced by any document are removed from `assets` and from storage. |
| `GET /api/docs/:id/assets/file?ref=` | any read level | Streams the bytes with `Range` support, answering the reference with one indexed `doc_assets` row rather than the document's whole map. |
| `GET /d/:id/assets?ref=` (+ optional `k=` token) | `resolveViewer` | Same, for the web viewer. |
| `GET /s/:token/assets?ref=` | `resolvePublicToken` | Same, for public links. |

`/api/*` carries a body limit: 2 MB for JSON, which is every route but two. `PUT /api/assets/:hash` is excluded because its body is the asset, already streamed and counted against the per-file cap, and `PUT /api/docs/:id` is bounded just above the 100 MB at which the desktop refuses to open a document at all, because nothing on the server caps a document's text. Over the limit is 413 `{ error: "body too large" }`, answered before any route or auth check runs.

Every served asset carries `Content-Type` from the row, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Accept-Ranges: bytes`, `Cache-Control: private, max-age=3600`, `ETag: "<hash>"`. An unknown ref, a missing document and a viewer without access all answer 404, the same as the text.

Deleting a document (`docs.ts` delete) removes its `doc_assets` rows and garbage-collects orphaned assets the same way the link route does. Text `PUT` is unchanged.

### Web rendering (`server/src/render.ts`)

`renderMarkdownHTML(markdown, { assetUrlFor?: (ref) => string | null })`. A new `rehypeCloudAssets` plugin runs after `rehypeMedia` and before `rehypeSanitize`: for every `img`, `video`, `audio` and `source`, when `src` has no scheme and `assetUrlFor(src)` returns a URL, the `src` is replaced. Callers pass a function backed by the document's `doc_assets` rows: `/d/:id/assets?ref=<enc>&k=<token>` for the member and invite pages, `/s/:token/assets?ref=<enc>` for the public page. Nothing else in the pipeline changes and the CSP already allows same-origin media.

## Markie

### Extracting references (`electron/doc-assets.js`)

`extractRefs(markdown)` returns the distinct local media references in a document, in order: markdown images `![](src)`, and `src` on `<img>`, `<video>`, `<audio>`, `<source>` in raw HTML. A reference is local when it has no scheme and is not protocol-relative. Both bounds on the read are there to keep it linear: a bare destination is at most 2048 characters, which is what the server would store anyway and what stops the engine backtracking through a document with no closing paren in it, and a document over 4 MB is not read for references at all. `resolveRefs(refs, { docPath, roots, files })` maps each to `{ ref, path, mime }` through `localAssets.resolveMedia` (containment and the allow-list) or to `{ ref, skipped: "outside" | "type" }`. `hashFile(path)` streams SHA-256 and returns `{ hash, size }`. The 100 MB cap is not applied here: the push stats each resolved file before it hashes it, and `stageAssets` records `{ ref, reason: "size" }` for one over the cap (see Pushing below).

### Pushing (`electron/asset-sync.js`)

The push is two halves. `stageAssets(filePath, cloudId, content)`:

1. extract, keeping the first 2000 references in document order and recording the rest as `{ ref, reason: "count" }`, then resolve and hash, dropping every reference outside the document's own folder first when the document is exposed (`isExposed`, from the last listing `sync.js` received; unknown counts as exposed); compute `fingerprint` = SHA-256 of the sorted `ref\thash` lines over the document's whole reference set, a skipped or unresolvable ref contributing an empty hash;
2. if the registry row's `assets_fingerprint` equals it and `assets_state` is `synced`, return `{ unchanged: true }`;
3. `POST missing`; upload each missing hash with `PUT /api/assets/:hash`, one at a time, streaming from disk, up to three attempts each;
4. return `{ staged: { linkRefs, uploaded, skipped, fingerprint } }`, where `linkRefs` is the full set (`{ ref, hash }` for resolved, `{ ref }` for skipped or unresolvable). On any failure write `assets_state = "pending"` and return the error.

`linkAssets(filePath, cloudId, staged, { baseVersion })` then sends `PUT /api/docs/:id/assets` with `staged.linkRefs`, carrying `baseVersion`. A `409 { error: "version mismatch", serverVersion }` means the document moved on since that version: the refs are left unclaimed and the result is `{ pending: true, conflict: true }`. On success it writes `assets_state = "synced"`, `assets_fingerprint`, `assets_skipped` (JSON of skipped refs and reasons) to the row. `pushAssets(filePath, cloudId, content, { baseVersion })` runs the two back to back, which is what reconciliation calls.

`push`, the text-writing branch of `resolve` and both branches of `syncOn` in `sync.js` upload the bytes before the text `PUT` and link the refs only after it, against the version that `PUT` returned. Uploading early is safe because the server keeps an uploaded asset nothing points at for an hour; linking early is not, because a link that lands in front of a text `PUT` that fails leaves the server's old text beside a media set that no longer holds its pictures. A document the server has never seen has nothing to attach media to at all: that one create goes first, and both halves follow it. When the text `PUT` fails no link is sent and the row is left `pending` for reconciliation. A media failure never blocks the text: the text still lands, the row is left `pending`, and reconciliation retries. A 503 "not configured" counts as pending without an error in the UI.

Registry gains three columns through the existing `PRAGMA table_info` + `ALTER` pattern: `assets_state TEXT`, `assets_fingerprint TEXT`, `assets_skipped TEXT`.

### Showing (`electron/main.js`, `electron/asset-cache.js`)

The renderer's `resolveAssetSrc` appends `?doc=<encoded document path>&ref=<encoded reference as written>` to every `markie-asset://` URL (the reference is carried rather than rebuilt, because the uploader stored it exactly as the markdown wrote it; the handler recomputes `ref` as the path relative to the document's folder, falling back to the absolute reference when the file is outside it, only when the URL carries no `ref`). The protocol handler tries the local file first, exactly as today. When the file does not exist or is not allowed, and the document's registry row has a `cloud_doc_id`, it asks `asset-cache.js` for `(cloudId, ref)`:

- cache hit under `<userData>/asset-cache/<hash>` (index `cache.json` maps `cloudId\tref` to hash, mime, size, last used, last validated): revalidated before it is served, because a ref is a name and the same name can be relinked to different bytes. One answer stands for 60 seconds, so seeking through a video is not a conditional request per Range slice. The conditional `GET` carries `If-None-Match: "<hash>"` and has 5 seconds to answer, after which the deadline is re-armed at 300 seconds for whatever body follows, so a big replacement is not held to the answer's budget: a 304 serves the cached copy, new bytes are stored like a miss and replace the index entry (the old file is removed unless another entry shares it), a 404 or 403 drops the entry and the file and serves nothing, and anything else (offline, a 5xx, a replacement that died mid-download) serves the cached copy rather than blanking the picture;
- miss: `GET /api/docs/:id/assets/file?ref=` through `sync.js`'s authenticated `api()` helper, stream to a temp file, move into the cache under the `ETag` hash, then serve.

The cache is capped at 2 GB; when over, the least recently used entries are deleted first. Sign-out clears it. A document pulled to `Documents/Markie/Cloud` therefore shows its images with no files written beside it and no change to its text.

### Reconciliation (`electron/reconcile.js`)

`reconcile({ limit = 50 })` runs after the sync config carries a confirmed principal: once at launch, then whenever `checkUpdates` runs and at least 10 minutes have passed since the last pass. Documents considered are rows with a `cloud_doc_id` and `sync_state` in (`synced`, `unpushed`); `paused`, `conflict` and `local-only` are left alone. Using one `GET /api/docs` listing:

| Case | Action |
|---|---|
| Not in the listing | Skip (deleted or revoked; the Library already shows it paused). |
| File missing on disk | Skip; the row is reported as `missing` to the Cloud page. |
| Server `version` > `cloud_version` | Skip; the existing update flow owns pulls. |
| `sync_state` is `unpushed`, or the disk hash differs from `content_hash` while the server is at `cloud_version` | `push` the text (existing function), which sends media first. |
| Server `hash` differs from `content_hash` at the same version (the server lost or never took the write) | `push` the text. |
| Text current and `assets_state` is not `synced`, or the fingerprint of the current extract differs | `pushAssets`. |

Sequential, 250 ms between documents, at most `limit` documents per pass; the next pass continues with the rest. The result `{ pushed, mediaPushed, skipped, errors }` is sent to the renderer, and the Cloud page shows a per-row "media pending", "file too large: <name>" or "not uploaded: <ref> (outside the document's folder)" note from `assets_state` and `assets_skipped`. No new buttons.

## Security

- The server recomputes the hash while streaming and never trusts the client's. Mime is allow-listed on upload and repeated on every response with `nosniff` and a sandboxing CSP, so a stored file cannot become a script or a page.
- Reads go through the same three gates the text uses; there is no fourth path to an asset. Tokens are compared against the document they were minted for, as `resolveViewer` already does.
- Storage keys are uploader id plus hash; a ref is data, never a path. Deduplication stays inside one account.
- Uploads stream to a temp file and count bytes against the caps before anything reaches storage.
- Markie's local handler is unchanged for local files; the cloud fallback only fires for a document the registry says is in the cloud, only through the signed-in `api()` helper, and only into a cache directory Markie owns.
- A document somebody else can read uploads only the files beside it, on the client and again at the link route. Otherwise a co-editor's text is a list of paths this machine resolves against its own grants and uploads into their document.
- `never-public.test.ts` gains the asset routes.

## Rollout

1. Server first: tables and routes deploy with no bucket configured (503 on asset routes); Kirby creates the private bucket and a key scoped to it and sets the four `ASSETS_*` variables on Railway; the service restarts.
2. App next, in 0.7.0: pushes media on every sync, shows cloud media, runs reconciliation. The first launch after updating backfills every synced document's media through the reconciliation pass.
3. The web viewer starts showing media as soon as both are live; older documents show it after their owner's Markie has run one pass.

## Testing

- Server: `assets.test.ts` (caps, hash mismatch, mime refusal, dedupe, link semantics, orphan collection, 404 parity with text) on `fsStore`; `storage.test.ts` with SigV4 known-answer vectors and a gated live test; `doc-view.test.ts`, `public.test.ts` and `never-public.test.ts` extended for asset routes and the `src` rewrite.
- Electron: `doc-assets.test.ts` (extraction, containment, allow-list, size skip), `asset-sync.test.ts` (fingerprint short-circuit, missing then upload then link, pending on failure, 503 as quiet pending), `asset-cache.test.ts` (hit, miss, eviction, sign-out), `reconcile.test.ts` (each row of the case table with a fake api), `sync.test.ts` (media before text on every write path).
- Window check: `scripts/sync-down-check.mjs` gains a document with a local image and asserts the second account's pulled copy renders it through the fallback, and `scripts/asset-web-check.mjs` fetches `/d/:id/assets` as a member, an invitee and a stranger.

## Not in scope

Presigned direct links, image resizing or transcoding, media inside live collaboration sessions (the Yjs text carries the same references, and they resolve the same way), and a Cloud page storage meter beyond the per-row note.
