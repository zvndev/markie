// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The web app's session: the cookie session's token is held in memory only,
// every client talks to the page's own origin, and the live socket goes where
// the page says (the server, when the app is served through a website).

type Client = typeof import("@/lib/auth-client");
type Session = typeof import("./session");
let client: Client;
let session: Session;

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  client = await import("@/lib/auth-client");
  session = await import("./session");
});
afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 401, json: async () => body })) as unknown as typeof fetch;

describe("web session boot", () => {
  it("adopts the cookie session for this origin, in memory only", async () => {
    const fetcher = answer({ session: { token: "tok_abcdefghijklmnop" }, user: { id: "u1", email: "a@example.com", name: "A" } });
    const user = await session.bootWebSession("https://docs.example.test", "wss://api.example.test/collab", fetcher);
    expect(user).toEqual({ id: "u1", email: "a@example.com", name: "A" });
    expect(client.inWebSession()).toBe(true);
    expect(client.getServerURL()).toBe("https://docs.example.test");
    expect(client.getAuthToken()).toBe("tok_abcdefghijklmnop");
    expect(client.collabWsBase()).toBe("wss://api.example.test/collab");
    // Never written anywhere a later page load could read it.
    expect(JSON.stringify({ ...localStorage })).not.toContain("tok_abcdefghijklmnop");
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!)).not.toContain("tok_");
  });

  it("uses this origin's own socket when the page names none", async () => {
    await session.bootWebSession("https://markie.example.org", null, answer({ session: { token: "tok_abcdefghijklmnop" }, user: { id: "u1", email: "a@example.com" } }));
    expect(client.collabWsBase()).toBe("wss://markie.example.org/collab");
  });

  it("is signed out when there is no session, and leaves the client untouched", async () => {
    expect(await session.bootWebSession("https://docs.example.test", null, answer(null))).toBeNull();
    expect(await session.bootWebSession("https://docs.example.test", null, answer({ session: { token: "short" }, user: { id: "u", email: "e" } }))).toBeNull();
    expect(client.inWebSession()).toBe(false);
  });

  it("ignores a server address change while it is the web app", async () => {
    await session.bootWebSession("https://docs.example.test", null, answer({ session: { token: "tok_abcdefghijklmnop" }, user: { id: "u1", email: "a@example.com" } }));
    client.setServerURL("https://elsewhere.example");
    expect(client.getServerURL()).toBe("https://docs.example.test");
  });
});

describe("the page's collab address", () => {
  const page = (content: string | null) => ({ querySelector: () => content === null ? null : { getAttribute: () => content } }) as unknown as Document;
  it("takes only a ws(s) /collab address", () => {
    expect(session.collabBaseFrom(page("wss://api.markiedocs.com/collab"))).toBe("wss://api.markiedocs.com/collab");
    expect(session.collabBaseFrom(page("ws://localhost:8799/collab"))).toBe("ws://localhost:8799/collab");
    for (const bad of [null, "", "https://api.markiedocs.com/collab", "wss://api.markiedocs.com/collab?token=x", "ws://evil.example/collab", "wss://a.example/other", "javascript:alert(1)"]) {
      expect(session.collabBaseFrom(page(bad))).toBeNull();
    }
  });
});
