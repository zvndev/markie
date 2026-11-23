// Delivery of a push notification to one phone: Apple's APNs for iOS and
// Firebase Cloud Messaging for Android. Who gets one, and what it says, is
// decided in devices.ts; this file only talks to the two services.
//
// No new dependency. APNs is HTTP/2 with a short ES256 token signed by the
// .p8 key (node:http2, node:crypto). FCM's HTTP v1 API is a plain HTTPS call
// with an OAuth access token, which Google hands out in exchange for an RS256
// assertion signed by the service account's key (fetch, node:crypto).
//
// Each platform is on only when its secrets are set (runtime-config.ts
// pushSettings). Off, send() answers "off" without touching the network. A
// secret that is present but unreadable also leaves the platform off, with
// one warning that names the variable and never the value: a comment must
// still be saved, and its email still sent, on a server whose push setup is
// wrong.
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { pushSettings, type PushSettings } from "./runtime-config.ts";

export type PushPlatform = "ios" | "android";

export interface PushMessage {
  title: string;
  body: string;
  /** The Markie link the app opens when the notification is tapped. */
  link: string;
  /** Notifications with the same group stack together on the phone. */
  group: string;
}

/**
 * sent: the service took it. dead: the service says this token will never
 * work again, so the caller forgets it. failed: anything else, kept for the
 * next time. off: this platform has no secrets here.
 */
export type PushResult = "sent" | "dead" | "failed" | "off";

export interface PushSender {
  /** Whether this server can deliver to that platform at all. */
  delivers(platform: PushPlatform): boolean;
  send(platform: PushPlatform, token: string, message: PushMessage): Promise<PushResult>;
  /** Drops the APNs connection. For tests and a stopping server. */
  close(): void;
}

/** Where the two services live. Only tests name anything else. */
export interface PushEndpoints {
  apns?: string;
  fcm?: string;
  googleToken?: string;
}

const APNS_PRODUCTION = "https://api.push.apple.com";
const APNS_DEVELOPMENT = "https://api.sandbox.push.apple.com";
const FCM_ORIGIN = "https://fcm.googleapis.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const REQUEST_TIMEOUT_MS = 10_000;
// Apple refuses a provider token older than an hour and throttles one that is
// re-signed more often than every twenty minutes.
const APNS_TOKEN_LIFETIME_MS = 40 * 60 * 1000;
// An idle connection is closed rather than held open to Apple all day.
const APNS_IDLE_MS = 5 * 60 * 1000;
// A notification nobody saw within a day is not worth delivering late.
const EXPIRES_AFTER_SECONDS = 24 * 60 * 60;
const WARN_EVERY_MS = 10 * 60 * 1000;

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

interface Apns {
  key: KeyObject;
  keyId: string;
  teamId: string;
  bundleId: string;
  origin: string;
}

interface Fcm {
  key: KeyObject;
  clientEmail: string;
  projectId: string;
}

function readApns(settings: PushSettings, warn: (message: string) => void): Omit<Apns, "origin"> | null {
  if (!settings.apns) return null;
  let key: KeyObject;
  try {
    key = createPrivateKey(settings.apns.key);
  } catch {
    warn("push: iOS is off. APNS_KEY is set but is not a readable private key. Use the contents of Apple's .p8 file.");
    return null;
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    warn("push: iOS is off. APNS_KEY must be the P-256 key Apple issued for push notifications.");
    return null;
  }
  return { key, keyId: settings.apns.keyId, teamId: settings.apns.teamId, bundleId: settings.apns.bundleId };
}

function readFcm(settings: PushSettings, warn: (message: string) => void): Fcm | null {
  if (!settings.fcm) return null;
  try {
    const account = JSON.parse(settings.fcm.serviceAccount) as { client_email?: unknown; private_key?: unknown; project_id?: unknown };
    if (typeof account.client_email !== "string" || typeof account.private_key !== "string" || typeof account.project_id !== "string") {
      throw new Error("missing fields");
    }
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(account.project_id)) throw new Error("bad project id");
    const key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not an RSA key");
    return { key, clientEmail: account.client_email, projectId: account.project_id };
  } catch {
    warn("push: Android is off. FCM_SERVICE_ACCOUNT is set but is not a Firebase service account JSON file (or its base64).");
    return null;
  }
}

export function createPushSender(
  settings: PushSettings,
  endpoints: PushEndpoints = {},
  { now = () => Date.now(), warn = (message: string) => console.warn(message) }: { now?: () => number; warn?: (message: string) => void } = {}
): PushSender {
  if (settings.incomplete.length) {
    warn(`push: iOS is off. ${settings.incomplete.join(", ")} not set.`);
  }
  const apnsRead = readApns(settings, warn);
  const apns: Apns | null = apnsRead
    ? { ...apnsRead, origin: endpoints.apns ?? (settings.apns?.environment === "development" ? APNS_DEVELOPMENT : APNS_PRODUCTION) }
    : null;
  const fcm = readFcm(settings, warn);
  const fcmOrigin = endpoints.fcm ?? FCM_ORIGIN;
  const googleTokenUrl = endpoints.googleToken ?? GOOGLE_TOKEN_URL;

  // A service that keeps refusing says so in the log, but not once per phone.
  const warned = new Map<string, number>();
  const refused = (what: string) => {
    const at = now();
    if (at - (warned.get(what) ?? -Infinity) < WARN_EVERY_MS) return;
    warned.set(what, at);
    warn(`push: ${what}`);
  };

  // --- APNs ---------------------------------------------------------------

  let providerToken = "";
  let providerTokenAt = 0;
  const apnsToken = (config: Apns): string => {
    const at = now();
    if (providerToken && at - providerTokenAt < APNS_TOKEN_LIFETIME_MS && at >= providerTokenAt) return providerToken;
    const header = b64url({ alg: "ES256", kid: config.keyId });
    const claims = b64url({ iss: config.teamId, iat: Math.floor(at / 1000) });
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: config.key, dsaEncoding: "ieee-p1363" });
    providerToken = `${header}.${claims}.${signature.toString("base64url")}`;
    providerTokenAt = at;
    return providerToken;
  };

  let session: ClientHttp2Session | null = null;
  const forget = (which: ClientHttp2Session) => {
    if (session === which) session = null;
  };
  const apnsSession = (config: Apns): ClientHttp2Session => {
    if (session && !session.closed && !session.destroyed) return session;
    const next = connect(config.origin);
    // Never the reason the process stays up.
    next.unref();
    next.setTimeout(APNS_IDLE_MS, () => next.close());
    next.on("error", () => forget(next));
    next.on("goaway", () => forget(next));
    next.on("close", () => forget(next));
    session = next;
    return next;
  };

  const sendApns = (config: Apns, token: string, message: PushMessage): Promise<PushResult> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result: PushResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const request = apnsSession(config).request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${apnsToken(config)}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(now() / 1000) + EXPIRES_AFTER_SECONDS),
          "content-type": "application/json",
        });
        let status = 0;
        let text = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => { status = Number(headers[":status"]); });
        request.on("data", (chunk: string) => { if (text.length < 2048) text += chunk; });
        request.on("end", () => {
          if (status === 200) return finish("sent");
          let reason = "";
          try {
            reason = String((JSON.parse(text) as { reason?: unknown }).reason ?? "");
          } catch {
            // no body
          }
          // 410: the app was removed or the token replaced. BadDeviceToken:
          // not a token for this app on this service.
          if (status === 410 || (status === 400 && reason === "BadDeviceToken")) return finish("dead");
          // A rejected provider token is signed afresh next time.
          if (status === 403) providerToken = "";
          refused(`Apple answered ${status}${/^[A-Za-z]{1,64}$/.test(reason) ? ` ${reason}` : ""}.`);
          finish("failed");
        });
        request.on("error", () => { refused("Apple could not be reached."); finish("failed"); });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
          request.close(constants.NGHTTP2_CANCEL);
          refused("Apple did not answer in time.");
          finish("failed");
        });
        request.end(JSON.stringify({
          aps: {
            alert: { title: message.title, body: message.body },
            sound: "default",
            "thread-id": message.group,
          },
          link: message.link,
        }));
      } catch {
        refused("Apple could not be reached.");
        finish("failed");
      }
    });

  // --- FCM ----------------------------------------------------------------

  let accessToken = "";
  let accessTokenUntil = 0;
  let fetching: Promise<string | null> | null = null;
  const fetchAccessToken = async (config: Fcm): Promise<string | null> => {
    const issued = Math.floor(now() / 1000);
    const header = b64url({ alg: "RS256", typ: "JWT" });
    // The audience is always Google's token endpoint, whatever the file says:
    // the assertion is a credential, and it is only ever made out to Google.
    const claims = b64url({ iss: config.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: issued, exp: issued + 3600 });
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), config.key);
    const assertion = `${header}.${claims}.${signature.toString("base64url")}`;
    const response = await fetch(googleTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      refused(`Google refused the Firebase service account (${response.status}).`);
      return null;
    }
    const data = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof data?.access_token !== "string" || !data.access_token) return null;
    const lifetime = typeof data.expires_in === "number" && data.expires_in > 120 ? data.expires_in : 3600;
    accessToken = data.access_token;
    accessTokenUntil = now() + (lifetime - 60) * 1000;
    return accessToken;
  };
  const fcmAccessToken = (config: Fcm): Promise<string | null> => {
    if (accessToken && now() < accessTokenUntil) return Promise.resolve(accessToken);
    // One exchange at a time, however many phones are waiting on it.
    fetching ??= fetchAccessToken(config)
      .catch(() => { refused("Google could not be reached."); return null; })
      .finally(() => { fetching = null; });
    return fetching;
  };

  const sendFcm = async (config: Fcm, token: string, message: PushMessage): Promise<PushResult> => {
    try {
      const bearer = await fcmAccessToken(config);
      if (!bearer) return "failed";
      const response = await fetch(`${fcmOrigin}/v1/projects/${config.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: { link: message.link },
            android: { priority: "HIGH", ttl: `${EXPIRES_AFTER_SECONDS}s`, notification: { tag: message.group } },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return "sent";
      }
      const data = (await response.json().catch(() => null)) as
        | { error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> } }
        | null;
      const code = data?.error?.details?.find((detail) => typeof detail?.errorCode === "string")?.errorCode;
      // Only Firebase's own word for it. A 404 alone can also mean a wrong
      // project, and that must not empty the table.
      if (code === "UNREGISTERED") return "dead";
      if (response.status === 401) accessToken = "";
      const status = typeof data?.error?.status === "string" && /^[A-Z_]{1,64}$/.test(data.error.status) ? ` ${data.error.status}` : "";
      refused(`Firebase answered ${response.status}${status}.`);
      return "failed";
    } catch {
      refused("Firebase could not be reached.");
      return "failed";
    }
  };

  return {
    delivers(platform) {
      return platform === "ios" ? apns !== null : fcm !== null;
    },
    send(platform, token, message) {
      if (platform === "ios") return apns ? sendApns(apns, token, message) : Promise.resolve("off");
      return fcm ? sendFcm(fcm, token, message) : Promise.resolve("off");
    },
    close() {
      const open = session;
      session = null;
      open?.destroy();
    },
  };
}

let shared: PushSender | null = null;

/** The server's one sender, made from the environment on first use. */
export function pushSender(): PushSender {
  if (!shared) {
    shared = createPushSender(pushSettings());
    const on = [shared.delivers("ios") ? "iOS" : "", shared.delivers("android") ? "Android" : ""].filter(Boolean);
    // Silent when both are off: that is every server that has not set this up.
    if (on.length) console.log(`push: on for ${on.join(" and ")}`);
  }
  return shared;
}

/** Test seam: swap the shared sender, or pass null to read the environment again. */
export function setPushSenderForTests(next: PushSender | null): void {
  shared?.close();
  shared = next;
}
