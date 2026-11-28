// A test-only updater feed, for the Mac cutover handoff check
// (scripts/mac-cutover-handoff-check.mjs).
//
// That check proves an installed Electron Markie on Apple Silicon takes the
// Markie RS release candidate through Check for Updates, from a feed served on
// this machine, before anything is public. A packaged app reads its feed from
// app-update.yml inside its signed bundle, so pointing it elsewhere needs a
// way in, and that way in must not exist in a build anyone downloads.
//
// Three things have to hold before the override does anything:
//
//   1. The build carries `markieUpdateHarness: true` in its package.json. Only
//      electron-builder.update-harness.cjs writes it, the release runner
//      refuses an app that carries it, and release:preflight fails if the
//      public builder config ever sets it.
//   2. The app is packaged. A dev run reads no feed at all.
//   3. MARKIE_UPDATE_HARNESS_FEED_URL is a plain http URL on the loopback
//      interface. Even a harness build cannot be sent to another machine.
//
// A private (super-nightly) build ignores it too: that lane has its own feed,
// gate and owner check, and nothing here should be able to route around them.

const HARNESS_ENV = "MARKIE_UPDATE_HARNESS_FEED_URL";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The feed to use instead of app-update.yml, or null for every real build.
 *
 * @param {{ isPackaged?: boolean, metadata?: Record<string, unknown> | null, env?: Record<string, string | undefined> }} [options]
 * @returns {{ provider: "generic", url: string } | null}
 */
function updateHarnessFeed({ isPackaged = false, metadata = null, env = {} } = {}) {
  if (!isPackaged) return null;
  if (metadata?.markieUpdateHarness !== true) return null;
  if (metadata?.markiePrivateRelease) return null;
  const raw = env?.[HARNESS_ENV];
  if (typeof raw !== "string" || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const href = url.href.endsWith("/") ? url.href : `${url.href}/`;
  return { provider: "generic", url: href };
}

module.exports = { HARNESS_ENV, updateHarnessFeed };
