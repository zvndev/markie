import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBED_FRAME_ORIGINS,
  embedFrameUrl,
  embedThumbnailUrl,
  parseEmbed,
} from "./embeds.ts";

// The same examples src/lib/embeds.test.ts pins: this file is a copy of the
// app's, and the two suites are what keep the copies from drifting.
test("parseEmbed recognises every way a YouTube link is written", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ]) {
    const embed = parseEmbed(url);
    assert.equal(embed?.provider, "youtube", url);
    assert.equal(embed?.id, "dQw4w9WgXcQ", url);
    assert.equal(embed?.url, url);
  }
});

test("parseEmbed reads a start time and a Vimeo id", () => {
  assert.equal(parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=1m30s")?.start, 90);
  assert.equal(parseEmbed("https://vimeo.com/148751763")?.provider, "vimeo");
  assert.equal(parseEmbed("https://player.vimeo.com/video/148751763")?.id, "148751763");
});

test("parseEmbed is null for everything that is just a link", () => {
  for (const url of [
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/channel/UC123",
    "https://www.youtube.com/watch?v=short",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/about",
    "youtu.be/dQw4w9WgXcQ",
    "",
  ]) {
    assert.equal(parseEmbed(url), null, url);
  }
});

test("the player and the thumbnail come from the origins the CSP names", () => {
  const yt = parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=90")!;
  assert.equal(embedFrameUrl(yt), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=90");
  assert.equal(embedThumbnailUrl(yt), "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  const vimeo = parseEmbed("https://vimeo.com/148751763")!;
  assert.equal(embedFrameUrl(vimeo), "https://player.vimeo.com/video/148751763?autoplay=1");
  assert.equal(embedThumbnailUrl(vimeo), null);
  assert.deepEqual([...EMBED_FRAME_ORIGINS].sort(), ["https://player.vimeo.com", "https://www.youtube-nocookie.com"]);
});
