// Hosted Live Docs, H3: an edit reaches an open page within seconds, and a
// page reaches the network only at the https origins its `:fetch` names
// (design, "Build order", H3: "An edit on the Mac shows on the phone within
// seconds, and a :fetch to an unlisted address is blocked").
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-live-docs-h3-")), "t.db");
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8787";
process.env.BETTER_AUTH_SECRET = "markie-live-docs-h3-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.LIVE_DOCS_DOMAIN = "live.localhost:8787";
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { app, liveDocs } = await import("./index.ts");
const { createLiveDocs } = await import("./live-docs.ts");
const { liveDocsConfig } = await import("./live-docs-config.ts");
const { LIVE_DOC_NETWORK_LIMIT } = await import("./live-docs-compile.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);
after(() => db.close());
assert.ok(liveDocs);

const APP_HOST = "127.0.0.1:8787";
const APP_ORIGIN = `http://${APP_HOST}`;
const liveHost = (label: string) => `${label}.live.localhost:8787`;

let callers = 0;
interface Ask { cookie?: string; bearer?: string; method?: string; headers?: Record<string, string>; body?: unknown }
function requestFor(host: string, path: string, init: Ask = {}): [string, RequestInit] {
  callers += 1;
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", `10.88.${Math.floor(callers / 250) % 250}.${callers % 250}`);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return [`http://${host}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }];
}
const ask = (host: string, path: string, init: Ask = {}) => { const [url, request] = requestFor(host, path, init); return app.request(url, request); };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function putDoc(token: string, id: string, name: string, content: string, baseVersion = 0) {
  const res = await ask(APP_HOST, `/api/docs/${id}`, { method: "PUT", bearer: token, body: { name, content, hash: sha(content), baseVersion } });
  assert.equal(res.status, 200, `PUT ${name}: ${await res.clone().text()}`);
}
async function makePublic(token: string, docId: string) {
  assert.equal((await ask(APP_HOST, `/api/docs/${docId}/public-link`, { method: "POST", bearer: token })).status, 200);
}
interface Address { url: string; access: string; publicUrl?: string; network: string[] }
async function addressFor(docId: string, token: string): Promise<Address> {
  const res = await ask(APP_HOST, `/api/docs/${docId}/live-doc`, { bearer: token });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Address;
}
const labelOf = (url: string) => /^http:\/\/([a-z2-7]{16})\./.exec(url)![1]!;
const connectSrc = (csp: string | null) => (csp ?? "").split("; ").find((directive) => directive.startsWith("connect-src "))!.split(" ").slice(1);

interface Tab { res: Response; next(timeoutMs?: number): Promise<{ event: string; data: string } | "closed" | "timeout">; close(): Promise<void> }
async function openTab(response: Response | Promise<Response>): Promise<Tab> {
  const res = await response;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  // One read in flight at a time, kept across calls: a read that outlives a
  // timeout still delivers its chunk to the next call instead of losing it.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    res,
    async next(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const cut = buffer.indexOf("\n\n");
        if (cut !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const lines = block.split("\n").filter((line) => !line.startsWith(":"));
          if (lines.length === 0) continue;
          return {
            event: lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message",
            data: lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"),
          };
        }
        if (ended) return "closed";
        const left = deadline - Date.now();
        if (left <= 0) return "timeout";
        pending ??= reader.read();
        const read = await Promise.race([pending, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), left))]);
        if (read === "timeout") return "timeout";
        pending = null;
        if (read.done) ended = true;
        else buffer += decoder.decode(read.value, { stream: true });
      }
    },
    async close() { await reader.cancel().catch(() => {}); },
  };
}

const stamp = Date.now();
const owner = await signUpVerified(app, { name: "Una Updater", email: `h3-owner-${stamp}@example.com` });
const ROSTER = ':fetch roster from "https://api.example.com/roster"\n\n# Team\n\n@loop roster into person\n- { person.name }\n@endloop\n';

// ── the network list ─────────────────────────────────────────────────────────

test("a page reaches exactly the https origins its :fetch names, and the address says which", async () => {
  const id = `h3-net-${stamp}`;
  await putDoc(owner.token, id, "Roster.wd", ROSTER.replace("# Team", ':fetch scores from "https://stats.example.org/v1/{ team }/scores"\n\n# Team'));
  await makePublic(owner.token, id);
  const address = await addressFor(id, owner.token);
  assert.deepEqual(address.network, ["https://api.example.com", "https://stats.example.org"]);
  const page = await ask(liveHost(labelOf(address.publicUrl!)), "/");
  assert.equal(page.status, 200);
  assert.deepEqual(connectSrc(page.headers.get("content-security-policy")), ["'self'", "https://api.example.com", "https://stats.example.org"]);
  const html = await page.text();
  assert.match(html, /<span data-wd-fetch="" data-wd-fetch-key="roster" data-wd-fetch-url="https:\/\/api\.example\.com\/roster"><\/span>/);
  assert.match(html, /data-wd-fetch-url="https:\/\/stats\.example\.org\/v1\/\{ team \}\/scores"/);
});

test("a page with no :fetch can reach nothing but its own host", async () => {
  const id = `h3-quiet-${stamp}`;
  await putDoc(owner.token, id, "Quiet.wd", ":state n = 1\n\n# Quiet { n }\n");
  await makePublic(owner.token, id);
  const address = await addressFor(id, owner.token);
  assert.deepEqual(address.network, []);
  const page = await ask(liveHost(labelOf(address.publicUrl!)), "/");
  assert.deepEqual(connectSrc(page.headers.get("content-security-policy")), ["'self'"]);
});

test("a :fetch to an address that may not be hosted is dropped, and opens nothing", async () => {
  const id = `h3-bad-${stamp}`;
  const sources = ["http://api.example.com/x", "https://192.168.1.10/x", "https://localhost/x", "https://printer.local/x", "/api/x", "{ base }/x"];
  await putDoc(owner.token, id, "Bad.wd", `${sources.map((url, index) => `:fetch f${index} from "${url}"`).join("\n")}\n\n# Bad\n`);
  await makePublic(owner.token, id);
  const address = await addressFor(id, owner.token);
  assert.deepEqual(address.network, []);
  const page = await ask(liveHost(labelOf(address.publicUrl!)), "/");
  assert.equal(page.status, 200);
  assert.deepEqual(connectSrc(page.headers.get("content-security-policy")), ["'self'"], "the browser blocks every unlisted address");
  // The runtime's own code names the attribute; what must be gone is the marker element.
  assert.ok(!/<span[^>]*data-wd-fetch/.test(await page.text()));
});

test("a :fetch to Markie's own hosts, or to too many places, is refused", async () => {
  const fast = createLiveDocs({ config: liveDocsConfig()!, appOrigin: APP_ORIGIN, siteUrl: "https://markie.test", appHosts: ["https://api.markie-example.com"] });
  const id = `h3-self-${stamp}`;
  await putDoc(owner.token, id, "Self.wd", ':fetch me from "https://api.markie-example.com/api/me"\n\n# Self\n');
  await makePublic(owner.token, id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const [url, init] = requestFor(liveHost(label), "/");
  const res = await fast.dispatch(new Request(url, init))!;
  assert.equal(res.status, 422);
  assert.match(await res.text(), /part of Markie/);

  const many = `h3-many-${stamp}`;
  const fetches = Array.from({ length: LIVE_DOC_NETWORK_LIMIT + 1 }, (_, index) => `:fetch f${index} from "https://host${index}.example.com/x"`).join("\n");
  await putDoc(owner.token, many, "Many.wd", `${fetches}\n\n# Many\n`);
  await makePublic(owner.token, many);
  const manyAddress = await addressFor(many, owner.token);
  assert.deepEqual(manyAddress.network, [], "a page that cannot be hosted reports no network");
  const page = await ask(liveHost(labelOf(manyAddress.publicUrl!)), "/");
  assert.equal(page.status, 422);
  assert.match(await page.text(), new RegExp(`at most ${LIVE_DOC_NETWORK_LIMIT} addresses`));
});

// ── live updates ─────────────────────────────────────────────────────────────

test("an open page hears about an edit at once, and once per version", async () => {
  const id = `h3-live-${stamp}`;
  await putDoc(owner.token, id, "Live.wd", "# One\n");
  await makePublic(owner.token, id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const page = await ask(liveHost(label), "/");
  const html = await page.text();
  const shown = /<meta name="markie-live-version" content="(\d+)">/.exec(html);
  assert.ok(shown, "the page says which version it shows");
  const tab = await openTab(ask(liveHost(label), `/__markie/live?v=${shown[1]}`));
  assert.deepEqual(await tab.next(), { event: "ready", data: "{}" });
  assert.equal(await tab.next(300), "timeout", "nothing to report while nothing changed");

  await putDoc(owner.token, id, "Live.wd", "# Two\n", Number(shown[1]));
  // The write itself re-checks open pages; no waiting for the 5-second timer.
  assert.deepEqual(await tab.next(500), { event: "updated", data: "{}" });
  assert.equal(await tab.next(300), "timeout", "one event per version");
  assert.match(await (await ask(liveHost(label), "/")).text(), /<h1>Two<\/h1>/, "the reload gets the new version");
  await tab.close();
});

test("a page that loaded just before an edit still hears about it", async () => {
  const id = `h3-race-${stamp}`;
  await putDoc(owner.token, id, "Race.wd", "# Before\n");
  await makePublic(owner.token, id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const shown = /<meta name="markie-live-version" content="(\d+)">/.exec(await (await ask(liveHost(label), "/")).text())![1]!;
  // The edit lands between the page load and its stream.
  await putDoc(owner.token, id, "Race.wd", "# After\n", Number(shown));
  const tab = await openTab(ask(liveHost(label), `/__markie/live?v=${shown}`));
  assert.deepEqual(await tab.next(), { event: "ready", data: "{}" });
  assert.deepEqual(await tab.next(500), { event: "updated", data: "{}" });
  await tab.close();
  // A stream that does not say what it shows starts from the current version.
  const fresh = await openTab(ask(liveHost(label), "/__markie/live"));
  assert.deepEqual(await fresh.next(), { event: "ready", data: "{}" });
  assert.equal(await fresh.next(300), "timeout");
  await fresh.close();
});

test("a stream still closes a tab when access ends after an update", async () => {
  const id = `h3-then-${stamp}`;
  await putDoc(owner.token, id, "Then.wd", "# A\n");
  await makePublic(owner.token, id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const tab = await openTab(ask(liveHost(label), "/__markie/live"));
  assert.deepEqual(await tab.next(), { event: "ready", data: "{}" });
  await putDoc(owner.token, id, "Then.wd", "# B\n", 1);
  assert.deepEqual(await tab.next(500), { event: "updated", data: "{}" });
  assert.equal((await ask(APP_HOST, `/api/docs/${id}/public-link`, { method: "DELETE", bearer: owner.token })).status, 200);
  assert.deepEqual(await tab.next(500), { event: "revoked", data: JSON.stringify({ reason: "link" }) });
});

test("the page script handles updates, and only reloads an untouched page", async () => {
  const { LIVE_DOC_CHANNEL_SCRIPT } = await import("./live-docs-page.ts");
  assert.match(LIVE_DOC_CHANNEL_SCRIPT, /addEventListener\("updated",updated\)/);
  assert.match(LIVE_DOC_CHANNEL_SCRIPT, /if\(!touched&&!recently\(\)\)\{/, "an untouched page reloads, but at most once every 30 seconds");
  assert.match(LIVE_DOC_CHANNEL_SCRIPT, /<3e4/);
  assert.match(LIVE_DOC_CHANNEL_SCRIPT, /markie-live-updated/);
  assert.match(LIVE_DOC_CHANNEL_SCRIPT, /markie-live-version/);
  assert.ok(!/innerHTML|eval\(|Function\(/.test(LIVE_DOC_CHANNEL_SCRIPT), "the script builds its bar from text nodes");
});

test("a burst of saves sends an open page at most two notices: one at once, one trailing", async () => {
  const { LIVE_DOC_UPDATE_INTERVAL_MS } = await import("./live-docs-channels.ts");
  const id = `h3-burst-${stamp}`;
  await putDoc(owner.token, id, "Burst.wd", "# Burst\n");
  await makePublic(owner.token, id);
  const label = labelOf((await addressFor(id, owner.token)).publicUrl!);
  const tab = await openTab(ask(liveHost(label), "/__markie/live"));
  assert.deepEqual(await tab.next(), { event: "ready", data: "{}" });
  for (let version = 1; version <= 10; version++) await putDoc(owner.token, id, "Burst.wd", "# Burst\n", version);
  const events: string[] = [];
  const until = Date.now() + LIVE_DOC_UPDATE_INTERVAL_MS + 1_500;
  while (Date.now() < until) {
    const next = await tab.next(until - Date.now());
    if (next === "timeout" || next === "closed") break;
    events.push(next.event);
  }
  await tab.close();
  assert.ok(events.length >= 1 && events.length <= 2, `got ${events.join(", ")}`);
  assert.ok(events.every((event) => event === "updated"));
  // And the page then shows the last version.
  assert.match(await (await ask(liveHost(label), "/")).text(), /<meta name="markie-live-version" content="11">/);
});

test("the address says the network is unknown when the compile could not finish", async () => {
  const busy = createLiveDocs({
    config: liveDocsConfig()!, appOrigin: APP_ORIGIN, siteUrl: "https://markie.test",
    compiler: { compile: async () => ({ ok: false as const, kind: "busy" as const, message: "Live Docs are busy." }), childrenStarted: () => 0, clearCache: () => {} },
  });
  const id = `h3-unknown-${stamp}`;
  await putDoc(owner.token, id, "Unknown.wd", ROSTER);
  const [url, init] = requestFor(APP_HOST, `/api/docs/${id}/live-doc`, { bearer: owner.token });
  const res = await busy.app.request(url, init);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { network: unknown }).network, null);
});
