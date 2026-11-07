// Hosted Live Docs compile with the Mac app's pinned Darkmown, not a second
// copy that can drift. The server cannot import src/lib/darkmown/ (its Docker
// build context is server/), so it runs generated copies, and this fails the
// moment a copy and its source differ. The fix is always
// `(cd server && npm run darkmown:sync)`, never an edit to a copy.
//
// The other half of the parity check runs in the app's suite:
// src/lib/darkmown/hosted-parity.test.ts compiles every sample through both
// pipelines and asserts the same sanitized output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COPY_DIR, FILES, expectedCopy, sourcePath } from "../scripts/sync-darkmown.mjs";

const sha256 = (bytes: string | Buffer, encoding: "hex" | "base64" = "hex") => createHash("sha256").update(bytes).digest(encoding);
const haveSources = FILES.every((file: { source: string }) => existsSync(sourcePath(file)));

test("every generated Darkmown file is its source, byte for byte (or by its one declared rewrite)", { skip: !haveSources && "built without the app sources" }, () => {
  for (const file of FILES) {
    assert.equal(readFileSync(join(COPY_DIR, file.name), "utf8"), expectedCopy(file), `${file.name} drifted: run (cd server && npm run darkmown:sync)`);
  }
  // Nothing extra is hiding in the generated directory.
  assert.deepEqual(readdirSync(COPY_DIR).sort(), FILES.map((file: { name: string }) => file.name).sort());
});

test("the copies are the artifacts PROVENANCE.json pins", () => {
  const provenance = JSON.parse(readFileSync(join(COPY_DIR, "PROVENANCE.json"), "utf8")) as {
    version: string;
    artifacts: Record<string, { bytes: number; sha256: string }>;
    hostAdaptations: Array<{ path: string; sha256: string }>;
  };
  for (const name of ["compiler-browser.mjs", "runtime.js.txt", "THIRD-PARTY-NOTICES.txt"]) {
    const bytes = readFileSync(join(COPY_DIR, name));
    assert.equal(sha256(bytes), provenance.artifacts[name].sha256, name);
    assert.equal(bytes.length, provenance.artifacts[name].bytes, name);
  }
  const bootstrap = provenance.hostAdaptations.find((entry) => entry.path.endsWith("local-form-bootstrap.js.txt"));
  assert.equal(sha256(readFileSync(join(COPY_DIR, "local-form-bootstrap.js.txt"))), bootstrap?.sha256);
});

test("the runtime policy hashes are the runtime and bootstrap the server embeds", () => {
  const policy = JSON.parse(readFileSync(join(COPY_DIR, "runtime-policy.json"), "utf8")) as { runtimeSha256: string; bootstrapSha256: string };
  assert.equal(sha256(readFileSync(join(COPY_DIR, "runtime.js.txt"), "utf8"), "base64"), policy.runtimeSha256);
  assert.equal(sha256(readFileSync(join(COPY_DIR, "local-form-bootstrap.js.txt"), "utf8"), "base64"), policy.bootstrapSha256);
});

test("the server's sanitizer dependencies are the versions the app sanitizes with", { skip: !existsSync(new URL("../../node_modules/rehype-sanitize/package.json", import.meta.url)) && "no app checkout" }, () => {
  const version = (root: string, name: string) =>
    (JSON.parse(readFileSync(new URL(`${root}node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string }).version;
  for (const name of ["unified", "rehype-raw", "rehype-sanitize", "rehype-stringify", "hast-util-raw", "hast-util-sanitize", "hast-util-to-html", "parse5"]) {
    assert.equal(version("../", name), version("../../", name), `${name}: server and app resolve different versions`);
  }
});
