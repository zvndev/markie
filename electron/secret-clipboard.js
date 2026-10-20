// Copying a secret out of the vault, from the main process.
//
// The renderer cannot do this job: reading the clipboard back needs focus, and
// the moment a key is useful is the moment Markie has lost focus to Terminal.
// So the copy happens here, the delayed clear happens here, and lock and quit
// clear it early. Only a SHA-256 fingerprint is kept, never the value, and the
// clipboard is cleared only if it still holds that exact value: whatever the
// user copied since is left alone.
const crypto = require("crypto");

const CLEAR_AFTER_MS = 30_000;
const MAX_SECRET_CHARS = 64 * 1024;

const digest = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * @param {{ readText(): string; writeText(text: string): void; clear(): void }} clipboard
 * @param {{ clearAfterMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: any) => void }} [options]
 */
function createSecretClipboard(clipboard, { clearAfterMs = CLEAR_AFTER_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null; // { fingerprint, timer }

  const clearIfUnchanged = () => {
    if (!pending) return false;
    const { fingerprint, timer } = pending;
    pending = null;
    clearTimer(timer);
    let current = "";
    try { current = clipboard.readText(); } catch { return false; }
    if (!current || digest(current) !== fingerprint) return false;
    clipboard.clear();
    return true;
  };

  const copy = (text) => {
    if (typeof text !== "string" || !text || text.length > MAX_SECRET_CHARS) return { ok: false, error: "Nothing to copy." };
    if (pending) { clearTimer(pending.timer); pending = null; }
    clipboard.writeText(text);
    const timer = setTimer(clearIfUnchanged, clearAfterMs);
    if (timer && typeof (/** @type {any} */ (timer)).unref === "function") (/** @type {any} */ (timer)).unref();
    pending = { fingerprint: digest(text), timer };
    return { ok: true, clearsAfterMs: clearAfterMs };
  };

  return { copy, clearNow: clearIfUnchanged, hasPending: () => !!pending };
}

module.exports = { createSecretClipboard, CLEAR_AFTER_MS, MAX_SECRET_CHARS };
