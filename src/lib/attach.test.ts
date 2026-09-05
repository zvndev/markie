import { describe, expect, it } from "vitest";
import {
  attachmentContent,
  attachmentFor,
  basenameOf,
  hrefFor,
  localAssetCount,
  opensAsDocument,
} from "./attach";

describe("attachment paths", () => {
  it("writes a relative link for a file beside the document", () => {
    expect(hrefFor("/Users/k/notes/shot.png", "/Users/k/notes")).toBe("shot.png");
  });

  it("keeps the folders for a file nested under the document", () => {
    expect(hrefFor("/Users/k/notes/img/shot.png", "/Users/k/notes")).toBe("img/shot.png");
  });

  it("writes the absolute path for a file that lives somewhere else", () => {
    // Kirby: "If a local file, then just make sure it's linked even if the file
    // moves outside." A link that points at the real file beats a tidy one.
    expect(hrefFor("/Users/k/Desktop/shot.png", "/Users/k/notes")).toBe(
      "/Users/k/Desktop/shot.png"
    );
  });

  it("does not mistake a sibling folder with a shared prefix for a parent", () => {
    expect(hrefFor("/Users/k/notes-old/shot.png", "/Users/k/notes")).toBe(
      "/Users/k/notes-old/shot.png"
    );
  });

  it("writes the absolute path when the document has never been saved", () => {
    expect(hrefFor("/Users/k/Desktop/shot.png", null)).toBe("/Users/k/Desktop/shot.png");
  });

  it("uses forward slashes and ignores case on Windows", () => {
    expect(hrefFor("C:\\Users\\K\\Notes\\shot.png", "c:\\users\\k\\notes")).toBe("shot.png");
  });

  it("does not fold case on POSIX, where two such folders are two folders", () => {
    expect(hrefFor("/Users/k/Notes/shot.png", "/Users/k/notes")).toBe("/Users/k/Notes/shot.png");
  });

  it("reads a basename from either separator", () => {
    expect(basenameOf("/a/b/c.png")).toBe("c.png");
    expect(basenameOf("C:\\a\\b\\c.png")).toBe("c.png");
  });
});

describe("what an attachment becomes", () => {
  it("embeds a picture, alt text and all", () => {
    expect(attachmentFor("/Users/k/notes/diagram.png", "/Users/k/notes")).toEqual({
      kind: "image",
      href: "diagram.png",
      label: "diagram",
    });
  });

  it("embeds a gif as a picture, because that is what it is", () => {
    expect(attachmentFor("/Users/k/notes/loop.gif", "/Users/k/notes").kind).toBe("image");
  });

  it("embeds a clip", () => {
    expect(attachmentFor("/Users/k/notes/demo.mp4", "/Users/k/notes").kind).toBe("video");
  });

  it("embeds audio", () => {
    expect(attachmentFor("/Users/k/notes/take.m4a", "/Users/k/notes").kind).toBe("audio");
  });

  it("links anything it cannot draw, keeping the extension in the words", () => {
    // "bundle.zip" reads as a file. "bundle" reads as a broken image.
    expect(attachmentFor("/Users/k/notes/bundle.zip", "/Users/k/notes")).toEqual({
      kind: "file",
      href: "bundle.zip",
      label: "bundle.zip",
    });
  });

  it("links a PDF rather than pretending to embed it", () => {
    expect(attachmentFor("/Users/k/notes/spec.pdf", "/Users/k/notes").kind).toBe("file");
  });

  it("makes media the image node, so the file stays plain markdown", () => {
    expect(attachmentContent(attachmentFor("/n/demo.mp4", "/n"))).toEqual([
      { type: "image", attrs: { src: "demo.mp4", alt: "demo" } },
    ]);
  });

  it("makes a file a link, and leaves the caret outside it", () => {
    expect(attachmentContent(attachmentFor("/n/spec.pdf", "/n"))).toEqual([
      {
        type: "text",
        text: "spec.pdf",
        marks: [{ type: "link", attrs: { href: "spec.pdf" } }],
      },
      { type: "text", text: " " },
    ]);
  });
});

describe("what still opens instead of attaching", () => {
  it("keeps dropping a markdown file meaning open it", () => {
    // Muscle memory: dropping a .md anywhere in Markie has always opened it.
    // Attachments are additive, so they must not take that over.
    expect(opensAsDocument("notes.md")).toBe(true);
    expect(opensAsDocument("data.csv")).toBe(true);
    expect(opensAsDocument("README.MARKDOWN")).toBe(true);
  });

  it("treats everything else as an attachment", () => {
    expect(opensAsDocument("shot.png")).toBe(false);
    expect(opensAsDocument("spec.pdf")).toBe(false);
    expect(opensAsDocument("demo.mp4")).toBe(false);
  });
});

describe("what would not travel with a shared document", () => {
  const count = (md: string) => localAssetCount(md);

  it("counts a picture that lives beside the document", () => {
    expect(count("![a](shot.png)")).toBe(1);
  });

  it("counts a linked file", () => {
    expect(count("[the spec](spec.pdf)")).toBe(1);
  });

  it("counts a path written in angle brackets", () => {
    expect(count("![a](<my holiday.png>)")).toBe(1);
  });

  it("counts an absolute path", () => {
    expect(count("![a](/Users/k/Desktop/shot.png)")).toBe(1);
  });

  it("ignores a URL, which travels fine", () => {
    expect(count("![a](https://example.com/shot.png)")).toBe(0);
  });

  it("ignores an inlined picture, which is carried in the text itself", () => {
    expect(count("![a](data:image/png;base64,AAAA)")).toBe(0);
  });

  it("ignores an anchor within the document", () => {
    expect(count("[top](#heading)")).toBe(0);
  });

  it("ignores a link to another markdown file", () => {
    expect(count("[next](chapter-two.md)")).toBe(0);
  });

  it("counts a picture or clip written as its HTML tag, which is how a sized one is kept", () => {
    expect(count('<img src="shot.png" alt="a" width="240">')).toBe(1);
    expect(count("<video src='clip.mp4' width=320 controls></video>")).toBe(1);
    expect(count('<img src="https://example.com/shot.png" width="240">')).toBe(0);
    // The same file, once as markdown and once sized, is still one file.
    expect(count('![a](shot.png)\n\n<img src="shot.png" width="240">')).toBe(1);
  });

  it("counts each distinct file once, however often it appears", () => {
    expect(count("![a](shot.png)\n\n![again](shot.png)\n\n![b](clip.mp4)")).toBe(2);
  });

  it("says nothing is at risk for a document of plain words", () => {
    expect(count("# Title\n\nJust words.")).toBe(0);
  });
});
