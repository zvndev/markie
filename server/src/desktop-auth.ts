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

// The server's own origin, from BETTER_AUTH_URL, or null when that is not a
// URL. Only the origin: a path or query on the setting says nothing about who
// issued the token.
export function desktopAuthIssuer(authBase: string | null | undefined): string | null {
  if (typeof authBase !== "string" || !authBase) return null;
  try {
    const origin = new URL(authBase).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

// A link with no state is still produced (an older app build sends none), but
// current builds reject it, which is what makes the check meaningful.
//
// `iss` names the server that minted the token. The nonce alone cannot: with
// more than one server, a server the user added can start its "Google
// sign-in" by bouncing the browser to another server's bridge with the app's
// nonce, and the token that comes back would be filed under the wrong server.
// The app compares `iss` with the server it started the sign-in against.
export function desktopAuthDeepLink(token: string, state: string | null, issuer: string | null = null): string {
  let link = `markie://auth?token=${encodeURIComponent(token)}`;
  if (state) link += `&state=${encodeURIComponent(state)}`;
  if (issuer) link += `&iss=${encodeURIComponent(issuer)}`;
  return link;
}
