import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAB_SCHEMA_VERSION,
  colorForName,
  connectWithTicket,
  TICKET_CLOSE_REFRESH_MIN_MS,
  FIRST_TICKET_RETRY_MS,
  TICKET_REFRESH_MS,
  type CollabTicketAnswer,
  type TicketedProvider,
  initials,
  RICH_SCHEMA_MATH,
  RICH_SCHEMA_PLAIN,
  roomSchemaOf,
  SEED_SETTLE_MS,
  TEXT_ROOM_SCHEMA,
} from "./collab";

const PALETTE = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#14b8a6",
  "#eab308",
];

describe("colorForName", () => {
  it("always returns a colour from the peer palette", () => {
    for (const name of ["", "a", "Ada Lovelace", "ada@markie.app", "日本語", "x".repeat(200)]) {
      expect(PALETTE).toContain(colorForName(name));
    }
  });

  it("is stable for the same name", () => {
    expect(colorForName("Ada Lovelace")).toBe(colorForName("Ada Lovelace"));
  });

  it("spreads distinct names across the palette", () => {
    const distinct = new Set(
      ["Ada", "Grace", "Alan", "Barbara", "Katherine", "Edsger", "Linus", "Rich"].map(
        colorForName
      )
    );
    expect(distinct.size).toBeGreaterThan(3);
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada lovelace king")).toBe("AL");
  });

  it("takes two letters from a single word", () => {
    expect(initials("Ada")).toBe("AD");
    expect(initials("k")).toBe("K");
  });

  it("splits email addresses on @ and .", () => {
    expect(initials("ada.lovelace@markie.app")).toBe("AL");
    expect(initials("ada@markie.app")).toBe("AM");
  });

  it("falls back to ? for empty or punctuation-only names", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
    expect(initials("@.@")).toBe("?");
  });

  it("trims surrounding whitespace", () => {
    expect(initials("  Ada Lovelace  ")).toBe("AL");
  });
});

describe("collab schema version", () => {
  it("is a whole number so rooms can be compared across builds", () => {
    expect(Number.isInteger(COLLAB_SCHEMA_VERSION)).toBe(true);
    expect(COLLAB_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("leaves room for the winning seeder's update to arrive", () => {
    expect(SEED_SETTLE_MS).toBeGreaterThan(0);
  });
});

describe("room schema", () => {
  it("speaks the math schema, and stamps plain rooms as every build reads them", () => {
    expect(COLLAB_SCHEMA_VERSION).toBe(RICH_SCHEMA_MATH);
    expect(RICH_SCHEMA_PLAIN).toBe(1);
    // Text rooms never changed: every build may join them.
    expect(TEXT_ROOM_SCHEMA).toBe(1);
  });

  it("reads a room with no stamp, or a stamp that is not a version, as nothing recorded", () => {
    expect(roomSchemaOf(undefined)).toBe(0);
    expect(roomSchemaOf(null)).toBe(0);
    expect(roomSchemaOf("2")).toBe(0);
    expect(roomSchemaOf({ v: 2 })).toBe(0);
    expect(roomSchemaOf(1.5)).toBe(0);
    expect(roomSchemaOf(2)).toBe(2);
  });

  it("ignores a stamp above the newest schema it knows, so one editor cannot lock a room", () => {
    expect(roomSchemaOf(COLLAB_SCHEMA_VERSION + 1)).toBe(0);
    expect(roomSchemaOf(999)).toBe(0);
  });
});

// ── the live-editing pass ──

class FakeProvider implements TicketedProvider {
  params: Record<string, string> = {};
  shouldConnect = false;
  connects = 0;
  #onClose = new Set<(event: CloseEvent | null) => void>();
  connect() {
    this.shouldConnect = true;
    this.connects += 1;
  }
  on(_event: "connection-close", fn: (event: CloseEvent | null) => void) {
    this.#onClose.add(fn);
  }
  off(_event: "connection-close", fn: (event: CloseEvent | null) => void) {
    this.#onClose.delete(fn);
  }
  drop(code: number) {
    for (const fn of [...this.#onClose]) fn({ code } as CloseEvent);
  }
}

const SESSION_TOKEN = "account-wide-session-token";
const ticket = (value: string): CollabTicketAnswer => ({ kind: "ticket", ticket: value, expiresAt: 0 });

// Answers in order, then repeats the last one.
function answers(...list: Array<CollabTicketAnswer | Error>) {
  let i = 0;
  return vi.fn(async (): Promise<CollabTicketAnswer> => {
    const next = list[Math.min(i++, list.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });
}

describe("connectWithTicket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects only once the first ticket is in, and never with the session token", async () => {
    let release!: (answer: CollabTicketAnswer) => void;
    const fetchTicket = vi.fn(() => new Promise<CollabTicketAnswer>((resolve) => (release = resolve)));
    const provider = new FakeProvider();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.connects).toBe(0);

    release(ticket("t1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.connects).toBe(1);
    expect(provider.params).toEqual({ ticket: "t1" });
  });

  it("swaps in a fresh ticket every two minutes, and a failed refresh keeps the one it has", async () => {
    const fetchTicket = answers(ticket("t1"), ticket("t2"), { kind: "failed", status: 503 }, ticket("t4"));
    const provider = new FakeProvider();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    const params = provider.params;

    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS);
    expect(provider.params.ticket).toBe("t2");
    // In place: y-websocket reads this object on every connect.
    expect(provider.params).toBe(params);

    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS);
    expect(provider.params.ticket).toBe("t2");

    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS);
    expect(provider.params).toEqual({ ticket: "t4" });
    expect(provider.connects).toBe(1);
  });

  it("asks again when the connection drops, unless the pass is fresh or the drop was deliberate", async () => {
    const fetchTicket = answers(ticket("t1"), ticket("t2"), ticket("t3"));
    const provider = new FakeProvider();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, () => {});
    await vi.advanceTimersByTimeAsync(0);

    provider.drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TICKET_CLOSE_REFRESH_MIN_MS);
    provider.drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(provider.params.ticket).toBe("t2");

    // A deliberate disconnect has nothing to reconnect.
    await vi.advanceTimersByTimeAsync(TICKET_CLOSE_REFRESH_MIN_MS);
    provider.shouldConnect = false;
    provider.drop(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
  });

  it("stops asking for good once the server closes with its final answer", async () => {
    const fetchTicket = answers(ticket("t1"), ticket("t2"));
    const provider = new FakeProvider();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    provider.drop(4403);
    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS * 3);
    provider.drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
  });

  it("stops refreshing once a refresh is refused, but keeps going through blips", async () => {
    const fetchTicket = answers(ticket("t1"), { kind: "failed", status: 502 }, { kind: "failed", status: 401 }, ticket("t4"));
    const provider = new FakeProvider();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS);
    expect(fetchTicket).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS * 3);
    await vi.advanceTimersByTimeAsync(TICKET_CLOSE_REFRESH_MIN_MS);
    provider.drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(3);
    expect(provider.params.ticket).toBe("t1");
  });

  it("counts a failed ask against the close guard, so a refusing server is not asked on every close", async () => {
    const fetchTicket = answers(ticket("t1"), { kind: "failed", status: 503 });
    const provider = new FakeProvider();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TICKET_CLOSE_REFRESH_MIN_MS);
    provider.drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      provider.drop(1006);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
  });

  it("uses the session token only for a server with no ticket route, and does not refresh it", async () => {
    const fetchTicket = answers({ kind: "legacy" });
    const provider = new FakeProvider();
    const unavailable = vi.fn();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, unavailable);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.params).toEqual({ token: SESSION_TOKEN });
    expect(provider.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS * 2);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("treats a refusal as no live session at once, never reaching for the token", async () => {
    for (const answer of [{ kind: "failed", status: 401 } as const, { kind: "failed", status: 404 } as const]) {
      const provider = new FakeProvider();
      const unavailable = vi.fn();
      const fetchTicket = answers(answer);
      connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, unavailable);
      await vi.advanceTimersByTimeAsync(0);
      expect(unavailable).toHaveBeenCalledTimes(1);
      expect(fetchTicket).toHaveBeenCalledTimes(1);
      expect(provider.connects).toBe(0);
      expect(provider.params).toEqual({});
    }
  });

  it("tries the first pass again through a blip, then gives up without the token", async () => {
    const total = FIRST_TICKET_RETRY_MS.reduce((sum, ms) => sum + ms, 0);
    for (const blip of [new Error("offline"), { kind: "failed", status: 503 } as const, { kind: "failed", status: 429 } as const]) {
      const provider = new FakeProvider();
      const unavailable = vi.fn();
      const fetchTicket = answers(blip);
      connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket }, unavailable);
      await vi.advanceTimersByTimeAsync(0);
      expect(unavailable).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(total);
      expect(fetchTicket).toHaveBeenCalledTimes(FIRST_TICKET_RETRY_MS.length + 1);
      expect(unavailable).toHaveBeenCalledTimes(1);
      expect(provider.params).toEqual({});
    }
    const provider = new FakeProvider();
    const unavailable = vi.fn();
    connectWithTicket(provider, { token: SESSION_TOKEN, fetchTicket: answers(new Error("offline"), ticket("t1")) }, unavailable);
    await vi.advanceTimersByTimeAsync(FIRST_TICKET_RETRY_MS[0]);
    expect(provider.params).toEqual({ ticket: "t1" });
    expect(provider.connects).toBe(1);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("stops cleanly: no connect after an early stop, no refresh after a late one", async () => {
    let release!: (answer: CollabTicketAnswer) => void;
    const early = new FakeProvider();
    const stopEarly = connectWithTicket(
      early,
      { token: SESSION_TOKEN, fetchTicket: () => new Promise((resolve) => (release = resolve)) },
      () => {}
    );
    stopEarly();
    release(ticket("t1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(early.connects).toBe(0);

    const fetchTicket = answers(ticket("t1"));
    const late = new FakeProvider();
    const stopLate = connectWithTicket(late, { token: SESSION_TOKEN, fetchTicket }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    stopLate();
    await vi.advanceTimersByTimeAsync(TICKET_REFRESH_MS * 3);
    late.drop(1006);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
  });
});
