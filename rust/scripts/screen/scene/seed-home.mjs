// Fixtures for the Recent and Cloud page scenes (docs/rust-port/SCREEN.md).
//   node seed-home.mjs <scratch>            local documents and the servers
//   node seed-home.mjs <scratch> --local    local documents only (no servers)
// Writes <scratch>/docs/* (made-up documents of every kind) and
// <scratch>/home.json: the scene arguments, with throwaway session tokens
// (never printed). Needs `servers.sh start <scratch>` first unless --local.
//
// Primary :18991. Alice owns six documents, two of them shared. Bob shares
// two with her (accepted). Carol and Frank each sent a request she has not
// answered. Erin has an empty account. Second :18995: Dana.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = path.resolve(process.argv[2]);
const localOnly = process.argv.includes("--local");
const PRIMARY = "http://localhost:18991";
const SECOND = "http://localhost:18995";
const PASSWORD = "correct horse battery";
const stamp = Date.now() % 1_000_000;

// ---------------------------------------------------------------- documents
const DOCS = {
  "Quarterly plan.md": `# Quarterly plan

Goals for the quarter, in the order we agreed.

## Ship the new editor

- Rich view on by default
- Tables that keep their widths
- Faster open for large files

## Grow the team

We hire two engineers and one designer before March.

> Keep the plan to one page.
`,
  "Launch checklist.md": `# Launch checklist

- [x] Sign the macOS build
- [x] Update the download page
- [ ] Write the release notes
- [ ] Email early access
- [ ] Watch the update feed for a day

## After launch

1. Read every reply.
2. Fix the first three bugs.
3. Thank the testers.
`,
  "Meeting notes.md": `# Weekly sync

**Present:** Alice, Bob, Carol

## Decisions

The grid view ships first. The list view follows it.

## Actions

| Who | What | When |
| --- | --- | --- |
| Alice | Draft the plan | Monday |
| Bob | Review pricing | Tuesday |
| Carol | Book the venue | Friday |
`,
  "Brand guidelines.md": `# Brand guidelines

## Voice

Plain words. Short sentences. Say what the thing does.

## Colour

Use one accent. Keep the rest quiet.

\`\`\`css
:root {
  --accent: #2f6fed;
  --paper: #fbfaf7;
}
\`\`\`
`,
  "Reading list.md": `# Reading list

1. The Design of Everyday Things
2. A Pattern Language
3. How Buildings Learn
4. The Elements of Typographic Style

*Add one note for each book once you finish it.*
`,
  "Pricing table.csv": `Plan,Seats,Monthly,Yearly
Free,1,0,0
Solo,1,8,80
Team,5,30,300
Studio,20,96,960
Company,100,400,4000
`,
  "Release notes.txt": `Markie 0.9.7

Fixed
  The outline no longer jumps while you type.
  Large files open in under a second.

Changed
  The share dialog shows who is invited.
  Find remembers the last search.
`,
  "settings.json": `{
  "theme": "paper",
  "zoom": 1.1,
  "pageWidth": 720,
  "autosave": true,
  "recent": ["Quarterly plan.md", "Meeting notes.md"]
}
`,
  "deploy.yaml": `service: docs
image: markie/docs
servers:
  web:
    - 10.0.0.4
    - 10.0.0.5
env:
  clear:
    PORT: 8787
`,
  "Homepage.html": `<!doctype html>
<html>
  <head><title>Field notes</title></head>
  <body>
    <h1>Field notes</h1>
    <p>Short essays about writing tools and the people who use them.</p>
    <p>New notes arrive on the first Monday of each month.</p>
  </body>
</html>
`,
  "Roadmap 2027.md": `# Roadmap 2027

## Spring

- Offline comments
- A calmer home page

## Summer

- Templates you can share
- Faster search

## Autumn

- Review mode for long documents
`,
  "Interview notes.md": `# Interview notes

## What they do today

They keep notes in three apps and lose track of which is current.

## What they asked for

- One place for drafts
- Sharing that takes one click
`,
  "Budget draft.md": `# Budget draft

A first pass at next year's numbers.
`,
  "Offsite agenda.md": `# Offsite agenda

Two days. One goal.
`,
};

// `--cards`: the edge cases of a document card. A Markdown document longer
// than two pages that uses every element the reader draws, an empty one, one
// with only front matter, a name too long for its card and a PDF.
const cards = process.argv.includes("--cards");
const FIELD_GUIDE = `---
title: Field guide
tags: [onboarding]
---
# Field guide

Welcome to the **studio**. This guide covers the *first two weeks*: where things are, who to ask, and how we ship. Read it with a coffee; it is meant to be [skimmed](#skim) and kept.

## Your first day

- [x] Collect your laptop from the front desk
- [x] Join the \`#studio\` channel
- [ ] Book a walk with your buddy
- [ ] Read the ~~old~~ new handbook

> We write things down so nobody has to remember them. If you learn something twice, write it here.

## How we plan

1. Each Monday the team picks three goals for the week.
2. Goals are small enough to finish by Thursday.
3. Friday is for review, demos and tidying up.

| Day | Focus | Owner |
| --- | --- | --- |
| Monday | Goals | Lead |
| Tuesday | Build | Everyone |
| Wednesday | Build | Everyone |
| Thursday | Finish | Everyone |
| Friday | Review | Lead |

## Tools

Our documents live in Markie. Code lives in the monorepo and builds with one command:

\`\`\`sh
make setup
make test
make run
\`\`\`

### Writing style

Use plain words and short sentences. Prefer a list to a long paragraph, and a table to a list when there are two dimensions. Headings are labels, not sentences.

### Reviews

Every change gets one reviewer. A review answers two questions: *does it work*, and *will the next person understand it*. Keep comments kind and specific.

---

## The second week

By now you have shipped something small. In the second week you pick up a real project with your buddy. Expect to pair for most of it.

- Pick a project from the board
- Write a one-page plan
- Share it on Wednesday
- Start building on Thursday

### Questions people ask

**Where do I park?** Behind the building, any bay marked green.

**Who approves time off?** Your lead, in the calendar, at least a week ahead.

**What if I break the build?** Tell the channel, fix it or revert it, and write one line about what happened. Everyone has done it.

## Glossary

| Word | Meaning |
| --- | --- |
| Ship | Put it in front of people |
| Demo | Five minutes, a working thing, no slides |
| Tidy | Delete what nobody uses |

## After the first month

Ask your lead for a check-in. Bring one thing that surprised you and one thing you would change. We read every answer and act on the good ones.
`;
const CARD_DOCS = {
  "Field guide.md": FIELD_GUIDE,
  "Empty note.md": "",
  "Front matter only.md": "---\ntitle: Draft\nstatus: idea\n---\n",
  "A document whose name is far too long to fit on one card.md": "# Long names\n\nThe name runs past the card and is cut with an ellipsis.\n",
  // A one-page PDF, made up here: a title and a line of text.
  "Scan.pdf": "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
};

const docs = path.join(dir, "docs");
fs.mkdirSync(docs, { recursive: true });
if (cards) for (const [name, text] of Object.entries(CARD_DOCS)) fs.writeFileSync(path.join(docs, name), text);
const local = ["Quarterly plan.md", "Launch checklist.md", "Meeting notes.md", "Brand guidelines.md", "Reading list.md", "Pricing table.csv", "Release notes.txt", "settings.json", "deploy.yaml", "Homepage.html"];
for (const name of local) fs.writeFileSync(path.join(docs, name), DOCS[name]);
// A Word document: any .docx passed as the third argument is copied in.
const word = process.argv.find((a) => a.endsWith(".docx"));
if (word) fs.copyFileSync(word, path.join(docs, "Offer letter.docx"));

const p = (name) => path.join(docs, name);
// Hours since each was last opened: today, this week, earlier.
const recents = [
  ...(cards ? [{ path: p("Field guide.md"), hours_ago: 0.1 }] : []),
  { path: p("Quarterly plan.md"), hours_ago: 0.4, star: true },
  { path: p("Meeting notes.md"), hours_ago: 2 },
  { path: p("Pricing table.csv"), hours_ago: 5 },
  ...(word ? [{ path: p("Offer letter.docx"), hours_ago: 27 }] : []),
  { path: p("Launch checklist.md"), hours_ago: 30, star: true },
  { path: p("Release notes.txt"), hours_ago: 52 },
  { path: p("Brand guidelines.md"), hours_ago: 75 },
  { path: p("Old proposal.md"), hours_ago: 100 }, // never written: "Missing on disk"
  { path: p("settings.json"), hours_ago: 24 * 9 },
  { path: p("Reading list.md"), hours_ago: 24 * 12, star: true },
  { path: p("deploy.yaml"), hours_ago: 24 * 20 },
  { path: p("Homepage.html"), hours_ago: 24 * 41 },
  ...(cards
    ? [
        { path: p("A document whose name is far too long to fit on one card.md"), hours_ago: 3 },
        { path: p("Empty note.md"), hours_ago: 26 },
        { path: p("Front matter only.md"), hours_ago: 24 * 4 },
        { path: p("Scan.pdf"), hours_ago: 24 * 300 },
      ]
    : []),
];
const out = { docs, recents, word: word ? p("Offer letter.docx") : null };

// ------------------------------------------------------------------ servers
async function call(base, method, pth, body, token) {
  const headers = { "Content-Type": "application/json", Origin: base };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  // The sign-up routes are rate limited: wait the window out and go on.
  for (let i = 0; i < 8; i++) {
    res = await fetch(base + pth, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 11_000));
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${pth} ${res.status} ${text.slice(0, 200)}`);
  return { data, token: res.headers.get("set-auth-token") };
}

async function account(base, name, label) {
  const email = `success+home-${label}-${stamp}@simulator.amazonses.com`;
  await call(base, "POST", "/api/auth/sign-up/email", { email, password: PASSWORD, name });
  const log = path.join(dir, `srv-${new URL(base).port}`, "server.log");
  const needle = `to=${email} subject="`;
  let code;
  for (let i = 0; i < 150 && !code; i++) {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes(needle)) : [];
    code = lines.at(-1)?.split(needle)[1]?.split(" ")[0];
    if (!code) await new Promise((r) => setTimeout(r, 100));
  }
  if (!code) throw new Error(`no code for ${label}`);
  const v = await call(base, "POST", "/api/auth/email-otp/verify-email", { email, otp: code });
  const token = v.token ?? v.data?.token;
  const me = await call(base, "GET", "/api/me", undefined, token);
  return { email, token, user: me.data.user ?? me.data, password: PASSWORD };
}

async function put(owner, name) {
  const id = crypto.randomUUID();
  const content = DOCS[name];
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  await call(PRIMARY, "PUT", `/api/docs/${id}`, { name, content, hash, baseVersion: 0 }, owner.token);
  return id;
}

async function share(owner, id, to, role, accept) {
  await call(PRIMARY, "POST", `/api/docs/${id}/shares`, { email: to.email, role }, owner.token);
  if (!accept) return;
  const reqs = await call(PRIMARY, "GET", "/api/people/requests", undefined, to.token);
  const list = reqs.data.requests ?? [];
  const r = list.find((x) => (x.docId ?? x.doc_id) === id) ?? list[0];
  if (r) await call(PRIMARY, "POST", `/api/people/${r.sender?.id ?? r.senderId}/accept`, {}, to.token);
}

if (!localOnly) {
  const alice = await account(PRIMARY, "Alice Rivera", "alice");
  const bob = await account(PRIMARY, "Bob Chen", "bob");
  const carol = await account(PRIMARY, "Carol Diaz", "carol");
  const frank = await account(PRIMARY, "Frank Osei", "frank");
  const erin = await account(PRIMARY, "Erin Vale", "erin");
  const dana = await account(SECOND, "Dana Self-Host", "dana");
  // Alice's cloud-only documents (her synced local files come from the scene's `sync`).
  await put(alice, "Roadmap 2027.md");
  const brand = await put(alice, "Brand guidelines.md");
  await put(alice, "Release notes.txt");
  await put(alice, "Pricing table.csv");
  await share(alice, brand, bob, "editor", true);
  await share(alice, brand, carol, "viewer", true);
  await call(PRIMARY, "POST", `/api/docs/${brand}/shares`, { email: "success@simulator.amazonses.com", role: "viewer" }, alice.token);
  // Bob shares two with Alice; she accepted him.
  const interview = await put(bob, "Interview notes.md");
  await share(bob, interview, alice, "editor", true);
  const reading = await put(bob, "Reading list.md");
  await share(bob, reading, alice, "viewer", true);
  // Two requests Alice has not answered.
  await share(carol, await put(carol, "Budget draft.md"), alice, "editor", false);
  await share(frank, await put(frank, "Offsite agenda.md"), alice, "viewer", false);
  Object.assign(out, {
    primary: PRIMARY,
    second: SECOND,
    alice: { token: alice.token, email: alice.email },
    erin: { token: erin.token, email: erin.email },
    dana: { token: dana.token, email: dana.email, password: PASSWORD },
    // Local files Alice syncs in the scene, so their cards show "Synced".
    sync: [p("Quarterly plan.md"), p("Meeting notes.md"), p("Launch checklist.md")],
  });
}
fs.writeFileSync(path.join(dir, "home.json"), JSON.stringify(out, null, 2));
console.log(`home fixtures: ${local.length + (word ? 1 : 0)} documents in ${docs}${localOnly ? "" : ", servers seeded"}`);
