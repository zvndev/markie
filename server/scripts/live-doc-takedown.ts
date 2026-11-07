// Take a hosted Live Doc down, or put it back (design, "Security model" 6).
//
// Run where DB_PATH points at the server's database, from server/:
//
//   node --experimental-strip-types scripts/live-doc-takedown.ts <address-or-doc-id> "<reason>"
//   node --experimental-strip-types scripts/live-doc-takedown.ts --restore <address-or-doc-id>
//   node --experimental-strip-types scripts/live-doc-takedown.ts --list
//
// <address-or-doc-id> is a full Live Doc address (https://<label>.<domain>/),
// a bare label, or a document id. A taken-down Live Doc is hosted at no level:
// its private and public addresses answer "taken down", its open tabs close
// within the server's recheck interval, and its passes and cookies are gone.
// The document itself is untouched; its owner still has it in Markie.
//
// This talks to the tables live-docs-store.ts creates, with plain SQL, so it
// does not load the server's auth, mail or live-editing modules.
import { openDatabase } from "../src/db.ts";

const LABEL = /^[a-z2-7]{16}$/;
const args = process.argv.slice(2);
const db = openDatabase();

function docIdFor(input: string): string | null {
  let value = input.trim();
  try {
    const url = new URL(value);
    value = url.hostname.split(".")[0] ?? "";
  } catch {
    // not a URL: a label or a document id
  }
  if (LABEL.test(value)) {
    const row = (db.prepare("SELECT doc_id FROM live_doc_addresses WHERE label = ?").get(value)
      ?? db.prepare("SELECT doc_id FROM live_doc_public_addresses WHERE label = ?").get(value)) as { doc_id: string } | undefined;
    if (row) return row.doc_id;
  }
  const doc = db.prepare("SELECT id FROM docs WHERE id = ?").get(value) as { id: string } | undefined;
  return doc?.id ?? null;
}

function usage(): never {
  console.error('Use: live-doc-takedown.ts <address-or-doc-id> "<reason>" | --restore <address-or-doc-id> | --list');
  process.exit(2);
}

if (args[0] === "--list") {
  const rows = db.prepare("SELECT doc_id, reason, created_at FROM live_doc_takedowns ORDER BY created_at DESC").all() as Array<{ doc_id: string; reason: string; created_at: number }>;
  for (const row of rows) console.log(`${new Date(row.created_at).toISOString()}  ${row.doc_id}  ${row.reason}`);
  if (rows.length === 0) console.log("No Live Docs are taken down.");
} else if (args[0] === "--restore") {
  if (!args[1]) usage();
  const docId = docIdFor(args[1]);
  if (!docId) {
    console.error(`No Live Doc or document matches ${args[1]}.`);
    process.exit(1);
  }
  const restored = db.prepare("DELETE FROM live_doc_takedowns WHERE doc_id = ?").run(docId).changes > 0;
  console.log(restored ? `Restored ${docId}.` : `${docId} was not taken down.`);
} else {
  const [target, reason] = args;
  if (!target || !reason?.trim()) usage();
  const docId = docIdFor(target);
  if (!docId) {
    console.error(`No Live Doc or document matches ${target}.`);
    process.exit(1);
  }
  db.transaction(() => {
    db.prepare(
      "INSERT INTO live_doc_takedowns (doc_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at"
    ).run(docId, reason.trim().slice(0, 500), Date.now());
    db.prepare("DELETE FROM live_doc_sessions WHERE doc_id = ?").run(docId);
    db.prepare("DELETE FROM live_doc_tickets WHERE doc_id = ?").run(docId);
  })();
  console.log(`Took down ${docId}. Its open tabs close within a few seconds.`);
}
