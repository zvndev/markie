// A fresh shared document for the `live` scene, so every run claims an
// empty room with its own file. Needs seed.json from seed.mjs.
//   node seed-live.mjs <scratch> <file.md>
// Writes <scratch>/live-session.json for MARKIE_RS_TEST_SESSION (throwaway
// token, never printed). Alice owns the copy; Bob, an editor, makes it live.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [dir, file] = process.argv.slice(2);
const seed = JSON.parse(fs.readFileSync(path.join(dir, "seed.json"), "utf8"));
const base = seed.primary;
async function call(method, p, body, token) {
  const headers = { "Content-Type": "application/json", Origin: base, Authorization: `Bearer ${token}` };
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const abs = path.resolve(file);
const content = fs.readFileSync(abs, "utf8");
const docId = crypto.randomUUID();
const hash = crypto.createHash("sha256").update(content).digest("hex");
await call("PUT", `/api/docs/${docId}`, { name: path.basename(abs), content, hash, baseVersion: 0 }, seed.alice.token);
await call("POST", `/api/docs/${docId}/shares`, { email: seed.bob.email, role: "editor" }, seed.alice.token);
const user = { id: seed.alice.user.id, name: seed.alice.user.name, email: seed.alice.email };
fs.writeFileSync(path.join(dir, "live-session.json"), JSON.stringify({ origin: base, token: seed.alice.token, user, docs: { [abs]: docId } }));
console.log(`live document ${path.basename(abs)} shared with Bob`);
