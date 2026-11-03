// The bar on a hosted document page, its links into the web app, and the
// page's legibility in light and dark. Rendering only; the routes that decide
// who gets which page are in hosted-page-routes.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderAccessRequiredPage,
  renderDownloadPage,
  renderNotFoundPage,
  renderPublicPage,
  renderSharedDocPage,
} from "./render.ts";
import { renderSignInNotice, renderWebSignInPage } from "./web-signin.ts";

const SHARED = {
  title: "Q3 Roadmap",
  markdown: "# Q3\n\nplan",
  docId: "doc123",
  siteUrl: "https://markie.test",
  sharedBy: "Dana",
  canEdit: true,
};
const PUBLIC = { title: "Notes", markdown: "# Notes", token: "tok123", siteUrl: "https://markie.test" };

const hrefs = (page: string) => [...page.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const appHrefs = (page: string) => hrefs(page).filter((h) => h === "/app" || h.startsWith("/app/"));

test("the bar is a disclosure the reader can close and reopen, with no script", () => {
  for (const page of [
    renderSharedDocPage(SHARED),
    renderPublicPage(PUBLIC),
    renderSharedDocPage({ ...SHARED, nav: { webApp: true, account: "a@b.test" } }),
  ]) {
    assert.match(page, /<details class="chrome" open>\s*<summary class="chrome-toggle">/);
    // The toggle's accessible name says which way it goes in each state.
    assert.match(page, /Hide<span class="sr-only"> the Markie bar<\/span>/);
    assert.match(page, /Show<span class="sr-only"> the Markie<\/span> bar/);
    assert.match(page, /\.chrome\[open\] \.when-closed, \.chrome:not\(\[open\]\) \.when-open \{ display: none; \}/);
    assert.match(page, /<nav class="nav" aria-label="Markie">/);
    // Still no script anywhere, and the page's own policy still allows none.
    assert.doesNotMatch(page, /<script/i);
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(page)?.[1] ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/);
  }
});

test("without the web app the bar links nowhere under /app and keeps today's buttons", () => {
  const shared = renderSharedDocPage({ ...SHARED, nav: { webApp: false, account: "me@x.test" } });
  assert.deepEqual(appHrefs(shared), []);
  assert.match(shared, /class="btn primary" href="markie:\/\/doc\?id=doc123[^"]*">Open in Markie/);
  assert.match(shared, />Get Markie</);
  assert.match(shared, /href="\/d\/doc123\/raw">Download \.md/);

  const pub = renderPublicPage({ ...PUBLIC, nav: { webApp: false, account: null } });
  assert.deepEqual(appHrefs(pub), []);
  assert.match(pub, /class="btn primary" href="markie:\/\/open\?token=tok123[^"]*">Open in Markie/);
  // The default, as every existing caller passes nothing.
  assert.deepEqual(appHrefs(renderPublicPage(PUBLIC)), []);
  assert.deepEqual(appHrefs(renderSharedDocPage(SHARED)), []);
});

test("with the web app an editor gets Library, New document and the document in the editor", () => {
  const page = renderSharedDocPage({ ...SHARED, nav: { webApp: true, account: "ed@x.test" } });
  assert.deepEqual(appHrefs(page), ["/app", "/app/new", "/app/d/doc123"]);
  assert.match(page, /class="btn primary" href="\/app\/d\/doc123">Open in editor/);
  assert.doesNotMatch(page, /markie:\/\/doc/);
  assert.match(page, />Get Markie</);
  assert.match(page, /Download \.md/);
  assert.match(page, /<span class="sr-only">Signed in as <\/span>ed@x\.test/);
});

test("a viewer gets Library and New document but no editor link", () => {
  const page = renderSharedDocPage({ ...SHARED, canEdit: false, nav: { webApp: true, account: "v@x.test" } });
  assert.deepEqual(appHrefs(page), ["/app", "/app/new"]);
  assert.doesNotMatch(page, /Open in editor/);
});

test("the editor link escapes an odd document id", () => {
  const page = renderSharedDocPage({ ...SHARED, docId: 'a"b<c', nav: { webApp: true, account: null } });
  assert.ok(appHrefs(page).includes("/app/d/a%22b%3Cc"));
});

test("a public page offers sign in to a visitor and the library to a signed-in reader", () => {
  const visitor = renderPublicPage({ ...PUBLIC, nav: { webApp: true, account: null } });
  assert.deepEqual(appHrefs(visitor), ["/app"]);
  assert.match(visitor, /<a class="nav-link" href="\/app">Sign in<\/a>/);
  assert.doesNotMatch(visitor, /class="who"/);

  const reader = renderPublicPage({ ...PUBLIC, nav: { webApp: true, account: "r@x.test" } });
  assert.deepEqual(appHrefs(reader), ["/app", "/app/new"]);
  assert.match(reader, /r@x\.test/);

  const editor = renderPublicPage({ ...PUBLIC, nav: { webApp: true, account: "e@x.test" }, editDocId: "doc9" });
  assert.deepEqual(appHrefs(editor), ["/app", "/app/new", "/app/d/doc9"]);
});

test("the account chip is escaped", () => {
  const page = renderSharedDocPage({ ...SHARED, nav: { webApp: true, account: '"><img src=x onerror=1>' } });
  assert.doesNotMatch(page, /<img src=x/);
});

test("every hosted page follows the system's dark mode", () => {
  const pages = {
    shared: renderSharedDocPage(SHARED),
    public: renderPublicPage(PUBLIC),
    access: renderAccessRequiredPage("https://markie.test", "/auth/web-signin?next=%2Fd%2Fx"),
    notFound: renderNotFoundPage("https://markie.test"),
    download: renderDownloadPage({ siteUrl: "https://markie.test" }),
    notice: renderSignInNotice({ title: "t", heading: "h", lines: [["x"]], action: null }),
    signIn: renderWebSignInPage({ next: "/", google: false, failed: false }),
  };
  for (const [name, page] of Object.entries(pages)) {
    assert.match(page, /color-scheme: light dark/, `${name}: declares both schemes`);
    assert.match(page, /@media \(prefers-color-scheme: dark\)/, `${name}: has dark colours`);
  }
  // Code on a document page switches highlight theme with the scheme, and
  // highlight.js's own block background gives way to the page's code panel.
  for (const page of [pages.shared, pages.public]) {
    assert.match(page, /github\.min\.css" media="\(prefers-color-scheme: light\)"/);
    assert.match(page, /github-dark\.min\.css" media="\(prefers-color-scheme: dark\)"/);
    assert.match(page, /main pre code\.hljs \{ background: transparent;/);
    assert.match(page, /main th \{ background: var\(--code-bg\); \}/);
  }
});

test("the bar and its nav reflow on a phone", () => {
  const page = renderSharedDocPage({ ...SHARED, nav: { webApp: true, account: "a@b.test" } });
  const phone = /@media \(max-width: 640px\) \{([\s\S]*?)\n  \}/.exec(page)?.[1] ?? "";
  assert.match(phone, /\.chrome \.bar \{/);
  assert.match(phone, /\.bar \.nav \{ flex-basis: 100%;/);
});

test("a plain-text document reads as text, escaped, on both page kinds", () => {
  const text = "# not a heading\nline two\n<b>x</b>";
  for (const page of [
    renderSharedDocPage({ ...SHARED, markdown: text, format: "text" }),
    renderPublicPage({ ...PUBLIC, markdown: text, format: "text" }),
  ]) {
    assert.match(page, /<pre class="text-doc"># not a heading\nline two\n&lt;b&gt;x&lt;\/b&gt;<\/pre>/);
    assert.doesNotMatch(page, /<h1>not a heading/);
  }
});

test("a Darkmown document shows its source on a public page too", () => {
  const page = renderPublicPage({ ...PUBLIC, markdown: "state n = 1\n<button>", format: "darkmown" });
  assert.match(page, /class="darkmown-note"/);
  assert.match(page, /<pre class="darkmown-source"><code>state n = 1\n&lt;button&gt;<\/code><\/pre>/);
  assert.match(page, /Download \.wd/);
});

// The colour rules are scoped to one scheme each, selected by the exact style
// attribute, and the markup itself stays as the author wrote it.
function docCss(page: string): string {
  const blocks = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  return blocks.length > 1 ? blocks[blocks.length - 1] : "";
}

test("an authored black run is lifted on the dark page and left alone on the light one", () => {
  const page = renderSharedDocPage({ ...SHARED, markdown: 'a <span style="color: #000000">ink</span> b' });
  assert.match(page, /<span style="color: #000000">ink<\/span>/);
  const css = docCss(page);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\{main \[style="color\\3a  \\23 000000"\]\{color:var\(--text\) !important\}\}/);
  assert.doesNotMatch(css, /prefers-color-scheme: light/);
});

test("an authored white run is darkened on the light page only", () => {
  const css = docCss(renderPublicPage({ ...PUBLIC, markdown: 'a <span style="color: white">w</span> b' }));
  assert.match(css, /@media \(prefers-color-scheme: light\)\{main \[style="color\\3a  white"\]\{color:var\(--text\) !important\}\}/);
  assert.doesNotMatch(css, /prefers-color-scheme: dark/);
});

test("a dark coloured run keeps its hue on the dark page", () => {
  const css = docCss(renderSharedDocPage({ ...SHARED, markdown: '<span style="color: #1a237e">navy</span>' }));
  const lifted = /prefers-color-scheme: dark\)\{[^{]*\{color:(#[0-9a-f]{6}) !important/.exec(css)?.[1];
  assert.ok(lifted, "a lifted colour for the dark page");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(lifted.slice(i, i + 2), 16));
  assert.ok(b > r && b > g, `stays blue: ${lifted}`);
});

test("a colour that reads on both pages gets no rule", () => {
  assert.equal(docCss(renderSharedDocPage({ ...SHARED, markdown: '<span style="color: red">r</span>' })), "");
  assert.equal(docCss(renderSharedDocPage(SHARED)), "");
});

test("text on a pale highlight gets dark ink in both schemes", () => {
  const css = docCss(renderSharedDocPage({ ...SHARED, markdown: 'a <span style="background-color: #fff59d">hi</span> b' }));
  assert.match(css, /^main \[style="background-color\\3a  \\23 fff59d"\]\{color:#2c2c2c\}/);
  // A <mark> with a pale background already gets dark text from the browser.
  assert.equal(docCss(renderSharedDocPage({ ...SHARED, markdown: '<mark style="background-color: #ff0">m</mark>' })), "");
});

test("nothing in an author's style attribute can break out of the colour stylesheet", () => {
  const evil = 'color: #000;}</style><script>alert(1)</script><style>a{';
  const page = renderSharedDocPage({ ...SHARED, markdown: `<span style="${evil.replace(/"/g, "&quot;")}">x</span>` });
  const css = docCss(page);
  assert.ok(css.length > 0, "the run still gets its dark-page rule");
  // Every character an author chose is a CSS escape: no angle bracket, no
  // brace, no quote of theirs reaches the stylesheet.
  const selector = /\[style="([^"]*)"\]/.exec(css)?.[1] ?? "";
  assert.doesNotMatch(selector, /[<>{}"]/);
  assert.doesNotMatch(css, /</);
  // The one <script> on the page is inert text inside the sanitized
  // attribute; there is no script element.
  assert.equal(page.match(/<script/g)?.length, 1);
  assert.match(page, /style="color: #000;}<\/style><script>/);
});
