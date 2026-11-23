// The API client with the phone's store behind it (offline-store.ts), so the
// screens keep calling the client they always called.
//
// Reading: the network is asked first. When it can't be reached, the copy
// kept on this phone is returned instead, and marked as such. A document the
// server says this account can't read any more (403, 404) is removed.
//
// Writing follows the desktop's sync (electron/sync.js) exactly:
// - A save the server never received is kept as an `unpushed` edit, with the
//   version it started from.
// - It is sent again when the connection is back, with that same version.
//   The version is never raised to get it through, so a queued save can
//   never overwrite a newer cloud copy: the server refuses it (409) and the
//   edit becomes a `conflict`.
// - A conflict is settled by the person, never merged: keep both, keep mine
//   on top of the cloud copy as it is now, or take the cloud copy. Taking the
//   cloud copy is refused while the edit is unpushed.
import { ApiError, type ApiClient, type AssetSource } from "./api";
import { DOC_ID, formatFromName, kindFromName, newDocId, type CloudDoc, type RecentDoc } from "./docs";
import { mergeRecent } from "./recent";
import { docKey, publicKey, type IndexEntry, type OfflineSession, type PendingEdit, type PendingState, type StoredDoc } from "./offline-store";

/** Why a document on screen is not simply the server's current copy. */
export interface OfflineInfo {
  /** The server couldn't be reached, so this is the copy kept on the phone. */
  fromPhone: boolean;
  /** When that copy was kept. */
  savedAt: number;
  /** The text shown is the person's edit, which the server has not taken. */
  pending: PendingState | null;
  /** With a pending edit: the cloud copy is known to have moved on. */
  behind: boolean;
  reason: string | null;
}

export type SaveResult = { id: string; version: number; queued?: boolean };

export type DrainResult = { sent: number; conflicts: number; refused: number; waiting: number };

export type OfflineMark = "kept" | PendingState;

export interface OfflineSnapshot {
  /** The last request could not reach the server. */
  offline: boolean;
  /** When the list on screen was kept, if it came from the phone. Null when it came from the server. */
  listSavedAt: number | null;
  /** By document id. */
  marks: ReadonlyMap<string, OfflineMark>;
  unsent: number;
  kept: number;
  /** Goes up when a document on the server was made or changed from this phone, so lists read again. */
  changes: number;
}

export interface KeepBothResult {
  /** The second document that now holds the person's version. */
  copy: { id: string; name: string; queued: boolean };
  /** The cloud copy the original document now holds. */
  cloud: CloudDoc;
}

export interface OfflineHandle {
  /** What the screens show about the store. The same object until something changes. */
  snapshot(): OfflineSnapshot;
  subscribe(listener: () => void): () => void;
  /** The pending edit on a document, if any. */
  pending(id: string): IndexEntry["pending"];
  /**
   * Saves a version. When the server can't be reached the edit is kept on
   * the phone and the answer says `queued`. A 409 is thrown as the API
   * client throws it, with the edit kept as a conflict.
   */
  save(input: { id: string; name: string; content: string; baseVersion: number }): Promise<SaveResult>;
  /** A new document. Kept on the phone when the server can't be reached. */
  create(input: { name: string; content: string }): Promise<SaveResult & { name: string }>;
  /** Sends every unpushed edit, oldest first. Stops at the first one the network drops. */
  drain(): Promise<DrainResult>;
  /** The cloud copy of a document, read now. */
  cloudCopy(id: string): Promise<CloudDoc>;
  /** The person's unsent text for a document, or null. */
  mine(id: string): Promise<PendingEdit | null>;
  /** Their version becomes a second document, then this one takes the cloud copy. */
  keepBoth(id: string, mine: string): Promise<KeepBothResult>;
  /** Reads the cloud version again and saves their version on top of it. */
  keepMine(id: string, mine: string): Promise<{ id: string; version: number }>;
  /** Drops their edit for the cloud copy. Refused while the edit is unpushed. */
  takeCloud(id: string): Promise<CloudDoc>;
  /** Their refused edit becomes a new document, and this one is let go. */
  rescue(id: string): Promise<{ id: string; name: string; queued: boolean }>;
  /** Drops an edit the server refused. The caller has asked the person first. */
  discard(id: string): Promise<void>;
  dispose(): void;
}

export type OfflineApiClient = ApiClient & { offline: OfflineHandle };

/** The store behind a client, when it has one. */
export function offlineOf(api: ApiClient): OfflineHandle | null {
  return (api as Partial<OfflineApiClient>).offline ?? null;
}

const infos = new WeakMap<CloudDoc, OfflineInfo>();

/** Set when a document on screen came from the phone or shows an unsent edit. */
export function offlineInfo(doc: CloudDoc | null | undefined): OfflineInfo | null {
  return doc ? infos.get(doc) ?? null : null;
}

/** The desktop's words (electron/sync.js resolveAt), for a phone. */
export const TAKE_CLOUD_REFUSAL = "This document has changes that never reached the cloud. Taking the cloud copy would delete them. Send them first.";

const isOffline = (error: unknown) => error instanceof ApiError && error.status === 0;
const isGone = (error: unknown) => error instanceof ApiError && (error.status === 403 || error.status === 404);
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "conflict";
/** The server is there but can't answer now. A stored copy is better than an error. */
const isUnavailable = (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);

/**
 * "Plan.md" becomes "Plan (my version).md", then "(my version 2)" and so on:
 * the desktop's rule (electron/sync.js keepBothPath). A name already in use
 * is never reused, so an earlier rescue is never mistaken for this one.
 */
export function keepBothName(name: string, taken: (candidate: string) => boolean): string | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 1000; n += 1) {
    const candidate = `${stem}${n === 0 ? " (my version)" : ` (my version ${n + 1})`}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return null;
}

export function createOfflineApi(api: ApiClient, store: OfflineSession, { now = () => Date.now() }: { now?: () => number } = {}): OfflineApiClient {
  let offline = false;
  let listSavedAt: number | null = null;
  let snapshot: OfflineSnapshot | null = null;
  let changes = 0;
  const changedOnServer = () => { changes += 1; notify(); };
  const listeners = new Set<() => void>();
  const notify = () => { snapshot = null; for (const listener of [...listeners]) listener(); };
  const unsubscribeStore = store.subscribe(notify);

  function reached(ok: boolean): void {
    if (offline === !ok) return;
    offline = !ok;
    notify();
    // Back in reach: whatever waited goes out.
    if (ok && store.unsent() > 0) void drain().catch(() => undefined);
  }

  /** Runs a request and notes whether the server could be reached. */
  async function net<T>(call: () => Promise<T>): Promise<T> {
    try {
      const value = await call();
      reached(true);
      return value;
    } catch (error) {
      if (isOffline(error)) reached(false);
      else if (error instanceof ApiError && error.status > 0) reached(true);
      throw error;
    }
  }

  /** The document as the person sees it: their unsent text over the stored copy. */
  function shown(record: StoredDoc, fromPhone: boolean): CloudDoc {
    const pending = record.pending;
    const doc: CloudDoc = pending
      ? { ...record.doc, name: pending.name, content: pending.content, version: pending.baseVersion }
      : { ...record.doc };
    if (fromPhone || pending) {
      infos.set(doc, {
        fromPhone,
        savedAt: record.savedAt,
        pending: pending?.state ?? null,
        behind: !!pending && record.doc.version !== null && record.doc.version > pending.baseVersion,
        reason: pending?.reason ?? null,
      });
    }
    return doc;
  }

  // ── The queue ─────────────────────────────────────────────────────────

  /** One document at a time: a save and the drain never push the same edit twice. */
  const busy = new Map<string, Promise<unknown>>();
  function locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const before = busy.get(id) ?? Promise.resolve();
    const run = before.then(task, task);
    const tail = run.catch(() => undefined);
    busy.set(id, tail);
    void tail.then(() => { if (busy.get(id) === tail) busy.delete(id); });
    return run;
  }

  function blankDoc(id: string, name: string, content: string, version: number): CloudDoc {
    return {
      id, name, format: formatFromName(name), version, content, updatedAt: new Date(now()).toISOString(),
      origin: { kind: "app", agent: null }, privateLink: api.privateLinkFor(id), role: "owner",
    };
  }

  /**
   * Sends one edit with the version it started from. Never anything else:
   * this is the only place a queued edit reaches the server.
   */
  async function push(id: string, edit: PendingEdit): Promise<"sent" | "conflict" | "refused" | "waiting"> {
    const key = docKey(id);
    const settle = async (state: PendingState, reason?: string) => {
      const record = await store.getDoc(key);
      if (record?.pending) await store.setPending(key, { ...record.pending, state, reason });
    };
    try {
      const saved = await net(() => api.saveDoc({ id, name: edit.name, content: edit.content, baseVersion: edit.baseVersion }));
      const record = await store.getDoc(key);
      const base = record?.doc ?? blankDoc(id, edit.name, edit.content, saved.version);
      await store.setPending(key, null, { ...base, name: edit.name, content: edit.content, version: saved.version, updatedAt: new Date(now()).toISOString() });
      changedOnServer();
      return "sent";
    } catch (error) {
      if (isConflict(error)) {
        // The cloud moved on, or an earlier send landed and its answer was
        // lost. Only the second is safe to call done: the cloud already
        // holds exactly this text.
        try {
          const cloud = await net(() => api.doc(id));
          if (cloud.content === edit.content) { await store.setPending(key, null, cloud); return "sent"; }
          await store.setPending(key, { ...edit, state: "conflict", reason: undefined }, cloud);
        } catch {
          await settle("conflict");
        }
        return "conflict";
      }
      if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 413 || error.status === 400)) {
        await settle("refused", error.message);
        return "refused";
      }
      // Offline, a busy server, a session that ended: it waits, unpushed.
      return "waiting";
    }
  }

  let draining: Promise<DrainResult> | null = null;
  function drain(): Promise<DrainResult> {
    draining ??= (async () => {
      const result: DrainResult = { sent: 0, conflicts: 0, refused: 0, waiting: 0 };
      const queue: { id: string; queuedAt: number }[] = [];
      for (const entry of store.entries()) {
        if (entry.pending !== "unpushed" || !entry.key.startsWith("d:")) continue;
        const record = await store.getDoc(entry.key);
        if (record?.pending?.state === "unpushed") queue.push({ id: entry.key.slice(2), queuedAt: record.pending.queuedAt });
      }
      queue.sort((a, b) => a.queuedAt - b.queuedAt);
      for (let i = 0; i < queue.length; i += 1) {
        if (!store.alive()) break;
        const { id } = queue[i];
        const outcome = await locked(id, async () => {
          // Read again under the lock: a save may have replaced or sent it.
          const record = await store.getDoc(docKey(id));
          return record?.pending?.state === "unpushed" ? push(id, record.pending) : null;
        });
        if (outcome === "sent") result.sent += 1;
        else if (outcome === "conflict") result.conflicts += 1;
        else if (outcome === "refused") result.refused += 1;
        else if (outcome === "waiting") {
          // The network dropped it: the rest would fail the same way.
          result.waiting += queue.length - i;
          break;
        }
      }
      return result;
    })().finally(() => { draining = null; });
    return draining;
  }

  const handle: OfflineHandle = {
    snapshot() {
      if (snapshot) return snapshot;
      const marks = new Map<string, OfflineMark>();
      let kept = 0;
      for (const entry of store.entries()) {
        if (!entry.key.startsWith("d:")) continue;
        kept += 1;
        marks.set(entry.key.slice(2), entry.pending ?? "kept");
      }
      snapshot = { offline, listSavedAt, marks, unsent: store.unsent(), kept, changes };
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    pending: (id) => store.entry(docKey(id))?.pending ?? null,

    save: ({ id, name, content, baseVersion }) => locked(id, async () => {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const key = docKey(id);
      const before = await store.getDoc(key);
      const edit: PendingEdit = { content, name, baseVersion, queuedAt: now(), state: "unpushed" };
      // On the phone before it is on the wire: if the app dies mid-request,
      // the text is still here.
      await store.setPending(key, edit, before?.doc ?? blankDoc(id, name, content, baseVersion));
      try {
        const saved = await net(() => api.saveDoc({ id, name, content, baseVersion }));
        const base = (await store.getDoc(key))?.doc ?? blankDoc(id, name, content, saved.version);
        await store.setPending(key, null, { ...base, name, content, version: saved.version, updatedAt: new Date(now()).toISOString() });
        changedOnServer();
        return saved;
      } catch (error) {
        if (isOffline(error)) return { id, version: baseVersion, queued: true };
        if (isConflict(error)) {
          await store.setPending(key, { ...edit, state: "conflict" });
          throw error;
        }
        if (error instanceof ApiError && error.status === 401) throw error;
        // The editor still holds the text and shows the error. What was
        // queued before this attempt, if anything, is put back.
        if (before) await store.setPending(key, before.pending);
        else await store.removeDoc(key, { evenIfPending: true });
        throw error;
      }
    }),

    async create({ name, content }) {
      const id = newDocId();
      const saved = await handle.save({ id, name, content, baseVersion: 0 });
      return { ...saved, name };
    },

    drain,

    cloudCopy: (id) => net(() => api.doc(id)),

    async mine(id) {
      return (await store.getDoc(docKey(id)))?.pending ?? null;
    },

    keepBoth: (id, mine) => locked(id, async () => {
      const key = docKey(id);
      const record = await store.getDoc(key);
      // Read the cloud copy before anything is written: a server that can't
      // be reached must not leave a stray copy for a choice never made.
      const cloud = await net(() => api.doc(id));
      const names = await store.knownNames();
      const name = keepBothName(record?.pending?.name ?? record?.doc.name ?? cloud.name, (candidate) => names.has(candidate));
      if (!name) throw new ApiError(409, "Couldn't find an unused name for the copy.");
      // Their version is safe as its own document, on the server or queued
      // on this phone, before the original takes the cloud copy.
      const copy = await handle.create({ name, content: mine });
      await store.setPending(key, null, cloud);
      changedOnServer();
      return { copy: { id: copy.id, name, queued: copy.queued === true }, cloud };
    }),

    keepMine: (id, mine) => locked(id, async () => {
      const key = docKey(id);
      const record = await store.getDoc(key);
      const cloud = await net(() => api.doc(id));
      if (cloud.version === null) throw new ApiError(409, "The server didn't say which version this document is at.");
      const name = record?.pending?.name ?? cloud.name;
      const edit: PendingEdit = { content: mine, name, baseVersion: cloud.version, queuedAt: now(), state: "conflict" };
      // Their text stays on the phone, still marked a conflict, until the
      // server has it. If the cloud copy moves again meanwhile, it is one.
      await store.setPending(key, edit, cloud);
      const saved = await net(() => api.saveDoc({ id, name, content: mine, baseVersion: cloud.version! }));
      await store.setPending(key, null, { ...cloud, name, content: mine, version: saved.version, updatedAt: new Date(now()).toISOString() });
      changedOnServer();
      return saved;
    }),

    takeCloud: (id) => locked(id, async () => {
      const key = docKey(id);
      if (store.entry(key)?.pending === "unpushed") throw new ApiError(409, TAKE_CLOUD_REFUSAL, "unpushed");
      const cloud = await net(() => api.doc(id));
      // Checked again: a save may have queued while the cloud copy was read.
      if (store.entry(key)?.pending === "unpushed") throw new ApiError(409, TAKE_CLOUD_REFUSAL, "unpushed");
      await store.setPending(key, null, cloud);
      return cloud;
    }),

    rescue: (id) => locked(id, async () => {
      const key = docKey(id);
      const record = await store.getDoc(key);
      if (!record?.pending) throw new ApiError(404, "There is no unsent edit on this document.");
      const names = await store.knownNames();
      const name = keepBothName(record.pending.name, (candidate) => names.has(candidate));
      if (!name) throw new ApiError(409, "Couldn't find an unused name for the copy.");
      const copy = await handle.create({ name, content: record.pending.content });
      await store.removeDoc(key, { evenIfPending: true });
      changedOnServer();
      return { id: copy.id, name, queued: copy.queued === true };
    }),

    discard: (id) => locked(id, async () => {
      const key = docKey(id);
      const record = await store.getDoc(key);
      if (!record?.pending) return;
      if (record.pending.state === "unpushed") throw new ApiError(409, TAKE_CLOUD_REFUSAL, "unpushed");
      // A document that only ever existed on this phone has nothing under it.
      if (record.pending.baseVersion === 0 && record.doc.version === 0) await store.removeDoc(key, { evenIfPending: true });
      else await store.setPending(key, null);
    }),

    dispose() {
      unsubscribeStore();
      listeners.clear();
    },
  };

  // ── Reading ───────────────────────────────────────────────────────────

  async function readDoc(key: string, fetchDoc: () => Promise<CloudDoc>, id: string | null): Promise<CloudDoc> {
    let stored = await store.getDoc(key);
    // An edit that waited goes first, so the copy read next is the one it made.
    if (id && stored?.pending?.state === "unpushed") {
      await locked(id, async () => {
        const record = await store.getDoc(key);
        if (record?.pending?.state === "unpushed") await push(id, record.pending);
      });
      stored = await store.getDoc(key);
    }
    try {
      const doc = await net(fetchDoc);
      const kept = await store.putDoc(key, doc, { opened: true }).catch(() => false);
      const record = kept ? await store.getDoc(key) : null;
      return record?.pending ? shown(record, false) : doc;
    } catch (error) {
      if (isGone(error)) {
        // Not theirs to read any more. An unsent edit is the one thing kept:
        // it is their own text, and they are told why it can't go out.
        if (stored?.pending) {
          // Made on this phone and never sent: the server has nothing to find yet.
          if (stored.pending.baseVersion === 0 && stored.doc.version === 0 && stored.pending.state === "unpushed") return shown(stored, true);
          await store.setPending(key, { ...stored.pending, state: "refused", reason: error instanceof ApiError ? error.message : undefined });
          const record = await store.getDoc(key);
          if (record) return shown(record, true);
        }
        await store.removeDoc(key).catch(() => undefined);
        throw error;
      }
      if (stored && isUnavailable(error)) {
        // Opened again counts as opened: it is the last to be evicted.
        void store.putDoc(key, stored.doc, { opened: true }).catch(() => undefined);
        return shown(stored, true);
      }
      throw error;
    }
  }

  function recentFromStored(record: StoredDoc): RecentDoc {
    const name = record.pending?.name ?? record.doc.name;
    return {
      id: record.doc.id, store: "docs", kind: kindFromName(name, record.doc.format), name, format: record.doc.format,
      createdAt: null, updatedAt: new Date(record.pending?.queuedAt ?? record.savedAt).toISOString(), origin: record.doc.origin,
      shared: false, role: record.doc.role ?? "owner", sharedBy: null, privateLink: record.doc.privateLink,
    };
  }

  /** Documents made on this phone that the server has not seen: they belong in the list too. */
  async function unsentNew(known: readonly RecentDoc[]): Promise<RecentDoc[]> {
    const out: RecentDoc[] = [];
    for (const entry of store.entries()) {
      if (!entry.pending || !entry.key.startsWith("d:")) continue;
      const id = entry.key.slice(2);
      if (known.some((doc) => doc.store === "docs" && doc.id === id)) continue;
      const record = await store.getDoc(entry.key);
      if (record?.pending && record.pending.baseVersion === 0) out.push(recentFromStored(record));
    }
    return out;
  }

  const wrapped: OfflineApiClient = {
    ...api,
    offline: handle,

    doc: (id) => (DOC_ID.test(id) ? readDoc(docKey(id), () => api.doc(id), id) : api.doc(id)),

    publicDoc: (token) => readDoc(publicKey(token), () => api.publicDoc(token), null),

    async recent(input = {}) {
      try {
        const page = await net(() => api.recent(input));
        if (!input.before) {
          if (listSavedAt !== null) { listSavedAt = null; notify(); }
          await store.putList({ docs: page }).catch(() => undefined);
        } else {
          const list = await store.getList().catch(() => null);
          if (list) await store.putList({ docs: mergeRecent(list.docs, page) }).catch(() => undefined);
        }
        const extra = input.before ? [] : await unsentNew(page);
        if (store.unsent() > 0) void drain().catch(() => undefined);
        return extra.length ? mergeRecent(page, extra) : page;
      } catch (error) {
        if (!isUnavailable(error) || input.before) throw error;
        const list = await store.getList().catch(() => null);
        const extra = await unsentNew(list?.docs ?? []);
        if (!list && !extra.length) throw error;
        listSavedAt = list?.savedAt ?? now();
        notify();
        return mergeRecent(list?.docs ?? [], extra);
      }
    },

    async platformRecent() {
      try {
        const rows = await net(() => api.platformRecent());
        await store.putList({ platform: rows }).catch(() => undefined);
        return rows;
      } catch (error) {
        if (!isUnavailable(error)) throw error;
        const list = await store.getList().catch(() => null);
        if (!list) throw error;
        return list.platform;
      }
    },

    async docLinks(id) {
      const key = docKey(id);
      if (!offline) {
        const links = await api.docLinks(id);
        // The client answers an empty map for "none" and for "couldn't ask".
        // Only a real answer replaces what is kept.
        if (links.size) { await store.setLinks(key, [...links.entries()]).catch(() => undefined); return links; }
      }
      const record = await store.getDoc(key).catch(() => null);
      return new Map(record?.links ?? []);
    },

    async asset(source: AssetSource, ref: string) {
      const key = source.kind === "doc" ? docKey(source.id) : publicKey(source.token);
      const fromPhone = async () => {
        const kept = await store.getAsset(key, ref).catch(() => null);
        return kept ? new Blob([kept.bytes], { type: kept.type }) : null;
      };
      // Known to be offline: don't make every picture wait for a timeout.
      const triedPhone = offline;
      if (triedPhone) {
        const kept = await fromPhone();
        if (kept) return kept;
      }
      try {
        const blob = await net(() => api.asset(source, ref));
        if (blob) void blob.arrayBuffer().then((bytes) => store.putAsset(key, ref, { type: blob.type, bytes })).catch(() => undefined);
        return blob;
      } catch (error) {
        const kept = triedPhone ? null : await fromPhone();
        if (kept) return kept;
        throw error;
      }
    },

    async saveDoc(input) {
      const saved = await net(() => api.saveDoc(input));
      // The copy on the phone follows a save made on the phone. A pending
      // edit is left alone: only the queue settles it.
      const key = docKey(input.id);
      const record = await store.getDoc(key).catch(() => null);
      if (record && !record.pending) {
        await store.putDoc(key, { ...record.doc, name: input.name, content: input.content, version: saved.version, updatedAt: new Date(now()).toISOString() }).catch(() => undefined);
      }
      return saved;
    },
  };
  return wrapped;
}
