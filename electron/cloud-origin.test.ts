import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import cloud from "./cloud-origin.json";
import * as renderer from "../src/lib/cloud-origin";

// Markie Cloud's origin is written down once, in cloud-origin.json. The
// places that cannot read it (the sandboxed preload) keep a literal, and
// this holds them to it.
const load = createRequire(import.meta.url);

describe("one Markie Cloud origin", () => {
  it("is api.markiedocs.com, with the Railway host as its only old address", () => {
    expect(cloud.origin).toBe("https://api.markiedocs.com");
    expect(cloud.legacyAliases).toEqual(["https://api-production-602f.up.railway.app"]);
    for (const origin of [cloud.origin, ...cloud.legacyAliases]) expect(new URL(origin).origin).toBe(origin);
  });

  it("is the one main, the private build and the renderer use", () => {
    expect(load("./share-origin.js").DEFAULT_SERVER).toBe(cloud.origin);
    expect(load("./share-origin.js").CLOUD_ALIASES).toEqual(cloud.legacyAliases);
    expect(load("./servers.js").DEFAULT_SERVER).toBe(cloud.origin);
    expect(load("./private-release.js").AUTH_ORIGIN).toBe(cloud.origin);
    expect(renderer.CLOUD_ORIGIN).toBe(cloud.origin);
    expect(renderer.CLOUD_ALIASES).toEqual(cloud.legacyAliases);
  });

  it("is the literal the sandboxed preload hands a private build", () => {
    const preload = readFileSync(new URL("./preload.js", import.meta.url), "utf8");
    const line = preload.split("\n").find((l) => l.includes("privateReleaseAuthOrigin:"));
    expect(line).toContain(`"${cloud.origin}"`);
    for (const alias of cloud.legacyAliases) expect(preload).not.toContain(alias);
  });

  it("is named nowhere else in main, so a move edits one file", () => {
    for (const file of ["main.js", "csp.js", "private-release.js", "servers.js", "sync.js", "share-open.js"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, file).not.toContain(cloud.origin);
      for (const alias of cloud.legacyAliases) expect(source, file).not.toContain(alias);
    }
  });

  it("the renderer and main agree on what an old address means", () => {
    const main = load("./share-origin.js");
    for (const value of [...cloud.legacyAliases, `${cloud.legacyAliases[0]}/`, cloud.origin, "https://docs.example.com", "nope", ""]) {
      expect(renderer.canonicalCloudOrigin(value)).toBe(main.canonicalCloudOrigin(value));
      expect(renderer.isCloudOrigin(value)).toBe(main.isCloudOrigin(value));
    }
  });

  // The server names markiedocs.com in every link it hands out when
  // MARKIE_DOCS_ORIGIN is set (server/src/doc-meta.ts privateLinkOrigin), as
  // it is on Markie Cloud. A link the app copies itself must match it.
  it("names markiedocs.com in Markie Cloud's document links, and a self-hosted server's own origin in its", () => {
    const main = load("./share-origin.js");
    expect(cloud.docsOrigin).toBe("https://markiedocs.com");
    expect(renderer.CLOUD_DOCS_ORIGIN).toBe(cloud.docsOrigin);
    expect(main.CLOUD_DOCS_ORIGIN).toBe(cloud.docsOrigin);
    const cases: Array<[string, string]> = [
      [cloud.origin, "https://markiedocs.com"],
      [`${cloud.origin}/`, "https://markiedocs.com"],
      [cloud.legacyAliases[0], "https://markiedocs.com"],
      ["https://docs.example.com", "https://docs.example.com"],
      ["https://docs.example.com/", "https://docs.example.com"],
      ["http://localhost:3000", "http://localhost:3000"],
    ];
    for (const [server, expected] of cases) {
      expect(renderer.docLinkOrigin(server), server).toBe(expected);
      expect(main.docLinkOrigin(server), server).toBe(expected);
    }
    expect(load("./agent-cloud.js").privateLinkFor(cloud.origin, "abc")).toBe("https://markiedocs.com/d/abc");
    expect(load("./agent-cloud.js").privateLinkFor("https://docs.example.com", "abc")).toBe("https://docs.example.com/d/abc");
  });
});
