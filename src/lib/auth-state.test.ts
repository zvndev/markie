import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_STATE_TTL_MS,
  clearAuthState,
  consumeAuthState,
  createAuthState,
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
