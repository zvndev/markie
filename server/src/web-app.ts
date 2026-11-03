// The Markie web app: the desktop renderer's editor, built for a browser
// (`npm run build:web` at the repo root, src/web) and served by this server.
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
// Where it runs: on the docs host when MARKIE_DOCS_ORIGIN names one
// (markiedocs.com on Markie Cloud, through the website's Vercel rewrites of
// /app), otherwise on this server's own origin. Either way it talks to this
// server's own origin directly, the API origin the page names: the session
// cookie the web sign-in set lives there, host-only, and the docs host is the
// same site, so a credentialed fetch from the app carries it. Sign-in, rate
// limits and uploads all happen on the API host with the browser's own
// address, never through the website's proxy, and the live-editing socket
// goes there too, since a proxying website cannot carry one.
//
// The shell is the same public bundle for everyone and holds nothing about
// any account, so it is served without asking for a session. The app asks
// the API for it and sends a signed-out browser to the sign-in itself
// (src/web/main.tsx).
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

/**
 * Whether the web app build is on this server. Cheap: one stat per call, so
 * a deploy that adds or removes the build needs no restart. MARKIE_WEB_DIST
 * points somewhere else, which is how tests switch it on and off.
 */
export function webAppAvailable(dir: string = process.env.MARKIE_WEB_DIST || DEFAULT_DIR): boolean {
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

/** An http(s) origin exactly, or null. */
function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The websocket origin (ws: or wss:) for an http(s) origin, or null. */
export function socketOrigin(apiOrigin: string): string | null {
  const origin = httpOrigin(apiOrigin);
  if (!origin) return null;
  const url = new URL(origin);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}

/**
 * The page tells the app where this server is: the API origin it signs in
 * on and calls, and the live-editing socket on the same host. Both are this
 * server's own configured origin (BETTER_AUTH_URL), never anything from the
 * request. The socket carries only a short-lived collab ticket
 * (collab-tickets.ts), never the session.
 */
export function withServerMeta(shell: string, apiOrigin: string): string {
  const api = httpOrigin(apiOrigin);
  const socket = socketOrigin(apiOrigin);
  if (!api || !socket) return shell;
  return shell.replace(
    "</head>",
    `  <meta name="markie-api" content="${api}" />\n  <meta name="markie-collab" content="${socket}/collab" />\n  </head>`
  );
}

/**
 * What the web app may load. Scripts are this origin's bundle plus the hashes
 * the build named: the pinned Darkmown interpreter and its bootstrap, which a
 * Darkmown preview's srcdoc frame inherits this policy for (the desktop names
 * the same two, electron/csp.js). Author JavaScript is never allowed. Network
 * calls go to this origin and to the API origin, and the collab websocket to
 * the API origin's host.
 */
export function webAppCsp(scriptHashes: readonly string[], apiOrigin: string): string {
  const api = httpOrigin(apiOrigin);
  const socket = socketOrigin(apiOrigin);
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes.filter((hash) => SCRIPT_HASH.test(hash)).map((hash) => `'${hash}'`)].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    ["connect-src 'self'", api, socket].filter(Boolean).join(" "),
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
  /** Where the build is. Defaults to server/web-dist (or MARKIE_WEB_DIST). */
  dir?: string;
  /**
   * This server's own origin (BETTER_AUTH_URL), which a browser reaches
   * directly: the API the app calls and signs in on, and its socket's host.
   */
  apiOrigin: string;
}

export function createWebApp({ dir = process.env.MARKIE_WEB_DIST || DEFAULT_DIR, apiOrigin }: WebAppOptions) {
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

  const page = () => {
    if (!webAppAvailable(root)) return notBuilt();
    let shell: string;
    try {
      shell = readFileSync(resolve(root, SHELL), "utf8");
    } catch {
      return notBuilt();
    }
    return new Response(withServerMeta(shell, apiOrigin), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The same for everyone, but it names this server and a deploy
        // replaces it, so no cache keeps it.
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": webAppCsp(readScriptHashes(root), apiOrigin),
      },
    });
  };

  app.get("/app", page);
  app.get("/app/*", page);
  return app;
}
