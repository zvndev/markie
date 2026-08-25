import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import realFs from "node:fs";
import realOs from "node:os";
import path from "node:path";

const load = createRequire(import.meta.url);
const { inlineLocalImages } = load("./inline-images.js") as {
  inlineLocalImages: (
    html: string,
    docDir: string,
    opts?: {
      fs?: typeof realFs;
      realpath?: (p: string) => string;
      maxImageBytes?: number;
      maxTotalBytes?: number;
    }
  ) => string;
};

// A 1x1 PNG, so the assertions can check a real base64 payload rather than a
// string the test itself invented.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let docDir: string;
let outsideDir: string;

beforeEach(() => {
  const root = realFs.mkdtempSync(path.join(realOs.tmpdir(), "markie-inline-"));
  docDir = path.join(root, "doc");
  outsideDir = path.join(root, "outside");
  realFs.mkdirSync(docDir);
  realFs.mkdirSync(outsideDir);
});

afterEach(() => {
  try {
    realFs.rmSync(path.dirname(docDir), { recursive: true, force: true });
  } catch {
    // the temp dir is the OS's problem after this
  }
});

function writeImage(rel: string, bytes: Buffer = PNG, dir = docDir) {
  const target = path.join(dir, rel);
  realFs.mkdirSync(path.dirname(target), { recursive: true });
  realFs.writeFileSync(target, bytes);
  return target;
}

describe("inlineLocalImages", () => {
  it("inlines a relative image next to the document", () => {
    writeImage("shot.png");
    const out = inlineLocalImages(`<p><img src="shot.png" alt="a"></p>`, docDir);
    expect(out).toContain(`src="data:image/png;base64,${PNG.toString("base64")}"`);
    expect(out).toContain(`alt="a"`);
  });

  it("inlines images from a subdirectory", () => {
    writeImage("assets/deep/shot.png");
    const out = inlineLocalImages(`<img src="assets/deep/shot.png">`, docDir);
    expect(out).toContain("data:image/png;base64,");
  });

  it("accepts a file:// URL inside the folder and decodes percent escapes", () => {
    const abs = writeImage("my shot.png");
    const url = `file://${abs.split(path.sep).map(encodeURIComponent).join("/")}`;
    const out = inlineLocalImages(`<img src="${url}">`, docDir);
    expect(out).toContain("data:image/png;base64,");
  });

  it("ignores the query and hash on a local src", () => {
    writeImage("shot.png");
    const out = inlineLocalImages(`<img src="shot.png?v=2#top">`, docDir);
    expect(out).toContain("data:image/png;base64,");
  });

  it("gives each format its own MIME type", () => {
    writeImage("a.jpg");
    writeImage("b.jpeg");
    writeImage("c.gif");
    writeImage("d.webp");
    writeImage("e.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    const out = inlineLocalImages(
      `<img src="a.jpg"><img src="b.jpeg"><img src="c.gif"><img src="d.webp"><img src="e.svg">`,
      docDir
    );
    expect(out).toContain("data:image/jpeg;base64,");
    expect((out.match(/data:image\/jpeg/g) ?? []).length).toBe(2);
    expect(out).toContain("data:image/gif;base64,");
    expect(out).toContain("data:image/webp;base64,");
    expect(out).toContain("data:image/svg+xml;base64,");
  });

  it("leaves an unsupported extension alone", () => {
    writeImage("notes.txt");
    const html = `<img src="notes.txt">`;
    expect(inlineLocalImages(html, docDir)).toBe(html);
  });

  describe("containment", () => {
    it("refuses a .. traversal out of the document folder", () => {
      writeImage("secret.png", PNG, outsideDir);
      const html = `<img src="../outside/secret.png">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("refuses an absolute path outside the folder", () => {
      const abs = writeImage("secret.png", PNG, outsideDir);
      const html = `<img src="${abs}">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("refuses a file:// URL outside the folder", () => {
      const abs = writeImage("secret.png", PNG, outsideDir);
      const html = `<img src="file://${abs}">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("refuses a symlink inside the folder that points outside it", () => {
      const abs = writeImage("secret.png", PNG, outsideDir);
      realFs.symlinkSync(abs, path.join(docDir, "link.png"));
      const html = `<img src="link.png">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("still inlines through a symlink that stays inside the folder", () => {
      writeImage("assets/shot.png");
      realFs.symlinkSync(path.join(docDir, "assets", "shot.png"), path.join(docDir, "link.png"));
      const out = inlineLocalImages(`<img src="link.png">`, docDir);
      expect(out).toContain("data:image/png;base64,");
    });
  });

  describe("caps", () => {
    it("leaves an image over the per-image cap untouched", () => {
      writeImage("big.png", Buffer.alloc(64, 1));
      writeImage("small.png", Buffer.alloc(8, 2));
      const out = inlineLocalImages(
        `<img src="big.png"><img src="small.png">`,
        docDir,
        { maxImageBytes: 32 }
      );
      expect(out).toContain(`src="big.png"`);
      expect(out).toContain("data:image/png;base64,");
    });

    it("stops inlining once the running total is spent, without failing", () => {
      writeImage("one.png", Buffer.alloc(40, 1));
      writeImage("two.png", Buffer.alloc(40, 2));
      const out = inlineLocalImages(`<img src="one.png"><img src="two.png">`, docDir, {
        maxTotalBytes: 60,
      });
      expect((out.match(/data:image\/png/g) ?? []).length).toBe(1);
      expect(out).toContain(`src="two.png"`);
    });

    it("applies the 10 MB per-image default when no cap is passed", () => {
      // One byte over the documented default, with no opts: the image must be
      // left alone. This exercises the default path rather than restating the
      // constant.
      writeImage("big.png", Buffer.alloc(10 * 1024 * 1024 + 1, 7));
      writeImage("small.png");
      const out = inlineLocalImages(`<img src="big.png"><img src="small.png">`, docDir);
      expect(out).toContain(`src="big.png"`);
      expect(out).toContain("data:image/png");
    });
  });

  describe("srcs it must not touch", () => {
    it("leaves http(s) URLs alone", () => {
      const html = `<img src="https://example.com/a.png"><img src="http://example.com/b.png">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("leaves data: and protocol-relative URLs alone", () => {
      const html = `<img src="data:image/png;base64,AAAA"><img src="//cdn.example.com/a.png">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("leaves a malformed or empty src alone", () => {
      const html = `<img src=""><img src><img><img src=shot.png>`;
      writeImage("shot.png");
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("leaves a missing file alone", () => {
      const html = `<img src="gone.png">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });

    it("leaves an unreadable file alone instead of throwing", () => {
      writeImage("shot.png");
      const html = `<img src="shot.png">`;
      const out = inlineLocalImages(html, docDir, {
        fs: {
          realpathSync: realFs.realpathSync,
          readFileSync: () => {
            throw new Error("EACCES");
          },
        } as unknown as typeof realFs,
      });
      expect(out).toBe(html);
    });

    it("leaves non-img tags alone", () => {
      writeImage("shot.png");
      const html = `<a href="shot.png">link</a><image src="shot.png">`;
      expect(inlineLocalImages(html, docDir)).toBe(html);
    });
  });

  it("returns the html untouched when there is no document folder", () => {
    const html = `<img src="shot.png">`;
    expect(inlineLocalImages(html, "")).toBe(html);
    expect(inlineLocalImages(html, path.join(docDir, "does-not-exist"))).toBe(html);
  });

  it("survives null html", () => {
    expect(inlineLocalImages(null as unknown as string, docDir)).toBe("");
  });

  it("uses an injected realpath", () => {
    writeImage("shot.png");
    const seen: string[] = [];
    const out = inlineLocalImages(`<img src="shot.png">`, docDir, {
      realpath: (p: string) => {
        seen.push(p);
        return realFs.realpathSync(p);
      },
    });
    expect(out).toContain("data:image/png;base64,");
    expect(seen.length).toBeGreaterThan(1);
  });
});
