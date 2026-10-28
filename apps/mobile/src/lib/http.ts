// The one seam between the API client and the network, so the client can be
// tested without a device and the app can swap the native transport for the
// browser's fetch while developing in a desktop browser.

export type HttpMethod = "GET" | "POST" | "PUT";

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** Serialized as JSON when present. */
  body?: unknown;
  /** "binary" for an image: the answer arrives in `bytes`, not `text`. */
  responseType?: "text" | "binary";
  /** Gives up after this long. The transport's own limit when absent. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** The raw response text. Parsing is the client's job, with its own limits. Empty for a binary answer. */
  text: string;
  /** The body of a successful binary request. */
  bytes?: Uint8Array;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** The request never reached the server, or no answer came back. */
export class NetworkError extends Error {
  constructor(message = "Can't reach the server. Check your connection.") {
    super(message);
    this.name = "NetworkError";
  }
}

export function lowerCaseHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") out[name.toLowerCase()] = value;
    else if (Array.isArray(value)) out[name.toLowerCase()] = value.map(String).join(", ");
    else if (value != null) out[name.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Browser fetch, for `npm run dev` in a desktop browser against the mock
 * server. No cookies either way and no redirects: a redirect would carry the
 * bearer token to wherever it points.
 */
export function fetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return async (request) => {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: { ...(request.body === undefined ? {} : { "content-type": "application/json" }), ...request.headers },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
      });
    } catch {
      throw new NetworkError();
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    if (request.responseType === "binary" && response.ok) {
      return { status: response.status, headers, text: "", bytes: new Uint8Array(await response.arrayBuffer()) };
    }
    return { status: response.status, headers, text: await response.text() };
  };
}

/** Capacitor hands binary answers back as base64. */
export function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
