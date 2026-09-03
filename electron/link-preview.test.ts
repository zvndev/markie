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
