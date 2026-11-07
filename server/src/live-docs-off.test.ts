// With LIVE_DOCS_DOMAIN unset the feature does not exist: no address is
// handed out, no pass route answers, and a host that would be a Live Doc's is
// just another request to the app.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-live-docs-off-")), "t.db");
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8787";
process.env.BETTER_AUTH_SECRET = "markie-live-docs-off-test-secret-32-plus";
process.env.MARKIE_SITE_URL = "https://markie.test";
delete process.env.LIVE_DOCS_DOMAIN;
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app, liveDocs } = await import("./index.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);
after(() => db.close());

test("no Live Docs object, no routes, no addresses", async () => {
  assert.equal(liveDocs, null);
  const owner = await signUpVerified(app, { name: "Owner", email: `live-off-${Date.now()}@example.com` });
  const content = ":state n = 1\n\n{ n }\n";
  const put = await app.request(`/api/docs/off-doc`, {
    method: "PUT",
    headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Off.wd", content, hash: createHash("sha256").update(content).digest("hex"), baseVersion: 0 }),
  });
  assert.equal(put.status, 200);
  const address = await app.request("/api/docs/off-doc/live-doc", { headers: { authorization: `Bearer ${owner.token}` } });
  assert.equal(address.status, 404);
  assert.deepEqual(await address.json(), { error: "not found" }, "the generic 404: the route does not exist");
  assert.equal((await app.request("/live-docs/pass/abcdefghijklmnop")).status, 404);
  const addresses = db.prepare("SELECT COUNT(*) AS n FROM live_doc_addresses").get() as { n: number };
  assert.equal(addresses.n, 0, "no address was minted");
});

test("a Live Doc-shaped host is just the app", async () => {
  const res = await app.request("http://abcdefghijklmnop.markie.live/health", { headers: { host: "abcdefghijklmnop.markie.live" } });
  assert.equal(res.status, 200);
});
