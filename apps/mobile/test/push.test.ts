import { describe, expect, it } from "vitest";
import { createPushController, PUSH_PREFS_KEY, type PushApi, type PushPlugin } from "../src/lib/push";
import { createApiClient } from "../src/lib/api";
import type { HttpRequest, HttpTransport } from "../src/lib/http";
import { appLinkFor, parseMarkieLink } from "../src/lib/deep-links";
import { pushFooter } from "../src/screens/settings";

// The plugin, as the phone would answer: a permission the person can grant or
// refuse, and a token that arrives by event after register().
function fakePlugin({ permission = "prompt", answer = "granted", token = "token-1" }: { permission?: string; answer?: string; token?: string } = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const calls: string[] = [];
  const phone = { permission, answer, token };
  const emit = (event: string, payload: unknown) => { for (const listener of listeners.get(event) ?? []) listener(payload); };
  const plugin = {
    async checkPermissions() { calls.push("check"); return { receive: phone.permission }; },
    async requestPermissions() { calls.push("request"); phone.permission = phone.answer; return { receive: phone.permission }; },
    async register() { calls.push("register"); queueMicrotask(() => emit("registration", { value: phone.token })); },
    async addListener(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return { remove: async () => { set.delete(listener); } };
    },
  } as unknown as PushPlugin;
  return { plugin, calls, phone, emit, listening: (event: string) => listeners.get(event)?.size ?? 0 };
}

function fakeApi({ delivers = true, fail = false }: { delivers?: boolean; fail?: boolean } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const api: PushApi & { createThread(id: string): Promise<string>; reply(id: string): Promise<void>; addShare(id: string): Promise<string>; doc(id: string): Promise<string>; origin: string } = {
    origin: "https://api.markiedocs.com",
    async registerDevice(device) { calls.push(["register", device]); if (fail) throw new Error("no route"); return { delivers }; },
    async removeDevice(token, options) { calls.push(["remove", token, options]); if (fail) throw new Error("offline"); },
    async createThread(id) { calls.push(["createThread", id]); return "thread-1"; },
    async reply(id) { calls.push(["reply", id]); },
    async addShare(id) { calls.push(["addShare", id]); return "member"; },
    async doc(id) { calls.push(["doc", id]); return "text"; },
  };
  return { api, calls, registered: () => calls.filter((c) => c[0] === "register").map((c) => c[1]), removed: () => calls.filter((c) => c[0] === "remove") };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const enabledPrefs = (extra: Record<string, unknown> = {}) => ({ [PUSH_PREFS_KEY]: JSON.stringify({ enabled: true, asked: true, showNames: false, ...extra }) });

function controller(options: { platform?: "ios" | "android" | "web"; available?: boolean; stored?: Record<string, string>; phone?: Parameters<typeof fakePlugin>[0] } = {}) {
  const fake = fakePlugin(options.phone);
  const storage = memoryStorage(options.stored);
  const push = createPushController({
    plugin: fake.plugin,
    platform: options.platform ?? "ios",
    available: async () => options.available ?? true,
    storage,
  });
  return { push, storage, ...fake };
}

describe("push: when nothing may happen", () => {
  it("is a quiet no-op in a browser", async () => {
    const { push, calls } = controller({ platform: "web", stored: enabledPrefs() });
    const server = fakeApi();
    const stop = push.start(() => { throw new Error("no link can arrive"); });
    push.setApi(server.api);
    await settle();
    expect(await push.state()).toEqual({ available: false, enabled: false, permission: "denied", showNames: false, delivers: null });
    expect((await push.enable()).available).toBe(false);
    await push.askOnce();
    await push.signOut(server.api);
    stop();
    expect(calls).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("never touches the plugin on an Android build with no Firebase project", async () => {
    const { push, calls, listening } = controller({ platform: "android", available: false, stored: enabledPrefs(), phone: { permission: "granted" } });
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    await push.enable();
    await push.watch(server.api).createThread("doc-1");
    await settle();
    // Not register(), which would call into Firebase, and not even a listener.
    expect(calls).toEqual([]);
    expect(listening("registration")).toBe(0);
    expect(server.registered()).toEqual([]);
  });

  it("treats a plugin that fails to attach as unavailable, without throwing", async () => {
    const fake = fakePlugin({ permission: "granted" });
    const plugin = { ...fake.plugin, addListener: async () => { throw new Error("not implemented"); } } as unknown as PushPlugin;
    const push = createPushController({ plugin, platform: "ios", available: async () => true, storage: memoryStorage(enabledPrefs()) });
    push.start(() => undefined);
    push.setApi(fakeApi().api);
    await settle();
    expect((await push.state()).available).toBe(false);
    expect(fake.calls).not.toContain("register");
  });
});

describe("push: asking for permission", () => {
  it("asks nothing at launch or at sign-in", async () => {
    const { push, calls } = controller();
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    expect(calls).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(await push.state()).toEqual({ available: true, enabled: false, permission: "prompt", showNames: false, delivers: null });
  });

  it("asks once, after the first comment, reply or share goes through, and registers on a yes", async () => {
    const { push, calls, storage } = controller();
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    const api = push.watch(server.api);
    // Reading a document is not a reason to ask.
    expect(await api.doc("doc-1")).toBe("text");
    await settle();
    expect(calls).not.toContain("request");

    expect(await api.createThread("doc-1")).toBe("thread-1");
    await settle();
    expect(calls.filter((c) => c === "request")).toHaveLength(1);
    expect(server.registered()).toEqual([{ platform: "ios", token: "token-1", showNames: false }]);
    expect(JSON.parse(storage.values.get(PUSH_PREFS_KEY)!)).toEqual({ enabled: true, asked: true, showNames: false });
    expect(await push.state()).toEqual({ available: true, enabled: true, permission: "granted", showNames: false, delivers: true });

    await api.reply("doc-1");
    await api.addShare("doc-1");
    await settle();
    expect(calls.filter((c) => c === "request")).toHaveLength(1);
    // The wrapped client is still the client.
    expect(api.origin).toBe("https://api.markiedocs.com");
  });

  it("takes a no for an answer, and does not ask again", async () => {
    const { push, calls } = controller({ phone: { answer: "denied" } });
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    const api = push.watch(server.api);
    await api.reply("doc-1");
    await settle();
    await api.reply("doc-1");
    await api.addShare("doc-1");
    await settle();
    expect(calls.filter((c) => c === "request")).toHaveLength(1);
    expect(calls).not.toContain("register");
    expect(server.registered()).toEqual([]);
    const state = await push.state();
    expect([state.enabled, state.permission]).toEqual([false, "denied"]);
  });

  it("does not ask when the comment failed", async () => {
    const { push, calls } = controller();
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    const api = push.watch({ ...server.api, createThread: async (id: string): Promise<string> => { throw new Error(`forbidden ${id}`); } });
    await expect(api.createThread("doc-1")).rejects.toThrow("forbidden");
    await settle();
    expect(calls).not.toContain("request");
  });

  it("can be turned on from Settings, and says so when the phone itself refuses", async () => {
    const yes = controller();
    yes.push.start(() => undefined);
    yes.push.setApi(fakeApi().api);
    expect((await yes.push.enable()).enabled).toBe(true);

    const no = controller({ phone: { permission: "denied", answer: "denied" } });
    no.push.start(() => undefined);
    no.push.setApi(fakeApi().api);
    const state = await no.push.enable();
    expect([state.enabled, state.permission]).toEqual([false, "denied"]);
    expect(pushFooter(state)).toMatch(/phone's settings/);
  });
});

describe("push: the token's life", () => {
  it("registers at launch for someone who said yes before, without asking again", async () => {
    const { push, calls } = controller({ stored: enabledPrefs({ showNames: true }), phone: { permission: "granted" } });
    const server = fakeApi({ delivers: false });
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    expect(calls).toContain("register");
    expect(calls).not.toContain("request");
    expect(server.registered()).toEqual([{ platform: "ios", token: "token-1", showNames: true }]);
    const state = await push.state();
    expect(state.delivers).toBe(false);
    expect(pushFooter(state)).toBe("This server doesn't send notifications yet.");
  });

  it("registers again when the system rotates the token", async () => {
    const { push, emit } = controller({ platform: "android", stored: enabledPrefs(), phone: { permission: "granted" } });
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    emit("registration", { value: "token-2" });
    await settle();
    expect(server.registered()).toEqual([
      { platform: "android", token: "token-1", showNames: false },
      { platform: "android", token: "token-2", showNames: false },
    ]);
    // Signing out removes the token the phone holds now, not the old one.
    await push.signOut(server.api);
    expect(server.removed()).toEqual([["remove", "token-2", { timeoutMs: 3000 }]]);
  });

  it("does not register while the phone's own setting says no", async () => {
    const { push, calls } = controller({ stored: enabledPrefs(), phone: { permission: "denied" } });
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    expect(calls).not.toContain("register");
    expect(server.registered()).toEqual([]);
  });

  it("removes the phone on sign-out with the ending session, and goes quiet after", async () => {
    const { push, emit } = controller({ stored: enabledPrefs(), phone: { permission: "granted" } });
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();

    // The app clears the session, then calls signOut with a client that still holds the old token.
    push.setApi(null);
    const ending = fakeApi();
    await push.signOut(ending.api);
    expect(ending.removed()).toEqual([["remove", "token-1", { timeoutMs: 3000 }]]);

    emit("registration", { value: "token-3" });
    await settle();
    expect(server.registered()).toHaveLength(1);
    expect(ending.registered()).toEqual([]);

    // The next person to sign in on this phone gets it.
    const next = fakeApi();
    push.setApi(next.api);
    await settle();
    expect(next.registered()).toEqual([{ platform: "ios", token: "token-1", showNames: false }]);
  });

  it("never lets a failing server break sign-out, launch or Settings", async () => {
    const { push } = controller({ stored: enabledPrefs(), phone: { permission: "granted" } });
    const server = fakeApi({ fail: true });
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    expect(server.registered()).toHaveLength(1);
    await expect(push.signOut(server.api)).resolves.toBeUndefined();
    await expect(push.setShowNames(true)).resolves.toMatchObject({ showNames: true });
    await expect(push.disable()).resolves.toMatchObject({ enabled: false });
  });

  it("turning it off removes the phone and keeps it off at the next launch", async () => {
    const first = controller({ stored: enabledPrefs(), phone: { permission: "granted" } });
    const server = fakeApi();
    first.push.start(() => undefined);
    first.push.setApi(server.api);
    await settle();
    expect((await first.push.disable()).enabled).toBe(false);
    expect(server.removed()).toEqual([["remove", "token-1", undefined]]);

    const again = controller({ stored: Object.fromEntries(first.storage.values), phone: { permission: "granted" } });
    const later = fakeApi();
    again.push.start(() => undefined);
    again.push.setApi(later.api);
    await again.push.watch(later.api).reply("doc-1");
    await settle();
    expect(again.calls).not.toContain("register");
    expect(again.calls).not.toContain("request");
    expect(later.registered()).toEqual([]);
  });

  it("sends the document-names choice to the server when it changes", async () => {
    const { push } = controller({ stored: enabledPrefs(), phone: { permission: "granted" } });
    const server = fakeApi();
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    const state = await push.setShowNames(true);
    expect(state.showNames).toBe(true);
    expect(server.registered().at(-1)).toEqual({ platform: "ios", token: "token-1", showNames: true });
    expect(pushFooter(state)).toMatch(/which document/);
    expect(pushFooter({ ...state, showNames: false })).toMatch(/never includes the comment or the document's name/);
  });
});

describe("push: a server from before the device routes", () => {
  // Markie Cloud is exactly this until its next deploy: POST /api/me/devices
  // answers 404. The app must stay quiet and usable: one try per token, no
  // loop, nothing thrown, and Settings still opens.
  function olderServer() {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = async (request) => {
      requests.push(request);
      if (request.url.includes("/api/me/devices")) return { status: 404, headers: {}, text: "404 Not Found" };
      return { status: 200, headers: {}, text: "{}" };
    };
    const api = createApiClient({ origin: "https://api.markiedocs.com", transport, getToken: () => "t".repeat(32) });
    return { api, requests, devices: () => requests.filter((request) => request.url.includes("/api/me/devices")) };
  }

  it("tries once, throws nothing, and does not try again on its own", async () => {
    const { push } = controller({ stored: enabledPrefs(), phone: { permission: "granted" } });
    const server = olderServer();
    push.start(() => undefined);
    push.setApi(server.api);
    await settle();
    expect(server.devices()).toHaveLength(1);
    // Time passes, the same client is handed over again (a re-render): still one.
    push.setApi(server.api);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.devices()).toHaveLength(1);
    const state = await push.state();
    expect(state).toMatchObject({ available: true, enabled: true, delivers: null });
    // No "failed" wording: the ordinary line.
    expect(pushFooter(state)).toBe("A notification says who commented. It never includes the comment or the document's name.");
  });

  it("asks for permission after a first comment as usual, and the comment itself is untouched", async () => {
    const { push, calls } = controller();
    const server = olderServer();
    const base = fakeApi();
    const api = push.watch({ ...base.api, registerDevice: server.api.registerDevice, removeDevice: server.api.removeDevice });
    push.start(() => undefined);
    push.setApi(api);
    await settle();
    expect(await api.createThread("doc-1")).toBe("thread-1");
    await settle();
    expect(calls).toContain("request");
    expect(server.devices()).toHaveLength(1);
    // Turning it off and signing out against the same server are quiet too.
    await expect(push.disable()).resolves.toMatchObject({ enabled: false });
    await expect(push.signOut(server.api)).resolves.toBeUndefined();
  });
});

describe("push: a tapped notification", () => {
  it("hands its link to the app, and nothing that is not a link", async () => {
    const { push, emit, listening } = controller();
    const links: string[] = [];
    const stop = push.start((link) => links.push(link));
    await settle();
    const link = "https://api.markiedocs.com/d/doc-1?thread=0b0e1f6e-3a53-4c0b-9d0a-5a6f6f0e7a11";
    emit("pushNotificationActionPerformed", { actionId: "tap", notification: { data: { aps: { alert: {} }, link } } });
    emit("pushNotificationActionPerformed", { notification: { data: { link: 7 } } });
    emit("pushNotificationActionPerformed", { notification: { data: { link: `https://api.markiedocs.com/d/${"x".repeat(5000)}` } } });
    emit("pushNotificationActionPerformed", { notification: {} });
    emit("pushNotificationActionPerformed", null);
    expect(links).toEqual([link]);

    stop();
    expect(listening("pushNotificationActionPerformed")).toBe(0);
    expect(listening("registration")).toBe(0);
  });

  it("carries the thread through the link router, which ignores anything that is not a thread id", () => {
    const thread = "0b0e1f6e-3a53-4c0b-9d0a-5a6f6f0e7a11";
    expect(parseMarkieLink(`https://api.markiedocs.com/d/doc-1?thread=${thread}`)).toEqual({ kind: "doc", id: "doc-1", origin: "https://api.markiedocs.com", thread });
    expect(parseMarkieLink(`https://docs.example.com/d/doc-1?thread=${thread}`, "https://docs.example.com")).toEqual({ kind: "doc", id: "doc-1", origin: "https://docs.example.com", thread });
    // A link with no thread, or a thread that is not an id, is the plain document link it always was.
    expect(parseMarkieLink("https://api.markiedocs.com/d/doc-1?k=invite")).toEqual({ kind: "doc", id: "doc-1", origin: "https://api.markiedocs.com" });
    expect(parseMarkieLink("https://api.markiedocs.com/d/doc-1?thread=../../etc")).toEqual({ kind: "doc", id: "doc-1", origin: "https://api.markiedocs.com" });
    // A public share has no threads.
    expect(parseMarkieLink(`markie-mobile://s/${"a".repeat(32)}?thread=${thread}`)).not.toHaveProperty("thread");
    // It survives the wait for sign-in.
    const target = parseMarkieLink(`markie-mobile://d/doc-1?thread=${thread}`)!;
    expect(parseMarkieLink(appLinkFor(target))).toEqual(target);
    // A link to somewhere else is still not a Markie link.
    expect(parseMarkieLink(`https://evil.example/d/doc-1?thread=${thread}`)).toBeNull();
  });
});

describe("push: the two server routes", () => {
  it("registers and removes this phone with the session, on the signed-in server only", async () => {
    const calls: HttpRequest[] = [];
    const transport: HttpTransport = async (request) => {
      calls.push(request);
      return { status: 200, headers: {}, text: JSON.stringify({ ok: true, delivers: true }) };
    };
    const api = createApiClient({ origin: "https://api.markiedocs.com", transport, getToken: () => "tok_aaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(await api.registerDevice({ platform: "android", token: "fcm:token_-1", showNames: false })).toEqual({ delivers: true });
    await api.removeDevice("fcm:token_-1", { timeoutMs: 3000 });
    expect(calls.map((c) => [c.method, c.url, c.headers?.authorization, c.body, c.timeoutMs])).toEqual([
      ["POST", "https://api.markiedocs.com/api/me/devices", "Bearer tok_aaaaaaaaaaaaaaaaaaaaaaaa", { platform: "android", token: "fcm:token_-1", showNames: false }, 15000],
      ["DELETE", "https://api.markiedocs.com/api/me/devices/fcm%3Atoken_-1", "Bearer tok_aaaaaaaaaaaaaaaaaaaaaaaa", undefined, 3000],
    ]);
  });
});
