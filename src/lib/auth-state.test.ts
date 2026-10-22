import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_STATE_TTL_MS,
  clearAuthState,
  consumeAuthState,
  consumeAuthStateFor,
  createAuthState,
  resolveAuthDeepLink,
} from "./auth-state";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
});

describe("createAuthState", () => {
  it("mints an unguessable nonce", () => {
    const value = createAuthState({ storage, now: 0 });
    expect(value).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a different nonce every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(createAuthState({ storage, now: 0 })!);
    expect(seen.size).toBe(50);
  });

  it("replaces a previous pending nonce so only the newest flow can complete", () => {
    const first = createAuthState({ storage, now: 0 })!;
    const second = createAuthState({ storage, now: 0 })!;
    expect(consumeAuthState(first, { storage, now: 0 })).toBe(false);
    expect(second).not.toBe(first);
  });

  it("returns null when storage is unavailable rather than pretending to protect", () => {
    expect(createAuthState({ storage: null, now: 0 })).toBe(null);
  });
});

describe("consumeAuthState", () => {
  it("accepts the nonce it just minted", () => {
    const value = createAuthState({ storage, now: 0 })!;
    expect(consumeAuthState(value, { storage, now: 1000 })).toBe(true);
  });

  // The whole point: a hostile page firing markie://auth with a stolen or
  // attacker-owned token has no nonce to present.
  it("rejects a deep link that carries no state", () => {
    createAuthState({ storage, now: 0 });
    expect(consumeAuthState(null, { storage, now: 0 })).toBe(false);
    expect(consumeAuthState(undefined, { storage, now: 0 })).toBe(false);
    expect(consumeAuthState("", { storage, now: 0 })).toBe(false);
  });

  it("rejects a deep link that carries the wrong state", () => {
    createAuthState({ storage, now: 0 });
    expect(consumeAuthState("f".repeat(32), { storage, now: 0 })).toBe(false);
  });

  it("rejects any state when no sign-in is pending", () => {
    expect(consumeAuthState("f".repeat(32), { storage, now: 0 })).toBe(false);
  });

  it("rejects a replay of a nonce that already succeeded", () => {
    const value = createAuthState({ storage, now: 0 })!;
    expect(consumeAuthState(value, { storage, now: 0 })).toBe(true);
    expect(consumeAuthState(value, { storage, now: 0 })).toBe(false);
  });

  // A failed attempt must not leave the nonce lying around for a second guess.
  it("consumes the pending nonce even when the check fails", () => {
    const value = createAuthState({ storage, now: 0 })!;
    expect(consumeAuthState("wrong", { storage, now: 0 })).toBe(false);
    expect(consumeAuthState(value, { storage, now: 0 })).toBe(false);
  });

  it("rejects a nonce older than the TTL", () => {
    const value = createAuthState({ storage, now: 0 })!;
    expect(consumeAuthState(value, { storage, now: AUTH_STATE_TTL_MS + 1 })).toBe(false);
  });

  it("accepts a nonce right at the TTL boundary", () => {
    const value = createAuthState({ storage, now: 0 })!;
    expect(consumeAuthState(value, { storage, now: AUTH_STATE_TTL_MS })).toBe(true);
  });

  it("rejects everything when storage is unavailable", () => {
    expect(consumeAuthState("anything", { storage: null, now: 0 })).toBe(false);
  });

  it("rejects a corrupted storage record instead of throwing", () => {
    storage.setItem("markie.authstate.v1", "{not json");
    expect(consumeAuthState("anything", { storage, now: 0 })).toBe(false);
    storage.setItem("markie.authstate.v1", JSON.stringify({ value: 42 }));
    expect(consumeAuthState("42", { storage, now: 0 })).toBe(false);
  });
});

describe("clearAuthState", () => {
  it("drops a pending nonce so an abandoned sign-in cannot be completed", () => {
    const value = createAuthState({ storage, now: 0 })!;
    clearAuthState({ storage });
    expect(consumeAuthState(value, { storage, now: 0 })).toBe(false);
  });

  it("is safe with nothing pending", () => {
    expect(() => clearAuthState({ storage })).not.toThrow();
    expect(() => clearAuthState({ storage: null })).not.toThrow();
  });
});

describe("a nonce bound to a server", () => {
  it("answers the server it was minted for", () => {
    const value = createAuthState({ storage, now: 0, origin: "https://docs.example.com" })!;
    expect(consumeAuthStateFor(value, { storage, now: 0 })).toEqual({
      ok: true,
      origin: "https://docs.example.com",
    });
  });

  it("is single use, whatever server it names", () => {
    const value = createAuthState({ storage, now: 0, origin: "https://docs.example.com" })!;
    consumeAuthStateFor(value, { storage, now: 0 });
    expect(consumeAuthStateFor(value, { storage, now: 0 })).toEqual({ ok: false });
  });

  it("is replaced by a sign-in started against another server", () => {
    // The first server's nonce is gone, so a link carrying it cannot hand a
    // token to either server.
    const first = createAuthState({ storage, now: 0, origin: "https://a.example.com" })!;
    createAuthState({ storage, now: 0, origin: "https://b.example.com" });
    expect(consumeAuthStateFor(first, { storage, now: 0 })).toEqual({ ok: false });
  });

  it("rejects a link whose state matches nothing", () => {
    createAuthState({ storage, now: 0, origin: "https://docs.example.com" });
    expect(consumeAuthStateFor("f".repeat(32), { storage, now: 0 })).toEqual({ ok: false });
    createAuthState({ storage, now: 0, origin: "https://docs.example.com" });
    expect(consumeAuthStateFor(null, { storage, now: 0 })).toEqual({ ok: false });
  });

  it("reads a nonce from before servers were named as the primary server's", () => {
    storage.setItem("markie.authstate.v1", JSON.stringify({ value: "abc", createdAt: 0 }));
    expect(consumeAuthStateFor("abc", { storage, now: 0 })).toEqual({ ok: true, origin: null });
  });

  it("rejects a record whose server is not a string", () => {
    storage.setItem("markie.authstate.v1", JSON.stringify({ value: "abc", createdAt: 0, origin: 7 }));
    expect(consumeAuthStateFor("abc", { storage, now: 0 })).toEqual({ ok: false });
  });

  it("expires like any other nonce", () => {
    const value = createAuthState({ storage, now: 0, origin: "https://docs.example.com" })!;
    expect(consumeAuthStateFor(value, { storage, now: AUTH_STATE_TTL_MS + 1 })).toEqual({ ok: false });
  });
});

// The mix-up: the user adds evil.example, which says it offers Google. The
// app's nonce goes to evil's /auth/google-start; evil bounces the browser to
// Markie Cloud's desktop bridge with that nonce, and Cloud answers with its
// own token. Without an issuer check the app files Cloud's token as evil's
// and sends it to evil.
describe("resolveAuthDeepLink", () => {
  const CLOUD = "https://api.markiedocs.com";
  const RAILWAY = "https://api-production-602f.up.railway.app";
  const EVIL = "https://evil.example";
  const link = (state: string, iss?: string) =>
    `markie://auth?token=cloud-token&state=${state}${iss === undefined ? "" : `&iss=${encodeURIComponent(iss)}`}`;
  const resolve = (url: string) => resolveAuthDeepLink(url, { primaryOrigin: CLOUD, storage, now: 0 });

  it("refuses a Cloud token that arrives for a nonce minted for another server, with no iss", () => {
    const state = createAuthState({ storage, now: 0, origin: EVIL })!;
    expect(resolve(link(state))).toEqual({ ok: false, reason: "issuer-mismatch" });
  });

  it("refuses a Cloud token that arrives for a nonce minted for another server, with iss naming Cloud", () => {
    const state = createAuthState({ storage, now: 0, origin: EVIL })!;
    expect(resolve(link(state, CLOUD))).toEqual({ ok: false, reason: "issuer-mismatch" });
  });

  it("consumes the nonce when it refuses, so the link cannot be replayed with another iss", () => {
    const state = createAuthState({ storage, now: 0, origin: EVIL })!;
    resolve(link(state, CLOUD));
    expect(resolve(link(state, EVIL))).toEqual({ ok: false, reason: "no-pending" });
  });

  it("accepts another server's token when iss names that server", () => {
    const state = createAuthState({ storage, now: 0, origin: EVIL })!;
    expect(resolve(link(state, EVIL))).toEqual({ ok: true, token: "cloud-token", origin: EVIL });
  });

  it("compares normalized origins", () => {
    const state = createAuthState({ storage, now: 0, origin: "https://docs.example.com" })!;
    expect(resolve(link(state, "https://DOCS.example.com:443/"))).toEqual({
      ok: true,
      token: "cloud-token",
      origin: "https://docs.example.com",
    });
  });

  it("refuses an iss that is not an origin at all", () => {
    const state = createAuthState({ storage, now: 0, origin: EVIL })!;
    expect(resolve(link(state, "evil.example"))).toEqual({ ok: false, reason: "issuer-mismatch" });
  });

  it("accepts a Cloud sign-in with no iss, which is what Cloud sends until its next deploy", () => {
    const state = createAuthState({ storage, now: 0, origin: CLOUD })!;
    expect(resolve(link(state))).toEqual({ ok: true, token: "cloud-token", origin: null });
  });

  it("accepts a Cloud sign-in whose iss names Cloud", () => {
    const state = createAuthState({ storage, now: 0, origin: CLOUD })!;
    expect(resolve(link(state, CLOUD))).toEqual({ ok: true, token: "cloud-token", origin: null });
  });

  // BETTER_AUTH_URL moves from the Railway host to api.markiedocs.com, and
  // the iss the server stamps moves with it. One server, two names: neither
  // the deploy nor this app's update may land first and break sign-in.
  it("accepts a Cloud sign-in whose iss names Cloud's old Railway address", () => {
    const state = createAuthState({ storage, now: 0, origin: CLOUD })!;
    expect(resolve(link(state, RAILWAY))).toEqual({ ok: true, token: "cloud-token", origin: null });
  });

  it("accepts a sign-in begun under the old address before an update, with either iss", () => {
    for (const iss of [CLOUD, RAILWAY]) {
      const state = createAuthState({ storage, now: 0, origin: RAILWAY })!;
      expect(resolve(link(state, iss))).toEqual({ ok: true, token: "cloud-token", origin: null });
    }
  });

  it("does not let another server borrow Cloud's old address as its issuer", () => {
    const state = createAuthState({ storage, now: 0, origin: EVIL })!;
    expect(resolve(link(state, RAILWAY))).toEqual({ ok: false, reason: "issuer-mismatch" });
  });

  it("accepts the Railway iss for Cloud even when Cloud is not the primary server", () => {
    const state = createAuthState({ storage, now: 0, origin: CLOUD })!;
    expect(resolveAuthDeepLink(link(state, RAILWAY), { primaryOrigin: "http://localhost:8787", storage, now: 0 })).toEqual({
      ok: true,
      token: "cloud-token",
      origin: CLOUD,
    });
  });

  it("accepts a nonce from before nonces named a server as Cloud's", () => {
    storage.setItem("markie.authstate.v1", JSON.stringify({ value: "abcdef01", createdAt: 0 }));
    expect(resolve(link("abcdef01"))).toEqual({ ok: true, token: "cloud-token", origin: null });
  });

  it("refuses a Cloud sign-in whose token another server says it issued", () => {
    const state = createAuthState({ storage, now: 0, origin: CLOUD })!;
    expect(resolve(link(state, EVIL))).toEqual({ ok: false, reason: "issuer-mismatch" });
  });

  it("refuses a link with no pending sign-in, and anything that is not an auth link", () => {
    expect(resolve(link("f".repeat(32), CLOUD))).toEqual({ ok: false, reason: "no-pending" });
    expect(resolve("markie://open?token=x")).toEqual({ ok: false, reason: "not-auth" });
    expect(resolve("markie://auth?state=abc")).toEqual({ ok: false, reason: "not-auth" });
    expect(resolve("not a url")).toEqual({ ok: false, reason: "not-auth" });
  });
});
