// Requests from the app go through the platform's own HTTP stack
// (URLSession, HttpURLConnection) rather than the web view's fetch. The web
// view's origin (capacitor://localhost, https://localhost) is not one the
// server grants CORS to, and a native request carries no Origin header, which
// is what the desktop's main-process sync already relies on.
//
// Nothing a request returns is kept on disk. Every request says
// `Cache-Control: no-store`, the server answers API calls with it, and on iOS
// URLSession's shared cache has no capacity at all
// (ios/App/App/MarkieBridgeViewController.swift). Android's HttpURLConnection
// has no response cache unless one is installed, and none is.
//
// Two rules keep the bearer token the only credential:
// - Redirects are never followed. The token goes to the chosen origin and
//   nowhere a 3xx might point.
// - Cookies are cleared after every response. Both platforms' stacks keep
//   Set-Cookie in a shared jar on their own, and better-auth sets its session
//   cookie on sign-in. A copy of the session in a cookie jar would be a second,
//   unencrypted credential that outlives "Sign out", so none is ever kept.
import { CapacitorCookies, CapacitorHttp } from "@capacitor/core";
import { bytesFromBase64, lowerCaseHeaders, NetworkError, type HttpRequest, type HttpTransport } from "./http";

const TIMEOUT_MS = 20_000;

/** The headers every native request carries, before the caller's own. */
export function nativeRequestHeaders(request: HttpRequest): Record<string, string> {
  return {
    accept: request.responseType === "binary" ? "image/*" : "application/json",
    "cache-control": "no-store",
    ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    ...request.headers,
  };
}

export function nativeTransport(): HttpTransport {
  return async (request) => {
    const binary = request.responseType === "binary";
    const timeout = request.timeoutMs ?? TIMEOUT_MS;
    try {
      const response = await CapacitorHttp.request({
        method: request.method,
        url: request.url,
        headers: nativeRequestHeaders(request),
        data: request.body === undefined ? undefined : request.body,
        responseType: binary ? "blob" : "text",
        disableRedirects: true,
        connectTimeout: timeout,
        readTimeout: timeout,
      });
      const headers = lowerCaseHeaders(response.headers);
      if (binary && response.status >= 200 && response.status < 300 && typeof response.data === "string") {
        return { status: response.status, headers, text: "", bytes: bytesFromBase64(response.data) };
      }
      const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? null);
      return { status: response.status, headers, text };
    } catch {
      throw new NetworkError();
    } finally {
      await CapacitorCookies.clearAllCookies().catch(() => undefined);
    }
  };
}
