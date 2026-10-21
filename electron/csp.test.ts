import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMBED_FRAME_ORIGINS,
  DARKMOWN_RUNTIME_HASH,
  DARKMOWN_BOOTSTRAP_HASH,
  buildAppCsp,
  collectInlineScriptHashes,
  inlineScriptHashesForHtml,
  scriptSrcDirective,
  withConnectOrigins,
} from "./csp.js";
import { EMBED_FRAME_ORIGINS as PROVIDER_FRAME_ORIGINS } from "../src/lib/embeds";

const hash = (script: string) =>
  `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

describe("packaged app CSP", () => {
  it("hashes only inline scripts and ignores bundled script files", () => {
    const html = [
      '<script src="/_next/static/chunks/app.js" async=""></script>',
      "<script>self.__next_f=self.__next_f||[]</script>",
      "<script>self.__next_f.push([1,\"payload\"])</script>",
    ].join("");

    expect(inlineScriptHashesForHtml(html)).toEqual([
      hash("self.__next_f=self.__next_f||[]"),
      hash('self.__next_f.push([1,"payload"])'),
    ]);
  });

  it("collects unique inline script hashes across built html files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "markie-csp-"));
    mkdirSync(path.join(root, "_not-found"));
    writeFileSync(path.join(root, "index.html"), "<script>boot()</script><script>boot()</script>");
    writeFileSync(path.join(root, "_not-found", "index.html"), "<script>notFound()</script>");

    expect(collectInlineScriptHashes(root)).toEqual([hash("boot()"), hash("notFound()")].sort());
  });

  it("builds a script policy without broad inline-script allowance", () => {
    const csp = buildAppCsp("missing-out-dir");

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("frames only sandboxed srcdoc previews and the supported video players", () => {
    const csp = buildAppCsp("missing-out-dir");
    const frame = csp.split("; ").find((d) => d.startsWith("frame-src "));
    expect(frame).toBeDefined();
    const allowed = frame!.replace("frame-src ", "").split(" ").sort();
    // The provider list is what decides which players exist; the policy
    // has to say the same thing or a card opens to a blank rectangle.
    expect(allowed).toEqual(["about:", ...PROVIDER_FRAME_ORIGINS].sort());
    expect(allowed).toEqual(["about:", ...EMBED_FRAME_ORIGINS].sort());
    expect(csp).not.toContain("frame-src *");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("includes collected script hashes in script-src", () => {
    expect(scriptSrcDirective([hash("boot()")])).toBe(`script-src 'self' ${hash("boot()")}`);
  });

  it("renders local DOCX image blobs without allowing executable blob content", () => {
    const directives = buildAppCsp("missing-out-dir").split("; ");
    expect(directives.find((value) => value.startsWith("img-src "))).toBe("img-src 'self' data: blob: https: markie-asset:");
    expect(directives.find((value) => value.startsWith("script-src "))).toBe(`script-src 'self' ${DARKMOWN_RUNTIME_HASH} ${DARKMOWN_BOOTSTRAP_HASH}`);
    expect(directives.find((value) => value.startsWith("object-src "))).toBe("object-src 'none'");
    expect(directives.find((value) => value.startsWith("frame-src "))).not.toContain("blob:");
  });
});

describe("connect-src for trusted servers", () => {
  const base = buildAppCsp("missing-out-dir");
  const connect = (csp: string) => csp.split("; ").find((d) => d.startsWith("connect-src "))!;

  it("adds each trusted server as https and wss, once", () => {
    const csp = withConnectOrigins(base, [
      "https://api.markiedocs.com",
      "https://api-production-602f.up.railway.app",
      "https://docs.example.com",
      "https://docs.example.com",
    ]);
    expect(connect(csp)).toBe(
      "connect-src 'self' https://api.markiedocs.com wss://api.markiedocs.com https://api-production-602f.up.railway.app wss://api-production-602f.up.railway.app https://docs.example.com wss://docs.example.com"
    );
    // Nothing else in the policy moves.
    expect(csp.split("; ").filter((d) => !d.startsWith("connect-src "))).toEqual(
      base.split("; ").filter((d) => !d.startsWith("connect-src "))
    );
  });

  it("lets the app reach Markie Cloud at its new address and its old one, over https and wss", () => {
    expect(connect(base)).toBe(
      "connect-src 'self' https://api.markiedocs.com wss://api.markiedocs.com https://api-production-602f.up.railway.app wss://api-production-602f.up.railway.app"
    );
  });

  it("never writes anything but a plain https origin into the policy", () => {
    const csp = withConnectOrigins(base, [
      "http://docs.example.com",
      "https://docs.example.com; script-src *",
      "https://docs.example.com/path",
      "https://*",
      42 as unknown as string,
    ]);
    expect(csp).toBe(base);
  });
});
