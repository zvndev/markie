// The brand assets this server serves and the logo its pages draw inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { BRAND_FILES, BRAND_HEAD, LETTERING_PATH, UNDERLINE_PATH, brandAssets, brandEmailLogoUrl, brandLogoSvg } from "./brand.ts";

test("serves the favicon and every listed brand file with its own type", async () => {
  const app = brandAssets();
  const ico = await app.request("/favicon.ico");
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  for (const name of BRAND_FILES) {
    const res = await app.request(`/brand/${name}`);
    assert.equal(res.status, 200, name);
    assert.ok((await res.arrayBuffer()).byteLength > 0, name);
  }
  assert.equal((await app.request("/brand/favicon.svg")).headers.get("content-type"), "image/svg+xml");
});

test("answers 404 for anything not on the list, including path tricks", async () => {
  const app = brandAssets();
  for (const path of ["/brand/nope.png", "/brand/..%2Fbrand.ts", "/brand/__proto__", "/brand/"]) {
    assert.equal((await app.request(path)).status, 404, path);
  }
});

test("every page favicon link points at a file the server has", () => {
  for (const [, href] of BRAND_HEAD.matchAll(/href="([^"]+)"/g)) {
    const served = href === "/favicon.ico" || BRAND_FILES.includes(href.replace("/brand/", "") as (typeof BRAND_FILES)[number]);
    assert.ok(served, href);
  }
});

test("the inline logo takes the page's text color for its lettering and keeps the underline red", () => {
  const svg = brandLogoSvg(160);
  assert.match(svg, /width="160" height="70"/);
  assert.match(svg, /fill="currentColor"/);
  assert.match(svg, /fill="#EC4431"/);
  assert.match(svg, /aria-label="Markie"/);
});

test("the email logo is an absolute URL on this server", () => {
  assert.equal(brandEmailLogoUrl("https://api.markiedocs.com/"), "https://api.markiedocs.com/brand/markie-logo-primary-512.png");
});

// The renderer's copy (src/lib/brand.ts) and this one are the same drawing.
// Only checked in a full checkout; the server image holds server/ alone.
test("the server's logo paths match the renderer's", { skip: !existsSync(new URL("../../src/lib/brand.ts", import.meta.url)) }, () => {
  const renderer = readFileSync(new URL("../../src/lib/brand.ts", import.meta.url), "utf8");
  assert.ok(renderer.includes(JSON.stringify(LETTERING_PATH)), "lettering differs");
  assert.ok(renderer.includes(JSON.stringify(UNDERLINE_PATH)), "underline differs");
});
