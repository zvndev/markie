import { test } from "node:test";
import assert from "node:assert/strict";
import { getIP } from "@better-auth/core/utils/ip";
import { clientIpHeader, cronsEnabled, releaseCommit } from "./runtime-config.ts";

test("clientIpHeader: neither name set keeps better-auth's own x-forwarded-for", () => {
  assert.equal(clientIpHeader({}), "x-forwarded-for");
  assert.equal(clientIpHeader({ MARKIE_CLIENT_IP_HEADER: " ", CLIENT_IP_HEADER: "" }), "x-forwarded-for");
});

test("clientIpHeader: the Fly deployment's MARKIE_CLIENT_IP_HEADER still wins as before", () => {
  assert.equal(clientIpHeader({ MARKIE_CLIENT_IP_HEADER: "fly-client-ip" }), "fly-client-ip");
  assert.equal(clientIpHeader({ MARKIE_CLIENT_IP_HEADER: " Fly-Client-IP " }), "fly-client-ip");
});

test("clientIpHeader: CLIENT_IP_HEADER names the header when Markie's own name is unset", () => {
  assert.equal(clientIpHeader({ CLIENT_IP_HEADER: "CF-Connecting-IP" }), "cf-connecting-ip");
  assert.equal(clientIpHeader({ CLIENT_IP_HEADER: "cf-connecting-ip", MARKIE_CLIENT_IP_HEADER: "CF-Connecting-IP" }), "cf-connecting-ip");
});

test("clientIpHeader: two different headers, or a value that is not a header name, stop the boot", () => {
  assert.throws(() => clientIpHeader({ MARKIE_CLIENT_IP_HEADER: "fly-client-ip", CLIENT_IP_HEADER: "cf-connecting-ip" }), /name different headers/);
  assert.throws(() => clientIpHeader({ CLIENT_IP_HEADER: "cf-connecting-ip, x-forwarded-for" }), /single header name/);
  assert.throws(() => clientIpHeader({ CLIENT_IP_HEADER: "cf connecting ip" }), /single header name/);
});

test("with a named header, a forged X-Forwarded-For is never read in its place", () => {
  const options = { advanced: { ipAddress: { ipAddressHeaders: [clientIpHeader({ CLIENT_IP_HEADER: "cf-connecting-ip" })] } } };
  const previous = process.env.NODE_ENV;
  // better-auth answers 127.0.0.1 for every request in development and test.
  process.env.NODE_ENV = "production";
  try {
    const both = new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" });
    assert.equal(getIP(both, options), "203.0.113.7");
    const forgedOnly = new Headers({ "x-forwarded-for": "198.51.100.1" });
    assert.equal(getIP(forgedOnly, options), null);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("cronsEnabled: on unless ENABLE_CRONS says off", () => {
  assert.equal(cronsEnabled({}), true);
  for (const on of ["true", "TRUE", "1", "yes", "", " "]) assert.equal(cronsEnabled({ ENABLE_CRONS: on }), true, on);
  for (const off of ["false", "False", "0", "no", "off", " off "]) assert.equal(cronsEnabled({ ENABLE_CRONS: off }), false, off);
});

test("releaseCommit: KAMAL_VERSION, then GIT_SHA, and nothing when neither is set", () => {
  assert.equal(releaseCommit({}), undefined);
  assert.equal(releaseCommit({ GIT_SHA: "8c63a7fb6381" }), "8c63a7fb6381");
  assert.equal(releaseCommit({ KAMAL_VERSION: "0123abc", GIT_SHA: "8c63a7fb6381" }), "0123abc");
  assert.equal(releaseCommit({ KAMAL_VERSION: "<script>", GIT_SHA: "" }), undefined);
  assert.equal(releaseCommit({ KAMAL_VERSION: "x".repeat(65) }), undefined);
});
