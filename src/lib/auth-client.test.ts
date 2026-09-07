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
      userId: "user-a",
    });
  });

  it("restores the account on launch when the stored token is the one it was confirmed for", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-a");
    localStorage.setItem(PRINCIPAL_KEY, JSON.stringify({ token: "tok-a", userId: "user-a" }));
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
    localStorage.setItem(PRINCIPAL_KEY, JSON.stringify({ token: "tok-a", userId: "user-a" }));
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
