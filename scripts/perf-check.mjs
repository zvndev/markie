// Typing-latency check against a running Markie instance with
// --remote-debugging-port=9222. Loads a 5k-line doc into the rich view,
// types 50 characters, and reports input→frame latency. Fails if p95 > 32ms.
//
// Usage:
//   open -a dist/mac-arm64/Markie.app --args --remote-debugging-port=9222
//   node scripts/perf-check.mjs

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("No debuggable Markie page found on :9222");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) =>
  new Promise((resolve) => {
    const msgId = ++id;
    const onMsg = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id === msgId) {
        ws.removeEventListener("message", onMsg);
        resolve(data.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
await new Promise((r) => (ws.onopen = r));

const res = await send("Runtime.evaluate", {
  expression: `(async () => {
    const ed = window.__markieEditor;
    if (!ed) return { error: "no editor — is the app in View mode?" };

    // 5k-line mixed document
    const blocks = [];
    for (let i = 0; i < 500; i++) {
      blocks.push(
        "## Section " + i,
        "",
        "Paragraph with **bold**, *italic*, and a [link](https://example.com) for section " + i + ".",
        "",
        "- item one",
        "- item two",
        "",
        "\\\`\\\`\\\`js",
        "const v" + i + " = " + i + ";",
        "\\\`\\\`\\\`",
        ""
      );
    }
    const doc = blocks.join("\\n");
    ed.commands.setContent(doc);
    await new Promise((r) => setTimeout(r, 1500)); // let parse + first paint settle

    ed.commands.focus("end");
    const pm = document.querySelector(".ProseMirror");
    pm.focus();

    const samples = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      document.execCommand("insertText", false, "x");
      await new Promise((r) => requestAnimationFrame(() => r()));
      samples.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 30));
    }
    samples.sort((a, b) => a - b);
    const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
    return {
      lines: doc.split("\\n").length,
      p50: +p(0.5).toFixed(2),
      p95: +p(0.95).toFixed(2),
      max: +samples[samples.length - 1].toFixed(2),
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

ws.close();
const v = res.result.value;
console.log(JSON.stringify(v));
if (v.error) {
  console.error(v.error);
  process.exit(1);
}
if (v.p95 > 32) {
  console.error(`FAIL: p95 ${v.p95}ms exceeds 32ms budget`);
  process.exit(1);
}
console.log(`OK: typing p50 ${v.p50}ms / p95 ${v.p95}ms on ${v.lines}-line doc`);
