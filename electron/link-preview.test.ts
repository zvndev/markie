import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createLinkPreviews,
  isPrivateAddress,
  parseMeta,
  parseTarget,
} from "./link-preview.js";

// ── What may be asked for ────────────────────────────────────────────────────

describe("addresses a preview will not reach", () => {
  it("refuses loopback, the private ranges, and link local", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "93.184.216.34"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses the IPv6 forms of the same thing", () => {
    for (const ip of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses anything it cannot read as an address, rather than guessing", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });

  it("refuses encoded mapped, multicast, transition and special-purpose addresses", () => {
    for (const ip of ["::ffff:7f00:1", "0:0:0:0:0:ffff:c0a8:1", "ff02::1", "fec0::1", "fe80::1%lo0", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "192.0.0.1", "198.18.0.1", "203.0.113.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
});

describe("URLs a preview will not follow", () => {
  it("takes http and https", () => {
    expect(parseTarget("https://example.com/a")?.href).toBe("https://example.com/a");
    expect(parseTarget("http://example.com/")?.href).toBe("http://example.com/");
  });

  it("refuses every other scheme", () => {
    for (const url of ["file:///etc/passwd", "markie-asset://local/x", "data:text/html,x", "javascript:alert(1)", "ftp://example.com"]) {
      expect(parseTarget(url), url).toBe(null);
    }
  });

  it("refuses names that mean this machine", () => {
    expect(parseTarget("http://localhost:3000/")).toBe(null);
    expect(parseTarget("http://printer.local/")).toBe(null);
  });

  it("refuses a URL carrying credentials, which a redirect would hand on", () => {
    expect(parseTarget("https://user:pass@example.com/")).toBe(null);
  });

  it("refuses likely credential links, oversized inputs and non-web service ports", () => {
    for (const url of ["https://example.com/?token=secret", "https://example.com/?authToken=secret", "https://example.com/?X-Amz-Signature=secret", "https://example.com/?code=secret", "https://example.com/reset-password/secret", "https://example.com/#access_token=secret", "https://example.com:444/", `https://example.com/${"x".repeat(9000)}`]) {
      expect(parseTarget(url), url.slice(0, 80)).toBe(null);
    }
    expect(parseTarget("https://example.com/?v=video#chapter")?.href).toBe("https://example.com/?v=video");
  });
});

// ── Reading somebody else's page ─────────────────────────────────────────────

describe("what a card is made of", () => {
  it("prefers Open Graph, the way every other reader does", () => {
    expect(
      parseMeta(`<html><head>
        <title>Fallback</title>
        <meta property="og:title" content="The real title">
        <meta property="og:description" content="What it is about">
        <meta property="og:site_name" content="Example">
      </head></html>`)
    ).toMatchObject({
      title: "The real title",
      description: "What it is about",
      siteName: "Example",
    });
  });

  it("falls back to the title tag and the plain description", () => {
    expect(
      parseMeta(`<head><title>Just a page</title><meta name="description" content="Some words"></head>`)
    ).toMatchObject({ title: "Just a page", description: "Some words" });
  });

  it("reads attributes in either order and either quote", () => {
    expect(parseMeta(`<head><meta content='Quoted' property=og:title></head>`).title).toBe("Quoted");
  });

  it("decodes the entities a title arrives with", () => {
    expect(parseMeta(`<head><meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;day&quot;"></head>`).title)
      .toBe(`Tom & Jerry's "day"`);
  });

  it("flattens whitespace, because a card is one line", () => {
    expect(parseMeta("<head><meta property=\"og:title\" content=\"A\n  long   title\"></head>").title)
      .toBe("A long title");
  });

  it("truncates rather than letting a page hand over an essay", () => {
    const long = "x".repeat(5000);
    const { description } = parseMeta(`<head><meta property="og:description" content="${long}"></head>`);
    expect(description!.length).toBeLessThanOrEqual(300);
    expect(description!.endsWith("…")).toBe(true);
  });

  it("keeps nothing from the body", () => {
    const meta = parseMeta(`<head><title>Head</title></head><body><meta property="og:title" content="Injected"></body>`);
    expect(meta.title).toBe("Head");
  });

  it("keeps no markup, whatever the page put in the attribute", () => {
    const { title } = parseMeta(`<head><meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;"></head>`);
    // Decoded to text, and text is all the renderer ever receives.
    expect(title).toBe("<script>alert(1)</script>");
    expect(typeof title).toBe("string");
  });

  it("says nothing when the page says nothing", () => {
    expect(parseMeta("<html><body>hi</body></html>")).toMatchObject({ title: null, description: null });
  });
});

// ── Fetching ─────────────────────────────────────────────────────────────────

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "192.168.1.10", family: 4 }];

function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
  });
}

const META = `<meta property="og:title" content="A page"><meta property="og:description" content="About it">`;
const PAGE = `<head>${META}</head>`;
// og:image belongs in the head like everything else; a card built from a page's
// body would be a card built from whatever a page chose to put there.
const pageWithImage = (src: string) => `<head>${META}<meta property="og:image" content="${src}"></head>`;

describe("fetching a preview", () => {
  it("normalizes encoded IP literals before refusing private targets", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://[::ffff:7f00:1]/"]) {
      expect(await previews.get(url)).toBe(null);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks image destinations as strictly as page destinations", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(pageWithImage("http://[::ffff:7f00:1]/private.png")));
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    expect((await previews.get("https://example.com/post"))?.image).toBe(null);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses oversized responses rather than returning truncated cards or images", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE + "x".repeat(512 * 1024)));
    expect(await createLinkPreviews({ fetchImpl, lookup: publicLookup }).get("https://example.com/")).toBe(null);
    const images = vi.fn(async (url: string) => url.endsWith(".png")
      ? new Response(new Uint8Array(512 * 1024 + 1), { headers: { "content-type": "image/png" } })
      : htmlResponse(pageWithImage("/card.png")));
    expect((await createLinkPreviews({ fetchImpl: images as never, lookup: publicLookup }).get("https://example.com/"))?.image).toBe(null);
  });

  it("bounds pending work even if a resolver never answers", async () => {
    const lookup = vi.fn(() => new Promise<never>(() => {}));
    const previews = createLinkPreviews({ lookup: lookup as never, timeoutMs: 15, maxInFlight: 2 });
    const first = previews.get("https://one.example/");
    const second = previews.get("https://two.example/");
    expect(await previews.get("https://three.example/")).toBe(null);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await Promise.all([first, second])).toEqual([null, null]);
  });

  it("bounds distinct simultaneous requests without queuing a hover backlog", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => { await held; return htmlResponse(PAGE); });
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup, maxInFlight: 2 });
    const first = previews.get("https://one.example/");
    const second = previews.get("https://two.example/");
    expect(await previews.get("https://three.example/")).toBe(null);
    release();
    expect((await Promise.all([first, second])).every(Boolean)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("returns the card for an ordinary page", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    expect(await previews.get("https://example.com/post")).toMatchObject({
      title: "A page",
      description: "About it",
      siteName: "example.com",
    });
  });

  it("never touches the network for a hostname that resolves inside the network", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({ fetchImpl, lookup: privateLookup });
    expect(await previews.get("https://intranet.example.com/")).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks every hop, not just the first", async () => {
    // The attack this closes: a public hostname that 302s to something inside
    // the reader's network. redirect: "follow" would never show us the hop.
    const lookup = vi.fn(async (host: string) =>
      host === "example.com"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }]
    );
    const fetchImpl = vi.fn(async () =>
      new Response("", { status: 302, headers: { location: "https://inside.example.org/admin" } })
    );
    const previews = createLinkPreviews({ fetchImpl, lookup: lookup as never });
    expect(await previews.get("https://example.com/go")).toBe(null);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than following a redirect loop forever", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("", { status: 302, headers: { location: "https://example.com/again" } })
    );
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    expect(await previews.get("https://example.com/start")).toBe(null);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("asks once however many times the pointer twitches", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    await Promise.all([
      previews.get("https://example.com/x"),
      previews.get("https://example.com/x"),
      previews.get("https://example.com/x"),
    ]);
    await previews.get("https://example.com/x");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("remembers that a page had nothing, so it is not asked again", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<html><body>nothing</body></html>"));
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    expect(await previews.get("https://example.com/bare")).toBe(null);
    expect(await previews.get("https://example.com/bare")).toBe(null);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("asks again once the answer has gone stale", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({
      fetchImpl,
      lookup: publicLookup,
      now: () => clock,
      ttlMs: 1000,
    });
    await previews.get("https://example.com/x");
    clock = 5000;
    await previews.get("https://example.com/x");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the site is down, rather than throwing at the renderer", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    expect(await previews.get("https://example.com/x")).toBe(null);
  });

  it("ignores a page that is not a page", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })
    );
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    expect(await previews.get("https://example.com/spec.pdf")).toBe(null);
  });

  it("inlines the picture, so the renderer asks nobody for anything", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith(".png")
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : htmlResponse(pageWithImage("/card.png"))
    );
    const previews = createLinkPreviews({ fetchImpl: fetchImpl as never, lookup: publicLookup });
    const card = await previews.get("https://example.com/post");
    expect(card?.image?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("refuses an og:image that is not an image", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith(".svg")
        ? new Response("<svg onload='alert(1)'>", { headers: { "content-type": "image/svg+xml" } })
        : htmlResponse(pageWithImage("/card.svg"))
    );
    const previews = createLinkPreviews({ fetchImpl: fetchImpl as never, lookup: publicLookup });
    const card = await previews.get("https://example.com/post");
    expect(card?.title).toBe("A page");
    expect(card?.image).toBe(null);
  });

  it("still shows the card when the picture cannot be had", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith(".png")
        ? new Response("nope", { status: 404 })
        : htmlResponse(pageWithImage("/card.png"))
    );
    const previews = createLinkPreviews({ fetchImpl: fetchImpl as never, lookup: publicLookup });
    expect((await previews.get("https://example.com/post"))?.title).toBe("A page");
  });

  it("refuses a link it was never going to follow, without asking DNS", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn();
    const previews = createLinkPreviews({ fetchImpl: fetchImpl as never, lookup: lookup as never });
    expect(await previews.get("file:///etc/passwd")).toBe(null);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the door the end-to-end check comes through", () => {
  it("is shut by default, so a loopback link is refused", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup });
    expect(await previews.get("http://127.0.0.1:9999/page")).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("opens only when asked, and only then", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({
      fetchImpl,
      lookup: publicLookup,
      allowPrivate: true,
    });
    expect((await previews.get("http://127.0.0.1:9999/page"))?.title).toBe("A page");
  });

  it("still refuses a scheme that was never about addresses", async () => {
    const fetchImpl = vi.fn();
    const previews = createLinkPreviews({
      fetchImpl: fetchImpl as never,
      lookup: publicLookup,
      allowPrivate: true,
    });
    expect(await previews.get("file:///etc/passwd")).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the pinned main-process transport", () => {
  it("contains unusual server statuses and synchronous transport failures", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(700);
      response.end("not a normal response");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      expect(await createLinkPreviews({ allowPrivate: true }).get(`http://127.0.0.1:${port}/`)).toBe(null);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const requestImpl = () => { throw new Error("setup failed"); };
    expect(await createLinkPreviews({ requestImpl, lookup: publicLookup }).get("https://example.com/")).toBe(null);
  });

  it("rejects mixed public/private DNS answers without opening a socket", async () => {
    const requestImpl = vi.fn();
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }, { address: "::ffff:7f00:1", family: 6 }];
    expect(await createLinkPreviews({ requestImpl: requestImpl as never, lookup }).get("https://example.com/")).toBe(null);
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it("cancels an indefinitely streaming response within the total request deadline", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<head>");
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      expect(await createLinkPreviews({ allowPrivate: true, timeoutMs: 30 }).get(`http://127.0.0.1:${port}/`)).toBe(null);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses the validated DNS result without a second lookup, preserving TLS and host identity", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const requests: Array<{ url: URL; options: Record<string, unknown> }> = [];
    const requestImpl = (url: URL, options: Record<string, unknown>, callback: (response: unknown) => void) => {
      requests.push({ url, options });
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () => {
        const pinned = options.lookup as (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void;
        pinned(url.hostname, { all: true }, (error, addresses) => {
          expect(error).toBe(null);
          expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
          const response = Object.assign(Readable.from([Buffer.from(PAGE)]), {
            statusCode: 200,
            headers: { "content-type": "text/html", "set-cookie": "private=not-forwarded" },
          });
          callback(response);
        });
      };
      return request;
    };
    const previews = createLinkPreviews({ lookup: lookup as never, requestImpl: requestImpl as never });
    expect((await previews.get("https://example.com/post"))?.title).toBe("A page");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(requests[0].url.hostname).toBe("example.com");
    expect(requests[0].options).not.toHaveProperty("rejectUnauthorized", false);
    expect(requests[0].options).not.toHaveProperty("checkServerIdentity");
    expect(requests[0].options.headers).toEqual({ "user-agent": expect.any(String), accept: "text/html,application/xhtml+xml", "accept-encoding": "identity" });
    expect(requests[0].options.agent).toMatchObject({ options: { proxyEnv: {}, keepAlive: false } });
  });

  it("uses the real Node request path against the explicit test-only loopback fixture", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((request, response) => {
      seen.push(request.headers);
      response.setHeader("content-type", "text/html");
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const target = `http://127.0.0.1:${port}/fixture`;
      expect(await createLinkPreviews().get(target)).toBe(null);
      expect(seen).toHaveLength(0);
      expect((await createLinkPreviews({ allowPrivate: true }).get(target))?.title).toBe("A page");
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty("cookie");
      expect(seen[0]).not.toHaveProperty("authorization");
      expect(seen[0]).not.toHaveProperty("referer");
      const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
      expect((await createLinkPreviews({ allowPrivate: true, lookup }).get(`http://fixture.example:${port}/fixture`))?.title).toBe("A page");
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(seen[1].host).toBe(`fixture.example:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not forward Set-Cookie or credentials across a redirect", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/first")
      ? new Response(null, { status: 302, headers: { location: "https://other.example/last", "set-cookie": "session=private" } })
      : htmlResponse(PAGE));
    expect((await createLinkPreviews({ fetchImpl: fetchImpl as never, lookup: publicLookup }).get("https://example.com/first"))?.title).toBe("A page");
    for (const [, options] of fetchImpl.mock.calls as unknown as Array<[string, { headers: Record<string, string> }]>) {
      expect(options.headers).not.toHaveProperty("cookie");
      expect(options.headers).not.toHaveProperty("authorization");
      expect(options.headers).not.toHaveProperty("referer");
    }
  });

  it("disposes a streaming redirect body before following the next hop", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((request, response) => {
      if (request.url === "/first") {
        response.writeHead(302, { location: "/last", "set-cookie": "session=private" });
        response.write("a redirect body that does not end");
      } else {
        expect(request.headers.cookie).toBeUndefined();
        response.writeHead(200, { "content-type": "text/html" });
        response.end(PAGE);
      }
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      expect((await createLinkPreviews({ allowPrivate: true, timeoutMs: 500 }).get(`http://127.0.0.1:${port}/first`))?.title).toBe("A page");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses compressed responses instead of unbounded decompression", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE, { headers: { "content-encoding": "gzip" } }));
    expect(await createLinkPreviews({ fetchImpl, lookup: publicLookup }).get("https://example.com/")).toBe(null);
  });

  it("keeps the in-memory cache within a byte budget", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PAGE));
    const previews = createLinkPreviews({ fetchImpl, lookup: publicLookup, maxCacheBytes: 240 });
    await previews.get("https://one.example/");
    await previews.get("https://two.example/");
    await previews.get("https://one.example/");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
