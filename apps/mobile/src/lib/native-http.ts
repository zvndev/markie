// Requests from the app go through the platform's own HTTP stack
// (URLSession, HttpURLConnection) rather than the web view's fetch. The web
// view's origin (capacitor://localhost, https://localhost) is not one the
// server grants CORS to, and a native request carries no Origin header, which
// is what the desktop's main-process sync already relies on.
//
// Two rules keep the bearer token the only credential:
// - Redirects are never followed. The token goes to the chosen origin and
//   nowhere a 3xx might point.
// - Cookies are cleared after every response. Both platforms' stacks keep
//   Set-Cookie in a shared jar on their own, and better-auth sets its session
//   cookie on sign-in. A copy of the session in a cookie jar would be a second,
//   unencrypted credential that outlives "Sign out", so none is ever kept.
import { CapacitorCookies, CapacitorHttp } from "@capacitor/core";
import { lowerCaseHeaders, NetworkError, type HttpTransport } from "./http";

const TIMEOUT_MS = 20_000;

export function nativeTransport(): HttpTransport {
  return async (request) => {
    try {
      const response = await CapacitorHttp.request({
        method: request.method,
        url: request.url,
        headers: {
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        data: request.body === undefined ? undefined : request.body,
        responseType: "text",
        disableRedirects: true,
        connectTimeout: TIMEOUT_MS,
        readTimeout: TIMEOUT_MS,
      });
      const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? null);
      return { status: response.status, headers: lowerCaseHeaders(response.headers), text };
    } catch {
      throw new NetworkError();
    } finally {
      await CapacitorCookies.clearAllCookies().catch(() => undefined);
    }
  };
}
