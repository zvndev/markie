// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The web app's session: the API origin's cookie session, asked for with a
// credentialed fetch (the app may be served on the docs host), its token held
// in memory only, every client talking to the API origin, and the live socket
// going where the page says. Only a real "signed out" sends the browser to
// the sign-in; anything else is an error, so the two can never bounce.

type Client = typeof import("@/lib/auth-client");
type Session = typeof import("./session");
let client: Client;
let session: Session;

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  client = await import("@/lib/auth-client");
  session = await import("./session");
});
afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown, status = 200) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
const SIGNED_IN = { session: { token: "tok_abcdefghijklmnop" }, user: { id: "u1", email: "a@example.com", name: "A" } };
const API = "https://api.example.test";

describe("web session boot", () => {
  it("asks the API origin with credentials, and adopts its session in memory only", async () => {
    const fetcher = answer(SIGNED_IN);
    const boot = await session.bootWebSession(API, "wss://api.example.test/collab", fetcher);
    expect(boot).toEqual({ kind: "signed-in", user: { id: "u1", email: "a@example.com", name: "A" } });
    expect(fetcher).toHaveBeenCalledWith(`${API}/api/auth/get-session`, { credentials: "include", cache: "no-store" });
    expect(client.inWebSession()).toBe(true);
    expect(client.getServerURL()).toBe(API);
    expect(client.getAuthToken()).toBe("tok_abcdefghijklmnop");
    expect(client.collabWsBase()).toBe("wss://api.example.test/collab");
    // Never written anywhere a later page load could read it.
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) expect(store.getItem(store.key(i)!)).not.toContain("tok_");
    }
  });

  it("uses the API origin's own socket when the page names none", async () => {
    await session.bootWebSession("https://markie.example.org", null, answer(SIGNED_IN));
    expect(client.collabWsBase()).toBe("wss://markie.example.org/collab");
  });

  it("is signed out on a 401 or better-auth's empty answer, and leaves the client untouched", async () => {
    expect(await session.bootWebSession(API, null, answer(null))).toEqual({ kind: "signed-out" });
    expect(await session.bootWebSession(API, null, answer({ error: "no" }, 401))).toEqual({ kind: "signed-out" });
    expect(client.inWebSession()).toBe(false);
  });

  it("calls anything else an error, never signed out, so it cannot loop through the sign-in", async () => {
    for (const status of [429, 500, 502, 403]) {
      expect(await session.bootWebSession(API, null, answer({}, status))).toEqual({ kind: "error", status });
    }
    // A session whose shape is wrong is not a reason to sign in again either.
    expect((await session.bootWebSession(API, null, answer({ session: { token: "short" }, user: { id: "u", email: "e" } }))).kind).toBe("error");
    expect(client.inWebSession()).toBe(false);
  });

  it("ignores a server address change while it is the web app", async () => {
    await session.bootWebSession(API, null, answer(SIGNED_IN));
    client.setServerURL("https://elsewhere.example");
    expect(client.getServerURL()).toBe(API);
  });
});

describe("the page's server addresses", () => {
  const page = (content: string | null) => ({ querySelector: () => content === null ? null : { getAttribute: () => content } }) as unknown as Document;
  it("takes only a ws(s) /collab address for the socket", () => {
    expect(session.collabBaseFrom(page("wss://api.markiedocs.com/collab"))).toBe("wss://api.markiedocs.com/collab");
    expect(session.collabBaseFrom(page("ws://localhost:8799/collab"))).toBe("ws://localhost:8799/collab");
    for (const bad of [null, "", "https://api.markiedocs.com/collab", "wss://api.markiedocs.com/collab?token=x", "ws://evil.example/collab", "wss://a.example/other", "javascript:alert(1)"]) {
      expect(session.collabBaseFrom(page(bad))).toBeNull();
    }
  });

  it("takes only an exact https origin for the API, or loopback http, and otherwise the page's own", () => {
    const own = "https://markiedocs.com";
    expect(session.apiOriginFrom(page("https://api.markiedocs.com"), own)).toBe("https://api.markiedocs.com");
    expect(session.apiOriginFrom(page("http://localhost:8787"), own)).toBe("http://localhost:8787");
    // The reserved development names (RFC 6761) may be plain http too.
    expect(session.apiOriginFrom(page("http://api.markie.localhost:8799"), own)).toBe("http://api.markie.localhost:8799");
    expect(session.apiOriginFrom(page("http://api.markie.test"), own)).toBe("http://api.markie.test");
    expect(session.collabBaseFrom(page("ws://api.markie.localhost:8799/collab"))).toBe("ws://api.markie.localhost:8799/collab");
    for (const bad of [null, "", "http://api.markiedocs.com", "https://api.markiedocs.com/", "https://api.markiedocs.com/x", "https://u:p@api.markiedocs.com", "javascript:alert(1)", "not a url"]) {
      expect(session.apiOriginFrom(page(bad), own)).toBe(own);
    }
  });
});

describe("the sign-in bounce guard", () => {
  it("stops a second trip to the sign-in moments after the first", () => {
    const now = 1_000_000;
    expect(session.signInWouldBounce(sessionStorage, now)).toBe(false);
    session.markSignInSent(sessionStorage, now);
    expect(session.signInWouldBounce(sessionStorage, now + 5_000)).toBe(true);
    // A later visit is not a bounce.
    expect(session.signInWouldBounce(sessionStorage, now + 10 * 60 * 1000)).toBe(false);
    session.clearSignInMark(sessionStorage);
    expect(session.signInWouldBounce(sessionStorage, now + 5_000)).toBe(false);
  });
});
