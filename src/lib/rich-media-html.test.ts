import { describe, expect, it } from "vitest";
import {
  escapeAttr,
  isLoneMediaTag,
  normalizeWidth,
  sizedMediaHtml,
} from "@/lib/rich-media-html";

describe("sizedMediaHtml", () => {
  it("writes a resized picture as the img tag every renderer accepts", () => {
    expect(sizedMediaHtml({ src: "demo/shot.png", alt: "beside", width: 300 }, "image")).toBe(
      '<img src="demo/shot.png" alt="beside" width="300">'
    );
  });

  it("leaves a picture nobody resized to the markdown syntax", () => {
    // Null means "write ![alt](src)": a document that uses none of this must
    // not change because the feature exists.
    expect(sizedMediaHtml({ src: "a.png", alt: "a", width: null }, "image")).toBeNull();
    expect(sizedMediaHtml({ src: "a.png", alt: "a" }, "image")).toBeNull();
    expect(sizedMediaHtml({ src: "a.png", alt: "a", width: 0 }, "image")).toBeNull();
    expect(sizedMediaHtml({ src: "", width: 300 }, "image")).toBeNull();
  });

  it("writes a resized clip as a video tag with controls", () => {
    expect(sizedMediaHtml({ src: "demo/clip.mp4", alt: "clip", width: 320 }, "video")).toBe(
      '<video src="demo/clip.mp4" width="320" controls></video>'
    );
  });

  it("never sizes audio, which has no width to keep", () => {
    expect(sizedMediaHtml({ src: "take.m4a", width: 320 }, "audio")).toBeNull();
  });

  it("keeps the title and drops an empty alt", () => {
    expect(sizedMediaHtml({ src: "a.png", alt: "", title: "T", width: 12 }, "image")).toBe(
      '<img src="a.png" title="T" width="12">'
    );
  });

  it("takes a width that arrived as a string and rounds off nothing", () => {
    expect(sizedMediaHtml({ src: "a.png", width: "240" }, "image")).toBe(
      '<img src="a.png" width="240">'
    );
    expect(normalizeWidth("240px")).toBe(240);
    expect(normalizeWidth("50%")).toBeNull();
    expect(normalizeWidth("abc")).toBeNull();
    expect(normalizeWidth(12.7)).toBeNull();
    expect(normalizeWidth(-4)).toBeNull();
  });

  it("escapes what could end the attribute or the tag", () => {
    expect(escapeAttr('a "b" & <c>')).toBe("a &quot;b&quot; &amp; &lt;c&gt;");
    expect(sizedMediaHtml({ src: 'x"y.png', alt: "a & b", width: 5 }, "image")).toBe(
      '<img src="x&quot;y.png" alt="a &amp; b" width="5">'
    );
  });
});

describe("isLoneMediaTag", () => {
  it("recognises one media tag alone on its line", () => {
    for (const line of [
      '<img src="a.png" width="300">',
      "<img src=a.png width=300>",
      '<img src="a.png" alt="x" />',
      '   <img src="a.png">',
      '<video src="clip.mp4" width="320" controls></video>',
      '<audio src="take.m4a" controls></audio>',
      '<IMG SRC="A.PNG">\n',
    ]) {
      expect(isLoneMediaTag(line), line).toBe(true);
    }
  });

  it("leaves everything wider than that to the raw HTML path", () => {
    for (const line of [
      '<div><img src="a.png"></div>',
      '<img src="a.png"> and some words',
      '<img src="a.png"><img src="b.png">',
      "<imgs>",
      "<!-- <img src=a.png> -->",
      "<p>",
      '<img src="a.png" onerror="alert(1)">x',
      "plain text",
    ]) {
      expect(isLoneMediaTag(line), line).toBe(false);
    }
  });
});
