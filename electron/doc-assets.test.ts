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
