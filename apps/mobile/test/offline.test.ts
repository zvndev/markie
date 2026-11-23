// What the phone keeps, without a device: the store and its wipe, the cap,
// the queue and its "never overwrite a newer copy" rule, and the three
// conflict choices. The API client is the real one, over a small server that
// versions documents the way server/src/docs.ts does.
import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "../src/lib/api";
import { NetworkError, type HttpTransport } from "../src/lib/http";
import { createOfflineApi, keepBothName, offlineInfo, offlineOf, TAKE_CLOUD_REFUSAL } from "../src/lib/offline-api";
import {
  createOfflineStore, docKey, memoryBackend, OFFLINE_LIMITS,
  type OfflineBackend, type OfflineOwner,
} from "../src/lib/offline-store";
import type { CloudDoc } from "../src/lib/docs";

const ORIGIN = "https://api.markiedocs.com";
const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaaaaaa";
const ME: OfflineOwner = { origin: ORIGIN, userId: "u1", email: "me@example.com" };
const OTHER: OfflineOwner = { origin: ORIGIN, userId: "u2", email: "other@example.com" };

interface ServerDoc { name: string; content: string; version: number; role?: string }

/** A server that keeps versions, can go away, and can answer a status of its own. */
function server(seed: Record<string, ServerDoc> = {}) {
  const docs = new Map<string, ServerDoc>(Object.entries(seed));
  const assets = new Map<string, Uint8Array>();
  const state = { online: true, status: null as number | null, gone: new Set<string>(), puts: [] as { id: string; baseVersion: number; content: string }[], dropNextPutAnswer: false };
  const json = (status: number, body: unknown) => ({ status, headers: {}, text: JSON.stringify(body) });
  const transport: HttpTransport = async (req) => {
    if (!state.online) throw new NetworkError();
    if (state.status) return json(state.status, { error: "nope" });
    const url = new URL(req.url);
    const one = /^\/api\/docs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (url.pathname === "/api/docs/recent") {
      return json(200, { docs: [...docs.entries()].map(([id, doc]) => ({ id, name: doc.name, updatedAt: "2026-11-20T10:00:00.000Z", role: doc.role ?? "owner" })) });
    }
    if (url.pathname === "/api/document-platform/documents") return json(200, { documents: [] });
    if (one && req.method === "GET") {
      const doc = docs.get(one[1]);
      if (state.gone.has(one[1])) return json(403, { error: "forbidden" });
      if (!doc) return json(404, { error: "not found" });
      return json(200, { doc: { id: one[1], ...doc, role: doc.role ?? "owner" } });
    }
    if (one && req.method === "PUT") {
      const body = req.body as { name: string; content: string; baseVersion: number };
      state.puts.push({ id: one[1], baseVersion: body.baseVersion, content: body.content });
      if (state.gone.has(one[1])) return json(403, { error: "forbidden" });
      const existing = docs.get(one[1]);
      if ((existing?.version ?? 0) !== body.baseVersion) return json(409, { error: "conflict", serverVersion: existing?.version ?? 0 });
      const version = (existing?.version ?? 0) + 1;
      docs.set(one[1], { name: body.name, content: body.content, version, role: existing?.role });
      if (state.dropNextPutAnswer) { state.dropNextPutAnswer = false; throw new NetworkError(); }
      return json(200, { id: one[1], version });
    }
    const links = /^\/api\/docs\/([A-Za-z0-9_-]+)\/links$/.exec(url.pathname);
    if (links) return json(200, { links: [{ ref: "notes.md", target: "d2" }] });
    const asset = /^\/api\/docs\/([A-Za-z0-9_-]+)\/assets\/file$/.exec(url.pathname);
    if (asset) {
      const bytes = assets.get(`${asset[1]}/${url.searchParams.get("ref")}`);
      if (!bytes) return json(404, { error: "not found" });
      return { status: 200, headers: { "content-type": "image/png" }, text: "", bytes };
    }
    return json(404, { error: "not found" });
  };
  /** The desktop, or anyone else: a save that moves the cloud copy on. */
  const elsewhere = (id: string, content: string) => {
    const doc = docs.get(id)!;
    docs.set(id, { ...doc, content, version: doc.version + 1 });
  };
  return { transport, docs, assets, state, elsewhere };
}

async function phone(srv: ReturnType<typeof server>, backend: OfflineBackend = memoryBackend(), owner: OfflineOwner = ME) {
  let clock = 1_000;
  const store = createOfflineStore(backend, { now: () => (clock += 1) });
  const session = (await store.start(owner))!;
  const raw = createApiClient({ origin: ORIGIN, transport: srv.transport, getToken: () => TOKEN });
  const api = createOfflineApi(raw, session, { now: () => (clock += 1) });
  return { api, store, session, backend, offline: api.offline };
}

const doc = (id: string, content: string, version = 1, name = `${id}.md`): CloudDoc => ({
  id, name, format: "markdown", version, content, updatedAt: null,
  origin: { kind: "app", agent: null }, privateLink: `${ORIGIN}/d/${id}`, role: "owner",
});

describe("reading with no network", () => {
  it("reopens an opened document from the phone, and says it did", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "# Plan\n", version: 3 } });
    const { api } = await phone(srv);
    const first = await api.doc("d1");
    expect(offlineInfo(first)).toBeNull();
    srv.state.online = false;
    const again = await api.doc("d1");
    expect(again.content).toBe("# Plan\n");
    expect(again.version).toBe(3);
    expect(offlineInfo(again)).toMatchObject({ fromPhone: true, pending: null });
    expect(api.offline.snapshot().offline).toBe(true);
  });

  it("still says offline for a document that was never opened", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api } = await phone(srv);
    srv.state.online = false;
    await expect(api.doc("d1")).rejects.toMatchObject({ status: 0 });
  });

  it("serves the kept copy when the server is there but can't answer", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api } = await phone(srv);
    await api.doc("d1");
    srv.state.status = 503;
    expect(offlineInfo(await api.doc("d1"))?.fromPhone).toBe(true);
  });

  it("shows the last list, with the documents that open marked", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 }, d2: { name: "Notes.txt", content: "y", version: 1 } });
    const { api } = await phone(srv);
    expect((await api.recent()).map((item) => item.id).sort()).toEqual(["d1", "d2"]);
    await api.platformRecent();
    await api.doc("d1");
    srv.state.online = false;
    expect((await api.recent()).map((item) => item.id).sort()).toEqual(["d1", "d2"]);
    expect(await api.platformRecent()).toEqual([]);
    const snapshot = api.offline.snapshot();
    expect(snapshot.listSavedAt).not.toBeNull();
    expect(snapshot.marks.get("d1")).toBe("kept");
    expect(snapshot.marks.has("d2")).toBe(false);
    srv.state.online = true;
    await api.recent();
    expect(api.offline.snapshot()).toMatchObject({ offline: false, listSavedAt: null });
  });

  it("keeps a document's pictures and links", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "![](a.png)", version: 1 } });
    srv.assets.set("d1/a.png", new Uint8Array([1, 2, 3, 4]));
    const { api } = await phone(srv);
    await api.doc("d1");
    expect((await api.asset({ kind: "doc", id: "d1" }, "a.png"))?.size).toBe(4);
    expect((await api.docLinks("d1")).get("notes.md")).toBe("d2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    srv.state.online = false;
    await api.doc("d1");
    const kept = await api.asset({ kind: "doc", id: "d1" }, "a.png");
    expect(kept?.type).toBe("image/png");
    expect(new Uint8Array(await kept!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await api.docLinks("d1")).get("notes.md")).toBe("d2");
  });

  it("removes a document the account can no longer read", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "secret", version: 1 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    expect(session.entry(docKey("d1"))).not.toBeNull();
    srv.state.gone.add("d1");
    await expect(api.doc("d1")).rejects.toMatchObject({ status: 403 });
    expect(session.entry(docKey("d1"))).toBeNull();
    srv.state.online = false;
    await expect(api.doc("d1")).rejects.toMatchObject({ status: 0 });
  });

  it("removes a deleted document too", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    srv.docs.delete("d1");
    await expect(api.doc("d1")).rejects.toMatchObject({ status: 404 });
    expect(session.entries()).toEqual([]);
  });
});

describe("the wipe", () => {
  it("signing out leaves nothing: documents, pictures, the list and queued edits", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "![](a.png)", version: 1 }, d2: { name: "B.md", content: "b", version: 1 } });
    srv.assets.set("d1/a.png", new Uint8Array(8));
    const { api, store, backend } = await phone(srv);
    await api.recent();
    await api.doc("d1");
    await api.doc("d2");
    await api.asset({ kind: "doc", id: "d1" }, "a.png");
    await new Promise((resolve) => setTimeout(resolve, 10));
    srv.state.online = false;
    await api.offline.save({ id: "d2", name: "B.md", content: "b, edited", baseVersion: 1 });
    expect((backend as ReturnType<typeof memoryBackend>).size()).toBeGreaterThan(4);
    await store.wipe();
    expect((backend as ReturnType<typeof memoryBackend>).size()).toBe(0);
    expect(store.session()).toBeNull();
  });

  it("an answer that arrives after the wipe is not written", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api, store, session, backend } = await phone(srv);
    const wiping = store.wipe();
    expect(session.alive()).toBe(false);
    await api.doc("d1");
    await session.putDoc(docKey("d9"), doc("d9", "late"));
    await session.putList({ docs: [] });
    await wiping;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((backend as ReturnType<typeof memoryBackend>).size()).toBe(0);
  });

  it("a different account signing in finds nothing of the last one's", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api, store, backend } = await phone(srv);
    await api.doc("d1");
    const next = await store.start(OTHER);
    expect(next!.entries()).toEqual([]);
    expect(await next!.getDoc(docKey("d1"))).toBeNull();
    expect(await backend.readAll("docs")).toEqual([]);
  });

  it("a launch with no session wipes what is there", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api, backend } = await phone(srv);
    await api.doc("d1");
    const relaunched = createOfflineStore(backend);
    expect(await relaunched.start(null)).toBeNull();
    expect((backend as ReturnType<typeof memoryBackend>).size()).toBe(0);
  });

  it("the same account comes back to its documents after a relaunch", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api, backend } = await phone(srv);
    await api.doc("d1");
    const relaunched = await createOfflineStore(backend).start(ME);
    expect(relaunched!.entry(docKey("d1"))?.name).toBe("Plan.md");
  });

  it("a session the server ended keeps only the unsent edits, for the same account", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 }, d2: { name: "B.md", content: "b", version: 1 } });
    const { api, store, backend } = await phone(srv);
    await api.recent();
    await api.doc("d1");
    await api.doc("d2");
    srv.state.online = false;
    await api.offline.save({ id: "d2", name: "B.md", content: "mine", baseVersion: 1 });
    expect(await store.hold()).toBe(1);
    expect((await backend.readAll("docs")).length).toBe(1);
    expect(await backend.read("meta", "list")).toBeUndefined();
    // A launch while still signed out leaves the held edit alone.
    const relaunched = createOfflineStore(backend);
    expect(await relaunched.start(null)).toBeNull();
    const back = await relaunched.start(ME);
    expect((await back!.getDoc(docKey("d2")))?.pending?.content).toBe("mine");
    expect(back!.entry(docKey("d1"))).toBeNull();
    // Anyone else gets nothing.
    const other = await createOfflineStore(backend).start(OTHER);
    expect(other!.entries()).toEqual([]);
  });

  it("a different account after a server-ended session never sees or sends the held edits", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 }, d2: { name: "B.md", content: "b", version: 1 } });
    const first = await phone(srv);
    await first.api.recent();
    await first.api.doc("d2");
    srv.state.online = false;
    await first.offline.save({ id: "d2", name: "B.md", content: "the first account's secret edit", baseVersion: 1 });
    const made = await first.offline.create({ name: "Private idea.md", content: "also theirs" });
    expect(await first.store.hold()).toBe(2);
    // The app is relaunched signed out, then someone else signs in.
    expect(await createOfflineStore(first.backend).start(null)).toBeNull();
    srv.state.online = true;
    const second = await phone(srv, first.backend, OTHER);
    const everything = JSON.stringify(await Promise.all((["meta", "index", "docs", "assets"] as const).map((name) => first.backend.readAll(name))));
    expect(everything).not.toContain("secret edit");
    expect(everything).not.toContain("also theirs");
    expect(everything).not.toContain(ME.email);
    expect(second.session.unsent()).toBe(0);
    expect(second.offline.snapshot().marks.size).toBe(0);
    expect(second.offline.pending("d2")).toBeNull();
    expect(await second.offline.mine("d2")).toBeNull();
    // Nothing waits to be sent, and nothing is: not by a drain, a list or an open.
    expect(await second.offline.drain()).toEqual({ sent: 0, conflicts: 0, refused: 0, waiting: 0 });
    expect((await second.api.recent()).map((item) => item.name)).not.toContain("Private idea.md");
    expect((await second.api.doc("d2")).content).toBe("b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(srv.state.puts).toEqual([]);
    expect(srv.docs.get("d2")).toMatchObject({ content: "b", version: 1 });
    expect(srv.docs.has(made.id)).toBe(false);
    // And the first account, coming back after that, finds them gone too.
    const back = await createOfflineStore(first.backend).start(ME);
    expect(back!.entries()).toEqual([]);
  });

  it("holding with nothing unsent is a full wipe", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api, store, backend } = await phone(srv);
    await api.doc("d1");
    expect(await store.hold()).toBe(0);
    expect((backend as ReturnType<typeof memoryBackend>).size()).toBe(0);
  });
});

describe("the cap", () => {
  const limits = { ...OFFLINE_LIMITS, maxDocs: 3, maxBytes: 1000, maxDocBytes: 400, maxAssetBytes: 100, maxAssetBytesPerDoc: 150 };
  async function small() {
    let clock = 0;
    const backend = memoryBackend();
    const session = (await createOfflineStore(backend, { limits, now: () => (clock += 1) }).start(ME))!;
    return { session, backend };
  }

  it("drops the least recently opened document first", async () => {
    const { session, backend } = await small();
    for (const id of ["a", "b", "c"]) await session.putDoc(docKey(id), doc(id, id), { opened: true });
    await session.putDoc(docKey("a"), doc("a", "a"), { opened: true });
    await session.putDoc(docKey("d"), doc("d", "d"), { opened: true });
    expect(session.entries().map((entry) => entry.key).sort()).toEqual(["d:a", "d:c", "d:d"]);
    expect(await backend.read("docs", "d:b")).toBeUndefined();
  });

  it("never drops a document with an unsent edit", async () => {
    const { session } = await small();
    await session.putDoc(docKey("a"), doc("a", "a"), { opened: true });
    await session.setPending(docKey("a"), { content: "mine", name: "a.md", baseVersion: 1, queuedAt: 1, state: "unpushed" });
    for (const id of ["b", "c", "d", "e"]) await session.putDoc(docKey(id), doc(id, id), { opened: true });
    const keys = session.entries().map((entry) => entry.key).sort();
    expect(keys).toContain("d:a");
    expect(keys.length).toBe(3);
    expect((await session.getDoc(docKey("a")))?.pending?.content).toBe("mine");
    expect(await session.removeDoc(docKey("a"))).toBe(false);
  });

  it("holds the byte cap, pictures included", async () => {
    const { session, backend } = await small();
    await session.putDoc(docKey("a"), doc("a", "x".repeat(300)), { opened: true });
    expect(await session.putAsset(docKey("a"), "p.png", { type: "image/png", bytes: new ArrayBuffer(90) })).toBe(true);
    await session.putDoc(docKey("b"), doc("b", "y".repeat(350)), { opened: true });
    await session.putDoc(docKey("c"), doc("c", "z".repeat(350)), { opened: true });
    expect(session.entry(docKey("a"))).toBeNull();
    expect(await backend.readAll("assets")).toEqual([]);
    expect(session.entries().map((entry) => entry.key).sort()).toEqual(["d:b", "d:c"]);
  });

  it("does not keep a document or a picture over its own limit", async () => {
    const { session } = await small();
    expect(await session.putDoc(docKey("big"), doc("big", "x".repeat(401)))).toBe(false);
    expect(session.entries()).toEqual([]);
    await session.putDoc(docKey("a"), doc("a", "a"));
    expect(await session.putAsset(docKey("a"), "huge.png", { type: "image/png", bytes: new ArrayBuffer(101) })).toBe(false);
    expect(await session.putAsset(docKey("a"), "1.png", { type: "image/png", bytes: new ArrayBuffer(100) })).toBe(true);
    expect(await session.putAsset(docKey("a"), "2.png", { type: "image/png", bytes: new ArrayBuffer(100) })).toBe(false);
    expect(await session.putAsset(docKey("nope"), "1.png", { type: "image/png", bytes: new ArrayBuffer(1) })).toBe(false);
  });
});

describe("queued edits", () => {
  it("keeps an offline save and sends it when the connection is back", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "one\n", version: 4 } });
    const { api } = await phone(srv);
    await api.doc("d1");
    srv.state.online = false;
    const saved = await api.offline.save({ id: "d1", name: "Plan.md", content: "one\ntwo\n", baseVersion: 4 });
    expect(saved).toEqual({ id: "d1", version: 4, queued: true });
    expect(api.offline.snapshot().marks.get("d1")).toBe("unpushed");
    const shown = await api.doc("d1");
    expect(shown.content).toBe("one\ntwo\n");
    expect(shown.version).toBe(4);
    expect(offlineInfo(shown)).toMatchObject({ fromPhone: true, pending: "unpushed" });
    srv.state.online = true;
    expect(await api.offline.drain()).toEqual({ sent: 1, conflicts: 0, refused: 0, waiting: 0 });
    expect(srv.docs.get("d1")).toMatchObject({ content: "one\ntwo\n", version: 5 });
    expect(srv.state.puts).toEqual([{ id: "d1", baseVersion: 4, content: "one\ntwo\n" }]);
    const after = await api.doc("d1");
    expect(after.version).toBe(5);
    expect(offlineInfo(after)).toBeNull();
    expect(api.offline.snapshot().unsent).toBe(0);
  });

  it("is still there, and still sent, after the app was closed and reopened", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "one\n", version: 1 } });
    const first = await phone(srv);
    await first.api.doc("d1");
    srv.state.online = false;
    await first.offline.save({ id: "d1", name: "Plan.md", content: "kept across a relaunch\n", baseVersion: 1 });
    const second = await phone(srv, first.backend);
    expect(second.offline.pending("d1")).toBe("unpushed");
    srv.state.online = true;
    // Opening the document is enough: the edit goes out first.
    const opened = await second.api.doc("d1");
    expect(opened).toMatchObject({ content: "kept across a relaunch\n", version: 2 });
    expect(srv.docs.get("d1")?.content).toBe("kept across a relaunch\n");
  });

  it("never overwrites a newer cloud copy: it becomes a conflict", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 2 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    srv.state.online = false;
    await api.offline.save({ id: "d1", name: "Plan.md", content: "phone\n", baseVersion: 2 });
    srv.elsewhere("d1", "desktop\n");
    srv.state.online = true;
    expect(await api.offline.drain()).toEqual({ sent: 0, conflicts: 1, refused: 0, waiting: 0 });
    // The one PUT carried the version the edit started from, and was refused.
    expect(srv.state.puts).toEqual([{ id: "d1", baseVersion: 2, content: "phone\n" }]);
    expect(srv.docs.get("d1")).toMatchObject({ content: "desktop\n", version: 3 });
    const record = await session.getDoc(docKey("d1"));
    expect(record?.pending).toMatchObject({ content: "phone\n", baseVersion: 2, state: "conflict" });
    expect(record?.doc).toMatchObject({ content: "desktop\n", version: 3 });
    // And it is not tried again behind the person's back.
    await api.offline.drain();
    await api.doc("d1");
    expect(srv.state.puts.length).toBe(1);
    expect(offlineInfo(await api.doc("d1"))).toMatchObject({ pending: "conflict", behind: true });
  });

  it("an interactive save that conflicts keeps the text and throws the conflict", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 2 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    srv.elsewhere("d1", "desktop\n");
    await expect(api.offline.save({ id: "d1", name: "Plan.md", content: "phone\n", baseVersion: 2 })).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect((await session.getDoc(docKey("d1")))?.pending).toMatchObject({ content: "phone\n", state: "conflict" });
    expect(srv.docs.get("d1")?.content).toBe("desktop\n");
  });

  it("a send whose answer was lost is not called a conflict", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 1 } });
    const { api } = await phone(srv);
    await api.doc("d1");
    srv.state.dropNextPutAnswer = true;
    expect((await api.offline.save({ id: "d1", name: "Plan.md", content: "sent once\n", baseVersion: 1 })).queued).toBe(true);
    expect(srv.docs.get("d1")).toMatchObject({ content: "sent once\n", version: 2 });
    expect(await api.offline.drain()).toMatchObject({ sent: 1, conflicts: 0 });
    expect(api.offline.pending("d1")).toBeNull();
    expect((await api.doc("d1")).version).toBe(2);
  });

  it("waits, unpushed, while the server can't be reached or can't answer", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 1 }, d2: { name: "B.md", content: "b\n", version: 1 } });
    const { api } = await phone(srv);
    await api.doc("d1");
    await api.doc("d2");
    srv.state.online = false;
    await api.offline.save({ id: "d1", name: "Plan.md", content: "1\n", baseVersion: 1 });
    await api.offline.save({ id: "d2", name: "B.md", content: "2\n", baseVersion: 1 });
    expect(await api.offline.drain()).toEqual({ sent: 0, conflicts: 0, refused: 0, waiting: 2 });
    srv.state.online = true;
    srv.state.status = 503;
    expect((await api.offline.drain()).waiting).toBe(2);
    expect(api.offline.snapshot().unsent).toBe(2);
    srv.state.status = null;
    expect((await api.offline.drain()).sent).toBe(2);
  });

  it("a later offline save replaces the queued one, with the same base", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 7 } });
    const { api } = await phone(srv);
    await api.doc("d1");
    srv.state.online = false;
    await api.offline.save({ id: "d1", name: "Plan.md", content: "first\n", baseVersion: 7 });
    const reopened = await api.doc("d1");
    await api.offline.save({ id: "d1", name: "Plan.md", content: "second\n", baseVersion: reopened.version! });
    srv.state.online = true;
    await api.offline.drain();
    expect(srv.state.puts).toEqual([{ id: "d1", baseVersion: 7, content: "second\n" }]);
    expect(srv.docs.get("d1")).toMatchObject({ content: "second\n", version: 8 });
  });

  it("a new document made offline is listed, and created when the connection is back", async () => {
    const srv = server();
    const { api } = await phone(srv);
    srv.state.online = false;
    const made = await api.offline.create({ name: "Idea.md", content: "# Idea\n" });
    expect(made.queued).toBe(true);
    expect((await api.recent()).map((item) => item.name)).toEqual(["Idea.md"]);
    expect((await api.doc(made.id)).content).toBe("# Idea\n");
    srv.state.online = true;
    await api.offline.drain();
    expect(srv.docs.get(made.id)).toMatchObject({ name: "Idea.md", content: "# Idea\n", version: 1 });
  });

  it("an edit the server refuses is kept, said to be refused, and can be rescued", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 1 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    srv.state.online = false;
    await api.offline.save({ id: "d1", name: "Plan.md", content: "mine\n", baseVersion: 1 });
    srv.state.online = true;
    srv.state.gone.add("d1");
    expect((await api.offline.drain()).refused).toBe(1);
    // Access is gone, so the server copy would be removed. Their text is not.
    const shown = await api.doc("d1");
    expect(shown.content).toBe("mine\n");
    expect(offlineInfo(shown)).toMatchObject({ pending: "refused" });
    const rescued = await api.offline.rescue("d1");
    expect(rescued.name).toBe("Plan (my version).md");
    expect(srv.docs.get(rescued.id)?.content).toBe("mine\n");
    expect(session.entry(docKey("d1"))).toBeNull();
  });

  it("an error that is not the network puts back what was queued before", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 1 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    srv.state.status = 500;
    await expect(api.offline.save({ id: "d1", name: "Plan.md", content: "mine\n", baseVersion: 1 })).rejects.toBeInstanceOf(ApiError);
    expect((await session.getDoc(docKey("d1")))?.pending).toBeNull();
  });

  it("a plain save through the client does not queue, and leaves a queued edit alone", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 1 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    srv.state.online = false;
    await expect(api.saveDoc({ id: "d1", name: "Plan.md", content: "live\n", baseVersion: 1 })).rejects.toMatchObject({ status: 0 });
    expect(session.unsent()).toBe(0);
    srv.state.online = true;
    await api.saveDoc({ id: "d1", name: "Plan.md", content: "live\n", baseVersion: 1 });
    expect((await session.getDoc(docKey("d1")))?.doc).toMatchObject({ content: "live\n", version: 2 });
  });
});

describe("the conflict choices", () => {
  async function conflicted() {
    const srv = server({ d1: { name: "Plan.md", content: "a\nb\nc\n", version: 2 } });
    const kit = await phone(srv);
    await kit.api.recent();
    await kit.api.doc("d1");
    srv.state.online = false;
    await kit.offline.save({ id: "d1", name: "Plan.md", content: "a\nphone\nc\n", baseVersion: 2 });
    srv.elsewhere("d1", "a\nb\nc\ndesktop\n");
    srv.state.online = true;
    await kit.offline.drain();
    return { srv, ...kit };
  }

  it("keep both: their version becomes a second document, then this one takes the cloud copy", async () => {
    const { srv, api, session } = await conflicted();
    const result = await api.offline.keepBoth("d1", "a\nphone\nc\n");
    expect(result.copy.name).toBe("Plan (my version).md");
    expect(result.copy.queued).toBe(false);
    // Three copies, none lost: the cloud's, theirs as its own document, and
    // the original now equal to the cloud's.
    expect(srv.docs.get("d1")).toMatchObject({ content: "a\nb\nc\ndesktop\n", version: 3 });
    expect(srv.docs.get(result.copy.id)).toMatchObject({ name: "Plan (my version).md", content: "a\nphone\nc\n", version: 1 });
    const record = await session.getDoc(docKey("d1"));
    expect(record?.pending).toBeNull();
    expect(record?.doc.content).toBe("a\nb\nc\ndesktop\n");
    expect(offlineInfo(await api.doc("d1"))).toBeNull();
  });

  it("keep both never reuses a name: a second rescue is (my version 2)", async () => {
    const { srv, api } = await conflicted();
    srv.docs.set("older", { name: "Plan (my version).md", content: "an earlier rescue", version: 1 });
    await api.recent();
    const result = await api.offline.keepBoth("d1", "a\nphone\nc\n");
    expect(result.copy.name).toBe("Plan (my version 2).md");
    expect(srv.docs.get("older")?.content).toBe("an earlier rescue");
  });

  it("keep both changes nothing when the server can't be reached", async () => {
    const { srv, api, session } = await conflicted();
    srv.state.online = false;
    await expect(api.offline.keepBoth("d1", "a\nphone\nc\n")).rejects.toMatchObject({ status: 0 });
    expect((await session.getDoc(docKey("d1")))?.pending).toMatchObject({ content: "a\nphone\nc\n", state: "conflict" });
    expect(session.entries().length).toBe(1);
  });

  it("keep both with the connection lost halfway keeps their version on the phone first", async () => {
    const { srv, api, session } = await conflicted();
    // The cloud copy is read, then the copy's PUT finds no network.
    const original = srv.transport;
    const flaky: HttpTransport = async (req) => {
      if (req.method === "PUT") throw new NetworkError();
      return original(req);
    };
    const raw = createApiClient({ origin: ORIGIN, transport: flaky, getToken: () => TOKEN });
    const half = createOfflineApi(raw, session);
    const result = await half.offline.keepBoth("d1", "a\nphone\nc\n");
    expect(result.copy.queued).toBe(true);
    expect((await session.getDoc(docKey(result.copy.id)))?.pending).toMatchObject({ content: "a\nphone\nc\n", baseVersion: 0, state: "unpushed" });
    expect((await session.getDoc(docKey("d1")))?.doc.content).toBe("a\nb\nc\ndesktop\n");
    await api.offline.drain();
    expect(srv.docs.get(result.copy.id)?.content).toBe("a\nphone\nc\n");
  });

  it("keep mine: reads the cloud version again and saves on top of it", async () => {
    const { srv, api, session } = await conflicted();
    const before = srv.state.puts.length;
    await api.offline.keepMine("d1", "a\nphone\nc\n");
    expect(srv.state.puts.slice(before)).toEqual([{ id: "d1", baseVersion: 3, content: "a\nphone\nc\n" }]);
    expect(srv.docs.get("d1")).toMatchObject({ content: "a\nphone\nc\n", version: 4 });
    expect((await session.getDoc(docKey("d1")))?.pending).toBeNull();
  });

  it("keep mine that can't reach the server leaves the conflict as it was", async () => {
    const { srv, api, session } = await conflicted();
    srv.state.online = false;
    await expect(api.offline.keepMine("d1", "a\nphone\nc\n")).rejects.toMatchObject({ status: 0 });
    expect((await session.getDoc(docKey("d1")))?.pending).toMatchObject({ content: "a\nphone\nc\n", state: "conflict" });
  });

  it("take cloud: their edit goes and the document holds the cloud copy", async () => {
    const { srv, api, session } = await conflicted();
    const cloud = await api.offline.takeCloud("d1");
    expect(cloud.content).toBe("a\nb\nc\ndesktop\n");
    expect((await session.getDoc(docKey("d1")))?.pending).toBeNull();
    expect(srv.docs.get("d1")?.version).toBe(3);
  });

  it("take cloud is refused while the edit is unpushed", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 1 } });
    const { api, session } = await phone(srv);
    await api.doc("d1");
    srv.state.online = false;
    await api.offline.save({ id: "d1", name: "Plan.md", content: "only copy\n", baseVersion: 1 });
    srv.state.online = true;
    srv.state.status = 503;
    await expect(api.offline.takeCloud("d1")).rejects.toMatchObject({ status: 409, code: "unpushed", message: TAKE_CLOUD_REFUSAL });
    await expect(api.offline.discard("d1")).rejects.toMatchObject({ code: "unpushed" });
    expect((await session.getDoc(docKey("d1")))?.pending?.content).toBe("only copy\n");
  });

  it("names the copy the way the desktop does", () => {
    const taken = new Set(["Plan (my version).md", "Plan (my version 2).md"]);
    expect(keepBothName("Plan.md", () => false)).toBe("Plan (my version).md");
    expect(keepBothName("Plan.md", (name) => taken.has(name))).toBe("Plan (my version 3).md");
    expect(keepBothName("notes", () => false)).toBe("notes (my version)");
    expect(keepBothName(".env", () => false)).toBe(".env (my version)");
    expect(keepBothName("Plan.md", () => true)).toBeNull();
  });
});

describe("the wrapper", () => {
  it("is the client the screens already use", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api } = await phone(srv);
    expect(api.origin).toBe(ORIGIN);
    expect(offlineOf(api)).toBe(api.offline);
    expect(offlineOf(createApiClient({ origin: ORIGIN, transport: srv.transport }))).toBeNull();
  });

  it("never holds the session token", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "x", version: 1 } });
    const { api, backend } = await phone(srv);
    await api.recent();
    await api.doc("d1");
    srv.state.online = false;
    await api.offline.save({ id: "d1", name: "Plan.md", content: "y", baseVersion: 1 });
    const everything = JSON.stringify(await Promise.all((["meta", "index", "docs", "assets"] as const).map((name) => backend.readAll(name))));
    expect(everything).not.toContain(TOKEN);
  });

  it("goes back online by itself and sends what waited", async () => {
    const srv = server({ d1: { name: "Plan.md", content: "base\n", version: 1 } });
    const { api } = await phone(srv);
    await api.doc("d1");
    srv.state.online = false;
    await api.offline.save({ id: "d1", name: "Plan.md", content: "mine\n", baseVersion: 1 });
    await api.recent().catch(() => undefined);
    srv.state.online = true;
    await api.recent();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(srv.docs.get("d1")?.content).toBe("mine\n");
    expect(api.offline.snapshot().unsent).toBe(0);
  });
});


describe("what the screens say", () => {
  it("tells a removed person that access changed, never that edits are waiting", async () => {
    const { liveLineText, ACCESS_CHANGED_NOTE } = await import("../src/screens/editor");
    // The shared editors report a 4403 close as "disconnected".
    const removed = liveLineText({ status: "disconnected", save: "pending", readOnly: false, wait: "not-synced", revoked: true });
    expect(removed).toBe(ACCESS_CHANGED_NOTE);
    expect(removed).not.toMatch(/offline|wait/i);
    expect(removed).toMatch(/read-only/);
    // Really offline still says so.
    expect(liveLineText({ status: "disconnected", save: "pending", readOnly: false, wait: "not-synced" })).toMatch(/^Offline\./);
  });

  it("says nothing was changed when a conflict choice fails", async () => {
    const { conflictErrorCopy } = await import("../src/components/conflict-sheet");
    expect(conflictErrorCopy(new ApiError(0, "x"))).toMatch(/offline.*Nothing was changed/);
    expect(conflictErrorCopy(new ApiError(409, TAKE_CLOUD_REFUSAL, "unpushed"))).toBe(TAKE_CLOUD_REFUSAL);
    expect(conflictErrorCopy(new ApiError(409, "x", "conflict"))).toMatch(/changed again/);
  });

  it("uses no em dashes in its own words", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["src/components/conflict-sheet.tsx", "src/components/offline-note.tsx"]) {
      const strings = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n").filter((line) => !line.trim().startsWith("//"));
      expect(strings.join("\n")).not.toContain("—");
    }
  });
});
