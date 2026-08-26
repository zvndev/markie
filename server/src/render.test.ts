import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderDownloadPage,
  renderMarkdownHTML,
  renderSharedDocPage,
  renderPublicPage,
  renderNotFoundPage,
} from "./render.ts";

test("renderMarkdownHTML converts markdown to html", () => {
  const html = renderMarkdownHTML("# Hello\n\n- a\n- b");
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<li>a<\/li>/);
});

test("renderPublicPage embeds title, content, and download link", () => {
  const page = renderPublicPage({
    title: "My <Doc>",
    markdown: "# Hi",
    token: "abc123",
    siteUrl: "https://markie.example.com",
  });
  assert.match(page, /My &lt;Doc&gt;/);
  assert.match(page, /<h1>Hi<\/h1>/);
  assert.match(page, /href="\/s\/abc123\/raw"/);
  assert.match(page, /https:\/\/markie\.example\.com/);
  assert.match(page, /markie:\/\//);
});

test("renderPublicPage offers the manifest primary download", () => {
  const page = renderPublicPage({
    title: "Doc",
    markdown: "# Hi",
    token: "tok",
    siteUrl: "https://markie.example.com",
  });
  assert.match(page, /href="\/download\/mac"/);
  assert.match(page, /Get Markie for macOS/);
});

test("renderDownloadPage lists public and planned platforms", () => {
  const page = renderDownloadPage({ siteUrl: "https://markie.example.com" });

  assert.match(page, /Download Markie/);
  assert.match(page, /macOS Apple Silicon/);
  assert.match(page, /Windows x64/);
  assert.match(page, /Not published yet/);
  assert.match(page, /Markie-\*-arm64\.dmg/);
  assert.match(page, /Markie-\*-x64\.dmg/);
  assert.match(page, /Markie-\*-x64\.exe/);
  assert.match(page, /Markie-\*-x64\.AppImage/);
  assert.match(page, /\/download\/mac-intel/);
  assert.match(page, /\/download\/windows/);
  assert.match(page, /\/download\/linux/);
});

test("renderDownloadPage offers every signed build and gates the rest", () => {
  const page = renderDownloadPage({ siteUrl: "https://markie.example.com" });
  const card = (label: string) =>
    page.slice(
      page.lastIndexOf('<section class="platform-card">', page.indexOf(`<h2>${label}</h2>`)),
      page.indexOf("</section>", page.indexOf(`<h2>${label}</h2>`))
    );

  // Both macOS architectures are signed and notarized; Windows is signed by
  // Azure Artifact Signing. All three are downloadable.
  for (const label of ["macOS Apple Silicon", "macOS Intel", "Windows x64"]) {
    assert.match(card(label), /Published/, label);
    assert.doesNotMatch(card(label), /Not published yet/, label);
  }
  assert.match(card("macOS Intel"), /href="\/download\/mac-intel"/);
  assert.match(card("macOS Intel"), /Get Markie for Intel Mac/);
  assert.match(card("Windows x64"), /href="\/download\/windows"/);
  assert.match(card("Windows x64"), /Get Markie for Windows/);

  // Linux is still packaging-only, and the page has to keep saying so rather
  // than offering a link to something that was never built.
  assert.match(card("Linux x64"), /Not published yet/);
  assert.match(card("Linux x64"), /Planned/);
});

test("renderPublicPage's Open in Markie deep link carries the token + source", () => {
  const page = renderPublicPage({
    title: "Doc",
    markdown: "# Hi",
    token: "tok123",
    siteUrl: "https://markie.example.com",
  });
  // primary "Open in Markie" → markie://open?token=…&src=… so the app can fetch
  // the shared doc (no account needed) and open it.
  assert.match(page, /href="markie:\/\/open\?token=tok123&amp;src=https%3A%2F%2Fmarkie\.example\.com"/);
  assert.match(page, /class="btn primary"[^>]*>Open in Markie/);
});

test("renderNotFoundPage keeps its install CTA on the stable download route", () => {
  const page = renderNotFoundPage("https://markie.example.com");
  assert.match(page, /not found|no longer|expired/i);
  assert.match(page, /href="https:\/\/markie\.example\.com\/download\/mac"/);
});

test("renderMarkdownHTML drops javascript: link hrefs", () => {
  const html = renderMarkdownHTML("[click](javascript:alert(1))");
  assert.doesNotMatch(html, /javascript:/);
});

test("renderMarkdownHTML preserves syntax-highlight classes", () => {
  const html = renderMarkdownHTML("```js\nconst a = 1;\n```");
  assert.match(html, /hljs/);
});

test("renderMarkdownHTML preserves KaTeX math output", () => {
  const html = renderMarkdownHTML("$E = mc^2$");
  assert.match(html, /katex/);
});

test("renderPublicPage sets a Content-Security-Policy", () => {
  const page = renderPublicPage({ title: "T", markdown: "# H", token: "tok", siteUrl: "https://x.test" });
  assert.match(page, /Content-Security-Policy/);
  assert.match(page, /default-src 'none'/);
});

const SHARED = {
  title: "Q3 Roadmap",
  markdown: "# Q3\n\nplan",
  docId: "doc123",
  siteUrl: "https://markie.test",
  sharedBy: "Dana",
  canEdit: false,
};

test("an invited newcomer is told which address claims the document", () => {
  // claimPendingInvites delivers the doc the moment the address is proven, and
  // no one can sign in without proving it; until now nothing told the reader
  // that, so the obvious move was to copy the text out by hand.
  const page = renderSharedDocPage({ ...SHARED, invitedEmail: "alice@example.com" });
  assert.match(page, /alice@example\.com/);
  assert.match(page, /already be[\s\S]*in your Library/);
});

test("a reader with no pending invite gets no invite instructions", () => {
  // Members and owners already have it; telling them to sign up would be noise.
  const page = renderSharedDocPage({ ...SHARED, invitedEmail: null });
  assert.doesNotMatch(page, /in your Library/);
});

test("an invited address is escaped into the page", () => {
  // The address comes from whatever the sharer typed into the invite box.
  const page = renderSharedDocPage({
    ...SHARED,
    invitedEmail: '"><script>alert(1)</script>',
  });
  assert.doesNotMatch(page, /<script>alert/);
});

test("the shared doc page always offers a way to get Markie", () => {
  const page = renderSharedDocPage({ ...SHARED, invitedEmail: null });
  assert.match(page, /Get Markie/);
});

test("the shared doc page links downloads through the stable site route", () => {
  // Release protocol: never a versioned artifact URL in a page or an email.
  const page = renderSharedDocPage({ ...SHARED, invitedEmail: "alice@example.com" });
  assert.doesNotMatch(page, /Markie-\d+\.\d+\.\d+/);
});
