import { describe, expect, it, vi } from "vitest";
import { createSessionStore, memoryKeyValue, SESSION_KEY, type SecureKeyValue } from "../src/lib/session";
import { platformSecureStore } from "../src/lib/secure-store";

const session = { origin: "https://api.markiedocs.com", token: "tok_aaaaaaaaaaaaaaaaaaaaaaaa", email: "me@example.com", name: "Me", userId: "u1" };

describe("session store", () => {
  it("saves and loads token and origin together", async () => {
    const kv = memoryKeyValue();
    const store = createSessionStore(kv);
    await store.save(session);
    expect(JSON.parse((await kv.get(SESSION_KEY))!)).toEqual(session);
    expect(await store.load()).toEqual(session);
  });

  it("clears on sign out", async () => {
    const store = createSessionStore(memoryKeyValue());
    await store.save(session);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("refuses to store a token for a non-https server", async () => {
    const store = createSessionStore(memoryKeyValue());
    await expect(store.save({ ...session, origin: "http://evil.example" })).rejects.toThrow();
    await expect(store.save({ ...session, token: "short" })).rejects.toThrow();
  });

  it("removes a stored record that fails validation instead of trusting it", async () => {
    const kv = memoryKeyValue();
    const remove = vi.spyOn(kv, "remove");
    await kv.set(SESSION_KEY, JSON.stringify({ ...session, origin: "https://api.markiedocs.com/evil-path" }));
    expect(await createSessionStore(kv).load()).toBeNull();
    expect(remove).toHaveBeenCalledWith(SESSION_KEY);
    await kv.set(SESSION_KEY, "{not json");
    expect(await createSessionStore(kv).load()).toBeNull();
  });

  it("treats an unreadable Keychain or Keystore item as signed out", async () => {
    const removed: string[] = [];
    const broken: SecureKeyValue = {
      get: async () => { throw new Error("key permanently invalidated"); },
      set: async () => undefined,
      remove: async (key) => { removed.push(key); },
    };
    expect(await createSessionStore(broken).load()).toBeNull();
    expect(removed).toEqual([SESSION_KEY]);
  });

  it("never touches localStorage off a device", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem, removeItem: vi.fn() });
    try {
      const store = createSessionStore(platformSecureStore(false));
      await store.save(session);
      expect(await store.load()).toEqual(session);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
