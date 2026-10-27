// Linux desktop integration that the packages cannot do on their own.
//
// The .deb installs /usr/share/applications/markie.desktop, which registers
// Markie for text/markdown and for the markie:// scheme, and its postinst
// refreshes the desktop database. Nothing else is needed for a deb install.
//
// An AppImage installs nothing. It is a single file the user downloaded, so
// until something writes a desktop entry for it, the system does not know it
// exists: no launcher entry, no "Open With", and no handler for markie://.
// That last one is not cosmetic. Google sign-in finishes with a markie://auth
// deep link, so an AppImage without a desktop entry cannot sign in at all.
//
// So when Markie is running as an AppImage, it writes its own entry under the
// user's data directory, pointing at the AppImage file it is running from. It
// only ever touches a file it wrote (marked X-Markie-AppImage), never one a
// package or the user put there, and it stands aside entirely when the deb's
// system entry exists.
//
// Kept free of Electron so it unit-tests on any OS; fs, env and the command
// runner are injected.

const nodeFs = require("node:fs");
const nodePath = require("node:path");

const DESKTOP_FILE = "markie.desktop";
const ICON_NAME = "markie";
const MARKER = "X-Markie-AppImage=true";
const MIME_TYPES = ["text/markdown", "text/x-markdown", "x-scheme-handler/markie"];
const SYSTEM_APPLICATION_DIRS = ["/usr/share/applications", "/usr/local/share/applications"];

/**
 * How this copy of Markie was installed on Linux, which decides how it updates.
 *
 *  - "appimage": the AppImage runtime sets APPIMAGE to the file being run.
 *    electron-updater replaces that file in place.
 *  - "deb" (or "rpm"/"pacman"): electron-builder writes resources/package-type
 *    into those packages, and electron-updater picks its package-manager
 *    updater from it.
 *  - null: anything else, such as linux-unpacked run by hand. Nothing can
 *    update that, so the update policy says so instead of failing later.
 */
function linuxPackageKind({
  platform = process.platform,
  env = process.env,
  resourcesPath = process.resourcesPath,
  fs = nodeFs,
} = {}) {
  if (platform !== "linux") return null;
  if (typeof env.APPIMAGE === "string" && nodePath.isAbsolute(env.APPIMAGE)) return "appimage";
  if (!resourcesPath) return null;
  try {
    const kind = fs.readFileSync(nodePath.join(resourcesPath, "package-type"), "utf8").trim();
    return ["deb", "rpm", "pacman"].includes(kind) ? kind : null;
  } catch {
    return null;
  }
}

// The Desktop Entry spec's quoting for an Exec argument: wrap in double quotes
// and backslash the four characters that stay special inside them. A path with
// a space or a quote in it is ordinary in a Downloads folder.
function quoteExecArg(value) {
  return `"${String(value).replace(/(["`$\\])/g, "\\$1")}"`;
}

// Any other string value: no newlines, so a strange path cannot add keys.
function escapeDesktopString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function appImageDesktopEntry({ appImagePath, version }) {
  return [
    "[Desktop Entry]",
    "Name=Markie",
    "Comment=Markdown reader and editor",
    // String escaping is applied on top of Exec quoting, per the spec, which is
    // why a literal backslash in the path ends up as four in the file.
    `Exec=${escapeDesktopString(quoteExecArg(appImagePath))} %U`,
    `TryExec=${escapeDesktopString(appImagePath)}`,
    "Terminal=false",
    "Type=Application",
    `Icon=${ICON_NAME}`,
    "StartupWMClass=markie",
    "Categories=Office;TextEditor;Utility;",
    `MimeType=${MIME_TYPES.join(";")};`,
    "Keywords=markdown;md;notes;editor;",
    ...(version ? [`X-AppImage-Version=${escapeDesktopString(version)}`] : []),
    MARKER,
    "",
  ].join("\n");
}

function dataHome(env, home) {
  const configured = env.XDG_DATA_HOME;
  return configured && nodePath.isAbsolute(configured) ? configured : nodePath.join(home, ".local", "share");
}

/**
 * Write or refresh the AppImage's desktop entry. Returns what it did and why,
 * so main.js can log a skip without it being an error.
 *
 * Synchronous on purpose: it must finish before app.setAsDefaultProtocolClient
 * runs, because on Linux that call asks xdg-settings to point markie:// at
 * markie.desktop, which has to exist first.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, resourcesPath?: string,
 *   version?: string, fs?: Pick<typeof import("node:fs"), "existsSync" | "readFileSync" | "writeFileSync" | "mkdirSync" | "copyFileSync">,
 *   run?: (command: string, args: string[]) => void }} [options]
 */
function ensureAppImageIntegration({
  env = process.env,
  home = require("node:os").homedir(),
  resourcesPath = process.resourcesPath,
  version,
  fs = nodeFs,
  run = () => {},
} = {}) {
  const appImagePath = env.APPIMAGE;
  if (typeof appImagePath !== "string" || !nodePath.isAbsolute(appImagePath)) {
    return { written: false, reason: "not-appimage" };
  }
  // A control character in the path is not something a person chose, and no
  // amount of escaping makes every desktop environment read it the same way.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(appImagePath)) return { written: false, reason: "unusual-path" };
  if (SYSTEM_APPLICATION_DIRS.some((dir) => fs.existsSync(nodePath.join(dir, DESKTOP_FILE)))) {
    return { written: false, reason: "system-entry" };
  }
  const base = dataHome(env, home);
  const applications = nodePath.join(base, "applications");
  const file = nodePath.join(applications, DESKTOP_FILE);
  const entry = appImageDesktopEntry({ appImagePath, version });

  let existing = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== null && !existing.includes(MARKER)) return { written: false, reason: "user-entry" };

  // The icon, so the launcher entry and the window look like Markie. Copied out
  // of the AppImage because the mount point it lives at changes every launch.
  const iconSource = resourcesPath ? nodePath.join(resourcesPath, "icons", "markie.png") : null;
  const iconDir = nodePath.join(base, "icons", "hicolor", "512x512", "apps");
  const iconTarget = nodePath.join(iconDir, `${ICON_NAME}.png`);
  try {
    if (iconSource && fs.existsSync(iconSource) && !fs.existsSync(iconTarget)) {
      fs.mkdirSync(iconDir, { recursive: true });
      fs.copyFileSync(iconSource, iconTarget);
    }
  } catch {
    // A missing icon is cosmetic; the entry still works.
  }

  if (existing === entry) return { written: false, reason: "current", file };
  fs.mkdirSync(applications, { recursive: true });
  fs.writeFileSync(file, entry, { mode: 0o644 });
  // Best effort, and not awaited: these only refresh caches. Without them the
  // entry is still read on the next desktop-database scan.
  run("update-desktop-database", [applications]);
  run("xdg-mime", ["default", DESKTOP_FILE, "x-scheme-handler/markie"]);
  return { written: true, reason: existing === null ? "created" : "updated", file };
}

/** The window icon on Linux, or undefined when the package did not ship one. */
function linuxWindowIcon({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  fs = nodeFs,
} = {}) {
  if (platform !== "linux" || !resourcesPath) return undefined;
  const icon = nodePath.join(resourcesPath, "icons", "markie.png");
  return fs.existsSync(icon) ? icon : undefined;
}

module.exports = {
  DESKTOP_FILE,
  MARKER,
  appImageDesktopEntry,
  ensureAppImageIntegration,
  linuxPackageKind,
  linuxWindowIcon,
  quoteExecArg,
};
