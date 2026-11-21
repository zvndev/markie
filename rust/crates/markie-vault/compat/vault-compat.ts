// Proves the Rust vault and the Electron vault read each other's data, using
// the repo's own TypeScript (src/lib/vault) and this crate's example binary.
// Every passphrase, key and document here is made up on the spot.
//
//   cd rust && cargo build -q -p markie-vault --example vault-compat
//   node --import ./scripts/ts-run/register.mjs crates/markie-vault/compat/vault-compat.ts
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual, strictEqual } from "node:assert";
import { VaultRepository, type VaultDeviceKeeper } from "../../../../src/lib/vault/repository";
import { validateStoredVault, VaultStorageError, type StoredVault, type VaultStorage } from "../../../../src/lib/vault/storage";
import { parseVaultBackup, VaultBackupError } from "../../../../src/lib/vault/backup";
import { VaultError, metadataBytes, parseVaultDeviceSlot, parseVaultDocument, parseVaultHeader } from "../../../../src/lib/vault/envelope";
import { addDotenvEntry, duplicateDotenvKeys, parseDotenv, removeDotenvLine, serializeDotenv, updateDotenvEntry } from "../../../../src/lib/vault/dotenv";
import { estimatePassphraseBits, suggestPassphrase } from "../../../../src/lib/vault/passphrase";

const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(here, "../../../target/debug/examples/vault-compat");
const rust = (request: object) => JSON.parse(execFileSync(binary, { input: JSON.stringify(request), maxBuffer: 256 * 1024 * 1024 }).toString());
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const PASSPHRASE = "compat check passphrase, made up";
let checks = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  deepStrictEqual(actual, expected, label);
  checks++;
};

class Memory implements VaultStorage {
  constructor(public value: StoredVault | null = null) {}
  async load() { return this.value; }
  async commit(_e: number | null, next: StoredVault) { this.value = structuredClone(next); }
}
const keeperFor = (secret: Uint8Array | null): VaultDeviceKeeper & { secret: Uint8Array | null } => ({
  secret,
  async release() { return this.secret ? { ok: true, secret: new Uint8Array(this.secret) } : { ok: false, reason: "missing" }; },
  async store(_id, s) { this.secret = new Uint8Array(s); return { ok: true }; },
  async remove() { this.secret = null; },
});

async function tsDocuments(repo: VaultRepository) {
  const out = [];
  for (const entry of await repo.list()) {
    const doc = await repo.read(entry.id);
    out.push({ id: entry.id, name: doc.metadata.name, mediaType: doc.metadata.mediaType, bytes: b64(doc.bytes) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const byName = (docs: { name: string }[]) => [...docs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const text = (s: string) => new TextEncoder().encode(s);
const docs = [
  { name: "Notes.md", mediaType: "text/markdown", bytes: text("# Hello\n") },
  { name: "prod.env", mediaType: "text/plain", bytes: text("A=1\nB=\"two\"\n") },
  { name: "Ünïcödé 🔐 \"q\" \\ \u0001\t\n.txt", mediaType: "text/plain", bytes: text("x") },
  { name: "empty", mediaType: "application/octet-stream", bytes: new Uint8Array(0) },
  { name: "binary.bin", mediaType: "application/x.custom+json", bytes: Uint8Array.from({ length: 70_000 }, (_, i) => (i * 131) & 255) },
];

// 1. TypeScript writes, Rust reads: passphrase, device slot, and backup restore.
{
  const storage = new Memory();
  const repo = new VaultRepository(storage);
  await repo.create(PASSPHRASE);
  for (const doc of docs) await repo.save(null, doc.bytes, { name: doc.name, mediaType: doc.mediaType });
  const keeper = keeperFor(null);
  await repo.enrollDevice(PASSPHRASE, keeper);
  const backup = await repo.backup();
  const expected = await tsDocuments(repo);
  const answer = rust({ command: "open", stored: storage.value, passphrase: PASSPHRASE, deviceSecret: b64(keeper.secret!), backup });
  check("Rust opens a TypeScript vault with the passphrase", byName(answer.passphrase), expected);
  check("Rust opens a TypeScript vault with the device secret", byName(answer.device), expected);
  check("Rust restores a TypeScript backup", byName(answer.backup), expected);
  const wrong = rust({ command: "open", stored: storage.value, passphrase: "not the passphrase at all" });
  check("Rust refuses the wrong passphrase", wrong.error, "vault:AuthenticationFailed");
}

// 2. Rust writes, TypeScript reads.
{
  const made = rust({ command: "make", passphrase: PASSPHRASE, docs: docs.map((d) => ({ ...d, bytes: b64(d.bytes) })) });
  const stored = validateStoredVault(made.stored);
  const repo = new VaultRepository(new Memory(stored));
  await repo.unlock(PASSPHRASE);
  const got = await tsDocuments(repo);
  check("TypeScript opens a Rust vault with the passphrase", got.map((d) => ({ name: d.name, mediaType: d.mediaType, bytes: d.bytes })),
    byName(docs.map((d) => ({ name: d.name, mediaType: d.mediaType, bytes: b64(d.bytes) }))));
  const device = new VaultRepository(new Memory(stored));
  await device.unlockWithDevice(keeperFor(Buffer.from(made.deviceSecret, "base64")));
  check("TypeScript opens a Rust vault with the device secret", await tsDocuments(device), got);
  parseVaultBackup(made.backup);
  const restored = new VaultRepository(new Memory());
  await restored.restore(made.backup, PASSPHRASE);
  check("TypeScript restores a Rust backup", await tsDocuments(restored), got);
  // The Rust repository's JSON is the same structure storage.ts validates.
  strictEqual(JSON.stringify(stored), made.storedJson, "Rust storage JSON equals JSON.stringify of the validated snapshot");
  checks++;
}

// 3. The same accept or reject decision on malformed envelopes.
const code = (error: unknown) => {
  if (error instanceof VaultError) return `vault:${error.code.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())}`;
  if (error instanceof VaultStorageError) return `storage:${error.code.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())}`;
  if (error instanceof VaultBackupError) return "backup";
  return `other:${(error as Error).message}`;
};
const tsParse = (kind: string, value: string) => {
  try {
    if (kind === "header") parseVaultHeader(value);
    else if (kind === "document") parseVaultDocument(value);
    else if (kind === "slot") parseVaultDeviceSlot(value);
    else if (kind === "backup") parseVaultBackup(value);
    else validateStoredVault(JSON.parse(value));
    return "ok";
  } catch (error) { return code(error); }
};
{
  const storage = new Memory();
  const repo = new VaultRepository(storage);
  await repo.create(PASSPHRASE);
  await repo.save(null, text("x"), { name: "a", mediaType: "text/plain" });
  await repo.enrollDevice(PASSPHRASE, keeperFor(null));
  const { header, records, deviceSlot } = storage.value!;
  const envelope = records[0].envelope;
  const backup = await repo.backup();
  const variants = (value: string) => [
    value, ` ${value}`, `${value}\n`, value.replace(/"version":1/, '"version":1.0'), value.replace(/"version":1/, '"version":"1"'),
    value.replace(/"kind":"([^"]+)"/, '"kind":"x$1"'), value.replace(/}$/, ',"extra":1}'), value.replace(/"kind"/, '"\\u006bind"'),
    value.replace(/("iv":")([^"]+)"/, '$1$2="'), value.replace(/("iv":")([^"]+)(.)"/, (_, a, b) => `${a}${b}_"`),
    value.replace(/("vaultId":")([^"]+)"/, '$1$2A"'), value.replace(/600000/, "6e5"), value.replace(/600000/, "599999"),
    value.replace(/600000/, "1000000"), value.replace(/600000/, "1000001"), value.replace(/"salt"/, '"Salt"'),
    value.slice(0, -1), value.replace(/^\{"kind":"([^"]+)","version":1/, '{"version":1,"kind":"$1"'),
  ];
  const items = [
    ...variants(header).map((t) => ({ kind: "header", text: t })),
    ...variants(envelope).map((t) => ({ kind: "document", text: t })),
    ...variants(deviceSlot!).map((t) => ({ kind: "slot", text: t })),
    ...variants(backup).map((t) => ({ kind: "backup", text: t })),
    { kind: "document", text: envelope.replace(/("ciphertext":")[^"]+/, `$1${"A".repeat(Math.ceil((8 * 1024 * 1024 + 4096 + 21) * 4 / 3))}`) },
    { kind: "stored", text: JSON.stringify(storage.value) },
    { kind: "stored", text: JSON.stringify({ ...storage.value, revision: 0 }) },
    { kind: "stored", text: JSON.stringify({ ...storage.value, revision: 2 ** 53 }) },
    { kind: "stored", text: JSON.stringify({ ...storage.value, extra: 1 }) },
    { kind: "stored", text: JSON.stringify({ ...storage.value, records: [...records, ...records] }) },
    { kind: "stored", text: JSON.stringify({ ...storage.value, records: [{ ...records[0], id: "AAAAAAAAAAAAAAAAAAAAAA" }] }) },
    { kind: "stored", text: JSON.stringify({ ...storage.value, deviceSlot: 5 }) },
  ];
  const answer = rust({ command: "parse", items });
  check("malformed envelopes: same decisions", answer, items.map((i) => tsParse(i.kind, i.text)));
  if (process.env.VERBOSE) console.log(JSON.stringify(answer));
}

// 4. Metadata JSON escaping, dotenv parsing and edits, passphrase strength.
{
  const items = [
    { name: "plain.md", mediaType: "text/markdown" }, { name: "\u0000\u0007\b\f\n\r\t\u001f\u007f  ", mediaType: "a/b" },
    { name: "\"\\/<>&'", mediaType: "a/b" }, { name: "é".repeat(1024), mediaType: "a/b" }, { name: "x".repeat(1025), mediaType: "a/b" },
    { name: "🔐".repeat(512), mediaType: "a/b" }, { name: "x", mediaType: "text" }, { name: "x", mediaType: "text/plain; charset=utf-8" },
    { name: "x", mediaType: "a".repeat(254) + "/b" }, { name: "x".repeat(1000), mediaType: "a/" + "b".repeat(253) },
  ];
  const ts = items.map((m) => { try { return b64(metadataBytes(m)); } catch (error) { return code(error); } });
  check("metadata bytes", rust({ command: "metadata", items }), ts);

  const texts = [
    "", "\n", "A=1", "A=1\n", "A=1\r\nB=2\rC=3\n", "# comment\n\n  # indented\nexport  KEY = value # note\n",
    "URL=http://x/#frag\nTAB=a\t#c\nHASH= #only\n", "Q=\"a\\nb\\\"c\\\\d\\x\"\nS='it''s'\nB=`tick`\n",
    "M=\"line one\nline two\"\nN=after\n", "OPEN=\"never closed\nX=1\n", "bad line\n=novalue\n1KEY=x\nkey.with.dots=1\n",
    "A=\"x\" trailing\nB=\"x\"  # ok\nC=\"x\"#ok\n", "DUP=1\nDUP=2\nOTHER=3\nDUP=4", "export\nexport=1\nexportX=1\n",
    "A=\" \"\nB=a b\nC=ü ñ 🔐\n", "K=\"multi\r\nline\r\n\"\r\nL=1\r\n", "E=\nF= \nG=  # c\n",
  ];
  const tsDotenv = texts.map((t) => {
    const doc = parseDotenv(t);
    let edited = doc;
    for (const line of doc.lines) if (line.kind === "entry") edited = updateDotenvEntry(edited, line.id, { value: `${line.value} edited #x` });
    edited = addDotenvEntry(edited, "NEW_KEY", "a b");
    if (doc.lines[0]) edited = removeDotenvLine(edited, doc.lines[0].id);
    return {
      lines: doc.lines.map(({ id: _id, ...rest }) => rest),
      newline: doc.newline, serialized: serializeDotenv(doc), edited: serializeDotenv(edited),
      duplicates: [...duplicateDotenvKeys(doc)].sort(),
    };
  });
  const rustDotenv = rust({ command: "dotenv", texts });
  const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)])) : v;
  check("dotenv parse, serialize and edits", sortKeys(rustDotenv), sortKeys(tsDotenv));

  const passphrases = ["", "short", "correct horse battery staple", "Correct-Horse-Battery", "aaaaaaaaaaaaaaaa", "abcdefghijklmnop",
    "Tr0ub4dor&3", "ÜberSicher Passwort 2026!", "🔐🔐🔐🔐 emoji only", "日本語のパスフレーズです", "--leading-and-trailing--",
    ...Array.from({ length: 20 }, () => suggestPassphrase())];
  check("passphrase strength", rust({ command: "strength", passphrases }), passphrases.map(estimatePassphraseBits));
}

console.log(`vault compatibility: ${checks} checks passed`);
