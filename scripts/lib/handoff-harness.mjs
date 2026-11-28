// The parts of the Mac cutover handoff check (scripts/mac-cutover-handoff-check.mjs)
// that can be tested without a Rust build, a signed app or a window: where it
// may run, the local feed it serves, and the server that serves it.
import { copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildCutoverFeeds, compareSemver, readRustRelease, artifactVersion } from "./mac-cutover.mjs";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const real = (target) => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * The app the check runs and updates must be a copy inside its own temporary
 * folder, never an installed Markie. Squirrel replaces the bundle at the path
 * the running app was launched from, so running against /Applications/Markie.app
 * would replace Kirby's real Markie with a release candidate.
 */
export function assertSafeAppPath(appPath, { workDir, home = process.env.HOME ?? "" }) {
  assert(workDir, "the check needs its temporary work folder");
  const app = real(appPath);
  const work = real(workDir);
  for (const installed of ["/Applications", home ? path.join(home, "Applications") : null].filter(Boolean)) {
    assert(!inside(app, real(installed)), `refusing to run against ${app}: an installed Markie is never the app under test`);
  }
  assert(inside(app, work) && app !== work, `refusing to run against ${app}: the app under test must be a copy inside ${work}`);
  return app;
}

/** The app to copy from may be anything but an installed Markie. */
export function assertSafeSourceApp(sourceApp, { home = process.env.HOME ?? "" } = {}) {
  const app = real(sourceApp);
  for (const installed of ["/Applications", home ? path.join(home, "Applications") : null].filter(Boolean)) {
    assert(
      !inside(app, real(installed)),
      `refusing ${app}: copy the harness build from dist-harness/ (or pass --build), not from an installed Markie`
    );
  }
  assert(existsSync(path.join(app, "Contents", "Info.plist")), `${app} is not an app bundle`);
  return app;
}

/** The package.json inside the harness build must carry the marker and the version updated from. */
export function assertHarnessPackage(packageJsonText, expectVersion) {
  const metadata = JSON.parse(packageJsonText);
  assert(
    metadata.markieUpdateHarness === true,
    "the app to update from is not an update-harness build (markieUpdateHarness is missing); build it with --build"
  );
  assert(metadata.version === expectVersion, `the harness build is ${metadata.version}, expected ${expectVersion}`);
  return metadata;
}

function linkOrCopy(from, to) {
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

async function sha512(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

/** The newest Electron x64 ZIP in a folder, with its size and SHA-512. */
export async function findIntelZip(dir) {
  const zips = readdirSync(dir)
    .map((name) => ({ name, version: artifactVersion(name, "x64", "zip") }))
    .filter((entry) => entry.version)
    .sort((left, right) => compareSemver(right.version, left.version));
  assert(zips.length > 0, `no Markie-<version>-x64.zip in ${dir}; build Electron x64 first (npm run electron:build:mac)`);
  const file = path.join(dir, zips[0].name);
  return { name: zips[0].name, version: zips[0].version, size: statSync(file).size, sha512: await sha512(file), path: file };
}

/**
 * A local copy of what mac/ will hold at the cutover: the Rust release
 * candidate's arm64 ZIP and DMG and an Electron x64 ZIP as the Intel bridge,
 * with the feed written by the same code the release runner uses. Served
 * from `<outDir>/mac/`.
 */
/**
 * @param {{ rustDir: string, intelDir: string, outDir: string, cutoverVersion: string, releaseDate?: string }} options
 */
export async function buildLocalFeed({ rustDir, intelDir, outDir, cutoverVersion, releaseDate = new Date().toISOString() }) {
  const rust = await readRustRelease(rustDir, { allowPrerelease: true });
  const intelZip = await findIntelZip(intelDir);
  // A release candidate (0.10.0-rc.1) sorts below the release it leads to, so
  // the floor here is the lower of the two: the bridge must still be an
  // Electron build that reads mac-intel/.
  const floor = compareSemver(rust.version, cutoverVersion) < 0 ? rust.version : cutoverVersion;
  const { mac } = buildCutoverFeeds({
    rust: { version: rust.version, files: rust.files },
    bridge: intelZip,
    cutoverVersion: floor,
    releaseDate,
  });
  const dir = path.join(outDir, "mac");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of rust.files) linkOrCopy(file.path, path.join(dir, file.name));
  linkOrCopy(intelZip.path, path.join(dir, intelZip.name));
  writeFileSync(path.join(dir, "latest-mac.yml"), mac.text);
  return { dir, feedText: mac.text, rust, intelZip, version: rust.version };
}

/**
 * A static file server on the loopback interface, for the feed above. It
 * serves files under `root` only, records every request, and answers HEAD
 * and GET (with a single byte range, which electron-updater's differential
 * download asks for).
 *
 * @param {{ root: string, host?: string, port?: number }} options
 * @returns {Promise<{ url: string, port: number, requests: { method: string | undefined, path: string, range: string | null }[], close: () => Promise<void> }>}
 */
export function startFeedServer({ root, host = "127.0.0.1", port = 0 }) {
  const requests = [];
  const base = real(root);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://placeholder");
    requests.push({ method: request.method, path: url.pathname, range: request.headers.range ?? null });
    let file;
    try {
      file = real(path.join(base, decodeURIComponent(url.pathname)));
    } catch {
      file = null;
    }
    if (!file || !inside(file, base) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        response.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      response.writeHead(206, { "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
      if (request.method === "HEAD") return response.end();
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { "content-length": size, "accept-ranges": "bytes", "cache-control": "no-store" });
    if (request.method === "HEAD") return response.end();
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** True when the bundle is Electron (it carries Electron Framework). */
export function isElectronApp(appPath) {
  return existsSync(path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework"));
}
