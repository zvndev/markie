// The Markie web app: the desktop renderer's editor, built for a browser
// (`npm run build:web` at the repo root, src/web) and served here on the
// server's own origin, so the web sign-in's session cookie is the credential.
//
//   GET /app            the cloud library
//   GET /app/d/<id>     one document, open in the editor
//   GET /app/new        the library with the new-document chooser open
//   GET /app/assets/*   the build's scripts, styles and fonts
//
// The build lands in server/web-dist/, which is gitignored apart from a
// placeholder, so an image built without it still builds. Without the build
// every /app route is a plain 404 page and webAppAvailable() says false, so
// nothing else on the server sends a reader there.
//
// A signed-out visitor to an /app page goes to the web sign-in and comes back
// to the same page. Assets need no session: they are the same public bundle
// for everyone and carry nothing about any account.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

const DEFAULT_DIR = fileURLToPath(new URL("../web-dist/", import.meta.url));
// The SPA shell. Named app.html, not index.html, because it is built from the
// repo root's app.html beside the desktop's index.html.
const SHELL = "app.html";
// Written by the build beside the shell: the hashes of the scripts the shell
// and the Darkmown frame may run (scripts/web-app-manifest.mjs).
const MANIFEST = "web-app.json";

/** Whether the web app build is on this server. Cheap: one stat per call. */
export function webAppAvailable(dir: string = DEFAULT_DIR): boolean {
  try {
    return statSync(resolve(dir, SHELL)).isFile();
  } catch {
    return false;
  }
}

/** Whether a path is one of the web app's, which set their own page policy. */
export function isWebAppPath(path: string): boolean {
  return path === "/app" || path.startsWith("/app/");
}

const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The page a signed-out visitor is sent back to after signing in: an /app
 * route this server serves, and nothing else, so the sign-in cannot be used
 * to bounce a browser anywhere. Anything unrecognised is the library.
 */
export function webAppReturnPath(path: string): string {
  if (path === "/app" || path === "/app/" || path === "/app/new") return path;
  const doc = /^\/app\/d\/([^/]+)$/.exec(path);
  return doc && DOC_ID.test(doc[1]) ? path : "/app";
}

function hostOf(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  if (!first) return null;
  try {
    return new URL(`https://${first}`).host;
  } catch {
    return null;
  }
}

/**
 * Where to send this request instead, so the web app and its sign-in run on
 * the docs host (MARKIE_DOCS_ORIGIN) and nowhere else: its session cookie is
 * set on the host that serves the sign-in, and a cookie on any other host is
 * one the app never sees. Null to serve the request here.
 *
 * Only browser GETs: an /app page, and the web sign-in when it is returning
 * to one. Nothing happens unless the docs host differs from this server's
 * own origin, so a self-hosted or local server is never redirected. The
 * target is the configured origin plus this request's path and query, never
 * anything else taken from the request (the same rule as canonical-host.ts).
 */
export function docsHostRedirect(request: Request, deployment: { origin: string; docsOrigin: string }): string | null {
  if (deployment.docsOrigin === deployment.origin) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const appPage = isWebAppPath(url.pathname);
  const appSignIn = (url.pathname === "/auth/web-signin" || url.pathname === "/auth/web-google")
    && isWebAppPath(url.searchParams.get("next") ?? "");
  if (!appPage && !appSignIn) return null;
  const docs = new URL(deployment.docsOrigin);
  const host = hostOf(request.headers.get("x-forwarded-host")) ?? hostOf(request.headers.get("host")) ?? url.host;
  if (host === docs.host) return null;
  return `${docs.origin}${url.pathname}${url.search}`;
}

// Video players a document may embed, the same two the desktop allows
// (electron/csp.js EMBED_FRAME_ORIGINS, src/lib/embeds.ts).
const EMBED_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"];
const SCRIPT_HASH = /^sha256-[A-Za-z0-9+/]{43}=$/;

function readScriptHashes(dir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(resolve(dir, MANIFEST), "utf8")) as { scriptHashes?: unknown };
    if (!Array.isArray(raw.scriptHashes)) return [];
    // Written into a header, so anything but an exact hash is dropped.
    return [...new Set(raw.scriptHashes.filter((hash): hash is string => typeof hash === "string" && SCRIPT_HASH.test(hash)))];
  } catch {
    return [];
  }
}

/** The websocket origin (ws: or wss:) for an http(s) origin, or null. */
export function socketOrigin(collabOrigin: string): string | null {
  try {
    const url = new URL(collabOrigin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * The page tells the app where its live-editing socket is. The app's own
 * origin may be a website that proxies plain HTTP to this server and cannot
 * carry a websocket (markiedocs.com through Vercel), so the socket goes to
 * this server's own origin directly. It carries only a short-lived collab
 * ticket (collab-tickets.ts), never the session.
 */
export function withCollabMeta(shell: string, collabOrigin: string): string {
  const socket = socketOrigin(collabOrigin);
  if (!socket) return shell;
  return shell.replace("</head>", `  <meta name="markie-collab" content="${socket}/collab" />\n  </head>`);
}

/**
 * What the web app may load. Scripts are this origin's bundle plus the hashes
 * the build named: the pinned Darkmown interpreter and its bootstrap, which a
 * Darkmown preview's srcdoc frame inherits this policy for (the desktop names
 * the same two, electron/csp.js). Author JavaScript is never allowed. Network
 * calls go to this origin, and the collab websocket to this server's own.
 */
export function webAppCsp(scriptHashes: readonly string[], collabOrigin: string): string {
  const socket = socketOrigin(collabOrigin);
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes.filter((hash) => SCRIPT_HASH.test(hash)).map((hash) => `'${hash}'`)].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${socket ? ` ${socket}` : ""}`,
    "worker-src 'self'",
    `frame-src about: ${EMBED_FRAME_ORIGINS.join(" ")}`,
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found · Markie</title></head>
<body><h1>Not found</h1><p>The Markie web app is not on this server.</p></body></html>`;

export interface WebAppOptions {
  /** Where the build is. Defaults to server/web-dist. */
  dir?: string;
  /**
   * This server's own origin (BETTER_AUTH_URL), which a browser reaches
   * directly: the collab websocket's address, wherever the app is served.
   */
  collabOrigin: string;
  /** The signed-in user for a request, or null. */
  sessionUser: (request: Request) => Promise<{ id: string } | null>;
}

export function createWebApp({ dir = DEFAULT_DIR, collabOrigin, sessionUser }: WebAppOptions) {
  const root = resolve(dir);
  const assetsRoot = resolve(root, "assets");
  const app = new Hono();

  const notBuilt = () =>
    new Response(NOT_BUILT_PAGE, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'" },
    });

  app.get("/app/assets/*", (c) => {
    if (!webAppAvailable(root)) return notBuilt();
    const relative = c.req.path.slice("/app/assets/".length);
    // Built names only: no directories above assets/, no dot files.
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(relative) || relative.split("/").some((part) => !part || part.startsWith("."))) {
      return c.text("Not found", 404);
    }
    const file = resolve(assetsRoot, relative);
    if (!file.startsWith(assetsRoot + sep) || !existsSync(file) || !statSync(file).isFile()) return c.text("Not found", 404);
    const type = ASSET_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    return new Response(readFileSync(file), {
      headers: {
        "content-type": type,
        // Every built name carries its content hash.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  const page = async (c: { req: { raw: Request; path: string } }) => {
    if (!webAppAvailable(root)) return notBuilt();
    const user = await sessionUser(c.req.raw).catch(() => null);
    if (!user) {
      const next = webAppReturnPath(c.req.path);
      return new Response(null, {
        status: 302,
        headers: { location: `/auth/web-signin?next=${encodeURIComponent(next)}`, "cache-control": "no-store" },
      });
    }
    let shell: string;
    try {
      shell = readFileSync(resolve(root, SHELL), "utf8");
    } catch {
      return notBuilt();
    }
    return new Response(withCollabMeta(shell, collabOrigin), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The shell is the same for everyone, but whether it is served at all
        // depends on the session, so no cache may keep it.
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": webAppCsp(readScriptHashes(root), collabOrigin),
      },
    });
  };

  app.get("/app", page);
  app.get("/app/*", page);
  return app;
}
