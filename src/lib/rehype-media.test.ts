import { describe, expect, it } from "vitest";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { mediaTagFor } from "@/lib/rehype-media";

describe("media in a document", () => {
  it("plays a video written with the image syntax", () => {
    // Markdown has one embed syntax. Requiring a Markie-only directive would
    // mean the file stops being plain markdown the moment it holds a clip.
    const html = renderMarkdownHTML("![clip](demo/clip.mp4)");
    expect(html).toContain('<video src="demo/clip.mp4"');
    expect(html).toContain("controls");
    expect(html).not.toContain("<img");
  });

  it("plays audio the same way", () => {
    expect(renderMarkdownHTML("![t](sound/track.mp3)")).toContain("<audio ");
  });

  it("leaves a picture a picture", () => {
    expect(renderMarkdownHTML("![p](shot.png)")).toContain("<img ");
  });

  it("does not preload whole files before a word has been read", () => {
    expect(renderMarkdownHTML("![c](a.mp4)")).toContain('preload="metadata"');
  });

  it("recognises the formats a browser can actually play, and no others", () => {
    for (const src of ["a.mp4", "a.m4v", "a.webm", "a.ogv", "a.mov", "A.MP4"]) {
      expect(mediaTagFor(src)).toBe("video");
    }
    for (const src of ["a.mp3", "a.m4a", "a.aac", "a.wav", "a.flac", "a.oga", "a.opus"]) {
      expect(mediaTagFor(src)).toBe("audio");
    }
    // .mkv and .avi are containers Chromium will not open, and a player that
    // renders a black rectangle is worse than a broken image.
    for (const src of ["a.png", "a.mkv", "a.avi", "a.pdf", "a", ""]) {
      expect(mediaTagFor(src)).toBeNull();
    }
  });

  it("reads the src as a URL, so a query or hash does not hide the extension", () => {
    expect(mediaTagFor("clip.mp4?v=2")).toBe("video");
    expect(mediaTagFor("clip.mp4#t=10")).toBe("video");
  });

  it("keeps a media source out of the sanitizer's way only when it is safe", () => {
    // The tag is new; the protocol rules are not relaxed for it.
    expect(renderMarkdownHTML("![x](javascript:alert(1))")).not.toContain("javascript:");
  });
});
