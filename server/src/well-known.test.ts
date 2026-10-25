// The association files iOS and Android fetch before they let the mobile app
// open /d and /s links. Fetched through the whole app as Markie Cloud, on its
// other name too, because a redirect, an auth check or a rewritten
// Content-Type would make the platform verifier give up silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-well-known-")), "t.db");
// Markie Cloud after the move: the Railway name is an alias, and browser
// pages asked for there are redirected (canonical-host.ts).
process.env.BETTER_AUTH_URL = "https://api.markiedocs.com";
process.env.BETTER_AUTH_SECRET = "markie-well-known-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markiedocs.com";
process.env.MARKIE_NO_LISTEN = "1";
delete process.env.MARKIE_OFFICIAL;
delete process.env.ANDROID_APP_CERT_SHA256;

const { app } = await import("./index.ts");
const { androidFingerprints, assetLinks, createWellKnown } = await import("./well-known.ts");

const HOSTS = ["api.markiedocs.com", "api-production-602f.up.railway.app", "markiedocs.com"];
const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase()).join(":");

async function fetchAs(host: string, path: string) {
  return app.request(`http://${host}${path}`, { headers: { host, "x-forwarded-host": host } });
}

test("this suite really runs on an aliased deployment: browser pages on the other name are redirected", async () => {
  const res = await fetchAs("api-production-602f.up.railway.app", "/auth/google-start");
  assert.equal(res.status, 308);
});

test("apple-app-site-association claims /d/* and /s/* for the mobile app, on every name, as JSON", async () => {
  for (const host of HOSTS) {
    const res = await fetchAs(host, "/.well-known/apple-app-site-association");
    assert.equal(res.status, 200, host);
    assert.equal(res.headers.get("location"), null);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("content-security-policy"), null);
    assert.deepEqual(await res.json(), {
      applinks: {
        apps: [],
        details: [{ appIDs: ["3VU8SG5TD9.com.zvn.markie.mobile"], components: [{ "/": "/d/*" }, { "/": "/s/*" }] }],
      },
    });
  }
});

test("assetlinks.json is an empty list until a fingerprint is configured", async () => {
  for (const host of HOSTS) {
    const res = await fetchAs(host, "/.well-known/assetlinks.json");
    assert.equal(res.status, 200, host);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(await res.json(), []);
  }
});

test("assetlinks.json names the package and every configured fingerprint", async () => {
  const lower = FP.toLowerCase();
  const wellKnown = createWellKnown({ ANDROID_APP_CERT_SHA256: ` ${lower} , ${FP},,` });
  const res = await wellKnown.request("/.well-known/assetlinks.json");
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "com.zvn.markie.mobile", sha256_cert_fingerprints: [FP] },
    },
  ]);
});

test("a malformed fingerprint is left out with a warning, never published", () => {
  const warnings: string[] = [];
  const out = androidFingerprints(`nope,${FP},AB:CD`, (m) => warnings.push(m));
  assert.deepEqual(out, [FP]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(androidFingerprints(undefined), []);
  assert.deepEqual(assetLinks([]), []);
});

test("the association files need no session and set no cookie", async () => {
  for (const path of ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"]) {
    const res = await app.request(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("set-cookie"), null);
  }
});
