// Where asset bytes live. Two stores behind one interface: a directory for
// tests and local development, and an S3-compatible bucket (Backblaze B2 in
// production) reached through a small in-house SigV4 signer so the server
// keeps its zero-SDK dependency list. Switching to @aws-sdk/client-s3 later
// is a change to this file alone.
import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
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
      const full = pathFor(key);
      try {
        return { size: (await stat(full)).size };
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
