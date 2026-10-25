import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mobileCsp } from "../vite.config";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");

describe("the app's content security policy", () => {
  const csp = mobileCsp();

  it("permits exactly the pinned Darkmown interpreter as inline script, which srcdoc frames inherit", () => {
    const runtime = read("../../../src/lib/darkmown/vendor/runtime.js.txt");
    const bootstrap = read("../../../src/lib/darkmown/local-form-bootstrap.js.txt");
    expect(csp).toContain(`script-src 'self' 'sha256-${sha(runtime)}' 'sha256-${sha(bootstrap)}'`);
    expect(csp).not.toMatch(/unsafe-eval|'unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/);
  });

  it("keeps network, plugins and navigation closed", () => {
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src about:");
  });

  it("is injected where index.html asks for it", () => {
    expect(read("../index.html")).toContain("<!-- markie:csp -->");
  });
});
