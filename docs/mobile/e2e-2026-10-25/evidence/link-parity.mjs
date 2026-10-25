// Byte-for-byte parity of the desktop bridge's markdownLink (electron/agent-cloud.js, used by the
// local MCP's markie_cloud_sync) and the hosted server's (server/src/doc-meta.ts, used by /mcp).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const REPO = process.argv[2];
process.env.BETTER_AUTH_URL = "http://localhost:8791";
process.env.NODE_ENV = "development";
const require = createRequire(import.meta.url);
const desktop = require(`${REPO}/electron/agent-cloud.js`);
const server = await import(`${REPO}/server/src/doc-meta.ts`);

let fail = 0;
const check = (label, a, b) => {
  const ok = Buffer.from(a).equals(Buffer.from(b));
  if (!ok) fail++;
  console.log(`${ok ? "SAME" : "DIFF"}  ${label}\n      desktop: ${a}\n      hosted:  ${b}`);
};

// 1. The documents this run made, against what the running hosted MCP actually returned.
for (const f of ["mcp-create-md.json", "mcp-create-wd.json"]) {
  const r = JSON.parse(readFileSync(`/tmp/markie-e2e/${f}`, "utf8")).result.structuredContent;
  const d = desktop.markdownLinkFor(r.name, desktop.privateLinkFor("http://localhost:8791", r.id));
  check(`${r.name} (live /mcp result)`, d, r.markdownLink);
  check(`${r.name} (server function, same process)`, d, server.markdownLinkFor(r.name, r.id));
}

// 2. Names that exercise every escaping rule, on the official origin.
const id = "2e495e31-1e8e-4883-8ee7-5a18c7edcae5";
const official = desktop.privateLinkFor("https://api.markiedocs.com", id);
const names = [
  "Order total.wd",
  "Plan [draft] <v2> `x`.md",
  "back\\slash.md",
  "line\r\nbreak sep para\n\nruns.md",
  "parens (in name).md",
  "emoji 🚀 and ünïcode.md",
];
for (const n of names) check(JSON.stringify(n), desktop.markdownLinkFor(n, official), server.markdownLink(n, official));
// 3. A URL holding parentheses (self-hosted origin with a path is not possible, so use an id).
const odd = desktop.privateLinkFor("http://localhost:8791", "a(b)c");
check("id with parentheses", desktop.markdownLinkFor("x.md", odd), server.markdownLink("x.md", odd));
// 4. The private link itself.
check("privateLink for the same id", desktop.privateLinkFor("http://localhost:8791", id), server.privateLinkFor(id));
console.log(fail ? `\n${fail} DIFFERENCES` : "\nALL IDENTICAL");
process.exit(fail ? 1 : 0);
