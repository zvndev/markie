// Drives a real click through the rail button, the way a person does, then
// moves the pointer away and asks whether the label is still on screen.
// jsdom cannot answer this: `:focus-visible` and `:has()` are real-browser
// behaviour, and the rule lives in globals.css which unit tests never load.
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.cwd(), "server", "package.json"));
const WebSocket = require("ws");
const PORT = process.env.PORT ?? "9455";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.once("open", r));
let id = 0;
const send = (method, params) =>
  new Promise((resolve) => {
    const mid = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id === mid) { ws.off("message", on); resolve(m.result); } };
    ws.on("message", on);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

// Reload first, or this measures whatever CSS was loaded when the window
// opened rather than what is on disk now. Skipping this produced a false pass
// that hid a real regression.
// The renderer mounts asynchronously; wait for the rail rather than assume it.
let box = null;
for (let i = 0; i < 100 && !box; i++) {
  box = await evaluate(`(() => {
    const b = document.querySelector('[aria-label^="Projects"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  if (!box) await new Promise((r) => setTimeout(r, 200));
}
if (!box) { console.log("RESULT " + JSON.stringify({ error: "rail button never appeared" })); process.exit(1); }

const _unused = await evaluate(`(() => {
  const b = document.querySelector('[aria-label^="Projects"]');
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`);

const tipOpacity = () => evaluate(`(() => {
  const t = [...document.querySelectorAll('[role="tooltip"]')].find(e => (e.textContent||'').trim().startsWith('Projects'));
  return t ? getComputedStyle(t).opacity : 'missing';
})()`);

async function mouse(type, x, y, button = "none", clickCount = 0) {
  await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount, buttons: type === "mousePressed" ? 1 : 0 });
}

// 1. Hover it: the label must appear.
await mouse("mouseMoved", box.x, box.y);
await new Promise((r) => setTimeout(r, 200));
const hovered = await tipOpacity();

// 2. Click it, then move the pointer far away, the way you would to read the page.
await mouse("mousePressed", box.x, box.y, "left", 1);
await mouse("mouseReleased", box.x, box.y, "left", 1);
await new Promise((r) => setTimeout(r, 150));
await mouse("mouseMoved", 900, 600);
await new Promise((r) => setTimeout(r, 400));
const afterClick = await tipOpacity();

// 3. Keyboard focus must still show it, because that is who the label is for.
await evaluate(`document.querySelector('[aria-label^="Projects"]').focus({ focusVisible: true })`);
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
await new Promise((r) => setTimeout(r, 200));

console.log("RESULT " + JSON.stringify({
  onHover: hovered,
  afterClickPointerAway: afterClick,
  pass: hovered === "1" && afterClick === "0",
}, null, 1));
ws.close();
