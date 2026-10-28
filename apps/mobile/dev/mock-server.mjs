#!/usr/bin/env node
// A stand-in for the Markie server's mobile surface, so the app runs end to
// end before the real routes land. Dependency-free; development only.
//
// It speaks the shapes in docs/mobile/AGENT-LINKS-CONTRACT.md:
//   POST /api/auth/email-otp/send-verification-otp  {email, type:"sign-in"}
//   POST /api/auth/sign-in/email-otp                {email, otp} -> set-auth-token
//   POST /api/auth/sign-out
//   GET  /api/me
//   GET  /api/docs/recent?limit=&before=            {docs:[recent item]}
//   GET  /api/docs/:id                              {doc:{..., format, origin}}
//   GET  /api/docs/:id/links                        {links:[{ref, target}]}
//   GET  /api/docs/:id/assets/file?ref=             a picture the document names (Range honored)
//   GET  /s/:token/raw                              a public share's markdown
//   GET  /s/:token/assets?ref=                      a public share's picture
//
// Usage: node dev/mock-server.mjs [--port 8790] [--host 127.0.0.1]
// Every sign-in code is 123456 (or $MOCK_OTP). Nothing is persisted.
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(arg("port", process.env.PORT ?? 8790));
const HOST = arg("host", "127.0.0.1");
const OTP = process.env.MOCK_OTP ?? "123456";

const sample = (name) => readFileSync(fileURLToPath(new URL(`../../../docs/document-testing/samples/${name}`, import.meta.url)), "utf8");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const started = Date.now();
const ago = (ms) => new Date(started - ms).toISOString();

const LAUNCH_BRIEF = `---
markie:
  project: launch
---

# Launch brief

Claude put this together from the planning thread. **Three things** need a decision before Friday, and the counter below tracks the open ones.

> **Decision needed.** Ship the mobile reader to TestFlight first, or wait for comments on mobile? The recommendation is *TestFlight first*: reading is the whole job of v1.

## Status

| Track | Owner | State |
| --- | --- | :---: |
| Server routes | WS1 | In review |
| Agent guidance | WS2 | Done |
| Desktop panel | WS3 | In progress |
| Mobile app | WS4 | In progress |

## This week

- [x] Freeze the link contract
- [x] Seed the mock server
- [ ] Screenshot every screen, light and dark
- [ ] Hand the ship checklist to Kirby

## The math behind the estimate

Reading time scales with length, so a document of $n$ words takes about $t = \\frac{n}{238}$ minutes. For the whole brief:

$$
t_{total} = \\sum_{i=1}^{k} \\frac{n_i}{238}
$$

## How agents send a link

\`\`\`ts
const result = await markie.createDocument({ name: "Launch brief.md", content });
reply(\`Here it is: \${result.markdownLink}\`);
\`\`\`

Open [the interactive counter](Counter.wd) to try a Darkmown document, read the [Markie site](https://markiedocs.com), or [email the team](mailto:team@example.com).

---

Questions go in the planning thread.[^1]

[^1]: Comments on mobile arrive after v1.
`;

const READING_LIST = `# Reading list

1. *The Design of Everyday Things*, Don Norman
2. *A Pattern Language*, Christopher Alexander
3. *Thinking in Systems*, Donella Meadows

Notes go under each title as I finish them.
`;

const ROADMAP = `# Q3 roadmap

## Themes

- **Reading everywhere.** Phone and tablet readers for every Markie Cloud document.
- **Agents as authors.** Agents write rich documents and send links, not walls of text.

## Milestones

| Month | Milestone |
| --- | --- |
| July | Agent tokens and the hosted MCP |
| August | Mobile reader beta |
| September | Comments on mobile |
`;

const DEPLOY_NOTES = `Deploy notes, staging
=====================

09:12  build 418 green
09:14  migrations applied (docs.format, docs.origin_kind, agent_tokens)
09:15  smoke: /api/docs/recent 200, /mcp initialize 200
09:20  rolled to 100%

Nothing to follow up.
`;

const READING_REPORT = `# Weekly reading report

Markie readers opened **1,284 documents** this week, up 18% on last week. Most of the growth came from links agents sent.

![Documents opened per day, Monday to Sunday](charts/opened-per-day.png)

Thursday's peak is the launch brief going out to the whole team. The weekend dip is normal.

## What to watch

- Links opened on phones are now a third of all opens.
- Darkmown documents get opened twice as often as plain ones.
`;

// A real PNG for the report's chart, drawn here so the mock stays
// dependency-free: a bar chart on a white card, no text.
function chartPng() {
  const width = 1200;
  const height = 675;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  const bars = [0.42, 0.55, 0.61, 0.93, 0.7, 0.33, 0.28];
  const plot = { left: 90, right: width - 70, top: 70, bottom: height - 80 };
  const slot = (plot.right - plot.left) / bars.length;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      let rgb = [255, 255, 255];
      const gridline = y > plot.top && y < plot.bottom && (plot.bottom - y) % 120 === 0;
      if (gridline && x > plot.left && x < plot.right) rgb = [228, 228, 231];
      if (y === plot.bottom && x > plot.left - 10 && x < plot.right) rgb = [161, 161, 170];
      const index = Math.floor((x - plot.left) / slot);
      if (index >= 0 && index < bars.length) {
        const inset = slot * 0.22;
        const x0 = plot.left + index * slot + inset;
        const x1 = plot.left + (index + 1) * slot - inset;
        const top = plot.bottom - bars[index] * (plot.bottom - plot.top);
        if (x >= x0 && x < x1 && y >= top && y < plot.bottom) {
          // Markie violet, the peak in blue, a soft fade toward the base.
          const fade = (y - top) / (plot.bottom - top);
          const base = index === 3 ? [37, 99, 235] : [139, 92, 246];
          rgb = base.map((c) => Math.round(c + (255 - c) * fade * 0.35));
        }
      }
      rows.set(rgb, row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const FILLER = [
  ["Standup notes.md", "# Standup notes\n\n- Mobile screenshots done\n- Contract frozen\n"],
  ["Ideas.md", "# Ideas\n\n- Offline reading for opened documents\n- Widgets for recent agent documents\n"],
  ["Interview questions.md", "# Interview questions\n\n1. Tell me about a document you rewrote.\n2. What makes a link worth tapping?\n"],
  ["Travel checklist.md", "# Travel checklist\n\n- [ ] Passport\n- [ ] Chargers\n- [x] Book the hotel\n"],
  ["Retro notes.md", "# Retro\n\n## Went well\n\nShipping the contract early.\n\n## Change\n\nScreenshot earlier.\n"],
];

const docs = new Map();
function seed({ id, name, content, updatedAgo, createdAgo = updatedAgo, agent = null, shared = false, sharedBy = null, role = "owner", unlisted = false }) {
  const format = /\.wd$/i.test(name) ? "darkmown" : /\.(txt|text|log)$/i.test(name) ? "text" : "markdown";
  docs.set(id, {
    id, name, content, format,
    version: 1,
    hash: randomBytes(8).toString("hex"),
    createdAt: ago(createdAgo),
    updatedAt: ago(updatedAgo),
    origin: agent ? { kind: "agent", agent } : { kind: "app", agent: null },
    shared, sharedBy, role, unlisted,
  });
}

seed({ id: "agent-brief", name: "Launch brief.md", content: LAUNCH_BRIEF, updatedAgo: 12 * MIN, agent: "Claude Code" });
seed({ id: "reading-report", name: "Weekly reading report.md", content: READING_REPORT, updatedAgo: 25 * MIN, agent: "Claude Code" });
// Opened only by link (markie-mobile://d/edge-cases): the hostile cases, kept out of Recent.
const EDGE_CASES = [
  "# Edge cases",
  "",
  "Two pictures the server holds at 95 MB each. The app refuses both after reading 20 MB of each.",
  "",
  "![first](charts/huge.png)",
  "",
  "![second](charts/huge-2.png)",
  "",
  "[Jump to a target past the right edge](#far-away)",
  "",
  '<div style="margin-left:900px"><h2 id="far-away">Far away</h2></div>',
  "",
  "The end of the edge cases.",
  "",
].join("\n");
seed({ id: "edge-cases", name: "Edge cases.md", content: EDGE_CASES, updatedAgo: 90 * DAY, unlisted: true });
seed({ id: "counter-wd", name: "Counter.wd", content: sample("Counter.wd"), updatedAgo: 40 * MIN, agent: "Codex" });
seed({ id: "expense-form-wd", name: "Expense check.wd", content: sample("Local-form.wd"), updatedAgo: 5 * HOUR, agent: "Claude Code" });
seed({ id: "reading-list", name: "Reading list.md", content: READING_LIST, updatedAgo: DAY + 3 * HOUR });
seed({ id: "q3-roadmap", name: "Q3 roadmap.md", content: ROADMAP, updatedAgo: 3 * DAY, shared: true, sharedBy: "ana@example.com", role: "viewer" });
seed({ id: "deploy-notes", name: "Deploy notes.txt", content: DEPLOY_NOTES, updatedAgo: 4 * DAY, agent: "Cursor" });
FILLER.forEach(([name, content], index) =>
  seed({ id: `filler-${index + 1}`, name, content, updatedAgo: (12 + index * 9) * DAY, shared: index === 2, sharedBy: index === 2 ? "sam@example.com" : null, role: index === 2 ? "editor" : "owner" })
);

const docLinks = new Map([["agent-brief", [{ ref: "Counter.wd", target: "counter-wd" }]]]);
const publicShares = new Map([["pub_launch_brief_demo_token", "agent-brief"], ["pub_reading_report_demo_token", "reading-report"]]);
// The files a document names beside itself, as the desktop syncs them.
// The edge-cases document's pictures are 95 MB of zeros, made only for the
// bytes a Range asks for, so the app's picture cap can be tested.
const HUGE_BYTES = 95_000_000;
const HUGE = { mime: "image/png", size: HUGE_BYTES, slice: (start, end) => Buffer.alloc(end - start + 1) };
const CHART = chartPng();
const docAssets = new Map([
  ["reading-report", new Map([["charts/opened-per-day.png", { mime: "image/png", size: CHART.length, slice: (start, end) => CHART.subarray(start, end + 1) }]])],
  ["edge-cases", new Map([["charts/huge.png", HUGE], ["charts/huge-2.png", HUGE]])],
]);

// MARKIE_MOCK_ASSET_DELAY_MS=4000 holds every picture back, to look at the loading state.
const ASSET_DELAY_MS = Number(process.env.MARKIE_MOCK_ASSET_DELAY_MS) || 0;

function sendAsset(req, res, log, docId, ref) {
  if (ASSET_DELAY_MS) return void setTimeout(() => sendAssetNow(req, res, log, docId, ref), ASSET_DELAY_MS);
  sendAssetNow(req, res, log, docId, ref);
}

function sendAssetNow(req, res, log, docId, ref) {
  const asset = docAssets.get(docId)?.get(ref ?? "");
  if (!asset) { log(404); res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end("Not found"); return; }
  // The real server's asset policy (server/src/assets.ts serveAsset), range
  // handling included: bytes=a-b, bytes=a-, bytes=-n; the end is clamped.
  const headers = { "content-type": asset.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range ?? "").trim());
  if (req.headers.range && (!m || (!m[1] && !m[2]))) { log(416); res.writeHead(416, { "content-type": "text/plain; charset=utf-8" }); res.end("Range Not Satisfiable"); return; }
  if (m && !(!m[1] && Number(m[2]) >= asset.size)) {
    const start = m[1] ? Number(m[1]) : asset.size - Number(m[2]);
    const end = Math.min(m[1] && m[2] ? Number(m[2]) : asset.size - 1, asset.size - 1);
    if (start > end) { log(416); res.writeHead(416, { "content-type": "text/plain; charset=utf-8" }); res.end("Range Not Satisfiable"); return; }
    const body = asset.slice(start, end);
    log(206);
    res.writeHead(206, { ...headers, "content-length": body.length, "content-range": `bytes ${start}-${end}/${asset.size}` });
    res.end(body);
    return;
  }
  const body = asset.slice(0, asset.size - 1);
  log(200);
  res.writeHead(200, { ...headers, "content-length": body.length });
  res.end(body);
}
// A document that exists but belongs to someone else, for the "no access" state.
const FORBIDDEN_ID = "someone-elses-doc";

const sessions = new Map(); // token -> user
const users = new Map(); // email -> user

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 64_000) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  });
}

function userFor(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match ? sessions.get(match[1]) ?? null : null;
}

function originOf(req) {
  return `http://${req.headers.host ?? `${HOST}:${PORT}`}`;
}

function recentItem(doc, origin) {
  return {
    id: doc.id, name: doc.name, format: doc.format,
    createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    origin: doc.origin,
    shared: doc.shared, role: doc.role, sharedBy: doc.sharedBy,
    privateLink: `${origin}/d/${doc.id}`,
  };
}

const CORS = {
  // Development only: the app's browser build at http://localhost:5174 reads this.
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-expose-headers": "set-auth-token, content-disposition",
};

const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
  const url = new URL(req.url ?? "/", originOf(req));
  const path = url.pathname;
  const log = (status) => console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${path}${url.search} -> ${status}`);
  const reply = (status, body, headers) => { log(status); send(res, status, body, headers); };

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && path === "/api/auth/email-otp/send-verification-otp") {
    const body = await readJson(req);
    if (!body || typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return reply(400, { code: "INVALID_EMAIL", message: "Invalid email" });
    }
    console.log(`\n  Sign-in code for ${body.email}: ${OTP}\n`);
    return reply(200, { success: true });
  }

  if (req.method === "POST" && path === "/api/auth/sign-in/email-otp") {
    const body = await readJson(req);
    if (!body || typeof body.email !== "string" || typeof body.otp !== "string") return reply(400, { code: "INVALID_REQUEST", message: "Invalid request" });
    if (body.otp !== OTP) return reply(400, { code: "INVALID_OTP", message: "Invalid OTP" });
    const email = body.email.trim().toLowerCase();
    const user = users.get(email) ?? { id: randomUUID(), email, name: email.split("@")[0], emailVerified: true };
    users.set(email, user);
    const token = randomBytes(24).toString("base64url");
    sessions.set(token, user);
    return reply(200, { redirect: false, token, user }, { "set-auth-token": token });
  }

  if (req.method === "POST" && path === "/api/auth/sign-out") {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (token) sessions.delete(token);
    return reply(200, { success: true });
  }

  if (req.method === "GET" && path === "/api/me") {
    const user = userFor(req);
    return reply(200, { user: user ? { id: user.id, email: user.email, name: user.name } : null });
  }

  const publicRaw = /^\/s\/([^/]+)\/raw$/.exec(path);
  if (req.method === "GET" && publicRaw) {
    const doc = docs.get(publicShares.get(decodeURIComponent(publicRaw[1])) ?? "");
    if (!doc) return reply(404, "Not found");
    const filename = doc.name.toLowerCase().endsWith(".md") ? doc.name : `${doc.name}.md`;
    log(200);
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    res.end(doc.content);
    return;
  }

  const publicAsset = /^\/s\/([^/]+)\/assets$/.exec(path);
  if (req.method === "GET" && publicAsset) {
    return sendAsset(req, res, log, publicShares.get(decodeURIComponent(publicAsset[1])) ?? "", url.searchParams.get("ref"));
  }

  // The web fallback when the app is not installed.
  const page = /^\/([ds])\/([^/]+)$/.exec(path);
  if (req.method === "GET" && page) {
    log(200);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Markie</title><p>This is the mock server's stand-in for the web page at ${path}. With the app installed, the link opens there.</p>`);
    return;
  }

  if (path.startsWith("/api/docs")) {
    const user = userFor(req);
    if (!user) return reply(401, { error: "unauthorized" });

    if (req.method === "GET" && path === "/api/docs/recent") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const before = url.searchParams.get("before");
      const items = [...docs.values()]
        .filter((doc) => !doc.unlisted && (!before || doc.updatedAt < before))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map((doc) => recentItem(doc, originOf(req)));
      return reply(200, { docs: items });
    }

    const links = /^\/api\/docs\/([^/]+)\/links$/.exec(path);
    if (req.method === "GET" && links) {
      const id = decodeURIComponent(links[1]);
      if (!docs.has(id)) return reply(404, { error: "not found" });
      return reply(200, { links: docLinks.get(id) ?? [] });
    }

    const asset = /^\/api\/docs\/([^/]+)\/assets\/file$/.exec(path);
    if (req.method === "GET" && asset) {
      return sendAsset(req, res, log, decodeURIComponent(asset[1]), url.searchParams.get("ref"));
    }

    const one = /^\/api\/docs\/([^/]+)$/.exec(path);
    if (req.method === "GET" && one) {
      const id = decodeURIComponent(one[1]);
      if (id === FORBIDDEN_ID) return reply(403, { error: "forbidden" });
      const doc = docs.get(id);
      if (!doc) return reply(404, { error: "not found" });
      return reply(200, {
        doc: {
          id: doc.id, name: doc.name, version: doc.version, content: doc.content, hash: doc.hash,
          updated_at: doc.updatedAt, format: doc.format, origin: doc.origin, role: doc.role,
        },
      });
    }

    // The desktop sync's save route (server/src/docs.ts): baseVersion must be
    // the version on the server, or 0 to create. Viewers can't save.
    if (req.method === "PUT" && one) {
      const id = decodeURIComponent(one[1]);
      const body = await readJson(req);
      if (!body || typeof body.content !== "string" || !body.name) return reply(400, { error: "bad request" });
      if (id === FORBIDDEN_ID) return reply(403, { error: "forbidden" });
      const existing = docs.get(id);
      if (existing && existing.role === "viewer") return reply(403, { error: "forbidden" });
      if (existing && existing.version !== body.baseVersion) return reply(409, { error: "conflict", serverVersion: existing.version });
      const name = String(body.name);
      const format = /\.wd$/i.test(name) ? "darkmown" : /\.(txt|text|log)$/i.test(name) ? "text" : "markdown";
      const updatedAt = new Date().toISOString();
      const doc = existing
        ? { ...existing, name, content: body.content, hash: body.hash, version: existing.version + 1, updatedAt }
        : { id, name, content: body.content, format, version: 1, hash: body.hash, createdAt: updatedAt, updatedAt, origin: { kind: "app", agent: null }, shared: false, sharedBy: null, role: "owner", unlisted: false };
      docs.set(id, doc);
      return reply(200, { id, version: doc.version, updated_at: updatedAt });
    }
  }

  reply(404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`Markie mock server on http://${HOST}:${port}`);
  console.log(`  Sign-in code: ${OTP} for any address.`);
  console.log(`  Documents: ${[...docs.keys()].join(", ")}`);
  console.log(`  No-access document: ${FORBIDDEN_ID}. Public share: /s/${[...publicShares.keys()][0]}`);
  console.log(`  Android emulator: use http://10.0.2.2:${port} as the server, or run adb reverse tcp:${port} tcp:${port}.`);
});
