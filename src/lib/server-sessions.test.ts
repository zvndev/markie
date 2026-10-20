// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";

type Sessions = typeof import("./server-sessions");
type Client = typeof import("./auth-client");
type State = typeof import("./auth-state");

const CLOUD = "https://api-production-602f.up.railway.app";
const SELF = "https://docs.example.com";

let sessions: Sessions;
let client: Client;
let state: State;
let syncConfig: ReturnType<typeof vi.fn>;
let syncSession: ReturnType<typeof vi.fn>;

async function fresh() {
  vi.resetModules();
  client = await import("./auth-client");
  sessions = await import("./server-sessions");
  state = await import("./auth-state");
}

beforeEach(async () => {
  localStorage.clear();
  syncConfig = vi.fn(async () => undefined);
  syncSession = vi.fn(async () => ({ ok: true }));
  installBridge({ syncConfig: syncConfig as never, syncSession: syncSession as never });
  await fresh();
});

afterEach(() => vi.unstubAllGlobals());

function answer(body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async (...args: unknown[]) => {
    void args;
    return { ok: true, status: 200, headers: new Headers(headers), json: async () => body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("migrating the old single server setting", () => {
  it("leaves a Markie Cloud user exactly as they were", async () => {
    localStorage.setItem("markie.token.v1", "tok-cloud");
    await fresh();
    expect(client.getServerURL()).toBe(CLOUD);
    expect(client.getAuthToken()).toBe("tok-cloud");
    expect(localStorage.getItem("markie.server.v1")).toBeNull();
  });

  it("drops a stored address that was Markie Cloud anyway, keeping the token", async () => {
    localStorage.setItem("markie.server.v1", `${CLOUD}/`);
    localStorage.setItem("markie.token.v1", "tok-cloud");
    localStorage.setItem(
      "markie.auth.principal.v1",
      JSON.stringify({ token: "tok-cloud", serverURL: CLOUD, userId: "u1" })
    );
    await fresh();
    expect(localStorage.getItem("markie.server.v1")).toBeNull();
    expect(client.getAuthToken()).toBe("tok-cloud");
    expect(client.getConfirmedAuthIdentity()).toEqual({ userId: "u1", serverURL: CLOUD });
  });

  it("moves another server's token under that server, and Markie Cloud starts signed out", async () => {
    localStorage.setItem("markie.server.v1", SELF);
    localStorage.setItem("markie.token.v1", "tok-self");
    localStorage.setItem(
      "markie.auth.principal.v1",
      JSON.stringify({ token: "tok-self", serverURL: SELF, userId: "u-self" })
    );
    await fresh();
    expect(client.getServerURL()).toBe(CLOUD);
    expect(client.getAuthToken()).toBeNull();
    expect(sessions.getServerToken(SELF)).toBe("tok-self");
    expect(JSON.parse(localStorage.getItem(`markie.auth.principal.v1@${SELF}`)!)).toEqual({
      token: "tok-self",
      serverURL: SELF,
      userId: "u-self",
    });
    expect(localStorage.getItem("markie.server.v1")).toBeNull();
  });

  it("does not hand the moved token to Markie Cloud", async () => {
    localStorage.setItem("markie.server.v1", SELF);
    localStorage.setItem("markie.token.v1", "tok-self");
    await fresh();
    client.pushSyncConfig();
    for (const [cfg] of syncConfig.mock.calls) expect((cfg as { token: string | null }).token).toBeNull();
  });

  it("keeps a dev build's localhost override", () => {
    localStorage.setItem("markie.server.v1", "http://localhost:8787");
    localStorage.setItem("markie.token.v1", "tok-dev");
    expect(client.migrateLegacyServer({ allowDev: true })).toBe(false);
    expect(localStorage.getItem("markie.server.v1")).toBe("http://localhost:8787");
    expect(localStorage.getItem("markie.token.v1")).toBe("tok-dev");
  });

  it("is a no-op the second time", () => {
    localStorage.setItem("markie.server.v1", SELF);
    localStorage.setItem("markie.token.v1", "tok-self");
    expect(client.migrateLegacyServer()).toBe(true);
    localStorage.setItem("markie.token.v1", "tok-cloud");
    expect(client.migrateLegacyServer()).toBe(false);
    expect(localStorage.getItem("markie.token.v1")).toBe("tok-cloud");
    expect(localStorage.getItem(`markie.token.v1@${SELF}`)).toBe("tok-self");
  });
});

describe("a session on another server", () => {
  it("is told to main through sync-session, token first and account after", async () => {
    sessions.setServerToken(SELF, "tok-self");
    expect(syncSession).toHaveBeenLastCalledWith({ origin: SELF, token: "tok-self", userId: null });

    answer({ user: { id: "u-self", email: "a@example.com", name: "A" } });
    await sessions.serverAuthClient(SELF).me();
    expect(syncSession).toHaveBeenLastCalledWith({ origin: SELF, token: "tok-self", userId: "u-self" });
    // The primary channel never hears about it.
    expect(syncConfig).not.toHaveBeenCalled();
  });

  // Main sends only a token it was handed for that server. One read from
  // storage before the launch push went out reaches main first.
  it("hands main a stored token before the first request that names it", async () => {
    localStorage.setItem(`markie.token.v1@${SELF}`, "tok-self");
    await fresh();
    const order: string[] = [];
    syncSession.mockImplementation(async () => {
      order.push("sync-session");
      return { ok: true };
    });
    answer({ user: null });
    const fetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetch.mockImplementation(async () => {
      order.push("server-request");
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ user: null }) };
    });
    await sessions.serverAuthClient(SELF).me();
    expect(order[0]).toBe("sync-session");
    expect(syncSession).toHaveBeenCalledWith({ origin: SELF, token: "tok-self", userId: null });
  });

  it("sends its token only to its own server", async () => {
    sessions.setServerToken(SELF, "tok-self");
    localStorage.setItem("markie.token.v1", "tok-cloud");
    const fetch = answer({ user: null });
    await sessions.serverAuthClient(SELF).me();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`${SELF}/api/me`);
    expect(init.headers.Authorization).toBe("Bearer tok-self");
    expect(init.redirect).toBe("error");
  });

  it("stores a token the server hands back for that server only", async () => {
    answer({ token: "tok-new", user: { id: "u", email: "a@example.com", name: "A" } }, { "set-auth-token": "tok-new" });
    await sessions.serverAuthClient(SELF).signInEmail("a@example.com", "pw");
    expect(sessions.getServerToken(SELF)).toBe("tok-new");
    expect(client.getAuthToken()).toBeNull();
  });

  it("signs out of one server and leaves the others", async () => {
    localStorage.setItem("markie.token.v1", "tok-cloud");
    sessions.setServerToken(SELF, "tok-self");
    answer({ success: true });
    await sessions.serverAuthClient(SELF).signOut();
    expect(sessions.getServerToken(SELF)).toBeNull();
    expect(client.getAuthToken()).toBe("tok-cloud");
    expect(syncSession).toHaveBeenLastCalledWith({ origin: SELF, token: null, userId: null });
  });

  it("is listed and pushed again at launch", () => {
    sessions.setServerToken(SELF, "tok-self");
    syncSession.mockClear();
    expect(sessions.storedServerOrigins()).toEqual([SELF]);
    sessions.forgetServerSession(SELF);
    expect(sessions.storedServerOrigins()).toEqual([]);
  });

  it("shares a document through the server it lives on", async () => {
    expect(sessions.sharesClientFor(null)).toBe(client.sharesClient);
    expect(sessions.sharesClientFor(CLOUD)).toBe(client.sharesClient);
    sessions.setServerToken(SELF, "tok-self");
    const fetch = answer({ shares: [] });
    await sessions.sharesClientFor(SELF).list("doc-1");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`${SELF}/api/docs/doc-1/shares`);
    expect(init.headers.Authorization).toBe("Bearer tok-self");
  });
});

describe("Google sign-in bound to a server", () => {
  it("mints a nonce for the server it was started against", () => {
    const url = sessions.serverAuthClient(SELF).googleSignInURL()!;
    expect(url.startsWith(`${SELF}/auth/google-start?state=`)).toBe(true);
    const nonce = new URL(url).searchParams.get("state");
    expect(state.consumeAuthStateFor(nonce)).toEqual({ ok: true, origin: SELF });
  });

  it("names Markie Cloud for a sign-in started there", () => {
    const url = client.authClient.googleSignInURL()!;
    const nonce = new URL(url).searchParams.get("state");
    expect(state.consumeAuthStateFor(nonce)).toEqual({ ok: true, origin: CLOUD });
  });
});
