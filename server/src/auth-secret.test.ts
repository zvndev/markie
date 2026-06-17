import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAuthSecret } from "./auth-secret.ts";

test("resolveAuthSecret returns the provided secret", () => {
  assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: "real" } as NodeJS.ProcessEnv), "real");
});

test("resolveAuthSecret throws in production when unset", () => {
  assert.throws(
    () => resolveAuthSecret({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    /BETTER_AUTH_SECRET is required/,
  );
});

test("resolveAuthSecret allows a dev fallback outside production", () => {
  const s = resolveAuthSecret({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.match(s, /dev-secret/);
});
