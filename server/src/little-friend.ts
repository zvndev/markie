/**
 * Little Friend, ZVN's own analytics, on markie-api: request timing per route
 * template and server faults with their stacks, for the Markie project.
 *
 * Off unless LF_SERVER_KEY holds the project's secret server key (lfs_...). A
 * missing or wrong key never stops the server from booting.
 *
 * What leaves the process, per @littlefriend/node:
 *   - for requests: the route template, the method, the status class and the
 *     duration, summed per hour;
 *   - for a fault: its type, message and stack frames, the release, the
 *     environment and a route template.
 *
 * Never a path with values in it, a query, body, header, cookie, address or
 * token. Markie's paths carry secrets (/s/<share token>, /d/<id>,
 * /api/document-platform/links/<token>, the collab socket's ?token=), so every
 * route here comes from the route table Hono matched, or is a fixed label.
 * The collector scrubs every message again before it stores it.
 */
import { LittleFriend, type LittleFriendError } from "@littlefriend/node";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";
import { releaseCommit } from "./runtime-config.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Fixed labels for faults that happen outside a Hono route. */
export const FAULT_ROUTES = {
  collab: "/collab/:docId",
  orphanSweep: "/cron/orphan-sweep",
  /** An agent's document write, from the REST API or the hosted MCP. */
  agentDocWrite: "/agent/document-write",
} as const;

/** A release Little Friend accepts: a version, a commit hash or an image tag. */
const RELEASE = /^[0-9A-Za-z][0-9A-Za-z._+@:/-]{0,99}$/;

/**
 * The deployed build every fault carries: LF_RELEASE (the Dockerfile bakes it
 * from the build's LF_RELEASE argument, the image tag), else the version Kamal
 * started the container with (KAMAL_VERSION, the same tag), else GIT_SHA.
 */
export function releaseFrom(env: Env = process.env): string | undefined {
  const explicit = env.LF_RELEASE?.trim();
  if (explicit && RELEASE.test(explicit)) return explicit;
  return releaseCommit(env);
}

/**
 * The client, or null when LF_SERVER_KEY is unset. A key of the wrong kind is
 * reported by name, never by value, and leaves Little Friend off.
 */
export function littleFriendFromEnv(
  env: Env = process.env,
  options: { fetch?: typeof fetch; endpoint?: string } = {}
): LittleFriend | null {
  const key = env.LF_SERVER_KEY?.trim();
  if (!key) return null;
  try {
    return new LittleFriend({
      key,
      release: releaseFrom(env),
      environment: env.LF_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      // Its code and status only. The SDK's messages never carry a key, but a
      // log line stays small.
      onError: (error: LittleFriendError) =>
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "little_friend_error",
            code: error.code,
            ...(error.status ? { status: error.status } : {}),
          })
        ),
    });
  } catch {
    console.warn(
      JSON.stringify({ level: "warn", event: "little_friend_off", reason: "LF_SERVER_KEY is not a server key (lfs_...)" })
    );
    return null;
  }
}

let client: LittleFriend | null = null;

/** Installs the process's client (null turns Little Friend off). */
export function installLittleFriend(lf: LittleFriend | null): void {
  client = lf;
}

/** The process's client, or null when Little Friend is off. */
export function littleFriend(): LittleFriend | null {
  return client;
}

/**
 * The route template Hono matched for this request, such as /s/:token, never
 * the path itself. Read after the handler ran, it names the route that
 * answered: a handler, or a middleware that refused the request (/api/agent/*).
 * Null when no route answered: a 404 that fell through every middleware, a
 * redirect or preflight answered by a catch-all middleware ("*").
 */
export function routeTemplate(c: Context): string | null {
  try {
    const route = matchedRoutes(c)[c.req.routeIndex];
    if (!route || typeof route.path !== "string") return null;
    const path = route.path;
    if (path === "*" || path === "/*") return null;
    // A middleware that passed the request on, and nothing after it matched.
    if (route.method === "ALL" && path.endsWith("*") && c.res.status === 404 && !c.error) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * Times every request into Little Friend's request stats, by route template.
 * Register it before every other middleware. Never throws into a request.
 */
export const requestTiming: MiddlewareHandler = async (c, next) => {
  const lf = client;
  if (!lf) return next();
  const started = performance.now();
  try {
    await next();
  } finally {
    try {
      lf.recordRequest(routeTemplate(c), c.req.method, c.res.status, performance.now() - started);
    } catch {
      // Analytics never fails a request.
    }
  }
};

/**
 * Sends a fault: an error the server did not mean to answer with. `route` is a
 * route template or one of FAULT_ROUTES, never a request's path. An
 * HTTPException below 500 is a deliberate answer, not a fault. Never throws.
 */
export function reportFault(error: unknown, route: string | null): void {
  const lf = client;
  if (!lf) return;
  if (error instanceof HTTPException && error.status < 500) return;
  try {
    lf.captureException(error, { route: route ?? "/*" });
  } catch {
    // Analytics never fails a request.
  }
}

/** reportFault for an error thrown inside a Hono route, under that route's template. */
export function reportRouteFault(error: unknown, c: Context): void {
  reportFault(error, client ? routeTemplate(c) : null);
}
