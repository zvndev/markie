import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  PROVIDER_PENDING_KEY,
  beginProviderSignIn,
  cancelProviderSignIn,
  completeProviderSignIn,
  createSignInAttempts,
  fetchServerSignIn,
  isAuthReturnLink,
  parseServerSignIn,
  providersFor,
  ProviderSignInError,
} from "../src/lib/provider-sign-in";
import { memoryKeyValue } from "../src/lib/session";
import { NetworkError, type HttpRequest, type HttpResponse, type HttpTransport } from "../src/lib/http";

const ORIGIN = "https://api.markiedocs.com";
const SELF = "https://markie.example.com";
const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaaaaaa";
const CODE = "c".repeat(43);
const USER = { id: "u1", email: "me@example.com", name: "Me" };

function fake(handler: (req: HttpRequest) => Partial<HttpResponse> & { json?: unknown } = () => ({ json: { token: TOKEN, user: USER } })) {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = async (req) => {
    calls.push(req);
    const out = handler(req);
    return { status: out.status ?? 200, headers: out.headers ?? {}, text: out.text ?? (out.json === undefined ? "" : JSON.stringify(out.json)) };
  };
  return { transport, calls };
}

const info = (signIn: Record<string, unknown>) => ({ product: "markie-server", apiVersion: 1, signIn });

/** A sign-in started on `origin`, and the link the server would send back for it. */
async function started(origin = ORIGIN, provider: "google" | "apple" = "google") {
  const secure = memoryKeyValue();
  const url = new URL(await beginProviderSignIn({ origin, provider, secure }));
  const kept = JSON.parse((await secure.get(PROVIDER_PENDING_KEY))!) as { state: string; verifier: string };
  const back = (extra: Record<string, string> = {}) => {
    const link = new URL("markie-mobile://auth");
    for (const [name, value] of Object.entries({ code: CODE, state: kept.state, iss: origin, ...extra })) if (value) link.searchParams.set(name, value);
    return link.href;
  };
  return { secure, url, kept, back };
}

describe("what a server offers the phone", () => {
  it("offers Google and Apple only when the server says it can hand a sign-in back to the phone", () => {
    expect(parseServerSignIn(ORIGIN, info({ email: true, google: true, apple: true, mobile: true }))).toEqual({ origin: ORIGIN, emailCode: true, google: true, apple: true });
    // A server from before the hand-off has Google for the desktop, and none for the phone.
    expect(parseServerSignIn(SELF, info({ email: true, google: true, apple: true }))).toEqual({ origin: SELF, emailCode: true, google: false, apple: false });
    expect(parseServerSignIn(SELF, info({ email: false, google: true, mobile: true }))).toEqual({ origin: SELF, emailCode: false, google: true, apple: false });
    expect(parseServerSignIn(SELF, info({ google: "yes", apple: 1, mobile: "true" }))).toMatchObject({ google: false, apple: false });
  });

  it("offers nothing extra when the answer is not a Markie server's", async () => {
    for (const data of [null, "text", {}, { product: "something-else", signIn: { google: true, mobile: true } }, { product: "markie-server" }]) {
      expect(parseServerSignIn(SELF, data)).toEqual({ origin: SELF, emailCode: true, google: false, apple: false });
    }
    const missing = fake(() => ({ status: 404, json: { error: "not found" } }));
    expect(await fetchServerSignIn(SELF, missing.transport)).toMatchObject({ google: false, apple: false });
    const down: HttpTransport = async () => { throw new NetworkError(); };
    expect(await fetchServerSignIn(SELF, down)).toMatchObject({ google: false, apple: false });
    const html = fake(() => ({ text: "<html>" }));
    expect(await fetchServerSignIn(SELF, html.transport)).toMatchObject({ google: false, apple: false });
  });

  it("asks the chosen server and nobody else, with no credentials", async () => {
    const { transport, calls } = fake(() => ({ json: info({ email: true, google: true, mobile: true }) }));
    expect(await fetchServerSignIn(SELF, transport)).toMatchObject({ origin: SELF, google: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${SELF}/api/server-info` });
    expect(calls[0].headers?.authorization).toBeUndefined();
  });

  it("on iOS shows Google only beside Apple, and Apple first", () => {
    const both = parseServerSignIn(ORIGIN, info({ google: true, apple: true, mobile: true }));
    const googleOnly = parseServerSignIn(ORIGIN, info({ google: true, mobile: true }));
    const appleOnly = parseServerSignIn(ORIGIN, info({ google: false, apple: true, mobile: true }));
    expect(providersFor(both, "ios")).toEqual(["apple", "google"]);
    expect(providersFor(googleOnly, "ios")).toEqual([]);
    expect(providersFor(appleOnly, "ios")).toEqual(["apple"]);
    expect(providersFor(both, "android")).toEqual(["google", "apple"]);
    expect(providersFor(googleOnly, "android")).toEqual(["google"]);
    expect(providersFor(null, "android")).toEqual([]);
    expect(providersFor(null, "ios")).toEqual([]);
  });
});

describe("starting a Google or Apple sign-in", () => {
  it("opens the chosen server with the secret's hash, and keeps the secret on the phone", async () => {
    const { url, kept } = await started(SELF, "apple");
    expect(url.origin).toBe(SELF);
    expect(url.pathname).toBe("/auth/mobile-start");
    expect([...url.searchParams.keys()].sort()).toEqual(["challenge", "provider", "state"]);
    expect(url.searchParams.get("provider")).toBe("apple");
    expect(url.searchParams.get("state")).toBe(kept.state);
    expect(kept.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("challenge")).toBe(createHash("sha256").update(kept.verifier).digest("hex"));
    expect(url.href).not.toContain(kept.verifier);
  });

  it("makes a new secret and state every time", async () => {
    const a = await started();
    const b = await started();
    expect(a.kept.verifier).not.toBe(b.kept.verifier);
    expect(a.kept.state).not.toBe(b.kept.state);
  });

  it("refuses a server address a token could not go to", async () => {
    const secure = memoryKeyValue();
    for (const origin of ["http://evil.example", "https://markie.example.com/path", "javascript:alert(1)", ""]) {
      await expect(beginProviderSignIn({ origin, provider: "google", secure })).rejects.toThrow();
    }
    expect(await secure.get(PROVIDER_PENDING_KEY)).toBeNull();
  });
});

describe("the link that comes back", () => {
  it("knows its own shape", () => {
    expect(isAuthReturnLink("markie-mobile://auth?code=x&state=y")).toBe(true);
    expect(isAuthReturnLink("markie-mobile://auth")).toBe(true);
    // The verified link Markie Cloud sends back, on the hosts the app claims.
    expect(isAuthReturnLink("https://markiedocs.com/auth/mobile-return#code=x&state=y")).toBe(true);
    expect(isAuthReturnLink("https://api.markiedocs.com/auth/mobile-return")).toBe(true);
    for (const other of [
      "markie-mobile://d/abc", "markie://auth?token=x", "https://api.markiedocs.com/auth", "markie-mobile://authx", "not a url", "",
      "http://markiedocs.com/auth/mobile-return#code=x", "https://markiedocs.com:444/auth/mobile-return#code=x",
      "https://evil.example/auth/mobile-return#code=x", "https://markiedocs.com.evil.example/auth/mobile-return#code=x",
      "https://user:pw@markiedocs.com/auth/mobile-return#code=x", "https://markiedocs.com/auth/mobile-return/more#code=x",
      "https://markiedocs.com/auth/mobile-bridge#code=x", "https://markie.example.com/auth/mobile-return#code=x",
    ]) {
      expect(isAuthReturnLink(other)).toBe(false);
    }
  });

  it("takes the verified https link Markie Cloud sends, reading the fragment and never the query", async () => {
    const { secure, kept } = await started(ORIGIN);
    const { transport, calls } = fake();
    const carried = `code=${CODE}&state=${kept.state}&iss=${encodeURIComponent(ORIGIN)}`;
    // The same pieces in the query are not the app's link: a server would have seen them.
    expect(await completeProviderSignIn(`https://markiedocs.com/auth/mobile-return?${carried}`, { secure, transport })).toBeNull();
    expect(calls).toHaveLength(0);
    const result = await completeProviderSignIn(`https://markiedocs.com/auth/mobile-return#${carried}`, { secure, transport });
    expect(result).toEqual({ origin: ORIGIN, token: TOKEN, user: USER });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${ORIGIN}/auth/mobile-exchange`, body: { code: CODE, verifier: kept.verifier, state: kept.state } });
  });

  it("trades the code and the kept secret for the session, on the server the sign-in started on", async () => {
    const { secure, kept, back } = await started(SELF);
    const { transport, calls } = fake();
    const result = await completeProviderSignIn(back(), { secure, transport });
    expect(result).toEqual({ origin: SELF, token: TOKEN, user: USER });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${SELF}/auth/mobile-exchange`,
      body: { client: "markie-mobile", code: CODE, verifier: kept.verifier, state: kept.state },
    });
    // The secret is used once: the same link again is a link nobody is waiting for.
    expect(await secure.get(PROVIDER_PENDING_KEY)).toBeNull();
    expect(await completeProviderSignIn(back(), { secure, transport })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("ignores a link when no sign-in is waiting, and sends nothing", async () => {
    const { transport, calls } = fake();
    expect(await completeProviderSignIn(`markie-mobile://auth?code=${CODE}&state=${"a".repeat(32)}&iss=${ORIGIN}`, { secure: memoryKeyValue(), transport })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("ignores a link with the wrong state, and leaves the real sign-in waiting", async () => {
    const { secure, back } = await started();
    const { transport, calls } = fake();
    for (const state of ["b".repeat(32), "", "nope"]) {
      expect(await completeProviderSignIn(back({ state }), { secure, transport })).toBeNull();
    }
    expect(await completeProviderSignIn(`markie-mobile://auth?token=${TOKEN}`, { secure, transport })).toBeNull();
    expect(calls).toHaveLength(0);
    // A page that fired those links did not cancel anything.
    expect(await completeProviderSignIn(back(), { secure, transport })).toMatchObject({ token: TOKEN });
  });

  it("never sends the hand-off to a server other than the one chosen", async () => {
    for (const iss of ["https://evil.example", "", "not a url", "https://markie.example.com.evil.example"]) {
      const { secure, back } = await started(SELF);
      const { transport, calls } = fake();
      expect(await completeProviderSignIn(back({ iss }), { secure, transport })).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("a foreign link that knows the state does not use up or cancel the sign-in that is waiting", async () => {
    const { secure, kept, back } = await started(SELF);
    const { transport, calls } = fake();
    const waiting = await secure.get(PROVIDER_PENDING_KEY);
    const malformed = new URL(back());
    malformed.searchParams.set("code", "short");
    const foreign = [
      // The right state, from another server, with a code or with a refusal.
      back({ iss: "https://evil.example" }),
      back({ iss: "https://evil.example", code: "", error: "failed" }),
      back({ iss: "" }),
      // The right state and server, and nothing this app can act on.
      back({ code: "" }),
      malformed.href,
      `https://markiedocs.com/auth/mobile-return#state=${kept.state}&iss=https%3A%2F%2Fevil.example&code=${CODE}`,
    ];
    for (const link of foreign) {
      expect(await completeProviderSignIn(link, { secure, transport })).toBeNull();
      expect(await secure.get(PROVIDER_PENDING_KEY)).toBe(waiting);
    }
    expect(calls).toHaveLength(0);
    // The real answer still finishes the sign-in afterwards.
    expect(await completeProviderSignIn(back(), { secure, transport })).toMatchObject({ origin: SELF, token: TOKEN });
    expect(calls).toHaveLength(1);
  });

  it("a late answer does not replace a newer sign-in: its session is ended and nothing is returned", async () => {
    const { secure, back } = await started(SELF);
    const attempts = createSignInAttempts();
    const current = attempts.begin();
    const calls: HttpRequest[] = [];
    const transport: HttpTransport = async (req) => {
      calls.push(req);
      // While the server is answering, the person signs in with a password.
      if (req.url.endsWith("/auth/mobile-exchange")) attempts.supersede();
      return { status: 200, headers: {}, text: JSON.stringify({ token: TOKEN, user: USER }) };
    };
    expect(current()).toBe(true);
    expect(await completeProviderSignIn(back(), { secure, transport, stillCurrent: current })).toBeNull();
    expect(current()).toBe(false);
    // The session the server just made is not left behind.
    expect(calls.map((call) => call.url)).toEqual([`${SELF}/auth/mobile-exchange`, `${SELF}/api/auth/sign-out`]);
    expect(calls[1]).toMatchObject({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    // An attempt begun after that is its own.
    expect(attempts.begin()()).toBe(true);
  });

  it("a sign-in that is still the current one is kept", async () => {
    const { secure, back } = await started(SELF);
    const { transport, calls } = fake();
    const current = createSignInAttempts().begin();
    expect(await completeProviderSignIn(back(), { secure, transport, stillCurrent: current })).toMatchObject({ token: TOKEN });
    expect(calls).toHaveLength(1);
  });

  it("is cancelled by another sign-in or a change of server: the link that then comes back is ignored", async () => {
    const { secure, back } = await started(SELF);
    const { transport, calls } = fake();
    await cancelProviderSignIn(secure);
    expect(await secure.get(PROVIDER_PENDING_KEY)).toBeNull();
    expect(await completeProviderSignIn(back(), { secure, transport })).toBeNull();
    expect(calls).toHaveLength(0);
    // Cancelling with nothing waiting is not an error.
    await cancelProviderSignIn(memoryKeyValue());
  });

  it("never takes a session from the link itself", async () => {
    const { secure, back } = await started();
    const { transport, calls } = fake(() => ({ status: 400, json: { error: "invalid_handoff" } }));
    await expect(completeProviderSignIn(back({ token: TOKEN }), { secure, transport })).rejects.toThrow("Google sign-in didn't finish. Try again.");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].body)).not.toContain(TOKEN);
  });

  it("ignores a malformed code without asking the server", async () => {
    for (const code of ["", "short", `${CODE}x`, "has space"]) {
      const { secure, back } = await started();
      const { transport, calls } = fake();
      const link = new URL(back());
      link.searchParams.set("code", code);
      expect(await completeProviderSignIn(link.href, { secure, transport })).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("gives up on a sign-in that waited too long", async () => {
    const { secure, back } = await started();
    const { transport, calls } = fake();
    await expect(completeProviderSignIn(back(), { secure, transport, now: () => Date.now() + 16 * 60 * 1000 })).rejects.toThrow("Google sign-in took too long. Try again.");
    expect(calls).toHaveLength(0);
  });

  it("says why the server refused, in the app's own words", async () => {
    const cases: Array<[string, RegExp]> = [
      ["account_not_linked", /already has a Markie account/],
      ["signup_invite_required", /invite-only/],
      ["signup_closed", /isn't taking new accounts/],
      ["provider_email_unverified", /Apple hasn't verified that email/],
      ["failed", /Apple sign-in didn't finish/],
      ["<script>alert(1)</script>", /Apple sign-in didn't finish/],
    ];
    for (const [error, words] of cases) {
      const { secure, back } = await started(ORIGIN, "apple");
      const { transport, calls } = fake();
      await expect(completeProviderSignIn(back({ code: "", error }), { secure, transport })).rejects.toThrow(words);
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses an answer with no usable session or no account", async () => {
    for (const json of [{}, { token: "short", user: USER }, { token: TOKEN }, { token: TOKEN, user: { id: "", email: "me@example.com" } }, { token: TOKEN, user: { id: "u1" } }]) {
      const { secure, back } = await started();
      const { transport } = fake(() => ({ json }));
      await expect(completeProviderSignIn(back(), { secure, transport })).rejects.toBeInstanceOf(ProviderSignInError);
    }
    const { secure, back } = await started();
    const offline: HttpTransport = async () => { throw new NetworkError(); };
    await expect(completeProviderSignIn(back(), { secure, transport: offline })).rejects.toThrow(/Can't reach the server/);
  });

  it("treats a tampered record in the Keychain as nothing waiting", async () => {
    const { transport, calls } = fake();
    for (const record of ["not json", "{}", JSON.stringify({ state: "a".repeat(32), verifier: "b".repeat(64), origin: "http://evil.example", provider: "google", at: Date.now() })]) {
      const secure = memoryKeyValue();
      await secure.set(PROVIDER_PENDING_KEY, record);
      expect(await completeProviderSignIn(`markie-mobile://auth?code=${CODE}&state=${"a".repeat(32)}&iss=http://evil.example`, { secure, transport })).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });
});
