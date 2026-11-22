// Scratch helper for the Cloud integration run. Talks only to a server on
// this computer. Tokens go to 0600 files in the scratch folder and are never
// printed.
//   node accounts.mjs signup <base> <log> <email> <name> <tokenfile>
//   node accounts.mjs signin <base> <log> <email> <tokenfile>
//   node accounts.mjs share <base> <ownerToken> <docName> <email> <role> <idfile>
//   node accounts.mjs accept <base> <token> <docIdFile>
//   node accounts.mjs bobjson <base> <docIdFile> <token> <dir> <out>
//   node accounts.mjs docs <base> <token>
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const [cmd, base, ...rest] = process.argv.slice(2);
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error("local servers only");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import { request } from "node:http";
function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, data, token: res.headers["set-auth-token"] ?? null });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function codeFrom(log, email, after) {
  const needle = `to=${email} subject="`;
  for (let i = 0; i < 200; i++) {
    const lines = readFileSync(log, "utf8").split("\n").slice(after).filter((l) => l.includes(needle));
    if (lines.length) return lines.at(-1).split(needle)[1].split(" ")[0];
    await sleep(100);
  }
  throw new Error("no code");
}
const lineCount = (log) => readFileSync(log, "utf8").split("\n").length;
const save = (file, token) => { writeFileSync(file, token); chmodSync(file, 0o600); };
const read = (file) => readFileSync(file, "utf8").trim();

if (cmd === "signup") {
  const [log, email, name, out] = rest;
  const at = lineCount(log);
  const r = await call("POST", "/api/auth/sign-up/email", { email, password: "correct horse battery", name });
  if (r.status === 422 || r.status === 400) {
    // Already created, not yet proven: send the proof code again.
    await call("POST", "/api/auth/email-otp/send-verification-otp", { email, type: "email-verification" });
  } else if (r.status >= 400) throw new Error(`sign-up ${r.status}`);
  const code = await codeFrom(log, email, at - 1);
  const v = await call("POST", "/api/auth/email-otp/verify-email", { email, otp: code });
  if (!v.token) throw new Error(`verify ${v.status}`);
  save(out, v.token);
  console.log(`signed up ${name}`);
} else if (cmd === "signin") {
  const [log, email, out] = rest;
  const at = lineCount(log);
  const s = await call("POST", "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (s.status >= 400) throw new Error(`send ${s.status}`);
  const code = await codeFrom(log, email, at - 1);
  const v = await call("POST", "/api/auth/sign-in/email-otp", { email, otp: code });
  if (!v.token) throw new Error(`sign-in ${v.status}`);
  save(out, v.token);
  console.log("signed in a second session");
} else if (cmd === "share") {
  const [ownerFile, docName, email, role, idFile] = rest;
  const owner = read(ownerFile);
  const docs = await call("GET", "/api/docs", undefined, owner);
  const doc = (docs.data?.docs ?? docs.data ?? []).find((d) => d.name === docName);
  if (!doc) throw new Error("no such document in the owner's cloud");
  const r = await call("POST", `/api/docs/${encodeURIComponent(doc.id)}/shares`, { email, role }, owner);
  writeFileSync(idFile, doc.id);
  console.log(`share ${r.status} ${JSON.stringify(r.data?.status ?? null)}`);
} else if (cmd === "accept") {
  const [tokenFile, idFile] = rest;
  const token = read(tokenFile);
  const id = read(idFile);
  const req = await call("GET", "/api/people/requests", undefined, token);
  const mine = (req.data?.requests ?? []).find((r) => r.docId === id);
  if (!mine) throw new Error("no request for that document");
  const a = await call("POST", `/api/people/${encodeURIComponent(mine.sender.id)}/accept`, {}, token);
  console.log(`accept ${a.status}`);
} else if (cmd === "bobjson") {
  const [idFile, tokenFile, dir, out] = rest;
  writeFileSync(out, JSON.stringify({ base, docId: read(idFile), token: read(tokenFile), dir }));
  chmodSync(out, 0o600);
  console.log("peer handoff written");
} else if (cmd === "docs") {
  const [tokenFile] = rest;
  const docs = await call("GET", "/api/docs", undefined, read(tokenFile));
  const rows = docs.data?.docs ?? docs.data ?? [];
  for (const d of rows) console.log(JSON.stringify({ name: d.name, version: d.version, shared: d.shared, origin: d.origin ?? d.createdBy ?? null }));
} else {
  throw new Error(`unknown ${cmd}`);
}
