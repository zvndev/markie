// Phase 6 E2E setup: create Alice + Bob, Alice creates a doc and shares it
// with Bob (editor). Prints JSON {aliceToken, bobToken, docId}.
const SERVER = "http://localhost:8787";
const ORIGIN = { Origin: "http://localhost:3000" };
const stamp = Date.now();

async function signUp(name, email, password) {
  const res = await fetch(`${SERVER}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) throw new Error(`signup ${email}: ${res.status} ${await res.text()}`);
  const token = res.headers.get("set-auth-token");
  if (!token) throw new Error(`no token for ${email}`);
  return token;
}

const aliceEmail = `alice.${stamp}@test.local`;
const bobEmail = `bob.${stamp}@test.local`;
const aliceToken = await signUp("Alice", aliceEmail, "password-123");
const bobToken = await signUp("Bob", bobEmail, "password-123");

// Alice creates the doc (client-generated id, versioned PUT)
const docId = `e2e-${stamp}`;
const content = "# Collab E2E\n\nSeed from setup.\n";
const hash = (await import("node:crypto"))
  .createHash("sha256")
  .update(content, "utf8")
  .digest("hex");
const createRes = await fetch(`${SERVER}/api/docs/${docId}`, {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${aliceToken}`,
    ...ORIGIN,
  },
  body: JSON.stringify({ name: "collab-e2e.md", content, hash, baseVersion: 0 }),
});
if (!createRes.ok) throw new Error(`create doc: ${createRes.status} ${await createRes.text()}`);

// Share with Bob as editor (sends the invite email — console in dev)
const shareRes = await fetch(`${SERVER}/api/docs/${docId}/shares`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${aliceToken}`,
    ...ORIGIN,
  },
  body: JSON.stringify({ email: bobEmail, role: "editor" }),
});
if (!shareRes.ok) throw new Error(`share: ${shareRes.status} ${await shareRes.text()}`);

console.log(JSON.stringify({ aliceToken, bobToken, docId, aliceEmail, bobEmail }));
