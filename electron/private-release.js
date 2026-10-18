const fsDefault = require("node:fs");
const path = require("node:path");

const CHANNEL = "super-nightly";
const AUTH_ORIGIN = "https://api-production-602f.up.railway.app";
const FRESH_MS = 60_000;
const BOOTSTRAP_CHANNELS = new Set(["private-release-status", "private-release-authorize", "private-release-lock", "open-external"]);

function privateReleaseConfig(metadata = {}) {
  const marker = metadata.markiePrivateRelease;
  if (!marker) return null;
  let apiOrigin = null;
  try {
    const parsed = new URL(marker.apiOrigin);
    if (parsed.protocol === "https:" && parsed.origin === marker.apiOrigin && !parsed.username && !parsed.password) apiOrigin = parsed.origin;
  } catch { /* A malformed private manifest stays private and locked. */ }
  return { channel: CHANNEL, apiOrigin: marker.channel === CHANNEL ? apiOrigin : null, gitCommit: typeof marker.gitCommit === "string" && /^[0-9a-f]{7,40}$/.test(marker.gitCommit) ? marker.gitCommit : "unknown" };
}

function initializePrivateReleaseIdentity({ app, metadata, fs = fsDefault }) {
  const config = privateReleaseConfig(metadata);
  if (!config) return null;
  const userData = require("./desktop-preview.cjs").validatedProfilePath(path.join(app.getPath("appData"), "Markie Super-nightly"), { appData: app.getPath("appData"), home: app.getPath("home"), stableUserData: app.getPath("userData"), fs });
  for (const [name, target] of Object.entries({ userData, sessionData: path.join(userData, "session"), logs: path.join(userData, "logs"), crashDumps: path.join(userData, "crashes") })) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 }); app.setPath(name, target);
  }
  return config;
}

/** Native authority: cached credentials are not cached authorization. */
function createPrivateReleaseGate({ config, userData, safeStorage, fetch = globalThis.fetch, fs = fsDefault, now = Date.now, onLock = () => {} }) {
  let token = null, until = 0, epoch = 0;
  const credentialPath = path.join(userData, "private-release-credential");
  const storageReady = () => safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  const authorized = () => !config || !!token && now() < until;
  const status = () => ({ required: !!config, authorized: authorized(), channel: config?.channel ?? null, gitCommit: config?.gitCommit ?? null, authOrigin: AUTH_ORIGIN });
  const lock = ({ forget = false } = {}) => {
    const wasOpen = !!token && until > 0;
    epoch++; until = 0; token = null;
    if (forget) { try { fs.unlinkSync(credentialPath); } catch { /* Missing enrollment is already locked. */ } }
    if (wasOpen) onLock();
    return status();
  };
  const readCredential = () => {
    try {
      if (!storageReady()) return null;
      const stat = fs.lstatSync(credentialPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return null;
      return safeStorage.decryptString(fs.readFileSync(credentialPath));
    } catch { return null; }
  };
  const authorize = async (candidate, { enroll = true } = {}) => {
    if (!config) return status();
    const ticket = ++epoch;
    // A bounded fresh online proof may survive an in-flight refresh, never a failed one.
    // Expiry denies new work, but the prior session still needs full native cleanup.
    const wasOpen = !!token && until > 0;
    const supplied = candidate === undefined ? token ?? readCredential() : candidate;
    try {
      if (!config.apiOrigin || !storageReady() || typeof supplied !== "string" || supplied.length < 1 || supplied.length > 16_384 || /[\r\n\x00]/.test(supplied)) throw new Error("denied");
      const response = await fetch(`${config.apiOrigin}/private-releases/access`, { method: "GET", headers: { Authorization: `Bearer ${supplied}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const proof = response.ok ? await response.json() : null;
      if (ticket !== epoch) return status();
      if (!proof || proof.authorized !== true || proof.channel !== CHANNEL || typeof proof.userId !== "string" || !proof.userId) throw new Error("denied");
      if (enroll) {
        const encrypted = safeStorage.encryptString(supplied);
        const temporary = `${credentialPath}.${require("node:crypto").randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, credentialPath); }
        finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
      }
      token = supplied; until = now() + FRESH_MS;
      return status();
    } catch {
      if (ticket !== epoch) return status();
      token = null; until = 0;
      if (wasOpen) onLock();
      return status();
    }
  };
  const updaterSettings = () => {
    if (!config || !config.apiOrigin || !authorized()) throw new Error("Private release authorization is required.");
    return { provider: "generic", url: `${config.apiOrigin}/private-releases/${CHANNEL}/`, channel: CHANNEL, requestHeaders: { Authorization: `Bearer ${token}` }, useMultipleRangeRequest: false };
  };
  return { status, authorized, authorize, lock, updaterSettings, rendererCredential: () => authorized() ? token : null, matchesCredential: (candidate) => candidate === token, allows: (channel) => authorized() || BOOTSTRAP_CHANNELS.has(channel) };
}

module.exports = { CHANNEL, AUTH_ORIGIN, FRESH_MS, privateReleaseConfig, initializePrivateReleaseIdentity, createPrivateReleaseGate };
