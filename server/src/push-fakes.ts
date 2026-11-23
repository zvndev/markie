// Test-only: a fake Apple push service and a fake Google (the token endpoint
// and Firebase Cloud Messaging), on loopback, with throwaway keys. The real
// sender (push.ts) is pointed at them, so what a suite sees is what Apple and
// Google would have been sent.
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttp2Server, type Http2Server } from "node:http2";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { pushSettings, type PushSettings } from "./runtime-config.ts";

export interface FakeApnsRequest {
  token: string;
  headers: Record<string, string>;
  body: { aps?: { alert?: { title?: string; body?: string }; sound?: string; "thread-id"?: string }; link?: string };
  /** The provider token's header and claims, once its signature checked out. */
  provider: { kid?: string; iss?: string; iat?: number } | null;
  raw: string;
}

export interface FakeFcmRequest {
  token: string;
  project: string;
  authorization: string;
  message: { token?: string; notification?: { title?: string; body?: string }; data?: { link?: string }; android?: unknown };
  raw: string;
}

const APNS_KEY_ID = "TESTKEY123";
const APNS_TEAM_ID = "TESTTEAM12";
const APNS_BUNDLE_ID = "com.zvn.markie.mobile";
const FCM_PROJECT = "markie-test";
const FCM_CLIENT_EMAIL = "push@markie-test.iam.gserviceaccount.com";
const ACCESS_TOKEN = "fake-google-access-token";

function decodeJwt(jwt: string, key: KeyObject, algorithm: "ES256" | "RS256"): { header: Record<string, unknown>; claims: Record<string, unknown> } | null {
  const [header, claims, signature] = jwt.split(".");
  if (!header || !claims || !signature) return null;
  const data = Buffer.from(`${header}.${claims}`);
  const ok = algorithm === "ES256"
    ? verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))
    : verify("sha256", data, key, Buffer.from(signature, "base64url"));
  if (!ok) return null;
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")),
  };
}

export interface PushFakes {
  /** The environment a server would be given to reach these fakes' accounts. */
  env: Record<string, string>;
  settings: PushSettings;
  endpoints: { apns: string; fcm: string; googleToken: string };
  apns: FakeApnsRequest[];
  fcm: FakeFcmRequest[];
  /** How many times an access token was asked of Google. */
  tokenExchanges: () => number;
  /** Answer for one device token: an HTTP status and, for Apple, a reason. */
  answerApns(token: string, status: number, reason?: string): void;
  answerFcm(token: string, status: number, errorCode?: string): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startPushFakes(): Promise<PushFakes> {
  const apple = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const google = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const apns: FakeApnsRequest[] = [];
  const fcm: FakeFcmRequest[] = [];
  const apnsAnswers = new Map<string, { status: number; reason?: string }>();
  const fcmAnswers = new Map<string, { status: number; errorCode?: string }>();
  let exchanges = 0;

  // Apple: HTTP/2, here without TLS (prior knowledge), which node's client
  // speaks to an http:// origin.
  const appleServer: Http2Server = createHttp2Server();
  appleServer.on("stream", (stream, headers) => {
    let raw = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { raw += chunk; });
    stream.on("end", () => {
      const token = String(headers[":path"] ?? "").replace(/^\/3\/device\//, "");
      const bearer = String(headers.authorization ?? "").replace(/^bearer /, "");
      const jwt = decodeJwt(bearer, apple.publicKey, "ES256");
      const flat: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) flat[name] = String(value);
      apns.push({
        token,
        headers: flat,
        body: JSON.parse(raw || "{}"),
        provider: jwt ? { kid: jwt.header.kid as string, iss: jwt.claims.iss as string, iat: jwt.claims.iat as number } : null,
        raw,
      });
      if (!jwt) {
        stream.respond({ ":status": 403, "content-type": "application/json" });
        stream.end(JSON.stringify({ reason: "InvalidProviderToken" }));
        return;
      }
      const answer = apnsAnswers.get(token) ?? { status: 200 };
      stream.respond({ ":status": answer.status, "content-type": "application/json" });
      stream.end(answer.status === 200 ? "" : JSON.stringify({ reason: answer.reason ?? "InternalServerError" }));
    });
  });

  const googleServer: Server = createHttpServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/token") {
        exchanges += 1;
        const form = new URLSearchParams(raw);
        const jwt = decodeJwt(form.get("assertion") ?? "", google.publicKey, "RS256");
        const good = jwt
          && form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer"
          && jwt.claims.iss === FCM_CLIENT_EMAIL
          && jwt.claims.aud === "https://oauth2.googleapis.com/token"
          && jwt.claims.scope === "https://www.googleapis.com/auth/firebase.messaging";
        return good ? json(200, { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" }) : json(400, { error: "invalid_grant" });
      }
      const send = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(req.url ?? "");
      if (req.method === "POST" && send) {
        const body = JSON.parse(raw || "{}") as { message?: FakeFcmRequest["message"] };
        const token = body.message?.token ?? "";
        fcm.push({ token, project: send[1], authorization: String(req.headers.authorization ?? ""), message: body.message ?? {}, raw });
        if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return json(401, { error: { status: "UNAUTHENTICATED" } });
        const answer = fcmAnswers.get(token) ?? { status: 200 };
        if (answer.status === 200) return json(200, { name: `projects/${send[1]}/messages/1` });
        return json(answer.status, {
          error: {
            code: answer.status,
            status: answer.status === 404 ? "NOT_FOUND" : "INTERNAL",
            details: answer.errorCode ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: answer.errorCode }] : [],
          },
        });
      }
      json(404, { error: "not found" });
    });
  });

  await new Promise<void>((resolve) => appleServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => googleServer.listen(0, "127.0.0.1", resolve));
  const applePort = (appleServer.address() as AddressInfo).port;
  const googlePort = (googleServer.address() as AddressInfo).port;

  const env = {
    APNS_KEY: apple.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    APNS_KEY_ID,
    APNS_TEAM_ID,
    APNS_BUNDLE_ID,
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      type: "service_account",
      project_id: FCM_PROJECT,
      client_email: FCM_CLIENT_EMAIL,
      private_key: google.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      // A real file names Google here. The sender must not follow it.
      token_uri: "https://attacker.example/token",
    }),
  };

  return {
    env,
    settings: pushSettings(env),
    endpoints: {
      apns: `http://127.0.0.1:${applePort}`,
      fcm: `http://127.0.0.1:${googlePort}`,
      googleToken: `http://127.0.0.1:${googlePort}/token`,
    },
    apns,
    fcm,
    tokenExchanges: () => exchanges,
    answerApns(token, status, reason) { apnsAnswers.set(token, { status, reason }); },
    answerFcm(token, status, errorCode) { fcmAnswers.set(token, { status, errorCode }); },
    reset() {
      apns.length = 0;
      fcm.length = 0;
      apnsAnswers.clear();
      fcmAnswers.clear();
    },
    async close() {
      await new Promise<void>((resolve) => appleServer.close(() => resolve()));
      googleServer.closeAllConnections();
      await new Promise<void>((resolve) => googleServer.close(() => resolve()));
    },
  };
}

export const FAKE_PUSH_IDS = { APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, FCM_PROJECT, ACCESS_TOKEN } as const;
