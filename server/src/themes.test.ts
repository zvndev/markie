// The theme store follows the account, and a pinned doc theme is owner-only.
// Both are "opaque JSON" endpoints, which is exactly where authorization slips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { acceptSender, signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-themes-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-themes-test-secret-32-plus-characters";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { themes } = await import("./themes.ts");
const { publicShare } = await import("./public.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", themes);
app.route("/", publicShare);

const stamp = Date.now();

async function call<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    Origin: "http://localhost:3000",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

// Account ids by address, for acceptSender below.
const ids = new Map<string, string>();
async function signUp(name: string, email: string): Promise<string> {
  const { token, id } = await signUpVerified(app, { name, email });
  ids.set(email, id);
  return token;
}

const ownerEmail = `owner-${stamp}@markie.test`;
const viewerEmail = `viewer-${stamp}@markie.test`;
const owner = await signUp("Owner", ownerEmail);
const viewer = await signUp("Viewer", viewerEmail);
const stranger = await signUp("Stranger", `stranger-${stamp}@markie.test`);
// The viewer accepted the owner (share-people.ts), so the owner's shares land.
acceptSender(ids.get(viewerEmail)!, ids.get(ownerEmail)!);

async function sharedDoc(): Promise<string> {
  const docId = randomUUID();
  const content = "# Theme\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  assert.equal(
    (await call("PUT", `/api/docs/${docId}`, owner, {
      name: "theme.md",
      content,
      hash,
      baseVersion: 0,
    })).status,
    200
  );
  assert.equal(
    (await call("POST", `/api/docs/${docId}/shares`, owner, {
      email: viewerEmail,
      role: "viewer",
    })).status,
    200
  );
  return docId;
}

const TOKENS = { background: "#101010", accent: "#f59e0b", fontSize: 16 };

test("the account theme store round-trips, opaquely", async () => {
  const empty = await call<{ store: unknown; updated_at: string | null }>(
    "GET",
    "/api/me/themes",
    owner
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.data?.store, null);
  assert.equal(empty.data?.updated_at, null);

  const store = { activeId: "sunset", custom: [{ id: "sunset", tokens: TOKENS }] };
  const put = await call<{ ok: boolean; updated_at: string }>(
    "PUT",
    "/api/me/themes",
    owner,
    { store }
  );
  assert.equal(put.status, 200);
  assert.ok(put.data?.updated_at);

  const read = await call<{ store: typeof store }>("GET", "/api/me/themes", owner);
  assert.deepEqual(read.data?.store, store);
});

test("the theme store is last-write-wins per account, and private to it", async () => {
  await call("PUT", "/api/me/themes", owner, { store: { activeId: "a", custom: [] } });
  await call("PUT", "/api/me/themes", owner, { store: { activeId: "b", custom: [] } });
  const mine = await call<{ store: { activeId: string } }>("GET", "/api/me/themes", owner);
  assert.equal(mine.data?.store.activeId, "b");

  // another account sees its own store, not the owner's
  const theirs = await call<{ store: unknown }>("GET", "/api/me/themes", stranger);
  assert.equal(theirs.data?.store, null);
});

test("the theme store rejects a non-object payload", async () => {
  for (const store of [null, "dark", 3, undefined]) {
    const res = await call("PUT", "/api/me/themes", owner, { store });
    assert.equal(res.status, 400, JSON.stringify(store));
  }
});

test("the theme routes are closed to unauthenticated callers", async () => {
  assert.equal((await call("GET", "/api/me/themes")).status, 401);
  assert.equal((await call("PUT", "/api/me/themes", undefined, { store: {} })).status, 401);
  const docId = await sharedDoc();
  assert.equal((await call("GET", `/api/docs/${docId}/theme`)).status, 401);
  assert.equal(
    (await call("PUT", `/api/docs/${docId}/theme`, undefined, { tokens: null })).status,
    401
  );
});

test("the owner pins a doc theme and every member reads it", async () => {
  const docId = await sharedDoc();

  const before = await call<{ tokens: unknown }>("GET", `/api/docs/${docId}/theme`, viewer);
  assert.equal(before.status, 200);
  assert.equal(before.data?.tokens, null);

  assert.equal(
    (await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS })).status,
    200
  );

  const after = await call<{ tokens: typeof TOKENS }>(
    "GET",
    `/api/docs/${docId}/theme`,
    viewer
  );
  assert.deepEqual(after.data?.tokens, TOKENS);
});

test("unpinning with null clears the doc theme", async () => {
  const docId = await sharedDoc();
  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS });
  assert.equal(
    (await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: null })).status,
    200
  );
  const read = await call<{ tokens: unknown }>("GET", `/api/docs/${docId}/theme`, owner);
  assert.equal(read.data?.tokens, null);
});

test("only the owner can pin a doc theme", async () => {
  const docId = await sharedDoc();
  for (const token of [viewer, stranger]) {
    const res = await call<{ error: string }>("PUT", `/api/docs/${docId}/theme`, token, {
      tokens: TOKENS,
    });
    assert.equal(res.status, 403);
    assert.equal(res.data?.error, "forbidden");
  }
});

test("a non-member cannot read a doc's theme", async () => {
  const docId = await sharedDoc();
  const res = await call("GET", `/api/docs/${docId}/theme`, stranger);
  assert.equal(res.status, 403);
});

test("pinning rejects a non-object token payload", async () => {
  const docId = await sharedDoc();
  const res = await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: "dark" });
  assert.equal(res.status, 400);
});

test("an unknown doc is a 403, not a leak that it does not exist", async () => {
  const res = await call("GET", `/api/docs/${randomUUID()}/theme`, owner);
  assert.equal(res.status, 403);
});

// ── The Markdown style pinned beside the theme ──────────────────────────────

const STYLE = { base: "technical", name: "Field manual", choices: { tableStyle: "zebra", headingRule: "short" }, numbers: { blockGap: 0.9 } };
const ATTACK = "} body { display: none } .x { background: url(https://evil.test/x)";
type Look = { tokens: unknown; style: unknown };

test("the owner pins a Markdown style beside the theme and every member reads it", async () => {
  const docId = await sharedDoc();
  const put = await call<{ ok: boolean; style: unknown }>("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS, style: STYLE });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data?.style, STYLE);
  const read = await call<Look>("GET", `/api/docs/${docId}/theme`, viewer);
  assert.deepEqual(read.data, { tokens: TOKENS, style: STYLE });
});

test("a pinned style is stored as listed ids and numbers in range, whatever was sent", async () => {
  const docId = await sharedDoc();
  const hostile = {
    base: ATTACK,
    name: `</style><script>alert(1)</script>\n${"x".repeat(500)}`,
    choices: { tableStyle: "grid", linkStyle: ATTACK, bulletStyle: "GRID", customCss: ATTACK, __proto__: { polluted: true } },
    numbers: { imageRadius: 1e308, blockGap: -5, leading: "1; color: red", listIndent: null, zIndex: 9 },
    css: ATTACK,
  };
  assert.equal((await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS, style: hostile })).status, 200);
  const read = await call<{ style: { base: string; name: string; choices: object; numbers: object } }>("GET", `/api/docs/${docId}/theme`, viewer);
  const style = read.data!.style;
  assert.equal(style.base, "spacious");
  assert.deepEqual(style.choices, { tableStyle: "grid" });
  assert.deepEqual(style.numbers, { imageRadius: 24, blockGap: 0.4 });
  assert.equal(style.name.length, 60);
  assert.ok(!style.name.includes("\n"));
  assert.deepEqual(Object.keys(style).sort(), ["base", "choices", "name", "numbers"]);
  assert.ok(!JSON.stringify(style).includes("evil"));
});

test("a style that is not an object is refused", async () => {
  const docId = await sharedDoc();
  for (const style of ["compact", 3, ["compact"], true]) {
    assert.equal((await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS, style })).status, 400, JSON.stringify(style));
  }
});

test("a client that predates styles still pins, reads and unpins, and its pin is the whole look", async () => {
  const docId = await sharedDoc();
  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS, style: STYLE });
  // An old client sends tokens alone. The look is then its theme in the default style.
  assert.equal((await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS })).status, 200);
  const read = await call<Look>("GET", `/api/docs/${docId}/theme`, viewer);
  // It reads `tokens`, exactly as before; `style` is a field it never looks at.
  assert.deepEqual(read.data?.tokens, TOKENS);
  assert.equal(read.data?.style, null);

  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS, style: STYLE });
  assert.equal((await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: null })).status, 200);
  assert.deepEqual((await call<Look>("GET", `/api/docs/${docId}/theme`, viewer)).data, { tokens: null, style: null });
});

test("a style is never pinned without a theme, and only by the owner", async () => {
  const docId = await sharedDoc();
  assert.equal((await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: null, style: STYLE })).status, 200);
  assert.deepEqual((await call<Look>("GET", `/api/docs/${docId}/theme`, viewer)).data, { tokens: null, style: null });
  for (const token of [viewer, stranger]) {
    assert.equal((await call("PUT", `/api/docs/${docId}/theme`, token, { tokens: TOKENS, style: STYLE })).status, 403);
  }
  assert.equal((await call("GET", `/api/docs/${docId}/theme`, stranger)).status, 403);
});

test("a stored style is cleaned again when it is read", async () => {
  const docId = await sharedDoc();
  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS, style: STYLE });
  // As if an older server, or a hand, had written something else into the column.
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  db.prepare("UPDATE docs SET enforced_style = ? WHERE id = ?").run(JSON.stringify({ base: "compact", choices: { tableStyle: ATTACK, quoteStyle: "pull" }, numbers: { leading: 50 } }), docId);
  assert.deepEqual((await call<Look>("GET", `/api/docs/${docId}/theme`, viewer)).data?.style, { base: "compact", choices: { quoteStyle: "pull" }, numbers: { leading: 1.25 } });
  db.prepare("UPDATE docs SET enforced_style = ? WHERE id = ?").run("{not json", docId);
  const broken = await call<Look>("GET", `/api/docs/${docId}/theme`, viewer);
  assert.equal(broken.status, 200);
  assert.equal(broken.data?.style, null);
  assert.deepEqual(broken.data?.tokens, TOKENS);
});

test("a public link hands out the pinned look, cleaned, with no account", async () => {
  const docId = await sharedDoc();
  const link = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner, {});
  assert.equal(link.status, 200);
  const token = new URL(link.data!.url).pathname.split("/").pop()!;

  const none = await call<Look>("GET", `/s/${token}/theme`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.data, { tokens: null, style: null });

  const tokens = { ...TOKENS, surface: "url(https://evil.test/x.png)", foreground: "#fafafa", bodyFont: "charter", headingFont: "x; y", lineHeight: 1.8, onload: "alert(1)", nested: { a: 1 } };
  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens, style: STYLE });
  const read = await call<Look>("GET", `/s/${token}/theme`);
  assert.equal(read.status, 200);
  // Plain colours, numbers and ids only: the url() and the unknown keys are gone.
  assert.deepEqual(read.data?.tokens, { background: "#101010", foreground: "#fafafa", accent: "#f59e0b", fontSize: 16, lineHeight: 1.8, bodyFont: "charter" });
  assert.deepEqual(read.data?.style, STYLE);

  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: null });
  assert.deepEqual((await call<Look>("GET", `/s/${token}/theme`)).data, { tokens: null, style: null });
});

test("a public look is a 404 for a link that does not exist", async () => {
  assert.equal((await call("GET", `/s/${"z".repeat(43)}/theme`)).status, 404);
});

// ── Markdown styles in the account's store ──────────────────────────────────

type Store = { activeId: string; custom: unknown[]; markdownStyle?: unknown };

test("the store's Markdown styles are cleaned on the way in, and the rest stays opaque", async () => {
  const account = await signUp("Styles", `styles-${stamp}@markie.test`);
  const store = {
    activeId: "sunset",
    custom: [{ id: "sunset", tokens: TOKENS, anything: { goes: ATTACK } }],
    markdownStyle: {
      activeId: "style-a",
      profiles: [
        { id: "style-a", name: "Mine", style: { base: "compact", choices: { tableStyle: "zebra", linkStyle: ATTACK } } },
        { id: "BAD ID", name: "x", style: { base: "compact" } },
      ],
      draft: { base: "editorial", numbers: { blockGap: 99 } },
      css: ATTACK,
    },
  };
  assert.equal((await call("PUT", "/api/me/themes", account, { store })).status, 200);
  const read = await call<{ store: Store }>("GET", "/api/me/themes", account);
  assert.deepEqual(read.data?.store.custom, store.custom);
  assert.deepEqual(read.data?.store.markdownStyle, {
    activeId: "style-a",
    profiles: [{ id: "style-a", name: "Mine", style: { base: "compact", name: "Mine", choices: { tableStyle: "zebra" } } }],
    draft: { base: "editorial", numbers: { blockGap: 2 } },
  });
});

test("a build that predates styles saves the store without erasing the account's styles", async () => {
  const account = await signUp("Old build", `old-build-${stamp}@markie.test`);
  const markdownStyle = { activeId: "style-a", profiles: [{ id: "style-a", name: "Mine", style: { base: "classic", name: "Mine" } }] };
  await call("PUT", "/api/me/themes", account, { store: { activeId: "markie-dark", custom: [], markdownStyle } });
  // Desktop 0.9.7 rebuilds the store when a template is chosen and sends it without the field.
  assert.equal((await call("PUT", "/api/me/themes", account, { store: { activeId: "paper-light", custom: [], templateId: "paper", overrides: {} } })).status, 200);
  const read = await call<{ store: Store & { templateId: string } }>("GET", "/api/me/themes", account);
  assert.equal(read.data?.store.templateId, "paper");
  assert.deepEqual(read.data?.store.markdownStyle, markdownStyle);
  // A build that knows styles always names the field, so it can still clear them.
  await call("PUT", "/api/me/themes", account, { store: { activeId: "paper-light", custom: [], markdownStyle: { activeId: "spacious", profiles: [] } } });
  assert.deepEqual((await call<{ store: Store }>("GET", "/api/me/themes", account)).data?.store.markdownStyle, { activeId: "spacious", profiles: [] });
});

test("a store's Markdown styles that are not a store at all are dropped, not stored", async () => {
  const account = await signUp("Junk", `junk-${stamp}@markie.test`);
  await call("PUT", "/api/me/themes", account, { store: { activeId: "a", custom: [], markdownStyle: ATTACK } });
  const read = await call<{ store: Store }>("GET", "/api/me/themes", account);
  assert.equal("markdownStyle" in read.data!.store, false);
});

test("the server's copy of the style lists is the app's file", async () => {
  const { readFileSync } = await import("node:fs");
  const { generated, COPY } = await import("../scripts/sync-markdown-style.mjs");
  // Out of date? Run: (cd server && npm run markdown-style:sync)
  assert.equal(readFileSync(COPY, "utf8"), generated());
});

// ── Typefaces in a pinned style ─────────────────────────────────────────────

test("a pinned style carries its typefaces to a public link, as listed ids only", async () => {
  const docId = await sharedDoc();
  const link = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner, {});
  const token = new URL(link.data!.url).pathname.split("/").pop()!;
  const style = {
    base: "technical",
    choices: {
      bodyFont: "literata",
      headingFont: "body",
      codeFont: "fira-code",
      headingNumbers: "outline",
    },
  };
  // The tokens name a code face too; a public link is handed no token outside
  // its checked list, so the style is what carries it.
  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: { ...TOKENS, codeFont: "fira-code" }, style });
  const read = await call<{ tokens: Record<string, unknown>; style: unknown }>("GET", `/s/${token}/theme`);
  assert.deepEqual(read.data?.style, style);
  assert.equal("codeFont" in read.data!.tokens, false);

  const hostile = {
    base: "compact",
    choices: {
      bodyFont: "local:inter:Evil'; } body { display: none",
      headingFont: "x; background: url(https://evil.test/f.woff2)",
      // A text face is not a code face, and a font on one computer is never stored.
      codeFont: "literata",
      headingNumbers: ATTACK,
    },
  };
  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS, style: hostile });
  assert.deepEqual((await call<Look>("GET", `/s/${token}/theme`)).data?.style, { base: "compact" });
  assert.deepEqual((await call<Look>("GET", `/api/docs/${docId}/theme`, viewer)).data?.style, { base: "compact" });
});
