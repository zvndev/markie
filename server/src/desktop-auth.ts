// The desktop OAuth bridge hands a session token back to the app through a
// `markie://auth` deep link. Markie is the registered protocol handler on the
// user's machine, so any web page can fire that scheme: a token alone does not
// prove the app asked for it. The app mints a single-use nonce before opening
// the browser and we carry it back untouched, so the app can match the deep
// link to the sign-in it started. See src/lib/auth-state.ts in the app.

// The nonce is echoed into a URL we hand to the browser, so only the shape the
// app produces is accepted. Anything else is dropped rather than reflected,
// which keeps the query string from becoming an injection point.
const STATE_PATTERN = /^[0-9a-f]{8,128}$/;

export function desktopAuthState(raw: string | null | undefined): string | null {
  return typeof raw === "string" && STATE_PATTERN.test(raw) ? raw : null;
}

// A link with no state is still produced (an older app build sends none), but
// current builds reject it, which is what makes the check meaningful.
export function desktopAuthDeepLink(token: string, state: string | null): string {
  const base = `markie://auth?token=${encodeURIComponent(token)}`;
  return state ? `${base}&state=${encodeURIComponent(state)}` : base;
}
