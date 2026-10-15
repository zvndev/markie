// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOfflineApp } from "./offline-app";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(state: ServiceWorkerState = "installing") {
  const worker = new EventTarget() as EventTarget & { state: ServiceWorkerState };
  worker.state = state;
  const register = vi.fn(async () => ({ installing: worker, waiting: null, active: null }));
  vi.stubGlobal("navigator", { serviceWorker: { register } });
  vi.stubGlobal("window", { isSecureContext: true, location: { protocol: "https:", href: "https://markie.test/app/?workspace=1" } });
  return { worker, register };
}

describe("offline readiness", () => {
  it("waits for actual activation rather than merely registration", async () => {
    const { worker, register } = setup();
    let status: string | undefined;
    const result = registerOfflineApp().then((value) => { status = value; });
    await Promise.resolve(); await Promise.resolve();
    expect(status).toBeUndefined();
    expect(register).toHaveBeenCalledWith("https://markie.test/app/service-worker.js", { scope: "/app/" });
    worker.state = "activated";
    worker.dispatchEvent(new Event("statechange"));
    await result;
    expect(status).toBe("ready");
  });
  it("reports cache-install failure and a stalled install honestly", async () => {
    const { worker } = setup();
    const failed = registerOfflineApp();
    await Promise.resolve(); await Promise.resolve();
    worker.state = "redundant";
    worker.dispatchEvent(new Event("statechange"));
    expect(await failed).toBe("failed");
    vi.useFakeTimers();
    setup();
    const stalled = registerOfflineApp();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await stalled).toBe("failed");
  });
  it("does not register from Electron or an insecure context", async () => {
    const { register } = setup();
    vi.stubGlobal("window", { isSecureContext: true, location: { protocol: "app:", href: "app://markie/" } });
    expect(await registerOfflineApp()).toBe("unavailable");
    expect(register).not.toHaveBeenCalled();
  });
});
