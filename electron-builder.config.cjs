/* eslint-disable @typescript-eslint/no-require-imports */
const { readFileSync } = require("node:fs");
const path = require("node:path");

const releaseManifest = JSON.parse(
  readFileSync(path.join(__dirname, "server/download-manifest.json"), "utf8")
);
const macPlatform = releaseManifest.platforms.find(
  (platform) => platform.id === "mac-arm64" && platform.status === "public"
);

if (!macPlatform?.feed?.path) {
  throw new Error("stable release manifest needs a public macOS updater feed");
}

const publishPath = path.posix.dirname(macPlatform.feed.path);

// Windows is built in CI and published from here, so it needs its own updater
// directory: the path is baked into app-update.yml at pack time, and an
// installer that shipped with the wrong one would look for its updates in the
// macOS directory forever. This was declared while the platform was still
// marked planned, which is why a Windows install packaged today already knows
// where its feed lives.
const winPlatform = releaseManifest.platforms.find((platform) => platform.id === "windows-x64");

if (!winPlatform?.feed?.path) {
  throw new Error("release manifest needs a Windows updater feed path");
}

const winPublishPath = path.posix.dirname(winPlatform.feed.path);

// Windows signing is opt-in per build, and deliberately not inferred from
// whether an Azure variable happens to be set: an unsigned installer and a
// signed one are different products, and which one a build produces should be
// something it was told, not something it worked out.
//
// build/win-sign.cjs explains why electron-builder's own azureSignOptions path
// is not used. The short version is that it requires a long-lived credential
// the signing call itself does not need.
const signWindowsWithAzure = process.env.MARKIE_WINDOWS_SIGNING === "azure";

const windowsSigntoolOptions = signWindowsWithAzure
  ? {
      sign: "build/win-sign.cjs",
      // One pass. Left to default, electron-builder signs twice — sha1 then
      // sha256 — and the second pass nests a signature inside the first.
      signingHashAlgorithms: ["sha256"],
      publisherName: process.env.MARKIE_WINDOWS_PUBLISHER_NAME,
    }
  : undefined;

const publishTarget = (targetPath) => ({
  provider: releaseManifest.storage.provider,
  bucket: releaseManifest.storage.bucket,
  endpoint: releaseManifest.storage.endpoint,
  region: releaseManifest.storage.region,
  path: targetPath,
});

module.exports = {
  appId: "com.zvn.markie",
  productName: "Markie",
  afterPack: "build/preflight.cjs",
  mac: {
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true,
    // Content-type claims, so LaunchServices accepts Markie as the default app
    // for the formats Settings > Files offers (electron/default-apps.js). The
    // extension-only fileAssociations below cannot express a UTI. Everything
    // except Markdown and Darkmown is claimed at Alternate rank: installing
    // Markie must never quietly take .txt or .docx away from the user's editor;
    // only an explicit choice in Settings does that.
    extendInfo: {
      CFBundleDocumentTypes: [
        { CFBundleTypeName: "Markdown document", CFBundleTypeRole: "Editor", LSHandlerRank: "Default", LSItemContentTypes: ["net.daringfireball.markdown"] },
        { CFBundleTypeName: "Darkmown document", CFBundleTypeRole: "Editor", LSHandlerRank: "Owner", LSItemContentTypes: ["com.zvn.markie.darkmown"] },
        { CFBundleTypeName: "Plain text", CFBundleTypeRole: "Editor", LSHandlerRank: "Alternate", LSItemContentTypes: ["public.plain-text"] },
        { CFBundleTypeName: "Word document", CFBundleTypeRole: "Editor", LSHandlerRank: "Alternate", LSItemContentTypes: ["org.openxmlformats.wordprocessingml.document"] },
        { CFBundleTypeName: "Rich Text document", CFBundleTypeRole: "Editor", LSHandlerRank: "Alternate", LSItemContentTypes: ["public.rtf"] },
        { CFBundleTypeName: "OpenDocument text", CFBundleTypeRole: "Editor", LSHandlerRank: "Alternate", LSItemContentTypes: ["org.oasis-open.opendocument.text"] },
        { CFBundleTypeName: "Structured text", CFBundleTypeRole: "Editor", LSHandlerRank: "Alternate", LSItemContentTypes: ["public.comma-separated-values-text", "public.json", "public.yaml", "public.xml"] },
      ],
      UTImportedTypeDeclarations: [
        {
          UTTypeIdentifier: "net.daringfireball.markdown",
          UTTypeDescription: "Markdown document",
          UTTypeConformsTo: ["public.plain-text"],
          UTTypeReferenceURL: "https://daringfireball.net/projects/markdown/",
          UTTypeTagSpecification: { "public.filename-extension": ["md", "markdown", "mdx"], "public.mime-type": ["text/markdown"] },
        },
        {
          UTTypeIdentifier: "public.yaml",
          UTTypeDescription: "YAML document",
          UTTypeConformsTo: ["public.plain-text"],
          UTTypeTagSpecification: { "public.filename-extension": ["yaml", "yml"], "public.mime-type": ["application/yaml"] },
        },
      ],
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: "com.zvn.markie.darkmown",
          UTTypeDescription: "Darkmown document",
          UTTypeConformsTo: ["public.plain-text"],
          UTTypeTagSpecification: { "public.filename-extension": ["wd"] },
        },
      ],
    },
  },
  dmg: {
    sign: true,
  },
  win: {
    icon: "build/icon.ico",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "zip", arch: ["x64"] },
    ],
    // Overrides the top-level publish block for Windows only. macOS keeps
    // reading the top-level one, so its app-update.yml is byte-for-byte what it
    // was — and the release runner asserts that, which is what would catch this
    // if the override ever leaked across platforms.
    publish: [publishTarget(winPublishPath)],
    ...(windowsSigntoolOptions ? { signtoolOptions: windowsSigntoolOptions } : {}),
  },
  linux: {
    icon: "build/icons",
    category: "Office",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
  },
  publish: [publishTarget(publishPath)],
  // Markie is English-only, so the ~50 MB of Chromium locale packs is paid for
  // nothing. The cost is that the handful of strings Chromium owns rather than
  // Markie (the "Look Up" and "Search with…" context menu items, the spellcheck
  // labels) show in English on a non-English system.
  //
  // Three names, not one, because electron-builder prunes by exact file
  // basename and the English pack is named differently per platform:
  // Resources/en.lproj on macOS, locales/en-US.pak and locales/en-GB.pak on
  // Windows and Linux. A list of just ["en"] deleted every .pak and left
  // Windows with an empty locales directory, which is a Chromium that will not
  // start rather than a Chromium without translations. Each platform ignores
  // the names it does not have. scripts/package-smoke.mjs asserts a locale
  // survives on all three, so this cannot go quiet again.
  electronLanguages: ["en", "en-US", "en-GB"],
  // electron/ and out/ are the whole shipped app. Note that `files` does NOT
  // decide *which* node_modules ship: electron-builder resolves production
  // dependencies from package.json separately, which is why every
  // renderer-only package lives in devDependencies (the renderer is already
  // bundled into out/ by `vite build`). The negations below do still filter
  // what gets copied out of the modules it picked, which is how the
  // build-time-only halves of the two native modules stay out.
  //
  // The first negation drops electron/*.test.ts, which sits next to the
  // modules it covers and has no business inside a user's app bundle.
  //
  // The rest are the sources a native module is compiled *from*: the amalgamated
  // SQLite C files (about 10 MB), better-sqlite3's own C++, and node-pty's
  // vendored winpty and conpty sources. The compiled .node binaries live under
  // build/Release and are not touched by any of this.
  files: [
    "electron/**/*",
    "out/**/*",
    // electron/doc-text.js re-exports this one MCP module so global search and
    // the MCP's markie_search_documents share one implementation. It is also
    // copied to Resources/mcp below; the asar needs its own copy because the
    // main process resolves ../mcp from inside the archive.
    "mcp/doc-text.cjs",
    "!electron/**/*.test.*",
    "!node_modules/better-sqlite3/deps/**",
    "!node_modules/better-sqlite3/src/**",
    "!node_modules/node-pty/third_party/**",
    "!node_modules/node-pty/deps/**",
  ],
  // Native modules cannot be loaded from inside the asar archive. Electron
  // Builder unpacks *.node on its own, which is not enough: node-pty also ships
  // winpty.dll, winpty-agent.exe and the conpty helpers on Windows, and those
  // stayed inside the archive, so the in-app terminal failed to start there.
  // Unpacking both modules wholesale keeps every sidecar next to its binding.
  asarUnpack: [
    "node_modules/node-pty/**",
    "node_modules/better-sqlite3/**",
  ],
  // Registers markie:// with the OS at install time — and, just as importantly,
  // lets the Windows uninstaller remove the registration again instead of
  // leaving a scheme pointing at a deleted executable.
  protocols: [{ name: "Markie", schemes: ["markie"] }],
  extraResources: [
    {
      from: "mcp",
      to: "mcp",
      // Named one by one so nothing accidental (a test file, a scratch
      // module) rides along. electron/mcp-packaging.test.ts fails when a new
      // runtime module in mcp/ is missing here, because a module left out of
      // this list is fine in dev and a dead MCP server in the shipped app.
      filter: [
        "agent-classify.mjs",
        "agent-client.mjs",
        "check-md.mjs",
        "conventions.mjs",
        "doc-text.cjs",
        "lib.mjs",
        "markdown-guide.mjs",
        "markie-mcp.mjs",
        "scan.mjs",
        "package.json",
      ],
    },
  ],
  directories: { output: "dist" },
  fileAssociations: [
    { ext: "md", name: "Markdown", role: "Editor" },
    { ext: "markdown", name: "Markdown", role: "Editor" },
    { ext: "mdx", name: "MDX", role: "Editor" },
    { ext: "csv", name: "CSV", role: "Editor" },
    { ext: "docx", name: "Word document", role: "Editor" },
    { ext: "doc", name: "Legacy Word document import", role: "Viewer" },
    { ext: "txt", name: "Plain text", role: "Editor" },
    { ext: ["text", "log"], name: "Plain text", role: "Editor", rank: "Alternate" },
    { ext: "wd", name: "Darkmown document", role: "Editor" },
    { ext: "json", name: "JSON", role: "Editor", rank: "Alternate" },
    { ext: ["yaml", "yml"], name: "YAML", role: "Editor", rank: "Alternate" },
    { ext: "xml", name: "XML", role: "Editor", rank: "Alternate" },
    { ext: "rtf", name: "Rich text import", role: "Viewer" },
    { ext: "odt", name: "OpenDocument text import", role: "Viewer" },
  ],
};
