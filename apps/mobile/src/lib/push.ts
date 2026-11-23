// Push notifications: asking for permission, telling the server which phone
// this is, and handing a tapped notification's link to the app.
//
// The server sends one kind of notification, a new comment or reply
// (server/src/devices.ts, docs/mobile/PUSH.md). This file is the phone's side.
//
//   - Permission is never asked at launch. It is asked once, the first time
//     the person does something replies are likely to follow: writing a
//     comment, replying, or sharing a document. After that the Notifications
//     rows in Settings turn it on and off.
//   - The token goes to the server after sign-in, on each launch, and whenever
//     the system hands out a new one.
//   - Signing out removes this phone from the server while the token that can
//     still do so is in hand.
//   - A tapped notification carries a Markie link. It is handed to the app's
//     one link entry point and nowhere else, so it obeys the same sign-in and
//     server rules as a link from Mail.
//
// In a desktop browser, on an Android build with no Firebase project, and on
// any device where the plugin fails, every call here is a quiet no-op.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

export type PushPlatform = "ios" | "android";
export type PushPermission = "granted" | "denied" | "prompt";

/** The part of @capacitor/push-notifications this file uses. */
export interface PushPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: "registration", listener: (token: { value: string }) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(event: "registrationError", listener: (error: unknown) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: "pushNotificationActionPerformed",
    listener: (action: { notification?: { data?: unknown } }) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

/** The two server routes, as the API client offers them (api.ts). */
export interface PushApi {
  registerDevice(device: { platform: PushPlatform; token: string; showNames: boolean }): Promise<{ delivers: boolean }>;
  removeDevice(token: string, options?: { timeoutMs?: number }): Promise<void>;
}

export interface PushState {
  /** False in a browser, and on a build that cannot receive notifications at all. */
  available: boolean;
  /** The person's choice in Markie. Off until they say yes once. */
  enabled: boolean;
  /** The phone's own answer, which Markie cannot change once it is "denied". */
  permission: PushPermission;
  /** Whether a notification may name the document. Off by default. */
  showNames: boolean;
  /** Whether the signed-in server sends notifications to this kind of phone. Null until it has said. */
  delivers: boolean | null;
}

export interface PushController {
  /** Starts listening for tokens and taps. Returns the way to stop. */
  start(onLink: (link: string) => void): () => void;
  /** The signed-in API client, or null when nobody is signed in. */
  setApi(api: PushApi | null): void;
  state(): Promise<PushState>;
  /** Turn notifications on. Shows the system's permission question the first time. */
  enable(): Promise<PushState>;
  /** Turn notifications off, and take this phone off the server. */
  disable(): Promise<PushState>;
  setShowNames(show: boolean): Promise<PushState>;
  /** The one automatic ask. Does nothing if the person was asked or chose before. */
  askOnce(): Promise<void>;
  /** Signing out: take this phone off the server with the session that is ending. Never throws. */
  signOut(api: PushApi): Promise<void>;
  /** The same client, asking once after a comment, a reply or a share goes through. */
  watch<T extends object>(api: T): T;
}

export const PUSH_PREFS_KEY = "markie.mobile.push.v1";
const SIGN_OUT_TIMEOUT_MS = 3_000;
const MAX_LINK_CHARS = 4096;
// The API calls after which a reply is likely, and so a notification wanted.
const ASK_AFTER = new Set(["createThread", "reply", "addShare"]);

interface Prefs {
  /** null until the person has chosen. */
  enabled: boolean | null;
  asked: boolean;
  showNames: boolean;
}

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function loadPrefs(storage: PrefStorage | null): Prefs {
  const fresh: Prefs = { enabled: null, asked: false, showNames: false };
  if (!storage) return fresh;
  try {
    const raw = JSON.parse(storage.getItem(PUSH_PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    if (!raw || typeof raw !== "object") return fresh;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
      asked: raw.asked === true,
      showNames: raw.showNames === true,
    };
  } catch {
    return fresh;
  }
}

function permissionFrom(status: { receive?: unknown } | null | undefined): PushPermission {
  return status?.receive === "granted" ? "granted" : status?.receive === "denied" ? "denied" : "prompt";
}

export interface PushControllerOptions {
  plugin: PushPlugin;
  platform: "ios" | "android" | "web";
  /** Whether this build can receive notifications. Asked once. */
  available: () => Promise<boolean>;
  storage: PrefStorage | null;
}

export function createPushController({ plugin, platform, available, storage }: PushControllerOptions): PushController {
  let prefs = loadPrefs(storage);
  let api: PushApi | null = null;
  let token: string | null = null;
  let delivers: boolean | null = null;
  let onLink: ((link: string) => void) | null = null;
  // Resolves once the listeners are attached, so a token is never missed.
  let ready: Promise<void> | null = null;

  const savePrefs = (next: Prefs) => {
    prefs = next;
    try {
      storage?.setItem(PUSH_PREFS_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: the choice lasts until the app closes.
    }
  };

  let availability: Promise<boolean> | null = null;
  const isAvailable = (): Promise<boolean> => {
    if (platform === "web") return Promise.resolve(false);
    availability ??= available().catch(() => false);
    return availability;
  };

  const permission = async (): Promise<PushPermission> => {
    try {
      return permissionFrom(await plugin.checkPermissions());
    } catch {
      return "denied";
    }
  };

  /** Sends the token in hand to the signed-in server. */
  const send = async (): Promise<void> => {
    const current = api;
    if (!current || !token || prefs.enabled !== true || platform === "web") return;
    try {
      const answer = await current.registerDevice({ platform, token, showNames: prefs.showNames });
      if (api === current) delivers = answer.delivers;
    } catch {
      // Offline, or a server without the route. The next launch tries again.
    }
  };

  /** Asks the system for the token when everything allows it. The token arrives by event. */
  const askForToken = async (): Promise<void> => {
    // The listeners first: attaching them is also what finds a missing plugin.
    if (ready) await ready;
    if (!api || prefs.enabled !== true || !(await isAvailable())) return;
    if ((await permission()) !== "granted") return;
    try {
      await plugin.register();
    } catch {
      // No token this time.
    }
  };
  // Launch and sign-in both lead here; one request for a token serves both.
  let syncing: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    syncing ??= askForToken().finally(() => { syncing = null; });
    return syncing;
  };

  const snapshot = async (): Promise<PushState> => {
    if (!(await isAvailable())) return { available: false, enabled: false, permission: "denied", showNames: false, delivers: null };
    return { available: true, enabled: prefs.enabled === true, permission: await permission(), showNames: prefs.showNames, delivers };
  };

  const enable = async (): Promise<PushState> => {
    if (!(await isAvailable())) return snapshot();
    let granted: PushPermission;
    try {
      granted = permissionFrom(await plugin.requestPermissions());
    } catch {
      granted = "denied";
    }
    // "No" to the system's question leaves the choice unmade: it can be
    // turned on later in the phone's settings and then here.
    savePrefs({ ...prefs, asked: true, enabled: granted === "granted" ? true : prefs.enabled });
    if (granted === "granted") {
      // A request that began before the yes would have stopped short.
      if (syncing) await syncing;
      await sync();
    }
    return snapshot();
  };

  const forget = async (from: PushApi | null, timeoutMs?: number): Promise<void> => {
    if (!from || !token) return;
    try {
      await from.removeDevice(token, timeoutMs ? { timeoutMs } : undefined);
    } catch {
      // The server also drops this phone when the session ends.
    }
  };

  const askOnce = async (): Promise<void> => {
    if (prefs.asked || prefs.enabled !== null || !api) return;
    if (!(await isAvailable())) return;
    // The phone already said no (an earlier install): do not count that as asking.
    if ((await permission()) === "denied") return;
    await enable();
  };

  return {
    start(handler) {
      onLink = handler;
      let stopped = false;
      const handles: { remove: () => Promise<void> }[] = [];
      const keep = (handle: { remove: () => Promise<void> }) => {
        if (stopped) void handle.remove().catch(() => undefined);
        else handles.push(handle);
      };
      ready = (async () => {
        if (!(await isAvailable()) || stopped) return;
        try {
          keep(await plugin.addListener("registration", (next) => {
            if (typeof next?.value !== "string" || !next.value) return;
            token = next.value;
            void send();
          }));
          keep(await plugin.addListener("registrationError", () => undefined));
          keep(await plugin.addListener("pushNotificationActionPerformed", (action) => {
            const data = action?.notification?.data;
            const link = data && typeof data === "object" ? (data as { link?: unknown }).link : null;
            if (typeof link === "string" && link.length <= MAX_LINK_CHARS) onLink?.(link);
          }));
        } catch {
          // The plugin is not there. Nothing else here will reach it either.
          availability = Promise.resolve(false);
        }
      })();
      void ready.then(() => sync());
      return () => {
        stopped = true;
        onLink = null;
        for (const handle of handles.splice(0)) void handle.remove().catch(() => undefined);
      };
    },

    setApi(next) {
      if (api === next) return;
      api = next;
      delivers = null;
      if (next) void sync();
    },

    state: snapshot,
    enable,

    async disable() {
      savePrefs({ ...prefs, asked: true, enabled: false });
      await forget(api);
      return snapshot();
    },

    async setShowNames(show) {
      savePrefs({ ...prefs, showNames: show });
      await send();
      return snapshot();
    },

    askOnce,

    async signOut(ending) {
      await forget(ending, SIGN_OUT_TIMEOUT_MS);
    },

    watch<T extends object>(client: T): T {
      const wrapped = Object.create(client) as Record<string, unknown>;
      for (const name of ASK_AFTER) {
        const original = (client as Record<string, unknown>)[name];
        if (typeof original !== "function") continue;
        wrapped[name] = async (...args: unknown[]) => {
          const result = await (original as (...a: unknown[]) => Promise<unknown>).apply(client, args);
          void askOnce().catch(() => undefined);
          return result;
        };
      }
      return wrapped as T;
    },
  };
}

function prefStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Whether this build can receive notifications. iOS always can. Android can
 * only with a Firebase project built in (android/app/google-services.json),
 * and the push plugin's register() must not be called without one, so the
 * app's own MarkiePush plugin (PushAvailabilityPlugin.java) is asked first.
 */
async function nativeAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("PushNotifications")) return false;
  const platform = Capacitor.getPlatform();
  if (platform === "ios") return true;
  if (platform !== "android") return false;
  const answer = await registerPlugin<{ available(): Promise<{ available?: boolean }> }>("MarkiePush").available();
  return answer?.available === true;
}

let shared: PushController | null = null;

/** The app's one controller, over the real plugin. */
export function pushController(): PushController {
  if (!shared) {
    const platform = Capacitor.getPlatform();
    shared = createPushController({
      plugin: PushNotifications as unknown as PushPlugin,
      platform: platform === "ios" || platform === "android" ? platform : "web",
      available: nativeAvailable,
      storage: prefStorage(),
    });
  }
  return shared;
}
