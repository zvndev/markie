// One owner for "who is signed in".
//
// This used to be five independent `authClient.me()` calls — Settings, the
// share dialog, comments, the activity bar, and page.tsx each probed /api/me on
// mount — kept roughly in step by an `authNonce` counter that page.tsx threaded
// down by hand and bumped whenever auth changed out of band. Every new surface
// that cared about the session had to be wired into that counter, and any that
// wasn't silently showed stale identity.
//
// So the session lives here instead: one probe, one snapshot, and subscribers
// that all learn about a change at the same moment.
import { useEffect, useSyncExternalStore } from "react";
import { authClient, type MarkieUser } from "@/lib/auth-client";

export type AuthStatus = "checking" | "in" | "out";

export interface AuthSnapshot {
  user: MarkieUser | null;
  status: AuthStatus;
}

export interface AuthStore {
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  /** Re-probe the session. Safe to call from anywhere, any number of times. */
  refresh(): Promise<void>;
  /**
   * Resolve once the session is actually known, starting the first probe if
   * nothing has yet. For callers that need a definitive answer before acting
   * (may this user edit? is this doc theirs?) rather than a snapshot that might
   * still say "checking".
   */
  ready(): Promise<AuthSnapshot>;
  /** Drop the session locally, then tell the server. */
  signOut(): Promise<void>;
}

interface AuthStoreOptions {
  fetchUser: () => Promise<MarkieUser | null>;
  signOut?: () => Promise<unknown>;
}

const SIGNED_OUT: AuthSnapshot = { user: null, status: "out" };
const CHECKING: AuthSnapshot = { user: null, status: "checking" };

function same(a: AuthSnapshot, b: AuthSnapshot): boolean {
  return a.status === b.status && a.user?.id === b.user?.id;
}

export function createAuthStore(opts: AuthStoreOptions): AuthStore {
  let snapshot: AuthSnapshot = CHECKING;
  const listeners = new Set<() => void>();

  // Every probe carries a ticket. Only the newest ticket may write, so an
  // overlapping refresh can't land a stale user on top of a newer one, and a
  // sign-out can invalidate a probe that is still in flight.
  let ticket = 0;

  const publish = (next: AuthSnapshot) => {
    // useSyncExternalStore re-renders in a loop when getSnapshot returns a new
    // object every call, so an unchanged session must keep its identity.
    if (same(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const refresh = async () => {
    const mine = ++ticket;
    let user: MarkieUser | null = null;
    try {
      user = await opts.fetchUser();
    } catch {
      // A probe that couldn't reach the server means "no session to act on".
      // Markie is local-first: staying in `checking` would leave every gated
      // surface spinning while the app itself works fine offline.
      user = null;
    }
    if (mine !== ticket) return;
    publish(user ? { user, status: "in" } : SIGNED_OUT);
  };

  const signOut = async () => {
    // Invalidate any probe still in flight, or signing out during the boot
    // check signs you straight back in when that check lands.
    ticket++;
    publish(SIGNED_OUT);
    try {
      await opts.signOut?.();
    } catch {
      // The local token is already gone. Claiming we're still signed in would
      // be a lie the next request would disprove anyway.
    }
  };

  // The first caller to need a real answer starts the probe, so no boot wiring
  // has to be remembered at a call site far away from here.
  let firstProbe: Promise<void> | null = null;
  const ready = async () => {
    if (!firstProbe) firstProbe = refresh();
    await firstProbe;
    return snapshot;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    ready,
    signOut,
  };
}

export const authStore = createAuthStore({
  fetchUser: () => authClient.me(),
  signOut: () => authClient.signOut(),
});

/**
 * Subscribe a component to the session. Mounting any auth-aware surface starts
 * the boot probe, so there is no separate "kick the session check" wiring to
 * forget when a new surface is added.
 */
export function useAuth(): AuthSnapshot {
  useEffect(() => {
    void authStore.ready();
  }, []);
  return useSyncExternalStore(
    authStore.subscribe,
    authStore.getSnapshot,
    // Static export prerenders on the server, where there is no session and no
    // storage to read one from.
    () => CHECKING
  );
}
