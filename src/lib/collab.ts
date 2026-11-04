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

// ── Room schema versions ──────────────────────────────────────────────────
//
// A room says in its meta map ("schemaVersion") the oldest editor that can
// represent it, and a client says on its ticket request (and so to the
// server's gate, server/src/collab-schema.ts) the newest room it can.
//
//   1  Everything up to desktop 0.9.4: paragraphs, headings, lists, tables
//      (with their cells' alignment), pictures, embeds, marks; math held as
//      text. Plain text rooms (Y.Text) are always 1.
//   2  A rich room an older build would damage:
//      * one holding a math node (mathInline, mathBlock; rich-math.ts). A
//        build without those nodes cannot draw it at all: its binding stops
//        on the first one and shows an empty or stale page, and its writer
//        could then report that page as the room's text and push it over the
//        stored copy.
//      * the room of a document with front matter. The room holds only the
//        body, and 0.9.4's desktop writes its file from a live room with no
//        front matter in front, so it would delete the YAML from the file.
//      So the server keeps older builds out of these rooms.
//
// The version is raised only when a room first needs it (a formula arrives,
// or a client whose copy has front matter seeds or opens it), never just
// because a newer build opened the room: a plain document stays open to
// every build.
//
// A stamp above the newest schema this build knows is ignored, here and on
// the server: any editor can write the meta map, and a stamp of 999 must not
// lock a room for everyone. A room this build truly cannot draw is still
// refused, by its binding (RichView).

/** The newest room schema this build reads and writes. Sent with each ticket request. */
export const COLLAB_SCHEMA_VERSION = 2;
/** A rich room with nothing in it an older build cannot draw. */
export const RICH_SCHEMA_PLAIN = 1;
/** A rich room holding a math node. */
export const RICH_SCHEMA_MATH = 2;
/** Plain text rooms (Y.Text) are byte-faithful to every build. */
export const TEXT_ROOM_SCHEMA = 1;
/** The key in the room's meta map. */
export const SCHEMA_KEY = "schemaVersion";
/**
 * Set once per room, by the client that seeded it or brought an older room
 * up to date (rich-room-migrate.ts); the server lets exactly one update set
 * it (server/src/collab-schema.ts). Its absence marks a room an older build
 * seeded.
 */
export const MODEL_KEY = "editorModel";
/** The value: this build's model (math nodes, no front matter in the room). */
export const EDITOR_MODEL = 2;

/** The schema a room's meta map records, or 0 when it records none or one this build does not know. */
export function roomSchemaOf(version: unknown): number {
  return typeof version === "number" && Number.isInteger(version) && version > 0 && version <= COLLAB_SCHEMA_VERSION ? version : 0;
}

/**
 * The server's final answer when a room has moved past this client
 * (server/src/collab.ts). A build that predates it gets 4403 instead, the
 * only close code it stops on.
 */
export const CLOSE_ROOM_TOO_NEW = 4426;

// A room is seeded by whichever client gets there first, and the server elects
// exactly one seeder per empty room. This is the client half: after the first
// sync, wait this long and look again before writing anything, so the losing
// racer sees the winner's content rather than adding a second copy of the file.
export const SEED_SETTLE_MS = 150;

/**
 * How long a client waits for the server to answer its seed or migration
 * (RichView claimRoom) before it gives the room up and goes back to the
 * local copy, saying so. An object so a test can shorten it.
 */
export const liveTiming = { claimTimeoutMs: 15_000 };


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
