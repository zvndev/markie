import { Hono } from "hono";
import { DocumentPlatformError, platformFail, platformObject, platformVersion, type DocumentPlatformStore } from "./document-platform-store.ts";

export interface DocumentPlatformOptions {
  store: DocumentPlatformStore;
  resolveUser(request: Request): Promise<{ id: string } | null>;
}

/** Bounded streaming JSON read; a dishonest/missing Content-Length cannot bypass the cap. */
async function jsonBody(request: Request, limit: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) platformFail("invalid-request", 415, "Content-Type application/json is required.");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) platformFail("too-large", 413, "Request exceeds the document-platform body limit.");
  if (!request.body) platformFail("invalid-request", 400, "A JSON request body is required.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => undefined); platformFail("too-large", 413, "Request exceeds the document-platform body limit."); }
      chunks.push(new Uint8Array(next.value));
    }
  } finally { reader.releaseLock(); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { platformFail("invalid-request", 400, "Request body is not valid UTF-8 JSON."); }
  // Snapshot transport is a flat object; reject nested allocation bombs before JSON.parse.
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") { if (++depth > 16) platformFail("invalid-request", 400, "Transport JSON nesting exceeds its safety bound."); }
    else if (c === "}" || c === "]") depth--;
  }
  try { return JSON.parse(text); } catch { platformFail("invalid-request", 400, "Request body is not valid UTF-8 JSON."); }
}
function downloadDisposition(name: string): string {
  // RFC 6266 attachment, safe ASCII fallback plus RFC 5987 UTF-8 extended filename.
  const safe = name.replace(/[\x00-\x1f\x7f"\\/]/g, "_").toWellFormed();
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_") || "document";
  const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Mount at /api/document-platform; legacy Markdown routes remain untouched. */
export function createDocumentPlatform({ store, resolveUser }: DocumentPlatformOptions): Hono {
  const app = new Hono();
  const wireLimit = Math.ceil(store.limits.maxDocumentBytes / 3) * 4 + 4096;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof DocumentPlatformError) return c.json({ error: error.code, message: error.message, ...(error.serverVersion !== undefined ? { serverVersion: error.serverVersion } : {}) }, error.status);
    // Never serialize database errors, auth internals, snapshot bytes, hashes, or bearer tokens.
    return c.json({ error: "storage-error", message: "Document sharing is temporarily unavailable. No change was acknowledged." }, 503);
  });
  const user = async (request: Request) => {
    const account = await resolveUser(request);
    if (!account || typeof account.id !== "string" || !account.id || account.id.length > 128) platformFail("unauthorized", 401, "Sign in to access ordinary cloud documents.");
    return account.id;
  };
  app.get("/links/:token", (c) => c.json({ document: store.publicSnapshot(c.req.param("token")) }));
  app.get("/links/:token/download", (c) => {
    const document = store.publicSnapshot(c.req.param("token")), bytes = Buffer.from(document.data, "base64");
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "application/octet-stream", "Content-Disposition": downloadDisposition(document.name), "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    } });
  });
  app.get("/documents", async (c) => c.json({ documents: store.list(await user(c.req.raw)) }));
  app.post("/documents", async (c) => {
    const userId = await user(c.req.raw), payload = await jsonBody(c.req.raw, wireLimit);
    return c.json({ document: store.create(userId, payload) }, 201);
  });
  app.get("/documents/:id", async (c) => c.json({ document: store.get(await user(c.req.raw), c.req.param("id")) }));
  app.put("/documents/:id", async (c) => {
    const userId = await user(c.req.raw), payload = await jsonBody(c.req.raw, wireLimit);
    return c.json({ document: store.update(userId, c.req.param("id"), payload) });
  });
  app.delete("/documents/:id", async (c) => {
    const userId = await user(c.req.raw), payload = platformObject(await jsonBody(c.req.raw, 1024), ["baseVersion"]);
    platformVersion(payload.baseVersion); store.remove(userId, c.req.param("id"), payload.baseVersion);
    return c.json({ ok: true });
  });
  app.get("/documents/:id/history", async (c) => c.json({ history: store.history(await user(c.req.raw), c.req.param("id")) }));
  app.get("/documents/:id/history/:version", async (c) => {
    const userId = await user(c.req.raw), version = c.req.param("version");
    if (!/^[1-9]\d{0,15}$/.test(version)) platformFail("invalid-request", 400, "Invalid history version.");
    return c.json({ document: store.historyVersion(userId, c.req.param("id"), Number(version)) });
  });
  app.get("/documents/:id/members", async (c) => c.json({ members: store.members(await user(c.req.raw), c.req.param("id")) }));
  app.post("/documents/:id/members", async (c) => {
    const userId = await user(c.req.raw), payload = await jsonBody(c.req.raw, 2048);
    store.addMember(userId, c.req.param("id"), payload); return c.json({ ok: true });
  });
  app.delete("/documents/:id/members/:userId", async (c) => {
    store.removeMember(await user(c.req.raw), c.req.param("id"), c.req.param("userId")); return c.json({ ok: true });
  });
  app.get("/documents/:id/links", async (c) => c.json({ links: store.links(await user(c.req.raw), c.req.param("id")) }));
  app.post("/documents/:id/links", async (c) => {
    const userId = await user(c.req.raw), payload = platformObject(await jsonBody(c.req.raw, 1024), ["expiresInSeconds"]);
    return c.json({ link: store.createLink(userId, c.req.param("id"), payload.expiresInSeconds as number) }, 201);
  });
  app.delete("/documents/:id/links/:linkId", async (c) => {
    store.revokeLink(await user(c.req.raw), c.req.param("id"), c.req.param("linkId")); return c.json({ ok: true });
  });
  return app;
}
