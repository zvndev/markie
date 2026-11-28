// node --test rust/scripts/mac-info-plist.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executableFor, infoPlist, plistXml } from "./mac-info-plist.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// What Electron Markie 0.9.8-super-nightly.2's own Info.plist declares, read
// from an installed copy: the identity macOS has on record for com.zvn.markie.
const electron = JSON.parse(readFileSync(path.join(here, "fixtures", "electron-markie-info.json"), "utf8"));
const VERSION = "0.10.0-super-nightly.1";

/** The plist as macOS reads it, through plutil. */
function asMacReads(plist) {
  const dir = mkdtempSync(path.join(tmpdir(), "markie-info-plist-"));
  try {
    const file = path.join(dir, "Info.plist");
    writeFileSync(file, plistXml(plist));
    assert.equal(spawnSync("/usr/bin/plutil", ["-lint", file]).status, 0);
    const json = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    assert.equal(json.status, 0);
    return JSON.parse(json.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the Mac app declares exactly what Electron Markie declares", { skip: process.platform !== "darwin" && "needs plutil" }, () => {
  const plist = asMacReads(infoPlist("nightly", VERSION));
  assert.equal(plist.CFBundleIdentifier, electron.CFBundleIdentifier);
  assert.equal(plist.CFBundleIdentifier, "com.zvn.markie");
  assert.equal(plist.CFBundleName, electron.CFBundleName);
  assert.equal(plist.LSApplicationCategoryType, electron.LSApplicationCategoryType);
  assert.equal(plist.LSMinimumSystemVersion, electron.LSMinimumSystemVersion);
  assert.equal(plist.CFBundleIconFile, electron.CFBundleIconFile);
  // The same URL scheme and, entry for entry, the same document types.
  assert.deepEqual(plist.CFBundleURLTypes, electron.CFBundleURLTypes);
  assert.deepEqual(plist.CFBundleDocumentTypes, electron.CFBundleDocumentTypes);
  assert.deepEqual(plist.UTExportedTypeDeclarations, electron.UTExportedTypeDeclarations);
  assert.deepEqual(plist.UTImportedTypeDeclarations, electron.UTImportedTypeDeclarations);
  assert.equal(plist.CFBundleDocumentTypes.length, 21);
  assert.equal(plist.CFBundleShortVersionString, VERSION);
  assert.equal(plist.CFBundleVersion, VERSION);
  // Electron's own executable name: Squirrel.Mac names the installed app after it.
  assert.equal(plist.CFBundleExecutable, electron.CFBundleExecutable ?? "Markie");
  assert.equal(plist.CFBundleExecutable, "Markie");
  assert.equal(plist.CFBundlePackageType, "APPL");
});

test("the public Mac app declares the same plist as the nightly, with its own version", { skip: process.platform !== "darwin" && "needs plutil" }, () => {
  const pub = asMacReads(infoPlist("public", "0.10.0"));
  const nightly = asMacReads(infoPlist("nightly", "0.10.0"));
  assert.deepEqual(pub, nightly);
  assert.equal(pub.CFBundleIdentifier, electron.CFBundleIdentifier);
  assert.deepEqual(pub.CFBundleDocumentTypes, electron.CFBundleDocumentTypes);
  assert.deepEqual(pub.CFBundleURLTypes, electron.CFBundleURLTypes);
  assert.equal(asMacReads(infoPlist("public", "0.10.0-rc.1")).CFBundleShortVersionString, "0.10.0-rc.1");
  assert.equal(pub.CFBundleExecutable, "Markie");
});

test("the dev build claims its own scheme and no file types", { skip: process.platform !== "darwin" && "needs plutil" }, () => {
  const plist = asMacReads(infoPlist("rs", "0.10.0"));
  assert.equal(plist.CFBundleIdentifier, "com.zvn.markie.rs");
  assert.equal(plist.CFBundleName, "Markie RS");
  assert.equal(plist.CFBundleExecutable, "markie-rs", "the dev build keeps its own executable name");
  assert.deepEqual(plist.CFBundleURLTypes, [{ CFBundleURLName: "com.zvn.markie.rs", CFBundleTypeRole: "Viewer", CFBundleURLSchemes: ["markie-rs"] }]);
  for (const key of ["CFBundleDocumentTypes", "UTExportedTypeDeclarations", "UTImportedTypeDeclarations"]) assert.equal(plist[key], undefined, key);
});

test("refuses a variant or version it does not know, and a config that is not Markie's", () => {
  assert.throws(() => infoPlist("stable", VERSION), /rs, nightly or public/);
  assert.throws(() => infoPlist("toString", VERSION), /rs, nightly or public/);
  assert.deepEqual(["rs", "nightly", "public"].map(executableFor), ["markie-rs", "Markie", "Markie"]);
  assert.throws(() => executableFor("stable"), /rs, nightly or public/);
  const cli = spawnSync(process.execPath, [path.join(here, "mac-info-plist.mjs"), "--executable", "public"], { encoding: "utf8" });
  assert.equal(cli.stdout, "Markie\n");
  assert.throws(() => infoPlist("nightly", ""), /version is required/);
  assert.throws(() => infoPlist("nightly", "1.0 <script>"), /version is required/);
  assert.throws(() => infoPlist("nightly", VERSION, { appId: "com.example.other", productName: "Markie" }), /not Markie's/);
  assert.throws(() => infoPlist("nightly", VERSION, { appId: "com.zvn.markie", productName: "Markie", protocols: [{ name: "Markie", schemes: ["markie", "other"] }] }), /exactly markie:\/\//);
  assert.match(plistXml({ A: "x < y & z" }), /<string>x &lt; y &amp; z<\/string>/);
});
