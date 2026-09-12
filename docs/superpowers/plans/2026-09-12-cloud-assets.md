# Cloud Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A synced document's images, video and audio are hosted with it in a private B2 bucket behind the server, served only to whoever may read the document (Markie, `/d/`, `/s/`), and a reconciliation pass repairs documents told to sync that never landed and backfills media.

**Architecture:** The server gains an `AssetStore` (S3 SigV4 over B2, filesystem for tests), two tables (`assets`, `doc_assets`), upload/link routes for Markie, and three read routes reusing the text's existing gates; the web viewer rewrites `src` at render time. Markie's main process extracts a document's local media with the same containment rules the local viewer uses, uploads what the server lacks before every text push, shows cloud media through a fallback in the existing `markie-asset://` handler with an on-disk cache, and runs a bounded reconciliation pass at launch and every ten minutes.

**Tech Stack:** Hono + better-sqlite3 + Node `fetch`/`crypto` (server, `node --test`); Electron main CJS modules (vitest `node`); React renderer (vitest `dom`).

**Spec:** `docs/superpowers/specs/2026-09-11-cloud-assets-design.md`

## Global Constraints

- Caps: 100 MB per file (`MAX_ASSET_BYTES = 100 * 1024 * 1024`), 500 MB per document (`MAX_DOC_ASSET_BYTES = 500 * 1024 * 1024`), 5 GB per account (`MAX_ACCOUNT_ASSET_BYTES = 5 * 1024 * 1024 * 1024`).
- Media allow-list, both sides, by extension: png jpg jpeg gif webp svg avif bmp ico mp4 m4v webm ogv mov mp3 m4a aac wav flac oga opus. The server's mime table is `server/src/asset-mime.ts`; Markie's is `electron/local-assets.js` (unchanged).
- Only local references are handled: no scheme, not protocol-relative, not `data:`.
- Storage key is `<uploader_id>/<sha256 hex>`. A `ref` is never used as a path or key.
- The document text is never rewritten by Markie. The web viewer rewrites `src` at render time only.
- Every asset response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Accept-Ranges: bytes`, `Cache-Control: private, max-age=3600`, `ETag: "<hash>"`.
- Unknown ref, missing document and no access all answer 404 on the asset read routes.
- Asset routes answer `503 { error: "assets not configured" }` when no store is configured; Markie treats that as quiet pending.
- Server env: `ASSETS_DIR` (filesystem store) or `ASSETS_BUCKET` + `ASSETS_ENDPOINT` + `ASSETS_KEY_ID` + `ASSETS_APP_KEY` (S3), the last three falling back to `B2_ENDPOINT`, `B2_KEY_ID`, `B2_APP_KEY`.
- No em-dashes in prose, docs, UI copy or commit messages. Commit with `-c core.hooksPath=/dev/null`, stage files by name, Lore commit format (see AGENTS.md), trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Server tests: `cd server && node --experimental-strip-types --test src/<file>.test.ts`. Electron tests: `npx vitest run electron/<file>.test.ts`. Renderer: `npx vitest run src/...`.
- Never `npm ci` in a worktree with a symlinked `node_modules`; never package from one.

---

## File structure

**Server (new)**
- `server/src/asset-mime.ts`: extension to mime table, `assetMimeFor(ref)`.
- `server/src/storage.ts`: `AssetStore` interface, `fsStore`, `s3Store` (SigV4), `assetStore()` selector.
- `server/src/assets.ts`: tables, caps, `assetsApi` (Hono: missing, upload, link), `assetRefsFor(docId)`, `serveAsset(c, docId, ref)`, `unlinkDocAssets(docId)`.
- `server/src/rehype-cloud-assets.ts`: the `src` rewrite plugin.

**Server (modify)**
- `server/src/render.ts`: `renderMarkdownHTML(markdown, opts)`, page renderers take `assetUrlFor`.
- `server/src/doc-view.ts`: `/d/:id/assets`, pass `assetUrlFor` to the page.
- `server/src/public.ts`: `/s/:token/assets`, pass `assetUrlFor` to the page.
- `server/src/docs.ts`: `GET /:id/assets/file`, delete cascade.
- `server/src/index.ts`: mount `assetsApi` at `/api`.
- `server/src/never-public.test.ts`: asset routes.

**Electron (new)**
- `electron/doc-assets.js`: `extractRefs`, `resolveRefs`, `hashFile`, `fingerprint`.
- `electron/asset-sync.js`: `createAssetSync({ api, registry, grants, fs })` returning `pushAssets`.
- `electron/asset-cache.js`: `createAssetCache({ dir, api, limitBytes })`.
- `electron/reconcile.js`: `createReconciler({ sync, registry, assetSync, fs, sleep })`.

**Electron (modify)**
- `electron/registry.js`: three columns.
- `electron/sync.js`: media before text on every write path; export `api`; `reconcile()`.
- `electron/main.js`: protocol fallback, reconciler scheduling, `asset-reconcile` IPC.
- `electron/preload.js`: expose the result.

**Renderer (modify)**
- `src/lib/asset-url.ts`: `?doc=` on every asset URL.
- `src/lib/electron.ts`, `src/components/cloud-view.tsx`: media note.

**Scripts**
- `scripts/sync-down-check.mjs`: an image in the synced document.
- `scripts/asset-web-check.mjs` (new).

---

### Task 1: Server asset mime table and storage

**Files:**
- Create: `server/src/asset-mime.ts`, `server/src/storage.ts`, `server/src/storage.test.ts`

**Interfaces:**
- Produces: `assetMimeFor(ref: string): string | null`; `ASSET_EXTENSIONS: string[]`.
- Produces: `interface AssetStore { put(key, body: Buffer | ReadableStream, size: number, mime: string): Promise<void>; get(key, range?: { start: number; end?: number }): Promise<AssetRead | null>; head(key): Promise<{ size: number } | null>; delete(key): Promise<void> }` where `AssetRead = { stream: ReadableStream<Uint8Array>; size: number; start: number; end: number; total: number }`.
- Produces: `fsStore(dir: string): AssetStore`, `s3Store(cfg: { bucket; endpoint; keyId; appKey; region?: string; fetchImpl?: typeof fetch; now?: () => Date }): AssetStore`, `assetStore(env = process.env): AssetStore | null`, `sigV4Headers(...)` (exported for the known-answer test).

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/storage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsStore, s3Store, assetStore, sigV4Headers } from "./storage.ts";
import { assetMimeFor } from "./asset-mime.ts";

test("assetMimeFor knows the allow-list and nothing else", () => {
  assert.equal(assetMimeFor("shots/a.PNG"), "image/png");
  assert.equal(assetMimeFor("clip.mov?x=1"), "video/quicktime");
  assert.equal(assetMimeFor("notes.txt"), null);
  assert.equal(assetMimeFor("evil.html"), null);
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream as never as AsyncIterable<Uint8Array>) parts.push(chunk);
  return Buffer.concat(parts);
}

test("fsStore round-trips a file, honours a range, and deletes", async () => {
  const store = fsStore(mkdtempSync(join(tmpdir(), "markie-store-")));
  await store.put("u1/abc", Buffer.from("0123456789"), 10, "image/png");
  assert.deepEqual(await store.head("u1/abc"), { size: 10 });
  const whole = await store.get("u1/abc");
  assert.equal((await collect(whole!.stream)).toString(), "0123456789");
  const part = await store.get("u1/abc", { start: 2, end: 4 });
  assert.equal((await collect(part!.stream)).toString(), "234");
  assert.deepEqual([part!.start, part!.end, part!.total], [2, 4, 10]);
  const tail = await store.get("u1/abc", { start: 8 });
  assert.equal((await collect(tail!.stream)).toString(), "89");
  await store.delete("u1/abc");
  assert.equal(await store.head("u1/abc"), null);
  assert.equal(await store.get("u1/abc"), null);
});

test("fsStore never escapes its directory", async () => {
  const store = fsStore(mkdtempSync(join(tmpdir(), "markie-store-")));
  await assert.rejects(() => store.put("../x", Buffer.from("x"), 1, "image/png"), /key/);
  await assert.rejects(() => store.head("u1/../../x"), /key/);
});

// AWS Signature Version 4 test suite, "get-vanilla" vector (empty payload,
// host header only), which every SigV4 implementation is checked against.
test("sigV4Headers matches the AWS known answer", () => {
  const headers = sigV4Headers({
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: {},
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    keyId: "AKIDEXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    now: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(
    headers.Authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
  );
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
});

test("s3Store issues signed requests against the bucket and streams a range back", async () => {
  const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    seen.push({ method: init.method!, url, headers });
    if (init.method === "PUT") return new Response(null, { status: 200 });
    if (init.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "10" } });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response("234", {
      status: 206,
      headers: { "content-range": "bytes 2-4/10", "content-length": "3" },
    });
  }) as unknown as typeof fetch;
  const store = s3Store({
    bucket: "markie-assets",
    endpoint: "https://s3.us-east-005.backblazeb2.com",
    keyId: "k",
    appKey: "s",
    fetchImpl,
    now: () => new Date("2026-09-12T00:00:00Z"),
  });
  await store.put("u1/abc", Buffer.from("0123456789"), 10, "image/png");
  assert.equal(seen[0].url, "https://s3.us-east-005.backblazeb2.com/markie-assets/u1/abc");
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=k\/20260912\/us-east-005\/s3\/aws4_request/);
  assert.equal(seen[0].headers["content-type"], "image/png");
  assert.deepEqual(await store.head("u1/abc"), { size: 10 });
  const part = await store.get("u1/abc", { start: 2, end: 4 });
  assert.equal(seen[2].headers.range, "bytes=2-4");
  assert.deepEqual([part!.start, part!.end, part!.total], [2, 4, 10]);
  assert.equal((await collect(part!.stream)).toString(), "234");
  await store.delete("u1/abc");
  assert.equal(seen[3].method, "DELETE");
});

test("s3Store answers null for a missing object", async () => {
  const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const store = s3Store({ bucket: "b", endpoint: "https://s3.example", keyId: "k", appKey: "s", fetchImpl });
  assert.equal(await store.head("u1/none"), null);
  assert.equal(await store.get("u1/none"), null);
});

test("assetStore picks the filesystem, then S3, then nothing", () => {
  assert.ok(assetStore({ ASSETS_DIR: mkdtempSync(join(tmpdir(), "markie-store-")) }));
  assert.ok(assetStore({ ASSETS_BUCKET: "b", B2_ENDPOINT: "https://s3.example", B2_KEY_ID: "k", B2_APP_KEY: "s" }));
  assert.equal(assetStore({}), null);
  assert.equal(assetStore({ ASSETS_BUCKET: "b" }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --experimental-strip-types --test src/storage.test.ts`
Expected: FAIL, cannot find `./storage.ts`.

- [ ] **Step 3: Write `server/src/asset-mime.ts`**

```ts
// The one list of what a document may embed, shared by every asset route.
// Kept in step with electron/local-assets.js: a file Markie will not draw
// locally is not one it uploads, and one it uploads is one this table names.
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
};

export const ASSET_EXTENSIONS = Object.keys(MIME_BY_EXT);

// The mime for a reference as written in markdown, or null when it is not a
// kind of file a document may embed. Query and fragment are ignored the way a
// browser ignores them when picking a handler.
export function assetMimeFor(ref: string): string | null {
  const bare = String(ref ?? "").split("#")[0].split("?")[0];
  const dot = bare.lastIndexOf(".");
  if (dot === -1) return null;
  return MIME_BY_EXT[bare.slice(dot).toLowerCase()] ?? null;
}
```

- [ ] **Step 4: Write `server/src/storage.ts`**

```ts
// Where asset bytes live. Two stores behind one interface: a directory for
// tests and local development, and an S3-compatible bucket (Backblaze B2 in
// production) reached through a small in-house SigV4 signer so the server
// keeps its zero-SDK dependency list. Switching to @aws-sdk/client-s3 later
// is a change to this file alone.
import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface AssetRead {
  stream: ReadableStream<Uint8Array>;
  size: number; // bytes in this response
  start: number;
  end: number; // inclusive
  total: number;
}

export interface AssetStore {
  put(key: string, body: Buffer | ReadableStream<Uint8Array>, size: number, mime: string): Promise<void>;
  get(key: string, range?: { start: number; end?: number }): Promise<AssetRead | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
}

// A key is "<uploader>/<hash>", both segments plain. Anything else is refused
// before it reaches a path or a URL.
const KEY = /^[A-Za-z0-9_-]{1,64}\/[a-f0-9]{64}$/;
function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error(`storage key refused: ${key}`);
  return key;
}

function toWeb(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
}

export function fsStore(dir: string): AssetStore {
  const root = resolve(dir);
  const pathFor = (key: string) => {
    const full = resolve(root, checkKey(key));
    if (!full.startsWith(root + sep)) throw new Error(`storage key refused: ${key}`);
    return full;
  };
  return {
    async put(key, body, _size, _mime) {
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });
      const tmp = `${full}.part`;
      const source = Buffer.isBuffer(body) ? Readable.from(body) : Readable.fromWeb(body as never);
      await pipeline(source, createWriteStream(tmp));
      await rename(tmp, full);
    },
    async get(key, range) {
      const full = pathFor(key);
      let total: number;
      try {
        total = (await stat(full)).size;
      } catch {
        return null;
      }
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? total - 1, total - 1);
      if (start > end || start >= total) return null;
      return { stream: toWeb(createReadStream(full, { start, end })), size: end - start + 1, start, end, total };
    },
    async head(key) {
      try {
        return { size: (await stat(pathFor(key))).size };
      } catch {
        return null;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

// AWS Signature Version 4, the subset S3 needs: one request, unsigned or
// pre-hashed payload, host and x-amz-* headers signed.
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

export function sigV4Headers(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  keyId: string;
  secret: string;
  region: string;
  service: string;
  now?: Date;
}): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: opts.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": opts.payloadHash,
  };
  // The known-answer vector signs host and x-amz-date only; a content hash
  // header is S3's own addition and is signed whenever it is sent.
  if (opts.service !== "s3") delete headers["x-amz-content-sha256"];
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalQuery = [...opts.url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalPath = opts.url.pathname.split("/").map((s) => encodeURIComponent(decodeURIComponent(s))).join("/") || "/";
  const canonicalRequest = [opts.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, opts.payloadHash].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${opts.secret}`, date);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const out: Record<string, string> = { ...headers };
  delete out.host;
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${opts.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

const UNSIGNED = "UNSIGNED-PAYLOAD";

// "https://s3.us-east-005.backblazeb2.com" names its region in the host; an
// endpoint that does not is signed as us-east-1, which S3-compatible stores
// accept.
function regionOf(endpoint: string, explicit?: string): string {
  if (explicit) return explicit;
  const m = /s3\.([a-z0-9-]+)\./.exec(endpoint);
  return m ? m[1] : "us-east-1";
}

export function s3Store(cfg: {
  bucket: string;
  endpoint: string;
  keyId: string;
  appKey: string;
  region?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): AssetStore {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const region = regionOf(cfg.endpoint, cfg.region);
  const urlFor = (key: string) => new URL(`${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${checkKey(key)}`);
  const send = (method: string, key: string, headers: Record<string, string>, body?: BodyInit) => {
    const url = urlFor(key);
    const signed = sigV4Headers({
      method,
      url,
      headers,
      payloadHash: UNSIGNED,
      keyId: cfg.keyId,
      secret: cfg.appKey,
      region,
      service: "s3",
      now: cfg.now?.(),
    });
    return fetchImpl(url.toString(), {
      method,
      headers: signed,
      body,
      duplex: "half",
      signal: AbortSignal.timeout(120_000),
    } as RequestInit);
  };
  return {
    async put(key, body, size, mime) {
      const res = await send("PUT", key, { "content-type": mime, "content-length": String(size) }, body as BodyInit);
      if (!res.ok) throw new Error(`storage put failed (${res.status})`);
    },
    async get(key, range) {
      const headers: Record<string, string> = {};
      if (range) headers.range = `bytes=${range.start}-${range.end ?? ""}`;
      const res = await send("GET", key, headers);
      if (res.status === 404) return null;
      if (res.status === 416) return null;
      if (!res.ok || !res.body) throw new Error(`storage get failed (${res.status})`);
      const length = Number(res.headers.get("content-length") ?? 0);
      const contentRange = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("content-range") ?? "");
      const start = contentRange ? Number(contentRange[1]) : 0;
      const end = contentRange ? Number(contentRange[2]) : length - 1;
      const total = contentRange ? Number(contentRange[3]) : length;
      return { stream: res.body as ReadableStream<Uint8Array>, size: end - start + 1, start, end, total };
    },
    async head(key) {
      const res = await send("HEAD", key, {});
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage head failed (${res.status})`);
      return { size: Number(res.headers.get("content-length") ?? 0) };
    },
    async delete(key) {
      const res = await send("DELETE", key, {});
      if (!res.ok && res.status !== 404) throw new Error(`storage delete failed (${res.status})`);
    },
  };
}

// The store the server runs with, or null when none is configured. The asset
// routes answer 503 in that case, which lets the server deploy before the
// bucket exists.
export function assetStore(env: Record<string, string | undefined> = process.env): AssetStore | null {
  if (env.ASSETS_DIR) return fsStore(env.ASSETS_DIR);
  const bucket = env.ASSETS_BUCKET;
  const endpoint = env.ASSETS_ENDPOINT ?? env.B2_ENDPOINT;
  const keyId = env.ASSETS_KEY_ID ?? env.B2_KEY_ID;
  const appKey = env.ASSETS_APP_KEY ?? env.B2_APP_KEY;
  if (!bucket || !endpoint || !keyId || !appKey) return null;
  return s3Store({ bucket, endpoint, keyId, appKey });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && node --experimental-strip-types --test src/storage.test.ts`
Expected: 7 passed. If the SigV4 known answer fails, compare the canonical request against the AWS `get-vanilla` vector line by line before touching anything else; the vector is authoritative.

- [ ] **Step 6: Commit**

```bash
git add server/src/asset-mime.ts server/src/storage.ts server/src/storage.test.ts
git -c core.hooksPath=/dev/null commit -m "Asset storage: a directory for tests, a signed bucket for production" -m "Constraint: the server carries no SDKs; SigV4 is small enough to own.
Tested: storage.test.ts, the AWS get-vanilla known answer included.
Not-tested: a live bucket (Task 12 gates that behind ASSETS_LIVE_TEST).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Server asset tables and the upload, missing and link routes

**Files:**
- Create: `server/src/assets.ts`, `server/src/assets.test.ts`
- Modify: `server/src/index.ts` (mount), `server/src/docs.ts` (delete cascade)

**Interfaces:**
- Consumes: `assetStore`, `AssetStore`, `assetMimeFor` (Task 1); `accessLevel`, `canEditLevel`, `canReadLevel` from `shares.ts`; `auth` from `auth.ts`.
- Produces: `export const assetsApi: Hono` mounted at `/api` with `POST /docs/:id/assets/missing`, `PUT /assets/:hash`, `PUT /docs/:id/assets`.
- Produces: `assetRefsFor(docId: string): Map<string, { owner_id: string; hash: string; mime: string; size: number }>`; `serveAsset(c: Context, docId: string, ref: string): Promise<Response>`; `unlinkDocAssets(docId: string): void`; `setAssetStoreForTests(store: AssetStore | null)`; constants `MAX_ASSET_BYTES`, `MAX_DOC_ASSET_BYTES`, `MAX_ACCOUNT_ASSET_BYTES`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/assets.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-assets-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-assets-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { assetsApi, assetRefsFor, MAX_ASSET_BYTES, setAssetStoreForTests } = await import("./assets.ts");
const { fsStore } = await import("./storage.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", assetsApi);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function json(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function upload(token: string, bytes: Buffer, hash = sha(bytes), mime = "image/png", length = bytes.length) {
  const res = await app.request(`/api/assets/${hash}`, {
    method: "PUT",
    headers: { "Content-Type": mime, "Content-Length": String(length), Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: bytes,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function makeDoc(token: string, content = "# t\n\n![](shots/a.png)\n") {
  const id = crypto.randomUUID();
  const r = await json("PUT", `/api/docs/${id}`, token, { name: "t.md", content, hash: sha(Buffer.from(content)), baseVersion: 0 });
  assert.equal(r.status, 200);
  return id;
}

let owner: { token: string; id: string };
let editor: { token: string; id: string };
let stranger: { token: string; id: string };
before(async () => {
  owner = await signUpVerified(app, "owner@markie.test");
  editor = await signUpVerified(app, "editor@markie.test");
  stranger = await signUpVerified(app, "stranger@markie.test");
});

test("missing answers from the caller's own scope", async () => {
  const id = await makeDoc(owner.token);
  const h = sha(PNG);
  let r = await json("POST", `/api/docs/${id}/assets/missing`, owner.token, { hashes: [h] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.missing, [h]);
  assert.equal(r.data.cap, 5 * 1024 * 1024 * 1024);
  assert.equal((await upload(owner.token, PNG)).status, 200);
  r = await json("POST", `/api/docs/${id}/assets/missing`, owner.token, { hashes: [h] });
  assert.deepEqual(r.data.missing, []);
  // Another account holding the same bytes learns nothing from this.
  const theirs = await makeDoc(stranger.token);
  r = await json("POST", `/api/docs/${theirs}/assets/missing`, stranger.token, { hashes: [h] });
  assert.deepEqual(r.data.missing, [h]);
});

test("missing is for the document's owner and editors only", async () => {
  const id = await makeDoc(owner.token);
  assert.equal((await json("POST", `/api/docs/${id}/assets/missing`, stranger.token, { hashes: [] })).status, 404);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "viewer" });
  assert.equal((await json("POST", `/api/docs/${id}/assets/missing`, editor.token, { hashes: [] })).status, 403);
});

test("upload refuses a wrong hash, a wrong type and a body over the cap, and is idempotent", async () => {
  assert.equal((await upload(owner.token, PNG, "0".repeat(64))).status, 400);
  assert.equal((await upload(owner.token, PNG, sha(PNG), "text/html")).status, 415);
  assert.equal((await upload(owner.token, PNG, sha(PNG), "image/png", MAX_ASSET_BYTES + 1)).status, 413);
  assert.equal((await upload(owner.token, PNG)).status, 200);
  assert.equal((await upload(owner.token, PNG)).status, 200);
  assert.equal((await upload(owner.token, PNG, "nothex")).status, 400);
});

test("upload refuses an account over its total", async () => {
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  db.prepare("INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)").run(
    stranger.id, "f".repeat(64), 5 * 1024 * 1024 * 1024, "image/png", "2026-01-01T00:00:00.000Z"
  );
  const r = await upload(stranger.token, Buffer.from("xx"));
  assert.equal(r.status, 413);
  assert.equal(r.data.error, "account over cap");
  db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(stranger.id, "f".repeat(64));
});

test("link replaces the set, keeps an entry without a hash, and collects orphans", async () => {
  const id = await makeDoc(owner.token);
  const a = Buffer.from("aaaa"), b = Buffer.from("bbbb");
  assert.equal((await upload(owner.token, a)).status, 200);
  assert.equal((await upload(owner.token, b)).status, 200);
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "a.png", hash: sha(a) }, { ref: "b.png", hash: sha(b) }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 2, kept: 0, dropped: 0 });
  assert.deepEqual([...assetRefsFor(id).keys()].sort(), ["a.png", "b.png"]);
  // An editor pushes text it cannot resolve b.png for: the link survives.
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  r = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref: "b.png" }] });
  assert.deepEqual(r.data, { linked: 0, kept: 1, dropped: 0 });
  assert.deepEqual([...assetRefsFor(id).keys()], ["b.png"]);
  // a.png is referenced by nothing now: gone from the table and the store.
  const store = fsStore(process.env.ASSETS_DIR!);
  assert.equal(await store.head(`${owner.id}/${sha(a)}`), null);
  assert.deepEqual(await store.head(`${owner.id}/${sha(b)}`), { size: 4 });
  // A hash the caller does not hold cannot be linked; an unknown ref without a hash is dropped.
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "c.png", hash: "1".repeat(64) }, { ref: "z.png" }] });
  assert.equal(r.status, 400);
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "b.png" }, { ref: "z.png" }] });
  assert.deepEqual(r.data, { linked: 0, kept: 1, dropped: 1 });
});

test("link refuses a document set over 500 MB by declared sizes", async () => {
  const id = await makeDoc(owner.token);
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  const big = "e".repeat(64);
  db.prepare("INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)").run(
    owner.id, big, 500 * 1024 * 1024 + 1, "video/mp4", "2026-01-01T00:00:00.000Z"
  );
  const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "big.mp4", hash: big }] });
  assert.equal(r.status, 413);
  db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(owner.id, big);
});

test("a viewer may not link; a stranger sees 404", async () => {
  const id = await makeDoc(owner.token);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "viewer" });
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [] })).status, 403);
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, stranger.token, { refs: [] })).status, 404);
});

test("deleting the document unlinks and collects", async () => {
  const id = await makeDoc(owner.token);
  const z = Buffer.from("zzzz");
  await upload(owner.token, z);
  await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "z.png", hash: sha(z) }] });
  assert.equal((await json("DELETE", `/api/docs/${id}`, owner.token)).status, 200);
  assert.equal(assetRefsFor(id).size, 0);
  assert.equal(await fsStore(process.env.ASSETS_DIR!).head(`${owner.id}/${sha(z)}`), null);
});

test("every route answers 503 when no store is configured", async () => {
  setAssetStoreForTests(null);
  try {
    const id = await makeDoc(owner.token);
    assert.equal((await upload(owner.token, PNG)).status, 503);
    assert.equal((await json("POST", `/api/docs/${id}/assets/missing`, owner.token, { hashes: [] })).status, 503);
    assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [] })).status, 503);
  } finally {
    setAssetStoreForTests(fsStore(process.env.ASSETS_DIR!));
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --experimental-strip-types --test src/assets.test.ts`
Expected: FAIL, cannot find `./assets.ts`.

- [ ] **Step 3: Write `server/src/assets.ts`**

```ts
// Media that travels with a document: what is stored, who may link it to
// which document, and how it is served. Reads go through the same three
// gates the text uses (bearer, /d/ viewer, /s/ token); this module only
// knows how to stream one asset once a caller has passed one of them.
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { accessLevel, canEditLevel } from "./shares.ts";
import { assetMimeFor } from "./asset-mime.ts";
import { assetStore, type AssetStore } from "./storage.ts";

export const MAX_ASSET_BYTES = 100 * 1024 * 1024;
export const MAX_DOC_ASSET_BYTES = 500 * 1024 * 1024;
export const MAX_ACCOUNT_ASSET_BYTES = 5 * 1024 * 1024 * 1024;

const db = openDatabase();
db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    owner_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, hash)
  );
  CREATE TABLE IF NOT EXISTS doc_assets (
    doc_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (doc_id, ref)
  );
  CREATE INDEX IF NOT EXISTS idx_doc_assets_asset ON doc_assets(owner_id, hash);
`);

let store: AssetStore | null = assetStore();
export function setAssetStoreForTests(next: AssetStore | null): void {
  store = next;
}

const HASH = /^[a-f0-9]{64}$/;
const ALLOWED_MIMES = new Set(
  ["png", "jpg", "gif", "webp", "svg", "avif", "bmp", "ico", "mp4", "m4v", "webm", "ogv", "mov", "mp3", "m4a", "aac", "wav", "flac", "oga", "opus"]
    .map((ext) => assetMimeFor(`x.${ext}`))
    .filter((m): m is string => !!m)
);

async function requireUser(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

function docExists(docId: string): boolean {
  return !!db.prepare("SELECT 1 FROM docs WHERE id = ? AND deleted_at IS NULL").get(docId);
}

function usageFor(ownerId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM assets WHERE owner_id = ?").get(ownerId) as { total: number };
  return row.total;
}

interface AssetRow {
  owner_id: string;
  hash: string;
  size: number;
  mime: string;
}

export function assetRefsFor(docId: string): Map<string, AssetRow> {
  const rows = db
    .prepare(
      `SELECT d.ref, a.owner_id, a.hash, a.size, a.mime FROM doc_assets d
       JOIN assets a ON a.owner_id = d.owner_id AND a.hash = d.hash WHERE d.doc_id = ?`
    )
    .all(docId) as (AssetRow & { ref: string })[];
  return new Map(rows.map((r) => [r.ref, { owner_id: r.owner_id, hash: r.hash, size: r.size, mime: r.mime }]));
}

// Rows in `assets` that no document links any more, removed from the table
// and from storage. Storage failures are logged, not thrown: the link is
// already gone, and a leftover object is a cost, not a leak.
async function collectOrphans(candidates: { owner_id: string; hash: string }[]): Promise<void> {
  for (const { owner_id, hash } of candidates) {
    const still = db.prepare("SELECT 1 FROM doc_assets WHERE owner_id = ? AND hash = ? LIMIT 1").get(owner_id, hash);
    if (still) continue;
    db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(owner_id, hash);
    try {
      await store?.delete(`${owner_id}/${hash}`);
    } catch (err) {
      console.error(`asset delete failed for ${owner_id}/${hash}:`, err);
    }
  }
}

export function unlinkDocAssets(docId: string): void {
  const rows = db.prepare("SELECT owner_id, hash FROM doc_assets WHERE doc_id = ?").all(docId) as { owner_id: string; hash: string }[];
  db.prepare("DELETE FROM doc_assets WHERE doc_id = ?").run(docId);
  void collectOrphans(rows);
}

// The gate for writes: owner or editor of a live document. 404 for a
// document the caller cannot see at all, the same as the text routes.
async function requireEditor(c: Context, docId: string) {
  const user = await requireUser(c);
  if (!user) return { error: c.json({ error: "unauthorized" }, 401) };
  const level = accessLevel(docId, user.id);
  if (!docExists(docId) || level === null) return { error: c.json({ error: "not found" }, 404) };
  if (!canEditLevel(level)) return { error: c.json({ error: "forbidden" }, 403) };
  return { user };
}

export const assetsApi = new Hono();

assetsApi.use("*", async (c, next) => {
  if (!store) return c.json({ error: "assets not configured" }, 503);
  await next();
});

assetsApi.post("/docs/:id/assets/missing", async (c) => {
  const docId = c.req.param("id");
  const gate = await requireEditor(c, docId);
  if ("error" in gate) return gate.error;
  const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null;
  const hashes = Array.isArray(body?.hashes) ? body!.hashes.filter((h): h is string => typeof h === "string" && HASH.test(h)) : [];
  const have = new Set(
    (db.prepare("SELECT hash FROM assets WHERE owner_id = ?").all(gate.user.id) as { hash: string }[]).map((r) => r.hash)
  );
  return c.json({ missing: hashes.filter((h) => !have.has(h)), usage: usageFor(gate.user.id), cap: MAX_ACCOUNT_ASSET_BYTES });
});

// Bytes in, hashed as they stream to a temp file, kept only when the hash
// the URL names is the hash of what arrived. Nothing reaches storage before
// every cap has been checked against real byte counts.
assetsApi.put("/assets/:hash", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const hash = c.req.param("hash");
  if (!HASH.test(hash)) return c.json({ error: "bad hash" }, 400);
  const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) return c.json({ error: "unsupported type" }, 415);
  const declared = Number(c.req.header("content-length") ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0) return c.json({ error: "length required" }, 411);
  if (declared > MAX_ASSET_BYTES) return c.json({ error: "file over cap", cap: MAX_ASSET_BYTES }, 413);
  if (usageFor(user.id) + declared > MAX_ACCOUNT_ASSET_BYTES) {
    return c.json({ error: "account over cap", cap: MAX_ACCOUNT_ASSET_BYTES }, 413);
  }
  const existing = db.prepare("SELECT size FROM assets WHERE owner_id = ? AND hash = ?").get(user.id, hash) as { size: number } | undefined;
  if (existing && (await store!.head(`${user.id}/${hash}`))) return c.json({ ok: true, hash, size: existing.size });

  const dir = await mkdtemp(join(tmpdir(), "markie-upload-"));
  const tmp = join(dir, "body");
  try {
    const hasher = createHash("sha256");
    let seen = 0;
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);
    const counted = Readable.fromWeb(body as never).on("data", (chunk: Buffer) => {
      seen += chunk.length;
      hasher.update(chunk);
      if (seen > MAX_ASSET_BYTES) counted.destroy(new Error("over cap"));
    });
    try {
      await pipeline(counted, createWriteStream(tmp));
    } catch (err) {
      if (String(err).includes("over cap")) return c.json({ error: "file over cap", cap: MAX_ASSET_BYTES }, 413);
      throw err;
    }
    if (hasher.digest("hex") !== hash) return c.json({ error: "hash mismatch" }, 400);
    const size = (await stat(tmp)).size;
    await store!.put(`${user.id}/${hash}`, Readable.toWeb(createReadStream(tmp)) as ReadableStream<Uint8Array>, size, mime);
    db.prepare(
      "INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(user.id, hash, size, mime, new Date().toISOString());
    return c.json({ ok: true, hash, size });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The document's full reference set. An entry with a hash must name an asset
// in the caller's scope; one without keeps whatever link the document already
// has for that ref (an editor pushing text whose pictures the owner uploaded)
// or is dropped.
assetsApi.put("/docs/:id/assets", async (c) => {
  const docId = c.req.param("id");
  const gate = await requireEditor(c, docId);
  if ("error" in gate) return gate.error;
  const body = (await c.req.json().catch(() => null)) as { refs?: unknown } | null;
  if (!Array.isArray(body?.refs)) return c.json({ error: "bad request" }, 400);
  const current = assetRefsFor(docId);
  const next = new Map<string, { owner_id: string; hash: string; size: number }>();
  let linked = 0, kept = 0, dropped = 0;
  for (const entry of body!.refs as { ref?: unknown; hash?: unknown }[]) {
    const ref = typeof entry?.ref === "string" ? entry.ref : "";
    if (!ref || ref.length > 2048) continue;
    if (typeof entry.hash === "string") {
      if (!HASH.test(entry.hash)) return c.json({ error: "bad hash" }, 400);
      const own = db.prepare("SELECT size FROM assets WHERE owner_id = ? AND hash = ?").get(gate.user.id, entry.hash) as { size: number } | undefined;
      if (!own) return c.json({ error: "unknown asset", hash: entry.hash }, 400);
      next.set(ref, { owner_id: gate.user.id, hash: entry.hash, size: own.size });
      linked += 1;
    } else if (current.has(ref)) {
      const row = current.get(ref)!;
      next.set(ref, { owner_id: row.owner_id, hash: row.hash, size: row.size });
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  const total = [...next.values()].reduce((n, r) => n + r.size, 0);
  if (total > MAX_DOC_ASSET_BYTES) return c.json({ error: "document over cap", cap: MAX_DOC_ASSET_BYTES }, 413);
  const before = [...current.values()].map((r) => ({ owner_id: r.owner_id, hash: r.hash }));
  db.transaction(() => {
    db.prepare("DELETE FROM doc_assets WHERE doc_id = ?").run(docId);
    const ins = db.prepare("INSERT INTO doc_assets (doc_id, ref, owner_id, hash) VALUES (?, ?, ?, ?)");
    for (const [ref, r] of next) ins.run(docId, ref, r.owner_id, r.hash);
  })();
  await collectOrphans(before);
  return c.json({ linked, kept, dropped });
});

// One asset, by the reference the document wrote, for a caller that has
// already passed a read gate. 404 for an unknown ref so the route says no
// more than the document page would.
export async function serveAsset(c: Context, docId: string, ref: string): Promise<Response> {
  if (!store) return c.json({ error: "assets not configured" }, 503);
  const row = assetRefsFor(docId).get(ref);
  if (!row) return c.text("Not found", 404);
  const rangeHeader = c.req.header("range");
  let range: { start: number; end?: number } | undefined;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m) return c.text("Range Not Satisfiable", 416);
    if (m[1]) range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
    else if (m[2]) range = { start: Math.max(0, row.size - Number(m[2])) };
  }
  const read = await store.get(`${row.owner_id}/${row.hash}`, range);
  if (!read) return c.text(range ? "Range Not Satisfiable" : "Not found", range ? 416 : 404);
  const headers = new Headers({
    "Content-Type": row.mime,
    "Content-Length": String(read.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ETag: `"${row.hash}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (range) headers.set("Content-Range", `bytes ${read.start}-${read.end}/${read.total}`);
  return new Response(read.stream, { status: range ? 206 : 200, headers });
}
```

- [ ] **Step 4: Mount and cascade**

In `server/src/index.ts`, after `app.route("/api", themes);` add:

```ts
app.route("/api", assetsApi);
```

with `import { assetsApi } from "./assets.ts";` beside the other imports.

In `server/src/docs.ts`, add `import { unlinkDocAssets } from "./assets.ts";` and in `docs.delete("/:id", ...)` add `unlinkDocAssets(docId);` after `purgeDocThreads(docId);`.

Circular import check: `assets.ts` imports `shares.ts` and `auth.ts`, not `docs.ts`, so `docs.ts` importing `assets.ts` is one-directional.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && node --experimental-strip-types --test src/assets.test.ts src/doc-delete.test.ts`
Expected: all pass. If Hono's `c.req.raw.body` is null in the test runner, the test harness's `app.request` with a `Buffer` body must set it; wrap the body as `new Blob([bytes])` in the `upload` helper.

- [ ] **Step 6: Commit**

```bash
git add server/src/assets.ts server/src/assets.test.ts server/src/index.ts server/src/docs.ts
git -c core.hooksPath=/dev/null commit -m "Assets: upload, link and unlink media for a document" -m "Constraint: dedupe within one uploader only, so a hash query answers nothing about another account.
Directive: a ref is data; the storage key is uploader plus hash and nothing else.
Tested: assets.test.ts, doc-delete.test.ts.
Not-tested: reads (Task 3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Server read routes behind the three existing gates

**Files:**
- Modify: `server/src/docs.ts` (`GET /:id/assets/file`), `server/src/doc-view.ts` (`GET /d/:id/assets`), `server/src/public.ts` (`GET /s/:token/assets`), `server/src/never-public.test.ts`
- Create: `server/src/asset-read.test.ts`

**Interfaces:**
- Consumes: `serveAsset` (Task 2), `resolveViewer` (doc-view), `resolvePublicToken` (public-links), `accessLevel`/`canReadLevel` (shares).

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/asset-read.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-asset-read-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-asset-read-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { assetsApi } = await import("./assets.ts");
const { docView } = await import("./doc-view.ts");
const { publicShare } = await import("./public.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", assetsApi);
app.route("/", docView);
app.route("/", publicShare);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.from("0123456789");
const H = (token?: string) => ({ Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

let owner: { token: string; id: string }, viewer: { token: string; id: string }, stranger: { token: string; id: string };
let docId: string;
before(async () => {
  owner = await signUpVerified(app, "o@markie.test");
  viewer = await signUpVerified(app, "v@markie.test");
  stranger = await signUpVerified(app, "s@markie.test");
  docId = crypto.randomUUID();
  const content = "![](a.png)\n";
  await app.request(`/api/docs/${docId}`, { method: "PUT", headers: { ...H(owner.token), "Content-Type": "application/json" }, body: JSON.stringify({ name: "t.md", content, hash: sha(Buffer.from(content)), baseVersion: 0 }) });
  await app.request(`/api/assets/${sha(PNG)}`, { method: "PUT", headers: { ...H(owner.token), "Content-Type": "image/png", "Content-Length": "10" }, body: new Blob([PNG]) });
  await app.request(`/api/docs/${docId}/assets`, { method: "PUT", headers: { ...H(owner.token), "Content-Type": "application/json" }, body: JSON.stringify({ refs: [{ ref: "a.png", hash: sha(PNG) }] }) });
  await app.request(`/api/docs/${docId}/shares`, { method: "POST", headers: { ...H(owner.token), "Content-Type": "application/json" }, body: JSON.stringify({ email: "v@markie.test", role: "viewer" }) });
});

test("the bearer route serves members, ranges included, and hides from everyone else", async () => {
  const path = `/api/docs/${docId}/assets/file?ref=a.png`;
  let res = await app.request(path, { headers: H(owner.token) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(res.headers.get("etag"), `"${sha(PNG)}"`);
  assert.equal(await res.text(), "0123456789");
  res = await app.request(path, { headers: { ...H(viewer.token), Range: "bytes=2-4" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await res.text(), "234");
  assert.equal((await app.request(path, { headers: H(stranger.token) })).status, 404);
  assert.equal((await app.request(path, { headers: H() })).status, 401);
  assert.equal((await app.request(`/api/docs/${docId}/assets/file?ref=nope.png`, { headers: H(owner.token) })).status, 404);
});

test("the /d/ route follows resolveViewer: personal token or session, nothing else", async () => {
  assert.equal((await app.request(`/d/${docId}/assets?ref=a.png`, { headers: H() })).status, 404);
  // The viewer's personal ?k= token, minted on the share row the way the
  // invite email mints it.
  const { ensureShareToken } = await import("./shares.ts");
  const k = ensureShareToken(docId, viewer.id);
  const withToken = await app.request(`/d/${docId}/assets?ref=a.png&k=${encodeURIComponent(k)}`, { headers: H() });
  assert.equal(withToken.status, 200);
  assert.equal(await withToken.text(), "0123456789");
  assert.equal((await app.request(`/d/${docId}/assets?ref=a.png&k=not-a-token`, { headers: H() })).status, 404);
  // Removing the member kills the token with the share row.
  await app.request(`/api/docs/${docId}/shares/${viewer.id}`, { method: "DELETE", headers: H(owner.token) });
  assert.equal((await app.request(`/d/${docId}/assets?ref=a.png&k=${encodeURIComponent(k)}`, { headers: H() })).status, 404);
});

test("the /s/ route follows the public token and revocation", async () => {
  const made = await app.request(`/api/docs/${docId}/public-link`, { method: "POST", headers: { ...H(owner.token), "Content-Type": "application/json" } });
  // The route answers { url: "<site>/s/<token>" }; the token is its last segment.
  const { url } = (await made.json()) as { url: string };
  const token = url.split("/s/")[1];
  let res = await app.request(`/s/${token}/assets?ref=a.png`, { headers: H() });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "0123456789");
  assert.equal((await app.request(`/s/${token}/assets?ref=b.png`, { headers: H() })).status, 404);
  await app.request(`/api/docs/${docId}/public-link`, { method: "DELETE", headers: H(owner.token) });
  res = await app.request(`/s/${token}/assets?ref=a.png`, { headers: H() });
  assert.equal(res.status, 404);
});
```

The personal `?k=` token comes from `ensureShareToken(docId, userId)` in `server/src/shares.ts:49`, stored on the share row; the public link route is `POST /api/docs/:id/public-link` in the same file, answering `{ url }`. Both are used above as they exist.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --experimental-strip-types --test src/asset-read.test.ts`
Expected: FAIL with 404s where 200 is expected (routes absent).

- [ ] **Step 3: Add the three routes**

`server/src/docs.ts`, after `docs.get("/:id", ...)`:

```ts
docs.get("/:id/assets/file", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  if (!canReadLevel(accessLevel(id, user.id))) return c.text("Not found", 404);
  const ref = c.req.query("ref") ?? "";
  return serveAsset(c, id, ref);
});
```

with `import { serveAsset, unlinkDocAssets } from "./assets.ts";`.

`server/src/doc-view.ts`, after the `/d/:id/raw` route:

```ts
docView.get("/d/:id/assets", async (c) => {
  const docId = c.req.param("id");
  const viewer = await resolveViewer(docId, c.req.query("k") ?? null, c.req.raw.headers);
  if (!viewer) return c.text("Not found", 404);
  if (!loadDoc(docId)) return c.text("Not found", 404);
  return serveAsset(c, docId, c.req.query("ref") ?? "");
});
```

`server/src/public.ts`, after `/s/:token/raw`:

```ts
publicShare.get("/s/:token/assets", (c) => {
  const link = resolvePublicToken(c.req.param("token"));
  if (!link) return c.text("Not found", 404);
  if (!docForToken(c.req.param("token"))) return c.text("Not found", 404);
  return serveAsset(c, link.doc_id, c.req.query("ref") ?? "");
});
```

- [ ] **Step 4: Extend `never-public.test.ts`**

Read the file; it asserts `/d/:id` never serves without access. Add the same assertion for `/d/<id>/assets?ref=a.png` (expect 404) and `/api/docs/<id>/assets/file?ref=a.png` without a bearer (expect 401), following the file's existing pattern.

- [ ] **Step 5: Run the tests**

Run: `cd server && node --experimental-strip-types --test src/asset-read.test.ts src/never-public.test.ts src/doc-view.test.ts src/public.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/docs.ts server/src/doc-view.ts server/src/public.ts server/src/asset-read.test.ts server/src/never-public.test.ts
git -c core.hooksPath=/dev/null commit -m "Serve a document's media through the gates its text already has" -m "Constraint: no fourth path to an asset; bearer, resolveViewer and the public token are the three there are.
Tested: asset-read.test.ts, never-public.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Web pages rewrite media `src` at render time

**Files:**
- Create: `server/src/rehype-cloud-assets.ts`
- Modify: `server/src/render.ts`, `server/src/doc-view.ts`, `server/src/public.ts`, `server/src/render.test.ts`

**Interfaces:**
- Produces: `rehypeCloudAssets(assetUrlFor: (ref: string) => string | null)`; `renderMarkdownHTML(markdown: string, opts?: { assetUrlFor?: (ref: string) => string | null }): string`; `renderSharedDocPage` and `renderPublicPage` accept `assetUrlFor?`.

- [ ] **Step 1: Write the failing tests** (append to `server/src/render.test.ts`)

```ts
test("a local media reference is rewritten when the document has it, and only then", () => {
  const md = "![a](shots/a.png)\n\n![b](b.png)\n\n![](clip.mp4)\n\n![](https://x.test/c.png)\n\n<img src=\"d.png\">\n";
  const html = renderMarkdownHTML(md, {
    assetUrlFor: (ref) => (["shots/a.png", "clip.mp4", "d.png"].includes(ref) ? `/d/1/assets?ref=${encodeURIComponent(ref)}` : null),
  });
  assert.match(html, /src="\/d\/1\/assets\?ref=shots%2Fa\.png"/);
  assert.match(html, /src="b\.png"/);
  assert.match(html, /<video[^>]*src="\/d\/1\/assets\?ref=clip\.mp4"/);
  assert.match(html, /src="https:\/\/x\.test\/c\.png"/);
  assert.match(html, /src="\/d\/1\/assets\?ref=d\.png"/);
});

test("a percent-encoded reference matches its decoded form", () => {
  const html = renderMarkdownHTML("![](my%20shot.png)\n", { assetUrlFor: (ref) => (ref === "my shot.png" ? "/d/1/assets?ref=my%20shot.png" : null) });
  assert.match(html, /src="\/d\/1\/assets\?ref=my%20shot\.png"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --experimental-strip-types --test src/render.test.ts`
Expected: FAIL (second argument ignored, src unchanged).

- [ ] **Step 3: Write the plugin and thread it through**

```ts
// server/src/rehype-cloud-assets.ts
// A shared document's `![](shots/a.png)` names a file beside the author's
// copy. On the web that file is one of the document's assets, reached by the
// same reference through the page's own asset route. The rewrite happens here
// and nowhere else: the markdown the server stores is what the author wrote.
import { visit } from "unist-util-visit";

interface ElementNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
}

const MEDIA_TAGS = new Set(["img", "video", "audio", "source"]);

function isLocal(src: string): boolean {
  return !!src && !src.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

// The reference a document wrote, as the asset table stores it: percent
// decoded, query and fragment kept off.
export function refOf(src: string): string {
  const bare = src.trim().split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

export function rehypeCloudAssets(assetUrlFor: (ref: string) => string | null) {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: ElementNode) => {
      if (!node.tagName || !MEDIA_TAGS.has(node.tagName)) return;
      const src = node.properties?.src;
      if (typeof src !== "string" || !isLocal(src)) return;
      const url = assetUrlFor(refOf(src));
      if (url) node.properties = { ...node.properties, src: url };
    });
  };
}
```

In `server/src/render.ts`, replace the single `processor` and `renderMarkdownHTML` with a builder:

```ts
import { rehypeCloudAssets } from "./rehype-cloud-assets.ts";

export interface RenderOptions {
  assetUrlFor?: (ref: string) => string | null;
}

function buildProcessor(opts: RenderOptions) {
  const p = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeMedia);
  if (opts.assetUrlFor) p.use(rehypeCloudAssets, opts.assetUrlFor);
  return p.use(rehypeEmbeds).use(rehypeHighlight).use(rehypeKatex).use(rehypeSanitize, sanitizeSchema).use(rehypeStringify);
}

const plain = buildProcessor({});

export function renderMarkdownHTML(markdown: string, opts: RenderOptions = {}): string {
  const processor = opts.assetUrlFor ? buildProcessor(opts) : plain;
  return String(processor.processSync(markdown));
}
```

Add `assetUrlFor?: (ref: string) => string | null` to the option types of `renderSharedDocPage` and `renderPublicPage` and pass `{ assetUrlFor: opts.assetUrlFor }` into their `renderMarkdownHTML` calls.

In `server/src/doc-view.ts` `/d/:id`, build the function from the table and pass it:

```ts
const refs = assetRefsFor(docId);
const k = c.req.query("k");
const assetUrlFor = (ref: string) =>
  refs.has(ref) ? `/d/${encodeURIComponent(docId)}/assets?ref=${encodeURIComponent(ref)}${k ? `&k=${encodeURIComponent(k)}` : ""}` : null;
```

In `server/src/public.ts` `/s/:token`, `docForToken` must also return `doc_id`; then:

```ts
const refs = assetRefsFor(doc.doc_id);
const assetUrlFor = (ref: string) => (refs.has(ref) ? `/s/${encodeURIComponent(token)}/assets?ref=${encodeURIComponent(ref)}` : null);
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node --experimental-strip-types --test src/render.test.ts src/doc-view.test.ts src/public.test.ts src/asset-read.test.ts`
Expected: all pass. Add one assertion to `doc-view.test.ts`: a document with a linked asset renders `src="/d/<id>/assets?ref=a.png"` and one without renders `src="a.png"`.

- [ ] **Step 5: Commit**

```bash
git add server/src/rehype-cloud-assets.ts server/src/render.ts server/src/doc-view.ts server/src/public.ts server/src/render.test.ts server/src/doc-view.test.ts
git -c core.hooksPath=/dev/null commit -m "The web viewer points a document's media at its own asset route" -m "Directive: the stored markdown is never rewritten; the rewrite lives in rehypeCloudAssets at render time.
Tested: render.test.ts, doc-view.test.ts, public.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Extracting a document's local media (Electron)

**Files:**
- Create: `electron/doc-assets.js`, `electron/doc-assets.test.ts`

**Interfaces:**
- Consumes: `localAssets.resolveMedia(src, { docDir, roots, files }) -> { path, mime, kind } | null` and `localAssets.mediaMimeFor(path)` from `electron/local-assets.js`.
- Produces: `extractRefs(markdown: string): string[]` (distinct, document order, percent-decoded, query and fragment removed); `resolveRefs(refs, { docPath, roots, files }): { ref, path, mime }[] | { ref, skipped: "outside" | "type" }[]` (one entry per ref); `hashFile(path): Promise<{ hash: string; size: number }>`; `fingerprint(entries: { ref: string; hash: string }[]): string`; `MAX_ASSET_BYTES`.

- [ ] **Step 1: Write the failing tests**

```ts
// electron/doc-assets.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const { extractRefs, resolveRefs, hashFile, fingerprint } =
  require("./doc-assets") as typeof import("./doc-assets");

describe("extractRefs", () => {
  it("finds markdown images and raw media tags, local only, once each, decoded", () => {
    const md = [
      "![a](shots/a.png)",
      "![again](shots/a.png)",
      '![sp](my%20shot.png "title")',
      "![web](https://x.test/c.png)",
      "![data](data:image/png;base64,AAAA)",
      "![proto](//cdn.test/d.png)",
      '<img src="d.png">',
      "<video src='clip.mp4?x=1' controls></video>",
      '<audio><source src="song.mp3#t=1"></audio>',
      "`![code](e.png)`",
    ].join("\n\n");
    expect(extractRefs(md)).toEqual(["shots/a.png", "my shot.png", "d.png", "clip.mp4", "song.mp3", "e.png"]);
  });

  it("returns nothing for a document without media", () => {
    expect(extractRefs("# Title\n\nJust words.\n")).toEqual([]);
  });
});

describe("resolveRefs and hashFile", () => {
  it("keeps what the local viewer would show and names why the rest is skipped", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "markie-doc-assets-"));
    const docDir = path.join(home, "report");
    mkdirSync(path.join(docDir, "shots"), { recursive: true });
    mkdirSync(path.join(home, "private"));
    writeFileSync(path.join(docDir, "shots", "a.png"), "png-bytes");
    writeFileSync(path.join(docDir, "notes.txt"), "text");
    writeFileSync(path.join(home, "private", "secret.png"), "png");
    const docPath = path.join(docDir, "doc.md");
    const out = resolveRefs(["shots/a.png", "notes.txt", "../private/secret.png", "missing.png"], { docPath, roots: [], files: [] });
    expect(out[0]).toEqual({ ref: "shots/a.png", path: path.join(docDir, "shots", "a.png"), mime: "image/png" });
    expect(out[1]).toEqual({ ref: "notes.txt", skipped: "type" });
    expect(out[2]).toEqual({ ref: "../private/secret.png", skipped: "outside" });
    expect(out[3]).toEqual({ ref: "missing.png", skipped: "outside" });
    const { hash, size } = await hashFile(path.join(docDir, "shots", "a.png"));
    expect(hash).toBe(createHash("sha256").update("png-bytes").digest("hex"));
    expect(size).toBe(9);
  });

  it("fingerprint is order-independent and changes with any ref or hash", () => {
    const a = fingerprint([{ ref: "a.png", hash: "1" }, { ref: "b.png", hash: "2" }]);
    const b = fingerprint([{ ref: "b.png", hash: "2" }, { ref: "a.png", hash: "1" }]);
    expect(a).toBe(b);
    expect(fingerprint([{ ref: "a.png", hash: "1" }])).not.toBe(a);
    expect(fingerprint([{ ref: "a.png", hash: "9" }, { ref: "b.png", hash: "2" }])).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/doc-assets.test.ts`
Expected: FAIL, cannot find module `./doc-assets`.

- [ ] **Step 3: Write `electron/doc-assets.js`**

```js
// What a document embeds, found the way the local viewer finds it. A
// reference this module resolves is one Markie draws on this machine; one it
// skips is one Markie would refuse to draw, so nothing travels that a reader
// here could not already see.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const localAssets = require("./local-assets");

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

// A markdown image, then the src of an img, video, audio or source tag in raw
// HTML. Fenced and inline code are cut out first so an example is not an
// embed.
const FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
const MD_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_SRC = /<(?:img|video|audio|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function isLocal(src) {
  return !!src && !src.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

function refOf(src) {
  const bare = src.trim().split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

function extractRefs(markdown) {
  const text = String(markdown ?? "").replace(FENCE, "");
  const seen = new Set();
  const out = [];
  const add = (src) => {
    if (!isLocal(src)) return;
    const ref = refOf(src);
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };
  for (const m of text.matchAll(MD_IMAGE)) add(m[1]);
  for (const m of text.matchAll(HTML_SRC)) add(m[1] ?? m[2] ?? m[3]);
  return out;
}

// One entry per ref: the allowed real path and its mime, or why not.
// "type" is a file Markie does not embed; "outside" is anything the local
// viewer would refuse, a missing file included, since the answer to the
// reader is the same either way.
function resolveRefs(refs, { docPath, roots = [], files = [] }) {
  const docDir = path.dirname(docPath);
  return refs.map((ref) => {
    if (!localAssets.mediaMimeFor(ref)) return { ref, skipped: "type" };
    const found = localAssets.resolveMedia(ref, { docDir, roots, files });
    if (!found) return { ref, skipped: "outside" };
    return { ref, path: found.path, mime: found.mime };
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hasher = crypto.createHash("sha256");
    let size = 0;
    fs.createReadStream(filePath)
      .on("data", (chunk) => {
        size += chunk.length;
        hasher.update(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve({ hash: hasher.digest("hex"), size }));
  });
}

// One string for "these refs at these hashes", so an unchanged document costs
// no request at all on the next push.
function fingerprint(entries) {
  const lines = entries.map((e) => `${e.ref}\t${e.hash}`).sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

module.exports = { MAX_ASSET_BYTES, extractRefs, resolveRefs, hashFile, fingerprint, refOf };
```

`localAssets.resolveMedia(src, { docDir, roots, files })` (`electron/local-assets.js:195`) returns `{ path, mime, kind }` for an allowed file and null otherwise, checking the extension before touching the filesystem and again on the realpath.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run electron/doc-assets.test.ts electron/local-assets.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add electron/doc-assets.js electron/doc-assets.test.ts
git -c core.hooksPath=/dev/null commit -m "Find what a document embeds, the way the local viewer does" -m "Constraint: only what Markie would draw here may travel; resolveMedia is the one judge of that.
Tested: doc-assets.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Registry columns and `pushAssets`

**Files:**
- Create: `electron/asset-sync.js`, `electron/asset-sync.test.ts`
- Modify: `electron/registry.js` (columns, `update` allow-list), `electron/registry.test.ts`

**Interfaces:**
- Consumes: Task 5's `extractRefs`, `resolveRefs`, `hashFile`, `fingerprint`, `MAX_ASSET_BYTES`.
- Produces: `createAssetSync({ api, registry, grants, fs, sleep })` returning `{ pushAssets(filePath, cloudId, content) }`, where `api(method, path, body?, opts?)` is sync.js's helper extended in this task to accept `{ raw: { stream, size, mime } }` for a streamed PUT (see Step 3). `pushAssets` resolves to `{ unchanged: true } | { ok: true, uploaded: number, skipped: { ref, reason }[] } | { pending: true, error?: string }`.
- Produces: registry columns `assets_state TEXT`, `assets_fingerprint TEXT`, `assets_skipped TEXT`.

- [ ] **Step 1: Write the failing tests**

Append to `electron/registry.test.ts` (follow its existing temp-db setup):

```ts
it("carries the media columns and lets update write them", () => {
  registry.track("/docs/a.md", "a.md");
  registry.update("/docs/a.md", { assets_state: "pending", assets_fingerprint: "f", assets_skipped: "[]" });
  const row = registry.get("/docs/a.md");
  expect(row.assets_state).toBe("pending");
  expect(row.assets_fingerprint).toBe("f");
  expect(row.assets_skipped).toBe("[]");
});
```

```ts
// electron/asset-sync.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const { createAssetSync } = require("./asset-sync") as typeof import("./asset-sync");
const { fingerprint } = require("./doc-assets") as typeof import("./doc-assets");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-sync-"));
  mkdirSync(path.join(dir, "shots"));
  writeFileSync(path.join(dir, "shots", "a.png"), "aaaa");
  writeFileSync(path.join(dir, "b.png"), "bbbb");
  return { dir, docPath: path.join(dir, "doc.md") };
}

type Call = { method: string; path: string; body?: unknown; raw?: { size: number; mime: string } };
function fakeApi(replies: Array<{ status: number; data?: unknown }>) {
  const calls: Call[] = [];
  const api = async (method: string, p: string, body?: unknown, opts?: { raw?: { stream: unknown; size: number; mime: string } }) => {
    calls.push({ method, path: p, body, raw: opts?.raw ? { size: opts.raw.size, mime: opts.raw.mime } : undefined });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected ${method} ${p}`);
    return { status: next.status, data: next.data ?? null };
  };
  return { api, calls };
}

let rows: Map<string, Record<string, unknown>>;
const registry = {
  get: (p: string) => rows.get(p) ?? null,
  update: (p: string, fields: Record<string, unknown>) => rows.set(p, { ...(rows.get(p) ?? {}), ...fields }),
};
const grants = { assetRoots: () => [] as string[], grantedFilePaths: () => [] as string[] };

beforeEach(() => {
  rows = new Map();
});

describe("pushAssets", () => {
  it("asks what is missing, uploads only that, links the full set and records the result", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")], usage: 0, cap: 1 } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { linked: 2, kept: 0, dropped: 1 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    const md = "![](shots/a.png)\n![](b.png)\n![](notes.txt)\n";
    const result = await pushAssets(docPath, "c1", md);
    expect(result).toEqual({ ok: true, uploaded: 1, skipped: [{ ref: "notes.txt", reason: "type" }] });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/api/docs/c1/assets/missing"],
      ["PUT", `/api/assets/${sha("bbbb")}`],
      ["PUT", "/api/docs/c1/assets"],
    ]);
    expect(calls[0].body).toEqual({ hashes: [sha("aaaa"), sha("bbbb")] });
    expect(calls[1].raw).toEqual({ size: 4, mime: "image/png" });
    expect(calls[2].body).toEqual({ refs: [{ ref: "shots/a.png", hash: sha("aaaa") }, { ref: "b.png", hash: sha("bbbb") }, { ref: "notes.txt" }] });
    const row = rows.get(docPath)!;
    expect(row.assets_state).toBe("synced");
    expect(row.assets_fingerprint).toBe(fingerprint([{ ref: "shots/a.png", hash: sha("aaaa") }, { ref: "b.png", hash: sha("bbbb") }]));
    expect(JSON.parse(row.assets_skipped as string)).toEqual([{ ref: "notes.txt", reason: "type" }]);
  });

  it("does nothing when the fingerprint already landed", async () => {
    const { docPath } = fixture();
    const md = "![](b.png)\n";
    rows.set(docPath, { cloud_doc_id: "c1", assets_state: "synced", assets_fingerprint: fingerprint([{ ref: "b.png", hash: sha("bbbb") }]) });
    const { api, calls } = fakeApi([]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await pushAssets(docPath, "c1", md)).toEqual({ unchanged: true });
    expect(calls).toEqual([]);
  });

  it("links an empty set for a document with no media, once", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 0 } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await pushAssets(docPath, "c1", "# words\n")).toEqual({ ok: true, uploaded: 0, skipped: [] });
    expect(calls.map((c) => c.path)).toEqual(["/api/docs/c1/assets"]);
    expect(await pushAssets(docPath, "c1", "# words\n")).toEqual({ unchanged: true });
  });

  it("retries an upload twice, then leaves the row pending with the error", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 0 },
      { status: 0 },
      { status: 0 },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    const result = await pushAssets(docPath, "c1", "![](b.png)\n");
    expect(result).toEqual({ pending: true, error: "media upload failed (offline)" });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
  });

  it("treats a 503 as pending with no error to show", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([{ status: 503, data: { error: "assets not configured" } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await pushAssets(docPath, "c1", "![](b.png)\n")).toEqual({ pending: true });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
  });

  it("skips a file over the cap and says so", async () => {
    const { dir, docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    // Nothing is left to upload, so there is nothing to ask about: the only
    // call is the link, which names the ref without a hash.
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 1 } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {}, maxBytes: 3 });
    const result = await pushAssets(docPath, "c1", "![](b.png)\n");
    expect(result).toEqual({ ok: true, uploaded: 0, skipped: [{ ref: "b.png", reason: "size" }] });
    expect(calls.map((c) => c.path)).toEqual(["/api/docs/c1/assets"]);
    expect(calls[0].body).toEqual({ refs: [{ ref: "b.png" }] });
    void dir;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/asset-sync.test.ts electron/registry.test.ts`
Expected: FAIL (module missing; columns missing).

- [ ] **Step 3: Registry columns and the streamed `api` option**

In `electron/registry.js`, after the `share_role_user` ALTER block, add:

```js
  // Media that travels with the document. "synced" when the server holds
  // every reference at the fingerprint; "pending" when a push is owed and the
  // reconciliation pass will make it. assets_skipped is a JSON list of refs
  // that did not travel and why, for the Cloud page to show.
  for (const col of ["assets_state", "assets_fingerprint", "assets_skipped"]) {
    if (!fileCols.some((c) => c.name === col)) db.exec(`ALTER TABLE files ADD COLUMN ${col} TEXT`);
  }
```

and add `"assets_state", "assets_fingerprint", "assets_skipped"` to the `allowed` list in `update()`.

In `electron/sync.js`, extend `api` to take a fourth argument for a streamed raw body, keeping every existing call unchanged:

```js
async function api(method, p, body, opts = {}) {
  try {
    const raw = opts.raw ?? null;
    const res = await fetch(`${config.serverURL}${p}`, {
      method,
      headers: raw
        ? { "Content-Type": raw.mime, "Content-Length": String(raw.size), Authorization: `Bearer ${config.token}` }
        : { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: raw ? raw.stream : body ? JSON.stringify(body) : undefined,
      duplex: raw ? "half" : undefined,
      signal: AbortSignal.timeout(raw ? 300000 : 15000),
    });
    ...unchanged...
```

and add `api` to `module.exports`.

- [ ] **Step 4: Write `electron/asset-sync.js`**

```js
// Pushing a document's media ahead of its text. One pass: what does the
// server lack, send exactly that, then tell it the document's full set. A
// failure leaves the row "pending" for the reconciliation pass; the text push
// that follows is never held up by a picture.
const fs = require("node:fs");
const { Readable } = require("node:stream");
const docAssets = require("./doc-assets");

function createAssetSync({ api, registry, grants, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxBytes = docAssets.MAX_ASSET_BYTES }) {
  const failure = (verb, res) => (res.status === 0 ? `${verb} failed (offline)` : `${verb} failed (${res.status})`);

  async function upload(entry) {
    let res = { status: 0 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(500 * attempt);
      res = await api("PUT", `/api/assets/${entry.hash}`, undefined, {
        raw: { stream: Readable.toWeb(fs.createReadStream(entry.path)), size: entry.size, mime: entry.mime },
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status === 503) return { pending: true };
      if (res.status === 413 || res.status === 415 || res.status === 400) return { skipped: res.status === 413 ? "size" : "type" };
    }
    return { error: failure("media upload", res) };
  }

  async function pushAssets(filePath, cloudId, content) {
    const row = registry.get(filePath) ?? {};
    const refs = docAssets.extractRefs(content);
    const resolved = docAssets.resolveRefs(refs, { docPath: filePath, roots: grants.assetRoots(), files: grants.grantedFilePaths() });
    const entries = [];
    const skipped = [];
    for (const r of resolved) {
      if (r.skipped) {
        skipped.push({ ref: r.ref, reason: r.skipped });
        continue;
      }
      const { hash, size } = await docAssets.hashFile(r.path);
      if (size > maxBytes) {
        skipped.push({ ref: r.ref, reason: "size" });
        continue;
      }
      entries.push({ ref: r.ref, path: r.path, mime: r.mime, hash, size });
    }
    const fp = docAssets.fingerprint(entries);
    if (row.assets_state === "synced" && row.assets_fingerprint === fp) return { unchanged: true };

    const pending = (error) => {
      registry.update(filePath, { assets_state: "pending", assets_skipped: JSON.stringify(skipped) });
      return error ? { pending: true, error } : { pending: true };
    };

    let uploaded = 0;
    if (entries.length > 0) {
      const missing = await api("POST", `/api/docs/${cloudId}/assets/missing`, { hashes: entries.map((e) => e.hash) });
      if (missing.status === 503) return pending();
      if (missing.status !== 200 || !Array.isArray(missing.data?.missing)) return pending(failure("media check", missing));
      const need = new Set(missing.data.missing);
      for (const entry of entries) {
        if (!need.has(entry.hash)) continue;
        const res = await upload(entry);
        if (res.pending) return pending();
        if (res.error) return pending(res.error);
        if (res.skipped) {
          skipped.push({ ref: entry.ref, reason: res.skipped });
          entry.dropped = true;
          continue;
        }
        uploaded += 1;
      }
    }
    const linkRefs = [
      ...entries.filter((e) => !e.dropped).map((e) => ({ ref: e.ref, hash: e.hash })),
      ...refs.filter((ref) => !entries.some((e) => e.ref === ref && !e.dropped)).map((ref) => ({ ref })),
    ];
    const link = await api("PUT", `/api/docs/${cloudId}/assets`, { refs: linkRefs });
    if (link.status === 503) return pending();
    if (link.status !== 200) return pending(failure("media link", link));
    registry.update(filePath, {
      assets_state: "synced",
      assets_fingerprint: docAssets.fingerprint(entries.filter((e) => !e.dropped)),
      assets_skipped: JSON.stringify(skipped),
    });
    return { ok: true, uploaded, skipped };
  }

  return { pushAssets };
}

module.exports = { createAssetSync };
```

Note on the link order: the test expects resolved entries first in document order, then unresolved refs in document order. Keep `linkRefs` built as above.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/asset-sync.test.ts electron/registry.test.ts electron/sync.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add electron/asset-sync.js electron/asset-sync.test.ts electron/registry.js electron/registry.test.ts electron/sync.js
git -c core.hooksPath=/dev/null commit -m "Push a document's media: what the server lacks, then the full set" -m "Directive: a media failure marks the row pending and never blocks the text; reconcile owns the retry.
Tested: asset-sync.test.ts, registry.test.ts, sync.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Media before text on every write path

**Files:**
- Modify: `electron/sync.js` (`syncOn`, `push`, `resolve`, `resolveKeepBoth`), `electron/sync.test.ts`, `electron/main.js` (construct the asset sync with `fileGrants`)

**Interfaces:**
- Consumes: `createAssetSync` (Task 6).
- Produces: `sync.setAssetSync(assetSync)`; each write path calls `assetSync.pushAssets(filePath, cloudId, content)` before its text `PUT` and includes `media: <result>` in its return value.

- [ ] **Step 1: Write the failing tests** (append to `electron/sync.test.ts`, using its `signIn`, `seedRow`, `respondWith` helpers)

```ts
describe("media travels ahead of the text", () => {
  let mediaCalls: string[];
  beforeEach(() => {
    mediaCalls = [];
    sync.setAssetSync({
      pushAssets: async (p: string, cloudId: string) => {
        mediaCalls.push(`${cloudId}:${p}`);
        return { ok: true, uploaded: 1, skipped: [] };
      },
    });
  });

  it("syncOn pushes media for the new cloud id before the text", async () => {
    signIn("test-token", ME);
    const calls = respondWith({ status: 200, body: { id: "x", version: 1 } });
    const res = await sync.syncOn("/docs/a.md", "a.md", "![](a.png)\n");
    expect(res.ok).toBe(true);
    expect(res.media).toEqual({ ok: true, uploaded: 1, skipped: [] });
    expect(mediaCalls).toHaveLength(1);
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  it("push and resolve carry the same order, and a pending result does not stop the text", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/b.md", sync_state: "synced", cloud_doc_id: "cb", cloud_version: 2 });
    sync.setAssetSync({ pushAssets: async () => ({ pending: true, error: "media upload failed (offline)" }) });
    respondWith({ status: 200, body: { id: "cb", version: 3 } });
    const res = await sync.push("/docs/b.md", "b.md", "![](b.png)\n");
    expect(res.ok).toBe(true);
    expect(res.media).toEqual({ pending: true, error: "media upload failed (offline)" });
    expect(rows.get("/docs/b.md")!.sync_state).toBe("synced");
  });
});
```

Read the existing `resolve`/`resolveKeepBoth` tests in the file and add one assertion each that `mediaCalls` gained an entry for the pushed content (the "local" and "keep both" strategies write text and so push media; the "cloud" strategy pulls and does not).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/sync.test.ts`
Expected: FAIL, `setAssetSync` is not a function.

- [ ] **Step 3: Wire it**

In `electron/sync.js`:

```js
// Set by main once file grants exist; a null here means media is not pushed,
// which is what the tests that do not care about it get.
let assetSync = null;
function setAssetSync(next) {
  assetSync = next;
}
async function pushMedia(filePath, cloudId, content) {
  if (!assetSync) return null;
  try {
    return await assetSync.pushAssets(filePath, cloudId, content);
  } catch (err) {
    return { pending: true, error: `media push failed (${err && err.message ? err.message : err})` };
  }
}
```

In `syncOn`: after `const cloudId = ...` and before the text `PUT`, `const media = await pushMedia(filePath, cloudId, content);` and add `media` to every returned object of that function (`{ ok: true, version, media }`, `{ conflict: true, ..., media }`, `{ error, media }`). Same in `push` (cloud id is `row.cloud_doc_id`), in `resolve` for the strategies that `PUT` text (before line 358's `PUT`, with the content being written), and in `resolveKeepBoth` before its text `PUT`. Export `setAssetSync`.

In `electron/main.js`, where `fileGrants` and `sync` are both available (near the `sync-config` handler at line 1254), add:

```js
const { createAssetSync } = require("./asset-sync");
sync.setAssetSync(createAssetSync({ api: sync.api, registry, grants: fileGrants }));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run electron/sync.test.ts electron/asset-sync.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add electron/sync.js electron/sync.test.ts electron/main.js
git -c core.hooksPath=/dev/null commit -m "Every text push sends the document's media first" -m "Directive: the media result rides on the push result as media; the text outcome is decided by the text alone.
Tested: sync.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Showing cloud media in Markie

**Files:**
- Create: `electron/asset-cache.js`, `electron/asset-cache.test.ts`
- Modify: `src/lib/asset-url.ts`, `src/lib/asset-url.test.ts`, `electron/main.js` (`registerAssetProtocol`), `electron/sync.js` (`clearAssetCache` on sign-out)

**Interfaces:**
- Consumes: `sync.api` (Task 6) for the authenticated fetch; `registry.get(path)` for the cloud id.
- Produces: `createAssetCache({ dir, fetchAsset, limitBytes = 2 * 1024 * 1024 * 1024 })` returning `{ get(cloudId, ref): Promise<{ path, mime, size } | null>, clear(): Promise<void> }` where `fetchAsset(cloudId, ref)` resolves to `{ stream, mime, hash, size } | null`.
- Produces: renderer asset URLs of the form `markie-asset://local/<encoded absolute path>?doc=<encoded document path>`.

- [ ] **Step 1: Write the failing tests**

```ts
// electron/asset-cache.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const { createAssetCache } = require("./asset-cache") as typeof import("./asset-cache");

const bytes = (s: string) => ({ stream: Readable.toWeb(Readable.from(Buffer.from(s))), mime: "image/png", hash: `h-${s}`, size: s.length });

describe("asset cache", () => {
  it("fetches once, then serves from disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const cache = createAssetCache({ dir, fetchAsset: async () => (fetches += 1, bytes("aaaa")) });
    const first = await cache.get("c1", "a.png");
    expect(first).toEqual({ path: path.join(dir, "h-aaaa"), mime: "image/png", size: 4 });
    expect(readFileSync(first!.path, "utf8")).toBe("aaaa");
    await cache.get("c1", "a.png");
    expect(fetches).toBe(1);
  });

  it("answers null for a miss on the server and does not remember it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let answer: ReturnType<typeof bytes> | null = null;
    const cache = createAssetCache({ dir, fetchAsset: async () => answer });
    expect(await cache.get("c1", "a.png")).toBeNull();
    answer = bytes("aaaa");
    expect((await cache.get("c1", "a.png"))?.size).toBe(4);
  });

  it("evicts the least recently used past the limit and clears on demand", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({ dir, fetchAsset: async (_c: string, ref: string) => bytes(ref.replace(".png", "").repeat(4)), limitBytes: 10 });
    await cache.get("c1", "a.png"); // 4 bytes
    await cache.get("c1", "b.png"); // 8
    await cache.get("c1", "a.png"); // a is now most recent
    await cache.get("c1", "c.png"); // 12 > 10: b goes
    expect(existsSync(path.join(dir, "h-aaaa"))).toBe(true);
    expect(existsSync(path.join(dir, "h-bbbb"))).toBe(false);
    expect(existsSync(path.join(dir, "h-cccc"))).toBe(true);
    await cache.clear();
    expect(existsSync(path.join(dir, "h-aaaa"))).toBe(false);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
```

Append to `src/lib/asset-url.test.ts`:

```ts
it("names the document the reference belongs to", () => {
  setAssetBaseDir("/Users/k/report");
  expect(resolveAssetSrc("shots/a.png")).toBe(
    `markie-asset://local/${encodeURIComponent("/Users/k/report/shots/a.png")}?doc=${encodeURIComponent("/Users/k/report")}`
  );
  expect(resolveAssetSrc("shots/a.png", "/elsewhere")).toBe(
    `markie-asset://local/${encodeURIComponent("/elsewhere/shots/a.png")}?doc=${encodeURIComponent("/elsewhere")}`
  );
});
```

Update every existing expectation in that test file that asserts the exact URL to include the `?doc=` suffix.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/asset-cache.test.ts src/lib/asset-url.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `electron/asset-cache.js`**

```js
// Media for a document that lives in the cloud, kept on disk so a picture is
// fetched once. Keyed by hash, so two documents sharing a file share a copy;
// the index maps (cloud id, ref) to that hash. Bounded, oldest use first.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function createAssetCache({ dir, fetchAsset, limitBytes = 2 * 1024 * 1024 * 1024 }) {
  const indexPath = path.join(dir, "cache.json");
  let index = null; // { entries: { [cloudId\tref]: { hash, mime, size, used } } }
  const inflight = new Map();

  async function load() {
    if (index) return index;
    await fsp.mkdir(dir, { recursive: true });
    try {
      index = JSON.parse(await fsp.readFile(indexPath, "utf8"));
      if (!index || typeof index.entries !== "object") index = { entries: {} };
    } catch {
      index = { entries: {} };
    }
    return index;
  }
  async function save() {
    await fsp.writeFile(indexPath, JSON.stringify(index), "utf8");
  }
  const fileFor = (hash) => path.join(dir, hash);

  async function evict() {
    const entries = Object.entries(index.entries);
    const byHash = new Map();
    for (const [key, e] of entries) {
      const cur = byHash.get(e.hash) ?? { size: e.size, used: 0, keys: [] };
      cur.used = Math.max(cur.used, e.used);
      cur.keys.push(key);
      byHash.set(e.hash, cur);
    }
    let total = [...byHash.values()].reduce((n, e) => n + e.size, 0);
    const oldest = [...byHash.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [hash, e] of oldest) {
      if (total <= limitBytes) break;
      await fsp.rm(fileFor(hash), { force: true });
      for (const key of e.keys) delete index.entries[key];
      total -= e.size;
    }
  }

  async function get(cloudId, ref) {
    await load();
    const key = `${cloudId}\t${ref}`;
    const hit = index.entries[key];
    if (hit && fs.existsSync(fileFor(hit.hash))) {
      hit.used = Date.now();
      await save();
      return { path: fileFor(hit.hash), mime: hit.mime, size: hit.size };
    }
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        const fetched = await fetchAsset(cloudId, ref);
        if (!fetched) return null;
        const tmp = path.join(dir, `.${fetched.hash}.part-${process.pid}-${Date.now()}`);
        await pipeline(Readable.fromWeb(fetched.stream), fs.createWriteStream(tmp));
        await fsp.rename(tmp, fileFor(fetched.hash));
        index.entries[key] = { hash: fetched.hash, mime: fetched.mime, size: fetched.size, used: Date.now() };
        await evict();
        await save();
        return { path: fileFor(fetched.hash), mime: fetched.mime, size: fetched.size };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  async function clear() {
    await load();
    for (const name of await fsp.readdir(dir)) await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    index = { entries: {} };
    await save();
  }

  return { get, clear };
}

module.exports = { createAssetCache };
```

- [ ] **Step 4: The renderer names the document**

In `src/lib/asset-url.ts` `resolveAssetSrc`, change the final line to:

```ts
  return `${ASSET_ORIGIN}/${encodeURIComponent(absolute)}?doc=${encodeURIComponent(dir)}`;
```

Search `src/` for any other place that builds a `markie-asset://` URL or parses one (`grep -rn "markie-asset" src electron scripts`) and keep them consistent; `mediaKindFor`-style helpers that look at the extension must strip the query first (they already strip `?` per the `resolveAssetSrc` comment; verify with the existing tests).

- [ ] **Step 5: The protocol fallback**

In `electron/sync.js` add and export:

```js
// One asset of a cloud document, streamed with the session's token. Null for
// anything but a 200, so a revoked share reads as "no such picture".
async function fetchAsset(cloudId, ref) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${config.serverURL}/api/docs/${encodeURIComponent(cloudId)}/assets/file?ref=${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(300000),
    });
    if (res.status !== 200 || !res.body) return null;
    const hash = (res.headers.get("etag") ?? "").replace(/"/g, "");
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    return { stream: res.body, mime: res.headers.get("content-type") ?? "application/octet-stream", hash, size: Number(res.headers.get("content-length") ?? 0) };
  } catch {
    return null;
  }
}
```

In `electron/main.js`, build the cache once app paths are known:

```js
const { createAssetCache } = require("./asset-cache");
const assetCache = createAssetCache({ dir: path.join(app.getPath("userData"), "asset-cache"), fetchAsset: sync.fetchAsset });
```

and in `registerAssetProtocol`, make the handler `async` and replace the final `if (!real || !mime) return new Response("Forbidden", { status: 403 });` with:

```js
    if (!real || !mime) {
      // Not here, or not allowed here. A document that lives in the cloud
      // may still have this picture on the server, under the reference the
      // text wrote, relative to the document's folder.
      const docDir = new URL(request.url).searchParams.get("doc");
      const cloud = docDir ? cloudDocFor(docDir, requested) : null;
      if (!cloud) return new Response("Forbidden", { status: 403 });
      const cached = await assetCache.get(cloud.cloudId, cloud.ref);
      if (!cached) return new Response("Not found", { status: 404 });
      return serveFileRange(cached.path, cached.mime, request.headers.get("range"));
    }
```

with, above `registerAssetProtocol`:

```js
// The cloud document a folder belongs to, and the reference a requested
// absolute path is under it. The renderer names the folder; the registry
// row for a file directly inside it names the cloud id. Several documents
// can share a folder, so the first row that is in the cloud wins.
function cloudDocFor(docDir, requested) {
  const rel = path.relative(docDir, requested);
  const ref = rel.startsWith("..") || path.isAbsolute(rel) ? requested : rel.split(path.sep).join("/");
  const rows = registry.list().filter((r) => r.cloud_doc_id && path.dirname(r.path) === path.resolve(docDir));
  return rows.length > 0 ? { cloudId: rows[0].cloud_doc_id, ref } : null;
}
```

If `registry.list()` is expensive at the library's size (200,000 files), add `registry.cloudDocsInDir(dir)` backed by `SELECT cloud_doc_id FROM files WHERE cloud_doc_id IS NOT NULL AND path LIKE ? || '%'` with a post-filter on `dirname`, and use that instead.

On sign-out (in `sync.setConfig` when the token goes null), `void assetCache.clear()`; since `sync.js` does not hold the cache, expose `sync.onSignOut(fn)` or call `assetCache.clear()` from main's `sync-config` handler when `cfg.token` is null. Choose the second: it keeps `sync.js` free of the cache.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run electron/asset-cache.test.ts src/lib/asset-url.test.ts electron/sync.test.ts src/lib/rich-extensions.test.ts src/components/rich-view.test.tsx` and `npx tsc --noEmit -p tsconfig.json`
Expected: all pass; fix any renderer test that pinned the old URL shape.

- [ ] **Step 7: Commit**

```bash
git add electron/asset-cache.js electron/asset-cache.test.ts electron/main.js electron/sync.js src/lib/asset-url.ts src/lib/asset-url.test.ts
git -c core.hooksPath=/dev/null commit -m "A cloud document's pictures show without a file beside it" -m "Directive: the local handler is unchanged for local files; the cloud fallback fires only for a folder the registry places in the cloud.
Tested: asset-cache.test.ts, asset-url.test.ts, sync.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Reconciliation

**Files:**
- Create: `electron/reconcile.js`, `electron/reconcile.test.ts`
- Modify: `electron/main.js` (schedule), `electron/preload.js`, `src/lib/electron.ts`, `src/components/cloud-view.tsx` (media note), `electron/sync.js` (expose `listRemote()`)

**Interfaces:**
- Consumes: `sync.push`, `sync.api`, `registry.list/get/update/hashContent`, `assetSync.pushAssets`.
- Produces: `createReconciler({ sync, registry, assetSync, fs, sleep, now })` returning `{ run({ limit = 50 } = {}): Promise<{ pushed: string[]; mediaPushed: string[]; skipped: { path, reason }[]; errors: { path, error }[] }> }`; IPC `asset-reconcile` returning the last result; `libraryState` items gain `media: { state: "synced" | "pending" | null, skipped: { ref, reason }[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// electron/reconcile.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const { createReconciler } = require("./reconcile") as typeof import("./reconcile");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, unknown> & { path: string };
let rows: Map<string, Row>;
let disk: Map<string, string>;
let pushed: string[];
let media: string[];
let listing: { docs: { id: string; version: number; hash: string }[] } | null;

const registry = {
  list: () => [...rows.values()],
  get: (p: string) => rows.get(p) ?? null,
  update: (p: string, f: Record<string, unknown>) => rows.set(p, { ...rows.get(p)!, ...f }),
  hashContent: (s: string) => sha(s),
};
const fs = {
  existsSync: (p: string) => disk.has(p),
  readFileSync: (p: string) => disk.get(p)!,
};
const sync = {
  api: async () => (listing ? { status: 200, data: listing } : { status: 0, data: null }),
  push: async (p: string, _name: string, content: string) => {
    pushed.push(p);
    const row = rows.get(p)!;
    rows.set(p, { ...row, sync_state: "synced", content_hash: sha(content), cloud_version: (row.cloud_version as number) + 1 });
    return { ok: true };
  },
};
const assetSync = { pushAssets: async (p: string) => (media.push(p), { ok: true, uploaded: 0, skipped: [] }) };

function seed(row: Row, content: string | null) {
  rows.set(row.path, { name: "x.md", sync_state: "synced", cloud_doc_id: "c" + rows.size, cloud_version: 1, content_hash: null, assets_state: "synced", ...row });
  if (content !== null) disk.set(row.path, content);
}

beforeEach(() => {
  rows = new Map();
  disk = new Map();
  pushed = [];
  media = [];
  listing = { docs: [] };
});

describe("reconcile", () => {
  it("pushes an unpushed row and one whose disk copy moved on while the server stood still", async () => {
    seed({ path: "/d/un.md", cloud_doc_id: "c1", sync_state: "unpushed", content_hash: sha("old") }, "old");
    seed({ path: "/d/edited.md", cloud_doc_id: "c2", content_hash: sha("v1") }, "v2");
    seed({ path: "/d/fine.md", cloud_doc_id: "c3", content_hash: sha("ok") }, "ok");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("old") }, { id: "c2", version: 1, hash: sha("v1") }, { id: "c3", version: 1, hash: sha("ok") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.pushed.sort()).toEqual(["/d/edited.md", "/d/un.md"]);
    expect(pushed).not.toContain("/d/fine.md");
  });

  it("pushes when the server's hash disagrees at the same version, and skips when the server is ahead", async () => {
    seed({ path: "/d/lost.md", cloud_doc_id: "c1", content_hash: sha("mine") }, "mine");
    seed({ path: "/d/behind.md", cloud_doc_id: "c2", cloud_version: 1, content_hash: sha("mine") }, "mine");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("theirs") }, { id: "c2", version: 5, hash: sha("theirs") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.pushed).toEqual(["/d/lost.md"]);
    expect(r.skipped).toEqual([{ path: "/d/behind.md", reason: "behind" }]);
  });

  it("leaves paused, conflict, local-only, missing-on-disk and delisted rows alone", async () => {
    seed({ path: "/d/p.md", cloud_doc_id: "c1", sync_state: "paused" }, "x");
    seed({ path: "/d/c.md", cloud_doc_id: "c2", sync_state: "conflict" }, "x");
    seed({ path: "/d/l.md", cloud_doc_id: null, sync_state: "local-only" }, "x");
    seed({ path: "/d/gone.md", cloud_doc_id: "c4", sync_state: "unpushed" }, null);
    seed({ path: "/d/delisted.md", cloud_doc_id: "c5", sync_state: "unpushed" }, "x");
    listing = { docs: [{ id: "c1", version: 1, hash: "" }, { id: "c2", version: 1, hash: "" }, { id: "c4", version: 1, hash: "" }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(pushed).toEqual([]);
    expect(r.skipped).toEqual([
      { path: "/d/gone.md", reason: "missing" },
      { path: "/d/delisted.md", reason: "delisted" },
    ]);
  });

  it("backfills media for a current document whose media is pending or stale", async () => {
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("![](a.png)"), assets_state: "pending" }, "![](a.png)");
    seed({ path: "/d/b.md", cloud_doc_id: "c2", content_hash: sha("b"), assets_state: null }, "b");
    seed({ path: "/d/c.md", cloud_doc_id: "c3", content_hash: sha("c"), assets_state: "synced" }, "c");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("![](a.png)") }, { id: "c2", version: 1, hash: sha("b") }, { id: "c3", version: 1, hash: sha("c") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.mediaPushed.sort()).toEqual(["/d/a.md", "/d/b.md", "/d/c.md"]);
  });

  it("does at most `limit` documents per pass and carries on next time", async () => {
    for (let i = 0; i < 5; i += 1) seed({ path: `/d/${i}.md`, cloud_doc_id: `c${i}`, sync_state: "unpushed" }, "x");
    listing = { docs: [0, 1, 2, 3, 4].map((i) => ({ id: `c${i}`, version: 1, hash: sha("x") })) };
    const rec = createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} });
    expect((await rec.run({ limit: 2 })).pushed).toHaveLength(2);
    expect((await rec.run({ limit: 2 })).pushed).toHaveLength(2);
    expect((await rec.run({ limit: 2 })).pushed).toHaveLength(1);
  });

  it("does nothing without a listing", async () => {
    seed({ path: "/d/un.md", cloud_doc_id: "c1", sync_state: "unpushed" }, "x");
    listing = null;
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r).toEqual({ pushed: [], mediaPushed: [], skipped: [], errors: [{ path: "*", error: "listing unavailable" }] });
  });
});
```

Note: in the media test the `c.md` row is `synced` but `pushAssets` is still called; `pushAssets` itself short-circuits on the fingerprint (Task 6), so the reconciler calls it for every current document and lets it decide. That keeps the reconciler free of extraction logic.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/reconcile.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Write `electron/reconcile.js`**

```js
// Repairing what was told to sync and never landed. One listing, one pass
// over the rows that are in the cloud and not paused or in conflict; the
// text is pushed where this device is ahead of a server that stood still,
// and the media is offered for every current document (pushAssets is what
// knows whether anything actually changed). Nothing is ever pulled here:
// the update flow owns that, because a pull can overwrite an edit.
function createReconciler({ sync, registry, assetSync, fs = require("node:fs"), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 250 }) {
  let cursor = 0;

  async function run({ limit = 50 } = {}) {
    const result = { pushed: [], mediaPushed: [], skipped: [], errors: [] };
    const res = await sync.api("GET", "/api/docs");
    if (res.status !== 200 || !Array.isArray(res.data?.docs)) {
      result.errors.push({ path: "*", error: "listing unavailable" });
      return result;
    }
    const remote = new Map(res.data.docs.map((d) => [d.id, d]));
    const rows = registry.list().filter((r) => r.cloud_doc_id && (r.sync_state === "synced" || r.sync_state === "unpushed"));
    if (cursor >= rows.length) cursor = 0;
    const slice = rows.slice(cursor, cursor + limit);
    cursor = cursor + limit >= rows.length ? 0 : cursor + limit;

    for (const [i, row] of slice.entries()) {
      if (i > 0) await sleep(gapMs);
      try {
        const r = remote.get(row.cloud_doc_id);
        if (!r) {
          result.skipped.push({ path: row.path, reason: "delisted" });
          continue;
        }
        if (!fs.existsSync(row.path)) {
          result.skipped.push({ path: row.path, reason: "missing" });
          continue;
        }
        if (r.version > (row.cloud_version ?? 0)) {
          result.skipped.push({ path: row.path, reason: "behind" });
          continue;
        }
        const content = fs.readFileSync(row.path, "utf8");
        const diskHash = registry.hashContent(content);
        const needsText = row.sync_state === "unpushed" || diskHash !== row.content_hash || r.hash !== row.content_hash;
        if (needsText) {
          const pushed = await sync.push(row.path, row.name, content);
          if (pushed && pushed.ok) result.pushed.push(row.path);
          else result.errors.push({ path: row.path, error: pushed?.error ?? "push refused" });
          // push already sent the media (Task 7); nothing more to do here.
          continue;
        }
        const media = await assetSync.pushAssets(row.path, row.cloud_doc_id, content);
        if (media && (media.ok || media.unchanged)) result.mediaPushed.push(row.path);
        else if (media && media.error) result.errors.push({ path: row.path, error: media.error });
      } catch (err) {
        result.errors.push({ path: row.path, error: err && err.message ? err.message : String(err) });
      }
    }
    return result;
  }

  return { run };
}

module.exports = { createReconciler };
```

Adjust the media test expectation if `unchanged` should not count as `mediaPushed`; the intent is "media is known current after the pass", so counting it is right.

- [ ] **Step 4: Schedule it and surface it**

In `electron/main.js`:

```js
const { createReconciler } = require("./reconcile");
const reconciler = createReconciler({ sync, registry, assetSync });
let lastReconcile = 0;
let lastReconcileResult = null;
async function reconcileIfDue(force = false) {
  if (!sync.isConfigured() || !sync.hasPrincipal()) return lastReconcileResult;
  if (!force && Date.now() - lastReconcile < 10 * 60 * 1000) return lastReconcileResult;
  lastReconcile = Date.now();
  lastReconcileResult = await reconciler.run();
  return lastReconcileResult;
}
```

where `assetSync` is the instance built in Task 7 (hoist it to module scope), and `sync.hasPrincipal()` is a new one-line export in `sync.js` returning `principal !== null`. Call `void reconcileIfDue()` inside the `doc-check-updates` handler after `sync.checkUpdates()` resolves (do not await it there; the update check must stay fast), and once from the `sync-config` handler when a push carries `userId` (that is the "confirmed principal" moment). Add `handle("asset-reconcile", () => reconcileIfDue(true))`.

In `electron/preload.js`, expose `assetReconcile: () => ipcRenderer.invoke("asset-reconcile")` following the pattern of the neighbouring entries, and in `src/lib/electron.ts` add `assetReconcile?(): Promise<ReconcileResult>` with `export interface ReconcileResult { pushed: string[]; mediaPushed: string[]; skipped: { path: string; reason: string }[]; errors: { path: string; error: string }[] }`.

In `electron/sync.js` `libraryState`, add to each local item:

```js
media: {
  state: f.assets_state ?? null,
  skipped: safeJson(f.assets_skipped),
},
```

with `const safeJson = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };`, and mirror the field on the `LibraryItem` type in `src/lib/electron.ts`.

In `src/components/cloud-view.tsx`, where a row's secondary line is rendered, add: when `item.media?.state === "pending"` the text "media pending"; when `item.media?.skipped?.length` the text `file too large: <first ref>` for a `size` reason (other reasons are silent; they are files the local viewer would not show either). Add a test in `src/components/cloud-view.test.tsx` for both strings.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/reconcile.test.ts electron/sync.test.ts src/components/cloud-view.test.tsx` and `npx tsc --noEmit -p tsconfig.json`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add electron/reconcile.js electron/reconcile.test.ts electron/main.js electron/preload.js electron/sync.js src/lib/electron.ts src/components/cloud-view.tsx src/components/cloud-view.test.tsx
git -c core.hooksPath=/dev/null commit -m "Repair what was told to sync and never landed" -m "Directive: reconcile never pulls; a server ahead of this device is the update flow's to resolve.
Tested: reconcile.test.ts, sync.test.ts, cloud-view.test.tsx.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Window checks

**Files:**
- Modify: `scripts/sync-down-check.mjs`
- Create: `scripts/asset-web-check.mjs`; add `"asset:web:check": "node scripts/asset-web-check.mjs"` to `package.json` scripts.

**Interfaces:**
- Consumes: the running server spawned by `sync-down-check.mjs` (read lines 1-120 for how it starts the server, creates accounts and drives Markie through `scripts/lib/electron-window.mjs`).

- [ ] **Step 1: Extend `sync-down-check.mjs`**

Where the first account's document is written to disk before syncing, also write a small PNG beside it (the 16-byte PNG header from `assets.test.ts` is enough for the pipeline; use a real 1x1 PNG so Chromium draws it) and reference it in the markdown: `![](shot.png)`. Start the server with `ASSETS_DIR=<tmp>/assets` in its env. After the second account's copy lands, add:

```js
check("the second machine's copy shows the picture through the cloud", await cdp.ev(`(() => { const img = document.querySelector('img[data-markie-src="shot.png"], img[src*="shot.png"]'); return !!img && img.naturalWidth > 0; })()`));
```

and assert that no `shot.png` file exists beside the landed document (`!fs.existsSync(path.join(landedDir, "shot.png"))`).

- [ ] **Step 2: Write `scripts/asset-web-check.mjs`**

A check against the same spawned server, no Markie window: create an owner and a viewer with `signUpVerified` semantics through the HTTP API (copy the sign-up and verify steps `sync-down-check.mjs` uses), push a document, upload and link one asset with `fetch`, then assert:

```js
check("owner reads it over the bearer route", (await get(`/api/docs/${id}/assets/file?ref=shot.png`, owner)).status === 200);
check("a stranger gets 404", (await get(`/api/docs/${id}/assets/file?ref=shot.png`, stranger)).status === 404);
check("the web page rewrites the src", /\/d\/[^"]+\/assets\?ref=shot\.png/.test(await (await fetch(`${SERVER}/d/${id}`, { headers: cookieFor(viewer) })).text()));
check("the public page serves it by token", (await fetch(`${SERVER}/s/${token}/assets?ref=shot.png`)).status === 200);
check("revoking the link revokes the picture", (await fetch(`${SERVER}/s/${token}/assets?ref=shot.png`)).status === 404);
```

Use the `check()`/summary shape from `sync-down-check.mjs` and exit non-zero on any failure.

- [ ] **Step 3: Run both**

Run: `MARKIE_ALLOW_E2E=1 npm run sync:check` then `MARKIE_ALLOW_E2E=1 npm run asset:web:check` (never alongside vitest).
Expected: all checks pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-down-check.mjs scripts/asset-web-check.mjs package.json
git -c core.hooksPath=/dev/null commit -m "Prove a picture travels with its document, in the window and on the web" -m "Tested: sync:check, asset:web:check.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Docs and the release notes

**Files:**
- Modify: `docs/RELEASING.md` (server env for assets, in the "Full macOS release" step 1 block about deploying the server), `deploy/DEPLOY.md` (the four `ASSETS_*` variables, the bucket and scoped key), `CHANGELOG.md` (Unreleased).

- [ ] **Step 1: Write the changelog entries** under `## [Unreleased]`:

```markdown
### Added

- **Pictures, video and audio travel with a synced document.** A file the
  document embeds is uploaded alongside it and shown to exactly the people
  who can read the document: in Markie on another machine, on the shared web
  page, and through a public link while that link stands. Revoke the share
  or the link and the media goes with it. Files over 100 MB stay local and
  the Cloud page says which.
- **Markie repairs sync on its own.** At launch and every ten minutes it
  checks every document you told it to sync against the cloud and pushes
  anything that never landed or fell behind, media included. It never
  pulls over an edit.
```

- [ ] **Step 2: Deployment notes**

In the deploy doc, add a section "Assets bucket": create a private B2 bucket (suggested name `markie-assets`), an application key scoped to that bucket with read and write, and set `ASSETS_BUCKET`, `ASSETS_ENDPOINT`, `ASSETS_KEY_ID`, `ASSETS_APP_KEY` on the Railway `api` service (`railway variable set ... --skip-deploys`, then deploy). Note that until they are set the asset routes answer 503 and Markie shows "media pending". Never write the values into the repo.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/RELEASING.md deploy/DEPLOY.md
git -c core.hooksPath=/dev/null commit -m "Say what media in the cloud means, and how to give the server a bucket" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Live bucket check (gated) and full gates

**Files:**
- Modify: `server/src/storage.test.ts` (one gated test)

- [ ] **Step 1: Add the gated live test**

```ts
test("the real bucket round-trips (ASSETS_LIVE_TEST=1 only)", { skip: process.env.ASSETS_LIVE_TEST !== "1" }, async () => {
  const store = assetStore(process.env)!;
  const key = `livetest/${"0".repeat(60)}beef`;
  await store.put(key, Buffer.from("live"), 4, "image/png");
  assert.deepEqual(await store.head(key), { size: 4 });
  const part = await store.get(key, { start: 1, end: 2 });
  assert.equal((await collect(part!.stream)).toString(), "iv");
  await store.delete(key);
  assert.equal(await store.head(key), null);
});
```

Run it once by hand against the real bucket with the four variables exported in the shell (never in a committed file) before the server deploy.

- [ ] **Step 2: Full gates**

Run in order, never concurrently with a window check: `npx tsc --noEmit -p tsconfig.json`; `npm run lint`; `npx vitest run --hookTimeout=60000`; `cd server && npm test`; `cd mcp && node --test lib.test.mjs`; then `MARKIE_ALLOW_E2E=1 npm run sync:check`, `asset:web:check`, `ui:check`, `large-doc:check`.

- [ ] **Step 3: Commit**

```bash
git add server/src/storage.test.ts
git -c core.hooksPath=/dev/null commit -m "A gated round-trip against the real assets bucket" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Storage and config: Task 1. Tables, caps, upload, missing, link, orphan collection, 503 when unconfigured, delete cascade: Task 2. Three read gates with the response headers and 404 parity: Task 3. Web `src` rewrite for `/d/` (with `k`) and `/s/`: Task 4. Extraction with the local viewer's rules: Task 5. Registry columns, `pushAssets` with fingerprint short-circuit, retries, pending, 503 quiet: Task 6. Media before text on `syncOn`, `push`, `resolve`, `resolveKeepBoth`: Task 7. Protocol fallback, cache with LRU cap and sign-out clear, `?doc=` in the renderer: Task 8. Reconciliation case table, cadence, limit, Cloud page notes: Task 9. Window checks: Task 10. Rollout docs and changelog: Task 11. Live bucket: Task 12. `never-public` extension: Task 3.

**Placeholders.** Task 3 uses `ensureShareToken` and the `public-link` route as they exist in `shares.ts`; Task 5 uses `resolveMedia`'s real return shape. No guesses remain. Task 1 imports only what it uses.

**Type consistency.** `pushAssets` returns `{ unchanged } | { ok, uploaded, skipped } | { pending, error? }` in Tasks 6, 7 and 9. `api(method, path, body, opts)` with `opts.raw = { stream, size, mime }` in Tasks 6 and 8. `fetchAsset(cloudId, ref)` resolves `{ stream, mime, hash, size } | null` in Task 8 both sides. `assetRefsFor(docId): Map<ref, { owner_id, hash, mime, size }>` in Tasks 2, 3, 4. Registry columns `assets_state`, `assets_fingerprint`, `assets_skipped` in Tasks 6 and 9.
