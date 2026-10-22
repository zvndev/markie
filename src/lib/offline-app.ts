export type OfflineAppStatus = "unavailable" | "ready" | "failed";

/** Registration never reloads the page or forces a waiting worker to activate. */
export async function registerOfflineApp(): Promise<OfflineAppStatus> {
  if (typeof window === "undefined" || !window.isSecureContext || !/^https?:$/.test(window.location.protocol)
      || !("serviceWorker" in navigator)) return "unavailable";
  try {
    const base = new URL("./", window.location.href);
    base.search = "";
    base.hash = "";
    const registration = await navigator.serviceWorker.register(new URL("service-worker.js", base).href, { scope: base.pathname });
    if (registration.active?.state === "activated") return "ready";
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker) return "failed";
    return await new Promise<OfflineAppStatus>((resolve) => {
      let settled = false;
      const finish = (status: OfflineAppStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener("statechange", changed);
        resolve(status);
      };
      const changed = () => {
        if (worker.state === "activated") finish("ready");
        else if (worker.state === "redundant") finish("failed");
      };
      const timer = setTimeout(() => finish("failed"), 20_000);
      worker.addEventListener("statechange", changed);
      changed();
    });
  } catch { return "failed"; }
}
