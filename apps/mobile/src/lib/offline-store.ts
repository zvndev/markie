// What the phone keeps so an opened document still opens on a plane: the
// documents this account opened, the pictures they show, the last Recent
// list, and any edit that has not reached the server yet.
//
// Where it lives: IndexedDB in the app's own web view. On iOS that is
// Library/WebKit inside the app's container, which iOS encrypts with the
// device passcode (Data Protection, available after the first unlock) and
// which AppDelegate.swift marks as excluded from iCloud and Finder backups.
// On Android it is the app's private data directory, encrypted by the
// device's file-based encryption, and the manifest already turns backups and
// device-to-device transfer off. Nothing here goes to localStorage, to a
// shared folder, or anywhere another app can read.
//
// The session token is never stored here. It stays in the Keychain or the
// Keystore (secure-store.ts).
//
// Who it belongs to: one account on one server. Signing out wipes all of it
// before the server is told. A different account signing in wipes it. A
// launch with no session wipes it. The one exception is a session the server
// ended on its own (a 401): then only the edits that were never sent are
// held, for the same account's next sign-in, because dropping them would
// lose the person's only copy.
//
// What is never dropped: a document with an edit the server has not taken.
// The cap below evicts the least recently opened documents first and skips
// those.
import type { CloudDoc, RecentDoc } from "./docs";

export type StoreName = "meta" | "index" | "docs" | "assets";
const STORES: readonly StoreName[] = ["meta", "index", "docs", "assets"];

export type WriteOp =
  | { store: StoreName; key: string; value: unknown }
  | { store: StoreName; key: string; remove: true }
  /** Every key that starts with this. */
  | { store: StoreName; removePrefix: string };

/** The seam under the store: IndexedDB on a device, memory in tests. */
export interface OfflineBackend {
  read(store: StoreName, key: string): Promise<unknown>;
  readAll(store: StoreName): Promise<unknown[]>;
  /** All of it or none of it. */
  write(ops: WriteOp[]): Promise<void>;
  clear(): Promise<void>;
}

/**
 * unpushed: the server never received this edit. conflict: the server
 * refused it because the cloud copy moved on. refused: the server refused it
 * for another reason (access removed, document deleted, storage full).
 * The names are the desktop's (electron/sync.js sync_state).
 */
export type PendingState = "unpushed" | "conflict" | "refused";

export interface PendingEdit {
  content: string;
  name: string;
  /** The version this edit started from. It is never raised to get a save through. */
  baseVersion: number;
  queuedAt: number;
  state: PendingState;
  /** Why the server refused it, in its own words when it gave any. */
  reason?: string;
}

export interface StoredDoc {
  key: string;
  /** The last copy the server gave. */
  doc: CloudDoc;
  /** Where the document's relative links point, as [ref, document id]. */
  links: [string, string][];
  pending: PendingEdit | null;
  savedAt: number;
}

export interface IndexEntry {
  key: string;
  name: string;
  textBytes: number;
  /** Stored pictures by ref, with their size. */
  assets: Record<string, number>;
  openedAt: number;
  savedAt: number;
  pending: PendingState | null;
  /** The cloud copy is known to be newer than the version the pending edit started from. */
  behind: boolean;
}

export interface StoredAsset {
  type: string;
  bytes: ArrayBuffer;
}

export interface StoredList {
  docs: RecentDoc[];
  platform: RecentDoc[];
  savedAt: number;
}

export interface OfflineOwner {
  origin: string;
  userId: string;
  email: string;
}

export interface OfflineLimits {
  maxDocs: number;
  /** Text and pictures together. */
  maxBytes: number;
  /** A document larger than this is read from the network every time. */
  maxDocBytes: number;
  maxAssetBytes: number;
  maxAssetBytesPerDoc: number;
  maxListDocs: number;
}

export const OFFLINE_LIMITS: OfflineLimits = {
  maxDocs: 200,
  maxBytes: 64 * 1024 * 1024,
  maxDocBytes: 8 * 1024 * 1024,
  maxAssetBytes: 4 * 1024 * 1024,
  maxAssetBytesPerDoc: 16 * 1024 * 1024,
  maxListDocs: 500,
};

export const docKey = (id: string) => `d:${id}`;
export const publicKey = (token: string) => `s:${token}`;
const assetKey = (key: string, ref: string) => `${key}\n${ref}`;
const OWNER_KEY = "owner";
const LIST_KEY = "list";

interface OwnerRecord extends OfflineOwner {
  /** The session ended on its own; only unsent edits are left, waiting for this account. */
  held: boolean;
}

function sameOwner(a: OfflineOwner, b: OfflineOwner): boolean {
  // The email is the fallback for a server that never said who the user is.
  return a.origin === b.origin && (a.userId || b.userId ? a.userId === b.userId : a.email === b.email);
}

const encoder = new TextEncoder();
export const textBytes = (text: string) => encoder.encode(text).length;

function entrySize(entry: IndexEntry): number {
  let total = entry.textBytes;
  for (const size of Object.values(entry.assets)) total += size;
  return total;
}

/** One account's time with the store. Dead the moment the store is wiped. */
export interface OfflineSession {
  readonly owner: OfflineOwner;
  /** False once the store was wiped or handed to another account. Writes are dropped. */
  alive(): boolean;
  entries(): IndexEntry[];
  entry(key: string): IndexEntry | null;
  /** Documents with an edit the server has not taken. */
  unsent(): number;
  /** Runs when anything the screens show changes. */
  subscribe(listener: () => void): () => void;
  getDoc(key: string): Promise<StoredDoc | null>;
  /**
   * Keeps the server's copy. A pending edit and the links stay as they were.
   * False when the document is too large to keep (and has no pending edit).
   */
  putDoc(key: string, doc: CloudDoc, options?: { opened?: boolean }): Promise<boolean>;
  setLinks(key: string, links: [string, string][]): Promise<void>;
  /**
   * Sets or clears the pending edit, with the server copy when it changed in
   * the same step. `doc` is required when the document isn't stored yet.
   */
  setPending(key: string, pending: PendingEdit | null, doc?: CloudDoc): Promise<void>;
  /** Removes a document and its pictures. Refuses one with a pending edit unless `evenIfPending`. */
  removeDoc(key: string, options?: { evenIfPending?: boolean }): Promise<boolean>;
  getAsset(key: string, ref: string): Promise<StoredAsset | null>;
  /** Keeps a picture for a stored document. False when it is over the caps. */
  putAsset(key: string, ref: string, asset: StoredAsset): Promise<boolean>;
  getList(): Promise<StoredList | null>;
  putList(list: { docs?: RecentDoc[]; platform?: RecentDoc[] }): Promise<void>;
  /** Names the store knows, for a copy's name that isn't taken. */
  knownNames(): Promise<Set<string>>;
}

export interface OfflineStore {
  /**
   * Opens the store for the signed-in account, or with null at a launch that
   * found no session. Another account's data is wiped first. Null when
   * nobody is signed in.
   */
  start(owner: OfflineOwner | null): Promise<OfflineSession | null>;
  /** Signing out: everything goes, at once. */
  wipe(): Promise<void>;
  /**
   * The server ended the session: documents, pictures and the list go, and
   * only edits that were never sent stay, for this account's next sign-in.
   * Returns how many documents were held.
   */
  hold(): Promise<number>;
  session(): OfflineSession | null;
}

export function createOfflineStore(
  backend: OfflineBackend,
  { now = () => Date.now(), limits = OFFLINE_LIMITS }: { now?: () => number; limits?: OfflineLimits } = {}
): OfflineStore {
  let generation = 0;
  let current: OfflineSession | null = null;
  // One writer at a time, so two saves of one document never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  function open(owner: OfflineOwner, loaded: IndexEntry[]): OfflineSession {
    const mine = generation;
    const index = new Map<string, IndexEntry>(loaded.map((entry) => [entry.key, entry]));
    const listeners = new Set<() => void>();
    const alive = () => mine === generation;
    const changed = () => { for (const listener of [...listeners]) listener(); };

    const readDoc = async (key: string): Promise<StoredDoc | null> => {
      const value = await backend.read("docs", key);
      return value && typeof value === "object" ? (value as StoredDoc) : null;
    };

    /** Least recently opened first, never one with a pending edit, never `keep`. */
    function evictions(keep: string): WriteOp[] {
      const ops: WriteOp[] = [];
      let count = index.size;
      let bytes = 0;
      for (const entry of index.values()) bytes += entrySize(entry);
      if (count <= limits.maxDocs && bytes <= limits.maxBytes) return ops;
      const candidates = [...index.values()]
        .filter((entry) => !entry.pending && entry.key !== keep)
        .sort((a, b) => a.openedAt - b.openedAt);
      for (const entry of candidates) {
        if (count <= limits.maxDocs && bytes <= limits.maxBytes) break;
        index.delete(entry.key);
        count -= 1;
        bytes -= entrySize(entry);
        ops.push({ store: "index", key: entry.key, remove: true }, { store: "docs", key: entry.key, remove: true }, { store: "assets", removePrefix: `${entry.key}\n` });
      }
      return ops;
    }

    async function writeDoc(record: StoredDoc, patch: Partial<IndexEntry> = {}): Promise<void> {
      const before = index.get(record.key);
      const shown = record.pending?.content ?? record.doc.content;
      const entry: IndexEntry = {
        key: record.key,
        name: record.pending?.name ?? record.doc.name,
        textBytes: textBytes(record.doc.content) + (record.pending ? textBytes(shown) : 0),
        assets: before?.assets ?? {},
        openedAt: before?.openedAt ?? now(),
        savedAt: record.savedAt,
        pending: record.pending?.state ?? null,
        behind: !!record.pending && record.doc.version !== null && record.doc.version > record.pending.baseVersion,
        ...patch,
      };
      index.set(record.key, entry);
      const ops: WriteOp[] = [
        { store: "docs", key: record.key, value: record },
        { store: "index", key: record.key, value: entry },
        ...evictions(record.key),
      ];
      try {
        await backend.write(ops);
      } catch (error) {
        // The disk and the index must not disagree: read the index again.
        await reload();
        throw error;
      }
    }

    async function reload(): Promise<void> {
      const entries = (await backend.readAll("index").catch(() => [])) as IndexEntry[];
      index.clear();
      for (const entry of entries) if (entry && typeof entry.key === "string") index.set(entry.key, entry);
    }

    const session: OfflineSession = {
      owner,
      alive,
      entries: () => [...index.values()],
      entry: (key) => index.get(key) ?? null,
      unsent: () => { let total = 0; for (const entry of index.values()) if (entry.pending) total += 1; return total; },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },

      getDoc: (key) => (alive() ? readDoc(key) : Promise.resolve(null)),

      putDoc: (key, doc, { opened = false } = {}) => serial(async () => {
        if (!alive()) return false;
        const before = await readDoc(key);
        if (!before?.pending && textBytes(doc.content) > limits.maxDocBytes) {
          // Too large to keep. A smaller copy from before is out of date now.
          if (before) {
            index.delete(key);
            await backend.write([{ store: "index", key, remove: true }, { store: "docs", key, remove: true }, { store: "assets", removePrefix: `${key}\n` }]);
            changed();
          }
          return false;
        }
        const record: StoredDoc = { key, doc, links: before?.links ?? [], pending: before?.pending ?? null, savedAt: now() };
        await writeDoc(record, opened ? { openedAt: now() } : {});
        changed();
        return true;
      }),

      setLinks: (key, links) => serial(async () => {
        if (!alive()) return;
        const before = await readDoc(key);
        if (!before) return;
        await writeDoc({ ...before, links: links.slice(0, 500) });
      }),

      setPending: (key, pending, doc) => serial(async () => {
        if (!alive()) return;
        const before = await readDoc(key);
        const base = doc ?? before?.doc;
        if (!base) throw new Error("This document isn't kept on this phone.");
        await writeDoc({ key, doc: base, links: before?.links ?? [], pending, savedAt: now() });
        changed();
      }),

      removeDoc: (key, { evenIfPending = false } = {}) => serial(async () => {
        if (!alive()) return false;
        const entry = index.get(key);
        if (!entry) return true;
        if (entry.pending && !evenIfPending) return false;
        index.delete(key);
        await backend.write([{ store: "index", key, remove: true }, { store: "docs", key, remove: true }, { store: "assets", removePrefix: `${key}\n` }]);
        changed();
        return true;
      }),

      async getAsset(key, ref) {
        if (!alive() || !index.get(key)?.assets[ref]) return null;
        const value = (await backend.read("assets", assetKey(key, ref))) as StoredAsset | undefined;
        return value && value.bytes instanceof ArrayBuffer && typeof value.type === "string" ? value : null;
      },

      putAsset: (key, ref, asset) => serial(async () => {
        if (!alive()) return false;
        const entry = index.get(key);
        // Pictures are kept only for a document that is kept.
        if (!entry || ref.length > 2048) return false;
        const size = asset.bytes.byteLength;
        const others = Object.entries(entry.assets).reduce((sum, [name, bytes]) => (name === ref ? sum : sum + bytes), 0);
        if (size > limits.maxAssetBytes || others + size > limits.maxAssetBytesPerDoc) return false;
        const next: IndexEntry = { ...entry, assets: { ...entry.assets, [ref]: size } };
        index.set(key, next);
        try {
          await backend.write([
            { store: "assets", key: assetKey(key, ref), value: asset },
            { store: "index", key, value: next },
            ...evictions(key),
          ]);
        } catch (error) {
          await reload();
          throw error;
        }
        return true;
      }),

      async getList() {
        if (!alive()) return null;
        const value = (await backend.read("meta", LIST_KEY)) as StoredList | undefined;
        return value && Array.isArray(value.docs) && Array.isArray(value.platform) ? value : null;
      },

      putList: ({ docs, platform }) => serial(async () => {
        if (!alive()) return;
        const before = (await backend.read("meta", LIST_KEY)) as StoredList | undefined;
        const next: StoredList = {
          docs: (docs ?? before?.docs ?? []).slice(0, limits.maxListDocs),
          platform: (platform ?? before?.platform ?? []).slice(0, limits.maxListDocs),
          savedAt: now(),
        };
        await backend.write([{ store: "meta", key: LIST_KEY, value: next }]);
      }),

      async knownNames() {
        const names = new Set<string>();
        for (const entry of index.values()) names.add(entry.name);
        const list = await session.getList().catch(() => null);
        for (const doc of [...(list?.docs ?? []), ...(list?.platform ?? [])]) names.add(doc.name);
        return names;
      },
    };
    return session;
  }

  async function wipe(): Promise<void> {
    // Dead first, in this same tick: an answer still on its way from the
    // network must find nowhere to be written.
    generation += 1;
    current = null;
    await serial(() => backend.clear());
  }

  return {
    session: () => current,
    wipe,

    start: (owner) => serial(async () => {
      generation += 1;
      current = null;
      const stored = (await backend.read("meta", OWNER_KEY).catch(() => undefined)) as OwnerRecord | undefined;
      if (!owner) {
        // Nobody is signed in. Held edits wait for their account; anything
        // else has no owner and goes.
        if (!stored?.held) await backend.clear();
        return null;
      }
      if (!stored || !sameOwner(stored, owner)) await backend.clear();
      await backend.write([{ store: "meta", key: OWNER_KEY, value: { ...owner, held: false } satisfies OwnerRecord }]);
      const entries = ((await backend.readAll("index")) as IndexEntry[]).filter((entry) => entry && typeof entry.key === "string");
      current = open(owner, entries);
      return current;
    }),

    async hold() {
      const session = current;
      generation += 1;
      current = null;
      if (!session) { await serial(() => backend.clear()); return 0; }
      return serial(async () => {
        const ops: WriteOp[] = [{ store: "meta", key: LIST_KEY, remove: true }];
        let kept = 0;
        for (const entry of session.entries()) {
          ops.push({ store: "assets", removePrefix: `${entry.key}\n` });
          if (entry.pending) {
            kept += 1;
            ops.push({ store: "index", key: entry.key, value: { ...entry, assets: {} } satisfies IndexEntry });
          } else {
            ops.push({ store: "index", key: entry.key, remove: true }, { store: "docs", key: entry.key, remove: true });
          }
        }
        if (kept === 0) { await backend.clear(); return 0; }
        ops.push({ store: "meta", key: OWNER_KEY, value: { ...session.owner, held: true } satisfies OwnerRecord });
        try {
          await backend.write(ops);
        } catch {
          // If what to keep can't be written, keeping nothing is the safe side.
          await backend.clear();
          return 0;
        }
        return kept;
      });
    },
  };
}

/** For tests, and for a web view with no IndexedDB: nothing outlives the page. */
export function memoryBackend(): OfflineBackend & { size(): number } {
  const stores = new Map<StoreName, Map<string, unknown>>(STORES.map((name) => [name, new Map()]));
  return {
    async read(store, key) { return stores.get(store)!.get(key); },
    async readAll(store) { return [...stores.get(store)!.values()]; },
    async write(ops) {
      for (const op of ops) {
        const map = stores.get(op.store)!;
        if ("removePrefix" in op) { for (const key of [...map.keys()]) if (key.startsWith(op.removePrefix)) map.delete(key); }
        else if ("remove" in op) map.delete(op.key);
        else map.set(op.key, structuredClone(op.value));
      }
    },
    async clear() { for (const map of stores.values()) map.clear(); },
    size() { let total = 0; for (const map of stores.values()) total += map.size; return total; },
  };
}

export const OFFLINE_DB_NAME = "markie-offline-v1";
const OPEN_TIMEOUT_MS = 5_000;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("The phone's storage refused the request."));
  });
}

/**
 * IndexedDB in the app's web view. Each write is one transaction over every
 * store it touches, so a document and its index entry change together.
 */
export function indexedDbBackend(factory: IDBFactory = indexedDB, name = OFFLINE_DB_NAME): OfflineBackend {
  let opening: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        for (const store of STORES) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
      };
      req.onsuccess = () => {
        settled = true;
        const db = req.result;
        // Another tab or a deleted database: open again next time.
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      req.onerror = () => { settled = true; opening = null; reject(req.error ?? new Error("The phone's storage couldn't be opened.")); };
      req.onblocked = () => { opening = null; reject(new Error("The phone's storage is busy.")); };
      // A database that never answers must not hold up the launch: the app
      // then runs with no store, as it did before there was one.
      setTimeout(() => {
        if (settled) return;
        opening = null;
        reject(new Error("The phone's storage didn't answer."));
      }, OPEN_TIMEOUT_MS);
    });
    return opening;
  };
  const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("The phone's storage refused the write."));
    tx.onerror = () => reject(tx.error ?? new Error("The phone's storage refused the write."));
  });
  return {
    async read(store, key) {
      const db = await database();
      return request(db.transaction(store, "readonly").objectStore(store).get(key));
    },
    async readAll(store) {
      const db = await database();
      return request(db.transaction(store, "readonly").objectStore(store).getAll());
    },
    async write(ops) {
      if (!ops.length) return;
      const db = await database();
      const names = [...new Set(ops.map((op) => op.store))];
      const tx = db.transaction(names, "readwrite");
      const finished = done(tx);
      for (const op of ops) {
        const store = tx.objectStore(op.store);
        if ("removePrefix" in op) store.delete(IDBKeyRange.bound(op.removePrefix, `${op.removePrefix}￿`));
        else if ("remove" in op) store.delete(op.key);
        else store.put(op.value, op.key);
      }
      await finished;
    },
    async clear() {
      try {
        const db = await database();
        const tx = db.transaction([...STORES], "readwrite");
        const finished = done(tx);
        for (const store of STORES) tx.objectStore(store).clear();
        await finished;
      } catch {
        // A database that can't be emptied is deleted whole.
        const db = await opening?.catch(() => null);
        db?.close();
        opening = null;
        await request(factory.deleteDatabase(name));
      }
    },
  };
}

/** The store for this platform: IndexedDB where the web view has it, memory otherwise. */
export function platformOfflineBackend(): OfflineBackend {
  try {
    if (typeof indexedDB !== "undefined" && indexedDB) return indexedDbBackend();
  } catch {
    // A web view that throws on the mere mention keeps nothing.
  }
  return memoryBackend();
}
