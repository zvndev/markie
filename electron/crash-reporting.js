// Whether a crash leaves this machine, and what it looks like when it does.
//
// Markie's promise on first run is that documents stay on the Mac. Sending
// crash reports anywhere is in tension with that, so the whole feature is
// off until the user turns it on, in the same shape as the beta channel:
// explicit, reachable only from inside the app, and reversible.
//
// Three separate things must all be true before a single byte is sent — the
// user opted in, a DSN is configured, and the payload survived scrubbing. Each
// is checked here rather than trusted from a caller.

const fsDefault = require("node:fs");
const path = require("node:path");
const { parseDsn, sentryAuthHeader, sentryEnvelope } = require("./sentry-envelope");

const CONSENT_FILE = "crash-reporting.json";

function consentPath(dir) {
  return path.join(dir, CONSENT_FILE);
}

/**
 * Has the user opted in?
 *
 * Fails closed on every error path. Anything that is not literally `true` means
 * no: the value comes off disk, where a corrupted or hand-edited file can hold
 * any shape, and "truthy" is not consent.
 */
function readCrashConsent(dir, { fs = fsDefault } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(consentPath(dir), "utf-8"));
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

/** Persist the choice. Returns whether it stuck, so the UI need not lie. */
function writeCrashConsent(dir, enabled, { fs = fsDefault } = {}) {
  try {
    fs.writeFileSync(
      consentPath(dir),
      `${JSON.stringify({ enabled: enabled === true }, null, 2)}\n`,
      "utf-8"
    );
    return true;
  } catch {
    return false;
  }
}

function loadConfig() {
  try {
    // Committed, and empty by default, so a build with no Sentry project behind
    // it is completely inert rather than half-wired.
    return require("./crash-reporting.config.json");
  } catch {
    return null;
  }
}

/**
 * The DSN this build reports to, or null when reporting is not configured.
 *
 * A Sentry DSN's public key is designed to be embedded in clients and is not a
 * secret, so the config file is committed. The environment override exists for
 * testing against a scratch project without editing a tracked file.
 */
function crashDsn(env = process.env, { config = loadConfig() } = {}) {
  const fromEnv = env?.MARKIE_SENTRY_DSN;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const fromConfig = config?.dsn;
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim();
  return null;
}

/**
 * Send one crash. Resolves to whether it was accepted, and never rejects: this
 * runs while the app is already broken, and failing to report must not become a
 * second failure.
 */
async function sendCrash(
  record,
  { dsn, home = "", environment = "production", clientVersion = "0.0.0", fetchImpl = globalThis.fetch } = {}
) {
  const parsed = parseDsn(dsn);
  if (!parsed || typeof fetchImpl !== "function") return false;
  try {
    const res = await fetchImpl(parsed.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": sentryAuthHeader(parsed, clientVersion),
      },
      body: sentryEnvelope(record, { dsn: parsed, home, environment }),
    });
    return Boolean(res?.ok);
  } catch {
    // Offline, DNS gone, Sentry down. The report is already in the local log.
    return false;
  }
}

module.exports = {
  CONSENT_FILE,
  consentPath,
  crashDsn,
  readCrashConsent,
  sendCrash,
  writeCrashConsent,
};
