// Phase 6 E2E: packaged app (Alice, via CDP) + headless Yjs client (Bob).
//   node scripts/collab-e2e-verify.mjs <bobToken> <docId>
import { createRequire } from "node:module";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const Y = require("yjs");
const { WebsocketProvider } = require("y-websocket");
const WebSocket = require("ws");

const [bobToken, docId] = process.argv.slice(2);
if (!bobToken || !docId) throw new Error("usage: verify.mjs <bobToken> <docId>");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CDP driver for Alice's packaged app ----
async function cdpConnect() {
  const res = await fetch("http://localhost:9222/json");
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://"));
  if (!page) throw new Error("no app:// page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.result?.exceptionDetails)
          reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result?.result?.value);
      });
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    });
  return { evaluate, close: () => ws.close() };
}

async function pollUntil(label, fn, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(300);
  }
}

const results = {};
const alice = await cdpConnect();

// 1. Alice's app detects the live doc and syncs the room
await pollUntil(
  "alice collab session synced",
  () => alice.evaluate("!!(window.__markieCollab && window.__markieCollab.provider.synced)"),
  30000
);
results.aliceLive = await alice.evaluate(
  "JSON.stringify({file: document.title, status: !!window.__markieCollab.provider.wsconnected})"
);

// 2. Bob connects headlessly with his token
const bobDoc = new Y.Doc();
const bobProvider = new WebsocketProvider("ws://localhost:8787/collab", docId, bobDoc, {
  WebSocketPolyfill: WebSocket,
  disableBc: true,
  params: { token: bobToken },
});
bobProvider.awareness.setLocalStateField("user", { name: "Bob", color: "#10b981" });
await pollUntil("bob synced", () => bobProvider.synced, 15000);

// 3. Bob sees the content Alice seeded from her local file
const bobFragment = bobDoc.getXmlFragment("default");
results.bobSeesSeed = await pollUntil(
  "bob sees seeded content",
  () => (bobFragment.toString().includes("Collab E2E") ? bobFragment.toString().slice(0, 120) : null)
);

// 4. Bob edits -> Alice's editor shows it
bobDoc.transact(() => {
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("bob-live-edit-marker")]);
  bobFragment.push([para]);
});
results.aliceSeesBobEdit = await pollUntil("alice sees bob's edit", () =>
  alice.evaluate(
    "window.__markieEditor && window.__markieEditor.getText().includes('bob-live-edit-marker')"
  )
);

// 5. Alice types -> Bob's doc shows it
await alice.evaluate(
  "window.__markieEditor.commands.focus('end'), window.__markieEditor.commands.insertContent('alice-live-edit-marker')"
);
results.bobSeesAliceEdit = await pollUntil("bob sees alice's edit", () =>
  bobFragment.toString().includes("alice-live-edit-marker")
);

// 6. Presence both ways: Bob in Alice's toolbar avatars; Alice in Bob's awareness
results.aliceSeesBobAvatar = await pollUntil("bob avatar in alice toolbar", () =>
  alice.evaluate("!!document.querySelector('[title=\"Bob\"]')")
);
results.bobSeesAlicePresence = await pollUntil("alice in bob awareness", () => {
  const users = [...bobProvider.awareness.getStates().values()]
    .map((s) => s.user?.name)
    .filter(Boolean);
  return users.includes("Alice") ? users : null;
});

// 7. Share button visible for the cloud-synced doc
results.shareButtonVisible = await alice.evaluate(
  "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Share')"
);

// 8. Live indicator on
results.liveIndicator = await alice.evaluate(
  "[...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'Live')"
);

console.log(JSON.stringify(results, null, 2));
bobProvider.destroy();
alice.close();
process.exit(0);
