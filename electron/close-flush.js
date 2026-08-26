// The window may not die with a keystroke in flight. Main asks the renderer
// to settle (flush autosave, write the draft), waits for app-close-ready, and
// only then destroys; a hung renderer gets a hard cap so quit can never wedge.
// Pure and injected so the handshake tests without a window.
function createCloseFlusher({
  send,
  onReady,
  timeoutMs = 2000,
  destroy,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let state = "idle"; // idle | pending | settled
  let timer = null;

  const settle = () => {
    // Only a close we asked for may end in a destroy. app-close-ready comes
    // over IPC, so a renderer that reloads or misbehaves can send it at any
    // time; acting on one outside a pending close would tear the window down
    // with the user's unsaved work still in it.
    if (state !== "pending") return;
    state = "settled";
    if (timer) clearTimer(timer);
    timer = null;
    destroy();
  };

  onReady(settle);

  return {
    requestClose() {
      if (state !== "idle") return;
      state = "pending";
      send("app-will-close");
      timer = setTimer(settle, timeoutMs);
    },
    isSettled() {
      return state === "settled";
    },
  };
}

module.exports = { createCloseFlusher };
