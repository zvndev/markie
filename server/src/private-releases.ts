/** Standalone private transport. Never import the public app, auth or database here. */
import { Hono } from "hono";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";

export const MAX_PRIVATE_RELEASE_BYTES = 512 * 1024 * 1024;
const MAX_FEED_BYTES = 64 * 1024, MAX_AUTH_BYTES = 32 * 1024;
const PREFIX = "/private-releases/super-nightly/";
const FEEDS = new Set(["super-nightly.yml", "super-nightly-mac.yml"]);
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-super-nightly(?:\.[0-9A-Za-z-]+)+$/;
const HASH = /^[A-Za-z0-9+/]{86}==$/;
const MAX_AUTH_IN_FLIGHT = 8, MAX_AUTH_PER_MINUTE = 60, MAX_NEGATIVE_AUTH_ENTRIES = 256;
export interface PrivateReleaseConfig {
  enabled: boolean;
  root: string;
  ownerId: string;
  /** Trusted deployment configuration ONLY. HTTPS origin, no path/query/userinfo. */
  authOrigin: string;
  publishKey: string;
}
interface Options extends PrivateReleaseConfig {
  /** Test seam; deployment uses the built-in HTTPS fetch. */
  fetch?: typeof globalThis.fetch;
  /** May lower the hard cap for tests, never raise it. */
  maxArtifactBytes?: number;
}
export function privateReleaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateReleaseConfig {
  return {
    enabled: env.PRIVATE_RELEASE_ENABLED === "true", root: env.PRIVATE_RELEASE_ROOT ?? "",
    ownerId: env.PRIVATE_RELEASE_OWNER_ID ?? "", authOrigin: env.PRIVATE_RELEASE_AUTH_ORIGIN ?? "",
    publishKey: env.PRIVATE_RELEASE_PUBLISH_KEY ?? "",
  };
}
function authEndpoint(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return `${url.origin}/api/auth/get-session`;
  } catch { return null; }
}
function artifactVersion(name: string): string | null {
  if (name.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) return null;
  if (!/\.(?:zip|dmg)(?:\.blockmap)?$/.test(name)) return null;
  const stem = name.replace(/\.(?:zip|dmg)(?:\.blockmap)?$/, "").replace(/-mac$/, "").replace(/-(?:arm64|x64|universal)$/, "");
  const match = /-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-super-nightly(?:\.[0-9A-Za-z-]+)+)$/.exec(stem);
  return match && VERSION.test(match[1]) ? match[1] : null;
}
function validName(name: string): boolean { return FEEDS.has(name) || artifactVersion(name) !== null; }
function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
function validPublishKey(key: string): boolean {
  // 32 random bytes encoded as hex or base64url. Reject visibly trivial secrets.
  return key.length <= 256 && /^(?:[a-fA-F0-9]{64,}|[A-Za-z0-9_-]{43,})$/.test(key) && new Set(key).size >= 12;
}
async function boundedBody(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > max) throw new Error("bounded body");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function requireOwner(request: Request, config: Options, endpoint: string): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(authorization)) return false;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await (config.fetch ?? globalThis.fetch)(endpoint, {
      method: "GET", headers: { authorization, accept: "application/json" }, redirect: "error", cache: "no-store", signal: controller.signal,
    });
    if (!response.ok || response.redirected) { await response.body?.cancel(); return false; }
    const session = JSON.parse((await boundedBody(response.body, MAX_AUTH_BYTES)).toString("utf8"));
    return session?.user?.id === config.ownerId && session.user.emailVerified === true &&
      session?.session?.userId === config.ownerId && typeof session.session.expiresAt === "string" &&
      Date.parse(session.session.expiresAt) > Date.now();
  } catch { return false; } finally { clearTimeout(timeout); }
}
/** Shared by access + downloads. No queuing, positive cache or raw credential keys. */
function ownerGate(config: Options, endpoint: string): (request: Request) => Promise<boolean> {
  let inFlight = 0, windowStart = Date.now(), windowCount = 0;
  const denied = new Map<string, number>();
  return async (request) => {
    const authorization = request.headers.get("authorization");
    if (!authorization || !/^Bearer [A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(authorization)) return false;
    const now = Date.now(), key = createHash("sha256").update(authorization).digest("base64url");
    const cachedUntil = denied.get(key);
    if (cachedUntil && cachedUntil > now) return false;
    if (cachedUntil) denied.delete(key);
    if (now - windowStart >= 60000) { windowStart = now; windowCount = 0; }
    if (inFlight >= MAX_AUTH_IN_FLIGHT || windowCount >= MAX_AUTH_PER_MINUTE) return false;
    inFlight++; windowCount++;
    try {
      const allowed = await requireOwner(request, config, endpoint);
      if (!allowed) {
        if (denied.size >= MAX_NEGATIVE_AUTH_ENTRIES) denied.delete(denied.keys().next().value!);
        denied.set(key, Date.now() + 10000);
      }
      return allowed;
    } finally { inFlight--; }
  };
}
async function checkedRoot(root: string): Promise<string> {
  // Private, service-owned, single-writer directory. No caller controls its path.
  // Reject symlinked ancestors before creating anything, then check root ownership.
  let ancestor = root;
  for (;;) {
    try { await lstat(ancestor); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
  }
  if (await realpath(ancestor) !== resolve(ancestor)) throw new Error("private root ancestor");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(root) !== resolve(root)) throw new Error("private root");
  return root;
}
async function checkedFile(root: string, name: string): Promise<FileHandle> {
  const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_PRIVATE_RELEASE_BYTES || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("private file");
    return file;
  } catch (error) { await file.close(); throw error; }
}
async function digest(file: FileHandle): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
  return hash.digest("base64");
}
interface FeedArtifact { url: string; sha512: string; size: number }
function scalar(input: string): string {
  if ((input.startsWith("'") && input.endsWith("'")) || (input.startsWith('"') && input.endsWith('"'))) return input.slice(1, -1);
  return input;
}
/** Intentionally accepts only electron-builder's simple feed subset, not YAML tags/aliases. */
function parseFeed(bytes: Buffer): { version: string; files: FeedArtifact[] } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error("feed syntax");
  const top = new Map<string, string>(), files: Record<string, string>[] = [];
  let inFiles = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line === "files:") { if (inFiles || top.has("files")) throw new Error("duplicate files"); top.set("files", ""); inFiles = true; continue; }
    const child = /^  - url: (.+)$/.exec(line);
    if (child && inFiles) { if (files.length >= 32) throw new Error("feed entries"); files.push({ url: scalar(child[1]) }); continue; }
    const property = /^    (sha512|size): (.+)$/.exec(line);
    if (property && inFiles && files.length) {
      const entry = files.at(-1)!;
      if (property[1] in entry) throw new Error("duplicate property");
      entry[property[1]] = scalar(property[2]); continue;
    }
    const field = /^(version|path|sha512|releaseDate): (.+)$/.exec(line);
    if (!field || top.has(field[1])) throw new Error("feed field");
    inFiles = false; top.set(field[1], scalar(field[2]));
  }
  const version = top.get("version") ?? "", path = top.get("path"), sha = top.get("sha512");
  if (!VERSION.test(version) || !files.length || !path || !sha || !HASH.test(sha)) throw new Error("feed metadata");
  const seen = new Set<string>();
  const parsed = files.map((file) => {
    if (!file.url || artifactVersion(file.url) !== version || file.url.endsWith(".blockmap") || seen.has(file.url) || !HASH.test(file.sha512 ?? "") || !/^[1-9]\d*$/.test(file.size ?? "")) throw new Error("feed artifact");
    seen.add(file.url);
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size > MAX_PRIVATE_RELEASE_BYTES) throw new Error("feed size");
    return { url: file.url, sha512: file.sha512, size };
  });
  if (!parsed.some((file) => file.url === path && file.sha512 === sha)) throw new Error("feed path");
  if (top.has("releaseDate") && !Number.isFinite(Date.parse(top.get("releaseDate")!))) throw new Error("feed date");
  return { version, files: parsed };
}
async function validateFeed(root: string, bytes: Buffer): Promise<void> {
  for (const reference of parseFeed(bytes).files) {
    const file = await checkedFile(root, reference.url);
    try {
      if ((await file.stat()).size !== reference.size || !equalSecret(await digest(file), reference.sha512)) throw new Error("feed integrity");
    } finally { await file.close(); }
  }
}
function rangeFor(header: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  const a = match[1] ? Number(match[1]) : null, b = match[2] ? Number(match[2]) : null;
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) return null;
  if (a === null) return b! > 0 ? { start: Math.max(0, size - b!), end: size - 1, partial: b! < size } : null;
  if (a >= size || (b !== null && b < a)) return null;
  const end = Math.min(b ?? size - 1, size - 1);
  return { start: a, end, partial: a !== 0 || end !== size - 1 };
}

/** No implicit mounting or startup; the independent service is the only entry. */
export function createPrivateReleaseGateway(options: Options = privateReleaseConfigFromEnv()): Hono {
  const config = { ...options }, app = new Hono(), endpoint = authEndpoint(config.authOrigin);
  const enabled = config.enabled && !!endpoint && !!config.ownerId && config.ownerId.trim() === config.ownerId &&
    isAbsolute(config.root) && resolve(config.root) !== "/";
  const maxBytes = Math.min(options.maxArtifactBytes ?? MAX_PRIVATE_RELEASE_BYTES, MAX_PRIVATE_RELEASE_BYTES);
  const publishing = new Set<string>();
  const authorizedOwner = ownerGate(config, endpoint ?? "");
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store, max-age=0"); c.header("CDN-Cache-Control", "no-store");
    c.header("Vary", "Authorization"); c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer"); c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    await next();
  });
  app.notFound((c) => c.text("Not found", 404));
  app.onError((_error, c) => c.text("Not found", 404));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/private-releases/access", async (c) => {
    if (!enabled || !await authorizedOwner(c.req.raw)) return c.notFound();
    return c.json({ channel: "super-nightly", authorized: true, userId: config.ownerId });
  });
  app.on(["GET", "HEAD"], `${PREFIX}:filename`, async (c) => {
    const name = c.req.param("filename");
    if (!validName(name)) return c.notFound();
    if (!enabled || !await authorizedOwner(c.req.raw)) return c.notFound();
    let file: FileHandle | undefined;
    try {
      const root = await checkedRoot(config.root); file = await checkedFile(root, name);
      const size = (await file.stat()).size;
      if (FEEDS.has(name)) {
        if (size > MAX_FEED_BYTES) return c.notFound();
        const feed = await file.readFile(); await validateFeed(root, feed);
      }
      const range = rangeFor(c.req.header("range") ?? null, size);
      if (!range) { c.header("Content-Range", `bytes */${size}`); return c.text("Range not satisfiable", 416); }
      c.header("Accept-Ranges", "bytes"); c.header("Content-Length", String(range.end - range.start + 1));
      c.header("Content-Type", FEEDS.has(name) ? "application/yaml; charset=utf-8" : "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${name}"`);
      if (range.partial) c.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      if (c.req.method === "HEAD") return c.body(null, range.partial ? 206 : 200);
      const body = Readable.toWeb(file.createReadStream({ start: range.start, end: range.end, autoClose: true })) as ReadableStream<Uint8Array>;
      file = undefined; // Stream owns and closes the descriptor, including cancellation.
      return new Response(body, { status: range.partial ? 206 : 200, headers: c.res.headers });
    } catch { return c.notFound(); } finally { await file?.close().catch(() => {}); }
  });
  app.put(`${PREFIX}:filename`, async (c) => {
    const key = c.req.header("x-markie-publish-key") ?? "";
    if (!enabled || !validPublishKey(config.publishKey) || key.length > 256 || !equalSecret(key, config.publishKey)) return c.notFound();
    const name = c.req.param("filename");
    if (!validName(name)) return c.notFound();
    const rawLength = c.req.header("content-length") ?? "", expectedHash = c.req.header("x-markie-sha512") ?? "";
    if (!/^[1-9]\d*$/.test(rawLength) || !HASH.test(expectedHash) || c.req.header("content-encoding")) return c.text("Invalid upload", 400);
    const length = Number(rawLength), limit = FEEDS.has(name) ? Math.min(MAX_FEED_BYTES, maxBytes) : maxBytes;
    if (!Number.isSafeInteger(length) || !Number.isSafeInteger(limit) || limit < 1 || length > limit) return c.text("Upload too large", 413);
    if (publishing.has(name) || publishing.size >= 2) return c.text("Upload busy", 409);
    publishing.add(name);
    let temp: string | undefined, handle: FileHandle | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const root = await checkedRoot(config.root), destination = join(root, name);
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
      if (existing && (!FEEDS.has(name) || !existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) return c.text("Upload conflict", 409);
      temp = join(root, `.upload-${randomUUID()}`);
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      reader = c.req.raw.body?.getReader();
      if (!reader) return c.text("Invalid upload", 400);
      const hash = createHash("sha512"); let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > length || received > limit) return c.text("Invalid upload", 400);
        hash.update(value);
        for (let at = 0; at < value.byteLength;) {
          const written = await handle.write(value, at, value.byteLength - at);
          if (!written.bytesWritten) throw new Error("short write");
          at += written.bytesWritten;
        }
      }
      const actualHash = hash.digest("base64");
      if (received !== length || !equalSecret(actualHash, expectedHash)) return c.text("Invalid upload", 400);
      await handle.sync(); await handle.close(); handle = undefined;
      if (FEEDS.has(name)) {
        const feedHandle = await checkedFile(root, basename(temp));
        try { await validateFeed(root, await feedHandle.readFile()); } finally { await feedHandle.close(); }
        await rename(temp, destination); temp = undefined; // Feeds become visible last.
      } else await link(temp, destination); // Atomic create-if-absent, never overwrite.
      c.header("x-markie-sha512", actualHash);
      return c.json({ ok: true, channel: "super-nightly", filename: name, size: received, sha512: actualHash }, FEEDS.has(name) ? 200 : 201);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? c.text("Upload conflict", 409) : c.text("Invalid upload", 400);
    }
    finally {
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
      await handle?.close().catch(() => {});
      if (temp) await unlink(temp).catch(() => {});
      publishing.delete(name);
    }
  });
  return app;
}
