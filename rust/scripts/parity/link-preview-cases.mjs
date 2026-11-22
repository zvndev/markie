// Electron's own link preview rules (electron/link-preview.js) on a battery
// of inputs, written as the fixture markie-core's `link_preview_electron`
// test holds Markie RS to. Regenerate after changing the cases:
//
//   node rust/scripts/parity/link-preview-cases.mjs > rust/crates/markie-core/tests/fixtures/link_preview_electron.json
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(repo, "package.json"));
const { parseMeta, parseTarget, isPrivateAddress } = require(path.join(repo, "electron/link-preview.js"));

const html = [
  `<head><title>Plain</title></head>`,
  `<meta property="og:title" content="OG"><meta name="twitter:title" content="TW"><title>T</title>`,
  `<meta name="description" property="og:title" content="property wins">`,
  `<meta property="" name="description" content="empty property falls to name">`,
  `<meta property="og:title" property="og:description" content="last property wins">`,
  `<meta property="og:title" content="first" content="second">`,
  `<meta property="og:title" content="one"><meta property="og:title" content="two">`,
  `<meta property="og:title" content="">  <meta property="og:title" content="after empty">`,
  `<META PROPERTY='og:site_name' CONTENT='Single &amp; quoted'>`,
  `<meta name=description content=unquoted>`,
  `<title>  Spaced\n\t out   title </title>`,
  `<title>&lt;b&gt; &quot;q&quot; &#39;a&#x27; &nbsp;x&nbsp; &#233; &#xe9; &#12a; &bogus; &#x110000;</title>`,
  `<title>${"word ".repeat(80)}</title>`,
  `<title>${"😀".repeat(310)}</title>`,
  `<title>${"a".repeat(298)}😀😀</title>`,
  `<meta property="og:image" content="https://x.example/a.png"><meta name="twitter:image" content="https://x.example/b.png">`,
  `<meta property="og:image:url" content="https://x.example/c.png">`,
  `<meta name="twitter:description" content="tw desc"><meta name="description" content="desc">`,
  `<meta name="application-name" content="App">`,
  `<head></head><body><meta property="og:title" content="in body"><title>body</title></body>`,
  `<HEAD><TITLE>Upper</TITLE></HEAD>`,
  `<title>a﻿b c</title>`,
  `<meta property="og:title" content="   ">  <title>fallback</title>`,
  `<meta/><meta><meta property="og:title"/>`,
  `<title>never closed`,
  `<title>   </title>`,
  `<title>${"a".repeat(299)}😀</title>`,
];

const urls = [
  "https://example.com/page",
  "http://example.com/a?b=1#frag",
  "https://example.com:8443/",
  "https://user:pw@example.com/",
  "ftp://example.com/",
  "javascript:alert(1)",
  "https://localhost/",
  "https://foo.localhost/",
  "https://printer.local/",
  "https://example.com./x",
  "https://EXAMPLE.com/Path",
  "https://example.com/?token=1",
  "https://example.com/?api_key=1",
  "https://example.com/?apiKey=1",
  "https://example.com/?monkey=1",
  "https://example.com/?code=1",
  "https://example.com/?zipcode=1",
  "https://example.com/?x-sig=1",
  "https://example.com/#access_token=abc",
  "https://example.com/#section",
  "https://example.com/reset-password/abc",
  "https://example.com/auth/callback",
  "https://example.com/auth/callbacks",
  "https://127.0.0.1/",
  "https://10.1.2.3/",
  "https://8.8.8.8/",
  "https://[::1]/",
  "https://[2606:4700::1111]/",
  "https://[2001:db8::1]/",
  "https://[::ffff:8.8.8.8]/",
  "https://169.254.169.254/latest",
  "https://例え.jp/パス",
  "https://example.com/a b",
  "not a url",
  "https://" + "a".repeat(8200) + ".com/",
];

const addresses = [
  "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.128.0.1", "127.0.0.1", "169.254.1.1", "172.15.0.1", "172.16.0.1",
  "172.31.255.255", "172.32.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1",
  "198.51.100.1", "203.0.113.1", "203.0.114.1", "224.0.0.1", "255.255.255.255", "8.8.8.8", "1.1.1.1",
  "::", "::1", "fe80::1", "fc00::1", "2000::1", "2001:db8::1", "2001:100::1", "2001:200::1", "2002::1",
  "2606:4700::1111", "3fff::1", "3fff:1000::1", "4000::1", "::ffff:8.8.8.8",
];

const target = (u) => {
  const t = parseTarget(u);
  if (!t) return null;
  // Electron refuses a private literal address one step later, before any
  // connection; Markie RS refuses it here. Either way nothing is fetched.
  const host = t.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) return null;
  return t.href;
};

// A lone surrogate left by a UTF-16 slice is drawn as U+FFFD.
const wellFormed = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v.toWellFormed() : v]));

console.log(JSON.stringify({
  meta: html.map((h) => ({ html: h, out: wellFormed(parseMeta(h)) })),
  targets: urls.map((u) => ({ url: u, out: target(u) })),
  private: addresses.map((a) => ({ address: a, out: isPrivateAddress(a) })),
}, null, 1));
