// Seed the scratch servers for the share and servers scenes. Writes
// <scratch>/seed.json with throwaway session tokens (never printed).
//   node seed.mjs <scratch>
// Primary :18991: Alice owns "Quarterly plan.md", shared with Bob (editor,
// accepted) and Carol (viewer, accepted), plus a pending invite to an address
// with no account (success@simulator.amazonses.com; mail stays in the
// console log). Second :18995: Dana, who signs in from Settings › Servers.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = process.argv[2];
const PRIMARY = "http://localhost:18991";
const SECOND = "http://localhost:18995";
const PASSWORD = "correct horse battery";
const stamp = Date.now() % 1_000_000;

async function call(base, method, p, body, token) {
  const headers = { "Content-Type": "application/json", Origin: base };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${text.slice(0, 200)}`);
  return { data, token: res.headers.get("set-auth-token") };
}

async function account(base, name, label) {
  const email = `success+scene-${label}-${stamp}@simulator.amazonses.com`;
  await call(base, "POST", "/api/auth/sign-up/email", { email, password: PASSWORD, name });
  const log = path.join(dir, `srv-${new URL(base).port}`, "server.log");
  const needle = `to=${email} subject="`;
  let code;
  for (let i = 0; i < 150 && !code; i++) {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes(needle)) : [];
    code = lines.at(-1)?.split(needle)[1]?.split(" ")[0];
    if (!code) await new Promise((r) => setTimeout(r, 100));
  }
  if (!code) throw new Error(`no code for ${label}`);
  const v = await call(base, "POST", "/api/auth/email-otp/verify-email", { email, otp: code });
  const token = v.token ?? v.data?.token;
  const me = await call(base, "GET", "/api/me", undefined, token);
  return { email, token, user: me.data.user ?? me.data, password: PASSWORD };
}

const alice = await account(PRIMARY, "Alice Rivera", "alice");
const bob = await account(PRIMARY, "Bob Chen", "bob");
const carol = await account(PRIMARY, "Carol Diaz", "carol");
const dana = await account(SECOND, "Dana Self-Host", "dana");
const docId = crypto.randomUUID();
const fileName = "Quarterly plan.md";
const content = "# Quarterly plan\n\nGoals for the quarter.\n";
const hash = crypto.createHash("sha256").update(content).digest("hex");
await call(PRIMARY, "PUT", `/api/docs/${docId}`, { name: fileName, content, hash, baseVersion: 0 }, alice.token);
for (const [who, role] of [[bob, "editor"], [carol, "viewer"]]) {
  await call(PRIMARY, "POST", `/api/docs/${docId}/shares`, { email: who.email, role }, alice.token);
  const reqs = await call(PRIMARY, "GET", "/api/people/requests", undefined, who.token);
  const list = reqs.data.requests ?? reqs.data.incoming ?? [];
  const r = list.find((x) => (x.docId ?? x.doc_id) === docId) ?? list[0];
  if (r) await call(PRIMARY, "POST", `/api/people/${r.sender?.id ?? r.senderId}/accept`, {}, who.token);
}
await call(PRIMARY, "POST", `/api/docs/${docId}/shares`, { email: "success@simulator.amazonses.com", role: "viewer" }, alice.token);
const shares = await call(PRIMARY, "GET", `/api/docs/${docId}/shares`, undefined, alice.token);
fs.writeFileSync(path.join(dir, "seed.json"), JSON.stringify({ primary: PRIMARY, second: SECOND, alice, bob, carol, dana, docId, fileName, content }, null, 2));
console.log(`seeded ${fileName}: ${(shares.data.shares ?? []).map((s) => `${s.name ?? s.email} ${s.role}${s.pending ? " (pending)" : ""}`).join(", ")}`);
