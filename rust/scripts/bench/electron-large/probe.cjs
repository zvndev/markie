// Session preload for the 7.9 bench (main.cjs). Runs in its own world, so it
// sees the page's DOM and frames but none of its code. It writes what it
// times into data attributes on <html>, where main.cjs reads them.
const { ipcRenderer } = require("electron");

const root = () => document.documentElement;
const afterFrame = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
const firstLine = () => document.querySelector(".cm-content .cm-line");

let painted = false;
let typedX = false;
const watch = new MutationObserver(() => {
  const line = firstLine();
  if (!painted && line && line.textContent.length > 0) {
    painted = true;
    afterFrame(() => {
      root().dataset.benchFirstPaint = String(Date.now());
      const content = document.querySelector(".cm-content");
      content.focus();
      ipcRenderer.send("bench-editor-ready");
    });
  }
  if (painted && !typedX && line && line.textContent.startsWith("x")) {
    typedX = true;
    afterFrame(() => {
      root().dataset.benchEditable = String(Date.now());
    });
  }
});
document.addEventListener("DOMContentLoaded", () => watch.observe(document.body, { childList: true, subtree: true, characterData: true }));

// Keystroke to the end of the next frame: from the keydown's own timestamp
// to a task after the frame that follows it.
// Two figures per key. `benchKeys`: to the end of the next frame, which on
// a 60 Hz frame clock includes waiting for that frame. `benchWork`: to the
// end of the work the key causes, without the wait: the keydown and input
// handlers, CodeMirror's update and the page's onChange, then style and
// layout forced in a task after them. Paint is in neither.
const keys = [];
const work = [];
let pending = null;
window.addEventListener(
  "keydown",
  (e) => {
    if (e.metaKey || e.key.length !== 1) return;
    const start = e.timeStamp;
    pending = start;
    afterFrame(() => {
      keys.push(performance.now() - start);
      root().dataset.benchKeys = JSON.stringify(keys);
    });
  },
  true
);
window.addEventListener("input", () => {
  if (pending === null) return;
  const start = pending;
  pending = null;
  setTimeout(() => {
    void document.documentElement.offsetHeight;
    work.push(performance.now() - start);
    root().dataset.benchWork = JSON.stringify(work);
  }, 0);
});
