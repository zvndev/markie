// Live-collaboration config shared between the page (which decides when a
// doc is live) and RichView (which runs the Yjs session).

export interface PeerUser {
  name: string;
  color: string;
}

/** What the document's server answered when asked for a live-editing pass. */
export type CollabTicketAnswer =
  | { kind: "ticket"; ticket: string; expiresAt: number }
  // A server from before tickets, with no route to ask: its socket takes the token.
  | { kind: "legacy" }
  | { kind: "failed"; status: number };

export interface CollabConfig {
  docId: string;
  wsBase: string; // ws(s)://host/collab — y-websocket appends /<docId>
  // The session on the document's server. Never put on the socket unless that
  // server predates tickets (see connectWithTicket).
  token: string;
  /** Asks the document's own server, with that server's session, for a pass. */
  fetchTicket: () => Promise<CollabTicketAnswer>;
  user: PeerUser;
  readonly: boolean; // viewer role: presence yes, edits no
}

// A pass lasts five minutes on the server (server/src/collab-tickets.ts).
// Swapping it every two keeps the one a reconnect will use well inside that,
// even when a refresh or two fails along the way.
export const TICKET_REFRESH_MS = 2 * 60 * 1000;

// A reconnect loop against a server that is down closes every couple of
// seconds. A pass younger than this still has minutes left, so asking again
// on each of those closes would only spend the per-minute allowance.
export const TICKET_CLOSE_REFRESH_MIN_MS = 30 * 1000;

// The first pass is asked for while the pane waits to connect. A blip (no
// network for a moment, a server mid-deploy, the per-minute allowance) is
// worth a few quick tries before the page gives up and shows the local copy;
// a refusal is not.
export const FIRST_TICKET_RETRY_MS = [1000, 3000, 6000];

// Status 0 is a request that never got an answer.
function isTransient(answer: CollabTicketAnswer): boolean {
  if (answer.kind !== "failed") return false;
  const { status } = answer;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** The part of y-websocket's WebsocketProvider that connectWithTicket uses. */
export interface TicketedProvider {
  params: Record<string, string>;
  shouldConnect: boolean;
  connect(): void;
  on(event: "connection-close", fn: (event: CloseEvent | null) => void): void;
  off(event: "connection-close", fn: (event: CloseEvent | null) => void): void;
}

/**
 * Connects a provider that was created with `connect: false`, once there is
 * a pass to connect with, and keeps that pass fresh for as long as it runs.
 * Returns the function that stops it.
 *
 * y-websocket rebuilds its URL from `params` on every connect, so updating
 * `params.ticket` in place is enough for each reconnect to carry the newest
 * pass without tearing the session down. `onUnavailable` runs when no pass
 * could be had at all; the caller treats that exactly as a session that
 * failed to start, never as a reason to send the token instead.
 */
export function connectWithTicket(
  provider: TicketedProvider,
  collab: Pick<CollabConfig, "token" | "fetchTicket">,
  onUnavailable: () => void
): () => void {
  let stopped = false;
  // No more asking: the server refused this person outright, or closed the
  // socket with its final answer. The session itself is the caller's to end.
  let halted = false;
  let inFlight = false;
  // When a pass was last asked for, answered or not, so a reconnect loop
  // against a server that keeps refusing cannot ask on every close.
  let askedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const ask = async (): Promise<CollabTicketAnswer> => {
    askedAt = Date.now();
    try {
      return await collab.fetchTicket();
    } catch {
      return { kind: "failed", status: 0 };
    }
  };

  const halt = () => {
    halted = true;
    if (timer) clearInterval(timer);
    timer = null;
    provider.off("connection-close", onClose);
  };

  // A refresh that fails for a moment keeps the pass already held: it has
  // minutes left, and the next tick or close asks again. A refusal means the
  // access is gone (removed, signed out elsewhere), and asking every couple of
  // minutes for as long as the pane stays open would only be noise.
  const refresh = async () => {
    if (stopped || halted || inFlight) return;
    inFlight = true;
    const answer = await ask();
    inFlight = false;
    if (stopped || halted) return;
    if (answer.kind === "ticket") {
      provider.params.ticket = answer.ticket;
      return;
    }
    if (!isTransient(answer)) halt();
  };

  // The close is when a pass matters, because a reconnect follows it. A
  // long sleep is the usual way to get here holding an expired one: timers
  // do not run while the machine is asleep.
  function onClose(event: CloseEvent | null) {
    // A deliberate disconnect or destroy has nothing to reconnect.
    if (!provider.shouldConnect) return;
    // The 4000-4999 range is the server's final answer.
    if (event && event.code >= 4000 && event.code < 5000) {
      halt();
      return;
    }
    if (Date.now() - askedAt < TICKET_CLOSE_REFRESH_MIN_MS) return;
    void refresh();
  }

  const start = async (attempt: number) => {
    retry = null;
    const answer = await ask();
    if (stopped) return;
    if (answer.kind === "legacy") {
      // LEGACY: only a server that answered "no such route" gets here (see
      // collabTicket in src/lib/auth-client.ts), and it can only take the
      // session token, exactly as every build did before tickets.
      provider.params = { token: collab.token };
      provider.connect();
      return;
    }
    if (isTransient(answer) && attempt < FIRST_TICKET_RETRY_MS.length) {
      retry = setTimeout(() => void start(attempt + 1), FIRST_TICKET_RETRY_MS[attempt]);
      return;
    }
    if (answer.kind !== "ticket") {
      onUnavailable();
      return;
    }
    provider.params = { ticket: answer.ticket };
    provider.on("connection-close", onClose);
    timer = setInterval(() => void refresh(), TICKET_REFRESH_MS);
    provider.connect();
  };
  void start(0);

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    if (timer) clearInterval(timer);
    provider.off("connection-close", onClose);
  };
}

// The shape RichView writes into a room when it seeds one. Bump it whenever a
// change to the editor's schema would make an older room's content unreadable
// to this build, so a client that meets such a room can say so instead of
// silently mangling it.
export const COLLAB_SCHEMA_VERSION = 1;

// A room is seeded by whichever client gets there first, and the server elects
// exactly one seeder per empty room. This is the client half: after the first
// sync, wait this long and look again before writing anything, so the losing
// racer sees the winner's content rather than adding a second copy of the file.
export const SEED_SETTLE_MS = 150;

export const SCHEMA_MISMATCH_NOTICE =
  "This document was made with a different Markie version; editing may misbehave.";

/** True when a room carries a schema version this build does not speak. */
export function isSchemaMismatch(version: unknown): boolean {
  return typeof version === "number" && version !== COLLAB_SCHEMA_VERSION;
}

/**
 * Whether the schema-mismatch notice should be raised now: only on a genuine
 * mismatch, and only if it has not already been said. The room's meta map can
 * fire the observer many times as edits stream in, so this keeps the warning
 * to once per session.
 */
export function shouldWarnSchema(version: unknown, alreadyWarned: boolean): boolean {
  return !alreadyWarned && isSchemaMismatch(version);
}

const PEER_COLORS = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#14b8a6",
  "#eab308",
];

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
