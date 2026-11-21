// Builds fresh, test-only fixture data with the repo's own TypeScript.
// Nothing here comes from a real profile: the passphrase, tokens and documents
// are made up on the spot and are only ever used by the Rust tests.
//
//   node --import ../../../../scripts/ts-run/register.mjs gen.ts <out.json>
import { writeFileSync } from "node:fs";
import { VaultRepository, type VaultDeviceKeeper } from "../../../../../src/lib/vault/repository";
import type { StoredVault, VaultStorage } from "../../../../../src/lib/vault/storage";
import { createMemoryLibraryStorage } from "../../../../../src/lib/document-library/memory";
import { createDocumentLibrary } from "../../../../../src/lib/document-library/repository";
import { DEFAULT_LIBRARY_LIMITS } from "../../../../../src/lib/document-library/model";
import { normalizeThemeStore } from "../../../../../src/lib/theme";

export const FIXTURE_PASSPHRASE = "fixture-only passphrase, never real";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

class MemoryVaultStorage implements VaultStorage {
  value: StoredVault | null = null;
  async load() { return this.value; }
  async commit(_expected: number | null, next: StoredVault) { this.value = structuredClone(next); }
}

let deviceSecret: Uint8Array | null = null;
const keeper: VaultDeviceKeeper = {
  async release() { return deviceSecret ? { ok: true, secret: new Uint8Array(deviceSecret) } : { ok: false, reason: "missing" }; },
  async store(_id, secret) { deviceSecret = new Uint8Array(secret); return { ok: true }; },
  async remove() { deviceSecret = null; },
};

const text = (value: string) => new TextEncoder().encode(value);
// Big enough that Chromium wraps the IndexedDB value in a blob file (over 64 KiB).
const bigBody = Array.from({ length: 2000 }, (_, i) => `Line ${i}: fixture text for the large vault document.\n`).join("");

const storage = new MemoryVaultStorage();
const vault = new VaultRepository(storage);
await vault.create(FIXTURE_PASSPHRASE);
const notes = await vault.save(null, text("# Fixture note\n\nNot a real secret.\n"), { name: "Fixture note.md", mediaType: "text/markdown" });
const env = await vault.save(null, text("# fixture\nAPI_KEY=fixture-not-a-key\nexport QUOTED=\"two\\nlines\" # c\n"), { name: "fixture.env", mediaType: "text/plain" });
await vault.save(null, text("Ünïcödé name, emoji 🔐"), { name: "Ünïcödé 🔐 \"quoted\".txt", mediaType: "text/plain" });
await vault.enrollDevice(FIXTURE_PASSPHRASE, keeper);
const phase1 = structuredClone(storage.value!);
const backup = await vault.backup();

// Phase 2 overwrites the snapshot in a later Chromium session: one document
// removed, one edited, one large one added. The reader must return this one.
await vault.remove(notes);
await vault.save(env, text("API_KEY=fixture-edited\n"), { name: "fixture.env", mediaType: "text/plain" });
await vault.save(null, text(bigBody), { name: "Large fixture.md", mediaType: "text/markdown" });
const phase2 = structuredClone(storage.value!);

// Decrypted expectations for both snapshots, so Rust checks real plaintext.
async function expected(stored: StoredVault) {
  const check = new VaultRepository(new MemoryVaultStorage());
  (check.storage as MemoryVaultStorage).value = stored;
  await check.unlock(FIXTURE_PASSPHRASE);
  const out = [];
  for (const entry of await check.list()) {
    const doc = await check.read(entry.id);
    out.push({ id: entry.id, name: doc.metadata.name, mediaType: doc.metadata.mediaType, bytes: b64(doc.bytes) });
  }
  return out;
}

// Document library rows, made by the library's own repository.
let clock = 1_700_000_000_000;
const libraryStorage = createMemoryLibraryStorage();
const library = createDocumentLibrary(libraryStorage, { now: () => (clock += 1000), createId: (() => { let n = 0; return () => `fixture-doc-${++n}`; })() });
const first = await library.put({ name: "Recovered.md", format: "markdown", bytes: text("# Recovered\n"), tags: ["fixture"], collection: null }, null);
if (!first.ok) throw new Error(first.error.message);
const second = await library.put({ id: first.value.id, name: "Recovered.md", format: "markdown", bytes: text("# Recovered, edited\n"), tags: ["fixture"], collection: "Inbox", extractedText: "Recovered, edited" }, first.value.revision);
if (!second.ok) throw new Error(second.error.message);
const word = await library.put({ name: "Binary.docx", format: "docx", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255, 128, 7]) }, null);
if (!word.ok) throw new Error(word.error.message);
const marked = await library.markExported(word.value.id, word.value.revision);
if (!marked.ok) throw new Error(marked.error.message);
const rows = await libraryStorage.execute("readonly", DEFAULT_LIBRARY_LIMITS, (snapshot) => ({ value: snapshot }));
const encodeRecord = (record: Record<string, unknown>) => ({ ...record, bytes: b64(record.bytes as Uint8Array) });
const libraryRows = {
  documents: rows.documents.map((row) => encodeRecord(row as Record<string, unknown>)),
  recovery: rows.recovery.map((row) => {
    const r = row as Record<string, unknown>;
    return { ...r, record: encodeRecord(r.record as Record<string, unknown>) };
  }),
};

const themes = normalizeThemeStore({
  activeId: "fixture-custom",
  custom: [{ id: "fixture-custom", name: "Fixture custom", tone: "dark", templateId: "markie", tokens: { bg: "#101010", fg: "#f0f0f0" } } as never],
  templateId: "markie",
  typography: { fontSize: 17 } as never,
});

// Fixed, obviously fake values. Phase 2 changes some of them.
const localStorage1: Record<string, string> = {
  "markie.token.v1": "fixture-token-primary",
  "markie.auth.principal.v1": JSON.stringify({ token: "fixture-token-primary", serverURL: "https://api.markiedocs.com", userId: "fixture-user-1" }),
  "markie.token.v1@https://docs.example.test": "fixture-token-selfhosted",
  "markie.auth.principal.v1@https://docs.example.test": JSON.stringify({ token: "fixture-token-selfhosted", serverURL: "https://docs.example.test", userId: "fixture-user-2" }),
  "markie.server.v1": "https://api.markiedocs.com",
  "markie.themes.v1": JSON.stringify(themes),
  "markie.colormode.v1": "light",
  "markie.sync.v1": "1",
  "markie.libtab.v4": "recent",
  "markie.leftpanel.width.v1": "288",
  "markie.browse.sort.v1": "modified",
  "markie.seen.v1": "1",
  "markie.vault.touchIdOffer": "dismissed",
  "markie.richoverride.v1:/Users/fixture/Notes/Ünïcödé.md": "1",
  "markie.richoverride.v1:/Users/fixture/🔐 秘密.md": "1",
  "markie.documents.zoom.v1": "1.25",
  "unrelated.key": "ignored by the migration",
};
const localStorage2 = { set: { "markie.colormode.v1": "dark", "markie.token.v1": "fixture-token-primary-rotated" }, remove: ["markie.seen.v1"] };

const out = {
  passphrase: FIXTURE_PASSPHRASE,
  deviceSecret: b64(deviceSecret!),
  phase1, phase2, backup,
  expected1: await expected(phase1),
  expected2: await expected(phase2),
  libraryRows,
  localStorage1, localStorage2,
};
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(`wrote ${process.argv[2]}`);
