import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const { extractRefs, resolveRefs, hashFile, fingerprint } =
  require("./doc-assets") as typeof import("./doc-assets");

describe("extractRefs", () => {
  it("finds markdown images and raw media tags, local only, once each, decoded", () => {
    const md = [
      "![a](shots/a.png)",
      "![again](shots/a.png)",
      '![sp](my%20shot.png "title")',
      "![web](https://x.test/c.png)",
      "![data](data:image/png;base64,AAAA)",
      "![proto](//cdn.test/d.png)",
      '<img src="d.png">',
      "<video src='clip.mp4?x=1' controls></video>",
      '<audio><source src="song.mp3#t=1"></audio>',
      "`![code](e.png)`",
      "```\n![f](f.png)\n```",
    ].join("\n\n");
    expect(extractRefs(md)).toEqual(["shots/a.png", "my shot.png", "d.png", "clip.mp4", "song.mp3"]);
  });

  it("reads an angle-bracket destination, which is how a name with a space is written", () => {
    // Valid CommonMark, and the local renderer draws it. Extraction returned
    // no ref at all, so the cloud copy of the document stayed broken.
    expect(extractRefs("![](<my image.png>)")).toEqual(["my image.png"]);
    expect(extractRefs('![a](<shots/my image.png> "title")')).toEqual(["shots/my image.png"]);
    expect(extractRefs("![](<a.png>)")).toEqual(["a.png"]);
    // The bare form is untouched, and an empty destination is still nothing.
    expect(extractRefs("![](a.png)")).toEqual(["a.png"]);
    expect(extractRefs("![](<>)")).toEqual([]);
  });

  it("wants a real src attribute, not one a longer name happens to end with", () => {
    // A lazy-loading attribute names a file the document does not render.
    // Uploading it sent a picture nobody asked to publish.
    expect(extractRefs('<img data-src="secret.png">')).toEqual([]);
    expect(extractRefs('<img poster-src="secret.png">')).toEqual([]);
    expect(extractRefs('<img src="a.png">')).toEqual(["a.png"]);
    expect(extractRefs("<img class=\"x\" src='b.png'>")).toEqual(["b.png"]);
    expect(extractRefs('<video\n  src="clip.mp4"\n></video>')).toEqual(["clip.mp4"]);
  });

  it("returns nothing for a document without media", () => {
    expect(extractRefs("# Title\n\nJust words.\n")).toEqual([]);
  });
});

describe("resolveRefs and hashFile", () => {
  it("keeps what the local viewer would show and names why the rest is skipped", async () => {
    // realpathSync.native, not the raw mkdtempSync path: on macOS /tmp resolves
    // through /var -> /private/var, and resolveMedia compares realpaths.
    const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "markie-doc-assets-")));
    const docDir = path.join(home, "report");
    mkdirSync(path.join(docDir, "shots"), { recursive: true });
    mkdirSync(path.join(home, "private"));
    writeFileSync(path.join(docDir, "shots", "a.png"), "png-bytes");
    writeFileSync(path.join(docDir, "notes.txt"), "text");
    writeFileSync(path.join(home, "private", "secret.png"), "png");
    const docPath = path.join(docDir, "doc.md");
    const out = resolveRefs(["shots/a.png", "notes.txt", "../private/secret.png", "missing.png"], { docPath, roots: [], files: [] });
    expect(out[0]).toEqual({ ref: "shots/a.png", path: path.join(docDir, "shots", "a.png"), mime: "image/png" });
    expect(out[1]).toEqual({ ref: "notes.txt", skipped: "type" });
    expect(out[2]).toEqual({ ref: "../private/secret.png", skipped: "outside" });
    expect(out[3]).toEqual({ ref: "missing.png", skipped: "outside" });
    const { hash, size } = await hashFile(path.join(docDir, "shots", "a.png"));
    expect(hash).toBe(createHash("sha256").update("png-bytes").digest("hex"));
    expect(size).toBe(9);
  });

  it("fingerprint is order-independent and changes with any ref or hash", () => {
    const a = fingerprint([{ ref: "a.png", hash: "1" }, { ref: "b.png", hash: "2" }]);
    const b = fingerprint([{ ref: "b.png", hash: "2" }, { ref: "a.png", hash: "1" }]);
    expect(a).toBe(b);
    expect(fingerprint([{ ref: "a.png", hash: "1" }])).not.toBe(a);
    expect(fingerprint([{ ref: "a.png", hash: "9" }, { ref: "b.png", hash: "2" }])).not.toBe(a);
  });

  it("counts a ref with no hash, so a skipped reference is still part of the set", () => {
    // An editor with no local copy of a picture resolves nothing either way.
    // Without the hashless entry both of these hash the empty set, and
    // removing the reference would never trigger a fresh link.
    expect(fingerprint([{ ref: "gone.png" }])).not.toBe(fingerprint([]));
    expect(fingerprint([{ ref: "gone.png" }])).not.toBe(fingerprint([{ ref: "other.png" }]));
    expect(fingerprint([{ ref: "a.png", hash: "1" }, { ref: "gone.png" }])).not.toBe(
      fingerprint([{ ref: "a.png", hash: "1" }])
    );
    // No hash is the empty hash, not the string "undefined".
    expect(fingerprint([{ ref: "gone.png" }])).toBe(fingerprint([{ ref: "gone.png", hash: "" }]));
  });
});

// A shared document reaches this on the Electron main thread, so the cost of
// reading it is the cost of the whole app being responsive. The bare
// destination group used to have no upper bound, so on text made of repeated
// "![](a" it swallowed the rest of the document, failed to find the closing
// paren and backtracked a character at a time, from every one of the starts:
// 1.8 s at 100 KB, 46 s at 500 KB, hours at a few megabytes, with no IPC, no
// window and no menus for the duration.
describe("extraction cannot be made expensive", () => {
  it("reads a document made entirely of unterminated image openers in well under a second", () => {
    const payload = "![](a".repeat(100_000);
    const started = Date.now();
    const refs = extractRefs(payload);
    const elapsed = Date.now() - started;
    expect(refs).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  it("bounds the same run inside a document that does have real references", () => {
    const payload = `![](real.png)\n${"![](a".repeat(50_000)}\n![](other.png)\n`;
    const started = Date.now();
    expect(extractRefs(payload)).toEqual(["real.png", "other.png"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("takes no reference at all out of a document over 4 MB", () => {
    // Above this the document is not one anybody is reading in Markie: the
    // renderer opens it in Source view at 1 MB and refuses it at 100 MB. A
    // pass that reads it costs the main thread more than its pictures are
    // worth, and a document this size is the shape an attack takes.
    const big = `![](a.png)\n${"x".repeat(4 * 1024 * 1024)}`;
    expect(extractRefs(big)).toEqual([]);
    // Just under, and it reads normally.
    expect(extractRefs(`![](a.png)\n${"x".repeat(1000)}`)).toEqual(["a.png"]);
  });

  it("drops a destination longer than the server would store anyway", () => {
    const long = "n".repeat(2049);
    expect(extractRefs(`![](${long}.png)`)).toEqual([]);
    const atCap = "n".repeat(2044);
    expect(extractRefs(`![](${atCap}.png)`)).toEqual([`${atCap}.png`]);
  });
});
