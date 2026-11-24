import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateReleaseGateway, MAX_PRIVATE_RELEASE_BYTES, privateReleaseConfigFromEnv } from "./private-releases.ts";

const VERSION = "0.8.0-super-nightly.20261018.1", NAME = `Markie-${VERSION}-arm64-mac.zip`;
const PAYLOAD = Buffer.from("synthetic private release bytes");
const sha = (data: Uint8Array | string) => createHash("sha512").update(data).digest("base64");
const bearer = { authorization: "Bearer test-owner-token" };
async function setup(overrides = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "markie-private-release-test-")));
  const requests: { url: string; init: RequestInit }[] = [];
  const config = {
    enabled: true, root: directory, ownerId: "synthetic-sole-owner-uid", authOrigin: "https://trusted-auth.example", publishKey: randomBytes(32).toString("base64url"),
    fetch: (async (url: string | URL | Request, init: RequestInit) => {
      requests.push({ url: String(url), init });
      const token = new Headers(init.headers).get("authorization");
      if (token === "Bearer failure") throw new Error("private auth backend details");
      const id = token === "Bearer wrong-owner" ? "synthetic-other-user" : "synthetic-sole-owner-uid";
      return Response.json({ user: { id, emailVerified: token !== "Bearer unverified" }, session: { userId: id, expiresAt: new Date(Date.now() + (token === "Bearer expired" ? -60000 : 60000)).toISOString() } });
    }) as typeof fetch,
    ...overrides,
  };
  const app = createPrivateReleaseGateway(config);
  const put = (name: string, data: Uint8Array | string = PAYLOAD, headers: Record<string, string> = {}) => {
    const body = Buffer.from(data);
    return app.request(`/private-releases/super-nightly/${name}`, { method: "PUT", headers: { "x-markie-publish-key": config.publishKey, "content-length": String(body.length), "x-markie-sha512": sha(body), ...headers }, body });
  };
  return { directory, requests, config, app, put, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function feed(name = NAME, data: Uint8Array = PAYLOAD, version = VERSION) {
  return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha(data)}\n    size: ${data.length}\npath: ${name}\nsha512: ${sha(data)}\nreleaseDate: '2026-10-18T18:00:00.000Z'\n`;
}
test("standalone import has no public auth/database boot and env is opt-in", () => {
  assert.equal(privateReleaseConfigFromEnv({}).enabled, false);
  assert.equal(privateReleaseConfigFromEnv({ PRIVATE_RELEASE_ENABLED: "1" }).enabled, false);
  assert.equal(privateReleaseConfigFromEnv({ PRIVATE_RELEASE_ENABLED: "true" }).enabled, true);
  assert.equal(MAX_PRIVATE_RELEASE_BYTES, 512 * 1024 * 1024);
});
test("only exact verified live owner bearer can access; failures are indistinguishable no-store 404", async () => {
  const t = await setup();
  try {
    for (const authorization of [undefined, "Basic test-owner-token", "Bearer wrong-owner", "Bearer unverified", "Bearer expired", "Bearer failure"]) {
      const response = await t.app.request("/private-releases/access", { headers: authorization ? { authorization } : { cookie: "session=test-owner-token" } });
      assert.equal(response.status, 404); assert.equal(await response.text(), "Not found");
      assert.match(response.headers.get("cache-control")!, /no-store/);
      assert.equal(response.headers.get("location"), null);
    }
    const response = await t.app.request("/private-releases/access", { headers: { ...bearer, cookie: "do-not-forward", "x-forwarded-host": "evil.example" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { channel: "super-nightly", authorized: true, userId: t.config.ownerId });
    const request = t.requests.at(-1)!;
    assert.equal(request.url, "https://trusted-auth.example/api/auth/get-session");
    assert.deepEqual(request.init.headers, { authorization: bearer.authorization, accept: "application/json" });
    assert.equal(request.init.redirect, "error"); assert.equal(request.init.cache, "no-store");
    assert.deepEqual(await (await t.app.request("/health")).json(), { ok: true });
  } finally { await t.cleanup(); }
});
test("invalid/disabled config, malformed auth, redirects and downstream errors fail closed", async () => {
  for (const change of [
    { enabled: false }, { ownerId: "" }, { root: "/" }, { root: "relative" },
    ...["http://auth.example", "https://auth.example/path", "https://u:p@auth.example", "https://auth.example/?target=x", "not a URL"].map((authOrigin) => ({ authOrigin })),
    ...[null, {}, { user: { id: "synthetic-sole-owner-uid", emailVerified: true } }, { user: { id: "synthetic-sole-owner-uid", emailVerified: "true" }, session: {} }].map((json) => ({ fetch: (async () => Response.json(json)) as typeof fetch })),
    { fetch: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as typeof fetch },
    { fetch: (async () => new Response("x".repeat(40000))) as typeof fetch },
  ]) {
    const t = await setup(change);
    try { assert.equal((await t.app.request("/private-releases/access", { headers: bearer })).status, 404); }
    finally { await t.cleanup(); }
  }
});
test("publishes immutable bytes privately, gates HEAD/ranges, and never redirects or public-caches", async () => {
  const t = await setup();
  try {
    const uploaded = await t.put(NAME);
    assert.equal(uploaded.status, 201); assert.equal(uploaded.headers.get("x-markie-sha512"), sha(PAYLOAD));
    assert.equal((await lstat(join(t.directory, NAME))).mode & 0o777, 0o600);
    for (const method of ["GET", "HEAD"]) assert.equal((await t.app.request(`/private-releases/super-nightly/${NAME}`, { method })).status, 404);
    let response = await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: bearer });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), PAYLOAD);
    assert.match(response.headers.get("cache-control")!, /private.*no-store/); assert.equal(response.headers.get("location"), null);
    response = await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: { ...bearer, Range: "bytes=2-5" } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes 2-5/${PAYLOAD.length}`); assert.equal(await response.text(), PAYLOAD.subarray(2, 6).toString());
    response = await t.app.request(`/private-releases/super-nightly/${NAME}`, { method: "HEAD", headers: bearer });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), String(PAYLOAD.length)); assert.equal(await response.text(), "");
    assert.equal((await t.put(NAME, "overwrite")).status, 409);
    assert.deepEqual(await readFile(join(t.directory, NAME)), PAYLOAD);
    assert.deepEqual(await readdir(t.directory), [NAME]);
    assert.equal(t.requests.length, 3); // Publisher never calls the auth backend.
  } finally { await t.cleanup(); }
});
test("range validation is strict and always behind authorization", async () => {
  const t = await setup();
  try {
    assert.equal((await t.put(NAME)).status, 201);
    for (const range of ["bytes=-", "bytes=1-0", "bytes=999-", "bytes=0-1,3-4", "bytes=9007199254740992-", "other=0-2"]) {
      assert.equal((await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: { ...bearer, Range: range } })).status, 416);
      assert.equal((await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: { Range: range } })).status, 404);
    }
    const suffix = await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: { ...bearer, Range: "bytes=-3" } });
    assert.equal(suffix.status, 206); assert.equal(await suffix.text(), PAYLOAD.subarray(-3).toString());
    const full = await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: { ...bearer, Range: "bytes=-999" } });
    assert.equal(full.status, 200); await full.arrayBuffer();
  } finally { await t.cleanup(); }
});
test("upload authenticates before filesystem and body access; app bearer never acts as publisher", async () => {
  const t = await setup();
  try {
    await rm(t.directory, { recursive: true });
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(PAYLOAD); controller.close(); } }, { highWaterMark: 0 });
    const request = new Request(`https://gateway.example/private-releases/super-nightly/${NAME}`, { method: "PUT", headers: { ...bearer, "content-length": String(PAYLOAD.length), "x-markie-sha512": sha(PAYLOAD) }, body, duplex: "half" } as RequestInit);
    assert.equal((await t.app.request(request)).status, 404); assert.equal(reads, 0);
    await assert.rejects(lstat(t.directory), { code: "ENOENT" });
    assert.equal((await t.put(NAME, PAYLOAD, { "x-markie-publish-key": "wrong" })).status, 404);
    assert.equal(t.requests.length, 0);
  } finally { await t.cleanup(); }
});
test("upload enforces content length, digest, hard bounds and cleans incomplete temps", async () => {
  const t = await setup({ maxArtifactBytes: PAYLOAD.length });
  try {
    const badHeaders: Record<string, string>[] = [
      { "content-length": "0" }, { "content-length": "-1" }, { "content-length": "1.2" }, { "content-length": "" },
      { "content-length": String(PAYLOAD.length - 1) }, { "x-markie-sha512": sha("wrong") },
      { "x-markie-sha512": "not a hash" }, { "content-encoding": "gzip" },
    ];
    for (const headers of badHeaders) { assert.equal((await t.put(NAME, PAYLOAD, headers)).status, 400); assert.deepEqual(await readdir(t.directory), []); }
    assert.equal((await t.put(NAME, PAYLOAD, { "content-length": String(MAX_PRIVATE_RELEASE_BYTES + 1) })).status, 413);
    assert.equal((await t.put(NAME, PAYLOAD, { "content-length": String(PAYLOAD.length + 1) })).status, 413);
    assert.equal((await t.put(NAME)).status, 201);
  } finally { await t.cleanup(); }
  const tiny = await setup({ publishKey: "a".repeat(64) });
  try { assert.equal((await tiny.put(NAME)).status, 404); } finally { await tiny.cleanup(); }
});
test("only private feed names and versioned artifact names are routable, encoded traversal included", async () => {
  const t = await setup();
  try {
    for (const name of ["latest-mac.yml", "latest.yml", "stable.yml", "beta.yml", "super-nightly-linux.yml", "Markie-0.8.0.zip", "Markie-0.8.0-beta.1.zip", "../secret.zip", "%2e%2e%2fsecret.zip", `${NAME}%2fsecret`, `${NAME}%00`, ".upload-123", "name.exe", "Markie-0.8.0-super-nightly.1.exe", "Markie-0.8.0-super-nightly..1.zip"]) {
      assert.equal((await t.put(name)).status, 404, name);
      assert.equal((await t.app.request(`/private-releases/super-nightly/${name}`, { headers: bearer })).status, 404, name);
    }
    assert.equal((await t.put(`${NAME}.blockmap`)).status, 201);
    assert.deepEqual(await readdir(t.directory), [`${NAME}.blockmap`]);
  } finally { await t.cleanup(); }
});
test("feeds publish last, only reference existing exact local artifacts, and update atomically", async () => {
  const t = await setup();
  try {
    assert.equal((await t.put("super-nightly-mac.yml", feed())).status, 400);
    assert.deepEqual(await readdir(t.directory), []);
    assert.equal((await t.put(NAME)).status, 201);
    assert.equal((await t.put("super-nightly-mac.yml", feed())).status, 200);
    const response = await t.app.request("/private-releases/super-nightly/super-nightly-mac.yml", { headers: bearer });
    assert.equal(response.status, 200); assert.equal(await response.text(), feed());
    for (const bad of [
      feed(`https://evil.example/${NAME}`), feed(`../${NAME}`), feed(`%2e%2e%2f${NAME}`), feed(`file://${NAME}`),
      feed().replace("size: " + PAYLOAD.length, "size: 999"), feed().replace(sha(PAYLOAD), sha("wrong")),
      feed().replace("version: " + VERSION, "version: 0.8.0"), feed() + "path: duplicate.zip\n",
      feed().replace("files:", "files: &anchor"), feed().replace("files:", "files: !!seq"),
      feed().replace(`path: ${NAME}`, "path: latest-mac.yml"), feed().replace(`- url: ${NAME}`, "- url: name.exe"),
      feed().replace("releaseDate:", "unknownField:"),
    ]) {
      assert.equal((await t.put("super-nightly-mac.yml", bad)).status, 400);
      assert.equal(await readFile(join(t.directory, "super-nightly-mac.yml"), "utf8"), feed());
    }
    const next = feed().replace("18:00:00", "18:01:00");
    assert.equal((await t.put("super-nightly-mac.yml", next)).status, 200);
    assert.equal(await readFile(join(t.directory, "super-nightly-mac.yml"), "utf8"), next);
    assert.equal((await t.app.request("/private-releases/super-nightly/super-nightly-mac.yml")).status, 404);
    assert.ok((await readdir(t.directory)).every((file) => !file.startsWith(".upload-")));
  } finally { await t.cleanup(); }
});
test("filesystem symlinks, hardlinks, permissive roots/files and tampered feeds fail closed", async () => {
  const t = await setup(), outside = await setup();
  try {
    await writeFile(join(outside.directory, NAME), PAYLOAD, { mode: 0o600 });
    await symlink(join(outside.directory, NAME), join(t.directory, NAME));
    assert.equal((await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: bearer })).status, 404);
    assert.equal((await t.put(NAME)).status, 409);
    await rm(join(t.directory, NAME));
    await link(join(outside.directory, NAME), join(t.directory, NAME));
    assert.equal((await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: bearer })).status, 404);
    await rm(join(t.directory, NAME));
    assert.equal((await t.put(NAME)).status, 201);
    await chmod(join(t.directory, NAME), 0o644);
    assert.equal((await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: bearer })).status, 404);
    await chmod(join(t.directory, NAME), 0o600);
    assert.equal((await t.put("super-nightly.yml", feed())).status, 200);
    await writeFile(join(t.directory, NAME), "tampered");
    assert.equal((await t.app.request("/private-releases/super-nightly/super-nightly.yml", { headers: bearer })).status, 404);
    await chmod(t.directory, 0o755);
    assert.equal((await t.put(`Markie-${VERSION}-x64-mac.zip`)).status, 400);
    const symlinkRoot = join(outside.directory, "linked"); await symlink(t.directory, symlinkRoot);
    const app = createPrivateReleaseGateway({ ...t.config, root: symlinkRoot });
    assert.equal((await app.request(`/private-releases/super-nightly/${NAME}`, { headers: bearer })).status, 404);
    assert.equal((await app.request(`/private-releases/super-nightly/${NAME}`, { method: "PUT", headers: { "x-markie-publish-key": t.config.publishKey, "content-length": String(PAYLOAD.length), "x-markie-sha512": sha(PAYLOAD) }, body: PAYLOAD })).status, 400);
  } finally { await t.cleanup(); await outside.cleanup(); }
});
test("concurrent immutable publication has one winner and body failures leave no files", async () => {
  const t = await setup();
  try {
    const responses = await Promise.all([t.put(NAME), t.put(NAME)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.deepEqual(await readFile(join(t.directory, NAME)), PAYLOAD);
    const other = `Markie-${VERSION}-x64-mac.zip`;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("private stream details")); } });
    const request = new Request(`https://gateway.example/private-releases/super-nightly/${other}`, { method: "PUT", headers: { "x-markie-publish-key": t.config.publishKey, "content-length": "2", "x-markie-sha512": sha("ab") }, body, duplex: "half" } as RequestInit);
    const response = await t.app.request(request);
    assert.equal(response.status, 400); assert.equal(await response.text(), "Invalid upload");
    assert.deepEqual(await readdir(t.directory), [NAME]);
    assert.equal((await t.put(other)).status, 201); // Reservation released after failure.
  } finally { await t.cleanup(); }
});
test("short bodies, oversized feeds and foreign sessions cannot publish partial state", async () => {
  const t = await setup();
  try {
    assert.equal((await t.put(NAME, PAYLOAD, { "content-length": String(PAYLOAD.length + 1) })).status, 400);
    assert.equal((await t.put("super-nightly.yml", "a".repeat(64 * 1024 + 1))).status, 413);
    assert.deepEqual(await readdir(t.directory), []);
    const foreign = createPrivateReleaseGateway({ ...t.config, fetch: (async () => Response.json({ user: { id: t.config.ownerId, emailVerified: true }, session: { userId: "foreign", expiresAt: new Date(Date.now() + 60000).toISOString() } })) as typeof fetch });
    assert.equal((await foreign.request("/private-releases/access", { headers: bearer })).status, 404);
    assert.equal((await t.put(NAME)).status, 201);
    const body = await (await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: bearer })).body!;
    await body.cancel(); // Cancelling download must close the owned file descriptor.
  } finally { await t.cleanup(); }
});
test("200 invalid bearer requests cannot amplify into unbounded public auth traffic", async () => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0, inFlight = 0, peak = 0;
  const t = await setup({ fetch: (async () => {
    calls++; inFlight++; peak = Math.max(peak, inFlight);
    await pending; inFlight--;
    return Response.json(null);
  }) as typeof fetch });
  try {
    const requests = Array.from({ length: 200 }, (_, i) => t.app.request(i % 2 ? "/private-releases/access" : `/private-releases/super-nightly/${NAME}`, { headers: { authorization: `Bearer synthetic-invalid-${i}` } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 8); assert.equal(peak, 8);
    finish!();
    for (const response of await Promise.all(requests)) { assert.equal(response.status, 404); assert.equal(await response.text(), "Not found"); }
    assert.equal(calls, 8);
    const before = calls;
    for (const name of ["latest.yml", "junk.exe", "%2e%2e%2fsecret.zip"]) assert.equal((await t.app.request(`/private-releases/super-nightly/${name}`, { headers: bearer })).status, 404);
    assert.equal(calls, before); // Junk filenames never consume downstream auth budget.
  } finally { finish?.(); await t.cleanup(); }
});
test("negative auth caching uses a bounded policy and the global minute budget fails closed", async () => {
  let calls = 0;
  const t = await setup({ fetch: (async () => { calls++; return Response.json(null); }) as typeof fetch });
  try {
    const token = "Bearer synthetic-invalid-credential-never-in-errors";
    for (let i = 0; i < 200; i++) {
      const response = await t.app.request("/private-releases/access", { headers: { authorization: token } });
      assert.equal(response.status, 404); assert.equal(await response.text(), "Not found");
      assert.ok(!JSON.stringify([...response.headers]).includes(token));
    }
    assert.equal(calls, 1);
    for (let i = 0; i < 100; i++) assert.equal((await t.app.request("/private-releases/access", { headers: { authorization: `Bearer distinct-${i}` } })).status, 404);
    assert.equal(calls, 60); // Access and artifact requests share this fixed cap.
    assert.equal((await t.app.request(`/private-releases/super-nightly/${NAME}`, { headers: bearer })).status, 404);
    assert.equal(calls, 60);
  } finally { await t.cleanup(); }
});

// ---------------------------------------------------------------- rs-nightly
// The second lane: Markie Nightly, the Rust build. Same gate, its own prefix,
// feed name, version rule, artifact names and folder.
const RS = "/private-releases/rs-nightly/", SUPER = "/private-releases/super-nightly/";
const RS_VERSION = "0.1.0-rs-nightly.7", RS_NAME = `Markie-Nightly-${RS_VERSION}-arm64.zip`, RS_FEED = "rs-nightly-mac.yml";
type Setup = Awaited<ReturnType<typeof setup>>;
function putAt(t: Setup, prefix: string, name: string, data: Uint8Array | string = PAYLOAD, headers: Record<string, string> = {}) {
  const body = Buffer.from(data);
  return t.app.request(prefix + name, { method: "PUT", headers: { "x-markie-publish-key": t.config.publishKey, "content-length": String(body.length), "x-markie-sha512": sha(body), ...headers }, body });
}
const rsFeed = (name = RS_NAME, data: Uint8Array = PAYLOAD, version = RS_VERSION) => feed(name, data, version);

test("rs-nightly publishes immutable bytes into its own folder and serves them only to the owner", async () => {
  const t = await setup();
  try {
    const uploaded = await putAt(t, RS, RS_NAME);
    assert.equal(uploaded.status, 201); assert.equal(uploaded.headers.get("x-markie-sha512"), sha(PAYLOAD));
    assert.deepEqual(await uploaded.json(), { ok: true, channel: "rs-nightly", filename: RS_NAME, size: PAYLOAD.length, sha512: sha(PAYLOAD) });
    assert.deepEqual(await readdir(t.directory), ["rs-nightly"]);
    assert.equal((await lstat(join(t.directory, "rs-nightly"))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(t.directory, "rs-nightly", RS_NAME))).mode & 0o777, 0o600);
    for (const headers of [undefined, { authorization: "Bearer wrong-owner" }, { authorization: "Bearer unverified" }, { authorization: "Bearer expired" }, { authorization: "Bearer failure" }, { cookie: "session=test-owner-token" }]) {
      for (const method of ["GET", "HEAD"]) {
        const denied = await t.app.request(RS + RS_NAME, { method, headers });
        assert.equal(denied.status, 404); assert.equal(denied.headers.get("location"), null); assert.match(denied.headers.get("cache-control")!, /no-store/);
      }
    }
    let response = await t.app.request(RS + RS_NAME, { headers: bearer });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), PAYLOAD);
    assert.match(response.headers.get("cache-control")!, /private.*no-store/); assert.equal(response.headers.get("content-disposition"), `attachment; filename="${RS_NAME}"`);
    response = await t.app.request(RS + RS_NAME, { headers: { ...bearer, Range: "bytes=2-5" } });
    assert.equal(response.status, 206); assert.equal(await response.text(), PAYLOAD.subarray(2, 6).toString());
    response = await t.app.request(RS + RS_NAME, { method: "HEAD", headers: bearer });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), String(PAYLOAD.length));
    assert.equal((await putAt(t, RS, RS_NAME, "overwrite")).status, 409);
    assert.deepEqual(await readFile(join(t.directory, "rs-nightly", RS_NAME)), PAYLOAD);
    assert.deepEqual(await readdir(join(t.directory, "rs-nightly")), [RS_NAME]);
    // The app's bearer never publishes, and a wrong key reads as no such route.
    assert.equal((await t.app.request(RS + `Markie-Nightly-0.1.0-rs-nightly.8-arm64.zip`, { method: "PUT", headers: { ...bearer, "content-length": String(PAYLOAD.length), "x-markie-sha512": sha(PAYLOAD) }, body: PAYLOAD })).status, 404);
    assert.equal((await putAt(t, RS, `Markie-Nightly-0.1.0-rs-nightly.8-arm64.zip`, PAYLOAD, { "x-markie-publish-key": "wrong" })).status, 404);
    assert.deepEqual(await readdir(join(t.directory, "rs-nightly")), [RS_NAME]);
  } finally { await t.cleanup(); }
});
test("rs-nightly feed is promoted last, re-hashed on every read and replaced atomically", async () => {
  const t = await setup();
  try {
    assert.equal((await putAt(t, RS, RS_FEED, rsFeed())).status, 400); // Nothing to point at yet.
    assert.equal((await putAt(t, RS, RS_NAME)).status, 201);
    assert.equal((await putAt(t, RS, RS_FEED, rsFeed())).status, 200);
    const response = await t.app.request(RS + RS_FEED, { headers: bearer });
    assert.equal(response.status, 200); assert.equal(await response.text(), rsFeed());
    assert.equal(response.headers.get("content-type"), "application/yaml; charset=utf-8");
    assert.equal((await t.app.request(RS + RS_FEED)).status, 404);
    for (const bad of [
      rsFeed(`https://evil.example/${RS_NAME}`), rsFeed(`../${RS_NAME}`), rsFeed(`%2e%2e%2f${RS_NAME}`), rsFeed(NAME),
      rsFeed().replace("size: " + PAYLOAD.length, "size: 999"), rsFeed().replace(sha(PAYLOAD), sha("wrong")),
      rsFeed().replace("version: " + RS_VERSION, "version: 0.1.0"), rsFeed().replace("version: " + RS_VERSION, "version: 0.1.0-rs-nightly.8"),
      rsFeed().replace("version: " + RS_VERSION, "version: " + VERSION), rsFeed() + "path: duplicate.zip\n",
      rsFeed().replace("files:", "files: &anchor"), rsFeed().replace("releaseDate:", "unknownField:"),
    ]) {
      assert.equal((await putAt(t, RS, RS_FEED, bad)).status, 400);
      assert.equal(await readFile(join(t.directory, "rs-nightly", RS_FEED), "utf8"), rsFeed());
    }
    const next = `Markie-Nightly-0.1.0-rs-nightly.8-arm64.zip`, nextBytes = Buffer.from("the next synthetic nightly");
    assert.equal((await putAt(t, RS, next, nextBytes)).status, 201);
    assert.equal((await putAt(t, RS, RS_FEED, rsFeed(next, nextBytes, "0.1.0-rs-nightly.8"))).status, 200);
    assert.equal(await (await t.app.request(RS + RS_FEED, { headers: bearer })).text(), rsFeed(next, nextBytes, "0.1.0-rs-nightly.8"));
    assert.ok((await readdir(join(t.directory, "rs-nightly"))).every((file) => !file.startsWith(".upload-")));
    // A served feed whose artifact changed on disk is refused, not served stale.
    await writeFile(join(t.directory, "rs-nightly", next), "tampered");
    assert.equal((await t.app.request(RS + RS_FEED, { headers: bearer })).status, 404);
  } finally { await t.cleanup(); }
});
test("rs-nightly routes only its feed and exact X.Y.Z-rs-nightly.N arm64 ZIP names", async () => {
  const t = await setup();
  try {
    for (const name of [
      "super-nightly.yml", "super-nightly-mac.yml", "rs-nightly.yml", "rs-nightly-win.yml", "latest-mac.yml", NAME, `${NAME}.blockmap`,
      `${RS_NAME}.blockmap`, `Markie-Nightly-${RS_VERSION}-x64.zip`, `Markie-Nightly-${RS_VERSION}-arm64.dmg`, `Markie-Nightly-${RS_VERSION}-arm64-mac.zip`,
      `Markie-${RS_VERSION}-arm64.zip`, `Markie-RS-${RS_VERSION}-arm64.zip`, "Markie-Nightly-0.1.0-arm64.zip", "Markie-Nightly-0.1.0-rs-nightly-arm64.zip",
      "Markie-Nightly-0.1.0-rs-nightly.07-arm64.zip", "Markie-Nightly-0.1.0-rs-nightly.7.1-arm64.zip", "Markie-Nightly-0.1.0-rs-nightly.x-arm64.zip",
      "Markie-Nightly-0.1.0-super-nightly.7-arm64.zip", "Markie-Nightly-01.1.0-rs-nightly.7-arm64.zip", "Markie-Nightly-0.1-rs-nightly.7-arm64.zip",
      "Markie-Nightly-0.1.0-rs-nightly..7-arm64.zip", "../secret.zip", "%2e%2e%2fsecret.zip", `${RS_NAME}%2fsecret`, `${RS_NAME}%00`, ".upload-123", "access", "rs-nightly",
      `Markie-Nightly-0.1.0-rs-nightly.${"9".repeat(200)}-arm64.zip`,
    ]) {
      assert.equal((await putAt(t, RS, name)).status, 404, name);
      assert.equal((await t.app.request(RS + name, { headers: bearer })).status, 404, name);
    }
    assert.deepEqual(await readdir(t.directory), []);
    assert.equal(t.requests.length, 0); // Junk names never reach the auth backend.
  } finally { await t.cleanup(); }
});
test("rs-nightly enforces content length, digest, the hard cap and the feed cap", async () => {
  const t = await setup({ maxArtifactBytes: PAYLOAD.length });
  try {
    for (const headers of [{ "content-length": "0" }, { "content-length": "" }, { "content-length": String(PAYLOAD.length - 1) }, { "x-markie-sha512": sha("wrong") }, { "x-markie-sha512": "not a hash" }, { "content-encoding": "gzip" }] as Record<string, string>[]) {
      assert.equal((await putAt(t, RS, RS_NAME, PAYLOAD, headers)).status, 400);
    }
    assert.equal((await putAt(t, RS, RS_NAME, PAYLOAD, { "content-length": String(MAX_PRIVATE_RELEASE_BYTES + 1) })).status, 413);
    assert.equal((await putAt(t, RS, RS_NAME, PAYLOAD, { "content-length": String(PAYLOAD.length + 1) })).status, 413);
    assert.equal((await putAt(t, RS, RS_FEED, "a".repeat(64 * 1024 + 1))).status, 413);
    assert.deepEqual(await readdir(join(t.directory, "rs-nightly")).catch(() => []), []);
    assert.equal((await putAt(t, RS, RS_NAME)).status, 201);
  } finally { await t.cleanup(); }
  const uncapped = await setup();
  try { assert.equal((await putAt(uncapped, RS, RS_NAME, PAYLOAD, { "content-length": String(MAX_PRIVATE_RELEASE_BYTES + 1) })).status, 413); }
  finally { await uncapped.cleanup(); }
});
test("the two lanes never see each other's files, feeds or names", async () => {
  const t = await setup();
  try {
    assert.equal((await t.put(NAME)).status, 201);
    assert.equal((await t.put("super-nightly-mac.yml", feed())).status, 200);
    assert.equal((await putAt(t, RS, RS_NAME)).status, 201);
    assert.equal((await putAt(t, RS, RS_FEED, rsFeed())).status, 200);
    assert.deepEqual((await readdir(t.directory)).sort(), [NAME, "rs-nightly", "super-nightly-mac.yml"].sort());
    assert.deepEqual((await readdir(join(t.directory, "rs-nightly"))).sort(), [RS_NAME, RS_FEED].sort());
    // Each prefix serves its own names only, even though both lanes hold files.
    for (const [prefix, name] of [[SUPER, RS_NAME], [SUPER, RS_FEED], [SUPER, "rs-nightly"], [SUPER, `rs-nightly%2f${RS_NAME}`], [RS, NAME], [RS, "super-nightly-mac.yml"], [RS, `..%2f${NAME}`]]) {
      assert.equal((await t.app.request(prefix + name, { headers: bearer })).status, 404, prefix + name);
      assert.equal((await putAt(t, prefix, name)).status, 404, prefix + name);
    }
    // A feed may not name the other lane's artifact, whatever version it claims.
    assert.equal((await t.put("super-nightly-mac.yml", feed(RS_NAME, PAYLOAD, RS_VERSION))).status, 400);
    assert.equal((await t.put("super-nightly-mac.yml", feed(RS_NAME))).status, 400);
    assert.equal((await putAt(t, RS, RS_FEED, feed())).status, 400);
    assert.equal(await (await t.app.request(SUPER + "super-nightly-mac.yml", { headers: bearer })).text(), feed());
    assert.equal(await (await t.app.request(RS + RS_FEED, { headers: bearer })).text(), rsFeed());
    // The access proof still names the first lane; the Electron build depends on that exact answer.
    assert.deepEqual(await (await t.app.request("/private-releases/access", { headers: bearer })).json(), { channel: "super-nightly", authorized: true, userId: t.config.ownerId });
  } finally { await t.cleanup(); }
});
test("rs-nightly fails closed on a permissive root or folder, links and a disabled gateway", async () => {
  const t = await setup(), outside = await setup();
  try {
    assert.equal((await putAt(t, RS, RS_NAME)).status, 201);
    await chmod(join(t.directory, "rs-nightly"), 0o755);
    assert.equal((await t.app.request(RS + RS_NAME, { headers: bearer })).status, 404);
    await chmod(join(t.directory, "rs-nightly"), 0o700);
    assert.equal((await t.app.request(RS + RS_NAME, { headers: bearer })).status, 200);
    await chmod(t.directory, 0o755); // A bad private root closes every lane under it.
    assert.equal((await t.app.request(RS + RS_NAME, { headers: bearer })).status, 404);
    assert.equal((await putAt(t, RS, "Markie-Nightly-0.1.0-rs-nightly.8-arm64.zip")).status, 400);
    await chmod(t.directory, 0o700);
    await rm(join(t.directory, "rs-nightly"), { recursive: true });
    await symlink(outside.directory, join(t.directory, "rs-nightly"));
    await writeFile(join(outside.directory, RS_NAME), PAYLOAD, { mode: 0o600 });
    assert.equal((await t.app.request(RS + RS_NAME, { headers: bearer })).status, 404);
    assert.equal((await putAt(t, RS, "Markie-Nightly-0.1.0-rs-nightly.8-arm64.zip")).status, 400);
    assert.deepEqual(await readdir(outside.directory), [RS_NAME]);
    await rm(join(t.directory, "rs-nightly"));
    assert.equal((await putAt(t, RS, RS_NAME)).status, 201);
    await rm(join(t.directory, "rs-nightly", RS_NAME));
    await link(join(outside.directory, RS_NAME), join(t.directory, "rs-nightly", RS_NAME));
    assert.equal((await t.app.request(RS + RS_NAME, { headers: bearer })).status, 404);
  } finally { await t.cleanup(); await outside.cleanup(); }
  const off = await setup({ enabled: false });
  try {
    assert.equal((await putAt(off, RS, RS_NAME)).status, 404);
    assert.equal((await off.app.request(RS + RS_NAME, { headers: bearer })).status, 404);
    assert.deepEqual(await readdir(off.directory), []);
  } finally { await off.cleanup(); }
});
/** Every status, header and body byte of a fixed super-nightly session, as one digest. */
async function superNightlyTranscript(create: typeof createPrivateReleaseGateway): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "markie-private-release-transcript-")));
  // A fixed synthetic key, so the transcript is the same on every run.
  const publishKey = "synthetic-transcript-key-0123456789-abcdefghijklmnopqrstuvwxyz";
  const app = create({
    enabled: true, root: directory, ownerId: "synthetic-sole-owner-uid", authOrigin: "https://trusted-auth.example", publishKey,
    fetch: (async (_url: string | URL | Request, init: RequestInit) => {
      const id = new Headers(init.headers).get("authorization") === bearer.authorization ? "synthetic-sole-owner-uid" : "synthetic-other-user";
      return Response.json({ user: { id, emailVerified: true }, session: { userId: id, expiresAt: "2999-01-01T00:00:00.000Z" } });
    }) as typeof fetch,
  });
  const hash = createHash("sha256");
  const record = async (label: string, response: Response) => {
    hash.update(JSON.stringify([label, response.status, [...response.headers].sort()]));
    hash.update(Buffer.from(await response.arrayBuffer()));
  };
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") => app.request(path, { method, headers });
  const put = (name: string, data: Uint8Array | string = PAYLOAD, headers: Record<string, string> = {}) => {
    const body = Buffer.from(data);
    return app.request(SUPER + name, { method: "PUT", headers: { "x-markie-publish-key": publishKey, "content-length": String(body.length), "x-markie-sha512": sha(body), ...headers }, body });
  };
  const other = `Markie-${VERSION}-x64-mac.zip`;
  try {
    await record("health", await get("/health"));
    await record("access denied", await get("/private-releases/access"));
    await record("access wrong owner", await get("/private-releases/access", { authorization: "Bearer wrong-owner" }));
    await record("access", await get("/private-releases/access", bearer));
    await record("feed before artifact", await put("super-nightly-mac.yml", feed()));
    await record("artifact", await put(NAME));
    await record("artifact again", await put(NAME, "overwrite"));
    await record("blockmap", await put(`${NAME}.blockmap`, "synthetic blockmap"));
    await record("wrong key", await put(other, PAYLOAD, { "x-markie-publish-key": "wrong" }));
    await record("bad digest", await put(other, PAYLOAD, { "x-markie-sha512": sha("wrong") }));
    await record("bad length", await put(other, PAYLOAD, { "content-length": "0" }));
    await record("too large", await put(other, PAYLOAD, { "content-length": String(MAX_PRIVATE_RELEASE_BYTES + 1) }));
    await record("bad feed", await put("super-nightly-mac.yml", feed().replace("size: " + PAYLOAD.length, "size: 999")));
    await record("feed", await put("super-nightly-mac.yml", feed()));
    await record("legacy feed", await put("super-nightly.yml", feed()));
    await record("oversized feed", await put("super-nightly.yml", "a".repeat(64 * 1024 + 1)));
    for (const name of [NAME, `${NAME}.blockmap`, "super-nightly-mac.yml", "super-nightly.yml", other, "latest-mac.yml", "rs-nightly", "rs-nightly-mac.yml", RS_NAME, "%2e%2e%2fsecret.zip", ".upload-123", "access"]) {
      await record(`get ${name}`, await get(SUPER + name, bearer));
      await record(`head ${name}`, await get(SUPER + name, bearer, "HEAD"));
      await record(`anonymous ${name}`, await get(SUPER + name));
      await record(`stranger ${name}`, await get(SUPER + name, { authorization: "Bearer wrong-owner" }));
    }
    for (const range of ["bytes=2-5", "bytes=-3", "bytes=-999", "bytes=999-", "bytes=1-0", "other=0-2"]) await record(`range ${range}`, await get(SUPER + NAME, { ...bearer, Range: range }));
    for (const path of ["/", "/private-releases", "/private-releases/", "/private-releases/super-nightly", "/private-releases/super-nightly/", "/private-releases/beta/" + NAME, `${SUPER}${NAME}/extra`]) {
      await record(`path ${path}`, await get(path, bearer));
      await record(`post ${path}`, await get(path, bearer, "POST"));
    }
    await record("delete", await get(SUPER + NAME, bearer, "DELETE"));
    hash.update(JSON.stringify((await readdir(directory)).sort()));
    for (const name of (await readdir(directory)).sort()) hash.update(await readFile(join(directory, name)));
    return hash.digest("hex");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("super-nightly answers exactly what it answered before the second lane existed", async () => {
  // Recorded from the gateway at b291e128, the commit before rs-nightly. A
  // change here is a change to what installed Electron nightlies receive.
  assert.equal(await superNightlyTranscript(createPrivateReleaseGateway), "cafb3a0cc72f03eb618dd108eb427f3177463bae91443d6a0936c39f821d177f");
});
