import { describe, expect, it, vi } from "vitest";
import { createSecretClipboard } from "./secret-clipboard.js";

function fakeClipboard(initial = "") {
  let text = initial;
  return { readText: () => text, writeText: (value: string) => { text = value; }, clear: vi.fn(() => { text = ""; }), get text() { return text; } };
}

function timers() {
  const queue: Array<() => void> = [];
  return { setTimer: (fn: () => void) => { queue.push(fn); return queue.length; }, clearTimer: vi.fn(), fire: () => queue.splice(0).forEach((fn) => fn()) };
}

describe("secret clipboard", () => {
  it("clears a copied secret after the delay when it is still on the clipboard", () => {
    const clipboard = fakeClipboard(), clock = timers();
    const secrets = createSecretClipboard(clipboard, clock);
    expect(secrets.copy("sk_live_123")).toEqual({ ok: true, clearsAfterMs: 30_000 });
    expect(clipboard.text).toBe("sk_live_123");
    clock.fire();
    expect(clipboard.clear).toHaveBeenCalledOnce();
    expect(clipboard.text).toBe("");
  });

  it("leaves whatever the user copied since alone", () => {
    const clipboard = fakeClipboard(), clock = timers();
    const secrets = createSecretClipboard(clipboard, clock);
    secrets.copy("sk_live_123");
    clipboard.writeText("a grocery list");
    clock.fire();
    expect(clipboard.clear).not.toHaveBeenCalled();
    expect(clipboard.text).toBe("a grocery list");
  });

  it("clears at once when the vault locks or the app quits, and only once", () => {
    const clipboard = fakeClipboard(), clock = timers();
    const secrets = createSecretClipboard(clipboard, clock);
    secrets.copy("DATABASE_URL=postgres://x");
    expect(secrets.clearNow()).toBe(true);
    expect(clipboard.text).toBe("");
    expect(secrets.hasPending()).toBe(false);
    expect(secrets.clearNow()).toBe(false);
  });

  it("refuses empty, non-string and oversized input", () => {
    const secrets = createSecretClipboard(fakeClipboard(), timers());
    expect(secrets.copy("").ok).toBe(false);
    expect(secrets.copy(42 as unknown as string).ok).toBe(false);
    expect(secrets.copy("x".repeat(64 * 1024 + 1)).ok).toBe(false);
  });
});
