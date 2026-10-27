#!/usr/bin/env node
// What the Linux release workflow leaves beside the packages it built.
//
// Linux packages are not code-signed, by design: there is no Linux equivalent
// of Gatekeeper or SmartScreen for a signature to satisfy, and the updater's
// integrity check is the SHA-512 in latest-linux.yml. So where Windows proves
// "this is our build" with an Authenticode signature checked on the release
// machine, Linux proves it with this file: the exact commit, the run that
// built it, the checks that run passed, and the SHA-512 of every package,
// written by CI next to a conventional SHA512SUMS file. release:prepare:linux
// downloads all of it and refuses anything that disagrees with itself, with
// the files, or with the commit being released.
//
//   node scripts/linux-build-evidence.mjs --dist dist --version 0.9.2 \
//     --commit <sha> --run-url <url> --check package-smoke --check xvfb-launch-smoke ...
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The two packages a Linux release ships, in the order the feed lists them. */
export function expectedLinuxArtifacts(version) {
  return [`Markie-${version}-x86_64.AppImage`, `Markie-${version}-amd64.deb`];
}

export const linuxFeedFile = (version) => (/-beta\.\d+$/.test(version) ? "beta-linux.yml" : "latest-linux.yml");
export const linuxEvidenceFile = (version) => `Markie-${version}-linux-build.json`;
export const linuxChecksumFile = (version) => `Markie-${version}-linux-SHA512SUMS.txt`;

// Checks the workflow must have passed for a build to be releasable. A build
// whose evidence lacks one of these was not smoke-tested and is refused.
export const REQUIRED_LINUX_CHECKS = [
  "package-smoke",
  "xvfb-launch-smoke-unpacked",
  "xvfb-launch-smoke-appimage",
  "deb-install-launch-remove",
  "desktop-entry-valid",
  "updater-config",
];

const sha512 = (file) => createHash("sha512").update(readFileSync(file)).digest();

/** `sha512sum` output: "<hex>  <name>" per line, binary-mode "*" tolerated. */
export function parseSha512Sums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{128})\s+\*?(.+)$/i);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

export function formatSha512Sums(files) {
  return files.map((file) => `${Buffer.from(file.sha512, "base64").toString("hex")}  ${file.name}\n`).join("");
}

function feedEntries(feedText) {
  const files = [];
  let current = null;
  for (const raw of feedText.split(/\r?\n/)) {
    const url = raw.match(/^\s*-\s+url:\s*(.+?)\s*$/)?.[1];
    if (url) {
      current = { url: decodeURIComponent(url.replace(/^['"]|['"]$/g, "")) };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const hash = raw.match(/^\s+sha512:\s*(.+?)\s*$/)?.[1];
    if (hash) current.sha512 = hash.replace(/^['"]|['"]$/g, "");
    const size = raw.match(/^\s+size:\s*(\d+)\s*$/)?.[1];
    if (size) current.size = Number(size);
  }
  return { version: feedText.match(/^version:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1] ?? null, files };
}

/**
 * Hash the packages, cross-check them against the feed electron-builder wrote,
 * and return the evidence record. Throws on any disagreement, so a workflow
 * that calls this fails before it uploads anything.
 */
/**
 * @param {{ dist: string, version: string, commit: string, runUrl?: string | null,
 *   runId?: string | null, checks?: string[], builtAt?: string }} options
 */
export function buildLinuxEvidence({ dist, version, commit, runUrl = null, runId = null, checks = [], builtAt = new Date().toISOString() }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`a full commit SHA is required, got ${commit ?? "nothing"}`);
  const missingChecks = REQUIRED_LINUX_CHECKS.filter((check) => !checks.includes(check));
  if (missingChecks.length) throw new Error(`the build did not pass: ${missingChecks.join(", ")}`);
  const feedName = linuxFeedFile(version);
  const feedPath = path.join(dist, feedName);
  if (!existsSync(feedPath)) throw new Error(`missing ${feedName} in ${dist}`);
  const feedText = readFileSync(feedPath, "utf8");
  const feed = feedEntries(feedText);
  if (feed.version !== version) throw new Error(`${feedName} names ${feed.version ?? "nothing"}, expected ${version}`);

  const expected = expectedLinuxArtifacts(version);
  const listed = feed.files.map((entry) => entry.url).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${feedName} lists ${listed.join(", ") || "nothing"}, expected ${expected.join(", ")}`);
  }
  const files = expected.map((name) => {
    const file = path.join(dist, name);
    if (!existsSync(file)) throw new Error(`missing ${name} in ${dist}`);
    const record = { name, size: statSync(file).size, sha512: sha512(file).toString("base64") };
    const entry = feed.files.find((candidate) => candidate.url === name);
    if (entry.size !== record.size) throw new Error(`${name} is ${record.size} bytes, ${feedName} says ${entry.size}`);
    if (entry.sha512 !== record.sha512) throw new Error(`${name} SHA-512 does not match ${feedName}`);
    return record;
  });
  return {
    schemaVersion: 1,
    product: "Markie",
    platform: "linux",
    arch: "x64",
    version,
    commit,
    runId,
    runUrl,
    builtAt,
    signing: "unsigned-by-design",
    feed: { name: feedName, sha512: createHash("sha512").update(feedText).digest("base64") },
    checks: [...checks],
    files,
  };
}

/**
 * The release machine's half: every claim in the evidence must hold for the
 * files on disk, the SHA512SUMS file must agree, and the build must be of the
 * commit being released. Returns the evidence.
 */
/**
 * @param {{ dist: string, version: string, commit?: string | null,
 *   files: { name: string, size: number, sha512: string }[] }} options
 */
export function verifyLinuxEvidence({ dist, version, commit, files }) {
  const evidencePath = path.join(dist, linuxEvidenceFile(version));
  if (!existsSync(evidencePath)) throw new Error(`missing ${linuxEvidenceFile(version)}; was the build published to the linux-built tag?`);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (evidence.version !== version) throw new Error(`Linux build evidence is for ${evidence.version}, expected ${version}`);
  if (commit && evidence.commit !== commit) {
    throw new Error(`the Linux build is of commit ${evidence.commit}, not the release commit ${commit}; re-run the Linux release workflow on main`);
  }
  if (evidence.signing !== "unsigned-by-design") throw new Error("Linux build evidence does not record its signing stance");
  const missingChecks = REQUIRED_LINUX_CHECKS.filter((check) => !evidence.checks?.includes(check));
  if (missingChecks.length) throw new Error(`the Linux build did not pass: ${missingChecks.join(", ")}`);

  const normalized = (list) =>
    JSON.stringify(
      [...(list ?? [])].map(({ name, size, sha512: hash }) => ({ name, size, sha512: hash })).sort((a, b) => a.name.localeCompare(b.name))
    );
  if (normalized(evidence.files) !== normalized(files)) {
    throw new Error("the Linux packages on disk are not the ones the build evidence describes");
  }

  const sumsPath = path.join(dist, linuxChecksumFile(version));
  if (!existsSync(sumsPath)) throw new Error(`missing ${linuxChecksumFile(version)}`);
  const sums = parseSha512Sums(readFileSync(sumsPath, "utf8"));
  for (const file of files) {
    const hex = Buffer.from(file.sha512, "base64").toString("hex");
    if (sums.get(file.name) !== hex) throw new Error(`${linuxChecksumFile(version)} disagrees about ${file.name}`);
  }
  return evidence;
}

function parseArgs(argv) {
  const options = { checks: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dist") options.dist = argv[++i];
    else if (arg === "--version") options.version = argv[++i];
    else if (arg === "--commit") options.commit = argv[++i];
    else if (arg === "--run-url") options.runUrl = argv[++i];
    else if (arg === "--run-id") options.runId = argv[++i];
    else if (arg === "--check") options.checks.push(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidence = buildLinuxEvidence(options);
    writeFileSync(path.join(options.dist, linuxEvidenceFile(options.version)), `${JSON.stringify(evidence, null, 2)}\n`);
    writeFileSync(path.join(options.dist, linuxChecksumFile(options.version)), formatSha512Sums(evidence.files));
    console.log(`[linux-evidence] Markie ${evidence.version} at ${evidence.commit}, unsigned by design`);
    for (const file of evidence.files) console.log(`[linux-evidence] ${file.name} ${file.size} bytes sha512 ${file.sha512}`);
  } catch (error) {
    console.error(`[linux-evidence] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
