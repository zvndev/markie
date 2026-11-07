# Hosting Live Docs

Every cloud document with format `darkmown` (a `.wd`) gets its own address, `<label>.<LIVE_DOCS_DOMAIN>`. In H1 it opens only for its owner, through a one-time pass. This page covers turning it on, running it locally, and putting it on `markie.live` in production.

The design is `markie-darkmown-sites-design-2026-11-01.md` (Circular ENG-7835). The code is `server/src/live-docs*.ts`.

## Turn it on

| Variable | Value | Effect |
|---|---|---|
| `LIVE_DOCS_DOMAIN` | unset | Off. No live routes, no addresses handed out |
| `LIVE_DOCS_DOMAIN` | `markie.live` | Production. Live Docs on `https://<label>.markie.live` |
| `LIVE_DOCS_DOMAIN` | `localhost:8787` | Local. Live Docs on `http://<label>.localhost:8787` |

The server refuses to boot when the live domain equals, contains, sits under, or shares a registrable domain with any name the app answers on: `BETTER_AUTH_URL`, its aliases, `MARKIE_SITE_URL` and `MARKIE_WEB_ORIGINS`. A Live Doc must never be able to read or plant the app's cookies.

## Run it locally

The app has to run on `127.0.0.1`, because `localhost` is the live domain and the boot check refuses the overlap.

```sh
cd server
DB_PATH=/tmp/live-docs/markie.db BETTER_AUTH_URL=http://127.0.0.1:8787 \
LIVE_DOCS_DOMAIN=localhost:8787 MARKIE_OFFICIAL=0 MARKIE_SIGNUP=open MARKIE_MAIL_LOG=1 \
  sh -c 'node --experimental-strip-types src/migrate.ts && npm run dev'
```

1. Point a nightly Mac build (or `npm run dev` with `localStorage["markie.nightly"] = "1"`) at `http://127.0.0.1:8787` and sync a `.wd`.
2. In the Library, open the row's menu: Copy Live Doc address, or Open Live Doc.
3. The browser goes to the address, then to the Markie sign-in on `127.0.0.1`, then back to the page.

Chrome and Firefox treat `http://*.localhost` as secure, so the `__Host-` cookie works there. Safari refuses a Secure cookie over plain http and shows "This browser didn't keep the Live Doc's cookie". It needs https, which production has.

Measured on 2026-11-03 with Playwright 1.63 against a local server:

| Check | Chromium | Firefox | WebKit |
|---|---|---|---|
| Owner opens the page, button runs (0 to 1) | yes | yes | no: needs https |
| CSP violations on the page | 0 | 1, its own favicon request | n/a |
| Cookie host-only, Secure, HttpOnly, Lax | yes | yes | refused over http |
| Signed out lands on the Markie sign-in | yes | yes | yes |
| Signed-in stranger gets 404 | yes | yes | yes |
| Owner's cookie after delete: refused | yes | not run | not run |

## How a request is routed

| Host | Answers |
|---|---|
| `<label>.<domain>`, 16 base32 characters | `/` the page, `/__markie/pass` the redeem. Everything else is 404 |
| `<domain>` itself | `/` redirects to `MARKIE_SITE_URL`. No cookie. Everything else is 404 |
| Any other name under `<domain>` | 404 |
| Any other host | The app, as before. `/live-docs/pass/<label>` and `/api/docs/:id/live-doc` live here |

- The live domain is answered before every app middleware, so no app route, CORS grant or app cookie can come back from a Live Doc host.
- When `Host` or `X-Forwarded-Host` names the live domain, the two must agree exactly, or the request is a 404. kamal-proxy forwards a client's own `X-Forwarded-*` headers for markie-api (Kamal's `forward_headers` defaults to on without `ssl`), so neither header alone can carry a request across.
- Every live response carries HSTS, `nosniff`, `Referrer-Policy: no-referrer`, COOP and CORP `same-origin`, `X-Frame-Options: DENY`, a Permissions-Policy denying camera, microphone and geolocation, `X-Robots-Tag: noindex, nofollow` and `Cache-Control: private, no-store`.
- The page's CSP admits the pinned runtime and its bootstrap by hash, and its one style block by hash. `connect-src` and `form-action` are `'none'` in H1.

## Production on markie.live

What any host needs to serve Live Docs. The exact steps for Markie Cloud's own boxes, DNS and accounts are kept with the private infrastructure, not in this repo.

| Need | Why |
|---|---|
| One wildcard certificate, `*.markie.live` plus `markie.live`, by DNS-01 | HTTP-01 cannot issue a wildcard. Per-label certificates are not an option, below |
| A wildcard DNS record, `*.markie.live`, to the server that runs the database writer | No record per Live Doc, so labels never appear in DNS |
| The TLS edge accepts SNI matching `^([a-z2-7]{16}\.)?markie\.live$` exactly | Match the label shape, not a suffix. A two-level name must never reach a proxy's catch-all service |
| The Host header passes through as sent, equal to the SNI | The server decides app or Live Doc from the real Host. A Host rewrite would turn every Live Doc into an app request, which the server then refuses |
| The reverse proxy routes `*.markie.live` and `markie.live` to markie-api | kamal-proxy v0.9.2 matches a one-level wildcard host: an exact host first, then `*` plus the name after its first dot, then its catch-all service (`internal/server/service_map.go`). Kamal 2.12 passes `proxy.hosts` through unchanged |
| `LIVE_DOCS_DOMAIN=markie.live` on the server | Turns the feature on and runs the boot check |
| CAA on `markie.live` naming the one CA in use, for `issue` and `issuewild` | Only that CA can issue for any label |

In Kamal terms the app side is:

```yaml
env:
  clear:
    LIVE_DOCS_DOMAIN: markie.live
proxy:
  hosts:
    - api.markiedocs.com
    - "*.markie.live"
    - markie.live
```

Then check it:

```sh
curl -sI https://aaaaaaaaaaaaaaaa.markie.live/      # 302 to https://api.markiedocs.com/live-docs/pass/aaaaaaaaaaaaaaaa, the Live Doc headers, no cookie
curl -sI https://markie.live/                       # 302 to https://markiedocs.com
curl -sI https://www.markie.live/                   # refused at the TLS handshake
curl -sI https://x.aaaaaaaaaaaaaaaa.markie.live/    # refused at the TLS handshake
```

The H1 finish line: the owner opens their own Live Doc's address on a phone, and a private window gets the sign-in page.

### Why not one certificate per Live Doc

Every certificate is published in Certificate Transparency logs within minutes, so per-label certificates would put each private Live Doc's address on crt.sh. Let's Encrypt also allows 50 certificates per registered domain a week. The wildcard keeps labels out of CT, and the wildcard DNS record keeps them out of DNS.

### Fallback: a CDN in front

If the edge cannot take the wildcard, put `markie.live` behind Cloudflare instead: its nameservers on a Cloudflare zone, a proxied `*.markie.live` record (Universal SSL covers `markie.live` and `*.markie.live`), and a tunnel route for `*.markie.live` to the reverse proxy. The app side is unchanged. It costs the CDN's request size and time limits, and the CDN sees every label.

### Logs

Labels appear in proxy logs as the host. Tickets do not need to: they ride in the query string, so a proxy log that keeps queries should redact them. A ticket is single use and expires in 60 seconds either way.

### Later

- Submit `markie.live` to the Public Suffix List once it serves, so browsers treat each label as its own site. Approval takes weeks and nothing waits on it.
- HSTS preload for `markie.live`. The header already sends `includeSubDomains`.

## How a compile is contained

Each compile runs in its own short-lived Node process (`server/src/live-docs-child.ts`), never in the server's process. A worker thread is not enough: when a worker runs out of heap, V8 can abort the whole server. The child gets:

- a 64 MB old generation and a small young generation;
- an empty environment;
- Node's permission model: it reads only its own script, `server/src/generated/darkmown/` and the server's `node_modules`, and cannot write files or start processes, workers or addons;
- no code generation from strings;
- 8 seconds of wall clock, then SIGKILL;
- capped stdout and stderr, and a one-line JSON reply that the server validates before use.

Production runs Node 22, whose permission model has no network permission. The child removes the network globals (`fetch`, `WebSocket` and the like) before the compiler loads, but `node:net` and `node:http` stay importable. That is acceptable only because the compiler never runs the source as code: Darkmown parses it, and its expressions are a closed AST, so nothing in a Live Doc can reach an import. Moving the image to Node 25 or later turns on the network permission as a second wall.

A compile that fails (out of time or memory) is remembered for 5 minutes, so reloading a broken Live Doc starts no new process. Each owner may have one compile running and four in flight at once, and past that gets "busy" for themselves alone, so one account cannot hold every slot.

Results are cached by source hash and compiler version, so each change to a Live Doc pays for one process start. The server image needs nothing extra: the child and everything it imports are under `src/` and the production `node_modules`.

## Keeping the server's Darkmown in step with the Mac

The server compiles with copies of the Mac app's pinned compiler, runtime, bootstrap, limits and sanitizer, in `server/src/generated/darkmown/`, because its Docker context is `server/` alone. After any change to `src/lib/darkmown/vendor/`, `security.ts`, the preview style, `mcp/darkmown-limits.mjs` or the runtime policy:

```sh
(cd server && npm run darkmown:sync)
```

`server/src/live-docs-parity.test.ts` fails while a copy differs, and `src/lib/darkmown/hosted-parity.test.ts` runs every sample through both pipelines and expects the same output.
