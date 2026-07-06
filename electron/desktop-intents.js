const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const OPENABLE = /\.(md|markdown|mdx|txt|csv)$/i;
const MARKIE_DEEP_LINK = /^markie:\/\//i;

function argvList(argv) {
  return Array.isArray(argv) ? argv.filter((arg) => typeof arg === "string" && arg.length > 0) : [];
}

function argToPath(arg) {
  if (typeof arg !== "string") return null;
  if (/^file:\/\//i.test(arg)) {
    try {
      return fileURLToPath(arg);
    } catch {
      return null;
    }
  }
  return arg;
}

function isOpenablePath(value) {
  const filePath = argToPath(value);
  return Boolean(filePath && OPENABLE.test(filePath));
}

function findDeepLinkArg(argv) {
  return argvList(argv).find((arg) => MARKIE_DEEP_LINK.test(arg)) || null;
}

function findOpenableLaunchFile(
  argv,
  {
    existsSync = fs.existsSync,
    resolvePath = path.resolve,
  } = {}
) {
  for (const arg of argvList(argv)) {
    const filePath = argToPath(arg);
    if (!filePath || !OPENABLE.test(filePath)) continue;
    if (!existsSync(filePath)) continue;
    return resolvePath(filePath);
  }
  return null;
}

function launchIntentFromArgv(argv, options = {}) {
  return {
    deepLink: findDeepLinkArg(argv),
    filePath: findOpenableLaunchFile(argv, options),
  };
}

function supportsMarkdownDefaultHandler({ platform = process.platform, isPackaged = false } = {}) {
  return platform === "darwin" && isPackaged;
}

function markdownDefaultHandlerUnavailable({ platform = process.platform, isPackaged = false } = {}) {
  if (platform !== "darwin") {
    return {
      ok: false,
      error: "Markie can open Markdown files when the OS associates them with the app. In-app default registration is currently macOS-only.",
    };
  }
  if (!isPackaged) {
    return {
      ok: false,
      error: "Run the installed Markie app (not the dev build) to set it as the default.",
    };
  }
  return null;
}

module.exports = {
  OPENABLE,
  findDeepLinkArg,
  findOpenableLaunchFile,
  isOpenablePath,
  launchIntentFromArgv,
  markdownDefaultHandlerUnavailable,
  supportsMarkdownDefaultHandler,
};
