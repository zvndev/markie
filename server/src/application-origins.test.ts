import { test } from "node:test";
import assert from "node:assert/strict";
import { applicationOrigins } from "./application-origins.ts";

test("desktop and supported web origins share an exact allowlist", () => {
  const origins = applicationOrigins({ MARKIE_WEB_ORIGINS: "https://documents.example.com,http://127.0.0.1:4173" });
  assert.ok(origins.includes("app://markie"));
  assert.ok(origins.includes("https://markiedocs.com"));
  assert.ok(origins.includes("http://127.0.0.1:3000"));
  assert.ok(origins.includes("http://127.0.0.1:4173"));
  assert.ok(!origins.includes("*"));
  assert.equal(new Set(origins).size, origins.length);
});

test("web origin configuration cannot enable arbitrary HTTP, paths or credentials", () => {
  for (const origin of ["*", "http://attacker.test", "https://example.com/path", "https://user:secret@example.com", "file:///tmp/", "https://example.com?x=y", "https://example.com#fragment"]) {
    assert.throws(() => applicationOrigins({ MARKIE_WEB_ORIGINS: origin }));
  }
  assert.throws(() => applicationOrigins({ MARKIE_WEB_ORIGINS: Array(17).fill("https://example.com").join(",") }));
});
