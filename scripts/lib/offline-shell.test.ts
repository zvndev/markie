import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { offlineWorkerSource } from "./offline-shell";

function harness() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const fetched: string[] = [];
  const matched: { url: string; options: unknown }[] = [];
  const context = vm.createContext({ URL, Set, Promise,
    self: { registration: { scope: "https://markie.test/app/" }, clients: { claim: async () => {} },
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler) },
    caches: { open: async () => ({ addAll: async (urls: string[]) => fetched.push(...urls), match: async (url: string, options: unknown) => { matched.push({ url, options }); return { cached: url }; } }),
      delete: async () => true, keys: async () => [] },
    fetch: async () => ({ network: true }),
  });
  vm.runInContext(offlineWorkerSource("0123456789abcdef", ["index.html", "assets/app-a.js", "favicon.ico"]), context);
  return { handlers, fetched, matched };
}

describe("offline application shell", () => {
  it("precaches only emitted app resources under its own scope", async () => {
    const { handlers, fetched } = harness();
    let pending: Promise<unknown> | undefined;
    handlers.get("install")!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
    expect(fetched.sort()).toEqual(["https://markie.test/app/assets/app-a.js", "https://markie.test/app/favicon.ico", "https://markie.test/app/index.html"]);
  });
  it.each(["/api/docs/1", "/app/private.docx", "/app/assets/app-a.js?token=secret", "/auth/callback", "/s/public"])("does not intercept document or account URL %s", (path) => {
    const { handlers } = harness();
    let intercepted = false;
    handlers.get("fetch")!({ request: { method: "GET", url: `https://markie.test${path}`, mode: "navigate" }, respondWith: () => { intercepted = true; } });
    expect(intercepted).toBe(false);
  });
  it("serves only its own navigation shell, including workspace query", async () => {
    const { handlers } = harness();
    let response: Promise<unknown> | undefined;
    handlers.get("fetch")!({ request: { method: "GET", url: "https://markie.test/app/?workspace=1", mode: "navigate" }, respondWith: (promise: Promise<unknown>) => { response = promise; } });
    expect(await response).toEqual({ cached: "https://markie.test/app/index.html" });
  });
  it("never intercepts cross-origin requests or writes", () => {
    const { handlers } = harness();
    for (const request of [{ method: "POST", url: "https://markie.test/app/" }, { method: "GET", url: "https://other.test/app/" }]) {
      let intercepted = false;
      handlers.get("fetch")!({ request, respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });
  it("matches allowlisted static assets despite Vary: Origin differences", async () => {
    const { handlers, matched } = harness();
    let response: Promise<unknown> | undefined;
    handlers.get("fetch")!({ request: { method: "GET", url: "https://markie.test/app/assets/app-a.js", mode: "cors" }, respondWith: (promise: Promise<unknown>) => { response = promise; } });
    expect(await response).toEqual({ cached: "https://markie.test/app/assets/app-a.js" });
    expect(matched).toEqual([{ url: "https://markie.test/app/assets/app-a.js", options: { ignoreVary: true } }]);
  });
  it("rejects document paths in the precache and never forces activation", () => {
    expect(() => offlineWorkerSource("0123456789abcdef", ["index.html", "private.docx"])).toThrow();
    expect(offlineWorkerSource("0123456789abcdef", ["index.html"])).not.toContain("skipWaiting()");
  });
});
