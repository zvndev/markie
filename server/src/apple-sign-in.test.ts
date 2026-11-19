import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { APPLE_ISSUER, appleConfigFromEnv, createAppleClientSecret, signAppleClientSecret } from "./apple-sign-in.ts";

// A throwaway P-256 key, the same kind Apple issues as a .p8.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = { APPLE_CLIENT_ID: "com.example.markie.signin", APPLE_TEAM_ID: "TEAM123456", APPLE_KEY_ID: "KEY1234567", APPLE_PRIVATE_KEY: pem };

function decode(jwt: string, key: KeyObject = publicKey) {
  const [header, payload, signature] = jwt.split(".");
  // Apple verifies the raw r||s form JOSE uses, not DER.
  const valid = verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  return { valid, header: JSON.parse(Buffer.from(header, "base64url").toString()), payload: JSON.parse(Buffer.from(payload, "base64url").toString()) };
}

test("Apple is off unless all four settings are present, and says which are missing", () => {
  assert.equal(appleConfigFromEnv({}), null);
  const warn = console.warn; const warned: string[] = []; console.warn = (line: string) => { warned.push(line); };
  try {
    assert.equal(appleConfigFromEnv({ ...env, APPLE_KEY_ID: "  " }), null);
    assert.equal(appleConfigFromEnv({ APPLE_CLIENT_ID: env.APPLE_CLIENT_ID }), null);
  } finally { console.warn = warn; }
  assert.match(warned[0], /APPLE_KEY_ID not set/);
  assert.match(warned[1], /APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY not set/);
  assert.ok(warned.every((line) => !line.includes("PRIVATE KEY-----")));
});

test("a .p8 pasted on one line with literal \\n escapes reads the same as the file", () => {
  const oneLine = pem.trim().replace(/\n/g, "\\n");
  assert.ok(!oneLine.includes("\n"));
  const config = appleConfigFromEnv({ ...env, APPLE_PRIVATE_KEY: oneLine });
  assert.ok(config);
  assert.equal(config.clientId, env.APPLE_CLIENT_ID);
  assert.ok(decode(signAppleClientSecret(config, 1_800_000_000, 3600)).valid);
});

test("an unreadable or wrong-curve key stops the boot without echoing the key", () => {
  assert.throws(() => appleConfigFromEnv({ ...env, APPLE_PRIVATE_KEY: "not a key" }), (error: Error) => /not a readable private key/.test(error.message) && !error.message.includes("not a key"));
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => appleConfigFromEnv({ ...env, APPLE_PRIVATE_KEY: p384 }), /P-256/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => appleConfigFromEnv({ ...env, APPLE_PRIVATE_KEY: rsa }), /P-256/);
});

test("the client secret is an ES256 JWT with the claims Apple requires", () => {
  const config = appleConfigFromEnv(env)!;
  const { valid, header, payload } = decode(signAppleClientSecret(config, 1_800_000_000, 7 * 86_400));
  assert.equal(valid, true);
  assert.deepEqual(header, { alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" });
  assert.deepEqual(payload, { iss: env.APPLE_TEAM_ID, iat: 1_800_000_000, exp: 1_800_000_000 + 7 * 86_400, aud: APPLE_ISSUER, sub: env.APPLE_CLIENT_ID });
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
  assert.equal(decode(signAppleClientSecret(config, 1_800_000_000, 60), other).valid, false);
});

test("the held secret is signed at creation, kept for a day, then re-signed well inside Apple's six months", () => {
  const config = appleConfigFromEnv(env)!;
  let now = Date.UTC(2026, 10, 19, 12);
  const held = createAppleClientSecret(config, { now: () => now });
  const first = held.current();
  const claims = decode(first).payload;
  assert.ok(claims.iat <= now / 1000 && claims.iat >= now / 1000 - 120, "issued now, allowing for clock skew");
  assert.ok(claims.exp - claims.iat <= 15_777_000, "within Apple's cap");
  assert.ok(claims.exp - now / 1000 >= 6 * 86_400, "valid for most of a week");
  now += 23 * 3600_000;
  assert.equal(held.current(), first);
  now += 3600_000;
  const second = held.current();
  assert.notEqual(second, first);
  assert.equal(decode(second).valid, true);
  assert.equal(decode(second).payload.iat, decode(first).payload.iat + 86_400);
  // A clock that jumps back re-signs rather than hand out an iat in the future.
  now -= 2 * 86_400_000;
  const third = held.current();
  assert.notEqual(third, second);
  assert.ok(decode(third).payload.iat <= now / 1000);
});

test("a bad key fails when the holder is made, not at the first sign-in", () => {
  const config = appleConfigFromEnv(env)!;
  assert.throws(() => createAppleClientSecret({ ...config, privateKey: generateKeyPairSync("ed25519").privateKey }));
});
