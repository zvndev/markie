// The feed file electron-updater fetches on each platform. macOS gets the
// -mac suffix electron-builder writes for its zip target; NSIS on Windows does
// not. Both names are mirrored in update-channel.js FEEDS, and
// update-policy.test.ts fails if the two ever disagree.
const MACOS_UPDATE_FEED = "latest-mac.yml";
const WINDOWS_UPDATE_FEED = "latest.yml";

function platformLabel(platform = process.platform) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return "this platform";
}

function desktopUpdatePolicy({
  platform = process.platform,
  isPackaged = false,
  isDev = false,
} = {}) {
  if (isDev || !isPackaged) {
    return {
      supported: false,
      reason: "dev",
      message: "Updates are checked in packaged Markie builds.",
      detail: "This development build cannot update itself. Build and release Markie with electron-builder to test the production update feed.",
    };
  }

  if (platform === "darwin") {
    return {
      supported: true,
      reason: null,
      platform: "macOS",
      feed: MACOS_UPDATE_FEED,
    };
  }

  // The signed Windows installer is a public download (download-manifest.json,
  // windows-x64), and electron-builder bakes the manifest's Windows feed
  // directory into app-update.yml at pack time, so a packaged install already
  // knows where to look. This file answering "not yet" was the only thing
  // between a Windows user and an update.
  if (platform === "win32") {
    return {
      supported: true,
      reason: null,
      platform: "Windows",
      feed: WINDOWS_UPDATE_FEED,
    };
  }

  const label = platformLabel(platform);
  return {
    supported: false,
    reason: "unsupported-platform",
    message: `Automatic updates are not enabled for ${label} yet.`,
    detail: "This local package can be smoke-tested, but Markie publishes signed macOS and Windows update feeds only. The Linux feed stays disabled until signing, feed files, and public download URLs are approved.",
  };
}

function shouldSetupAutoUpdate(options = {}) {
  return desktopUpdatePolicy(options).supported;
}

module.exports = {
  MACOS_UPDATE_FEED,
  WINDOWS_UPDATE_FEED,
  desktopUpdatePolicy,
  platformLabel,
  shouldSetupAutoUpdate,
};
