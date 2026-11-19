import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createProviderAccountLabels, idTokenEmail } from "./provider-account-labels.ts";

const token = (claims: unknown) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test("the address is read from the ID token's email claim, as the provider gives it", () => {
  assert.equal(idTokenEmail(token({ email: "Kirby@Example.org" })), "Kirby@Example.org");
  assert.equal(idTokenEmail(token({ email: "x7k2p9qz4m@privaterelay.appleid.com", is_private_email: "true" })), "x7k2p9qz4m@privaterelay.appleid.com");
  for (const value of [undefined, null, 42, "", "not.a.jwt.at.all", "a.b", token({}), token({ email: 7 }), token({ email: "no-at-sign" }), token({ email: "two words@example.org" }), token({ email: "line\u0007@example.org" }), token({ email: `${"a".repeat(250)}@example.org` }), `x.${"%%%"}.y`]) {
    assert.equal(idTokenEmail(value), null, String(value));
  }
});

function setup() {
  const db = new Database(":memory:");
  const labels = createProviderAccountLabels(db);
  db.exec("CREATE TABLE account(id TEXT PRIMARY KEY,userId TEXT,providerId TEXT)");
  db.exec("INSERT INTO account VALUES('g1','u1','google'),('a1','u1','apple'),('old','u1','google'),('c1','u1','credential')");
  return { db, labels };
}

test("a Google or Apple row is labeled once at creation, and only while its row still belongs to the same user", () => {
  const { db, labels } = setup();
  try {
    labels.record({ id: "g1", userId: "u1", providerId: "google", idToken: token({ email: "first@gmail.example" }) });
    labels.record({ id: "a1", userId: "u1", providerId: "apple", idToken: token({ email: "relay@privaterelay.appleid.com" }) });
    // A second record for the same row changes nothing: the label is the address it was created with.
    labels.record({ id: "g1", userId: "u1", providerId: "google", idToken: token({ email: "later@gmail.example" }) });
    // Password rows and rows without a token get no label.
    labels.record({ id: "c1", userId: "u1", providerId: "credential", idToken: token({ email: "pw@example.org" }) });
    labels.record({ id: "old", userId: "u1", providerId: "google" });
    const rows = [{ id: "c1", providerId: "credential" }, { id: "g1", providerId: "google" }, { id: "a1", providerId: "apple" }, { id: "old", providerId: "google" }];
    assert.deepEqual(labels.label(rows), [
      { id: "c1", providerId: "credential" },
      { id: "g1", providerId: "google", email: "first@gmail.example" },
      { id: "a1", providerId: "apple", email: "relay@privaterelay.appleid.com" },
      { id: "old", providerId: "google" },
    ]);
    // A label whose account row moved to another user, or is gone, is never shown.
    db.prepare("UPDATE account SET userId='u2' WHERE id='g1'").run();
    assert.deepEqual(labels.label([{ id: "g1", providerId: "google" }]), [{ id: "g1", providerId: "google" }]);
    labels.remove("a1");
    assert.equal(db.prepare("SELECT 1 FROM account_provider_labels WHERE account_id='a1'").get(), undefined);
  } finally { db.close(); }
});

test("recording is display only: a failure is logged and never reaches sign-in", () => {
  const { db, labels } = setup();
  db.close();
  const error = console.error; let logged = 0; console.error = () => { logged++; };
  try { assert.doesNotThrow(() => labels.record({ id: "g1", userId: "u1", providerId: "google", idToken: token({ email: "x@example.org" }) })); }
  finally { console.error = error; }
  assert.equal(logged, 1);
});
