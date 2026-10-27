// The feed file electron-updater fetches on each platform. macOS gets the
// -mac suffix electron-builder writes for its zip target; NSIS on Windows does
// not; Linux x64 gets -linux (arm64 would be -linux-arm64, which Markie does
// not build). All three are mirrored in update-channel.js FEEDS, and
// update-policy.test.ts fails if the two ever disagree.
const MACOS_UPDATE_FEED = "latest-mac.yml";
const WINDOWS_UPDATE_FEED = "latest.yml";
const LINUX_UPDATE_FEED = "latest-linux.yml";

const { linuxPackageKind } = require("./linux-desktop");

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
  isPreview = false,
  // How a Linux copy was installed. Detected from the running process unless
  // a test passes it; see linux-desktop.js.
  linuxPackage = platform === "linux" ? linuxPackageKind({ platform }) : null,
} = {}) {
  if (isPreview) {
    return {
      supported: false,
      reason: "preview",
      message: "Markie Preview does not install automatic updates.",
      detail: "This local preview is separate from installed Markie and never reads the stable or beta update feeds. Build a new preview to test newer changes.",
    };
  }
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

  // Linux publishes linux/latest-linux.yml (download-manifest.json,
  // linux-x64). An AppImage replaces itself in place; a .deb is reinstalled
  // through the package manager, which asks for the admin password, so it is
  // installed only when the user says so rather than silently on quit.
  // Neither is code-signed: electron-updater checks the SHA-512 in the feed
  // before it installs anything, on every platform.
  if (platform === "linux") {
    if (linuxPackage === "appimage" || linuxPackage === "deb") {
      return {
        supported: true,
        reason: null,
        platform: "Linux",
        feed: LINUX_UPDATE_FEED,
        packageKind: linuxPackage,
        installOnQuit: linuxPackage === "appimage",
      };
    }
    return {
      supported: false,
      reason: "unsupported-package",
      message: "This copy of Markie cannot update itself.",
      detail: "Markie updates itself when it runs as the AppImage or is installed from the .deb. Download the latest version from https://markiedocs.com/download/linux.",
    };
  }

  const label = platformLabel(platform);
  return {
    supported: false,
    reason: "unsupported-platform",
    message: `Automatic updates are not enabled for ${label} yet.`,
    detail: "Markie publishes update feeds for macOS, Windows and Linux only.",
  };
}

function shouldSetupAutoUpdate(options = {}) {
  return desktopUpdatePolicy(options).supported;
}

module.exports = {
  LINUX_UPDATE_FEED,
  MACOS_UPDATE_FEED,
  WINDOWS_UPDATE_FEED,
  desktopUpdatePolicy,
  platformLabel,
  shouldSetupAutoUpdate,
};
