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
  files: ["electron/**/*", "out/**/*"],
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
