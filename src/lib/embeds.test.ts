import { describe, expect, it } from "vitest";
import {
  EMBED_FRAME_ORIGINS,
  embedFrameUrl,
  embedLabel,
  embedThumbnailUrl,
  parseEmbed,
} from "@/lib/embeds";

// The same examples the server suite pins (server/src/embeds.test.ts), so the
// two copies of the module cannot drift apart without one of them failing.
describe("parseEmbed", () => {
  it("recognises every way a YouTube link is written", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "http://youtu.be/dQw4w9WgXcQ",
    ]) {
      expect(parseEmbed(url), url).toEqual(
        expect.objectContaining({ provider: "youtube", id: "dQw4w9WgXcQ", url })
      );
    }
  });

  it("keeps the address exactly as written, since that is what the file holds", () => {
    const url = "  https://youtu.be/dQw4w9WgXcQ?t=90  ";
    expect(parseEmbed(url)?.url).toBe("https://youtu.be/dQw4w9WgXcQ?t=90");
  });

  it("reads a start time in the forms YouTube writes", () => {
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=90")?.start).toBe(90);
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=90s")?.start).toBe(90);
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=1m30s")?.start).toBe(90);
    expect(parseEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s")?.start).toBe(3723);
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ")?.start).toBeNull();
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=abc")?.start).toBeNull();
  });

  it("recognises a Vimeo video", () => {
    for (const url of [
      "https://vimeo.com/148751763",
      "https://www.vimeo.com/148751763/",
      "https://player.vimeo.com/video/148751763",
    ]) {
      expect(parseEmbed(url), url).toEqual(
        expect.objectContaining({ provider: "vimeo", id: "148751763" })
      );
    }
  });

  it("is a link and nothing more for everything else", () => {
    for (const url of [
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/",
      "https://www.youtube.com/channel/UC123",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ<script>",
      "https://vimeo.com/about",
      "https://vimeo.com/12",
      "ftp://youtu.be/dQw4w9WgXcQ",
      "youtu.be/dQw4w9WgXcQ",
      "",
      null,
      undefined,
    ]) {
      expect(parseEmbed(url), String(url)).toBeNull();
    }
  });

  it("does not take a look-alike host", () => {
    expect(parseEmbed("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseEmbed("https://notyoutu.be/dQw4w9WgXcQ")).toBeNull();
  });
});

describe("what a card is made of", () => {
  const yt = parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=90")!;
  const vimeo = parseEmbed("https://vimeo.com/148751763")!;

  it("opens the player on the cookie-free host, at the start time", () => {
    expect(embedFrameUrl(yt)).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=90"
    );
    expect(embedFrameUrl(parseEmbed("https://youtu.be/dQw4w9WgXcQ")!)).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"
    );
    expect(embedFrameUrl(vimeo)).toBe("https://player.vimeo.com/video/148751763?autoplay=1");
  });

  it("knows where a picture can be had without asking, and where it cannot", () => {
    expect(embedThumbnailUrl(yt)).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(embedThumbnailUrl(vimeo)).toBeNull();
  });

  it("names the provider for the card", () => {
    expect(embedLabel(yt)).toBe("YouTube");
    expect(embedLabel(vimeo)).toBe("Vimeo");
  });

  it("lists every player origin, for the CSP to allow and nothing else", () => {
    expect([...EMBED_FRAME_ORIGINS].sort()).toEqual([
      "https://player.vimeo.com",
      "https://www.youtube-nocookie.com",
    ]);
    for (const embed of [yt, vimeo]) {
      expect(EMBED_FRAME_ORIGINS).toContain(new URL(embedFrameUrl(embed)).origin);
    }
  });
});
