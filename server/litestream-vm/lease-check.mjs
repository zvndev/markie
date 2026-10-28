// The fence for a SQLite app whose Litestream runs inside its container
// (zvn-infra docs/kata.md, "SQLite apps"). Canonical copy: zvn-infra
// kamal/sqlite-in-vm/lease-check.mjs. Each app image carries a copy at
// /opt/litestream-vm/lease-check.mjs, run by /opt/litestream-vm/init before
// anything opens the database.
//
// The same check as `zvn-sqlite preflight` on the box: the app's lease in B2
// names this box, and the box's copy was made for that lease's epoch. The
// box's half is the marker zvn-sqlite writes next to the database,
// <data dir>/.zvn-sqlite-writer (epoch, state, host). A box that died as the
// writer and comes back after a failover has an old epoch, so its container
// stops here instead of shipping a stale copy over the real replica.
//
// Exit 0 to go on. Anything else refuses, with the reason on stderr.
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
function refuse(why) {
  console.error(`lease-check: ${why}; refusing to start ${env.LITESTREAM_APP || "the app"}`);
  process.exit(1);
}
function need(name) {
  const v = env[name];
  if (!v) refuse(`${name} is not set`);
  return v;
}

const app = need("LITESTREAM_APP");
const db = need("LITESTREAM_DB");
const bucket = need("LITESTREAM_BUCKET");
const prefix = need("LITESTREAM_PREFIX");
const endpoint = new URL(need("LITESTREAM_ENDPOINT"));
const region = need("LITESTREAM_REGION");
const keyId = need("LITESTREAM_ACCESS_KEY_ID");
const secret = need("LITESTREAM_SECRET_ACCESS_KEY");
// The box this container runs on. Kamal sets it, and so does `zvn-sqlite
// start` for a container it runs from the standby kit.
const me = need("KAMAL_HOST");

function readKv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

const markerPath = join(dirname(db), ".zvn-sqlite-writer");
let marker;
try {
  marker = readKv(readFileSync(markerPath, "utf8"));
} catch {
  refuse(`no ${markerPath}: zvn-sqlite has not made this box the writer (import, takeover or handover)`);
}
if (marker.host !== me) refuse(`the marker in ${dirname(db)} was written on ${marker.host}, not on ${me}`);
if (marker.state !== "writer") refuse(`this box's copy is ${marker.state || "unknown"} (epoch ${marker.epoch}), not the writer's`);
if (!existsSync(db)) refuse(`${db} is missing`);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

async function getLease() {
  const key = `${prefix}/${app}/LEASE`;
  const path = "/" + [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256("");
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["GET", path, "", `host:${endpoint.host}`, `x-amz-content-sha256:${payload}`,
    `x-amz-date:${amzDate}`, "", signed, payload].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSign = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSign).update(toSign).digest("hex");
  const res = await fetch(`${endpoint.origin}${path}`, {
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: await res.text() };
}

// Right after a box boots, the VM's resolver can need a few seconds
// (docs/kata.md, DNS). Retry a network failure or a 5xx for about 30 s.
let lease;
for (let attempt = 1; ; attempt++) {
  let why;
  try {
    const r = await getLease();
    if (r.status === 200) { lease = readKv(r.body); break; }
    if (r.status === 404) refuse(`${app} has no lease in B2`);
    if (r.status < 500) refuse(`reading the lease returned HTTP ${r.status}`);
    why = `HTTP ${r.status}`;
  } catch (e) {
    why = e.cause?.code || e.name || String(e);
  }
  if (attempt >= 10) refuse(`could not read the lease (${why})`);
  await new Promise((r) => setTimeout(r, 3000));
}

if (lease.holder !== me) refuse(`the lease is held by ${lease.holder || "nobody"}, not ${me}`);
if (lease.epoch !== marker.epoch) refuse(`the lease is epoch ${lease.epoch}, this box's copy is epoch ${marker.epoch}`);
console.log(`lease-check: ${me} holds ${app}'s lease, epoch ${lease.epoch}, and its copy matches`);
