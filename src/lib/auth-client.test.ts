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

// The last push, reduced to the two fields that matter here.
function lastPush(): { token: string | null; userId: string | null | undefined } {
  const call = syncConfig.mock.calls.at(-1)?.[0] as
    | { token: string | null; userId?: string | null }
    | undefined;
  if (!call) throw new Error("nothing was pushed");
  return { token: call.token, userId: call.userId };
}

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
});
