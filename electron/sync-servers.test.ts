import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Several servers at once: every request goes to the server the document
// lives on, with that server's token, and to nowhere else. Loaded through
// require() so the registry stand-in and the trusted list are the instances
// sync.js holds (see sync.test.ts).
const load = createRequire(import.meta.url);
const registry = load("./registry.js");
const sync = load("./sync.js");
const { setTrustedOrigins } = load("./share-origin.js");

const CLOUD = "https://api.markiedocs.com";
const SELF = "https://docs.example.com";

interface Row {
  path: string;
  name: string;
  sync_state: string;
  cloud_doc_id: string | null;
  cloud_origin?: string | null;
  cloud_version: number;
  content_hash: string | null;
  last_opened_at: string | null;
  share_role?: string | null;
  share_role_user?: string | null;
}

interface Call {
  method: string;
  url: string;
  auth: string | null;
}

const realRegistry = { ...registry };
let rows: Map<string, Row>;
let tmpDir: string;
let realHome: string | undefined;
let calls: Call[];
// origin -> handler for that server
let servers: Record<string, (method: string, p: string) => { status: number; body?: unknown }>;

function seedRow(overrides: Partial<Row> & { path: string }): Row {
  const row: Row = {
    name: path.basename(overrides.path),
    sync_state: "local-only",
    cloud_doc_id: null,
    cloud_version: 0,
    content_hash: null,
    last_opened_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
  rows.set(row.path, row);
  return row;
}

function signInAt(origin: string, token: string, userId: string) {
  if (origin === CLOUD) {
    sync.setConfig({ token, serverURL: CLOUD });
    sync.setConfig({ token, serverURL: CLOUD, userId });
  } else {
    sync.setSession({ origin, token });
    sync.setSession({ origin, token, userId });
  }
}

beforeEach(() => {
  rows = new Map();
  calls = [];
  servers = {};
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-sync-servers-"));
  realHome = process.env.HOME;
  process.env.HOME = tmpDir;
  registry.listRoots = () => [];
  registry.addRoot = () => {};
  registry.get = (p: string) => rows.get(p);
  registry.update = (p: string, fields: Partial<Row>) => {
    const row = rows.get(p);
    if (row) Object.assign(row, fields);
  };
  registry.hashContent = (content: string) => `hash:${content}`;
  registry.list = () => [...rows.values()];
  registry.pruneMissing = () => 0;
  registry.track = (p: string, name: string) => {
    if (!rows.has(p)) seedRow({ path: p, name });
  };
  registry.forget = (p: string) => rows.delete(p);
  setTrustedOrigins(() => [CLOUD, SELF]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
      const u = new URL(url);
      calls.push({ method: init?.method ?? "GET", url, auth: init?.headers?.Authorization ?? null });
      const handler = servers[u.origin];
      if (!handler) throw new Error(`unexpected request to ${u.origin}`);
      const reply = handler(init?.method ?? "GET", u.pathname);
      return { status: reply.status, json: async () => reply.body ?? null, headers: new Headers(), body: null };
    })
  );
  signInAt(CLOUD, "cloud-token", "cloud-user");
  signInAt(SELF, "self-token", "self-user");
});

afterEach(() => {
  sync.setConfig({ token: null, serverURL: null });
  sync.forgetOrigin(SELF);
  setTrustedOrigins(null);
  Object.assign(registry, realRegistry);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("sessions per server", () => {
  it("keeps one session per server, independently", () => {
    expect(sync.configuredOrigins()).toEqual([CLOUD, SELF]);
    expect(sync.hasPrincipal(CLOUD)).toBe(true);
    expect(sync.hasPrincipal(SELF)).toBe(true);

    sync.setSession({ origin: SELF, token: null });
    expect(sync.configuredOrigins()).toEqual([CLOUD]);
    expect(sync.hasPrincipal(CLOUD)).toBe(true);
  });

  it("refuses a session for a server that is not trusted", () => {
    const res = sync.setSession({ origin: "https://evil.example.com", token: "stolen" });
    expect(res.error).toBeTruthy();
    expect(sync.isConfigured("https://evil.example.com")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not trust an account named in the same push as a new token", () => {
    sync.setSession({ origin: SELF, token: "other-token", userId: "self-user" });
    expect(sync.hasPrincipal(SELF)).toBe(false);
  });

  it("names the set of sessions without containing any token", () => {
    const { sessionKey } = sync.setSession({ origin: SELF, token: "self-token" });
    expect(sessionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionKey).not.toContain("self-token");
    const after = sync.setSession({ origin: SELF, token: null }).sessionKey;
    expect(after).not.toBe(sessionKey);
  });
});

describe("routing each document to its own server", () => {
  it("pushes a document to the server it lives on, with that server's token only", async () => {
    seedRow({ path: "/d/cloud.md", sync_state: "synced", cloud_doc_id: "c1", cloud_version: 1, content_hash: "hash:x" });
    seedRow({
      path: "/d/self.md",
      sync_state: "synced",
      cloud_doc_id: "s1",
      cloud_origin: SELF,
      cloud_version: 1,
      content_hash: "hash:x",
    });
    servers[CLOUD] = () => ({ status: 200, body: { version: 2 } });
    servers[SELF] = () => ({ status: 200, body: { version: 2 } });

    await sync.push("/d/cloud.md", "cloud.md", "new");
    await sync.push("/d/self.md", "self.md", "new");

    expect(calls).toEqual([
      { method: "PUT", url: `${CLOUD}/api/docs/c1`, auth: "Bearer cloud-token" },
      { method: "PUT", url: `${SELF}/api/docs/s1`, auth: "Bearer self-token" },
    ]);
  });

  it("does not push a document on a server the user is signed out of", async () => {
    seedRow({ path: "/d/self.md", sync_state: "synced", cloud_doc_id: "s1", cloud_origin: SELF, cloud_version: 1 });
    sync.setSession({ origin: SELF, token: null });
    expect(await sync.push("/d/self.md", "self.md", "new")).toEqual({ skipped: "not signed in" });
    expect(calls).toHaveLength(0);
  });

  it("sends nothing to a server the moment it stops being trusted", async () => {
    seedRow({ path: "/d/self.md", sync_state: "synced", cloud_doc_id: "s1", cloud_origin: SELF, cloud_version: 1 });
    setTrustedOrigins(() => [CLOUD]);
    expect(await sync.push("/d/self.md", "self.md", "new")).toEqual({ skipped: "not signed in" });
    expect(await sync.api("GET", "/api/docs", undefined, { origin: SELF })).toEqual({ status: 0, data: null });
    expect(calls).toHaveLength(0);
  });

  it("starts a new document on the server asked for, and records where it went", async () => {
    seedRow({ path: "/d/new.md" });
    servers[SELF] = () => ({ status: 200, body: { version: 1 } });

    const res = await sync.syncOn("/d/new.md", "new.md", "hello", undefined, SELF);

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith(`${SELF}/api/docs/`)).toBe(true);
    expect(calls[0].auth).toBe("Bearer self-token");
    expect(rows.get("/d/new.md")!.cloud_origin).toBe(SELF);
  });

  it("starts a new document on the primary server by default, without marking the row", async () => {
    seedRow({ path: "/d/new.md" });
    servers[CLOUD] = () => ({ status: 200, body: { version: 1 } });

    await sync.syncOn("/d/new.md", "new.md", "hello");

    expect(calls[0].url.startsWith(`${CLOUD}/api/docs/`)).toBe(true);
    expect(rows.get("/d/new.md")!.cloud_origin).toBeUndefined();
  });

  it("never uploads a new document to another signed-in server when Markie Cloud is signed out", async () => {
    seedRow({ path: "/d/new.md" });
    sync.setConfig({ token: null, serverURL: CLOUD });
    servers[SELF] = () => ({ status: 200, body: { version: 1 } });

    const res = await sync.syncOn("/d/new.md", "new.md", "hello");

    expect(res).toEqual({ error: "Sign in to Markie Cloud to sync this file." });
    expect(calls).toHaveLength(0);
    expect(rows.get("/d/new.md")!.cloud_origin).toBeUndefined();
  });

  it("refuses a server that was named but is signed out, rather than using another", async () => {
    seedRow({ path: "/d/new.md" });
    sync.setSession({ origin: SELF, token: null });
    servers[CLOUD] = () => ({ status: 200, body: { version: 1 } });

    const res = await sync.syncOn("/d/new.md", "new.md", "hello", undefined, SELF);

    expect(res).toEqual({ error: "Sign in to docs.example.com to sync this file." });
    expect(calls).toHaveLength(0);
  });

  it("says Markie Cloud is signed out in the Library when only another server has a session", async () => {
    sync.setConfig({ token: null, serverURL: CLOUD });
    servers[SELF] = () => ({ status: 200, body: { docs: [] } });

    const state = await sync.libraryState();

    expect(state.signedIn).toBe(false);
    expect(state.servers).toEqual([SELF]);
  });

  it("pulls from the server it is told, and remembers that server on the row", async () => {
    servers[SELF] = () => ({ status: 200, body: { doc: { content: "# hi\n", name: "hi.md", version: 3 } } });
    const target = path.join(tmpDir, "hi.md");

    const res = await sync.pull("s9", target, SELF);

    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ method: "GET", url: `${SELF}/api/docs/s9`, auth: "Bearer self-token" }]);
    expect(rows.get(fs.realpathSync(target))!.cloud_origin).toBe(SELF);
  });
});

describe("Markie Cloud's old address", () => {
  const RAILWAY = "https://api-production-602f.up.railway.app";

  it("pushes a row still recorded under the old address to Markie Cloud, with Cloud's token", async () => {
    seedRow({ path: "/d/old.md", sync_state: "synced", cloud_doc_id: "c1", cloud_origin: RAILWAY, cloud_version: 1, content_hash: "hash:x" });
    servers[CLOUD] = () => ({ status: 200, body: { version: 2 } });

    await sync.push("/d/old.md", "old.md", "new");

    expect(calls).toEqual([{ method: "PUT", url: `${CLOUD}/api/docs/c1`, auth: "Bearer cloud-token" }]);
  });

  it("reads a sign-in pushed under the old address as Markie Cloud's", () => {
    sync.setConfig({ token: "cloud-token", serverURL: RAILWAY });
    expect(sync.primary()).toBe(CLOUD);
    expect(sync.isConfigured(CLOUD)).toBe(true);
    // The same token at the same server is the same session.
    expect(sync.hasPrincipal(CLOUD)).toBe(true);
    expect(sync.sessionToken(RAILWAY)).toBe("cloud-token");
  });

  it("files a pull from the old address as Markie Cloud's, unmarked", async () => {
    servers[CLOUD] = () => ({ status: 200, body: { doc: { content: "# hi\n", name: "hi.md", version: 3 } } });
    const target = path.join(tmpDir, "hi.md");

    const res = await sync.pull("c9", target, RAILWAY);

    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ method: "GET", url: `${CLOUD}/api/docs/c9`, auth: "Bearer cloud-token" }]);
    expect(rows.get(fs.realpathSync(target))!.cloud_origin ?? null).toBeNull();
  });

  it("clears the old address off a row it writes again", async () => {
    const target = path.join(tmpDir, "old.md");
    fs.writeFileSync(target, "# old\n");
    const real = fs.realpathSync(target);
    seedRow({ path: real, sync_state: "synced", cloud_doc_id: "c1", cloud_origin: RAILWAY, cloud_version: 1 });
    servers[CLOUD] = () => ({ status: 200, body: { doc: { content: "# hi\n", name: "old.md", version: 3 } } });

    expect((await sync.pull("c1", target, RAILWAY)).ok).toBe(true);

    expect(rows.get(real)!.cloud_origin).toBeNull();
  });
});

describe("an upload bound to its server's session", () => {
  it("stops when that server's session changes mid-upload", async () => {
    seedRow({ path: "/d/self.md", sync_state: "synced", cloud_doc_id: "s1", cloud_origin: SELF, cloud_version: 1 });
    servers[SELF] = () => {
      // Another account signs in to the same server while the PUT is out.
      sync.setSession({ origin: SELF, token: "someone-else" });
      return { status: 200, body: { version: 2 } };
    };
    const res = await sync.push("/d/self.md", "self.md", "new");
    expect(res.error).toMatch(/changed during the upload/);
    expect(rows.get("/d/self.md")!.cloud_version).toBe(1);
  });

  it("is not disturbed by a session change on another server", async () => {
    seedRow({ path: "/d/self.md", sync_state: "synced", cloud_doc_id: "s1", cloud_origin: SELF, cloud_version: 1 });
    servers[SELF] = () => {
      sync.setConfig({ token: "cloud-token-2", serverURL: CLOUD });
      return { status: 200, body: { version: 2 } };
    };
    const res = await sync.push("/d/self.md", "self.md", "new");
    expect(res.ok).toBe(true);
    expect(rows.get("/d/self.md")!.cloud_version).toBe(2);
  });
});

describe("the Library across servers", () => {
  it("lists every signed-in server, marking documents that are not on the primary", async () => {
    seedRow({ path: "/d/cloud.md", sync_state: "synced", cloud_doc_id: "c1", cloud_version: 1 });
    seedRow({ path: "/d/self.md", sync_state: "synced", cloud_doc_id: "s1", cloud_origin: SELF, cloud_version: 1 });
    servers[CLOUD] = () => ({
      status: 200,
      body: { docs: [{ id: "c1", version: 1 }, { id: "c2", name: "Cloud only", version: 1 }] },
    });
    servers[SELF] = () => ({
      status: 200,
      body: { docs: [{ id: "s1", version: 1 }, { id: "s2", name: "Self only", version: 1, shared: true, role: "editor" }] },
    });

    const state = await sync.libraryState();
    const byId = Object.fromEntries(state.items.map((i: { cloudId: string }) => [i.cloudId, i]));

    expect(state.signedIn).toBe(true);
    expect(state.servers).toEqual([SELF]);
    expect(state.cloudError).toBeNull();
    expect(byId.c1.server).toBeUndefined();
    expect(byId.c2).toMatchObject({ kind: "cloud-only", state: "cloud-only" });
    expect(byId.c2.server).toBeUndefined();
    expect(byId.s1).toMatchObject({ kind: "local", server: SELF, state: "synced", owned: true });
    expect(byId.s2).toMatchObject({ kind: "shared", server: SELF, role: "editor" });
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      [`${CLOUD}/api/docs`, "Bearer cloud-token"],
      [`${SELF}/api/docs`, "Bearer self-token"],
    ]);
  });

  it("keeps the same cloud id on two servers as two documents", async () => {
    seedRow({ path: "/d/cloud.md", sync_state: "synced", cloud_doc_id: "same", cloud_version: 1 });
    servers[CLOUD] = () => ({ status: 200, body: { docs: [{ id: "same", version: 1 }] } });
    // The other server names the same id. It says nothing about the first
    // server's document: that one stays synced, and this one is its own item.
    servers[SELF] = () => ({ status: 200, body: { docs: [{ id: "same", name: "Other", version: 7 }] } });

    const state = await sync.libraryState();
    const same = state.items.filter((i: { cloudId: string }) => i.cloudId === "same");

    expect(same).toHaveLength(2);
    expect(same[0]).toMatchObject({ kind: "local", state: "synced" });
    expect(same[1]).toMatchObject({ kind: "cloud-only", server: SELF, remoteVersion: 7 });
  });

  it("reads a failed list on one server as that server's problem only", async () => {
    seedRow({ path: "/d/cloud.md", sync_state: "synced", cloud_doc_id: "c1", cloud_version: 1 });
    seedRow({ path: "/d/self.md", sync_state: "synced", cloud_doc_id: "s1", cloud_origin: SELF, cloud_version: 1 });
    servers[CLOUD] = () => ({ status: 200, body: { docs: [] } });
    servers[SELF] = () => ({ status: 503 });

    const state = await sync.libraryState();
    const byId = Object.fromEntries(state.items.map((i: { cloudId: string }) => [i.cloudId, i]));

    // The primary's empty list does mean c1 was deleted there...
    expect(byId.c1.state).toBe("paused");
    // ...but the other server's outage says nothing about s1.
    expect(byId.s1.state).toBe("synced");
    expect(state.cloudError).toContain("docs.example.com");
  });

  it("reads remembered roles only for the account on the row's own server", async () => {
    // Both rows remember an owner role for "self-user". Only one of them
    // lives on the server where that account is signed in.
    seedRow({
      path: "/d/self.md",
      sync_state: "synced",
      cloud_doc_id: "s1",
      cloud_origin: SELF,
      cloud_version: 1,
      share_role: "owner",
      share_role_user: "self-user",
    });
    seedRow({
      path: "/d/cloud.md",
      sync_state: "synced",
      cloud_doc_id: "c1",
      cloud_version: 1,
      share_role: "owner",
      share_role_user: "self-user",
    });
    servers[CLOUD] = () => ({ status: 503 });
    servers[SELF] = () => ({ status: 503 });

    const state = await sync.libraryState();
    const byId = Object.fromEntries(state.items.map((i: { cloudId: string; owned: boolean | null }) => [i.cloudId, i.owned]));
    expect(byId).toEqual({ s1: true, c1: null });
  });
});

describe("checking for updates across servers", () => {
  it("lands a document from another machine under the server it came from", async () => {
    servers[CLOUD] = () => ({ status: 200, body: { docs: [] } });
    servers[SELF] = (_m, p) =>
      p === "/api/docs"
        ? { status: 200, body: { docs: [{ id: "s5", name: "Plan", version: 1 }] } }
        : { status: 200, body: { doc: { content: "plan", name: "Plan", version: 1 } } };

    const res = await sync.checkUpdates();

    expect(res.landed).toHaveLength(1);
    expect(res.landed[0]).toMatchObject({ cloudId: "s5", server: SELF });
    const row = [...rows.values()].find((r) => r.cloud_doc_id === "s5")!;
    expect(row.cloud_origin).toBe(SELF);
    expect(calls.filter((c) => c.url.startsWith(SELF)).every((c) => c.auth === "Bearer self-token")).toBe(true);
    expect(calls.filter((c) => c.url.startsWith(CLOUD)).every((c) => c.auth === "Bearer cloud-token")).toBe(true);
  });

  it("reports an update with the server it is on", async () => {
    seedRow({ path: "/d/self.md", sync_state: "synced", cloud_doc_id: "s1", cloud_origin: SELF, cloud_version: 1 });
    servers[CLOUD] = () => ({ status: 200, body: { docs: [] } });
    servers[SELF] = () => ({ status: 200, body: { docs: [{ id: "s1", version: 4 }] } });

    const res = await sync.checkUpdates();

    expect(res.updates).toEqual([
      expect.objectContaining({ path: "/d/self.md", cloudId: "s1", remoteVersion: 4, server: SELF }),
    ]);
  });
});

describe("removing a server", () => {
  it("drops its session and everything it said", () => {
    sync.noteListing([{ id: "s1", sharedOut: false }], SELF);
    // One server's listing says nothing about the same id on another.
    expect(sync.isExposed("s1", CLOUD)).toBeNull();
    expect(sync.isExposed("s1", SELF)).toBe(false);

    sync.forgetOrigin(SELF);

    expect(sync.isConfigured(SELF)).toBe(false);
    expect(sync.isExposed("s1", SELF)).toBeNull();
    expect(sync.isConfigured(CLOUD)).toBe(true);
  });
});
