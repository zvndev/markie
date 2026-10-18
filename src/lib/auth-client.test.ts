// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";

// What the renderer tells the sync engine about who is signed in. The engine
// reads the registry's remembered roles only for the account named here, so
// the pairing of token and account has to be honest: an account named beside
// a token it was not confirmed for is how one user's roles came to speak for
// another.

type Client = typeof import("./auth-client");

let client: Client;
let syncConfig: ReturnType<typeof vi.fn>;

function answerMe(user: { id: string; email: string; name: string } | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ user }),
    }))
  );
}

// Every push so far, reduced to the two fields that matter here.
function pushes(): Array<{ token: string | null; userId: string | null }> {
  return syncConfig.mock.calls.map(([c]) => {
    const call = c as { token: string | null; userId?: string | null };
    return { token: call.token, userId: call.userId ?? null };
  });
}

function lastPush(): { token: string | null; userId: string | null } {
  const last = pushes().at(-1);
  if (!last) throw new Error("nothing was pushed");
  return last;
}

const A = { id: "user-a", email: "a@example.com", name: "A" };
const B = { id: "user-b", email: "b@example.com", name: "B" };
const PRINCIPAL_KEY = "markie.auth.principal.v1";
const TOKEN_KEY = "markie.token.v1";

beforeEach(async () => {
  localStorage.clear();
  syncConfig = vi.fn(async () => undefined);
  installBridge({ syncConfig: syncConfig as never });
  // The principal is module state, so every case starts from a fresh module.
  vi.resetModules();
  client = await import("./auth-client");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("who the sync engine is told is signed in", () => {
  it("pins private authentication to the trusted server and keeps bearer/principal persistence in memory", async () => {
    installBridge({ syncConfig: syncConfig as never, privateReleaseAuthOrigin: "https://api-production-602f.up.railway.app" });
    localStorage.setItem("markie.server.v1", "https://untrusted.invalid");
    vi.resetModules(); client = await import("./auth-client");
    expect(client.getServerURL()).toBe("https://api-production-602f.up.railway.app");
    client.setServerURL("https://other.invalid"); expect(client.getServerURL()).toBe("https://api-production-602f.up.railway.app");
    client.adoptAuthToken("private-synthetic-token"); answerMe(A); await client.authClient.me();
    expect(client.getAuthToken()).toBe("private-synthetic-token"); expect(client.getConfirmedAuthIdentity()?.userId).toBe(A.id);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull(); expect(localStorage.getItem(PRINCIPAL_KEY)).toBeNull();
    vi.resetModules(); client = await import("./auth-client"); expect(client.getAuthToken()).toBeNull();
  });
  it("forgets private native enrollment before offline sign-out completes, independently of denied sync IPC", async () => {
    const privateReleaseLock = vi.fn(async () => ({ required: true, authorized: false, channel: "super-nightly", gitCommit: "abcdef0", authOrigin: "https://api-production-602f.up.railway.app" }));
    installBridge({ privateReleaseAuthOrigin: "https://api-production-602f.up.railway.app", privateReleaseLock, syncConfig: vi.fn(async () => ({ error: "private-release-locked" })) as never });
    vi.resetModules(); client = await import("./auth-client"); client.adoptAuthToken("private-synthetic-token");
    let fail!: (reason: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })));
    const signOut = client.authClient.signOut();
    expect(privateReleaseLock).toHaveBeenCalledOnce(); expect(client.getAuthToken()).toBeNull();
    fail(new Error("offline")); await signOut; expect(client.getAuthToken()).toBeNull(); expect(privateReleaseLock).toHaveBeenCalledTimes(2);
  });
  it("exposes only an exact confirmed account/server, never a token", async () => {
    client.adoptAuthToken("tok-a");
    expect(client.getConfirmedAuthIdentity()).toBeNull();
    answerMe(A); await client.authClient.me();
    expect(client.getConfirmedAuthIdentity()).toEqual({ userId: A.id, serverURL: client.getServerURL() });
    const server = client.getServerURL();
    client.setServerURL("https://different.test");
    expect(client.getConfirmedAuthIdentity()).toBeNull();
    client.setServerURL(server); answerMe(A); await client.authClient.me();
    client.adoptAuthToken("tok-b");
    expect(client.getConfirmedAuthIdentity()).toBeNull();
    answerMe(B); await client.authClient.me();
    expect(client.getConfirmedAuthIdentity()).toEqual({ userId: B.id, serverURL: server });
    localStorage.setItem(TOKEN_KEY, "cross-tab-token");
    expect(client.getConfirmedAuthIdentity()).toBeNull();
  });
  it("names the account only after the server confirms it for the token", async () => {
    client.adoptAuthToken("tok-a");
    expect(lastPush()).toEqual({ token: "tok-a", userId: null });

    answerMe({ id: "user-a", email: "a@example.com", name: "A" });
    await client.authClient.me();
    expect(lastPush()).toEqual({ token: "tok-a", userId: "user-a" });
  });

  it("drops the account the moment a different token arrives", async () => {
    // A is confirmed, and then B's token replaces A's with no sign-out in
    // between, the way a second sign-in over an expired session does. The push
    // that carries B's token must not carry A.
    client.adoptAuthToken("tok-a");
    answerMe({ id: "user-a", email: "a@example.com", name: "A" });
    await client.authClient.me();

    client.adoptAuthToken("tok-b");
    expect(lastPush()).toEqual({ token: "tok-b", userId: null });

    answerMe({ id: "user-b", email: "b@example.com", name: "B" });
    await client.authClient.me();
    expect(lastPush()).toEqual({ token: "tok-b", userId: "user-b" });
  });

  it("confirms the same account again under a new token", async () => {
    // A signs out and back in as A. The engine forgot A with the old token,
    // so the confirmation has to be sent again rather than skipped as
    // already known.
    client.adoptAuthToken("tok-a");
    answerMe({ id: "user-a", email: "a@example.com", name: "A" });
    await client.authClient.me();

    client.adoptAuthToken("tok-a2");
    const pushes = syncConfig.mock.calls.length;
    await client.authClient.me();
    expect(syncConfig.mock.calls.length).toBe(pushes + 1);
    expect(lastPush()).toEqual({ token: "tok-a2", userId: "user-a" });
  });

  it("keeps the account through a push that repeats the same token", async () => {
    client.adoptAuthToken("tok-a");
    answerMe({ id: "user-a", email: "a@example.com", name: "A" });
    await client.authClient.me();

    client.adoptAuthToken("tok-a");
    expect(lastPush()).toEqual({ token: "tok-a", userId: "user-a" });
  });

  it("forgets the account on sign-out", async () => {
    client.adoptAuthToken("tok-a");
    answerMe({ id: "user-a", email: "a@example.com", name: "A" });
    await client.authClient.me();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ success: true }),
      }))
    );
    await client.authClient.signOut();
    expect(lastPush()).toEqual({ token: null, userId: null });
  });

  it("ignores an answer about a token the session has already moved past", async () => {
    // A's probe is in flight when B's token lands. A's answer is about A's
    // token, and publishing it now would pair A with B's token in main.
    client.adoptAuthToken("tok-a");
    let answerA: (res: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => (answerA = resolve)))
    );
    const inFlight = client.authClient.me();

    client.adoptAuthToken("tok-b");
    answerA({ ok: true, status: 200, headers: new Headers(), json: async () => ({ user: A }) });

    expect(await inFlight).toBeNull();
    expect(pushes().map((p) => p.userId)).not.toContain("user-a");
    expect(lastPush()).toEqual({ token: "tok-b", userId: null });

    answerMe(B);
    await client.authClient.me();
    expect(lastPush()).toEqual({ token: "tok-b", userId: "user-b" });
  });
});

describe("the account across a relaunch", () => {
  // The token already survives a relaunch in storage. Without the account
  // beside it, a launch with no network has a token and nobody confirmed for
  // it, and every remembered role is refused for the length of the outage.
  it("writes the confirmed account beside the token it was confirmed for", async () => {
    client.adoptAuthToken("tok-a");
    answerMe(A);
    await client.authClient.me();

    expect(JSON.parse(localStorage.getItem(PRINCIPAL_KEY)!)).toEqual({
      token: "tok-a",
      serverURL: client.getServerURL(),
      userId: "user-a",
    });
  });

  it("does not restore it for a server it was not confirmed by", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-a");
    localStorage.setItem(
      PRINCIPAL_KEY,
      JSON.stringify({ token: "tok-a", serverURL: "https://elsewhere.example", userId: "user-a" })
    );
    vi.resetModules();
    client = await import("./auth-client");

    client.pushSyncConfig();
    expect(pushes()).toEqual([{ token: "tok-a", userId: null }]);
    expect(localStorage.getItem(PRINCIPAL_KEY)).toBeNull();
  });

  it("forgets the account when the server address changes", async () => {
    client.adoptAuthToken("tok-a");
    answerMe(A);
    await client.authClient.me();
    syncConfig.mockClear();

    client.setServerURL("https://elsewhere.example");
    expect(pushes()).toEqual([{ token: "tok-a", userId: null }]);
    expect(localStorage.getItem(PRINCIPAL_KEY)).toBeNull();
  });

  it("tells native sync about server changes even when the token has no confirmed principal", () => {
    client.adoptAuthToken("unconfirmed-token");
    syncConfig.mockClear();
    client.setServerURL("https://new-server.example");
    expect(syncConfig).toHaveBeenCalledExactlyOnceWith({ token: "unconfirmed-token", serverURL: "https://new-server.example", userId: null });
    expect(client.getConfirmedAuthIdentity()).toBeNull();
    expect(localStorage.getItem(PRINCIPAL_KEY)).toBeNull();
  });

  it("restores the account on launch when the stored token is the one it was confirmed for", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-a");
    localStorage.setItem(
      PRINCIPAL_KEY,
      JSON.stringify({ token: "tok-a", serverURL: client.getServerURL(), userId: "user-a" })
    );
    vi.resetModules();
    client = await import("./auth-client");

    // Main refuses a user named in the same push as a new token, so the boot
    // push is two: the token alone, then the token with its account.
    client.pushSyncConfig();
    expect(pushes()).toEqual([
      { token: "tok-a", userId: null },
      { token: "tok-a", userId: "user-a" },
    ]);
  });

  it("does not restore it for a token it was not confirmed for", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-b");
    localStorage.setItem(PRINCIPAL_KEY, JSON.stringify({ token: "tok-a", serverURL: client.getServerURL(), userId: "user-a" }));
    vi.resetModules();
    client = await import("./auth-client");

    client.pushSyncConfig();
    expect(pushes()).toEqual([{ token: "tok-b", userId: null }]);
    expect(localStorage.getItem(PRINCIPAL_KEY)).toBeNull();
  });

  it("forgets it when the token changes", async () => {
    client.adoptAuthToken("tok-a");
    answerMe(A);
    await client.authClient.me();

    client.adoptAuthToken("tok-b");
    expect(localStorage.getItem(PRINCIPAL_KEY)).toBeNull();
  });

  it("forgets it on sign-out", async () => {
    client.adoptAuthToken("tok-a");
    answerMe(A);
    await client.authClient.me();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ success: true }),
      }))
    );
    await client.authClient.signOut();
    expect(localStorage.getItem(PRINCIPAL_KEY)).toBeNull();
  });
});

describe("verified identity code sign-in", () => {
  const challengeId = "synthetic-challenge", flowId = "a".repeat(43);
  function mockCodeServer(capability: number | Record<string, unknown> = { verifiedIdentities: true }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/capabilities")) return typeof capability === "number" ? new Response("", { status: capability }) : Response.json(capability);
      if (url.endsWith("/identities/sign-in/start")) return Response.json({ challengeId, flowId, expiresInSeconds: 300 });
      if (url.endsWith("/identities/sign-in/verify")) return Response.json({ token: "canonical-token" });
      if (url.endsWith("/api/me")) return Response.json({ user: A });
      if (url.endsWith("/send-verification-otp")) return Response.json({ success: true });
      if (url.endsWith("/sign-in/email-otp")) return Response.json({ user: A }, { headers: { "set-auth-token": "legacy-token" } });
      throw new Error(`Unexpected route: ${url} ${init?.method}`);
    });
  }
  it("uses canonical identity endpoints, confirms the returned token, and never transmits browser cookies or an existing bearer", async () => {
    const request = mockCodeServer(); vi.stubGlobal("fetch", request);
    expect((await client.authClient.sendOTP(" Alias@Example.com ")).ok).toBe(true);
    const result = await client.authClient.verifyOTP("alias@example.com", "123456");
    expect(result.ok).toBe(true); expect(result.data?.user).toEqual(A);
    expect(client.getAuthToken()).toBe("canonical-token"); expect(client.getConfirmedAuthIdentity()?.userId).toBe(A.id);
    const calls = request.mock.calls;
    expect(JSON.parse(calls[1][1]!.body as string)).toEqual({ email: "alias@example.com" });
    expect(JSON.parse(calls[2][1]!.body as string)).toEqual({ challengeId, flowId, code: "123456" });
    for (const [, init] of calls.slice(0, 3)) { expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error"); expect(new Headers(init?.headers).has("authorization")).toBe(false); }
  });
  it("falls back to the legacy signup-capable code flow only for capability404", async () => {
    const request = mockCodeServer(404); vi.stubGlobal("fetch", request);
    expect((await client.authClient.sendOTP("a@example.com")).ok).toBe(true);
    expect((await client.authClient.verifyOTP("a@example.com", "123456")).ok).toBe(true);
    expect(client.getAuthToken()).toBe("legacy-token"); expect(request.mock.calls.some(([url]) => url.includes("/identities/sign-in/"))).toBe(false);
  });
  it.each([401, 403, 500, { verifiedIdentities: false }, {}])("does not downgrade when capabilities return %j", async (capability) => {
    const request = mockCodeServer(capability); vi.stubGlobal("fetch", request);
    expect((await client.authClient.sendOTP("a@example.com")).ok).toBe(false); expect(request).toHaveBeenCalledOnce();
  });
  it("refuses verification for a different email or an absent ephemeral flow", async () => {
    const request = mockCodeServer(); vi.stubGlobal("fetch", request);
    expect((await client.authClient.verifyOTP("a@example.com", "123456")).ok).toBe(false); expect(request).not.toHaveBeenCalled();
    await client.authClient.sendOTP("a@example.com");
    expect((await client.authClient.verifyOTP("b@example.com", "123456")).ok).toBe(false); expect(request).toHaveBeenCalledTimes(2);
  });
  it("discards an in-flight token response when the account or server changes", async () => {
    const normal = mockCodeServer(); let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/identities/sign-in/verify") ? new Promise<Response>((resolve) => { answer = resolve; }) : normal(url, init)));
    await client.authClient.sendOTP("a@example.com"); const verify = client.authClient.verifyOTP("a@example.com", "123456");
    client.adoptAuthToken("new-account-token"); answer(Response.json({ token: "stale-token" }));
    expect((await verify).ok).toBe(false); expect(client.getAuthToken()).toBe("new-account-token");
    await client.authClient.sendOTP("a@example.com"); const otherServer = client.authClient.verifyOTP("a@example.com", "123456");
    client.setServerURL("https://other.example"); answer(Response.json({ token: "wrong-server-token" }));
    expect((await otherServer).ok).toBe(false); expect(client.getAuthToken()).toBe("new-account-token");
  });
  it("invalidates earlier sends and verifies when a newer code is requested", async () => {
    const normal = mockCodeServer(); let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/identities/sign-in/verify") ? new Promise<Response>((resolve) => { answer = resolve; }) : normal(url, init)));
    await client.authClient.sendOTP("a@example.com"); const verify = client.authClient.verifyOTP("a@example.com", "123456");
    await client.authClient.sendOTP("b@example.com"); answer(Response.json({ token: "obsolete-token" }));
    expect((await verify).ok).toBe(false); expect(client.getAuthToken()).toBeNull();
  });
  it("emits same-window invalidation for token, confirmed principal, server, and sign-out changes without token details", async () => {
    const listener = vi.fn(); window.addEventListener("markie:account-session-change", listener);
    try {
      client.adoptAuthToken("tok-a"); expect(listener).toHaveBeenCalledTimes(1);
      answerMe(A); await client.authClient.me(); expect(listener).toHaveBeenCalledTimes(2);
      client.adoptAuthToken("tok-a"); expect(listener).toHaveBeenCalledTimes(2);
      client.setServerURL("https://other.example"); expect(listener).toHaveBeenCalledTimes(3);
      await client.authClient.signOut(); expect(listener).toHaveBeenCalledTimes(4);
      expect(listener.mock.calls.every(([event]) => !(event as CustomEvent).detail)).toBe(true);
    } finally { window.removeEventListener("markie:account-session-change", listener); }
  });
  it("does not let late generic auth headers or sign-out clear a newer session", async () => {
    client.adoptAuthToken("initial"); let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const signIn = client.authClient.signInEmail("a@example.com", "secret"); client.adoptAuthToken("newer"); answer(Response.json({ user: A }, { headers: { "set-auth-token": "stale" } }));
    expect((await signIn).ok).toBe(false); expect(client.getAuthToken()).toBe("newer");
    const signOut = client.authClient.signOut(); client.adoptAuthToken("newest"); answer(Response.json({ success: true })); await signOut;
    expect(client.getAuthToken()).toBe("newest");
  });
});
