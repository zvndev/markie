import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { darkmownLinkTarget, blocksSrcdocNavigation, createDarkmownPictureScopes, createLinkGate } = require("./darkmown-preview.js");

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
    ]) expect(darkmownLinkTarget(href), href).toBeNull();
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
