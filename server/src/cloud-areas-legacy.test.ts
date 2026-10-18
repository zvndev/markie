import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified, type TestUser } from "./test-users.ts";
import { createCloudAreasApi } from "./cloud-areas.ts";

const directory = mkdtempSync(join(tmpdir(), "markie-area-legacy-"));
process.env.DB_PATH = join(directory, "test.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "cloud-area-fixture-auth-secret-32-characters";
process.env.MARKIE_SITE_URL = "https://markie.test";
const { auth } = await import("./auth.ts"), { runMigrations } = await getMigrations(auth.options);
await runMigrations();
const { docs, configureDocsCloudAreas } = await import("./docs.ts");
const { shares, accessLevel, canReadLevel } = await import("./shares.ts");
const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs); app.route("/api/docs", shares);
app.route("/api/account", createCloudAreasApi({ store: configureDocsCloudAreas(true)!, authenticate: async (req) => (await auth.api.getSession({ headers: req.headers }))?.user ?? null, canAccessDocument: (uid, kind, docId) => kind === "markdown" && canReadLevel(accessLevel(docId, uid)) }));
configureDocsCloudAreas(false);
let owner: TestUser, viewer: TestUser;
before(async () => { owner = await signUpVerified(app, { name: "Area owner", email: "area-owner@example.test" }); viewer = await signUpVerified(app, { name: "Area viewer", email: "area-viewer@example.test" }); });
async function request(path: string, user: TestUser, method = "GET", body?: unknown) {
  return app.request(path, { method, headers: { Authorization: `Bearer ${user.token}`, Origin: "http://localhost:3000", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const payload = (content = "# Note", baseVersion = 0, areaId?: string) => ({ name: "note.md", content, hash: createHash("sha256").update(content).digest("hex"), baseVersion, ...(areaId === undefined ? {} : { areaId }) });

test("real legacy uploads retain disabled response contract, then create/move/backfill per-user areas without changing ACL", async () => {
  configureDocsCloudAreas(false);
  const id = randomUUID(), legacy = await request(`/api/docs/${id}`, owner, "PUT", payload());
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).areaId, undefined);
  const areas = configureDocsCloudAreas(true)!;
  const personal = areas.ensureDefault(owner.id), project = areas.create(owner.id, "Project"), foreign = areas.create(viewer.id, "Other account");
  const initial = await request(`/api/docs/${id}`, owner); assert.equal((await initial.json()).doc.areaId, personal.id);
  const createdId = randomUUID(), created = await request(`/api/docs/${createdId}`, owner, "PUT", payload("custom", 0, project.id));
  assert.equal(created.status, 200); assert.equal((await created.json()).areaId, project.id);
  assert.equal((await request(`/api/docs/${createdId}`, owner, "PUT", payload("no implicit move", 1, personal.id))).status, 409);
  assert.equal((await request(`/api/docs/${createdId}`, owner, "PUT", payload("foreign", 1, foreign.id))).status, 404);
  assert.equal((await request(`/api/docs/${createdId}`, owner, "PUT", payload("preserved", 1))).status, 200);
  assert.equal(areas.getPlacement(owner.id, "markdown", createdId)?.areaId, project.id);
  assert.equal((await request(`/api/account/cloud-areas/placements/markdown/${createdId}`, viewer, "PUT", { areaId: foreign.id })).status, 404);
  assert.equal((await request(`/api/docs/${createdId}/shares`, owner, "POST", { email: viewer.email, role: "viewer" })).status, 200);
  assert.equal((await request(`/api/account/cloud-areas/placements/markdown/${createdId}`, viewer, "PUT", { areaId: foreign.id })).status, 200);
  assert.equal(areas.getPlacement(owner.id, "markdown", createdId)?.areaId, project.id);
  assert.equal((await request(`/api/docs/${createdId}`, viewer, "PUT", payload("forbidden", 2))).status, 403);
  const shared = (await (await request("/api/docs", viewer)).json()).docs.find((doc: { id: string }) => doc.id === createdId);
  assert.equal(shared.areaId, foreign.id); assert.equal(shared.shared, true);
});

test("legacy invalid destinations and placement failures leave no document/history/placement partial rows", async () => {
  const areas = configureDocsCloudAreas(true)!, db = areas.database, foreign = areas.ensureDefault(viewer.id), deniedId = randomUUID();
  assert.equal((await request(`/api/docs/${deniedId}`, owner, "PUT", payload("foreign", 0, foreign.id))).status, 404);
  assert.equal(db.prepare("SELECT id FROM docs WHERE id=?").get(deniedId), undefined);
  assert.equal(db.prepare("SELECT doc_id FROM doc_history WHERE doc_id=?").get(deniedId), undefined);
  const failedId = randomUUID();
  db.exec(`CREATE TRIGGER fail_area_legacy BEFORE INSERT ON cloud_document_placements WHEN NEW.document_id='${failedId}' BEGIN SELECT RAISE(ABORT,'private-trigger-detail'); END;`);
  const failed = await request(`/api/docs/${failedId}`, owner, "PUT", payload("rollback"));
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private-trigger-detail|INSERT/);
  assert.equal(db.prepare("SELECT id FROM docs WHERE id=?").get(failedId), undefined);
  assert.equal(db.prepare("SELECT doc_id FROM doc_history WHERE doc_id=?").get(failedId), undefined);
  assert.equal(areas.getPlacement(owner.id, "markdown", failedId), undefined);
  db.exec("DROP TRIGGER fail_area_legacy");
});
