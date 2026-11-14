// The network a hosted Live Doc may use: `:fetch` to a fixed https origin,
// kept only when the caller asks (server/src/live-docs-child.ts). The Mac
// preview never asks, so it stays offline.
import { describe, expect, it } from "vitest";
import { compileDarkmown } from "./compiler";
import { darkmownFetchOrigin, sanitizeDarkmownBody } from "./security";

const bodyOf = (source: string) => compileDarkmown(source).bodyHtml;

describe("darkmownFetchOrigin", () => {
  it("gives the fixed origin of an https address, interpolated or not", () => {
    expect(darkmownFetchOrigin("https://api.example.com/roster")).toBe("https://api.example.com");
    expect(darkmownFetchOrigin("https://API.Example.com/roster?team={ team }")).toBe("https://api.example.com");
    expect(darkmownFetchOrigin("https://api.example.com/teams/{ team }/roster")).toBe("https://api.example.com");
    expect(darkmownFetchOrigin("https://api.example.com:8443/x")).toBe("https://api.example.com:8443");
    expect(darkmownFetchOrigin("https://api.example.com:443/x")).toBe("https://api.example.com");
    expect(darkmownFetchOrigin("https://api.example.com")).toBe("https://api.example.com");
  });

  it("refuses an address whose host an interpolation can still extend", () => {
    for (const url of [
      "https://api.example.com{ x }", "https://api.example.com{ x }/roster", "https://api.example.com.{ x }/roster",
      "https://api.example.co{ x }/roster", "https://api.example.com:44{ x }/roster", "https://abcdefghijklmnop.markie.liv{ x }/__markie/live",
      "https://api.example.com\u3002evil.com/x", "https://api.example.com{ x }\u3002evil.com/",
    ]) expect(darkmownFetchOrigin(url), url).toBeNull();
    // Interpolation after the host has ended is fine.
    expect(darkmownFetchOrigin("https://api.example.com/{ x }")).toBe("https://api.example.com");
    expect(darkmownFetchOrigin("https://api.example.com?q={ x }")).toBe("https://api.example.com");
    expect(darkmownFetchOrigin("https://api.example.com:8443/{ x }")).toBe("https://api.example.com:8443");
  });

  it("refuses anything whose origin is not fixed, public and https", () => {
    for (const url of [
      "http://api.example.com/x", "/api/x", "./x", "{ base }/x", "https://{ host }/x", "https://api.{ zone }.com/x", "//api.example.com/x",
      "https://192.168.1.1/x", "https://10.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://printer.local/x", "https://nas.lan/x",
      "https://wiki.internal/x", "https://router.home.arpa/x", "https://site.test/x", "https://x.example/x", "https://intranet/x",
      "https://user:pw@api.example.com/x", "https://api.example.com@evil.example.org/x", "https://api.example.com\\@evil.org/x",
      " https://api.example.com/x", "https://api.example.com/x y", "https://api.example.com:0/x", "https://api.example.com:99999/x",
      "javascript:alert(1)", "data:text/plain,x", "", 42, null,
    ]) expect(darkmownFetchOrigin(url), String(url)).toBeNull();
  });
});

describe("sanitizeDarkmownBody with fetch", () => {
  const SOURCE = ':fetch roster from "https://api.example.com/roster"\n\n# Team\n\n@loop roster into person\n- { person.name }\n@endloop\n';

  it("keeps a :fetch to a public https origin and reports the origin", async () => {
    const result = await sanitizeDarkmownBody(bodyOf(SOURCE), true, { fetch: true });
    expect(result.network).toEqual(["https://api.example.com"]);
    expect(result.bodyHtml).toMatch(/<span data-wd-fetch="" data-wd-fetch-key="roster" data-wd-fetch-url="https:\/\/api\.example\.com\/roster"><\/span>/);
  });

  it("drops it, and reports nothing, without the option: the Mac preview stays offline", async () => {
    for (const [trusted, options] of [[true, {}], [false, { fetch: true }], [true, { links: true }]] as const) {
      const result = await sanitizeDarkmownBody(bodyOf(SOURCE), trusted, options);
      expect(result.network).toEqual([]);
      expect(result.bodyHtml).not.toContain("data-wd-fetch");
    }
  });

  it("drops a :fetch whose address may not be hosted, and warns", async () => {
    for (const url of ["http://api.example.com/x", "https://192.168.1.1/x", "https://localhost/x", "/api/x", "{ base }/x"]) {
      const result = await sanitizeDarkmownBody(`<span data-wd-fetch data-wd-fetch-key="x" data-wd-fetch-url="${url}"></span>`, true, { fetch: true });
      expect(result.network, url).toEqual([]);
      expect(result.bodyHtml, url).not.toContain("data-wd-fetch");
      expect(result.warnings, url).toHaveLength(1);
    }
  });

  it("records a token-refresh address too, and refuses a private one", async () => {
    const ok = await sanitizeDarkmownBody('<span data-wd-fetch data-wd-fetch-key="x" data-wd-fetch-url="https://api.example.com/x" data-wd-fetch-headers="auth" data-wd-fetch-refresh="https://auth.example.org/token"></span>', true, { fetch: true });
    expect(ok.network).toEqual(["https://api.example.com", "https://auth.example.org"]);
    const bad = await sanitizeDarkmownBody('<span data-wd-fetch data-wd-fetch-key="x" data-wd-fetch-url="https://api.example.com/x" data-wd-fetch-headers="auth" data-wd-fetch-refresh="https://10.0.0.1/token"></span>', true, { fetch: true });
    expect(bad.network).toEqual([]);
    expect(bad.bodyHtml).not.toContain("data-wd-fetch");
  });

  it("refuses a marker with odd options, extra attributes or a bad state key", async () => {
    for (const extra of ['data-wd-fetch-method="TRACE"', 'data-wd-fetch-when="hover"', 'data-wd-fetch-timeout="1e9"', 'data-wd-fetch-retry="99"',
      'data-wd-fetch-headers="a.b"', 'data-wd-fetch-body="__proto__"', 'data-wd-fetch-deps="a,__proto__"', 'onclick="x()"', 'data-wd-fetch-sneaky="1"', 'style="color:red"']) {
      const result = await sanitizeDarkmownBody(`<span data-wd-fetch data-wd-fetch-key="x" data-wd-fetch-url="https://api.example.com/x" ${extra}></span>`, true, { fetch: true });
      expect(result.network, extra).toEqual([]);
      expect(result.bodyHtml, extra).not.toContain("data-wd-fetch");
    }
    const keyed = await sanitizeDarkmownBody('<span data-wd-fetch data-wd-fetch-key="a.b" data-wd-fetch-url="https://api.example.com/x"></span>', true, { fetch: true });
    expect(keyed.network).toEqual([]);
  });

  it("keeps the allowed options exactly", async () => {
    const result = await sanitizeDarkmownBody('<span data-wd-fetch data-wd-fetch-key="x" data-wd-fetch-url="https://api.example.com/x?q={ q }" data-wd-fetch-method="POST" data-wd-fetch-when="visible" data-wd-fetch-timeout="5000" data-wd-fetch-retry="2" data-wd-fetch-body="draft" data-wd-fetch-deps="q,draft"></span>', true, { fetch: true });
    expect(result.network).toEqual(["https://api.example.com"]);
    for (const piece of ['data-wd-fetch-method="POST"', 'data-wd-fetch-when="visible"', 'data-wd-fetch-timeout="5000"', 'data-wd-fetch-retry="2"', 'data-wd-fetch-body="draft"', 'data-wd-fetch-deps="q,draft"']) {
      expect(result.bodyHtml).toContain(piece);
    }
  });

  it("still keeps forms local: a form that posts somewhere is not network a page gets", async () => {
    const result = await sanitizeDarkmownBody('<form data-wd-form="signup" action="https://api.example.com/signup" method="post"><input name="email"></form>', true, { fetch: true });
    expect(result.network).toEqual([]);
    expect(result.bodyHtml).not.toContain("action=");
  });
});
