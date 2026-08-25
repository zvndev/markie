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

module.exports = {
  appId: "com.zvn.markie",
  productName: "Markie",
  afterPack: "build/preflight.cjs",
  mac: {
    category: "public.app-category.developer-tools",
    icon: "public/icon.icns",
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
  publish: [
    {
      provider: releaseManifest.storage.provider,
      bucket: releaseManifest.storage.bucket,
      endpoint: releaseManifest.storage.endpoint,
      region: releaseManifest.storage.region,
      path: publishPath,
    },
  ],
  // electron/ and out/ are the whole shipped app. Note that `files` does NOT
  // control node_modules: electron-builder resolves production dependencies
  // from package.json separately and copies them in on top of this list, which
  // is why every renderer-only package lives in devDependencies (the renderer
  // is already bundled into out/ by `next build`).
  //
  // The negation drops electron/*.test.ts, which sits next to the modules it
  // covers and has no business inside a user's app bundle.
  files: ["electron/**/*", "out/**/*", "!electron/**/*.test.*"],
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
      filter: ["markie-mcp.mjs", "lib.mjs", "scan.mjs", "package.json"],
    },
  ],
  directories: { output: "dist" },
  fileAssociations: [
    { ext: "md", name: "Markdown", role: "Editor" },
    { ext: "markdown", name: "Markdown", role: "Editor" },
    { ext: "mdx", name: "MDX", role: "Editor" },
    { ext: "csv", name: "CSV", role: "Editor" },
  ],
};
