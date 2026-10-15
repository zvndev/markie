const fsDefault = require("node:fs");
const pathDefault = require("node:path");

const PREVIEW_NAME = "Markie Preview";
const PREVIEW_APP_ID = "com.zvn.markie.preview";

// Only the packaged manifest selects this mode. Environment variables and
// command-line flags cannot make a stable build masquerade as a preview.
/** @param {{isPackaged?: boolean, metadata?: unknown}} [options] */
function isDesktopPreview({ isPackaged = false, metadata } = {}) {
  return isPackaged === true && metadata?.name === "markie-preview"
    && metadata?.markieDesktopPreview === true;
}

function userDataOverride(argv = []) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user-data-dir") values.push(argv[++i]);
    else if (typeof arg === "string" && arg.startsWith("--user-data-dir=")) values.push(arg.slice(16));
  }
  if (!values.length) return null;
  if (values.length !== 1 || typeof values[0] !== "string" || !values[0]) {
    throw new Error("Pass one absolute --user-data-dir for the isolated desktop profile.");
  }
  return values[0];
}

// Resolve existing ancestors as well as the leaf, so a new child below a
// symlink cannot accidentally redirect a test profile into installed Markie.
function canonicalPath(value, { fs, path }) {
  let existing = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { return path.resolve(fs.realpathSync(existing), ...suffix); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * @param {string} value
 * @param {{appData: string, home?: string, stableUserData?: string | null, platform?: NodeJS.Platform, fs?: {realpathSync: (value: string) => string}, path?: import("node:path").PlatformPath}} options
 */
function validatedProfilePath(value, {
  appData, home, stableUserData, platform = process.platform,
  fs = fsDefault, path = platform === "win32" ? pathDefault.win32 : pathDefault,
} = {}) {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)
    || !path.isAbsolute(value) || (platform === "win32" && !/^[a-z]:\\/i.test(value))) {
    throw new Error("The isolated desktop profile must be an absolute local directory.");
  }
  const normalized = canonicalPath(value, { fs, path });
  const key = (target) => {
    const result = canonicalPath(target, { fs, path });
    return platform === "win32" || platform === "darwin" ? result.toLowerCase() : result;
  };
  const candidate = key(normalized);
  const contains = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  const broad = [path.parse(normalized).root, home, appData].filter(Boolean);
  const installed = [stableUserData, path.join(appData, "Markie"), path.join(appData, "markie")].filter(Boolean);
  if (broad.some((target) => contains(candidate, key(target)))
    || installed.some((target) => contains(candidate, key(target)) || contains(key(target), candidate))) {
    throw new Error("Choose a dedicated profile outside installed Markie data, not a home or system directory.");
  }
  return normalized;
}

/**
 * @param {{app: {isPackaged: boolean, getPath: (name: string) => string, setName: (name: string) => void, setPath: (name: string, target: string) => void, setAppUserModelId: (id: string) => void}, metadata?: unknown, argv?: string[], fs?: typeof import("node:fs"), platform?: NodeJS.Platform}} options
 */
function initializeDesktopIdentity({ app, metadata, argv = process.argv.slice(1), fs = fsDefault, platform = process.platform } = {}) {
  const isPreview = isDesktopPreview({ isPackaged: app.isPackaged, metadata });
  const override = userDataOverride(argv);
  if (!isPreview && !override) return { isPreview: false, userData: null };
  const path = platform === "win32" ? pathDefault.win32 : pathDefault;
  const appData = app.getPath("appData");
  const userData = validatedProfilePath(override || path.join(appData, PREVIEW_NAME), {
    appData, home: app.getPath("home"),
    stableUserData: isPreview ? null : app.getPath("userData"),
    platform, fs, path,
  });
  if (isPreview) {
    app.setName(PREVIEW_NAME);
    if (platform === "win32") app.setAppUserModelId(PREVIEW_APP_ID);
  }
  // This runs before electron-updater, registry, sessions or crash reporting
  // are imported/created. No consumer may cache the installed profile first.
  const paths = { userData, sessionData: path.join(userData, "session"), logs: path.join(userData, "logs"), crashDumps: path.join(userData, "crashes") };
  for (const [name, target] of Object.entries(paths)) {
    fs.mkdirSync(target, { recursive: true });
    app.setPath(name, target);
  }
  return { isPreview, userData };
}

function desktopStartUrl({ isPreview = false, isDev = false, devUrl = "http://localhost:3000" } = {}) {
  if (isPreview) return "app://markie/index.html";
  return isDev ? devUrl : "app://markie/index.html";
}

function isStableDesktopAuthUrl(value) {
  try { return /^(?:\/auth\/(?:google-start|desktop-bridge)|\/api\/auth\/desktop)(?:\/|$)/.test(new URL(value).pathname); }
  catch { return false; }
}

module.exports = { PREVIEW_NAME, PREVIEW_APP_ID, isDesktopPreview, userDataOverride, validatedProfilePath, initializeDesktopIdentity, desktopStartUrl, isStableDesktopAuthUrl };
