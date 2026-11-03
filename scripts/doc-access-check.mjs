#!/usr/bin/env node
// Who can reach a private document, asked of a real server from the outside.
//
// Starts a throwaway server with its own database, makes five accounts, and
// has Alice write a document carrying a unique secret line. Then every route
// that serves, lists, changes or streams a document is called as someone who
// should be refused: nobody signed in, Bob (signed in, not on the document),
// Eve (signed up, address never proved), Carol (viewer, for writes) and Dave
// (an editor, after Alice removes him). A refusal passes only if its status
// says no AND the secret appears nowhere in what came back, so a 403 that
// still carries the text fails. Each write is also sent by Alice first, so a
// refusal is known to come from the access check and not from a bad request.
//
// Links from share and invite emails are checked too: holding one is never
// enough on its own, and the live-editing socket is asked through a pass for
// one document rather than the account's session token.
//
// Usage: node scripts/doc-access-check.mjs   (no window; safe to run anywhere)
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const Database = require("better-sqlite3");
const WebSocket = require("ws");
const Y = require("yjs");
const { WebsocketProvider } = require("y-websocket");
const encoding = require("lib0/encoding");
const syncProtocol = require("y-protocols/sync");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = `SECRET-${randomBytes(9).toString("hex")}`;
const NAME = `Private plan ${randomBytes(4).toString("hex")}.md`;
const results = [];
const check = (name, passed, detail = "") => {
  results.push({ name, passed });
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
};
const section = (title) => process.stdout.write(`\n${title}\n`);

async function pickPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

let stopServer = () => {};
const tempPaths = [];

async function startServer(port, dir) {
  const env = { ...process.env, DB_PATH: path.join(dir, "markie.db"), PORT: String(port), BETTER_AUTH_URL: `http://localhost:${port}` };
  delete env.NODE_ENV;
  const cwd = path.join(root, "server");
  const migrate = spawn(process.execPath, ["--experimental-strip-types", "src/migrate.ts"], { cwd, env, stdio: "ignore" });
  await new Promise((res, rej) => migrate.on("exit", (code) => (code === 0 ? res() : rej(new Error(`migrate exited ${code}`)))));
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  stopServer = () => child.kill("SIGTERM");
  process.on("exit", () => child.kill("SIGTERM"));
  for (let i = 0; i < 150; i += 1) {
    const res = await fetch(`http://localhost:${port}/health`).catch(() => null);
    if (res && res.status < 500) return;
    await sleep(200);
  }
  throw new Error("server did not start");
}

async function main() {
  const serverDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-access-")));
  tempPaths.push(serverDir);
  const port = await pickPort();
  const BASE = `http://localhost:${port}`;
  await startServer(port, serverDir);
  const ORIGIN = { Origin: "http://localhost:3000" };

  const call = async (token, method, route, body, extraHeaders = {}) => {
    const res = await fetch(`${BASE}${route}`, {
      method,
      redirect: "manual",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...ORIGIN,
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
  };
  const db = () => new Database(path.join(serverDir, "markie.db"));
  const signUp = async (name, email, { verify = true } = {}) => {
    let res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ORIGIN },
      body: JSON.stringify({ name, email, password: "password-123" }),
    });
    if (!res.ok) throw new Error(`sign-up ${email}: ${res.status} ${await res.text()}`);
    const signUpToken = res.headers.get("set-auth-token");
    if (!verify) return signUpToken;
    const handle = db();
    handle.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run(email);
    handle.close();
    res = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ORIGIN },
      body: JSON.stringify({ email, password: "password-123" }),
    });
    if (!res.ok) throw new Error(`sign-in ${email}: ${res.status} ${await res.text()}`);
    return res.headers.get("set-auth-token");
  };

  const stamp = Date.now();
  const email = (who) => `${who}.${stamp}@test.local`;
  const alice = await signUp("Alice", email("alice"));
  const bob = await signUp("Bob", email("bob"));
  const carol = await signUp("Carol", email("carol"));
  const dave = await signUp("Dave", email("dave"));
  const eve = await signUp("Eve", email("eve"), { verify: false });

  const content = `# ${NAME}\n\n${SECRET}\n`;
  const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  const D = `doc-${stamp}`;
  let r = await call(alice, "PUT", `/api/docs/${D}`, { name: NAME, content, hash: hash(content), baseVersion: 0 });
  if (r.status !== 200) throw new Error(`create: ${r.status} ${r.text}`);
  for (const [who, role] of [["carol", "viewer"], ["dave", "editor"]]) {
    r = await call(alice, "POST", `/api/docs/${D}/shares`, { email: email(who), role });
    if (r.status >= 300) throw new Error(`share ${who}: ${r.status} ${r.text}`);
  }
  r = await call(alice, "POST", `/api/docs/${D}/threads`, { anchor: { quote: SECRET }, body: `comment about ${SECRET}` });
  const threadOk = r.status < 300;
  const threadId = threadOk ? JSON.parse(r.text)?.thread?.id ?? JSON.parse(r.text)?.id ?? null : null;

  // A refusal: the status says no, and nothing of the document came back.
  const refused = (res) => res.status >= 300 && !res.text.includes(SECRET) && !res.text.includes(NAME);
  const show = (res) => `HTTP ${res.status}${res.text.includes(SECRET) ? " CONTAINS THE SECRET" : ""}${res.text.includes(NAME) ? " CONTAINS THE NAME" : ""}: ${res.text.slice(0, 120).replace(/\s+/g, " ")}`;

  const readRoutes = [
    ["GET", `/api/docs/${D}`],
    ["GET", `/api/docs/${D}/access`],
    ["GET", `/api/docs/${D}/shares`],
    ["GET", `/api/docs/${D}/public-link`],
    ["GET", `/api/docs/${D}/threads`],
    ["GET", `/api/docs/${D}/theme`],
    ["GET", `/api/docs/${D}/links`],
    ["GET", `/api/docs/${D}/assets/file?hash=${"0".repeat(64)}`],
    ["GET", `/d/${D}`],
    ["GET", `/d/${D}/raw`],
    ["GET", `/d/${D}/assets`],
  ];
  const writeRoutes = [
    ["PUT", `/api/docs/${D}`, () => ({ name: NAME, content: "overwritten", hash: hash("overwritten"), baseVersion: 1 })],
    ["POST", `/api/docs/${D}/shares`, () => ({ email: email("bob"), role: "editor" })],
    ["POST", `/api/docs/${D}/public-link`, () => ({})],
    ["PUT", `/api/docs/${D}/theme`, () => ({ tokens: null })],
    ["PUT", `/api/docs/${D}/links`, () => ({ links: [] })],
    ["POST", `/api/docs/${D}/threads`, () => ({ anchor: { quote: "x" }, body: "intruder comment" })],
    ...(threadId ? [["POST", `/api/docs/${D}/threads/${threadId}/status`, () => ({ status: "resolved" })]] : []),
    ["DELETE", `/api/docs/${D}/shares/${encodeURIComponent(email("carol"))}`, () => undefined],
    ["DELETE", `/api/docs/${D}`, () => undefined],
  ];

  section("Reads, as someone who is not on the document");
  for (const [label, token] of [["signed out", null], ["Bob (stranger)", bob], ["Eve (unverified)", eve]]) {
    for (const [method, route] of readRoutes) {
      const res = await call(token, method, route);
      check(`${label}: ${method} ${route.replace(D, ":id")}`, refused(res), refused(res) ? "" : show(res));
    }
  }

  section("Writes, as someone who may not make them");
  const actors = [["signed out", null], ["Bob (stranger)", bob], ["Eve (unverified)", eve], ["Carol (viewer)", carol]];
  for (const [method, route, body] of writeRoutes) {
    if (method === "DELETE" && route === `/api/docs/${D}`) continue; // deleted last, below
    for (const [label, token] of actors) {
      // Viewers may comment; that is a feature, reported separately below.
      if (label.startsWith("Carol") && route.endsWith("/threads") && method === "POST") continue;
      const res = await call(token, method, route, body());
      check(`${label}: ${method} ${route.replace(D, ":id")}`, refused(res), refused(res) ? "" : show(res));
    }
  }
  r = await call(alice, "GET", `/api/docs/${D}`);
  check("the document is unchanged after every refused write", r.status === 200 && r.text.includes(SECRET), show(r));
  r = await call(carol, "GET", `/api/docs/${D}`);
  check("control: Carol (viewer) can read it", r.status === 200 && r.text.includes(SECRET), `HTTP ${r.status}`);
  r = await call(carol, "POST", `/api/docs/${D}/threads`, { anchor: { quote: "x" }, body: "viewer comment" });
  process.stdout.write(`       note: a viewer adding a comment gets HTTP ${r.status}\n`);

  section("Links from share and invite emails, without signing in");
  const dbRead = (sql, ...args) => {
    const handle = db();
    try {
      return handle.prepare(sql).get(...args);
    } finally {
      handle.close();
    }
  };
  const carolId = dbRead('SELECT id FROM "user" WHERE email = ?', email("carol"))?.id;
  const memberToken = dbRead("SELECT token FROM shares WHERE doc_id = ? AND user_id = ?", D, carolId)?.token;
  check("Carol's share-email link exists to test (control)", !!memberToken, "");
  if (memberToken) {
    for (const suffix of ["", "/raw", "/assets?ref=a.png"]) {
      const route = `/d/${D}${suffix}${suffix.includes("?") ? "&" : "?"}k=${encodeURIComponent(memberToken)}`;
      const res = await call(null, "GET", route);
      check(`signed out, holding Carol's link: GET /d/:id${suffix.split("?")[0]}`, refused(res), refused(res) ? "" : show(res));
      const asBob = await call(bob, "GET", route);
      check(`Bob, holding Carol's link: GET /d/:id${suffix.split("?")[0]}`, refused(asBob), refused(asBob) ? "" : show(asBob));
    }
    const asCarol = await call(carol, "GET", `/d/${D}/raw`);
    check("control: Carol signed in reads /d/:id/raw", asCarol.status === 200 && asCarol.text.includes(SECRET), `HTTP ${asCarol.status}`);
  }
  const outsider = `frank.${stamp}@test.local`;
  r = await call(alice, "POST", `/api/docs/${D}/shares`, { email: outsider, role: "editor" });
  const inviteToken = dbRead("SELECT token FROM pending_shares WHERE doc_id = ? AND email = ?", D, outsider)?.token;
  check("an invite to an address with no account exists to test (control)", !!inviteToken, `HTTP ${r.status}`);
  if (inviteToken) {
    for (const suffix of ["", "/raw"]) {
      const res = await call(null, "GET", `/d/${D}${suffix}?k=${encodeURIComponent(inviteToken)}`);
      check(`signed out, holding an invite link: GET /d/:id${suffix}`, !res.text.includes(SECRET), show(res));
    }
    const asBob = await call(bob, "GET", `/d/${D}?k=${encodeURIComponent(inviteToken)}`);
    check("Bob, holding someone else's invite link, gets nothing and claims nothing", refused(asBob) && !dbRead("SELECT 1 AS x FROM shares WHERE doc_id = ? AND user_id = (SELECT id FROM \"user\" WHERE email = ?)", D, email("bob")), show(asBob));
  }

  section("The public link, for members and after a removal");
  r = await call(alice, "POST", `/api/docs/${D}/public-link`, {});
  const firstLink = (JSON.parse(r.text || "{}").url ?? "").split("/s/")[1];
  for (const [label, token] of [["Carol (viewer)", carol], ["Dave (editor)", dave]]) {
    const res = await call(token, "GET", `/api/docs/${D}/public-link`);
    check(`${label}: GET /api/docs/:id/public-link`, res.status >= 400 && !(firstLink && res.text.includes(firstLink)), show(res));
  }
  r = await call(alice, "DELETE", `/api/docs/${D}/shares/${encodeURIComponent(email("carol"))}`);
  const removal = JSON.parse(r.text || "{}");
  const nextLink = (removal.url ?? "").split("/s/")[1];
  check("removing Carol says the public link was replaced", removal.publicLinkRotated === true && !!nextLink && nextLink !== firstLink, r.text.slice(0, 160));
  if (firstLink) {
    const old = await call(null, "GET", `/s/${firstLink}`);
    check("the link Carol could have kept stops working", refused(old), refused(old) ? "" : show(old));
  }
  if (nextLink) {
    const fresh = await call(null, "GET", `/s/${nextLink}`);
    check("the replacement link works (control)", fresh.status === 200 && fresh.text.includes(SECRET), `HTTP ${fresh.status}`);
    await call(alice, "DELETE", `/api/docs/${D}/public-link`);
  }
  r = await call(carol, "GET", `/api/docs/${D}`);
  check("Carol, removed, can no longer read it", refused(r), refused(r) ? "" : show(r));
  r = await call(alice, "POST", `/api/docs/${D}/shares`, { email: email("carol"), role: "viewer" });

  section("Listings and search, as Bob");
  for (const route of ["/api/docs", "/api/docs/recent", "/api/docs/shared-by-me", "/api/docs/share-contacts"]) {
    const res = await call(bob, "GET", route);
    const leaks = res.text.includes(D) || res.text.includes(SECRET) || res.text.includes(NAME) || res.text.includes(email("alice"));
    check(`Bob: GET ${route} shows nothing of Alice's`, !leaks, leaks ? show(res) : "");
  }

  section("Agent tokens and MCP, as Bob's agent");
  r = await call(bob, "POST", "/api/agent-tokens", { name: "bob agent" });
  const bobAgent = JSON.parse(r.text || "{}").token;
  check("Bob can make an agent token (control)", typeof bobAgent === "string" && bobAgent.startsWith("mk_agent_"), `HTTP ${r.status}`);
  if (bobAgent) {
    let res = await call(bobAgent, "GET", `/api/agent/docs/${D}`);
    check("Bob's agent: GET /api/agent/docs/:id", refused(res), refused(res) ? "" : show(res));
    res = await call(bobAgent, "GET", "/api/agent/docs");
    check("Bob's agent: GET /api/agent/docs lists nothing of Alice's", !res.text.includes(D) && !res.text.includes(NAME), "");
    res = await call(bobAgent, "PUT", `/api/agent/docs/${D}`, { content: "agent overwrite" });
    check("Bob's agent: PUT /api/agent/docs/:id", refused(res), refused(res) ? "" : show(res));
    res = await call(bobAgent, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "markie_read_my_document", arguments: { id: D } } }, { Accept: "application/json, text/event-stream" });
    check("Bob's agent: MCP markie_read_my_document on Alice's id", !res.text.includes(SECRET) && !res.text.includes(NAME), show(res));
    res = await call(bobAgent, "POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "markie_update_document", arguments: { id: D, content: "mcp overwrite" } } }, { Accept: "application/json, text/event-stream" });
    const after = await call(alice, "GET", `/api/docs/${D}`);
    check("Bob's agent: MCP markie_update_document on Alice's id changes nothing", after.text.includes(SECRET), show(res));
  }
  res400: {
    const res = await call("mk_agent_" + "x".repeat(40), "GET", "/api/agent/docs");
    check("a made-up agent token is refused", res.status === 401, `HTTP ${res.status}`);
  }

  section("Public links");
  r = await call(alice, "POST", `/api/docs/${D}/public-link`, {});
  const linkToken = (JSON.parse(r.text || "{}").url ?? "").split("/s/")[1];
  check("Alice can make a public link (control)", !!linkToken, `HTTP ${r.status}`);
  if (linkToken) {
    process.stdout.write(`       link token length: ${linkToken.length} characters\n`);
    let res = await call(null, "GET", `/s/${linkToken}`);
    check("anyone with the link can read it while it exists (by design)", res.status === 200 && res.text.includes(SECRET), `HTTP ${res.status}`);
    res = await call(null, "GET", `/s/${linkToken.slice(0, -1)}${linkToken.endsWith("a") ? "b" : "a"}`);
    check("a link one character off is refused", refused(res), refused(res) ? "" : show(res));
    res = await call(alice, "DELETE", `/api/docs/${D}/public-link`);
    res = await call(null, "GET", `/s/${linkToken}`);
    check("a revoked link stops working", refused(res), refused(res) ? "" : show(res));
    res = await call(null, "GET", `/s/${linkToken}/raw`);
    check("a revoked link's raw text stops working", refused(res), refused(res) ? "" : show(res));
  }

  section("Live editing (the collab websocket)");
  const wsBase = `ws://localhost:${port}/collab`;
  const rawSocket = (credential, docId, kind = "token") =>
    new Promise((resolve) => {
      const url = `${wsBase}/${docId}${credential ? `?${kind}=${encodeURIComponent(credential)}` : ""}`;
      const ws = new WebSocket(url, { headers: ORIGIN });
      const chunks = [];
      let code = null;
      ws.on("message", (m) => chunks.push(Buffer.from(m)));
      // Ask for everything, the way a client with an empty document does. A
      // server that let this socket in answers with the whole document, so an
      // empty reply means it was refused, not merely that nobody asked.
      ws.on("open", () => {
        const ask = encoding.createEncoder();
        encoding.writeVarUint(ask, 0);
        syncProtocol.writeSyncStep1(ask, new Y.Doc());
        ws.send(encoding.toUint8Array(ask));
      });
      ws.on("close", (c) => (code = c));
      ws.on("error", () => {});
      setTimeout(() => {
        try { ws.close(); } catch {}
        resolve({ code, bytes: Buffer.concat(chunks) });
      }, 1500);
    });
  const passFor = async (token, docId) => {
    const res = await call(token, "POST", `/api/docs/${docId}/collab-ticket`, {});
    return { status: res.status, ticket: JSON.parse(res.text || "{}").ticket ?? null, text: res.text };
  };
  // Every client here joins the way the desktop now does: with a pass for
  // one document, never the session token. disableBc keeps clients in this
  // one process from syncing to each other directly, around the server.
  const provider = (pass, docId) => {
    const ydoc = new Y.Doc();
    const p = new WebsocketProvider(wsBase, docId, ydoc, { WebSocketPolyfill: WebSocket, params: { ticket: pass }, connect: true, disableBc: true });
    const closes = [];
    p.on("connection-close", (e) => closes.push(e?.code ?? null));
    const synced = new Promise((res) => (p.synced ? res() : p.once("sync", () => res())));
    return { ydoc, p, synced, closes };
  };
  const fragmentText = (ydoc) => ydoc.getXmlFragment("default").toString();

  // Alice writes the room's content the way her editor would.
  for (const [label, token] of [["signed out", null], ["Bob (stranger)", bob], ["Eve (unverified)", eve]]) {
    const pass = await passFor(token, D);
    check(`${label}: no live-editing pass for the document`, !pass.ticket && pass.status >= 400, `HTTP ${pass.status}`);
  }
  const owner = provider((await passFor(alice, D)).ticket, D);
  await owner.synced;
  owner.ydoc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(`live ${SECRET}`)]);
    owner.ydoc.getXmlFragment("default").insert(0, [paragraph]);
  });
  await sleep(600);
  for (const [label, token] of [["signed out", null], ["Bob (stranger)", bob], ["Eve (unverified)", eve]]) {
    const got = await rawSocket(token, D);
    const leaked = got.bytes.includes(Buffer.from(SECRET));
    check(`${label}: the live room sends nothing of the document`, !leaked, `close code ${got.code}, ${got.bytes.length} bytes received${leaked ? ", CONTAINS THE SECRET" : ""}`);
  }

  // Carol may read the room but not write it.
  const carolPass = (await passFor(carol, D)).ticket;
  check("control: Carol (viewer) gets a pass", !!carolPass, "");
  const otherDoc = `other-${stamp}`;
  const oc = `# Other\n\n${SECRET}-other\n`;
  await call(alice, "PUT", `/api/docs/${otherDoc}`, { name: "other.md", content: oc, hash: hash(oc), baseVersion: 0 });
  const seedOther = provider((await passFor(alice, otherDoc)).ticket, otherDoc);
  await seedOther.synced;
  seedOther.ydoc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(`other ${SECRET}-other`)]);
    seedOther.ydoc.getXmlFragment("default").insert(0, [paragraph]);
  });
  await sleep(400);
  const crossed = await rawSocket(carolPass, otherDoc, "ticket");
  check("Carol's pass for one document opens nothing on another", !crossed.bytes.includes(Buffer.from(`${SECRET}-other`)), `close code ${crossed.code}, ${crossed.bytes.length} bytes`);
  const forged = await rawSocket("not-a-real-pass", D, "ticket");
  check("a made-up pass opens nothing", !forged.bytes.includes(Buffer.from(SECRET)), `close code ${forged.code}`);
  seedOther.p.destroy();
  const viewer = provider(carolPass, D);
  await Promise.race([viewer.synced, sleep(4000)]);
  check("control: Carol (viewer) reads the live room", fragmentText(viewer.ydoc).includes(SECRET), "");
  viewer.ydoc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("VIEWER-WROTE-THIS")]);
    viewer.ydoc.getXmlFragment("default").insert(0, [paragraph]);
  });
  await sleep(800);
  const fresh = provider((await passFor(alice, D)).ticket, D);
  await fresh.synced;
  await sleep(300);
  check("a viewer's edit never reaches the room", !fragmentText(fresh.ydoc).includes("VIEWER-WROTE-THIS") && !fragmentText(owner.ydoc).includes("VIEWER-WROTE-THIS"), fragmentText(fresh.ydoc).slice(0, 120));

  // Dave is an editor, connected, when Alice removes him.
  const davePass = (await passFor(dave, D)).ticket;
  const editor = provider(davePass, D);
  await Promise.race([editor.synced, sleep(4000)]);
  check("control: Dave (editor) reads the live room", fragmentText(editor.ydoc).includes(SECRET), "");
  r = await call(alice, "DELETE", `/api/docs/${D}/shares/${encodeURIComponent(email("dave"))}`);
  await sleep(1500);
  editor.ydoc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("REMOVED-EDITOR-WROTE-THIS")]);
    editor.ydoc.getXmlFragment("default").insert(0, [paragraph]);
  });
  await sleep(1000);
  check("removing Dave closes his open live connection", editor.closes.length > 0, `close codes ${JSON.stringify(editor.closes)}`);
  const fresh2 = provider((await passFor(alice, D)).ticket, D);
  await fresh2.synced;
  await sleep(300);
  check("Dave's edits after removal never reach the room", !fragmentText(fresh2.ydoc).includes("REMOVED-EDITOR-WROTE-THIS"), "");
  let res = await call(dave, "GET", `/api/docs/${D}`);
  check("Dave can no longer read the document", refused(res), refused(res) ? "" : show(res));
  const daveAgain = await rawSocket(davePass, D, "ticket");
  check("Dave cannot rejoin the live room with the pass he still holds", !daveAgain.bytes.includes(Buffer.from(SECRET)), `close code ${daveAgain.code}`);
  const daveNewPass = await passFor(dave, D);
  check("Dave cannot get a new pass", !daveNewPass.ticket, `HTTP ${daveNewPass.status}`);
  // Desktop builds from before passes still join with the session token.
  const legacy = await rawSocket(alice, D, "token");
  check("control: the legacy token path still serves the owner", legacy.bytes.includes(Buffer.from(SECRET)), `close code ${legacy.code}`);
  for (const p of [owner, viewer, fresh, editor, fresh2]) p.p.destroy();

  section("A deleted document's id");
  const D2 = `doc2-${stamp}`;
  const c2 = `# Old\n\n${SECRET}-old\n`;
  await call(alice, "PUT", `/api/docs/${D2}`, { name: "old.md", content: c2, hash: hash(c2), baseVersion: 0 });
  await call(alice, "POST", `/api/docs/${D2}/shares`, { email: email("carol"), role: "viewer" });
  await call(alice, "POST", `/api/docs/${D2}/threads`, { anchor: { quote: "Old" }, body: `old comment ${SECRET}` });
  await call(alice, "DELETE", `/api/docs/${D2}`);
  res = await call(bob, "PUT", `/api/docs/${D2}`, { name: "bob.md", content: "bob's", hash: hash("bob's"), baseVersion: 0 });
  process.stdout.write(`       Bob writing to Alice's deleted id: HTTP ${res.status}\n`);
  res = await call(bob, "GET", `/api/docs/${D2}/threads`);
  check("Bob cannot read the deleted document's old comments through its id", !res.text.includes(SECRET), show(res));
  res = await call(bob, "GET", `/api/docs/${D2}/shares`);
  check("Bob cannot see who the deleted document was shared with", !res.text.includes(email("carol")), show(res));
  res = await call(carol, "GET", `/api/docs/${D2}`);
  check("Carol is not handed Bob's document through Alice's old share", !(res.status === 200 && res.text.includes("bob's")), show(res));

  const failed = results.filter((x) => !x.passed).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
  if (failed) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  process.stdout.write(`check failed: ${e.stack ?? e}\n`);
  process.exitCode = 1;
} finally {
  stopServer();
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
  process.exit(process.exitCode ?? 0);
}
