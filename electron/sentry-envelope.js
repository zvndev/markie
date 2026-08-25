// Talking to Sentry without the Sentry SDK.
//
// @sentry/electron adds ~43 MB to node_modules and drags in @sentry/replay and
// OpenTelemetry. The packaged app is 286 MiB against a 330 MiB budget, of which
// 270 MiB is the Electron framework — so roughly 16 MiB is ours, and the
// headroom exists for Electron upgrades. Spending all of it here would be bad
// enough; shipping a session-replay library inside a local-first markdown
// editor, even switched off, is worse.
//
// Sentry's ingest API is a documented HTTP endpoint and the crash record is
// already structured, so this sends the envelope directly. What that buys is
// everything the SDK would have given us for this use case — grouping,
// release tracking, symbolicated frames, alerting — with nothing added to the
// bundle and, more importantly, with every byte that leaves the machine
// written down in one auditable file.

const crypto = require("node:crypto");

/**
 * Split a DSN into the pieces the ingest call needs.
 *
 * Returns null for anything unusable, which disables reporting: a crash
 * reporter that throws on a fat-fingered DSN breaks the app it exists to watch.
 */
function parseDsn(dsn) {
  if (typeof dsn !== "string" || !dsn.trim()) return null;
  let url;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  const publicKey = url.username;
  const projectId = url.pathname.replace(/^\/+/, "");
  if (!publicKey || !projectId) return null;
  return {
    publicKey,
    host: url.host,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
  };
}

// Absolute POSIX paths, which in a markdown editor are almost always the path
// of somebody's document.
const ABSOLUTE_PATH = /(?:\/[^\s/:()'"]+){2,}/g;

/**
 * Remove anything that identifies the user or their documents.
 *
 * Paths collapse to a basename: "/Users/kirby/Desktop/Q3 salary.md" tells us
 * nothing useful about a bug that "Q3 salary.md" does not, and one of them is
 * a filename the user never agreed to send us.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubText(text, home) {
  if (typeof text !== "string" || !text) return text ?? "";
  let out = text;
  // Markie's own bundle URLs (app://, https://) are the entire value of a stack
  // frame and carry no user data, so they are protected from the path rule.
  // file:// is deliberately NOT protected: a frame like
  // file:///Users/x/Desktop/Q3 salary.md is exactly the document-name leak
  // this scrubber exists to stop, so its path half goes through the path rule.
  // The sentinels are NUL characters, built at runtime: no real stack or
  // message contains NUL, and a literal NUL byte in source makes git treat
  // this file as binary.
  const SENTINEL = String.fromCharCode(0);
  const protectedUrls = [];
  out = out.replace(/(?:app|https?):\/\/[^\s)'"]+/g, (match) => {
    protectedUrls.push(match);
    return `${SENTINEL}URL${protectedUrls.length - 1}${SENTINEL}`;
  });
  out = out.replace(ABSOLUTE_PATH, (match) => match.slice(match.lastIndexOf("/") + 1));
  if (home) {
    // Whatever is left of the home directory, including a bare mention of it.
    out = out.split(home).join("~");
    // The bare short name too — but only as a whole word. A user named "mark"
    // must not have every "markdown" in the stack rewritten into "~down".
    const user = home.slice(home.lastIndexOf("/") + 1);
    if (user) {
      out = out.replace(
        new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(user)}(?=$|[^A-Za-z0-9_-])`, "g"),
        "$1~"
      );
    }
  }
  out = out.replace(
    new RegExp(`${SENTINEL}URL(\\d+)${SENTINEL}`, "g"),
    (_m, i) => protectedUrls[Number(i)]
  );
  return out;
}

const FRAME_WITH_NAME = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/;
const FRAME_BARE = /^\s*at\s+(.+?):(\d+):(\d+)\s*$/;

/**
 * Turn a V8 stack string into Sentry frames.
 *
 * Frames are what make grouping precise and symbolication possible at all: with
 * only a message, Sentry groups by text and can never map a minified location
 * back to source.
 */
function parseStackFrames(stack, home) {
  if (typeof stack !== "string" || !stack) return [];
  const frames = [];
  for (const line of stack.split("\n")) {
    let m = line.match(FRAME_WITH_NAME);
    if (m) {
      frames.push({
        function: m[1],
        filename: scrubText(m[2], home),
        abs_path: scrubText(m[2], home),
        lineno: Number(m[3]),
        colno: Number(m[4]),
        in_app: true,
      });
      continue;
    }
    m = line.match(FRAME_BARE);
    if (m) {
      frames.push({
        filename: scrubText(m[1], home),
        abs_path: scrubText(m[1], home),
        lineno: Number(m[2]),
        colno: Number(m[3]),
        in_app: true,
      });
    }
  }
  // Sentry renders the crashing frame last; a JS stack lists it first.
  return frames.reverse();
}

function eventId() {
  return crypto.randomBytes(16).toString("hex");
}

// "TypeError: boom" → "TypeError"
function exceptionType(stack, fallback) {
  const first = String(stack ?? "").split("\n")[0] ?? "";
  const m = first.match(/^([A-Za-z_$][\w$]*Error|[A-Za-z_$][\w$]*Exception)\b/);
  return m ? m[1] : fallback;
}

/**
 * The full request body for one crash: envelope header, item header, event.
 * Newline-delimited JSON, which is the envelope format.
 */
function sentryEnvelope(record, { dsn, home = "", environment = "production" }) {
  const message = scrubText(record.message ?? "Unknown error", home);
  const frames = parseStackFrames(record.stack, home);
  const sentAt = new Date().toISOString();

  const event = {
    event_id: eventId(),
    timestamp: record.at ?? sentAt,
    platform: "javascript",
    level: "error",
    logger: `markie.${record.source ?? "unknown"}`,
    release: record.version,
    environment,
    tags: {
      source: record.source ?? "unknown",
      // Recorded as a tag rather than left to Sentry's own detection, which
      // reports MacIntel for Apple Silicon.
      platform: record.platform,
    },
    exception: {
      values: [
        {
          type: exceptionType(record.stack, "Error"),
          value: message,
          ...(frames.length ? { stacktrace: { frames } } : {}),
        },
      ],
    },
  };
  if (record.componentStack) {
    event.extra = { componentStack: scrubText(record.componentStack, home) };
  }

  return [
    JSON.stringify({ event_id: event.event_id, sent_at: sentAt, dsn: undefined }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
}

/** The auth header Sentry's ingest endpoint requires. */
function sentryAuthHeader(dsn, clientVersion) {
  return `Sentry sentry_version=7, sentry_client=markie/${clientVersion}, sentry_key=${dsn.publicKey}`;
}

module.exports = {
  parseDsn,
  parseStackFrames,
  scrubText,
  sentryAuthHeader,
  sentryEnvelope,
};
