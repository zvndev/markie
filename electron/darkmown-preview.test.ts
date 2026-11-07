import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { darkmownLinkTarget, blocksSrcdocNavigation, createSrcdocNavigationGuard, markdownGrantFolder, createDarkmownPictureScopes, createLinkGate } = require("./darkmown-preview.js");

describe("darkmownLinkTarget", () => {
  it("opens ordinary web pages and mail drafts", () => {
    expect(darkmownLinkTarget("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(darkmownLinkTarget("http://example.com")).toBe("http://example.com/");
    expect(darkmownLinkTarget("mailto:ada@example.com")).toBe("mailto:ada@example.com");
    expect(darkmownLinkTarget("mailto:ada@example.com?subject=Trip%20notes&cc=bo@example.org")).toBe("mailto:ada@example.com?subject=Trip%20notes&cc=bo@example.org");
  });

  it("refuses javascript:, file: and every other scheme", () => {
    for (const href of [
      "javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/passwd", "file://localhost/Users/me/.ssh/id_rsa",
      "data:text/html,<script>alert(1)</script>", "vbscript:msgbox", "markie://open?path=/etc", "markie-asset://local/%2Fetc%2Fpasswd",
      "ftp://example.com", "blob:https://example.com/x", "about:blank", "chrome://settings",
    ]) expect(darkmownLinkTarget(href), href).toBeNull();
  });

  it("refuses relative paths, credentials, whitespace tricks and oversized input", () => {
    for (const href of [
      "other.md", "/etc/passwd", "../up.md", "//example.com", "https://user:pw@example.com", "https://google.com@evil.example",
      " https://example.com", "https://example.com\n", "java\tscript:alert(1)", "https:\\\\example.com", "https:example.com",
      `https://example.com/${"a".repeat(9000)}`, "", 42, null, undefined, { href: "https://example.com" },
    ]) expect(darkmownLinkTarget(href as never), String(href)).toBeNull();
  });

  it("refuses mail drafts that attach files or carry odd addresses", () => {
    for (const href of [
      "mailto:ada@example.com?attach=/etc/passwd", "mailto:ada@example.com?Attach=~/.ssh/id_rsa", "mailto:ada@example.com?body=x&file=y",
      "mailto:", "mailto:not-an-address", "mailto:ada@localhost", "mailto:ada@example.com#frag", "mailto:ada@example.com?cc=nobody",
      "mailto:%22quoted%22@example.com",
      // `attach=` hidden in the address, for a client that parses fields loosely.
      "mailto:x&attach=/etc/passwd&y@a.co", "mailto:x=1@a.co", "mailto:x/y@a.co",
      // A line break in a header field starts another header.
      "mailto:a@b.co?subject=Hi%0D%0ABcc:%20evil@x.co", "mailto:a@b.co?subject=Hi%0ABcc:evil@x.co", "mailto:a@b.co?cc=c@d.co%0D%0Abcc:e@f.co",
    ]) expect(darkmownLinkTarget(href), href).toBeNull();
  });

  it("still opens a body with line breaks, which is what a body is for", () => {
    expect(darkmownLinkTarget("mailto:a@b.co?body=line%20one%0D%0Aline%20two")).toBe("mailto:a@b.co?body=line%20one%0D%0Aline%20two");
    expect(darkmownLinkTarget("mailto:first.last+tag@example.co.uk")).toBe("mailto:first.last+tag@example.co.uk");
  });
});

describe("createSrcdocNavigationGuard", () => {
  it("keeps judging a preview frame after it steps through about:blank", () => {
    const guard = createSrcdocNavigationGuard();
    const frame = { isMainFrame: false, frameId: 42, parentIsTop: true };
    expect(guard.blocks({ ...frame, frameUrl: "about:srcdoc", url: "about:blank" })).toBe(false);
    expect(guard.blocks({ ...frame, frameUrl: "about:blank", url: "https://evil.example/" })).toBe(true);
    expect(guard.blocks({ ...frame, frameUrl: "about:blank", url: "about:srcdoc" })).toBe(false);
    // The stateless rule alone would have let it through.
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "about:blank", url: "https://evil.example/" })).toBe(false);
  });

  it("leaves frames nested inside other frames, and frames that never showed srcdoc, alone", () => {
    const guard = createSrcdocNavigationGuard();
    expect(guard.blocks({ isMainFrame: false, frameId: 7, parentIsTop: false, frameUrl: "about:srcdoc", url: "https://player.example/next" })).toBe(false);
    expect(guard.blocks({ isMainFrame: false, frameId: 8, parentIsTop: true, frameUrl: "https://www.youtube-nocookie.com/embed/x", url: "https://www.youtube-nocookie.com/embed/y" })).toBe(false);
    expect(guard.blocks({ isMainFrame: true, frameId: 1, parentIsTop: false, frameUrl: "about:srcdoc", url: "https://example.com/" })).toBe(false);
  });

  it("forgets every frame when the app's top frame navigates", () => {
    const guard = createSrcdocNavigationGuard();
    guard.blocks({ isMainFrame: false, frameId: 42, parentIsTop: true, frameUrl: "about:srcdoc", url: "about:srcdoc" });
    guard.reset();
    expect(guard.blocks({ isMainFrame: false, frameId: 42, parentIsTop: true, frameUrl: "https://www.youtube-nocookie.com/embed/x", url: "https://www.youtube-nocookie.com/embed/y" })).toBe(false);
  });
});

describe("blocksSrcdocNavigation", () => {
  it("stops a preview frame from navigating anywhere but a fresh srcdoc", () => {
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "about:srcdoc", url: "https://example.com/" })).toBe(true);
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "about:srcdoc", url: "file:///etc/passwd" })).toBe(true);
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "about:srcdoc", url: "javascript:alert(1)" })).toBe(true);
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "about:srcdoc", url: "about:srcdoc" })).toBe(false);
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "about:srcdoc", url: "about:srcdoc#x", isSameDocument: true })).toBe(false);
  });

  it("leaves the app window and other frames (video players) alone", () => {
    expect(blocksSrcdocNavigation({ isMainFrame: true, frameUrl: "about:srcdoc", url: "https://example.com/" })).toBe(false);
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "https://www.youtube-nocookie.com/embed/x", url: "https://www.youtube-nocookie.com/embed/y" })).toBe(false);
    expect(blocksSrcdocNavigation({ isMainFrame: false, frameUrl: "about:blank", url: "about:srcdoc" })).toBe(false);
  });
});

describe("createDarkmownPictureScopes", () => {
  let root: string, docDir: string, outside: string;
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const ask = (scopes: ReturnType<typeof createDarkmownPictureScopes>, host: string, ref: string) => scopes.resolve(host, `/${encodeURIComponent(ref)}`);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-wd-pictures-")));
    docDir = path.join(root, "trip");
    outside = path.join(root, "private");
    mkdirSync(path.join(docDir, "pics"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(docDir, "notes.wd"), "# Trip");
    writeFileSync(path.join(docDir, "pics", "shot.png"), "png");
    writeFileSync(path.join(docDir, "my photo.jpg"), "jpg");
    writeFileSync(path.join(docDir, "secret.txt"), "not a picture");
    writeFileSync(path.join(outside, "id.png"), "outside");
    writeFileSync(path.join(root, "beside.png"), "beside the folder");
    symlinkSync(path.join(outside, "id.png"), path.join(docDir, "pics", "link-out.png"));
    symlinkSync(outside, path.join(docDir, "dir-out"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("serves a picture beside the document and in its subfolders", () => {
    const scopes = createDarkmownPictureScopes({ randomUUID: uuid });
    const host = scopes.scopeFor(7, docDir);
    expect(host).toMatch(/^wd-[0-9a-f]{32}$/);
    expect(ask(scopes, host, "pics/shot.png")).toEqual({ path: path.join(docDir, "pics", "shot.png"), mime: "image/png", kind: "image" });
    expect(ask(scopes, host, "./pics/shot.png?v=2#top")?.path).toBe(path.join(docDir, "pics", "shot.png"));
    expect(ask(scopes, host, "my%20photo.jpg")?.path).toBe(path.join(docDir, "my photo.jpg"));
  });

  it("refuses a ../ picture, even one that exists", () => {
    const scopes = createDarkmownPictureScopes({ randomUUID: uuid });
    const host = scopes.scopeFor(7, docDir);
    expect(ask(scopes, host, "../beside.png")).toBeNull();
    expect(ask(scopes, host, "pics/../../beside.png")).toBeNull();
    expect(ask(scopes, host, "%2E%2E/beside.png")).toBeNull();
    expect(ask(scopes, host, "..%2Fbeside.png")).toBeNull();
    expect(ask(scopes, host, "../private/id.png")).toBeNull();
  });

  it("refuses a symlink that points out of the folder", () => {
    const scopes = createDarkmownPictureScopes({ randomUUID: uuid });
    const host = scopes.scopeFor(7, docDir);
    expect(ask(scopes, host, "pics/link-out.png")).toBeNull();
    expect(ask(scopes, host, "dir-out/id.png")).toBeNull();
  });

  it("refuses absolute paths, schemes and files that are not pictures", () => {
    const scopes = createDarkmownPictureScopes({ randomUUID: uuid });
    const host = scopes.scopeFor(7, docDir);
    for (const ref of [path.join(docDir, "pics", "shot.png"), `file://${path.join(docDir, "pics", "shot.png")}`, "https://example.com/x.png", "secret.txt", "notes.wd", "pics", "C:/x.png", "pics\\shot.png", "missing.png"]) {
      expect(ask(scopes, host, ref), ref).toBeNull();
    }
    expect(scopes.resolve(host, "pics/shot.png")).toBeNull(); // no leading slash: not a path this module made
    expect(scopes.resolve(host, "/%E0%A4%A")).toBeNull(); // malformed escape
  });

  it("answers nothing for an unknown, released or malformed scope", () => {
    const scopes = createDarkmownPictureScopes({ randomUUID: uuid });
    const host = scopes.scopeFor(7, docDir);
    expect(ask(scopes, "wd-ffffffffffffffffffffffffffffffff", "pics/shot.png")).toBeNull();
    expect(ask(scopes, "local", "pics/shot.png")).toBeNull();
    scopes.releaseOwner(7);
    expect(ask(scopes, host, "pics/shot.png")).toBeNull();
    expect(scopes.scopeFor(0, docDir)).toBeNull();
    expect(scopes.scopeFor(7, "")).toBeNull();
  });

  it("stops serving when the folder is replaced, even by a symlink to the same contents", () => {
    const scopes = createDarkmownPictureScopes({ randomUUID: uuid });
    const host = scopes.scopeFor(7, docDir);
    expect(ask(scopes, host, "pics/shot.png")).not.toBeNull();
    // The folder is moved aside and its name now points somewhere else.
    const aside = path.join(root, "trip-old");
    renameSync(docDir, aside);
    mkdirSync(path.join(outside, "pics"));
    writeFileSync(path.join(outside, "pics", "shot.png"), "someone else's");
    symlinkSync(outside, docDir);
    expect(ask(scopes, host, "pics/shot.png")).toBeNull();
    // And it stays dead: putting the original back does not revive it.
    rmSync(docDir);
    renameSync(aside, docDir);
    expect(ask(scopes, host, "pics/shot.png")).toBeNull();
    expect(scopes.scopeFor(7, docDir)).not.toBe(host);
  });

  it("reuses one scope per window and folder, and evicts the oldest", () => {
    const scopes = createDarkmownPictureScopes({ randomUUID: uuid, maxScopes: 2 });
    const first = scopes.scopeFor(7, docDir);
    expect(scopes.scopeFor(7, docDir)).toBe(first);
    const other = scopes.scopeFor(8, docDir);
    expect(other).not.toBe(first);
    scopes.scopeFor(7, outside);
    expect(scopes.size()).toBe(2);
    expect(ask(scopes, first, "pics/shot.png")).toBeNull();
    expect(ask(scopes, other, "pics/shot.png")?.path).toBe(path.join(docDir, "pics", "shot.png"));
  });
});

describe("createLinkGate", () => {
  it("lets one link through per click, not a burst", () => {
    let now = 1_000;
    const gate = createLinkGate({ now: () => now, minIntervalMs: 400 });
    expect(gate.allow()).toBe(true);
    expect(gate.allow()).toBe(false);
    now += 399;
    expect(gate.allow()).toBe(false);
    now += 1;
    expect(gate.allow()).toBe(true);
  });
});

describe("markdownGrantFolder", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-md-grant-")));
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "sub", "real.md"), "# real");
    // A .md-named symlink to a folder: the reviewer's case.
    symlinkSync(root, path.join(root, "sub", "notes.md"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("scopes a real Markdown file to its folder", () => {
    expect(markdownGrantFolder({ ok: true, path: path.join(root, "sub", "real.md") })).toBe(path.join(root, "sub"));
  });

  it("refuses a grant that resolves to a folder, a non-Markdown name, or no grant at all", () => {
    // canRead realpaths sub/notes.md to the root folder itself.
    expect(markdownGrantFolder({ ok: true, path: realpathSync(path.join(root, "sub", "notes.md")) })).toBeNull();
    expect(markdownGrantFolder({ ok: true, path: path.join(root, "sub") })).toBeNull();
    expect(markdownGrantFolder({ ok: true, path: path.join(root, "sub", "real.txt") })).toBeNull();
    expect(markdownGrantFolder({ ok: true, path: path.join(root, "sub", "missing.md") })).toBeNull();
    expect(markdownGrantFolder({ ok: false })).toBeNull();
    expect(markdownGrantFolder(null)).toBeNull();
  });
});
