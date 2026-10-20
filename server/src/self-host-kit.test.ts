// The self-hosting kit outside the Node process: storage configuration, the
// Litestream config, the boot script's refusals, and deploy/init.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetStore, s3Store } from "./storage.ts";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(SERVER, "..");
const ENTRYPOINT = join(SERVER, "docker-entrypoint.sh");
const INIT = join(REPO, "deploy", "init.sh");
const HASH = "a".repeat(64);

function captureFetch(t: { after(fn: () => void): void }): string[] {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return urls;
}

test("generic S3 names reach any provider, with media under assets/ in a shared bucket", async (t) => {
  const urls = captureFetch(t);
  const store = assetStore({
    S3_ENDPOINT: "https://abc123.r2.cloudflarestorage.com/", S3_BUCKET: "markie",
    S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", S3_REGION: "auto",
  });
  assert.ok(store);
  assert.equal(await store!.head(`user1/${HASH}`), null);
  assert.equal(urls[0], `https://abc123.r2.cloudflarestorage.com/markie/assets/user1/${HASH}`);

  const split = assetStore({
    S3_ENDPOINT: "http://minio:9000", S3_BUCKET: "backups", S3_ASSETS_BUCKET: "media",
    S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret",
  });
  await split!.head(`user1/${HASH}`);
  assert.equal(urls[1], `http://minio:9000/media/assets/user1/${HASH}`);
});

test("the live deployment's ASSETS_* and B2_* names still resolve exactly as before", async (t) => {
  const urls = captureFetch(t);
  const store = assetStore({
    ASSETS_BUCKET: "markie-assets", ASSETS_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    ASSETS_KEY_ID: "id", ASSETS_APP_KEY: "key",
    B2_ENDPOINT: "https://s3.us-east-005.backblazeb2.com", B2_BUCKET: "Markie", B2_KEY_ID: "b2", B2_APP_KEY: "b2key",
  });
  await store!.head(`user1/${HASH}`);
  assert.equal(urls[0], `https://s3.us-west-004.backblazeb2.com/markie-assets/user1/${HASH}`);
  assert.equal(assetStore({}), null);
});

test("half-configured generic storage is refused with the missing names", () => {
  assert.throws(() => assetStore({ S3_BUCKET: "b", S3_ENDPOINT: "https://e" }), /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
  assert.throws(() => s3Store({ bucket: "b", endpoint: "https://e", keyId: "i", appKey: "k", prefix: "../x" }), /prefix refused/);
});

test("deploy/litestream.yml is the server's encrypted config, byte for byte", () => {
  const server = readFileSync(join(SERVER, "litestream.yml"), "utf8");
  const deploy = readFileSync(join(REPO, "deploy", "litestream.yml"), "utf8");
  assert.equal(deploy, server);
  assert.match(server, /path: markie-db-age/);
  assert.match(server, /age:\n\s+identities:\n\s+- \$\{LITESTREAM_AGE_IDENTITY\}\n\s+recipients:\n\s+- \$\{LITESTREAM_AGE_RECIPIENT\}/);
});

// A stand-in for litestream that reports what it was run with, so the boot
// script's decisions can be checked without a bucket.
function fakeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "markie-fakebin-"));
  const fake = join(bin, "litestream");
  writeFileSync(fake, '#!/bin/sh\necho "litestream $*"\necho "bucket=$B2_BUCKET endpoint=$B2_ENDPOINT region=[$B2_REGION]"\n');
  chmodSync(fake, 0o755);
  return bin;
}

function entrypoint(env: Record<string, string>, args: string[]) {
  const result = spawnSync("sh", [ENTRYPOINT, ...args], {
    cwd: SERVER,
    env: { PATH: `${fakeBin()}:${process.env.PATH}`, DB_PATH: "/tmp/markie-entrypoint-test.db", ...env },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

const AGE = { LITESTREAM_AGE_IDENTITY: "AGE-SECRET-KEY-1TEST", LITESTREAM_AGE_RECIPIENT: "age1test" };
const LEGACY = { B2_ENDPOINT: "https://s3.us-east-005.backblazeb2.com", B2_BUCKET: "Markie", B2_KEY_ID: "k", B2_APP_KEY: "s" };

test("the boot script passes the live deployment's B2_* names through untouched", () => {
  const r = entrypoint({ ...LEGACY, ...AGE }, ["backup", "generations", "/data/markie.db"]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /litestream generations -config \/etc\/litestream.yml \/data\/markie.db/);
  assert.match(r.out, /bucket=Markie endpoint=https:\/\/s3.us-east-005.backblazeb2.com region=\[\]/);
});

test("the boot script maps generic S3 names onto the ones litestream.yml reads", () => {
  const r = entrypoint({
    S3_ENDPOINT: "http://minio:9000", S3_BUCKET: "markie", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", S3_REGION: "auto", ...AGE,
  }, ["backup", "snapshots", "/data/markie.db"]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /bucket=markie endpoint=http:\/\/minio:9000 region=\[auto\]/);
});

test("the boot script refuses to replicate without the age key, and names what is missing", () => {
  for (const env of [{ ...LEGACY }, { ...LEGACY, LITESTREAM_AGE_RECIPIENT: "age1test" }]) {
    const r = entrypoint(env, []);
    assert.equal(r.status, 1);
    assert.match(r.err, /LITESTREAM_AGE_IDENTITY and LITESTREAM_AGE_RECIPIENT/);
    assert.match(r.err, /only replicates the database encrypted/);
    assert.doesNotMatch(r.out, /litestream/);
  }
  const partial = entrypoint({ S3_BUCKET: "markie", ...AGE }, []);
  assert.equal(partial.status, 1);
  assert.match(partial.err, /S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY/);
});

// deploy/init.sh, run the way a person runs it, minus the terminal.
function runInit(args: string[], path = process.env.PATH ?? "") {
  const dir = mkdtempSync(join(tmpdir(), "markie-init-"));
  const envFile = join(dir, ".env");
  const result = spawnSync("/bin/sh", [INIT, "--non-interactive", "--env-file", envFile, ...args], {
    env: { PATH: path, HOME: dir }, encoding: "utf8", input: "",
  });
  return { dir, envFile, status: result.status, out: result.stdout + result.stderr };
}

const STORAGE = ["--s3-endpoint", "http://minio:9000", "--s3-bucket", "markie", "--s3-access-key-id", "minio-id", "--s3-secret-access-key", "minio-secret-value"];
const hasAgeKeygen = spawnSync("sh", ["-c", "command -v age-keygen"]).status === 0;

test("init.sh writes a private .env with generated secrets it never prints", { skip: !hasAgeKeygen && "age-keygen is not installed" }, () => {
  const r = runInit(["--domain", "https://Markie.Example.org/", ...STORAGE, "--no-mail", "--quota-bytes", "1048576"]);
  assert.equal(r.status, 0, r.out);
  const env = readFileSync(r.envFile, "utf8");
  const value = (name: string) => env.match(new RegExp(`^${name}='([^']*)'$`, "m"))?.[1];
  assert.equal(value("MARKIE_DOMAIN"), "markie.example.org");
  assert.equal(value("BETTER_AUTH_URL"), "https://markie.example.org");
  assert.match(value("BETTER_AUTH_SECRET") ?? "", /^[0-9a-f]{64}$/);
  assert.match(value("LITESTREAM_AGE_IDENTITY") ?? "", /^AGE-SECRET-KEY-1[0-9A-Z]+$/);
  assert.match(value("LITESTREAM_AGE_RECIPIENT") ?? "", /^age1[0-9a-z]+$/);
  assert.equal(value("MARKIE_MAIL_LOG"), "1");
  assert.equal(value("MARKIE_STORAGE_QUOTA_BYTES"), "1048576");
  assert.equal(statSync(r.envFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(r.dir, "markie-backup-key.txt")).mode & 0o777, 0o600);
  for (const secret of [value("BETTER_AUTH_SECRET")!, value("LITESTREAM_AGE_IDENTITY")!, "minio-secret-value"]) {
    assert.ok(!r.out.includes(secret), "init.sh printed a secret");
  }
  assert.match(r.out, /password manager/);
  // The recipient really is the identity's public half.
  const derived = execFileSync("age-keygen", ["-y"], { input: `${value("LITESTREAM_AGE_IDENTITY")}\n`, encoding: "utf8" }).trim();
  assert.equal(derived, value("LITESTREAM_AGE_RECIPIENT"));

  // Running it again changes nothing.
  const before = readFileSync(r.envFile, "utf8");
  const again = spawnSync("sh", [INIT, "--non-interactive", "--env-file", r.envFile, "--domain", "other.example.org", "--no-storage"], { encoding: "utf8" });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(readFileSync(r.envFile, "utf8"), before);
});

test("init.sh without age-keygen leaves the key empty and says how to make one", () => {
  // A PATH holding only the basic tools the script needs, so age-keygen is absent
  // wherever this runs.
  const bin = mkdtempSync(join(tmpdir(), "markie-init-bin-"));
  for (const tool of ["dirname", "sed", "tr", "grep", "head", "od", "date", "chmod", "cat", "openssl", "stty"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
  const r = runInit(["--domain", "m.example.org", ...STORAGE, "--resend-api-key", "re_test_key", "--mail-from", "Markie <m@m.example.org>"], bin);
  assert.equal(r.status, 0, r.out);
  const env = readFileSync(r.envFile, "utf8");
  assert.match(env, /^LITESTREAM_AGE_IDENTITY=''$/m);
  assert.match(env, /^RESEND_API_KEY='re_test_key'$/m);
  assert.match(env, /^EMAIL_FROM='Markie <m@m.example.org>'$/m);
  assert.doesNotMatch(env, /MARKIE_MAIL_LOG='1'/);
  assert.match(r.out, /age-keygen -o markie-backup-key.txt/);
  assert.match(r.out, /refuses to start until both are set/);
  assert.ok(!existsSync(join(r.dir, "markie-backup-key.txt")));
});

test("init.sh refuses missing or half-given storage instead of guessing", () => {
  assert.match(runInit(["--domain", "m.example.org"]).out, /no storage given/);
  assert.match(runInit(["--domain", "m.example.org", "--s3-bucket", "b"]).out, /missing its S3 endpoint/);
  assert.match(runInit(["--domain", "not a domain", "--no-storage"]).out, /is not a domain name/);
  assert.match(runInit([]).out, /--domain is required/);
});
