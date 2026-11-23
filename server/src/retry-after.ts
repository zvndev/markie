// better-auth answers a rate-limited request with 429 and its own
// `X-Retry-After` header. `Retry-After` is the standard one, and the one the
// phone app reads to say how long to wait (mobile plan 8.11). This adds it to
// any 429 that lacks it, and leaves every other answer exactly as it is.

/** Used when a 429 carries no readable wait at all. One minute is the longest sign-in window (auth.ts rateLimit). */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

export function withRetryAfter(response: Response): Response {
  if (response.status !== 429 || response.headers.has("Retry-After")) return response;
  const hinted = Number(response.headers.get("X-Retry-After"));
  const seconds = Number.isFinite(hinted) && hinted > 0
    ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(hinted))
    : DEFAULT_RETRY_AFTER_SECONDS;
  try {
    response.headers.set("Retry-After", String(seconds));
    return response;
  } catch {
    // A response whose headers can't be changed is copied, body and all.
    const headers = new Headers(response.headers);
    headers.set("Retry-After", String(seconds));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
