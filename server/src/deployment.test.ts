// Which server this is decides where links point and which guards hold. The
// official deployment is the default, so the live Railway variables (which set
// no MARKIE_OFFICIAL) must keep resolving to it with every guard intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveDeployment, officialFlag, API_VERSION, SERVER_VERSION, CLOUD_API_ORIGIN, CLOUD_API_LEGACY_ORIGINS, CLOUD_API_ORIGINS } from "./deployment.ts";
import { applicationOrigins } from "./application-origins.ts";
import { feedForPlatform, primaryDownloadPlatform } from "./downloads.ts";
import { mailMode, emailSignInAvailable, sendEmail } from "./email.ts";
import { parseStorageQuota } from "./quota.ts";

const RAILWAY = "https://api-production-602f.up.railway.app";

test("the live deployment's variables resolve to the official Markie Cloud, with no warning", () => {
  const warnings: string[] = [];
  const d = resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: RAILWAY }, (m) => warnings.push(m));
  assert.equal(d.official, true);
  assert.equal(d.origin, RAILWAY);
  assert.equal(d.siteUrl, "https://markiedocs.com");
  assert.equal(d.downloadSiteUrl, "https://markiedocs.com");
  assert.equal(d.name, "Markie Cloud");
  assert.deepEqual(warnings, []);
});

test("the release-manifest guards still hold on the official deployment", () => {
  assert.throws(
    () => resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: RAILWAY, MARKIE_SITE_URL: "https://evil.test" }),
    /must match the stable release manifest/
  );
  assert.throws(
    () => feedForPlatform(primaryDownloadPlatform(), "https://evil.test/feed", "production"),
    /cannot override the stable release manifest/
  );
});

test("an unset flag on an unknown production host still means official, and says so", () => {
  const warnings: string[] = [];
  const d = resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: "https://markie.example.org" }, (m) => warnings.push(m));
  assert.equal(d.official, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MARKIE_OFFICIAL=0/);
  // Explicitly official is quiet.
  const quiet: string[] = [];
  resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: "https://x.example", MARKIE_OFFICIAL: "1" }, (m) => quiet.push(m));
  assert.deepEqual(quiet, []);
});

test("a self-hosted server follows its own origin and sends downloads to the official site", () => {
  const d = resolveDeployment({ NODE_ENV: "production", MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://markie.example.org/" });
  assert.equal(d.official, false);
  assert.equal(d.origin, "https://markie.example.org");
  assert.equal(d.siteUrl, "https://markie.example.org");
  assert.equal(d.downloadSiteUrl, "https://markiedocs.com");
  assert.equal(d.name, "markie.example.org");
  const named = resolveDeployment({ MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://m.example", MARKIE_SERVER_NAME: "  Acme Docs " });
  assert.equal(named.name, "Acme Docs");
  // The official-site guard does not apply to somebody else's server.
  const fronted = resolveDeployment({ NODE_ENV: "production", MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://api.example.org", MARKIE_SITE_URL: "https://docs.example.org/" });
  assert.equal(fronted.siteUrl, "https://docs.example.org");
});

test("a self-hosted production server must say where it lives, and the flag takes only 0 or 1", () => {
  assert.throws(() => resolveDeployment({ NODE_ENV: "production", MARKIE_OFFICIAL: "0" }), /BETTER_AUTH_URL is required/);
  assert.throws(() => officialFlag({ MARKIE_OFFICIAL: "yes" }), /must be 1/);
  assert.equal(officialFlag({}), true);
  assert.equal(officialFlag({ MARKIE_OFFICIAL: "" }), true);
  assert.equal(officialFlag({ MARKIE_OFFICIAL: "0" }), false);
});

test("the API version and server version are what server-info reports", () => {
  assert.equal(API_VERSION, 1);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(SERVER_VERSION, pkg.version);
});

test("a self-hosted server trusts the desktop app and itself, not the official website", () => {
  const self = applicationOrigins({ NODE_ENV: "production", MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://markie.example.org" });
  assert.ok(self.includes("app://markie"));
  assert.ok(self.includes("https://markie.example.org"));
  assert.ok(!self.includes("https://markiedocs.com"));
  assert.ok(!self.includes("https://www.markiedocs.com"));
  const official = applicationOrigins({ NODE_ENV: "production", BETTER_AUTH_URL: RAILWAY });
  // Plus Cloud's other name, which is the same server (official.ts cloudApiAliases).
  assert.deepEqual(official, ["app://markie", "https://markiedocs.com", "https://www.markiedocs.com", "https://api.markiedocs.com"]);
});

test("mail modes: Resend when keyed, the log only by declaration, and never silently in production", () => {
  assert.equal(mailMode({ RESEND_API_KEY: "k", NODE_ENV: "production" }), "resend");
  assert.equal(mailMode({ NODE_ENV: "production" }), "off");
  assert.equal(mailMode({}), "console");
  assert.equal(mailMode({ NODE_ENV: "production", MARKIE_OFFICIAL: "0", MARKIE_MAIL_LOG: "1" }), "log");
  assert.throws(() => mailMode({ NODE_ENV: "production", MARKIE_MAIL_LOG: "1" }), /self-hosted servers only/);
  assert.equal(emailSignInAvailable({ NODE_ENV: "production" }), false);
  assert.equal(emailSignInAvailable({ NODE_ENV: "production", RESEND_API_KEY: "k" }), true);
  assert.equal(emailSignInAvailable({ NODE_ENV: "production", MARKIE_OFFICIAL: "0", MARKIE_MAIL_LOG: "1" }), true);
});

test("a production server with no mail refuses to send a code, and drops other mail without its contents", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ["NODE_ENV", "RESEND_API_KEY", "MARKIE_MAIL_LOG", "MARKIE_OFFICIAL"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  delete process.env.RESEND_API_KEY;
  delete process.env.MARKIE_MAIL_LOG;
  delete process.env.MARKIE_OFFICIAL;
  process.env.NODE_ENV = "production";
  const logged: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => logged.push(args.join(" ")));
  await assert.rejects(sendEmail({ to: "a@x.test", subject: "123456 is your code", text: "code 123456", secret: true }), /unavailable/);
  await sendEmail({ to: "a@x.test", subject: "Shared", text: "https://example.test/d/1?k=token-value" });
  assert.ok(logged.every((line) => !line.includes("token-value") && !line.includes("123456")));

  process.env.MARKIE_OFFICIAL = "0";
  process.env.MARKIE_MAIL_LOG = "1";
  await sendEmail({ to: "a@x.test", subject: "654321 is your code", text: "code 654321", secret: true });
  assert.ok(logged.some((line) => line.includes("[mail-log]") && line.includes("654321")));
});

test("the storage quota is off unless set, and refuses anything but whole bytes", () => {
  assert.equal(parseStorageQuota({}), null);
  assert.equal(parseStorageQuota({ MARKIE_STORAGE_QUOTA_BYTES: "" }), null);
  assert.equal(parseStorageQuota({ MARKIE_STORAGE_QUOTA_BYTES: "1073741824" }), 1073741824);
  for (const bad of ["0", "-1", "1.5", "10GB", "1e9", "99999999999999999999"]) {
    assert.throws(() => parseStorageQuota({ MARKIE_STORAGE_QUOTA_BYTES: bad }), /positive whole number/, bad);
  }
});

test("Markie Cloud's API origins are the ones the desktop app knows", () => {
  const desktop = JSON.parse(readFileSync(new URL("../../electron/cloud-origin.json", import.meta.url), "utf8")) as {
    origin: string;
    legacyAliases: string[];
  };
  assert.equal(CLOUD_API_ORIGIN, desktop.origin);
  assert.deepEqual([...CLOUD_API_LEGACY_ORIGINS], desktop.legacyAliases);
  assert.deepEqual([...CLOUD_API_ORIGINS], [desktop.origin, ...desktop.legacyAliases]);
});

test("the official deployment answers on both of Cloud's names, whichever BETTER_AUTH_URL names", () => {
  const warnings: string[] = [];
  const moved = resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: "https://api.markiedocs.com" }, (m) => warnings.push(m));
  assert.equal(moved.official, true);
  assert.equal(moved.origin, "https://api.markiedocs.com");
  assert.deepEqual(moved.apiAliases, [RAILWAY]);
  assert.equal(moved.siteUrl, "https://markiedocs.com");
  assert.deepEqual(warnings, []);

  assert.deepEqual(resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: RAILWAY }).apiAliases, ["https://api.markiedocs.com"]);
  // A trailing slash on the variable is still the same origin.
  assert.deepEqual(resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: "https://api.markiedocs.com/" }).apiAliases, [RAILWAY]);
});

test("no other server gets Cloud's other name", () => {
  assert.deepEqual(resolveDeployment({ MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://docs.example.com" }).apiAliases, []);
  // A self-hosted server that claims Cloud's address is still not Cloud.
  assert.deepEqual(resolveDeployment({ MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://api.markiedocs.com" }).apiAliases, []);
  assert.deepEqual(resolveDeployment({}).apiAliases, []);
  assert.deepEqual(resolveDeployment({ NODE_ENV: "production", BETTER_AUTH_URL: "https://markie.example.org" }, () => {}).apiAliases, []);
});

test("the official deployment's browser origins include both of Cloud's names, and a self-hosted server's do not", () => {
  const moved = applicationOrigins({ NODE_ENV: "production", BETTER_AUTH_URL: "https://api.markiedocs.com" });
  assert.ok(moved.includes(RAILWAY));
  const before = applicationOrigins({ NODE_ENV: "production", BETTER_AUTH_URL: RAILWAY });
  assert.ok(before.includes("https://api.markiedocs.com"));
  const selfHosted = applicationOrigins({ NODE_ENV: "production", MARKIE_OFFICIAL: "0", BETTER_AUTH_URL: "https://docs.example.com" });
  assert.ok(!selfHosted.includes(RAILWAY));
  assert.ok(!selfHosted.includes("https://api.markiedocs.com"));
});
