// The window may not die with a keystroke in flight. Main asks the renderer
// to settle (flush autosave, write the draft), waits for app-close-ready, and
// only then destroys; a hung renderer gets a hard cap so quit can never wedge.
// Pure and injected so the handshake tests without a window.
function createCloseFlusher({
  send,
  onReady,
  onCancel = () => {},
  onCanceled = () => {},
  forceOnTimeout = () => true,
  timeoutMs = 2000,
  destroy,
  quitting = () => false,
  quit = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let state = "idle"; // idle | pending | settled
  let timer = null;
  let nextTicket = 0;
  let activeTicket;

  const settle = (ticket) => {
    // Only a close we asked for may end in a destroy. app-close-ready comes
    // over IPC, so a renderer that reloads or misbehaves can send it at any
    // time; acting on one outside a pending close would tear the window down
    // with the user's unsaved work still in it.
    if (state !== "pending" || (activeTicket !== undefined && ticket !== activeTicket)) return;
    state = "settled";
    if (timer) clearTimer(timer);
    timer = null;
    destroy();
    // Preventing a close cancels the quit that asked for it, and on macOS
    // nothing restarts it: the window goes away and the app lives on with no
    // window and a dock icon that answers nothing. Ask again now that the
    // document is safe.
    if (quitting()) quit();
  };
  const cancel = (ticket) => {
    if (state !== "pending" || (activeTicket !== undefined && ticket !== activeTicket)) return;
    state = "idle";
    if (timer) clearTimer(timer);
    timer = null;
    activeTicket = undefined;
    onCanceled();
  };

  onReady(settle);
  onCancel(cancel);

  return {
    requestClose() {
      if (state !== "idle") return;
      state = "pending";
      const mayForce = forceOnTimeout();
      const ticket = mayForce ? undefined : ++nextTicket;
      activeTicket = ticket;
      timer = setTimer(() => mayForce ? settle(ticket) : cancel(ticket), timeoutMs);
      // Legacy Markdown keeps its existing handshake. Document sessions must
      // acknowledge this specific close after durable recovery or cancel it.
      if (ticket === undefined) send("app-will-close");
      else send("app-will-close", ticket);
    },
    isSettled() {
      return state === "settled";
    },
  };
}

module.exports = { createCloseFlusher };
