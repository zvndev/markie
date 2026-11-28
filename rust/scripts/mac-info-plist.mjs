#!/usr/bin/env node
/** Writes the Info.plist of a Markie RS bundle.
 *
 *   node rust/scripts/mac-info-plist.mjs <rs|nightly|public> <version>   # XML on stdout
 *
 * `rs` is the dev side build: its own bundle id, the markie-rs:// scheme and
 * no file types. `nightly` and `public` are the Mac app, on the super-nightly
 * channel and on the public feeds: Markie's bundle id, markie://, and the
 * document types Electron Markie declares, read from the same
 * electron-builder.config.cjs electron-builder reads, so the two apps cannot
 * drift apart while both exist. macOS and Squirrel.Mac must see one app. The
 * two Mac variants write the same plist; only the version differs.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const IDENTITIES = {
  rs: { name: "Markie RS", bundleId: "com.zvn.markie.rs", scheme: "markie-rs", icon: "markie-rs", executable: "markie-rs", main: false },
  nightly: { name: "Markie", bundleId: "com.zvn.markie", scheme: "markie", icon: "icon.icns", executable: "Markie", main: true },
  public: { name: "Markie", bundleId: "com.zvn.markie", scheme: "markie", icon: "icon.icns", executable: "Markie", main: true },
};
/** `Contents/MacOS/<this>`. The Mac app's is "Markie", Electron Markie's own:
 * Squirrel.Mac names the installed bundle after the update's executable, so
 * any other name turns /Applications/Markie.app into /Applications/<name>.app.
 * The cargo binary, `markie-rs`, is copied in under this name. */
export function executableFor(variant) {
  if (!Object.hasOwn(IDENTITIES, variant)) throw new Error("variant must be rs, nightly or public");
  return IDENTITIES[variant].executable;
}

export function builderConfig(root = repo) {
  return require(path.join(root, "electron-builder.config.cjs"));
}

/** CFBundleDocumentTypes as electron-builder writes them: `mac.extendInfo`'s
 * content-type claims, then one entry per `fileAssociations` item. */
export function documentTypes(config, iconFile) {
  const fromAssociations = (config.fileAssociations ?? []).map((association) => ({
    CFBundleTypeExtensions: [association.ext].flat().map((ext) => ext.replace(/^\./, "")),
    CFBundleTypeName: association.name || [association.ext].flat()[0],
    CFBundleTypeRole: association.role || "Editor",
    LSHandlerRank: association.rank || "Default",
    CFBundleTypeIconFile: iconFile,
  }));
  return [...(config.mac?.extendInfo?.CFBundleDocumentTypes ?? []), ...fromAssociations];
}

export function infoPlist(variant, version, config = builderConfig()) {
  const identity = IDENTITIES[variant];
  if (!Object.hasOwn(IDENTITIES, variant)) throw new Error("variant must be rs, nightly or public");
  if (typeof version !== "string" || !/^[0-9A-Za-z.-]{1,64}$/.test(version)) throw new Error("a version is required");
  const plist = {
    CFBundleName: identity.name,
    CFBundleDisplayName: identity.name,
    CFBundleIdentifier: identity.bundleId,
    CFBundleExecutable: identity.executable,
    CFBundleIconFile: identity.icon,
    CFBundlePackageType: "APPL",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: "12.0",
    NSHighResolutionCapable: true,
  };
  if (!identity.main) {
    // One scheme of its own, and no file types: it never answers for Markie.
    plist.CFBundleURLTypes = [{ CFBundleURLName: identity.bundleId, CFBundleTypeRole: "Viewer", CFBundleURLSchemes: [identity.scheme] }];
    return plist;
  }
  if (config.appId !== identity.bundleId || config.productName !== identity.name) throw new Error("electron-builder.config.cjs is not Markie's");
  const protocols = [config.protocols].flat().filter(Boolean);
  if (protocols.length !== 1 || protocols[0].schemes.join() !== identity.scheme) throw new Error("Markie claims exactly markie://");
  plist.LSApplicationCategoryType = config.mac.category;
  plist.NSHumanReadableCopyright = `Copyright © ${new Date().getUTCFullYear()} ZVN`;
  // As electron-builder writes `protocols`.
  plist.CFBundleURLTypes = protocols.map((protocol) => ({ CFBundleURLName: protocol.name, CFBundleTypeRole: protocol.role || "Editor", CFBundleURLSchemes: protocol.schemes }));
  plist.CFBundleDocumentTypes = documentTypes(config, identity.icon);
  plist.UTExportedTypeDeclarations = config.mac.extendInfo.UTExportedTypeDeclarations;
  plist.UTImportedTypeDeclarations = config.mac.extendInfo.UTImportedTypeDeclarations;
  // A copy: the config object is shared by every caller in this process.
  return structuredClone(plist);
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function node(value, indent) {
  if (typeof value === "string") return `${indent}<string>${escape(value)}</string>\n`;
  if (typeof value === "boolean") return `${indent}<${value}/>\n`;
  if (Array.isArray(value)) return `${indent}<array>\n${value.map((item) => node(item, indent + "  ")).join("")}${indent}</array>\n`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${indent}  <key>${escape(key)}</key>\n${node(item, indent + "  ")}`);
    return `${indent}<dict>\n${entries.join("")}${indent}</dict>\n`;
  }
  throw new Error("only strings, booleans, arrays and dictionaries belong in this Info.plist");
}

export function plistXml(plist) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${node(plist, "")}</plist>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [variant, version] = process.argv.slice(2);
  // `--executable <variant>` prints the bundle executable's name, for the shell scripts.
  if (variant === "--executable") process.stdout.write(`${executableFor(version)}\n`);
  else process.stdout.write(plistXml(infoPlist(variant, version)));
}
