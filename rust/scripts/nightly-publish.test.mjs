// node --test rust/scripts/nightly-publish.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_NAME, BUNDLE_ID, BUNDLE_NAME, FEED_NAME, GATEWAY_ORIGIN, IDENTITY, LANE_PREFIX, REQUIREMENT, TEAM_ID,
  artifactName, assertSigningAuthority, createFeed, feedText, gatewayOrigin, inspectZip, nightlySettings, outputDirectory,
  parseFeed, publishFiles, runCli, systemTools, uploadUrl, verifyRelease,
} from "./nightly-publish.mjs";

const VERSION = "0.1.0-rs-nightly.7", COMMIT = "a".repeat(40), ZIP_NAME = artifactName(VERSION);
// A synthetic publish key: the right shape, and nobody's secret.
const KEY = "synthetic-publish-key-0123456789-abcdefghijklmnopqrstuvwxyz";
const sha = (data) => createHash("sha512").update(data).digest("base64");
const clean = { gitCommit: COMMIT, gitDirty: false };
const macOnly = { skip: process.platform !== "darwin" && "needs macOS ditto and plutil" };

function plistFor({ bundleId = BUNDLE_ID, version = VERSION, schemes = ["markie-nightly"], extra = "" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${APP_NAME}</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>markie-rs</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array>${schemes.map((s) => `<string>${s}</string>`).join("")}</array></dict></array>
${extra}</dict></plist>
`;
}

/** An output folder as nightly-release.sh leaves it: the ZIP of a bundle. Not signed. */
function release(options = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-nightly-publish-test-")));
  const output = path.join(root, "out"), source = path.join(root, "source"), app = path.join(source, BUNDLE_NAME);
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(output);
  writeFileSync(path.join(app, "Contents", "Info.plist"), plistFor(options));
  const binary = path.join(app, "Contents", "MacOS", "markie-rs");
  writeFileSync(binary, `#!/bin/sh\necho "${APP_NAME} ${options.reportedVersion ?? VERSION} (${BUNDLE_ID}) ${options.reportedCommit ?? COMMIT}"\n`);
  chmodSync(binary, 0o755);
  const zip = path.join(output, ZIP_NAME);
  const made = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  assert.equal(made.status, 0);
  const settings = { version: VERSION, apiOrigin: GATEWAY_ORIGIN, gitCommit: COMMIT, channel: "rs-nightly", output };
  return { root, output, zip, settings, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const goodDisplay = `Executable=/tmp/x/${BUNDLE_NAME}/Contents/MacOS/markie-rs\nIdentifier=${BUNDLE_ID}\nFormat=app bundle with Mach-O thin (arm64)\nCodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded\nAuthority=${IDENTITY}\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTimestamp=24 Nov 2026 at 12:00:00\nTeamIdentifier=${TEAM_ID}\n`;

/** Real ditto, plutil and the fixture binary; scripted codesign, spctl and stapler. */
function fakeTools(overrides = {}) {
  const answers = { sealed: true, ours: true, display: goodDisplay, gatekeeper: true, stapled: true, ...overrides };
  const calls = [];
  return {
    calls,
    run(command, args, options) {
      calls.push([command, ...args].join(" "));
      const answer = (ok, stderr = "") => ({ ok, stdout: "", stderr });
      if (command === "/usr/bin/codesign" && args.includes("--display")) return answer(true, answers.display);
      if (command === "/usr/bin/codesign" && args.includes("-R")) return answer(answers.ours);
      if (command === "/usr/bin/codesign") return answer(answers.sealed);
      if (command === "/usr/sbin/spctl") return answer(answers.gatekeeper);
      if (command === "/usr/bin/xcrun") return answer(answers.stapled);
      return systemTools.run(command, args, options);
    },
  };
}

/** A stored ZIP with exactly these entries, for names ditto would never write. */
function storedZip(entries) {
  const parts = [], directory = [];
  let offset = 0;
  for (const { name, data = "", mode = 0o100644 } of entries) {
    const nameBytes = Buffer.from(name), body = Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body); directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directoryBytes = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

test("settings need an exact nightly version, a clean commit and the reviewed gateway", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-nightly-settings-")));
  try {
    const rust = path.join(root, "rust"); mkdirSync(rust);
    const env = { MARKIE_NIGHTLY_VERSION: VERSION, MARKIE_PRIVATE_API_ORIGIN: GATEWAY_ORIGIN };
    const settings = nightlySettings(env, rust, clean);
    assert.deepEqual(settings, { version: VERSION, apiOrigin: GATEWAY_ORIGIN, gitCommit: COMMIT, channel: "rs-nightly", output: path.join(rust, "target", "nightly", VERSION) });
    for (const version of [undefined, "", "0.1.0", "0.1.0-super-nightly.7", "0.1.0-rs-nightly", "0.1.0-rs-nightly.07", "0.1.0-rs-nightly.7.1", "0.1.0-rs-nightly.x", "v0.1.0-rs-nightly.7", "0.1.0-rs-nightly.7\n"]) {
      assert.throws(() => nightlySettings({ ...env, MARKIE_NIGHTLY_VERSION: version }, rust, clean), /X\.Y\.Z-rs-nightly\.N/, String(version));
    }
    assert.throws(() => nightlySettings(env, rust, { gitCommit: COMMIT, gitDirty: true }), /clean, exact commit/);
    assert.throws(() => nightlySettings(env, rust, { gitCommit: "abc123", gitDirty: false }), /clean, exact commit/);
    assert.throws(() => nightlySettings({ MARKIE_NIGHTLY_VERSION: VERSION }, rust, clean), /MARKIE_PRIVATE_API_ORIGIN is required/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the destination is closed: one origin, one prefix, two file names", () => {
  assert.equal(gatewayOrigin(GATEWAY_ORIGIN), GATEWAY_ORIGIN);
  assert.equal(gatewayOrigin(GATEWAY_ORIGIN + "/"), GATEWAY_ORIGIN);
  for (const origin of [
    "http://markie-nightly.zvndev.com", "https://markie-nightly.zvndev.com:8443", "https://markie-nightly.zvndev.com/private-releases", "https://user:pass@markie-nightly.zvndev.com",
    "https://markie-nightly.zvndev.com/?x=1", "https://markie-nightly.zvndev.com/#x", "https://markie-nightly.fly.dev", "https://api.markiedocs.com", "https://markie-nightly.zvndev.com.evil.example",
    "https://evil.example", "https://localhost", "https://127.0.0.1", "not a url", "", undefined,
  ]) assert.throws(() => gatewayOrigin(origin), Error, String(origin));
  const settings = { version: VERSION, apiOrigin: GATEWAY_ORIGIN };
  assert.equal(uploadUrl(settings, ZIP_NAME), `${GATEWAY_ORIGIN}${LANE_PREFIX}${ZIP_NAME}`);
  assert.equal(uploadUrl(settings, FEED_NAME), `${GATEWAY_ORIGIN}/private-releases/rs-nightly/rs-nightly-mac.yml`);
  for (const name of ["super-nightly-mac.yml", "rs-nightly.yml", artifactName("0.1.0-rs-nightly.8"), `../super-nightly/${ZIP_NAME}`, `${ZIP_NAME}?x=1`, `${ZIP_NAME}#x`, `${ZIP_NAME}.blockmap`, "Markie-0.9.4-super-nightly.1-arm64-mac.zip", ""]) {
    assert.throws(() => uploadUrl(settings, name), /Only the rs-nightly feed/, name);
  }
  assert.throws(() => uploadUrl({ version: VERSION, apiOrigin: "https://evil.example" }, ZIP_NAME), /reviewed private gateway/);
});

test("the output folder is outside the repository or under rust/target/nightly, never a dry run or a symlink", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-nightly-output-")));
  try {
    const rust = path.join(root, "repo", "rust"); mkdirSync(rust, { recursive: true });
    assert.equal(outputDirectory(rust, undefined, VERSION), path.join(rust, "target", "nightly", VERSION));
    assert.equal(outputDirectory(rust, path.join(root, "elsewhere"), VERSION), path.join(root, "elsewhere"));
    assert.throws(() => outputDirectory(rust, "relative/out", VERSION), /must be absolute/);
    assert.throws(() => outputDirectory(rust, path.join(root, "repo", "docs"), VERSION), /outside the repository/);
    assert.throws(() => outputDirectory(rust, path.join(rust, "scripts"), VERSION), /outside the repository/);
    assert.throws(() => outputDirectory(rust, path.join(rust, "target", "nightly", `${VERSION}-dry-run`), VERSION), /dry-run build is never/);
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "linked"));
    assert.throws(() => outputDirectory(rust, path.join(root, "linked", "out"), VERSION), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the feed is the gateway's subset and names exactly this version's ZIP", () => {
  const settings = { version: VERSION }, data = Buffer.from("synthetic zip"), hash = sha(data);
  const text = feedText(VERSION, hash, data.length, "2026-11-24T18:00:00.000Z");
  assert.equal(text, `version: ${VERSION}\nfiles:\n  - url: ${ZIP_NAME}\n    sha512: ${hash}\n    size: ${data.length}\npath: ${ZIP_NAME}\nsha512: ${hash}\nreleaseDate: '2026-11-24T18:00:00.000Z'\n`);
  assert.deepEqual(parseFeed(Buffer.from(text), settings), { version: VERSION, name: ZIP_NAME, sha512: hash, size: data.length });
  for (const bad of [
    text.replace(`version: ${VERSION}`, "version: 0.1.0-rs-nightly.8"), text.replace(`- url: ${ZIP_NAME}`, `- url: https://evil.example/${ZIP_NAME}`),
    text.replace(`- url: ${ZIP_NAME}`, `- url: ../${ZIP_NAME}`), text.replace(`path: ${ZIP_NAME}`, "path: latest-mac.yml"),
    text.replace(`size: ${data.length}`, "size: 0"), text.replace(`size: ${data.length}`, `size: ${512 * 1024 * 1024 + 1}`), text.replace(`    sha512: ${hash}`, "    sha512: nope"),
    text.replace(`\nsha512: ${hash}`, `\nsha512: ${sha("other")}`), text + "path: duplicate.zip\n", text.replace("files:", "files: &anchor"), text.replace("releaseDate:", "unknownField:"),
    text.replace("'2026-11-24T18:00:00.000Z'", "'not a date'"), text + `  - url: ${ZIP_NAME}\n`, "", "a".repeat(64 * 1024 + 1),
  ]) assert.throws(() => parseFeed(Buffer.from(bad), settings), Error, bad.slice(0, 60));
});

test("a ZIP may hold only the bundle, and nothing written through a link", () => {
  const inside = `${BUNDLE_NAME}/Contents/Info.plist`;
  assert.deepEqual(inspectZip(storedZip([{ name: `${BUNDLE_NAME}/`, mode: 0o040755 }, { name: inside, data: "x" }, { name: `${BUNDLE_NAME}/Contents/Current`, data: "A", mode: 0o120755 }])), { entries: 3, expanded: 2, links: 1 });
  for (const name of ["evil.sh", `markie nightly.app/Contents/Info.plist`, `${BUNDLE_NAME}/Contents/R\u00e9sum\u00e9.txt`, `../${inside}`, `${BUNDLE_NAME}/../../evil`, `${BUNDLE_NAME}/./x`, `${BUNDLE_NAME}//x`, `/Applications/${inside}`, `${BUNDLE_NAME}\\x`, "Markie.app/Contents/Info.plist", `__MACOSX/${BUNDLE_NAME}/._x`, BUNDLE_NAME]) {
    assert.throws(() => inspectZip(storedZip([{ name: inside, data: "x" }, { name, data: "x" }])), /outside Markie Nightly\.app/, name);
  }
  assert.throws(() => inspectZip(storedZip([{ name: `${BUNDLE_NAME}/Contents/Resources`, data: "/tmp", mode: 0o120755 }, { name: `${BUNDLE_NAME}/Contents/Resources/evil`, data: "x" }])), /through a link/);
  assert.throws(() => inspectZip(storedZip([{ name: inside, data: "a" }, { name: inside, data: "b" }])), /repeats an entry/);
  // The disk ignores letter case: these are one file, and "resources/evil" lands under the link "Resources".
  assert.throws(() => inspectZip(storedZip([{ name: inside, data: "a" }, { name: `${BUNDLE_NAME}/Contents/info.PLIST`, data: "b" }])), /repeats an entry/);
  assert.throws(() => inspectZip(storedZip([{ name: `${BUNDLE_NAME}/Contents/Resources`, data: "/tmp", mode: 0o120755 }, { name: `${BUNDLE_NAME}/Contents/resources/evil`, data: "x" }])), /through a link/);
  assert.throws(() => inspectZip(Buffer.from("not a zip archive at all, just some text")), /not a ZIP/);
  assert.throws(() => inspectZip(storedZip([])), /out of bounds/);
});

test("the signing authority must be the reviewed certificate, team and hardened runtime", () => {
  assert.doesNotThrow(() => assertSigningAuthority(goodDisplay));
  assert.throws(() => assertSigningAuthority(goodDisplay.replace(`Identifier=${BUNDLE_ID}`, "Identifier=com.zvn.markie")), /not signed as/);
  assert.throws(() => assertSigningAuthority(goodDisplay.replace(`TeamIdentifier=${TEAM_ID}`, "TeamIdentifier=AAAAAAAAAA")), /signing team/);
  assert.throws(() => assertSigningAuthority(goodDisplay.replace(`TeamIdentifier=${TEAM_ID}`, "TeamIdentifier=not set")), /signing team/);
  assert.throws(() => assertSigningAuthority(goodDisplay.replace(`Authority=${IDENTITY}`, `Authority=Apple Development: Kirby Campbell (${TEAM_ID})`)), /Developer ID Application/);
  // A Developer ID further down the chain does not make the leaf one.
  assert.throws(() => assertSigningAuthority(goodDisplay.replace(`Authority=${IDENTITY}`, `Authority=Someone Else\nAuthority=${IDENTITY}`)), /Developer ID Application/);
  assert.throws(() => assertSigningAuthority(goodDisplay.replace("flags=0x10000(runtime)", "flags=0x2(adhoc)")), /hardened runtime/);
  assert.match(REQUIREMENT, /identifier "com\.zvn\.markie\.nightly" and anchor apple generic .* certificate leaf\[subject\.OU\] = "3VU8SG5TD9"/);
});

test("verify passes a right release and names each wrong one", macOnly, () => {
  const r = release();
  try {
    createFeed(r.settings);
    const tools = fakeTools();
    const verified = verifyRelease(r.settings, tools);
    const zipBytes = readFileSync(r.zip), feedBytes = readFileSync(path.join(r.output, FEED_NAME));
    assert.deepEqual(verified, { version: VERSION, gitCommit: COMMIT, files: [
      { name: ZIP_NAME, file: r.zip, size: zipBytes.length, sha512: sha(zipBytes) },
      { name: FEED_NAME, file: path.join(r.output, FEED_NAME), size: feedBytes.length, sha512: sha(feedBytes) },
    ] });
    const calls = tools.calls.join("\n");
    assert.match(calls, /codesign --verify --deep --strict -R =identifier "com\.zvn\.markie\.nightly"/);
    assert.match(calls, /spctl --assess --type execute/);
    assert.match(calls, /xcrun stapler validate/);
    // Nothing from the ZIP runs before the signature checks.
    assert.ok(tools.calls.findIndex((c) => c.endsWith("markie-rs --version")) > tools.calls.findIndex((c) => c.startsWith("/usr/bin/xcrun")));
    for (const [change, message] of [
      [{ sealed: false }, /code signature is not valid/], [{ ours: false }, /reviewed Developer ID team/], [{ gatekeeper: false }, /Gatekeeper/], [{ stapled: false }, /not stapled/],
      [{ display: goodDisplay.replace(TEAM_ID + "\n", "AAAAAAAAAA\n") }, /signing team/],
    ]) assert.throws(() => verifyRelease(r.settings, fakeTools(change)), message);
    assert.throws(() => verifyRelease({ ...r.settings, gitCommit: "b".repeat(40) }, fakeTools()), /not built from the checked-out commit/);
    // The real macOS tools refuse this unsigned fixture outright.
    assert.throws(() => verifyRelease(r.settings, systemTools), /code signature is not valid/);
    // Anything else in the folder, or a ZIP that changed after the feed was written.
    writeFileSync(path.join(r.output, "stray.dmg"), "x");
    assert.throws(() => verifyRelease(r.settings, fakeTools()), /something other than/);
    rmSync(path.join(r.output, "stray.dmg"));
    writeFileSync(r.zip, Buffer.concat([zipBytes, Buffer.from("x")]));
    assert.throws(() => verifyRelease(r.settings, fakeTools()), /size is not the feed's/);
    const flipped = Buffer.from(zipBytes); flipped[40] ^= 0xff;
    writeFileSync(r.zip, flipped);
    assert.throws(() => verifyRelease(r.settings, fakeTools()), /SHA-512 is not the feed's/);
  } finally { r.cleanup(); }
});

test("verify refuses another app, another version, other schemes and file types inside a right-named ZIP", macOnly, () => {
  for (const [options, message] of [
    [{ bundleId: "com.zvn.markie" }, /not Markie Nightly/], [{ bundleId: "com.zvn.markie.rs" }, /not Markie Nightly/],
    [{ version: "0.1.0-rs-nightly.6" }, /another version/], [{ schemes: ["markie"] }, /markie-nightly:\/\/ and no other/],
    [{ schemes: ["markie-nightly", "markie"] }, /no other scheme/], [{ schemes: ["markie-rs"] }, /markie-nightly:\/\//],
    [{ extra: "<key>CFBundleDocumentTypes</key><array><dict/></array>\n" }, /claims no file types/],
    [{ reportedVersion: "0.1.0-rs-nightly.6" }, /not built from the checked-out commit at this version/],
  ]) {
    const r = release(options);
    try { createFeed(r.settings); assert.throws(() => verifyRelease(r.settings, fakeTools()), message, JSON.stringify(options)); }
    finally { r.cleanup(); }
  }
});

test("publish sends the ZIP first and the feed last, to the closed destination, with the key only in its header", macOnly, async () => {
  const r = release();
  try {
    createFeed(r.settings);
    const verified = verifyRelease(r.settings, fakeTools());
    const requests = [];
    const fetchImpl = async (url, init) => { requests.push({ url, init }); return new Response("{}", { status: url.endsWith(".yml") ? 200 : 201 }); };
    const result = await publishFiles(r.settings, verified, KEY, fetchImpl);
    assert.deepEqual(requests.map((q) => q.url), [`${GATEWAY_ORIGIN}${LANE_PREFIX}${ZIP_NAME}`, `${GATEWAY_ORIGIN}${LANE_PREFIX}${FEED_NAME}`]);
    for (const [index, q] of requests.entries()) {
      assert.equal(q.init.method, "PUT"); assert.equal(q.init.redirect, "error"); assert.equal(q.init.credentials, "omit");
      assert.equal(q.init.headers["x-markie-publish-key"], KEY);
      assert.equal(q.init.headers["x-markie-sha512"], verified.files[index].sha512);
      assert.equal(q.init.headers["Content-Length"], String(verified.files[index].size));
      assert.deepEqual(Buffer.from(q.init.body), readFileSync(verified.files[index].file));
      assert.ok(!q.url.includes(KEY));
    }
    assert.equal(requests[0].init.headers["If-None-Match"], "*");
    assert.equal(requests[1].init.headers["If-None-Match"], undefined);
    assert.deepEqual(result, { uploaded: [{ name: ZIP_NAME, status: 201, alreadyThere: false }, { name: FEED_NAME, status: 200, alreadyThere: false }] });
    assert.ok(!JSON.stringify(result).includes(KEY));
  } finally { r.cleanup(); }
});

test("publish stops before the feed when anything is wrong", macOnly, async () => {
  const r = release();
  try {
    createFeed(r.settings);
    const verified = verifyRelease(r.settings, fakeTools());
    const attempt = async (respond, files = verified, key = KEY, settings = r.settings) => {
      const urls = [];
      const outcome = await publishFiles(settings, files, key, async (url) => { urls.push(url.slice(url.lastIndexOf("/") + 1)); return respond(url); }).then(() => null, (error) => error);
      return { urls, error: outcome };
    };
    // A missing, short or odd key never reaches the network.
    for (const key of [null, 42, "", "short", `${KEY}\nx-injected: 1`, `${KEY} `, "k".repeat(300)]) {
      const { urls, error } = await attempt(() => new Response("{}", { status: 201 }), verified, key);
      assert.match(error.message, /MARKIE_PRIVATE_PUBLISH_KEY is required/); assert.deepEqual(urls, []);
    }
    // The gateway refuses the ZIP: the feed is never sent.
    for (const status of [400, 404, 413, 500]) {
      const { urls, error } = await attempt(() => new Response("no", { status }));
      assert.match(error.message, new RegExp(`refused the ZIP \\(${status}\\); the feed was not sent`)); assert.deepEqual(urls, [ZIP_NAME]);
      assert.ok(!error.message.includes(KEY));
    }
    // The gateway refuses the feed.
    let step = await attempt((url) => new Response("no", { status: url.endsWith(".yml") ? 400 : 201 }));
    assert.match(step.error.message, /refused the feed \(400\); the feed was not replaced/); assert.deepEqual(step.urls, [ZIP_NAME, FEED_NAME]);
    // A redirect is an error (fetch throws under redirect: "error").
    step = await attempt(() => { throw new TypeError("fetch failed"); });
    assert.match(step.error.message, /fetch failed/); assert.deepEqual(step.urls, [ZIP_NAME]);
    // Artifacts verified for another version or commit, or in another order.
    step = await attempt(() => new Response("{}", { status: 201 }), { ...verified, version: "0.1.0-rs-nightly.8" });
    assert.match(step.error.message, /verified for this version and commit/); assert.deepEqual(step.urls, []);
    step = await attempt(() => new Response("{}", { status: 201 }), { ...verified, files: [verified.files[1], verified.files[0]] });
    assert.match(step.error.message, /then the feed, and nothing else/); assert.deepEqual(step.urls, []);
    step = await attempt(() => new Response("{}", { status: 201 }), verified, KEY, { ...r.settings, apiOrigin: "https://evil.example" });
    assert.match(step.error.message, /reviewed private gateway/); assert.deepEqual(step.urls, []);
    // The feed changed on disk after verification: the ZIP went, the feed did not.
    writeFileSync(path.join(r.output, FEED_NAME), readFileSync(path.join(r.output, FEED_NAME), "utf8").replace("releaseDate", "releaseDate "));
    step = await attempt(() => new Response("{}", { status: 201 }));
    assert.match(step.error.message, /changed after verification/); assert.deepEqual(step.urls, [ZIP_NAME]);
    // The ZIP changed on disk after verification: nothing is sent at all.
    writeFileSync(r.zip, "tampered");
    step = await attempt(() => new Response("{}", { status: 201 }));
    assert.match(step.error.message, /changed after verification/); assert.deepEqual(step.urls, []);
  } finally { r.cleanup(); }
});

/** The gateway's PUT rules, enough to stand in for it over real HTTP. */
function mockGateway() {
  const stored = new Map(), log = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks), name = decodeURIComponent(request.url.slice(LANE_PREFIX.length));
      const reply = (status) => { log.push({ method: request.method, url: request.url, status, headers: request.headers }); response.writeHead(status).end(); };
      if (request.method !== "PUT" || !request.url.startsWith(LANE_PREFIX) || request.headers["x-markie-publish-key"] !== KEY) return reply(404);
      if (Number(request.headers["content-length"]) !== body.length || request.headers["x-markie-sha512"] !== sha(body)) return reply(400);
      if (name === FEED_NAME) {
        const match = /- url: (\S+)\n {4}sha512: (\S+)\n {4}size: (\d+)/.exec(body.toString());
        const artifact = match && stored.get(match[1]);
        if (!artifact || sha(artifact) !== match[2] || artifact.length !== Number(match[3])) return reply(400);
        stored.set(name, body); return reply(200);
      }
      if (stored.has(name)) return reply(409);
      stored.set(name, body); return reply(201);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const local = `http://127.0.0.1:${server.address().port}`;
    // The publisher only ever builds gateway URLs; the test carries them to the mock.
    const fetchImpl = (url, init) => { assert.ok(url.startsWith(GATEWAY_ORIGIN + LANE_PREFIX), url); return fetch(local + url.slice(GATEWAY_ORIGIN.length), init); };
    resolve({ stored, log, fetchImpl, close: () => new Promise((done) => server.close(done)) });
  }));
}

test("over real HTTP: write-once ZIP, feed promoted last, and a retry after a lost feed still lands", macOnly, async () => {
  const r = release(), gateway = await mockGateway();
  try {
    createFeed(r.settings);
    const verified = verifyRelease(r.settings, fakeTools());
    const first = await publishFiles(r.settings, verified, KEY, gateway.fetchImpl);
    assert.deepEqual(first.uploaded.map((u) => u.status), [201, 200]);
    assert.deepEqual(gateway.log.map((entry) => [entry.method, entry.url, entry.status]), [["PUT", LANE_PREFIX + ZIP_NAME, 201], ["PUT", LANE_PREFIX + FEED_NAME, 200]]);
    assert.equal(gateway.log[0].headers["if-none-match"], "*");
    assert.equal(gateway.log[0].headers["content-length"], String(verified.files[0].size));
    assert.deepEqual(gateway.stored.get(ZIP_NAME), readFileSync(r.zip));
    assert.deepEqual(gateway.stored.get(FEED_NAME), readFileSync(path.join(r.output, FEED_NAME)));
    // Published again (say the feed PUT was lost the first time): the ZIP is
    // already there and untouched, and the feed is accepted because it matches.
    gateway.stored.delete(FEED_NAME);
    const again = await publishFiles(r.settings, verified, KEY, gateway.fetchImpl);
    assert.deepEqual(again.uploaded, [{ name: ZIP_NAME, status: 409, alreadyThere: true }, { name: FEED_NAME, status: 200, alreadyThere: false }]);
    // A different ZIP already under this name: the gateway keeps its own and refuses the feed.
    gateway.stored.set(ZIP_NAME, Buffer.from("someone else's bytes")); gateway.stored.delete(FEED_NAME);
    await assert.rejects(publishFiles(r.settings, verified, KEY, gateway.fetchImpl), /refused the feed \(400\)/);
    assert.equal(gateway.stored.has(FEED_NAME), false);
    // A wrong key reads as no such route, and nothing is stored.
    gateway.stored.clear();
    await assert.rejects(publishFiles(r.settings, verified, KEY.replace("synthetic", "incorrect"), gateway.fetchImpl), /refused the ZIP \(404\)/);
    assert.equal(gateway.stored.size, 0);
  } finally { await gateway.close(); r.cleanup(); }
});

test("the command line takes one word, the key only from the environment, and never prints it", macOnly, async () => {
  const r = release();
  try {
    const env = { MARKIE_NIGHTLY_VERSION: VERSION, MARKIE_PRIVATE_API_ORIGIN: GATEWAY_ORIGIN, MARKIE_NIGHTLY_OUTPUT_DIR: r.output, MARKIE_PRIVATE_PUBLISH_KEY: KEY };
    const options = { provenance: clean, tools: fakeTools() };
    for (const args of [[], ["publish", KEY], ["publish", "--key", KEY], ["upload"], ["verify", "--skip-signature"], ["feed", "verify"]]) {
      await assert.rejects(runCli(args, env, path.join(r.root, "repo", "rust"), options), /Usage: node rust\/scripts\/nightly-publish\.mjs/);
    }
    const fed = await runCli(["feed"], env, path.join(r.root, "repo", "rust"), options);
    assert.deepEqual(fed.files.map((f) => f.name), [ZIP_NAME, FEED_NAME]);
    assert.equal(fed.destination, `${GATEWAY_ORIGIN}${LANE_PREFIX}`);
    const verified = await runCli(["verify"], { ...env, MARKIE_PRIVATE_PUBLISH_KEY: undefined }, path.join(r.root, "repo", "rust"), options);
    assert.equal(verified.uploaded, undefined);
    const sent = [];
    const published = await runCli(["publish"], env, path.join(r.root, "repo", "rust"), { ...options, fetch: async (url, init) => { sent.push(init.method + " " + url); return new Response("{}", { status: 201 }); } });
    assert.deepEqual(sent, [`PUT ${GATEWAY_ORIGIN}${LANE_PREFIX}${ZIP_NAME}`, `PUT ${GATEWAY_ORIGIN}${LANE_PREFIX}${FEED_NAME}`]);
    assert.ok(!JSON.stringify(published).includes(KEY), "the result is printed; it must not hold the key");
    // No key in the environment: verification passes, then publishing stops with nothing sent.
    const none = [];
    await assert.rejects(runCli(["publish"], { ...env, MARKIE_PRIVATE_PUBLISH_KEY: undefined }, path.join(r.root, "repo", "rust"), { ...options, fetch: async (url) => { none.push(url); return new Response("{}"); } }), /MARKIE_PRIVATE_PUBLISH_KEY is required/);
    assert.deepEqual(none, []);
    // A dirty tree stops every command before anything is read or sent.
    await assert.rejects(runCli(["publish"], env, path.join(r.root, "repo", "rust"), { ...options, provenance: { gitCommit: COMMIT, gitDirty: true } }), /clean, exact commit/);
  } finally { r.cleanup(); }
});
