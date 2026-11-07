// Which domain Live Docs run on, the boot check that keeps it apart from the
// app's own names, and which side of the server a request's host reaches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLiveDocsIsolated, classifyRequestHost, liveDocOrigin, liveDocsConfig } from "./live-docs-config.ts";

test("unset or empty LIVE_DOCS_DOMAIN means the feature is off", () => {
  assert.equal(liveDocsConfig({}), null);
  assert.equal(liveDocsConfig({ LIVE_DOCS_DOMAIN: "" }), null);
  assert.equal(liveDocsConfig({ LIVE_DOCS_DOMAIN: "   " }), null);
});

test("a bare domain is https; a loopback one is http and may name a port", () => {
  assert.deepEqual(liveDocsConfig({ LIVE_DOCS_DOMAIN: "markie.live" }), { domain: "markie.live", port: "", scheme: "https" });
  assert.deepEqual(liveDocsConfig({ LIVE_DOCS_DOMAIN: "Markie.Live" }), { domain: "markie.live", port: "", scheme: "https" });
  assert.deepEqual(liveDocsConfig({ LIVE_DOCS_DOMAIN: "localhost:8787" }), { domain: "localhost", port: ":8787", scheme: "http" });
  assert.equal(liveDocOrigin(liveDocsConfig({ LIVE_DOCS_DOMAIN: "markie.live" })!, "abcdefghijklmnop"), "https://abcdefghijklmnop.markie.live");
  assert.throws(() => liveDocOrigin(liveDocsConfig({ LIVE_DOCS_DOMAIN: "markie.live" })!, "evil.test/"));
});

test("anything but a bare domain stops the boot", () => {
  for (const bad of ["https://markie.live", "markie.live/", "*.markie.live", "markie..live", "-markie.live", "127.0.0.1", "markie.live:0", "markie.live:70000", "mar kie.live", "markie.live,evil.test"]) {
    assert.throws(() => liveDocsConfig({ LIVE_DOCS_DOMAIN: bad }), /LIVE_DOCS_DOMAIN/, bad);
  }
});

test("the boot refuses a live domain that equals, contains, sits under or shares a site with the app", () => {
  const live = liveDocsConfig({ LIVE_DOCS_DOMAIN: "markie.live" })!;
  for (const [app, reason] of [
    ["https://markie.live", /same name/],
    ["https://api.markie.live", /contains/],
    ["https://live", /sits under/],
    ["https://www.markie.live", /contains/],
  ] as const) {
    assert.throws(() => assertLiveDocsIsolated(live, [app]), reason, app);
  }
  const underApp = liveDocsConfig({ LIVE_DOCS_DOMAIN: "live.markiedocs.com" })!;
  assert.throws(() => assertLiveDocsIsolated(underApp, ["https://markiedocs.com"]), /sits under/);
  assert.throws(() => assertLiveDocsIsolated(underApp, ["https://api.markiedocs.com"]), /shares a registrable domain/);
  // Markie Cloud's real names are clear of markie.live.
  assert.doesNotThrow(() => assertLiveDocsIsolated(live, [
    "https://api.markiedocs.com", "https://api-production-602f.up.railway.app", "https://markiedocs.com", "https://www.markiedocs.com", undefined, "",
  ]));
});

test("locally, the app on localhost and Live Docs on localhost is refused with the fix in the message", () => {
  const live = liveDocsConfig({ LIVE_DOCS_DOMAIN: "localhost:8787" })!;
  assert.throws(() => assertLiveDocsIsolated(live, ["http://localhost:8787"]), /127\.0\.0\.1/);
  assert.doesNotThrow(() => assertLiveDocsIsolated(live, ["http://127.0.0.1:8787", "https://markiedocs.com"]));
});

const request = (headers: Record<string, string>, url = "http://placeholder/") => new Request(url, { headers });

test("host classification: app, apex, a Live Doc, and everything else under the live domain refused", () => {
  const config = liveDocsConfig({ LIVE_DOCS_DOMAIN: "markie.live" })!;
  const label = "abcdefghijklmn23";
  assert.deepEqual(classifyRequestHost(request({ host: "api.markiedocs.com" }), config), { kind: "app" });
  assert.deepEqual(classifyRequestHost(request({ host: "markie.live" }), config), { kind: "apex" });
  assert.deepEqual(classifyRequestHost(request({ host: `${label}.markie.live` }), config), { kind: "live", label });
  assert.deepEqual(classifyRequestHost(request({ host: `${label}.markie.live:443` }), config), { kind: "live", label });
  assert.deepEqual(classifyRequestHost(request({ host: `${label.toUpperCase()}.MARKIE.LIVE.` }), config), { kind: "live", label });
  for (const host of ["www.markie.live", `x.${label}.markie.live`, `${label}.markie.live:8443`, "abc.markie.live", `${label}1.markie.live`, "xn--abc.markie.live"]) {
    assert.deepEqual(classifyRequestHost(request({ host }), config), { kind: "refused" }, host);
  }
  // A name that merely ends with the domain's letters is not under it.
  assert.deepEqual(classifyRequestHost(request({ host: "notmarkie.live" }), config), { kind: "app" });
});

test("Host and X-Forwarded-Host must agree when either names the live domain", () => {
  const config = liveDocsConfig({ LIVE_DOCS_DOMAIN: "markie.live" })!;
  const label = "abcdefghijklmn23";
  assert.deepEqual(classifyRequestHost(request({ host: `${label}.markie.live`, "x-forwarded-host": `${label}.markie.live` }), config), { kind: "live", label });
  assert.deepEqual(classifyRequestHost(request({ host: "api.markiedocs.com", "x-forwarded-host": `${label}.markie.live` }), config), { kind: "refused" });
  assert.deepEqual(classifyRequestHost(request({ host: `${label}.markie.live`, "x-forwarded-host": "api.markiedocs.com" }), config), { kind: "refused" });
  assert.deepEqual(classifyRequestHost(request({ host: `${label}.markie.live`, "x-forwarded-host": "bbbbbbbbbbbbbbbb.markie.live" }), config), { kind: "refused" });
  assert.deepEqual(classifyRequestHost(request({ host: "api.markiedocs.com", "x-forwarded-host": "other.example" }), config), { kind: "app" });
  // No Host header at all: the URL's host decides.
  assert.deepEqual(classifyRequestHost(request({}, `https://${label}.markie.live/`), config), { kind: "live", label });
});
