// The servers this app will talk to with a session: Markie Cloud, always, and
// any server the user added on purpose in Settings > Servers.
//
// This list is the security control that used to be a hard pin to one host.
// A bearer token, the sync engine and authenticated share fetches only ever
// go to an origin on it (electron/share-origin.js reads it). So nothing may
// put an origin here except main, after the user saw the server's name and
// address and said yes. A link, a document, or the renderer on its own cannot.
//
// Pure apart from the file it is handed, so it unit-tests without Electron.
const nodeFs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DEFAULT_SERVER, isLoopbackHostname } = require("./share-origin");
const { readTextCapped } = require("./bounded-body");

const DEFAULT_NAME = "Markie Cloud";
// What a default server that predates /api/server-info is assumed to offer.
const DEFAULT_INFO = Object.freeze({
  name: DEFAULT_NAME,
  apiVersion: 1,
  version: null,
  signIn: Object.freeze({ email: true, google: true, signup: "open" }),
});
const SUPPORTED_API_VERSION = 1;
// Who may make an account on a server: anyone, only someone invited, or
// nobody new. Anything a server says that is not one of these reads as open,
// which only decides whether the app offers "Create an account".
const SIGNUP_MODES = new Set(["open", "invite", "closed"]);
function signupMode(value) {
  return SIGNUP_MODES.has(value) ? value : "open";
}

// The sign-in methods a server offers, reduced to what this app understands.
function cleanSignIn(signIn) {
  const s = signIn && typeof signIn === "object" ? signIn : {};
  return { email: s.email !== false, google: s.google === true, signup: signupMode(s.signup) };
}
const MAX_NAME = 80;
const MAX_INFO_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 8000;
// A check the user does not act on goes stale: the server could answer
// differently by the time they come back to the dialog.
const PROBE_TTL_MS = 10 * 60 * 1000;


/**
 * What the user typed, reduced to an exact origin, or the reason it is not
 * one. https only, no user name or password, nothing after the host but an
 * optional trailing slash. This computer (localhost, 127.0.0.0/8, 0.0.0.0,
 * ::1, ::, IPv4 loopback written as IPv6), over http or https, only in dev.
 */
function parseServerOrigin(input, { allowDev = false } = {}) {
  if (typeof input !== "string") return { ok: false, error: "Enter a server address." };
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter a server address." };
  if (raw.length > 2048) return { ok: false, error: "That address is too long." };
  if (/\s/.test(raw)) return { ok: false, error: "That isn't a valid address." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "That isn't a valid address." };
  }
  if (u.username || u.password) {
    return { ok: false, error: "Leave the user name and password out of the address." };
  }
  // This computer, by any spelling (share-origin.js). Only a dev build may
  // use a server here.
  const local = isLoopbackHostname(u.hostname);
  if (local && !allowDev) return { ok: false, error: "Markie can't use a server on this computer." };
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    return { ok: false, error: "The address has to start with https://." };
  }
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) {
    return { ok: false, error: "Use just the server's address, with nothing after it." };
  }
  if (!u.hostname) return { ok: false, error: "That isn't a valid address." };
  return { ok: true, origin: u.origin, host: u.host };
}

// Characters drawn like a Latin letter: other scripts' look-alikes, and the
// digits and symbols people use in place of letters. Only for comparing a
// name with the reserved ones below, never for showing it.
const CONFUSABLE = new Map(Object.entries({
  0: "o", 1: "i", l: "i", "|": "i", "!": "i", 3: "e", 4: "a", "@": "a", 5: "s", $: "s", 7: "t",
  // Cyrillic
  а: "a", е: "e", і: "i", ї: "i", ӏ: "i", к: "k", м: "m", о: "o", р: "p", с: "c", у: "y", х: "x", ԁ: "d",
  // Greek
  α: "a", ε: "e", ι: "i", κ: "k", μ: "m", ο: "o", ρ: "p", ν: "v", τ: "t",
  // dotless i
  ı: "i",
}));

// A name reduced to the letters it reads as: compatibility forms folded
// (full-width letters, ligatures), accents and every space, dot, zero-width
// or other non-letter character dropped, look-alikes mapped, and "rn" read
// as the "m" it passes for.
function nameSkeleton(value) {
  const folded = String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let out = "";
  for (const ch of folded) out += CONFUSABLE.get(ch) ?? ch;
  return out.replace(/[^a-z]/g, "").replace(/rn/g, "m");
}

// Only Markie Cloud may call itself Markie. These words may sit around
// "markie" in a reserved name without making it a different one.
const RESERVED_CORE = nameSkeleton("markie");
const RESERVED_FILLER = ["the", "official", "cloud", "app", "server", "servers", "docs", "desktop", "sync", "team", "service", "hq"]
  .map(nameSkeleton)
  .sort((a, b) => b.length - a.length);

/**
 * Whether a server's name reads as Markie Cloud's: "Markie", "Markie Cloud",
 * "MARKIE  cloud", "Mаrkie Cloud" with a Cyrillic a, "Markie Cloud
 * (official)" and the like. A name that only mentions Markie among words of
 * its own ("Acme's Markie") is not.
 */
function isReservedName(value) {
  const sk = nameSkeleton(value);
  if (!sk.includes(RESERVED_CORE)) return false;
  if (sk.includes(nameSkeleton("markie cloud")) || sk.includes(nameSkeleton("cloud markie"))) return true;
  let rest = sk.replace(RESERVED_CORE, "");
  for (let changed = true; changed && rest; ) {
    changed = false;
    for (const word of RESERVED_FILLER) {
      if (rest.includes(word)) {
        rest = rest.replace(word, "");
        changed = true;
      }
    }
  }
  return rest === "";
}

function cleanName(value, fallback) {
  if (typeof value !== "string") return fallback;
  // Control and bidi-override characters could make one name read as another.
  const name = value.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").trim();
  if (!name) return fallback;
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name;
}

// The name a server the user added is shown under. One that passes for
// Markie Cloud's is replaced by its host, so a server cannot borrow Cloud's
// name to collect a password meant for Cloud.
function serverName(value, host) {
  const name = cleanName(value, host);
  return isReservedName(name) ? host : name;
}

/**
 * Check a /api/server-info body. The server's own `origin` must match the
 * address we asked, so a proxy or a misconfigured host cannot get one address
 * added under another's name.
 */
function parseServerInfo(body, origin) {
  if (!body || typeof body !== "object") return { ok: false, error: "That address isn't a Markie server." };
  if (body.product !== "markie-server") return { ok: false, error: "That address isn't a Markie server." };
  if (body.apiVersion !== SUPPORTED_API_VERSION) {
    return { ok: false, error: "That server runs a version of Markie this app doesn't support." };
  }
  if (typeof body.origin === "string" && body.origin) {
    let reported = null;
    try {
      reported = new URL(body.origin).origin;
    } catch {
      reported = null;
    }
    if (reported !== origin) {
      return { ok: false, error: `That server says its address is ${String(body.origin).slice(0, 200)}. Use that address instead.` };
    }
  }
  const signIn = body.signIn && typeof body.signIn === "object" ? body.signIn : {};
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    // keep the origin as the fallback name
  }
  return {
    ok: true,
    info: {
      name: serverName(body.name, host),
      apiVersion: SUPPORTED_API_VERSION,
      version: typeof body.version === "string" ? body.version.slice(0, 40) : null,
      signIn: cleanSignIn(signIn),
    },
  };
}

/**
 * Ask a server who it is. No credentials, no redirects (a redirect is how an
 * address the user approved would turn into one they did not), a size cap
 * and a timeout. The default server may not have the route yet, so a 404
 * from it reads as the defaults.
 */
async function probeServerInfo(origin, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const isDefault = origin === DEFAULT_SERVER;
  // One controller for the whole exchange: the timeout covers reading the
  // body too, and an oversize body aborts the request rather than draining it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(`${origin}/api/server-info`, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      return { ok: false, error: "Couldn't reach that server." };
    }
    if (res.status !== 200) {
      // Nothing in a refusal is read, so none of it is downloaded.
      controller.abort();
      if (isDefault && res.status === 404) return { ok: true, info: { ...DEFAULT_INFO, signIn: { ...DEFAULT_INFO.signIn } } };
      return { ok: false, error: "That address isn't a Markie server." };
    }
    let text;
    try {
      text = await readTextCapped(res, MAX_INFO_BYTES, { controller });
    } catch (err) {
      return err && err.code === "EBODYTOOLARGE"
        ? { ok: false, error: "That address isn't a Markie server." }
        : { ok: false, error: "Couldn't read that server's answer." };
    }
    return finishProbe(text, origin, isDefault);
  } finally {
    clearTimeout(timer);
  }
}

function finishProbe(text, origin, isDefault) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "That address isn't a Markie server." };
  }
  const parsed = parseServerInfo(body, origin);
  if (!parsed.ok) return parsed;
  // The default server is always called Markie Cloud here, whatever it says.
  if (isDefault) parsed.info.name = DEFAULT_NAME;
  return parsed;
}

/**
 * The trusted list, persisted as JSON at `file`. Markie Cloud is always first
 * and is never written to or removed from the file.
 * @param {{
 *   file?: string | null,
 *   allowDev?: boolean,
 *   fs?: any,
 *   now?: () => number,
 *   fetchImpl?: any,
 *   randomId?: () => string,
 * }} [options]
 */
function createServerStore({
  file,
  allowDev = false,
  fs = nodeFs,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  randomId = () => crypto.randomBytes(16).toString("hex"),
} = {}) {
  let added = load();
  let defaultInfo = { ...DEFAULT_INFO, signIn: { ...DEFAULT_INFO.signIn } };
  // probeId -> { origin, info, at }. A server is added from a check main
  // made itself, so the name the user confirmed is the name the server gave,
  // not one the renderer passed in.
  const probes = new Map();

  function load() {
    if (!file) return [];
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return [];
    }
    const list = Array.isArray(parsed?.servers) ? parsed.servers : [];
    const seen = new Set([DEFAULT_SERVER]);
    const out = [];
    for (const s of list) {
      if (!s || typeof s.origin !== "string") continue;
      // A stored entry has to survive the same check a typed one does, so a
      // hand-edited or corrupted file cannot widen what is trusted.
      const check = parseServerOrigin(s.origin, { allowDev });
      if (!check.ok || check.origin !== s.origin || seen.has(check.origin)) continue;
      seen.add(check.origin);
      out.push({
        origin: check.origin,
        name: serverName(s.name, check.host),
        signIn: cleanSignIn(s.signIn),
        version: typeof s.version === "string" ? s.version : null,
        addedAt: typeof s.addedAt === "string" ? s.addedAt : null,
      });
    }
    return out;
  }

  function save() {
    if (!file) return;
    const body = JSON.stringify({ version: 1, servers: added }, null, 2);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  }

  function list() {
    return [
      { origin: DEFAULT_SERVER, isDefault: true, name: DEFAULT_NAME, signIn: { ...defaultInfo.signIn }, version: defaultInfo.version, addedAt: null },
      ...added.map((s) => ({ ...s, isDefault: false, signIn: { ...s.signIn } })),
    ];
  }

  function origins() {
    return [DEFAULT_SERVER, ...added.map((s) => s.origin)];
  }

  function isTrusted(origin) {
    return origins().includes(origin);
  }

  function get(origin) {
    return list().find((s) => s.origin === origin) ?? null;
  }

  function prune() {
    const cutoff = now() - PROBE_TTL_MS;
    for (const [id, p] of probes) if (p.at < cutoff) probes.delete(id);
  }

  // Step one of adding: check the address and ask the server who it is.
  async function probe(input) {
    const parsed = parseServerOrigin(input, { allowDev });
    if (!parsed.ok) return parsed;
    const answer = await probeServerInfo(parsed.origin, { fetchImpl });
    if (!answer.ok) return answer;
    prune();
    const probeId = randomId();
    probes.set(probeId, { origin: parsed.origin, info: answer.info, at: now() });
    return {
      ok: true,
      probeId,
      origin: parsed.origin,
      host: parsed.host,
      name: answer.info.name,
      version: answer.info.version,
      signIn: { ...answer.info.signIn },
      alreadyAdded: isTrusted(parsed.origin),
    };
  }

  // Step two: the user confirmed what probe showed them.
  function add(probeId) {
    prune();
    const p = typeof probeId === "string" ? probes.get(probeId) : null;
    if (!p) return { ok: false, error: "Check the server again, then add it." };
    probes.delete(probeId);
    if (p.origin === DEFAULT_SERVER) {
      defaultInfo = { ...defaultInfo, signIn: { ...p.info.signIn }, version: p.info.version };
      return { ok: true, server: get(DEFAULT_SERVER) };
    }
    const entry = {
      origin: p.origin,
      name: p.info.name,
      signIn: { ...p.info.signIn },
      version: p.info.version,
      addedAt: new Date(now()).toISOString(),
    };
    const at = added.findIndex((s) => s.origin === p.origin);
    if (at >= 0) added[at] = { ...entry, addedAt: added[at].addedAt ?? entry.addedAt };
    else added.push(entry);
    try {
      save();
    } catch (err) {
      added = load();
      return { ok: false, error: `Couldn't save the server list (${err && err.message ? err.message : err}).` };
    }
    return { ok: true, server: get(p.origin) };
  }

  function remove(origin) {
    if (origin === DEFAULT_SERVER) return { ok: false, error: "Markie Cloud can't be removed." };
    const before = added.length;
    added = added.filter((s) => s.origin !== origin);
    if (added.length === before) return { ok: true, removed: false };
    try {
      save();
    } catch (err) {
      added = load();
      return { ok: false, error: `Couldn't save the server list (${err && err.message ? err.message : err}).` };
    }
    return { ok: true, removed: true };
  }

  return { list, origins, isTrusted, get, probe, add, remove };
}

module.exports = {
  DEFAULT_SERVER,
  DEFAULT_NAME,
  DEFAULT_INFO,
  parseServerOrigin,
  parseServerInfo,
  probeServerInfo,
  createServerStore,
  isReservedName,
  PROBE_TTL_MS,
};
