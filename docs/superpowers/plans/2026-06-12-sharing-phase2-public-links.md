# Sharing Phase 2 — Public Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an unguessable, revocable public link per doc — `GET /s/:token` renders a gorgeous read-only preview with a `Download .md` button and a Markie CTA; `GET /s/:token/raw` streams the file; the share dialog and invite emails surface the link — so anyone can view/download a shared doc with no account.

**Architecture:** All server-side in the existing Hono app. A new `public_links` table (own module, mirrors `pending.ts`). A self-contained server renderer (`render.ts`) reuses Markie's exact `unified` markdown→HTML pipeline plus a styled HTML page shell (decision OD-2: existing renderer, not markie-framework). Public routes mount at root (`/s/:token`), owner mutations live on the existing `/api/docs` shares router. Domain is env-driven via `MARKIE_SITE_URL` (decision OD-1), default `https://markie.zvndev.com`.

**Tech Stack:** Hono, better-sqlite3, Node 22 `--experimental-strip-types` (import `.ts` with explicit extensions), `unified`/remark/rehype, Node built-in `node:test`. Client: React, `auth-client.ts` fetch helper.

**Spec:** `docs/superpowers/specs/2026-06-12-account-optional-sharing-design.md` (Phase 2 section; OD-1/OD-2/OD-3 resolved 2026-06-12).

---

## File Structure

- **Create `server/src/render.ts`** — pure `renderMarkdownHTML(md)` (same plugin chain as `src/lib/markdown-html.ts`) + `renderPublicPage({title, markdown, token, siteUrl})` (full styled HTML page) + `renderNotFoundPage(siteUrl)`. One responsibility: turn a doc into public HTML.
- **Create `server/src/public-links.ts`** — `public_links` table + `createOrGetPublicLink`, `getPublicLinkToken`, `resolvePublicToken`, `revokePublicLink`. Mirrors `pending.ts` (own db handle). One responsibility: public-link persistence.
- **Create `server/src/public.ts`** — Hono router: unauthenticated `GET /s/:token` and `GET /s/:token/raw`. One responsibility: public HTTP surface.
- **Modify `server/src/shares.ts`** — add owner endpoints `GET/POST/DELETE /:id/public-link`; in the unknown-email invite branch, ensure a public link exists and point the email at it.
- **Modify `server/src/index.ts`** — mount `publicShare` at root.
- **Modify `server/package.json`** — add the 8 renderer deps + a `test` script.
- **Modify `src/lib/auth-client.ts`** — `sharesClient.getPublicLink/createPublicLink/revokePublicLink`.
- **Modify `src/components/share-dialog.tsx`** — "Anyone with the link" section (create / copy / revoke).
- **Create `server/src/render.test.ts`**, **`server/src/public-links.test.ts`** — `node:test` units.

Routes (`/s/:token`) deliberately sit **outside `/api`** so the public URL is clean and CORS/auth middleware for the app don't apply.

---

### Task 1: Add renderer dependencies to the server

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add the 8 renderer deps + a test script**

Edit `server/package.json`. In `"scripts"`, add a `test` entry. In `"dependencies"`, add the renderer libs (versions pinned to match the root app exactly):

```json
{
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "start": "node --experimental-strip-types src/index.ts",
    "migrate": "npx @better-auth/cli@latest migrate --config src/auth.ts -y",
    "test": "node --experimental-strip-types --test src/render.test.ts src/public-links.test.ts"
  },
  "dependencies": {
    "@hono/node-server": "^2.0.4",
    "better-auth": "^1.6.16",
    "better-sqlite3": "^12.10.0",
    "hono": "^4.12.25",
    "rehype-highlight": "^7.0.2",
    "rehype-katex": "^7.0.1",
    "rehype-stringify": "^10.0.1",
    "remark-gfm": "^4.0.1",
    "remark-math": "^6.0.0",
    "remark-parse": "^11.0.0",
    "remark-rehype": "^11.1.2",
    "unified": "^11.0.5",
    "ws": "^8.21.0",
    "y-protocols": "^1.0.7",
    "y-websocket": "^3.0.0",
    "yjs": "^13.6.31"
  }
}
```

- [ ] **Step 2: Install**

Run: `cd server && npm install`
Expected: installs the new packages, exits 0, `node_modules/unified` etc. present.

- [ ] **Step 3: Commit**

```bash
cd <repo-root>
git add server/package.json server/package-lock.json
git commit -m "build(server): add markdown renderer deps for public share pages"
```

---

### Task 2: Server render module

**Files:**
- Create: `server/src/render.ts`
- Test: `server/src/render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/render.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderMarkdownHTML,
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
  // title escaped in <title> and heading
  assert.match(page, /My &lt;Doc&gt;/);
  // rendered content present
  assert.match(page, /<h1>Hi<\/h1>/);
  // download button points at the raw route
  assert.match(page, /href="\/s\/abc123\/raw"/);
  // a get-Markie CTA points at the site
  assert.match(page, /https:\/\/markie\.example\.com/);
  // markie:// deep link attempt present
  assert.match(page, /markie:\/\//);
});

test("renderNotFoundPage returns a 404 body with a site link", () => {
  const page = renderNotFoundPage("https://markie.example.com");
  assert.match(page, /not found|no longer|expired/i);
  assert.match(page, /https:\/\/markie\.example\.com/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --experimental-strip-types --test src/render.test.ts`
Expected: FAIL — cannot resolve `./render.ts`.

- [ ] **Step 3: Write the implementation**

Create `server/src/render.ts`:

```ts
// Self-contained server-side renderer for public share pages. Uses the exact
// same unified pipeline as the in-app preview (src/lib/markdown-html.ts), kept
// here so the server has no dependency on the Next app's module graph.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeHighlight)
  .use(rehypeKatex)
  .use(rehypeStringify);

export function renderMarkdownHTML(markdown: string): string {
  return String(processor.processSync(markdown));
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"
  );

// CDN stylesheets for the rendered content (highlight.js + KaTeX), so the page
// is self-contained and zero-build.
const HEAD_CSS = `
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">`;

const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0a0c; color: #e4e4e7;
    font: 16px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .bar { position: sticky; top: 0; display: flex; align-items: center; gap: 12px;
    padding: 12px 20px; background: #131316cc; backdrop-filter: blur(8px);
    border-bottom: 1px solid #27272a; }
  .bar .brand { font-weight: 800; color: #f59e0b; font-size: 18px; }
  .bar .title { font-size: 14px; color: #a1a1aa; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { text-decoration: none; font-size: 13px; font-weight: 600;
    padding: 7px 14px; border-radius: 8px; white-space: nowrap; }
  .btn.primary { background: #f59e0b; color: #000; }
  .btn.ghost { color: #e4e4e7; border: 1px solid #3f3f46; }
  main { max-width: 760px; margin: 0 auto; padding: 36px 24px 64px; }
  main :where(h1,h2,h3) { line-height: 1.25; margin-top: 1.6em; }
  main h1 { font-size: 1.9em; }
  main pre { background: #131316; padding: 14px 16px; border-radius: 10px;
    overflow-x: auto; border: 1px solid #27272a; }
  main code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main :not(pre) > code { background: #27272a; padding: 1px 5px; border-radius: 5px;
    font-size: 0.9em; }
  main a { color: #fbbf24; }
  main blockquote { border-left: 3px solid #3f3f46; margin: 1em 0; padding: 2px 16px;
    color: #a1a1aa; }
  main table { border-collapse: collapse; }
  main th, main td { border: 1px solid #27272a; padding: 6px 12px; }
  main img { max-width: 100%; border-radius: 8px; }
  .cta { max-width: 760px; margin: 0 auto; padding: 24px; border-top: 1px solid #27272a;
    color: #a1a1aa; font-size: 14px; }
  .cta a { color: #fbbf24; font-weight: 600; }`;

export function renderPublicPage(opts: {
  title: string;
  markdown: string;
  token: string;
  siteUrl: string;
}): string {
  const { title, markdown, token, siteUrl } = opts;
  const content = renderMarkdownHTML(markdown);
  const safeTitle = esc(title);
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${safeTitle} · Markie</title>
  ${HEAD_CSS}
  <style>${PAGE_CSS}</style>
</head><body>
  <div class="bar">
    <span class="brand">M</span>
    <span class="title">${safeTitle}</span>
    <a class="btn ghost" href="markie://open">Open in Markie</a>
    <a class="btn primary" href="/s/${esc(token)}/raw">Download .md</a>
  </div>
  <main>${content}</main>
  <div class="cta">
    These look even better in <a href="${esc(siteUrl)}">Markie</a> — it's free,
    it's fast, and your markdown will thank you.
  </div>
</body></html>`;
}

export function renderNotFoundPage(siteUrl: string): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link expired · Markie</title>
  <style>${PAGE_CSS}</style>
</head><body>
  <main style="text-align:center;padding-top:80px">
    <div style="font-size:40px;font-weight:800;color:#f59e0b">M</div>
    <h1>This link is no longer available</h1>
    <p style="color:#a1a1aa">The doc was unshared, or the link expired.</p>
    <p><a class="btn primary" href="${esc(siteUrl)}">Get Markie</a></p>
  </main>
</body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --experimental-strip-types --test src/render.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/render.ts server/src/render.test.ts
git commit -m "feat(server): public-page markdown renderer + styled HTML shell"
```

---

### Task 3: public_links persistence module

**Files:**
- Create: `server/src/public-links.ts`
- Test: `server/src/public-links.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/public-links.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module's db at a throwaway file BEFORE importing it.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-pl-")), "t.db");
const {
  createOrGetPublicLink,
  getPublicLinkToken,
  resolvePublicToken,
  revokePublicLink,
} = await import("./public-links.ts");

test("createOrGetPublicLink is stable per doc", () => {
  const a = createOrGetPublicLink("doc1", "owner1");
  const b = createOrGetPublicLink("doc1", "owner1");
  assert.equal(a, b);
  assert.ok(a.length >= 32);
});

test("resolvePublicToken maps token back to doc", () => {
  const token = createOrGetPublicLink("doc2", "owner1");
  assert.deepEqual(resolvePublicToken(token), { doc_id: "doc2" });
  assert.equal(resolvePublicToken("nope"), null);
});

test("getPublicLinkToken returns current or null", () => {
  assert.equal(getPublicLinkToken("doc404"), null);
  const token = createOrGetPublicLink("doc3", "owner1");
  assert.equal(getPublicLinkToken("doc3"), token);
});

test("revokePublicLink removes the link", () => {
  const token = createOrGetPublicLink("doc4", "owner1");
  assert.equal(revokePublicLink("doc4"), true);
  assert.equal(resolvePublicToken(token), null);
  assert.equal(revokePublicLink("doc4"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --experimental-strip-types --test src/public-links.test.ts`
Expected: FAIL — cannot resolve `./public-links.ts`.

- [ ] **Step 3: Write the implementation**

Create `server/src/public-links.ts`:

```ts
// Public share links: an unguessable, revocable token per doc that grants
// account-free read + download via GET /s/:token. Own table so it can be
// revoked independently of membership. Mirrors pending.ts (own db handle).
import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS public_links (
    doc_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_public_token ON public_links(token);
`);

const newToken = () =>
  `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

// Create the link once; subsequent calls return the same token (stable URL).
export function createOrGetPublicLink(docId: string, userId: string): string {
  const existing = db
    .prepare("SELECT token FROM public_links WHERE doc_id = ?")
    .get(docId) as { token: string } | undefined;
  if (existing) return existing.token;
  const token = newToken();
  db.prepare(
    `INSERT INTO public_links (doc_id, token, created_by, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(docId, token, userId, new Date().toISOString());
  return token;
}

export function getPublicLinkToken(docId: string): string | null {
  const row = db
    .prepare("SELECT token FROM public_links WHERE doc_id = ?")
    .get(docId) as { token: string } | undefined;
  return row?.token ?? null;
}

export function resolvePublicToken(token: string): { doc_id: string } | null {
  const row = db
    .prepare("SELECT doc_id FROM public_links WHERE token = ?")
    .get(token) as { doc_id: string } | undefined;
  return row ?? null;
}

export function revokePublicLink(docId: string): boolean {
  return (
    db.prepare("DELETE FROM public_links WHERE doc_id = ?").run(docId).changes >
    0
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --experimental-strip-types --test src/public-links.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/public-links.ts server/src/public-links.test.ts
git commit -m "feat(server): public_links table + create/resolve/revoke"
```

---

### Task 4: Public HTTP routes

**Files:**
- Create: `server/src/public.ts`
- Modify: `server/src/index.ts` (imports near top; mount after the other `app.route(...)` calls)

- [ ] **Step 1: Write the public router**

Create `server/src/public.ts`:

```ts
// Unauthenticated public share surface: a rendered preview and a raw download.
// Mounted at root (not /api) so links are clean: ${SITE}/s/:token
import { Hono } from "hono";
import Database from "better-sqlite3";
import { resolvePublicToken } from "./public-links.ts";
import {
  renderPublicPage,
  renderNotFoundPage,
} from "./render.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");
const MARKIE_SITE = process.env.MARKIE_SITE_URL ?? "https://markie.zvndev.com";

function docForToken(
  token: string
): { name: string; content: string } | null {
  const link = resolvePublicToken(token);
  if (!link) return null;
  const doc = db
    .prepare(
      "SELECT name, content FROM docs WHERE id = ? AND deleted_at IS NULL"
    )
    .get(link.doc_id) as { name: string; content: string } | undefined;
  return doc ?? null;
}

export const publicShare = new Hono();

publicShare.get("/s/:token", (c) => {
  const token = c.req.param("token");
  const doc = docForToken(token);
  if (!doc) return c.html(renderNotFoundPage(MARKIE_SITE), 404);
  return c.html(
    renderPublicPage({
      title: doc.name,
      markdown: doc.content,
      token,
      siteUrl: MARKIE_SITE,
    })
  );
});

publicShare.get("/s/:token/raw", (c) => {
  const token = c.req.param("token");
  const doc = docForToken(token);
  if (!doc) return c.text("Not found", 404);
  const base = doc.name.replace(/"/g, "").trim() || "document";
  const filename = base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(doc.content);
});
```

- [ ] **Step 2: Mount it in `server/src/index.ts`**

Add the import beside the other route imports (after `import { themes } from "./themes.ts";`):

```ts
import { publicShare } from "./public.ts";
```

Then, immediately after the existing `app.route("/api", themes);` line, add:

```ts
app.route("/", publicShare);
```

- [ ] **Step 3: Manual smoke — seed a token and fetch the page**

Run (from `server/`), in one shot against a temp DB:

```bash
cd server
DB_PATH=/tmp/markie-pub-smoke.db node --experimental-strip-types -e '
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(process.env.DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT, version INT, content TEXT, hash TEXT, updated_at TEXT, deleted_at TEXT);`);
  db.prepare("INSERT OR REPLACE INTO docs (id,owner_id,name,content,deleted_at) VALUES (?,?,?,?,NULL)").run("d1","u1","Demo Doc","# Hi\n\n- one\n- two");
  const { createOrGetPublicLink } = await import("./src/public-links.ts");
  console.log("TOKEN=" + createOrGetPublicLink("d1","u1"));
'
```

Note the printed `TOKEN=…`. Then start the server against the same DB and curl it:

```bash
DB_PATH=/tmp/markie-pub-smoke.db MARKIE_SITE_URL=https://markie.example.com node --experimental-strip-types src/index.ts &
sleep 1
curl -s "http://localhost:8787/s/<TOKEN>" | grep -o "Demo Doc"        # expect: Demo Doc
curl -s "http://localhost:8787/s/<TOKEN>" | grep -o "<h1>Hi</h1>"     # expect: <h1>Hi</h1>
curl -sI "http://localhost:8787/s/<TOKEN>/raw" | grep -i "content-disposition"  # expect: attachment; filename="Demo Doc.md"
curl -s "http://localhost:8787/s/badtoken" -o /dev/null -w "%{http_code}\n"     # expect: 404
kill %1
```

Expected: title + heading present, raw sets the attachment header, bad token 404s.

- [ ] **Step 4: Commit**

```bash
git add server/src/public.ts server/src/index.ts
git commit -m "feat(server): public /s/:token preview + raw download routes"
```

---

### Task 5: Owner endpoints + wire invite email to the public link

**Files:**
- Modify: `server/src/shares.ts`

- [ ] **Step 1: Import the public-link helpers**

At the top of `server/src/shares.ts`, beside the existing `import { addPending, ... } from "./pending.ts";`, add:

```ts
import {
  createOrGetPublicLink,
  getPublicLinkToken,
  revokePublicLink,
} from "./public-links.ts";
```

- [ ] **Step 2: Add owner public-link endpoints**

In `server/src/shares.ts`, immediately after the `shares.delete("/:id/shares/:idOrEmail", ...)` handler (before the `// ── playful invite email bodies ──` comment), add:

```ts
// Current public link for a doc (owner or member). null when none exists yet.
shares.get("/:id/public-link", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!accessLevel(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const token = getPublicLinkToken(docId);
  return c.json({ url: token ? `${MARKIE_SITE}/s/${token}` : null });
});

// Create (or return) the public link — owner only.
shares.post("/:id/public-link", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const token = createOrGetPublicLink(docId, user.id);
  return c.json({ url: `${MARKIE_SITE}/s/${token}` });
});

// Revoke the public link — owner only.
shares.delete("/:id/public-link", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  revokePublicLink(docId);
  return c.json({ ok: true });
});
```

- [ ] **Step 3: Point the invite email at the public link**

In the unknown-email branch of `shares.post("/:id/shares", ...)`, replace the existing `addPending(...)` + `sendEmail(...)` block with one that also ensures a public link and passes its preview URL into the email:

```ts
  // Unknown email → pending invite + a friendly nudge to join.
  addPending(docId, cleanEmail, role, user.id);
  const previewUrl = `${MARKIE_SITE}/s/${createOrGetPublicLink(docId, user.id)}`;
  await sendEmail({
    to: cleanEmail,
    subject: `📄 ${inviter} tossed you a doc`,
    text: `${inviter} shared "${doc.name}" with you on Markie.\n\nRead it right now (no account needed): ${previewUrl}\n\nReading raw markdown in a browser is a small tragedy — Markie fixes that. Make an account with this email and "${doc.name}" will be waiting in your Library.`,
    html: inviteHtml(inviter, doc.name, previewUrl),
  });
  return c.json({ ok: true, status: "invited", email: cleanEmail, role });
```

- [ ] **Step 4: Update `inviteHtml` to use the preview link**

Replace the existing `inviteHtml` function with one that takes `previewUrl` and gives it the primary button (plus a secondary raw-download link):

```ts
function inviteHtml(
  inviter: string,
  docName: string,
  previewUrl: string
): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:460px;margin:0 auto;color:#18181b">
  <div style="font-size:32px;font-weight:800;color:#f59e0b">M</div>
  <h2 style="font-size:19px;margin:8px 0 4px">${escapeHtml(inviter)} tossed you a doc 📄</h2>
  <p style="font-size:14px;line-height:1.5;color:#3f3f46">They shared <strong>${escapeHtml(docName)}</strong> with you on Markie.</p>
  <p style="font-size:14px;line-height:1.5;color:#3f3f46">No account needed to read it — it's right here, rendered nicely:</p>
  <p style="margin:20px 0">
    <a href="${escapeHtml(previewUrl)}" style="background:#f59e0b;color:#000;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;display:inline-block">Open it →</a>
  </p>
  <p style="font-size:13px;color:#3f3f46">Prefer the file? <a href="${escapeHtml(previewUrl)}/raw" style="color:#b45309">Download the .md</a>. And make an account with this email to keep it in your Library — your markdown will thank you.</p>
</div>`;
}
```

- [ ] **Step 5: Type-check the server compiles**

Run: `cd server && node --experimental-strip-types --check src/shares.ts`
Expected: no output, exit 0 (syntax/type-strip OK).

- [ ] **Step 6: Manual smoke — owner create/revoke + console email shows the link**

Run from `server/` (uses the email→console fallback since no `RESEND_API_KEY`):

```bash
cd server
DB_PATH=/tmp/markie-pub-smoke.db node --experimental-strip-types -e '
  const { createOrGetPublicLink, getPublicLinkToken, revokePublicLink } = await import("./src/public-links.ts");
  const t = createOrGetPublicLink("d1","u1");
  console.log("created:", t, "| get:", getPublicLinkToken("d1"));
  console.log("revoked:", revokePublicLink("d1"), "| get-after:", getPublicLinkToken("d1"));
'
```

Expected: `created` and `get` match; `revoked: true`; `get-after: null`.

- [ ] **Step 7: Commit**

```bash
git add server/src/shares.ts
git commit -m "feat(server): owner public-link endpoints; invite email links to preview"
```

---

### Task 6: Client API for public links

**Files:**
- Modify: `src/lib/auth-client.ts:156-185` (extend the `sharesClient` object)

- [ ] **Step 1: Add public-link methods to `sharesClient`**

In `src/lib/auth-client.ts`, inside the `sharesClient` object, after the `remove(...)` method, add:

```ts
  getPublicLink: async (docId: string): Promise<string | null> => {
    const res = await api<{ url: string | null }>(
      `/api/docs/${encodeURIComponent(docId)}/public-link`
    );
    return res.ok ? res.data?.url ?? null : null;
  },

  createPublicLink: async (docId: string): Promise<string | null> => {
    const res = await api<{ url?: string }>(
      `/api/docs/${encodeURIComponent(docId)}/public-link`,
      { method: "POST", body: "{}" }
    );
    return res.ok ? res.data?.url ?? null : null;
  },

  revokePublicLink: async (docId: string): Promise<boolean> => {
    const res = await api<{ ok?: boolean }>(
      `/api/docs/${encodeURIComponent(docId)}/public-link`,
      { method: "DELETE" }
    );
    return res.ok;
  },
```

- [ ] **Step 2: Type-check**

Run: `cd <repo-root> && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth-client.ts
git commit -m "feat(client): sharesClient public-link get/create/revoke"
```

---

### Task 7: Share dialog — "Anyone with the link" section

**Files:**
- Modify: `src/components/share-dialog.tsx`

- [ ] **Step 1: Add public-link state + load it**

In `src/components/share-dialog.tsx`, add state beside the existing `useState` declarations (after `const [busy, setBusy] = useState(false);`):

```tsx
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);
```

In the existing effect that loads members (the one calling `sharesClient.list(docId)`), after it resolves, also load the public link. If members load inside a `useEffect`/`useCallback` named `refresh` or similar, add this alongside it (same `docId` dependency):

```tsx
    sharesClient.getPublicLink(docId).then((url) => {
      setPublicUrl(url);
    });
```

- [ ] **Step 2: Add create/revoke/copy handlers**

Add these handlers next to the existing `handleAdd`/`handleRemove` functions:

```tsx
  const createLink = async () => {
    setLinkBusy(true);
    const url = await sharesClient.createPublicLink(docId);
    setLinkBusy(false);
    if (url) setPublicUrl(url);
  };

  const revokeLink = async () => {
    setLinkBusy(true);
    const ok = await sharesClient.revokePublicLink(docId);
    setLinkBusy(false);
    if (ok) setPublicUrl(null);
  };

  const copyLink = () => {
    if (!publicUrl) return;
    navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
```

- [ ] **Step 3: Render the section**

In the dialog body, after the members list block and before the closing wrapper of the dialog content, add:

```tsx
        <div className="mt-4 pt-3 border-t border-border">
          <div className="text-[12px] font-medium text-foreground mb-1">
            Anyone with the link
          </div>
          {publicUrl ? (
            <>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={publicUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 text-[12px] bg-background border border-border rounded-md px-2 py-1.5 text-muted outline-none"
                />
                <button
                  onClick={copyLink}
                  className="text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[11px] text-muted">
                  Anyone with this link can view & download — no account needed.
                </span>
                <button
                  onClick={revokeLink}
                  disabled={linkBusy}
                  className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-50"
                >
                  Revoke
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={createLink}
              disabled={linkBusy}
              className="text-[12px] px-3 py-1.5 rounded-md border border-border text-muted hover:text-foreground disabled:opacity-50"
            >
              {linkBusy ? "Creating…" : "Create a public link"}
            </button>
          )}
        </div>
```

- [ ] **Step 4: Type-check + lint**

Run: `cd <repo-root> && npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/share-dialog.tsx
git commit -m "feat(client): public link section in the share dialog"
```

---

### Task 8: Full server test pass + spec/status update

**Files:**
- Modify: `docs/superpowers/specs/2026-06-12-markie-upcoming-features.md` (mark Sharing Phase 2 done)

- [ ] **Step 1: Run the server unit suite**

Run: `cd server && npm test`
Expected: all tests across `render.test.ts` + `public-links.test.ts` pass.

- [ ] **Step 2: Update the upcoming-features doc**

In `docs/superpowers/specs/2026-06-12-markie-upcoming-features.md`, under "Account-optional sharing — Phase 2", change status from parked to shipped, noting the domain is env-driven via `MARKIE_SITE_URL` and no longer blocks.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-12-markie-upcoming-features.md
git commit -m "docs: mark sharing Phase 2 (public links) shipped"
```

---

## Deployment note (not a code task)

The server change must be redeployed to Railway for public links to work in production:
`railway up server --path-as-root --service api --ci` (project markie/production/api).
Ensure `MARKIE_SITE_URL` is set on the service to whatever domain's DNS points at the API host; until a custom domain is wired, it stays `https://markie.zvndev.com`. The `/s/:token` route is served by the API host itself.

## Self-review notes

- **Spec coverage:** `public_links` table ✓ (T3), `POST/DELETE public-link` ✓ (T5), `GET /s/:token` preview ✓ (T4), `/s/:token/raw` download ✓ (T4), email button → public link ✓ (T5), revoked/missing → 404 ✓ (T4), owner-only guards ✓ (T5), existing renderer (OD-2) ✓ (T2), env-driven domain (OD-1) ✓ (uses `MARKIE_SITE`). Public editing remains out of scope (non-goal) ✓.
- **Type consistency:** `createOrGetPublicLink/getPublicLinkToken/resolvePublicToken/revokePublicLink` names identical across T3 (def), T4, T5. `sharesClient.getPublicLink/createPublicLink/revokePublicLink` identical across T6 (def) and T7 (use). Route shape `{ url: string | null }` consistent server (T5) ↔ client (T6).
- **Placeholders:** none — all code is concrete; the only `<TOKEN>` is a runtime value the operator pastes during the T4 smoke check.
