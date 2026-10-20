import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SERVER,
  parseServerOrigin,
  parseServerInfo,
  probeServerInfo,
  createServerStore,
  isReservedName,
  PROBE_TTL_MS,
} from "./servers.js";

const INFO = {
  product: "markie-server",
  apiVersion: 1,
  version: "1.2.3",
  name: "Team docs",
  origin: "https://docs.example.com",
  signIn: { email: true, google: false },
};

function answer(status: number, body: unknown) {
  const fn = vi.fn(async (..._args: unknown[]) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  );
  return fn as typeof fn & typeof fetch;
}

// A body that never ends, counting how much of it was pulled and whether
// the reader gave up on it.
function endless(chunk = 16 * 1024) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      seen.pulled += chunk;
      c.enqueue(new Uint8Array(chunk).fill(32));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

describe("parseServerOrigin", () => {
  it("reduces a typed address to an exact https origin", () => {
    expect(parseServerOrigin("https://docs.example.com")).toMatchObject({ ok: true, origin: "https://docs.example.com" });
    expect(parseServerOrigin("  https://Docs.Example.com/ ")).toMatchObject({ ok: true, origin: "https://docs.example.com" });
    expect(parseServerOrigin("docs.example.com")).toMatchObject({ ok: true, origin: "https://docs.example.com" });
    expect(parseServerOrigin("https://docs.example.com:8443")).toMatchObject({ ok: true, origin: "https://docs.example.com:8443" });
    // The default port is the same origin, not a different one.
    expect(parseServerOrigin("https://docs.example.com:443")).toMatchObject({ ok: true, origin: "https://docs.example.com" });
  });

  it("refuses anything that is not https", () => {
    expect(parseServerOrigin("http://docs.example.com").ok).toBe(false);
    expect(parseServerOrigin("ftp://docs.example.com").ok).toBe(false);
    expect(parseServerOrigin("javascript:alert(1)").ok).toBe(false);
  });

  it("refuses credentials in the address", () => {
    expect(parseServerOrigin("https://user:pass@docs.example.com").ok).toBe(false);
    expect(parseServerOrigin("https://user@docs.example.com").ok).toBe(false);
  });

  it("refuses a path, query or fragment, so only an exact origin is ever trusted", () => {
    expect(parseServerOrigin("https://docs.example.com/api").ok).toBe(false);
    expect(parseServerOrigin("https://docs.example.com/?x=1").ok).toBe(false);
    expect(parseServerOrigin("https://docs.example.com/#a").ok).toBe(false);
  });

  it("refuses empty, spaced or garbage input", () => {
    expect(parseServerOrigin("").ok).toBe(false);
    expect(parseServerOrigin("   ").ok).toBe(false);
    expect(parseServerOrigin("https://docs example.com").ok).toBe(false);
    expect(parseServerOrigin(null as unknown as string).ok).toBe(false);
    expect(parseServerOrigin("https://").ok).toBe(false);
  });

  it("allows localhost only in dev", () => {
    expect(parseServerOrigin("http://localhost:8787").ok).toBe(false);
    expect(parseServerOrigin("https://localhost:8787").ok).toBe(false);
    expect(parseServerOrigin("http://localhost:8787", { allowDev: true })).toMatchObject({
      ok: true,
      origin: "http://localhost:8787",
    });
    expect(parseServerOrigin("http://127.0.0.1:8787", { allowDev: true }).ok).toBe(true);
    // Dev still does not open http to the rest of the world.
    expect(parseServerOrigin("http://docs.example.com", { allowDev: true }).ok).toBe(false);
  });
});

describe("parseServerInfo", () => {
  it("accepts the contract and keeps only what it understands", () => {
    const r = parseServerInfo(INFO, "https://docs.example.com");
    expect(r).toEqual({
      ok: true,
      info: { name: "Team docs", apiVersion: 1, version: "1.2.3", signIn: { email: true, google: false, signup: "open" } },
    });
  });

  it("keeps the server's sign-up mode, reading anything unknown as open", () => {
    for (const signup of ["open", "invite", "closed"]) {
      expect(parseServerInfo({ ...INFO, signIn: { ...INFO.signIn, signup } }, "https://docs.example.com")).toMatchObject({
        info: { signIn: { signup } },
      });
    }
    expect(parseServerInfo({ ...INFO, signIn: { ...INFO.signIn, signup: "maybe" } }, "https://docs.example.com")).toMatchObject({
      info: { signIn: { signup: "open" } },
    });
  });

  it("refuses a body that is not a Markie server", () => {
    expect(parseServerInfo({ ...INFO, product: "other" }, "https://docs.example.com").ok).toBe(false);
    expect(parseServerInfo(null, "https://docs.example.com").ok).toBe(false);
    expect(parseServerInfo("hi", "https://docs.example.com").ok).toBe(false);
  });

  it("refuses an API version it does not speak", () => {
    expect(parseServerInfo({ ...INFO, apiVersion: 2 }, "https://docs.example.com").ok).toBe(false);
    expect(parseServerInfo({ ...INFO, apiVersion: "1" }, "https://docs.example.com").ok).toBe(false);
  });

  it("refuses a server that reports a different origin from the one asked", () => {
    const r = parseServerInfo({ ...INFO, origin: "https://elsewhere.example.com" }, "https://docs.example.com");
    expect(r.ok).toBe(false);
  });

  it("falls back to the host for a missing name and strips control characters", () => {
    expect(parseServerInfo({ ...INFO, name: undefined }, "https://docs.example.com")).toMatchObject({
      info: { name: "docs.example.com" },
    });
    expect(parseServerInfo({ ...INFO, name: "Team‮ docs\n" }, "https://docs.example.com")).toMatchObject({
      info: { name: "Team docs" },
    });
  });

  // A server that calls itself Markie Cloud would have the user type their
  // Cloud password into its sign-in form. It is shown under its host instead.
  it("shows a server that passes for Markie Cloud under its host", () => {
    for (const name of [
      "Markie Cloud",
      "Markie",
      "  markie   CLOUD ",
      "M a r k i e  C l o u d",
      "Mаrkie Cloud", // Cyrillic a
      "Markіe", // Cyrillic i
      "Mark1e Cloud",
      "Ｍａｒｋｉｅ Ｃｌｏｕｄ", // full-width
      "Mar\u200bkie Cloud", // zero-width space
      "Markie Cloud (official)",
      "The Markie Cloud",
      "markie.cloud",
      "rnarkie",
    ]) {
      expect(isReservedName(name), name).toBe(true);
      expect(parseServerInfo({ ...INFO, name }, "https://docs.example.com"), name).toMatchObject({
        info: { name: "docs.example.com" },
      });
    }
  });

  it("keeps a name that only mentions Markie among words of its own", () => {
    for (const name of ["Acme's Markie", "Markie at Acme", "Team docs", "Cloud"]) {
      expect(isReservedName(name), name).toBe(false);
    }
    expect(parseServerInfo({ ...INFO, name: "Markie at Acme" }, "https://docs.example.com")).toMatchObject({
      info: { name: "Markie at Acme" },
    });
  });

  it("treats Google as off unless the server says it is on", () => {
    expect(parseServerInfo({ ...INFO, signIn: undefined }, "https://docs.example.com")).toMatchObject({
      info: { signIn: { email: true, google: false } },
    });
  });
});

describe("probeServerInfo", () => {
  it("asks without credentials and without following redirects", async () => {
    const fetchImpl = answer(200, INFO);
    await probeServerInfo("https://docs.example.com", { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://docs.example.com/api/server-info");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it("reads a 404 from the default server as Markie Cloud's defaults", async () => {
    const r = await probeServerInfo(DEFAULT_SERVER, { fetchImpl: answer(404, "Not found") });
    expect(r).toMatchObject({ ok: true, info: { name: "Markie Cloud", apiVersion: 1, signIn: { email: true, google: true } } });
  });

  it("does not read a 404 from any other server as anything", async () => {
    const r = await probeServerInfo("https://docs.example.com", { fetchImpl: answer(404, "Not found") });
    expect(r.ok).toBe(false);
  });

  it("fails cleanly when the server cannot be reached or answers junk", async () => {
    const down = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect((await probeServerInfo("https://docs.example.com", { fetchImpl: down })).ok).toBe(false);
    expect((await probeServerInfo("https://docs.example.com", { fetchImpl: answer(200, "<html>") })).ok).toBe(false);
    expect((await probeServerInfo("https://docs.example.com", { fetchImpl: answer(200, "x".repeat(70000)) })).ok).toBe(false);
  });

  it("stops reading a server-info body that never ends, and aborts the request", async () => {
    const { stream, seen } = endless();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const r = await probeServerInfo("https://docs.example.com", { fetchImpl });

    expect(r).toEqual({ ok: false, error: "That address isn't a Markie server." });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(64 * 1024 + 2 * 16 * 1024);
    expect(signal?.aborted).toBe(true);
  });
});

describe("the trusted server list", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-servers-"));
    file = path.join(dir, "servers.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("always starts with Markie Cloud, which cannot be removed", () => {
    const store = createServerStore({ file });
    expect(store.origins()).toEqual([DEFAULT_SERVER]);
    expect(store.list()[0]).toMatchObject({ origin: DEFAULT_SERVER, isDefault: true, name: "Markie Cloud" });
    expect(store.remove(DEFAULT_SERVER).ok).toBe(false);
    expect(store.isTrusted(DEFAULT_SERVER)).toBe(true);
  });

  it("adds a server only from a check it made itself, and persists it", async () => {
    const store = createServerStore({ file, fetchImpl: answer(200, INFO) });
    expect(store.isTrusted("https://docs.example.com")).toBe(false);
    const checked = await store.probe("https://docs.example.com");
    expect(checked).toMatchObject({ ok: true, origin: "https://docs.example.com", name: "Team docs" });
    // Checking is not adding.
    expect(store.isTrusted("https://docs.example.com")).toBe(false);

    const added = store.add((checked as { probeId: string }).probeId);
    expect(added).toMatchObject({ ok: true, server: { origin: "https://docs.example.com", name: "Team docs" } });
    expect(store.isTrusted("https://docs.example.com")).toBe(true);

    const reopened = createServerStore({ file });
    expect(reopened.origins()).toEqual([DEFAULT_SERVER, "https://docs.example.com"]);
  });

  it("refuses an add with no matching check, a used one, or a stale one", async () => {
    let clock = 1_000_000;
    const store = createServerStore({ file, fetchImpl: answer(200, INFO), now: () => clock });
    expect(store.add("made-up").ok).toBe(false);
    expect(store.add(undefined as unknown as string).ok).toBe(false);

    const first = (await store.probe("https://docs.example.com")) as { probeId: string };
    expect(store.add(first.probeId).ok).toBe(true);
    expect(store.add(first.probeId).ok).toBe(false);

    store.remove("https://docs.example.com");
    const second = (await store.probe("https://docs.example.com")) as { probeId: string };
    clock += PROBE_TTL_MS + 1;
    expect(store.add(second.probeId).ok).toBe(false);
    expect(store.isTrusted("https://docs.example.com")).toBe(false);
  });

  it("does not probe an address that fails validation", async () => {
    const fetchImpl = answer(200, INFO);
    const store = createServerStore({ file, fetchImpl });
    expect((await store.probe("http://docs.example.com")).ok).toBe(false);
    expect((await store.probe("https://a:b@docs.example.com")).ok).toBe(false);
    expect((await store.probe("https://localhost:8787")).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("removes an added server", async () => {
    const store = createServerStore({ file, fetchImpl: answer(200, INFO) });
    const p = (await store.probe("docs.example.com")) as { probeId: string };
    store.add(p.probeId);
    expect(store.remove("https://docs.example.com")).toMatchObject({ ok: true, removed: true });
    expect(store.isTrusted("https://docs.example.com")).toBe(false);
    expect(createServerStore({ file }).origins()).toEqual([DEFAULT_SERVER]);
  });

  it("ignores stored entries that would not pass the typed-address check", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        servers: [
          { origin: "http://plain.example.com", name: "x" },
          { origin: "https://docs.example.com/path", name: "x" },
          { origin: "https://u:p@docs.example.com", name: "x" },
          { origin: "http://localhost:8787", name: "dev" },
          { origin: DEFAULT_SERVER, name: "Fake cloud" },
          { origin: "https://ok.example.com", name: "Fine" },
          { origin: "https://ok.example.com", name: "Duplicate" },
        ],
      })
    );
    expect(createServerStore({ file }).origins()).toEqual([DEFAULT_SERVER, "https://ok.example.com"]);
    // Localhost survives only in a dev build.
    expect(createServerStore({ file, allowDev: true }).origins()).toEqual([
      DEFAULT_SERVER,
      "http://localhost:8787",
      "https://ok.example.com",
    ]);
  });

  it("renames a stored server that passes for Markie Cloud, so a hand-edited file cannot either", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, servers: [{ origin: "https://evil.example.com", name: "Markie Cloud" }] })
    );
    expect(createServerStore({ file }).get("https://evil.example.com")).toMatchObject({ name: "evil.example.com" });
  });

  it("survives a missing or corrupt file", () => {
    fs.writeFileSync(file, "{not json");
    expect(createServerStore({ file }).origins()).toEqual([DEFAULT_SERVER]);
  });
});
