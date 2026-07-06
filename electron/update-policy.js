const MACOS_UPDATE_FEED = "latest-mac.yml";

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

  if (platform !== "darwin") {
    const label = platformLabel(platform);
    return {
      supported: false,
      reason: "unsupported-platform",
      message: `Automatic updates are not enabled for ${label} yet.`,
      detail: "This local package can be smoke-tested, but Markie currently publishes a signed macOS update feed only. Windows and Linux feeds stay disabled until signing, feed files, and public download URLs are approved.",
    };
  }

  return {
    supported: true,
    reason: null,
    platform: "macOS",
    feed: MACOS_UPDATE_FEED,
  };
}

function shouldSetupAutoUpdate(options = {}) {
  return desktopUpdatePolicy(options).supported;
}

module.exports = {
  MACOS_UPDATE_FEED,
  desktopUpdatePolicy,
  platformLabel,
  shouldSetupAutoUpdate,
};
