import { describe, expect, it, vi } from "vitest";
import { createAuthStore } from "./auth-store";
import type { MarkieUser } from "@/lib/auth-client";

const ALICE: MarkieUser = { id: "u1", email: "alice@example.com", name: "Alice" };
const BOB: MarkieUser = { id: "u2", email: "bob@example.com", name: "Bob" };

// A fetch we can settle by hand, so "which refresh wins" is a decision the test
// makes rather than a race it hopes for.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createAuthStore", () => {
  it("starts out checking, with nobody signed in", () => {
    const store = createAuthStore({ fetchUser: async () => null });
    expect(store.getSnapshot()).toEqual({ user: null, status: "checking" });
  });

  it("lands on the signed-in user", async () => {
    const store = createAuthStore({ fetchUser: async () => ALICE });
    await store.refresh();
    expect(store.getSnapshot()).toEqual({ user: ALICE, status: "in" });
  });

  it("lands signed out when there is no session", async () => {
    const store = createAuthStore({ fetchUser: async () => null });
    await store.refresh();
    expect(store.getSnapshot()).toEqual({ user: null, status: "out" });
  });

  it("treats a failed probe as signed out rather than staying stuck checking", async () => {
    const store = createAuthStore({
      fetchUser: async () => {
        throw new Error("offline");
      },
    });
    await store.refresh();
    // Markie is local-first: a probe that can't reach the server means "no
    // session to act on", not a spinner that never resolves.
    expect(store.getSnapshot()).toEqual({ user: null, status: "out" });
  });

  it("notifies subscribers when the session changes", async () => {
    const store = createAuthStore({ fetchUser: async () => ALICE });
    const seen = vi.fn();
    store.subscribe(seen);
    await store.refresh();
    expect(seen).toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", async () => {
    const store = createAuthStore({ fetchUser: async () => ALICE });
    const seen = vi.fn();
    store.subscribe(seen)();
    await store.refresh();
    expect(seen).not.toHaveBeenCalled();
  });

  // useSyncExternalStore re-renders forever if getSnapshot hands back a fresh
  // object each call, so an unchanged session must return the same reference.
  it("keeps snapshot identity stable when nothing changed", async () => {
    const store = createAuthStore({ fetchUser: async () => ALICE });
    await store.refresh();
    const first = store.getSnapshot();
    await store.refresh();
    expect(store.getSnapshot()).toBe(first);
  });

  it("does not notify subscribers when the session is unchanged", async () => {
    const store = createAuthStore({ fetchUser: async () => ALICE });
    await store.refresh();
    const seen = vi.fn();
    store.subscribe(seen);
    await store.refresh();
    expect(seen).not.toHaveBeenCalled();
  });

  it("lets the newest refresh win when two overlap", async () => {
    const slow = deferred<MarkieUser | null>();
    const fast = deferred<MarkieUser | null>();
    const calls = [slow.promise, fast.promise];
    let call = 0;
    const store = createAuthStore({ fetchUser: () => calls[call++] });

    const firstRefresh = store.refresh();
    const secondRefresh = store.refresh();
    // The second probe answers first, then the first one finally lands. A stale
    // answer overwriting a newer one is how the account UI ends up showing the
    // previous user after a switch.
    fast.resolve(BOB);
    await secondRefresh;
    slow.resolve(ALICE);
    await firstRefresh;

    expect(store.getSnapshot()).toEqual({ user: BOB, status: "in" });
  });

  it("signs out immediately without waiting on the network", async () => {
    const store = createAuthStore({
      fetchUser: async () => ALICE,
      signOut: async () => {},
    });
    await store.refresh();
    const pending = store.signOut();
    // The UI must not show the old identity while the request is in flight.
    expect(store.getSnapshot()).toEqual({ user: null, status: "out" });
    await pending;
    expect(store.getSnapshot()).toEqual({ user: null, status: "out" });
  });

  it("stays signed out even if the sign-out request fails", async () => {
    const store = createAuthStore({
      fetchUser: async () => ALICE,
      signOut: async () => {
        throw new Error("offline");
      },
    });
    await store.refresh();
    await store.signOut();
    // The local token is already gone, so reporting "still signed in" would be
    // a lie the next request would disprove.
    expect(store.getSnapshot()).toEqual({ user: null, status: "out" });
  });

  it("ready() starts the first probe on its own", async () => {
    const fetchUser = vi.fn(async () => ALICE);
    const store = createAuthStore({ fetchUser });
    expect(await store.ready()).toEqual({ user: ALICE, status: "in" });
    expect(fetchUser).toHaveBeenCalledTimes(1);
  });

  it("ready() probes once no matter how many callers await it", async () => {
    const fetchUser = vi.fn(async () => ALICE);
    const store = createAuthStore({ fetchUser });
    await Promise.all([store.ready(), store.ready(), store.ready()]);
    // Three gated surfaces opening at once must not mean three /api/me calls.
    expect(fetchUser).toHaveBeenCalledTimes(1);
  });

  it("ready() reflects a later refresh rather than the boot answer", async () => {
    let current: MarkieUser | null = null;
    const store = createAuthStore({ fetchUser: async () => current });
    expect(await store.ready()).toEqual({ user: null, status: "out" });
    current = ALICE;
    await store.refresh();
    expect(await store.ready()).toEqual({ user: ALICE, status: "in" });
  });

  it("ignores a refresh that was already in flight when sign-out happened", async () => {
    const slow = deferred<MarkieUser | null>();
    const store = createAuthStore({
      fetchUser: () => slow.promise,
      signOut: async () => {},
    });
    const refreshing = store.refresh();
    await store.signOut();
    slow.resolve(ALICE);
    await refreshing;
    // Otherwise signing out during a boot probe signs you straight back in.
    expect(store.getSnapshot()).toEqual({ user: null, status: "out" });
  });
});
