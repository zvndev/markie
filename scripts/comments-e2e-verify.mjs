// Phase 7 E2E: comments in the packaged app (Alice via CDP) with Bob
// replying via API and editing via a headless Yjs client.
//   node scripts/comments-e2e-verify.mjs <aliceToken> <bobToken> <docId>
import { createRequire } from "node:module";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const Y = require("yjs");
const { WebsocketProvider } = require("y-websocket");
const WebSocket = require("ws");

const SERVER = "http://localhost:8787";
const ORIGIN = { Origin: "http://localhost:3000" };
const [aliceToken, bobToken, docId] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (token, method, path, body) => {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...ORIGIN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

async function cdpConnect() {
  const targets = await (await fetch("http://localhost:9222/json")).json();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ev = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) =>
        msg.result?.exceptionDetails
          ? reject(new Error(JSON.stringify(msg.result.exceptionDetails)))
          : resolve(msg.result?.result?.value)
      );
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  return { ev, close: () => ws.close() };
}

async function pollUntil(label, fn, timeoutMs = 25000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(400);
  }
}

const results = {};
const { ev } = await cdpConnect();

await pollUntil("alice live", () => ev("!!(window.__markieCollab && window.__markieCollab.provider.synced)"), 30000);

// 1. Alice selects "Collab E2E" in the heading and the affordance appears
await ev("window.__markieEditor.commands.setTextSelection({from: 2, to: 8})");
await pollUntil("comment affordance", () =>
  ev("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Comment')")
);
results.affordanceOnSelect = true;
const commentedText = await ev("window.__markieEditor.state.doc.textBetween(2, 8)");

// 2. Alice writes the comment through the real composer UI
await ev("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Comment').click()");
await pollUntil("composer open", () => ev("!!document.querySelector('textarea')"));
await ev(`(() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'Should we rename this heading?');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(200);
await ev(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
const bubbleSel = "[data-comment-thread]";
await pollUntil("gutter bubble", () => ev(`!!document.querySelector('${bubbleSel}')`));
results.threadCreatedFromUI = true;

// 3. Bob replies via API; Alice's panel shows it after the poll cycle
const list = await api(bobToken, "GET", `/api/docs/${docId}/threads`);
const threadId = list.data.threads[0].id;
await api(bobToken, "POST", `/api/docs/${docId}/threads/${threadId}/comments`, {
  body: "Yes — calling it Markie Live.",
});
results.bobReplied = true;
await pollUntil("alice sees 2 comments on bubble", () =>
  ev(`document.querySelector('${bubbleSel}')?.textContent === '2'`)
);
results.aliceSeesReplyCount = true;

// 4. Anchor survives a concurrent edit above it (Bob prepends a paragraph)
const bobDoc = new Y.Doc();
const bobProvider = new WebsocketProvider("ws://localhost:8787/collab", docId, bobDoc, {
  WebSocketPolyfill: WebSocket,
  disableBc: true,
  params: { token: bobToken },
});
await pollUntil("bob synced", () => bobProvider.synced, 15000);
const frag = bobDoc.getXmlFragment("default");
bobDoc.transact(() => {
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText("inserted-above-by-bob")]);
  frag.insert(0, [para]);
});
await pollUntil("alice got bob's insert", () =>
  ev("window.__markieEditor.getText().includes('inserted-above-by-bob')")
);
await sleep(600); // let the gutter re-measure
await ev(`document.querySelector('${bubbleSel}').click()`);
await sleep(300);
const selectedAfterShift = await ev(
  "window.__markieEditor.state.doc.textBetween(window.__markieEditor.state.selection.from, window.__markieEditor.state.selection.to)"
);
results.anchorSurvivesEdit = { before: commentedText, after: selectedAfterShift, ok: selectedAfterShift === commentedText };

// 5. Panel shows both authors; resolve from the UI
await pollUntil("panel open", () => ev("!!document.querySelector('[data-comment-panel]')"));
results.panelShowsBoth = await ev(`(() => {
  const t = document.querySelector('[data-comment-panel]').innerText;
  return t.includes('Alice') && t.includes('Bob') && t.includes('Markie Live');
})()`);
await ev("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Resolve').click()");
await pollUntil("bubble gone + resolved chip", () =>
  ev(`!document.querySelector('${bubbleSel}') && [...document.querySelectorAll('button')].some(b => b.textContent.includes('resolved'))`)
);
results.resolveFlow = true;

// 6. Reopen from the resolved list
await ev("[...document.querySelectorAll('button')].find(b => b.textContent.includes('resolved')).click()");
await pollUntil("reopen visible", () => ev("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Reopen')"));
await ev("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reopen').click()");
await pollUntil("bubble back", () => ev(`!!document.querySelector('${bubbleSel}')`));
results.reopenFlow = true;

console.log(JSON.stringify(results, null, 2));
bobProvider.destroy();
process.exit(0);
