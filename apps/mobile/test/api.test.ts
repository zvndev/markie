import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, documentErrorCopy } from "../src/lib/api";
import { NetworkError, type HttpRequest, type HttpResponse, type HttpTransport } from "../src/lib/http";

const ORIGIN = "https://api.markiedocs.com";
const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaaaaaa";

function fake(handler: (req: HttpRequest) => Partial<HttpResponse> & { json?: unknown }) {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = async (req) => {
    calls.push(req);
    const out = handler(req);
    return { status: out.status ?? 200, headers: out.headers ?? {}, text: out.text ?? (out.json === undefined ? "" : JSON.stringify(out.json)), ...(out.bytes ? { bytes: out.bytes } : {}) };
  };
  return { transport, calls };
}

const recentItem = {
  id: "doc-1", name: "Plan.wd", format: "darkmown",
  createdAt: "2026-10-24T10:00:00.000Z", updatedAt: "2026-10-25T10:00:00.000Z",
  origin: { kind: "agent", agent: "Claude Code" },
  shared: false, role: "owner", sharedBy: null,
  privateLink: "https://api.markiedocs.com/d/doc-1",
};

describe("api client: sign in", () => {
  it("sends the code as a sign-in OTP, without a token", async () => {
    const { transport, calls } = fake(() => ({ json: { success: true } }));
    await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).sendCode("me@example.com");
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORIGIN}/api/auth/email-otp/send-verification-otp`, body: { email: "me@example.com", type: "sign-in" } });
    expect(calls[0].headers?.authorization).toBeUndefined();
  });

  it("takes the session token from set-auth-token", async () => {
    const { transport, calls } = fake(() => ({ headers: { "set-auth-token": TOKEN }, json: { token: "ignored-body-token-xxxxxx", user: { id: "u1", email: "me@example.com", name: "Me" } } }));
    const result = await createApiClient({ origin: ORIGIN, transport }).verifyCode("me@example.com", "123456");
    expect(calls[0]).toMatchObject({ url: `${ORIGIN}/api/auth/sign-in/email-otp`, body: { email: "me@example.com", otp: "123456" } });
    expect(result.token).toBe(TOKEN);
    expect(result.user).toEqual({ id: "u1", email: "me@example.com", name: "Me" });
  });

  it("falls back to the body token, and refuses an answer with no usable token", async () => {
    const body = fake(() => ({ json: { token: TOKEN, user: { email: "me@example.com" } } }));
    expect((await createApiClient({ origin: ORIGIN, transport: body.transport }).verifyCode("me@example.com", "123456")).token).toBe(TOKEN);
    const none = fake(() => ({ json: { user: { email: "me@example.com" } } }));
    await expect(createApiClient({ origin: ORIGIN, transport: none.transport }).verifyCode("me@example.com", "123456")).rejects.toMatchObject({ status: 502 });
    const junk = fake(() => ({ headers: { "set-auth-token": "has spaces\nand newlines" }, json: {} }));
    await expect(createApiClient({ origin: ORIGIN, transport: junk.transport }).verifyCode("me@example.com", "123456")).rejects.toBeInstanceOf(ApiError);
  });

  it("turns a wrong code into a sentence a person can act on", async () => {
    const { transport } = fake(() => ({ status: 400, json: { code: "INVALID_OTP", message: "Invalid OTP" } }));
    await expect(createApiClient({ origin: ORIGIN, transport }).verifyCode("me@example.com", "000000"))
      .rejects.toMatchObject({ status: 400, message: "That code isn't right, or it expired. Send a new one.", serverMessage: "Invalid OTP" });
  });

  it("names an invite-only server instead of a generic failure", async () => {
    const { transport } = fake(() => ({ status: 403, json: { code: "signup_invite_required" } }));
    await expect(createApiClient({ origin: ORIGIN, transport }).verifyCode("new@example.com", "123456"))
      .rejects.toMatchObject({ message: "This server is invite-only. Ask its owner for an invite." });
  });

  it("reports offline when the transport never reached the server", async () => {
    const transport: HttpTransport = async () => { throw new NetworkError(); };
    await expect(createApiClient({ origin: ORIGIN, transport }).sendCode("me@example.com"))
      .rejects.toMatchObject({ status: 0, message: "Can't reach Markie's server. Check your connection." });
  });
});

describe("api client: documents", () => {
  it("lists recent documents with the bearer token, and encodes the cursor", async () => {
    const { transport, calls } = fake(() => ({ json: { docs: [recentItem] } }));
    const api = createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN });
    const docs = await api.recent({ limit: 500, before: "2026-10-25T10:00:00.000Z" });
    expect(calls[0].url).toBe(`${ORIGIN}/api/docs/recent?limit=100&before=2026-10-25T10%3A00%3A00.000Z`);
    expect(calls[0].headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(docs).toEqual([{ ...recentItem, format: "darkmown", origin: { kind: "agent", agent: "Claude Code" } }]);
  });

  it("drops malformed rows instead of trusting them", async () => {
    const { transport } = fake(() => ({ json: { docs: [recentItem, { id: "../etc/passwd", name: "x", updatedAt: recentItem.updatedAt }, { id: "ok", name: 7, updatedAt: "not a date" }, null] } }));
    const docs = await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).recent();
    expect(docs.map((doc) => doc.id)).toEqual(["doc-1"]);
  });

  it("reads one document with format and origin, and never sends an unsafe id", async () => {
    const { transport, calls } = fake(() => ({ json: { doc: { id: "doc-1", name: "Plan.wd", version: 3, content: ":state n = 0", hash: "h", updated_at: "2026-10-25T10:00:00.000Z", format: "darkmown", origin: { kind: "agent", agent: "Codex" } } } }));
    const api = createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN });
    const doc = await api.doc("doc-1");
    expect(calls[0].url).toBe(`${ORIGIN}/api/docs/doc-1`);
    expect(doc).toMatchObject({ id: "doc-1", format: "darkmown", version: 3, content: ":state n = 0", origin: { kind: "agent", agent: "Codex" }, privateLink: `${ORIGIN}/d/doc-1` });
    await expect(api.doc("../../api/me")).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("derives the format from the name when the server predates the field", async () => {
    const { transport } = fake(() => ({ json: { doc: { id: "d", name: "notes.log", content: "x", updated_at: "2026-10-25T10:00:00.000Z" } } }));
    expect((await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).doc("d")).format).toBe("text");
  });

  it("keeps the server's own words for a document it won't show", async () => {
    const { transport } = fake(() => ({ status: 404, json: { error: "not found" } }));
    const error = await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).doc("gone").catch((e) => e);
    expect(error).toMatchObject({ status: 404, serverMessage: "not found" });
    expect(documentErrorCopy(error)).toMatchObject({ title: "Document not found", detail: 'The server said: "not found" (404)', signIn: false });
    expect(documentErrorCopy(new ApiError(403, "forbidden", "", "forbidden"))).toMatchObject({ title: "You don't have access" });
    expect(documentErrorCopy(new ApiError(401, "x"))).toMatchObject({ signIn: true });
  });

  it("offers the way back, not a retry, when trying again can't work, and names the server", () => {
    const forbidden = documentErrorCopy(new ApiError(403, "forbidden"), "markie.example.com");
    expect(forbidden).toMatchObject({ retry: false, signIn: false });
    expect(forbidden.body).toContain("markie.example.com");
    expect(forbidden.body).not.toContain("Markie Cloud");
    expect(documentErrorCopy(new ApiError(403, "forbidden")).body).toContain("this server");
    expect(documentErrorCopy(new ApiError(404, "gone"))).toMatchObject({ retry: false });
    expect(documentErrorCopy(new ApiError(0, "offline"))).toMatchObject({ retry: true });
    expect(documentErrorCopy(new ApiError(503, "down"))).toMatchObject({ retry: true });
  });

  it("caps the server sign-out at the time it is given", async () => {
    const { transport, calls } = fake(() => ({ json: { success: true } }));
    await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).signOut({ timeoutMs: 3000 });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${ORIGIN}/api/auth/sign-out`, timeoutMs: 3000 });
    expect(calls[0].headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("treats a redirect as an error rather than following it with the token", async () => {
    const { transport } = fake(() => ({ status: 302, headers: { location: "https://evil.example/steal" } }));
    await expect(createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).recent()).rejects.toMatchObject({ status: 302 });
  });

  it("stores a rotated token from a successful answer, but not from a failure", async () => {
    const rotated = "tok_bbbbbbbbbbbbbbbbbbbbbbbb";
    const onTokenRotated = vi.fn();
    const ok = fake(() => ({ headers: { "set-auth-token": rotated }, json: { user: { id: "u", email: "a@b.co", name: "" } } }));
    await createApiClient({ origin: ORIGIN, transport: ok.transport, getToken: () => TOKEN, onTokenRotated }).me();
    expect(onTokenRotated).toHaveBeenCalledWith(rotated);
    onTokenRotated.mockClear();
    const failed = fake(() => ({ status: 401, headers: { "set-auth-token": rotated }, json: {} }));
    await createApiClient({ origin: ORIGIN, transport: failed.transport, getToken: () => TOKEN, onTokenRotated }).me().catch(() => undefined);
    expect(onTokenRotated).not.toHaveBeenCalled();
  });

  it("reads a public share without any token, and recovers a Darkmown name", async () => {
    const { transport, calls } = fake(() => ({ text: ":state n = 0", headers: { "content-disposition": "attachment; filename=\"Plan.wd.md\"; filename*=UTF-8''Plan.wd.md" } }));
    const doc = await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).publicDoc("pub_aaaaaaaaaaaaaaaaaaaa");
    expect(calls[0].headers).toEqual({});
    expect(calls[0].url).toBe(`${ORIGIN}/s/pub_aaaaaaaaaaaaaaaaaaaa/raw`);
    expect(doc).toMatchObject({ name: "Plan.wd", format: "darkmown", content: ":state n = 0", publicToken: "pub_aaaaaaaaaaaaaaaaaaaa" });
  });

  it("resolves a document's relative links and ignores junk", async () => {
    const { transport } = fake(() => ({ json: { links: [{ ref: "plan.md", target: "doc-2" }, { ref: "x.md" }, { ref: "y.md", target: "../bad" }] } }));
    const links = await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).docLinks("doc-1");
    expect([...links]).toEqual([["plan.md", "doc-2"]]);
  });
});

describe("api client: a document's own pictures", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it("reads a private document's picture from its asset route, with the token, as binary", async () => {
    const { transport, calls } = fake(() => ({ headers: { "content-type": "image/png" }, bytes: png }));
    const blob = await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).asset({ kind: "doc", id: "doc-1" }, "shots/a b.png");
    expect(calls[0]).toMatchObject({ method: "GET", url: `${ORIGIN}/api/docs/doc-1/assets/file?ref=shots%2Fa%20b.png`, responseType: "binary" });
    expect(calls[0].headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(blob?.type).toBe("image/png");
    expect(blob?.size).toBe(4);
  });

  it("reads a public share's picture from the share's route, with no token", async () => {
    const { transport, calls } = fake(() => ({ headers: { "content-type": "image/jpeg" }, bytes: png }));
    await createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }).asset({ kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa" }, "a.jpg");
    expect(calls[0].url).toBe(`${ORIGIN}/s/pub_aaaaaaaaaaaaaaaaaaaa/assets?ref=a.jpg`);
    expect(calls[0].headers).toEqual({});
  });

  it("shows nothing for a missing picture, a non-image, or a bad id", async () => {
    const missing = fake(() => ({ status: 404, text: "Not found" }));
    expect(await createApiClient({ origin: ORIGIN, transport: missing.transport, getToken: () => TOKEN }).asset({ kind: "doc", id: "doc-1" }, "x.png")).toBeNull();
    const html = fake(() => ({ headers: { "content-type": "text/html" }, bytes: png }));
    expect(await createApiClient({ origin: ORIGIN, transport: html.transport, getToken: () => TOKEN }).asset({ kind: "doc", id: "doc-1" }, "x.png")).toBeNull();
    const never = fake(() => ({ headers: { "content-type": "image/png" }, bytes: png }));
    expect(await createApiClient({ origin: ORIGIN, transport: never.transport, getToken: () => TOKEN }).asset({ kind: "doc", id: "../etc" }, "x.png")).toBeNull();
    expect(never.calls).toHaveLength(0);
  });
});
