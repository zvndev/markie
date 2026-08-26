# Markie 0.5.0 "Organized Workspace" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Markie 0.5.0: debounced autosave with drafts and history (gated
behind a rich-editor round-trip fix), virtual project/block organization over
the existing index, the server email-verification fix for the share-takeover
flaw, the Windows auto-update path, and MCP agent instructions.

**Architecture:** Pure logic in `src/lib/` (vitest node project) and small
dependency-injected `electron/*.js` modules (the `snapshots.js` /
`mdindex.js` pattern), UI in `src/components/` (vitest jsdom project),
main-process wiring in `electron/main.js` kept thin, server work in
`server/src/` (node:test), MCP work self-contained in `mcp/`.

**Tech Stack:** TypeScript/JS on Node 22, Electron 41, Next.js 16 static
export, React 19, TipTap 3 + tiptap-markdown, CodeMirror 6, better-sqlite3,
Hono + better-auth, vitest 4, node:test.

**Spec:** `docs/superpowers/specs/2026-08-26-organized-workspace-design.md`.
Read it before starting any task. Sections referenced below as "Spec N.M".

## Global Constraints

- Branch: `feat/organized-workspace-0.5.0` is already checked out. Never
  merge, push, tag, publish, notarize, or deploy. Never run electron-builder
  with `--publish always`.
- Keep green at every commit: `npm test` (baseline 98 files / 1,175 cases,
  grows as you add), `npm run lint` (0 errors), `npm run build` (this is the
  only TypeScript check and enforces the 12MB `out/` budget in CI),
  `node --test mcp/lib.test.mjs`, `(cd server && npm test)` (baseline 148
  cases). `./init.sh` runs the whole gate.
- Never weaken, skip, or delete an existing test to make a task pass.
- No new external dependencies. `js-yaml@^4.1.1` (already a devDependency) may
  be imported from renderer code only; packaged Electron main-process code may
  require only `better-sqlite3`, `electron-updater`, `node-pty`, and Node
  built-ins. `mcp/` stays entirely dependency-free and must not import from
  outside `mcp/`.
- Every commit uses the Lore protocol from `AGENTS.md` (intent line, then only
  the trailers that add real context: Constraint / Rejected / Confidence /
  Scope-risk / Directive / Tested / Not-tested).
- Every new IPC channel must appear in all three of `electron/main.js`,
  `electron/preload.js`, and `src/lib/electron.ts` in the same commit;
  `electron/ipc-contract.test.ts` enforces this.
- No em-dashes in any prose you write (docs, UI copy, comments are exempt but
  avoid them anyway).
- UI uses existing design tokens only (`bg-surface`, `border-border`,
  `text-muted`, `var(--status-*)`) and the documented radius scale
  (`docs/design/radius-scale.md`: cards `rounded-md`, popovers `rounded-lg`,
  modals `rounded-xl`). Both color modes must stay fully legible.
- `src/app/page.tsx` is 1,899 lines today and must not be longer when this
  release is done. Check with `wc -l src/app/page.tsx` at the end of every
  task that touches it.
- Two human checkpoints are pre-declared in the spec (Spec 5.7 SQLite DDL,
  Spec 6.4 MCP additions). Implement them exactly as specced; any deviation
  from that DDL or tool surface requires stopping and escalating.
- Vitest project split: pure `.test.ts` under `src/` or `electron/` runs in
  the node environment; anything needing a DOM (TipTap, components) must be a
  `.test.tsx` under `src/` (jsdom project). `src/test/mock-bridge.ts` is the
  ElectronAPI mock for page/component tests.

## Task order and parallelism

Phases 1 and 2 are strictly sequential (1 blocks 2; inside each phase the
tasks are ordered). Phase 3 requires Phase 2's page extraction (Task 6) but
not the rest of Phase 2. Phase 4 depends only on Phase 3's front matter
convention being settled (Task 13). Phases 5 (server) and 6 (Windows) are
independent of everything and of each other; they can run at any time,
including in parallel worktrees.

| Phase | Tasks | Theme |
|---|---|---|
| 1 | 1-4 | Rich-mode round-trip integrity (blocks autosave) |
| 2 | 5-12 | Autosave, flush-on-transition, drafts, history |
| 3 | 13-23 | Projects: metadata, schema, engine, Files tab, full view, audit |
| 4 | 24-27 | MCP instructions, write-path conventions, drift fixes, plugin skill |
| 5 | 28-30 | Server: dependency upgrades, email verification, claim gating |
| 6 | 31-32 | Windows updater policy + docs reconciliation |
| final | 33 | Full gate, changelog |

---

# Phase 1: Rich-mode round-trip integrity

## Task 1: Extract the rich extension list to a shared module

**Files:**
- Create: `src/lib/rich-extensions.ts`
- Create: `src/lib/rich-extensions.test.ts`
- Modify: `src/components/rich-view.tsx:205-241` (the `useEditor` extensions
  array)

**Interfaces:**
- Produces: `richBaseExtensions(opts?: { collab?: boolean }): AnyExtension[]`
  consumed by `rich-view.tsx` (Task 1), `probeRoundTrip` (Task 2), and the
  round-trip suite (Task 2).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/rich-extensions.test.ts
import { describe, expect, it } from "vitest";
import { richBaseExtensions } from "@/lib/rich-extensions";

const names = (opts?: { collab?: boolean }) =>
  richBaseExtensions(opts).map((e) => e.name);

describe("richBaseExtensions", () => {
  it("contains the full editing surface, in a stable order", () => {
    expect(names()).toEqual([
      "starterKit",
      "tableKit",
      "taskList",
      "taskItem",
      "image",
      "placeholder",
      "markieKeymap",
      "highlight",
      "textStyle",
      "color",
      "fontFamily",
      "fontSize",
      "textAlign",
      "markdown",
    ]);
  });

  it("only differs in undo history between solo and collab", () => {
    // Same extension names either way; collab mode disables StarterKit's
    // undoRedo because the Yjs history replaces it.
    expect(names({ collab: true })).toEqual(names({ collab: false }));
  });
});
```

Note: if an extension's runtime `name` differs from the strings above (for
example StarterKit may report `"starterKit"` or the package may differ), run
the test once, read the actual names from the failure output, and fix the
EXPECTED LIST, not the module. The point of the test is a pinned, stable
list; the exact spelling comes from TipTap.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- src/lib/rich-extensions.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Create the module by moving the array out of rich-view.tsx**

```ts
// src/lib/rich-extensions.ts
// The one list of extensions the rich editor is built from. The editor
// component, the round-trip probe, and the round-trip test suite all import
// this so the probe can never drift from what the real editor does.
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Highlight } from "@tiptap/extension-highlight";
import { MarkieKeymap } from "@/lib/rich-keymap";
import { TextAlign } from "@tiptap/extension-text-align";
import {
  Color,
  FontFamily,
  FontSize,
  TextStyle,
} from "@tiptap/extension-text-style";
import { Markdown } from "tiptap-markdown";
import type { AnyExtension } from "@tiptap/react";

export function richBaseExtensions(
  opts: { collab?: boolean } = {}
): AnyExtension[] {
  return [
    // Collaboration replaces local undo history with the shared Yjs one
    StarterKit.configure(opts.collab ? { undoRedo: false } : {}),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    Placeholder.configure({ placeholder: "Start typing or open a file" }),
    MarkieKeymap,
    // Formatting markdown has no syntax for; serializes as inline HTML.
    // See rich-view.tsx for the full rationale (kept there, where the
    // user-facing trade-off lives).
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Markdown.configure({
      html: true,
      linkify: true,
      breaks: false,
      tightLists: true,
      transformPastedText: true,
    }),
  ];
}
```

In `rich-view.tsx`, replace the inline array inside `useEditor` (lines
208-241) with:

```ts
    extensions: [...richBaseExtensions({ collab: !!session }), ...init.extensions],
```

and delete the now-unused extension imports from `rich-view.tsx` (keep the
Collaboration and CollaborationCaret imports; they stay in the component).
Keep the explanatory comments about HTML serialization by moving them next to
the `richBaseExtensions` call or into the new module.

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/lib/rich-extensions.test.ts && npm test && npm run lint && npm run build`
Expected: all PASS; the full suite stays at 98+ files green (rich-view
behavior is unchanged, only the array moved).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rich-extensions.ts src/lib/rich-extensions.test.ts src/components/rich-view.tsx
git commit -m "$(cat <<'MSG'
Give the rich editor's extension list one home so a probe can trust it

Constraint: The round-trip probe (next task) must test the exact editor
  configuration, not a copy that can drift.
Rejected: Building the probe from a duplicated list | drift is the failure
  mode this release exists to close.
Confidence: high
Scope-risk: narrow
Tested: New extension-list test; full vitest suite unchanged and green.
Not-tested: Visual behavior (unchanged code path).
MSG
)"
```

---

## Task 2: Round-trip probe and the round-trip test suite

**Files:**
- Create: `src/lib/rich-roundtrip.ts`
- Create: `src/lib/rich-roundtrip.test.tsx` (jsdom: TipTap needs a DOM, and
  the dom vitest project only picks up `.test.tsx` under `src/`)

**Interfaces:**
- Consumes: `richBaseExtensions()` from Task 1;
  `formatMarkdownTables` from `src/lib/format-tables.ts`.
- Produces:
  - `probeRoundTrip(markdown: string): { clean: boolean; output: string }`
  - `describeLossRisks(markdown: string): LossRisk[]` where
    `type LossRisk = "footnotes" | "raw-html" | "html-comments" |
    "display-math" | "table-alignment" | "wrapped-paragraphs" |
    "front-matter"`
  consumed by Task 4 (gating) and Task 7 (autosave eligibility).

- [ ] **Step 1: Write the failing suite**

```tsx
// src/lib/rich-roundtrip.test.tsx
import { describe, expect, it } from "vitest";
import { probeRoundTrip, describeLossRisks } from "@/lib/rich-roundtrip";

// Fixtures that MUST survive a parse-serialize round trip byte for byte
// (after Markie's deliberate table re-alignment, which the probe accepts).
const SAFE: Array<[string, string]> = [
  ["heading", "# Title\n\nBody text.\n"],
  ["nested list", "- one\n- two\n  - two.a\n"],
  ["task list", "- [x] done\n- [ ] todo\n"],
  ["fenced code", "```ts\nconst x = 1;\n```\n"],
  ["link and image", "[site](https://example.com)\n\n![alt](img.png)\n"],
  ["blockquote", "> quoted line\n"],
  ["simple table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
  ["hr", "above\n\n---\n\nbelow\n"],
  ["inline math", "Euler: $e^{i\\pi}$ stays.\n"],
];

// Fixtures the current dependency set is expected to change. If one of these
// turns out to round-trip cleanly on this exact TipTap/tiptap-markdown
// version, move it to SAFE with a dated comment; the suite documents real
// behavior, and the gating logic reads the probe, not this table.
const LOSSY: Array<[string, string]> = [
  ["footnote", "Text with a note.[^1]\n\n[^1]: the note\n"],
  ["raw html block", "<div class=\"warn\">\n<b>html</b>\n</div>\n"],
  ["html comment", "before\n\n<!-- keep me -->\n\nafter\n"],
  ["display math", "$$\n\\frac{a}{b} \\, dx\n$$\n"],
  ["table alignment", "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n"],
  ["wrapped paragraph", "This paragraph is wrapped\nacross two lines.\n"],
];

describe("probeRoundTrip", () => {
  for (const [name, md] of SAFE) {
    it(`round-trips: ${name}`, () => {
      const res = probeRoundTrip(md);
      expect(res.clean, `output was:\n${res.output}`).toBe(true);
    });
  }
  for (const [name, md] of LOSSY) {
    it(`detects loss: ${name}`, () => {
      expect(probeRoundTrip(md).clean).toBe(false);
    });
  }

  it("accepts table re-alignment as clean", () => {
    // Ragged pipes; formatMarkdownTables aligns them, which is Markie's
    // documented normalization on any rich edit.
    const ragged = "| a | b |\n|---|-----|\n| 1 | 2 |\n";
    expect(probeRoundTrip(ragged).clean).toBe(true);
  });
});

describe("describeLossRisks", () => {
  it("names each construct", () => {
    expect(describeLossRisks("x[^1]\n\n[^1]: n\n")).toContain("footnotes");
    expect(describeLossRisks("<div>x</div>\n")).toContain("raw-html");
    expect(describeLossRisks("<!-- c -->\n")).toContain("html-comments");
    expect(describeLossRisks("$$\nx\n$$\n")).toContain("display-math");
    expect(describeLossRisks("| a |\n| :--- |\n")).toContain("table-alignment");
    expect(describeLossRisks("---\nkey: v\n---\nbody\n")).toContain("front-matter");
  });
  it("finds nothing in plain prose", () => {
    expect(describeLossRisks("# T\n\nOne line.\n")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/rich-roundtrip.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the probe**

```ts
// src/lib/rich-roundtrip.ts
// Answers one question exactly: if the rich editor parsed this document and
// the user made a single edit, would saving change bytes the user did not
// touch? The probe is exact (parse + serialize with the real extension list)
// rather than a heuristic, so it can never miss a new lossy construct.
import { Editor } from "@tiptap/core";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { formatMarkdownTables } from "@/lib/format-tables";

export type LossRisk =
  | "front-matter"
  | "footnotes"
  | "raw-html"
  | "html-comments"
  | "display-math"
  | "table-alignment"
  | "wrapped-paragraphs";

// A trailing-newline difference is not damage.
const norm = (s: string) => s.replace(/\n+$/, "") + "\n";

export function probeRoundTrip(markdown: string): {
  clean: boolean;
  output: string;
} {
  const editor = new Editor({
    extensions: richBaseExtensions(),
    content: "",
  });
  try {
    editor.commands.setContent(markdown, { emitUpdate: false });
    const storage = editor.storage as unknown as {
      markdown: { getMarkdown(): string };
    };
    const output = formatMarkdownTables(storage.markdown.getMarkdown());
    const reference = formatMarkdownTables(markdown);
    return { clean: norm(output) === norm(reference), output };
  } catch {
    // A document the editor cannot even parse is by definition not safe to
    // rich-edit.
    return { clean: false, output: "" };
  } finally {
    editor.destroy();
  }
}

// Names the constructs for the banner. Best-effort and purely informational:
// gating decisions use probeRoundTrip, never this.
export function describeLossRisks(markdown: string): LossRisk[] {
  const risks: LossRisk[] = [];
  const md = String(markdown ?? "");
  if (/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.test(md)) {
    risks.push("front-matter");
  }
  if (/^\[\^[^\]]+\]:/m.test(md) || /\[\^[^\]]+\]/.test(md)) {
    risks.push("footnotes");
  }
  if (/<!--[\s\S]*?-->/.test(md)) risks.push("html-comments");
  // An HTML tag at line start that is not a comment.
  if (/^<(?!!--)[a-zA-Z][^>]*>/m.test(md)) risks.push("raw-html");
  if (/^\$\$/m.test(md)) risks.push("display-math");
  // A delimiter row cell with alignment colons.
  if (/^\s*\|?\s*:-{2,}|-{2,}:\s*(\||$)/m.test(md)) risks.push("table-alignment");
  // A paragraph line followed directly by another text line (soft wrap).
  if (/^[^\s>#|`\-*\d![<][^\n]*\n[^\s>#|`\-*\d![<]/m.test(md)) {
    risks.push("wrapped-paragraphs");
  }
  return risks;
}
```

If `new Editor({...})` requires an element in this TipTap version, mount it
on a detached node: `element: document.createElement("div")`. jsdom provides
`document` in the dom test project and in the running app.

- [ ] **Step 4: Run and reconcile the fixture table**

Run: `npm test -- src/lib/rich-roundtrip.test.tsx`

If any SAFE fixture fails or any LOSSY fixture round-trips cleanly, that is a
finding about the real dependency set: move the fixture to the other table
with a dated comment (for example `// verified clean on tiptap-markdown 0.9.0,
2026-08-XX`) and, when the totals differ meaningfully from the briefing's "14
of 20 change bytes", note the observed numbers in the spec's Section 2.1
point 5. Do NOT weaken the probe to make a fixture pass. Adjust the
`describeLossRisks` regexes only if a test shows a genuine false negative.

Then: `npm test && npm run lint && npm run build`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rich-roundtrip.ts src/lib/rich-roundtrip.test.tsx
git commit -m "$(cat <<'MSG'
Prove, per document, whether rich editing would rewrite bytes the user never touched

Constraint: Autosave (phase 2) is forbidden until lossy documents refuse
  silent rich serialization; the probe is that gate.
Rejected: A construct blacklist as the gate | a heuristic misses the next
  lossy construct, an exact parse+serialize comparison cannot.
Confidence: high
Scope-risk: narrow
Directive: The gating logic must always read probeRoundTrip, never
  describeLossRisks, which is banner copy only.
Tested: Round-trip suite over safe and lossy fixture tables.
Not-tested: Collab-mode documents (probe is solo-mode by design).
MSG
)"
```

---

## Task 3: Front matter shim (lossless front matter through rich edits)

**Files:**
- Create: `src/lib/front-matter.ts`
- Create: `src/lib/front-matter.test.ts`
- Modify: `src/components/rich-view.tsx` (external-value application effect
  at 451-461, `serializeMarkdown` at 76-83, `flush` at 282-299)
- Modify: `src/lib/rich-roundtrip.test.tsx` (front matter fixtures become
  clean through the shim path)

**Interfaces:**
- Produces:
  - `splitFrontMatter(md: string): { frontMatter: string; body: string }`
  - `joinFrontMatter(frontMatter: string, body: string): string`
  consumed by `rich-view.tsx` (this task), `probe` callers (Task 4), the MCP
  helper mirror (Task 24), and the meta extractor's spec (Task 13 keeps its
  own CJS copy; a parity test ties them, see Task 13 Step 1).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/front-matter.test.ts
import { describe, expect, it } from "vitest";
import { splitFrontMatter, joinFrontMatter } from "@/lib/front-matter";

describe("splitFrontMatter", () => {
  it("splits a leading front matter block verbatim", () => {
    const md = "---\ntitle: X\nmarkie:\n  project: P\n---\n# Body\n";
    const { frontMatter, body } = splitFrontMatter(md);
    expect(frontMatter).toBe("---\ntitle: X\nmarkie:\n  project: P\n---\n");
    expect(body).toBe("# Body\n");
    expect(joinFrontMatter(frontMatter, body)).toBe(md);
  });

  it("requires the block to start at byte zero", () => {
    const md = "\n---\nkey: v\n---\nbody\n";
    expect(splitFrontMatter(md)).toEqual({ frontMatter: "", body: md });
  });

  it("does not treat an unterminated --- as front matter", () => {
    const md = "---\nkey: v\nno closer\n";
    expect(splitFrontMatter(md)).toEqual({ frontMatter: "", body: md });
  });

  it("ignores a thematic break later in the document", () => {
    const md = "# T\n\n---\n\nafter\n";
    expect(splitFrontMatter(md).frontMatter).toBe("");
  });

  it("handles CRLF and the ... terminator", () => {
    const md = "---\r\nkey: v\r\n...\r\nbody\r\n";
    const { frontMatter, body } = splitFrontMatter(md);
    expect(frontMatter).toBe("---\r\nkey: v\r\n...\r\n");
    expect(body).toBe("body\r\n");
  });

  it("does not match a longer dash run", () => {
    const md = "----\nnot front matter\n";
    expect(splitFrontMatter(md).frontMatter).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/front-matter.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/lib/front-matter.ts
// Front matter never enters the rich editor. TipTap has no node for it, so a
// parse turns it into a mangled heading; instead the shim holds it aside
// verbatim and re-attaches it on serialize. Byte-for-byte preservation is a
// hard requirement: agents declare `markie: {project, block}` here and the
// taxonomy reads it back.

export interface SplitDoc {
  frontMatter: string; // "" when the document has none; includes both fences
  body: string;
}

const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

export function splitFrontMatter(md: string): SplitDoc {
  const m = FRONT_MATTER_RE.exec(md);
  if (!m) return { frontMatter: "", body: md };
  return { frontMatter: m[0], body: md.slice(m[0].length) };
}

export function joinFrontMatter(frontMatter: string, body: string): string {
  return frontMatter ? frontMatter + body : body;
}
```

- [ ] **Step 4: Wire the shim into RichView (solo mode only)**

In `rich-view.tsx`:

1. Add a ref near the other refs:

```ts
  // Front matter held aside while the body is in the editor (solo mode).
  // Collab rooms hold parsed content already; the shim does not apply there.
  const frontMatterRef = useRef("");
```

2. In the external-value effect (currently lines 451-461), strip before
   setContent:

```ts
  useEffect(() => {
    if (!editor || session) return;
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const { frontMatter, body } = splitFrontMatter(value);
    frontMatterRef.current = frontMatter;
    applyingExternal.current = true;
    try {
      editor.commands.setContent(body, { emitUpdate: false });
    } finally {
      applyingExternal.current = false;
    }
  }, [value, editor, session]);
```

3. Change `serializeMarkdown` to take the held front matter (make it a
   closure-level helper or pass the ref value):

```ts
function serializeMarkdown(editor: Editor, frontMatter = ""): string {
  const raw = (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown();
  return joinFrontMatter(frontMatter, formatMarkdownTables(raw));
}
```

4. Every call site inside the component passes
   `session ? "" : frontMatterRef.current` (the debounce in `onUpdate` and
   `flush`). The initial `content:` for solo mode also becomes the stripped
   body: change `content: session ? undefined : value` to
   `content: session ? undefined : splitFrontMatter(value).body` and
   initialize `frontMatterRef` from the initial value with a `useState`
   initializer:

```ts
  const [initialSplit] = useState(() => splitFrontMatter(value));
  // ... content: session ? undefined : initialSplit.body,
  // and in the same initializer scope: frontMatterRef.current = initialSplit.frontMatter
```

(Set `frontMatterRef.current = initialSplit.frontMatter` in a `useEffect`
that runs once, or initialize the ref lazily; either is fine as long as the
first serialize sees it.)

- [ ] **Step 5: Extend the round-trip suite through the shim**

Add to `src/lib/rich-roundtrip.test.tsx`:

```tsx
import { splitFrontMatter, joinFrontMatter } from "@/lib/front-matter";

describe("front matter shim", () => {
  it("carries front matter through a probe untouched", () => {
    const md = "---\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\n# Doc\n\nBody.\n";
    const { frontMatter, body } = splitFrontMatter(md);
    const res = probeRoundTrip(body);
    expect(res.clean).toBe(true);
    expect(joinFrontMatter(frontMatter, res.output)).toBe(
      joinFrontMatter(frontMatter, body)
    );
  });
});
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run lint && npm run build`
Expected: PASS, including all existing rich-view-dependent page tests (the
shim must be invisible for documents without front matter).

- [ ] **Step 7: Commit**

```bash
git add src/lib/front-matter.ts src/lib/front-matter.test.ts src/components/rich-view.tsx src/lib/rich-roundtrip.test.tsx
git commit -m "$(cat <<'MSG'
Hold front matter aside so rich edits can never mangle it

Constraint: Agents declare markie:{project,block} in front matter and the
  0.5.0 taxonomy reads it back; one rich edit destroying it would break the
  headline feature.
Rejected: Teaching TipTap a front-matter node | far larger surface, and the
  bytes must be preserved verbatim, which a parse cannot promise.
Confidence: high
Scope-risk: moderate
Directive: The shim is solo-mode only; collab rooms keep parsed content.
Tested: front-matter unit suite, shim round-trip case, full vitest suite.
Not-tested: Front matter behavior inside live collab sessions (unchanged,
  known-lossy, documented in the spec).
MSG
)"
```

---

## Task 4: Gate rich editing on the probe, with an explicit override

**Files:**
- Create: `src/lib/rich-override.ts`
- Create: `src/lib/rich-override.test.ts`
- Create: `src/components/rich-guard.tsx`
- Create: `src/components/rich-guard.test.tsx`
- Modify: `src/app/page.tsx` (probe state, RichView props, banner mount)

**Interfaces:**
- Consumes: `probeRoundTrip`, `describeLossRisks` (Task 2),
  `splitFrontMatter` (Task 3).
- Produces:
  - `richOverride(path: string | null): boolean` /
    `setRichOverride(path: string | null, on: boolean): void`
    (localStorage key `markie.richoverride.v1:<path>`, untitled uses the
    fileName or `"untitled"`).
  - `<RichLossBanner risks onEditSource onOverride />` component.
  - Page state `richLossy: LossRisk[] | null` consumed by Task 7's
    autosave-eligibility rule.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/rich-override.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { richOverride, setRichOverride } from "@/lib/rich-override";

describe("rich override", () => {
  beforeEach(() => localStorage.clear());

  it("defaults off and persists per path", () => {
    expect(richOverride("/a/x.md")).toBe(false);
    setRichOverride("/a/x.md", true);
    expect(richOverride("/a/x.md")).toBe(true);
    expect(richOverride("/a/y.md")).toBe(false);
  });

  it("treats null path as the untitled document", () => {
    setRichOverride(null, true);
    expect(richOverride(null)).toBe(true);
  });
});
```

Note: this file uses localStorage, so make it `.test.ts` ONLY if the node
project provides localStorage (it does not). Name it
`src/lib/rich-override.test.tsx` so it runs in the jsdom project.

```tsx
// src/components/rich-guard.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RichLossBanner } from "@/components/rich-guard";

describe("RichLossBanner", () => {
  it("names the constructs and offers both exits", async () => {
    const onEditSource = vi.fn();
    const onOverride = vi.fn();
    render(
      <RichLossBanner
        risks={["footnotes", "raw-html"]}
        onEditSource={onEditSource}
        onOverride={onOverride}
      />
    );
    expect(screen.getByRole("status").textContent).toMatch(/footnotes/i);
    await userEvent.click(screen.getByRole("button", { name: /edit in source/i }));
    expect(onEditSource).toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /edit rich anyway/i })
    );
    expect(onOverride).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/rich-override.test.tsx src/components/rich-guard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the override store and banner**

```ts
// src/lib/rich-override.ts
// The user's explicit "yes, normalize this document" consent, per document,
// per machine. localStorage on purpose: this is an editing preference, not
// document data, and it must survive restarts but need not sync.
const KEY = (path: string | null) =>
  `markie.richoverride.v1:${path ?? "untitled"}`;

export function richOverride(path: string | null): boolean {
  try {
    return window.localStorage.getItem(KEY(path)) === "1";
  } catch {
    return false;
  }
}

export function setRichOverride(path: string | null, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY(path), "1");
    else window.localStorage.removeItem(KEY(path));
  } catch {
    // storage unavailable: the choice lasts for the session via page state
  }
}
```

```tsx
// src/components/rich-guard.tsx
import type { LossRisk } from "@/lib/rich-roundtrip";

const LABELS: Record<LossRisk, string> = {
  "front-matter": "front matter",
  footnotes: "footnotes",
  "raw-html": "raw HTML",
  "html-comments": "HTML comments",
  "display-math": "display math",
  "table-alignment": "table alignment",
  "wrapped-paragraphs": "wrapped lines",
};

export function RichLossBanner({
  risks,
  onEditSource,
  onOverride,
}: {
  risks: LossRisk[];
  onEditSource: () => void;
  onOverride: () => void;
}) {
  const what =
    risks.length > 0
      ? risks.map((r) => LABELS[r]).join(", ")
      : "formatting the rich editor cannot represent";
  return (
    <div
      role="status"
      className="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-foreground flex items-center gap-2 flex-wrap"
    >
      <span className="min-w-0">
        Rich editing is off for this file: it uses {what} that the rich editor
        would rewrite.
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onEditSource}
          className="h-6 px-2 rounded-md border border-border bg-surface hover:bg-accent/40 text-[11.5px]"
        >
          Edit in Source
        </button>
        <button
          type="button"
          onClick={onOverride}
          className="h-6 px-2 rounded-md text-muted hover:text-foreground text-[11.5px]"
          title="Rich edits will normalize this document's formatting"
        >
          Edit rich anyway
        </button>
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Wire the probe into the page**

In `page.tsx`:

1. New state near the other document state:

```ts
  // Constructs the rich editor would rewrite in the open document, or null
  // when the document is rich-safe. Drives the read-only guard and, in
  // phase 2, autosave eligibility.
  const [richLossy, setRichLossy] = useState<LossRisk[] | null>(null);
  const [richOverridden, setRichOverridden] = useState(false);
```

2. Probe whenever a document lands (in `loadFile`, `handleNewFile`, and the
   boot path, right after `setSavedContent`), via one helper:

```ts
  const assessRichSafety = useCallback((md: string, path: string | null) => {
    const { body } = splitFrontMatter(md);
    // Empty and trivially small documents are always safe; skip the parse.
    const res = body.trim() ? probeRoundTrip(body) : { clean: true, output: "" };
    setRichLossy(res.clean ? null : describeLossRisks(md));
    setRichOverridden(richOverride(path));
  }, []);
```

Call `assessRichSafety(md, data.path)` at the end of `loadFile`,
`assessRichSafety("", null)` in `handleNewFile`, and for the boot
sample/welcome paths. Do not re-probe on every keystroke: the probe protects
the bytes as they were opened; once the user edits (or overrides), the
decision stands until the next document load.

3. Compute the guard and pass it down where `<RichView>` renders:

```ts
  const richBlocked = richLossy !== null && !richOverridden;
```

- `<RichView ... readOnly={!docEditable || richBlocked} />`
- Above the rich pane (inside the `mode === "preview" || mode === "split"`
  branch, before the `ErrorBoundary`), render:

```tsx
  {richBlocked && !collabCfg && (
    <RichLossBanner
      risks={richLossy ?? []}
      onEditSource={() => setMode("edit")}
      onOverride={() => {
        setRichOverride(filePath, true);
        setRichOverridden(true);
      }}
    />
  )}
```

Layout note: the banner belongs inside the rich pane's flex column so the
Source pane in split mode is unaffected; wrap the rich pane content in a
`flex flex-col` container if it is not one already, with the banner first.

- [ ] **Step 5: Page-level regression test**

Create `src/app/page.richguard.test.tsx` following the `page.save.test.tsx`
pattern (mock bridge, boot with `getInitialFile`):

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

import Home from "./page";

const LOSSY = {
  name: "notes.md",
  path: "/notes/notes.md",
  content: "Text with a note.[^1]\n\n[^1]: the note\n",
};
const CLEAN = { name: "plain.md", path: "/notes/plain.md", content: "# Hi\n\nBody.\n" };

describe("rich loss guard", () => {
  it("locks rich editing for a lossy document and unlocks on override", async () => {
    installBridge({ getInitialFile: vi.fn(async () => LOSSY) } as Partial<ElectronAPI>);
    render(<Home />);
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toMatch(/rich editing is off/i);
    await userEvent.click(screen.getByRole("button", { name: /edit rich anyway/i }));
    await waitFor(() =>
      expect(screen.queryByText(/rich editing is off/i)).not.toBeInTheDocument()
    );
  });

  it("shows no banner for a clean document", async () => {
    installBridge({ getInitialFile: vi.fn(async () => CLEAN) } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("Body.");
    expect(screen.queryByText(/rich editing is off/i)).not.toBeInTheDocument();
  });
});
```

Adjust the `role="status"` query if the collab error banner also uses it;
scope with `within` on the rich pane or give the loss banner a
`data-markie-rich-guard` attribute and query that.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run lint && npm run build && wc -l src/app/page.tsx`
Expected: all green; page.tsx grew by only the guard wiring (roughly +40
lines is acceptable at this stage; Task 6 pays it back).

- [ ] **Step 7: Commit**

```bash
git add src/lib/rich-override.ts src/lib/rich-override.test.tsx src/components/rich-guard.tsx src/components/rich-guard.test.tsx src/app/page.tsx src/app/page.richguard.test.tsx
git commit -m "$(cat <<'MSG'
Refuse silent rich rewrites: lossy documents open read-only in Rich with a way out

Constraint: Autosave lands next phase; without this gate it would corrupt
  footnotes, raw HTML, and math in files agents and git are watching.
Rejected: Forcing Source mode on lossy files | the rendered view is Markie's
  core value; read-only rich keeps it while removing the corruption path.
Confidence: medium
Scope-risk: moderate
Directive: Never enable autosave for a document where richBlocked is true
  and the rich pane is the editing surface.
Tested: Guard unit + component tests, page-level lossy/clean/override tests,
  full suite green.
Not-tested: Real-world corpus beyond the fixture tables; the probe is exact
  per document so unknown constructs fail closed.
MSG
)"
```

---

# Phase 2: Autosave, drafts, and history

## Task 5: Pure autosave scheduler

**Files:**
- Create: `src/lib/autosave.ts`
- Create: `src/lib/autosave.test.ts`

**Interfaces:**
- Produces:

```ts
createAutosave(opts: {
  idleMs?: number;              // default 1000
  maxWaitMs?: number;           // default 5000
  save: () => Promise<boolean>; // true = committed; false = refused/failed
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
}): {
  noteChange(): void;
  flush(): Promise<boolean>;
  cancel(): void;
  isPending(): boolean;
}
```

  consumed by Task 7's wiring and Task 8's flush-on-transition.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/autosave.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave } from "@/lib/autosave";

describe("createAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once after the idle delay", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save });
    a.noteChange();
    a.noteChange();
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.isPending()).toBe(false);
  });

  it("resets the idle timer on each change but honors maxWait", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save, idleMs: 1000, maxWaitMs: 5000 });
    // Type every 500ms forever; the idle timer alone would never fire.
    for (let i = 0; i < 9; i++) {
      a.noteChange();
      await vi.advanceTimersByTimeAsync(500);
    }
    // 4500ms into the burst; maxWait forces a save at 5000ms.
    expect(save).not.toHaveBeenCalled();
    a.noteChange();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush saves immediately when dirty and is a no-op when clean", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save });
    await expect(a.flush()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
    a.noteChange();
    await expect(a.flush()).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1); // timer was cleared by flush
  });

  it("changes during an in-flight save trigger one follow-up save", async () => {
    let release!: (v: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((r) => (release = r))
      )
      .mockImplementation(async () => true);
    const a = createAutosave({ save });
    a.noteChange();
    await vi.advanceTimersByTimeAsync(1000); // first save starts, hangs
    a.noteChange(); // edit while saving
    release(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("cancel drops pending work silently", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save });
    a.noteChange();
    a.cancel();
    await vi.runAllTimersAsync();
    expect(save).not.toHaveBeenCalled();
  });

  it("a save that reports false stays quiet until the next change", async () => {
    const save = vi.fn(async () => false);
    const a = createAutosave({ save });
    a.noteChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    // No retry loop: a refused save (disk conflict) waits for the caller to
    // resolve the situation and call noteChange again.
    expect(save).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/autosave.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/autosave.ts
// Google-Docs-style write scheduling, kept pure so the timing rules are
// testable with fake clocks. One rule pair: save after idleMs of quiet, but
// never let a continuous burst outrun maxWaitMs. No retry policy lives here:
// a refused save is the caller's situation to resolve.

export interface AutosaveOptions {
  idleMs?: number;
  maxWaitMs?: number;
  save: () => Promise<boolean>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
}

export interface Autosave {
  noteChange(): void;
  flush(): Promise<boolean>;
  cancel(): void;
  isPending(): boolean;
}

export function createAutosave(opts: AutosaveOptions): Autosave {
  const idleMs = opts.idleMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 5000;
  const setT = opts.setTimer ?? setTimeout;
  const clearT = opts.clearTimer ?? clearTimeout;
  const now = opts.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let burstStart: number | null = null;
  let dirty = false;
  let saving = 0;
  // All saves run on one chain so two writes can never interleave.
  let chain: Promise<boolean> = Promise.resolve(true);

  const clear = () => {
    if (timer !== null) clearT(timer);
    timer = null;
  };

  const commit = (): Promise<boolean> => {
    clear();
    burstStart = null;
    if (!dirty) return chain;
    dirty = false;
    saving += 1;
    chain = chain
      .then(() => opts.save(), () => opts.save())
      .catch(() => false)
      .finally(() => {
        saving -= 1;
      });
    return chain;
  };

  return {
    noteChange() {
      dirty = true;
      if (burstStart === null) burstStart = now();
      clear();
      const elapsed = now() - burstStart;
      const wait = Math.max(0, Math.min(idleMs, maxWaitMs - elapsed));
      timer = setT(() => {
        timer = null;
        void commit();
      }, wait);
    },
    flush() {
      if (!dirty) return chain;
      return commit();
    },
    cancel() {
      clear();
      burstStart = null;
      dirty = false;
    },
    isPending() {
      return dirty || saving > 0;
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/lib/autosave.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/autosave.ts src/lib/autosave.test.ts
git commit -m "$(cat <<'MSG'
Add the autosave clock: idle-debounced saves a long burst cannot postpone forever

Constraint: The save model is locked as 1s idle plus a hard max-wait so a
  continuous typing burst still lands on disk.
Rejected: Retrying refused saves inside the scheduler | a disk conflict must
  surface to the user, not spin.
Confidence: high
Scope-risk: narrow
Tested: Fake-timer suite covering idle, max-wait, flush, cancel, in-flight
  overlap, and refused saves.
Not-tested: Wiring into the page (next tasks).
MSG
)"
```

---

## Task 6: Extract document state from page.tsx into useDocument

**Files:**
- Create: `src/lib/use-document.ts`
- Create: `src/lib/use-document.test.tsx` (renderHook needs jsdom)
- Modify: `src/app/page.tsx` (remove the five useState declarations and the
  transitions they own; consume the hook)

**Interfaces:**
- Produces (consumed by page.tsx now, extended by Tasks 7-9):

```ts
export interface LoadPayload {
  name: string;
  content: string;
  path: string | null;
  unsaved?: boolean;
}
export function useDocument(): {
  content: string;
  savedContent: string;
  fileName: string | null;
  filePath: string | null;
  isDirty: boolean;
  edit(md: string): void;          // user typing; the only autosave trigger
  applyExternal(md: string): void; // pull/reload; sets saved too
  load(data: LoadPayload): void;   // document landed
  reset(): void;                   // new untitled buffer
  markSaved(md: string): void;     // a save committed this markdown
  setLocation(path: string | null, name: string | null): void; // Save As / rename
};
```

- [ ] **Step 1: Write the failing hook tests**

```tsx
// src/lib/use-document.test.tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDocument } from "@/lib/use-document";

describe("useDocument", () => {
  it("tracks dirty state across edit and markSaved", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.edit("one two"));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.markSaved("one two"));
    expect(result.current.isDirty).toBe(false);
  });

  it("load with unsaved keeps the buffer dirty (snapshot/draft restore)", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "fresh", path: "/a.md" }));
    act(() =>
      result.current.load({ name: "a.md", content: "old version", path: "/a.md", unsaved: true })
    );
    expect(result.current.content).toBe("old version");
    expect(result.current.isDirty).toBe(true);
  });

  it("applyExternal replaces content without dirtying", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    act(() => result.current.applyExternal("server copy"));
    expect(result.current.content).toBe("server copy");
    expect(result.current.isDirty).toBe(false);
  });

  it("reset clears to an untitled buffer", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    act(() => result.current.reset());
    expect(result.current.filePath).toBeNull();
    expect(result.current.fileName).toBeNull();
    expect(result.current.content).toBe("");
    expect(result.current.isDirty).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement the hook**

Run: `npm test -- src/lib/use-document.test.tsx` (FAIL), then:

```ts
// src/lib/use-document.ts
"use client";
// The document buffer, extracted from page.tsx so autosave, drafts, and
// flush-on-transition have one owner to attach to instead of five useStates
// scattered through a 1,900-line component. Behavior is a byte-for-byte copy
// of what page.tsx did; the existing page.*.test.tsx suites are the proof.
import { useCallback, useMemo, useState } from "react";

export interface LoadPayload {
  name: string;
  content: string;
  path: string | null;
  unsaved?: boolean;
}

export function useDocument() {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);

  const edit = useCallback((md: string) => setContent(md), []);

  const applyExternal = useCallback((md: string) => {
    setContent(md);
    setSavedContent(md);
  }, []);

  const load = useCallback((data: LoadPayload) => {
    setContent(data.content);
    setFileName(data.name);
    setFilePath(data.path);
    // A snapshot/draft restore arrives with unsaved:true: savedContent keeps
    // its previous value so the document shows dirty until the user commits.
    // This mirrors page.tsx's original line 609 exactly.
    if (!data.unsaved) setSavedContent(data.content);
  }, []);

  const reset = useCallback(() => {
    setContent("");
    setSavedContent("");
    setFileName(null);
    setFilePath(null);
  }, []);

  const markSaved = useCallback((md: string) => setSavedContent(md), []);

  const setLocation = useCallback(
    (path: string | null, name: string | null) => {
      setFilePath(path);
      setFileName(name);
    },
    []
  );

  return useMemo(
    () => ({
      content,
      savedContent,
      fileName,
      filePath,
      isDirty: content !== savedContent,
      edit,
      applyExternal,
      load,
      reset,
      markSaved,
      setLocation,
    }),
    [content, savedContent, fileName, filePath, edit, applyExternal, load, reset, markSaved, setLocation]
  );
}
```

- [ ] **Step 3: Swap page.tsx onto the hook**

Mechanical, behavior-preserving replacement in `page.tsx`:

- Delete the `content` (175), `fileName` (178), `filePath` (179),
  `savedContent` (180) useStates and `isDirty` (257).
- Add `const doc = useDocument();` and
  `const { content, fileName, filePath, isDirty } = doc;`.
- Replace writes:
  - Typing paths (the `onChange` props of `Editor` and `RichView`, the
    format-tables command and menu handler): `doc.edit(x)`. For the
    format-tables case, which uses a functional update
    (`setContent((prev) => formatMarkdownTables(prev))`), read
    `docRef.current.content` and call `doc.edit(formatMarkdownTables(...))`.
  - `handlePullUpdate` / `handleConflictResolved` / `reloadFromDisk` / the
    save handler's `reloaded` branch: `doc.applyExternal(pulled)`.
  - `loadFile` body: `doc.load({ name: data.name, content: md, path: data.path, unsaved: data.unsaved })`
    replaces the four set calls.
  - `handleNewFile`: `doc.reset()`.
  - `handleSave` success: `doc.markSaved(md)`; `handleSaveAs` success:
    `doc.setLocation(res.path, res.name); doc.markSaved(md)`.
  - `handleRename` success: `doc.setLocation(res.path, res.name)`.
  - Boot effect sample/welcome branches: `doc.applyExternal(WELCOME_DOC)` /
    `doc.applyExternal(SAMPLE)`.
- `docRef` (269-272) keeps working off the destructured values.

Work in small groups of edits, running `npm test -- src/app` between groups.
Every one of the six existing `page.*.test.tsx` suites must pass unchanged;
if one fails, the extraction changed behavior: fix the extraction, never the
test.

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run lint && npm run build && wc -l src/app/page.tsx`
Expected: green; `page.tsx` is now shorter than 1,899 lines.

- [ ] **Step 5: Commit**

```bash
git add src/lib/use-document.ts src/lib/use-document.test.tsx src/app/page.tsx
git commit -m "$(cat <<'MSG'
Give the document buffer one owner before autosave moves in

Constraint: page.tsx is a 1,899-line component and both 0.5.0 feature tracks
  add document state; the seam is extracted first so they cannot make it worse.
Rejected: Wiring autosave straight into page.tsx | five scattered useStates
  with implicit invariants is how the discard-on-switch P0 happened.
Confidence: medium
Scope-risk: moderate
Directive: edit() is the only path that may ever arm autosave; loads, pulls,
  and reloads must go through load()/applyExternal().
Tested: New hook suite; all six existing page.*.test.tsx suites unchanged
  and green.
Not-tested: Autosave (not wired yet).
MSG
)"
```

---

## Task 7: Wire autosave end to end (renderer + main-process conflict rule)

**Files:**
- Create: `electron/save-conflict.js`
- Create: `electron/save-conflict.test.ts`
- Modify: `electron/main.js` `save-file` handler (835-877)
- Modify: `src/lib/electron.ts` (`saveFile` args gain `autosave?: boolean`;
  `SaveResult.code` union gains `"disk-changed"`)
- Modify: `src/app/page.tsx` (arm autosave; `handleSave` gains `autosave`;
  disk-changed routing)
- Create: `src/app/page.autosave.test.tsx`

`electron/preload.js` needs no change: `saveFile` already forwards the whole
args object (`saveFile: (args) => ipcRenderer.invoke("save-file", args)`).
Verify that and leave it alone.

**Interfaces:**
- Consumes: `createAutosave` (Task 5), `useDocument` (Task 6), `richBlocked`
  and `richLossy` (Task 4).
- Produces:
  - `saveConflictAction({ autosave, force, changed }): "proceed" | "ask" | "refuse"`
    in `electron/save-conflict.js`.
  - `handleSave(opts?: { force?: boolean; autosave?: boolean })` in page.tsx.
  - Autosave armed for eligible documents; Task 8 reuses
    `autosaveRef.current.flush()`.

- [ ] **Step 1: Failing test for the main-process rule**

```ts
// electron/save-conflict.test.ts
import { describe, expect, it } from "vitest";
const { saveConflictAction } = require("./save-conflict.js");

describe("saveConflictAction", () => {
  it("proceeds when the disk is unchanged", () => {
    expect(saveConflictAction({ autosave: false, force: false, changed: null })).toBe("proceed");
    expect(saveConflictAction({ autosave: true, force: false, changed: null })).toBe("proceed");
  });
  it("force always proceeds (the user already answered in-app)", () => {
    expect(saveConflictAction({ autosave: false, force: true, changed: "x" })).toBe("proceed");
    expect(saveConflictAction({ autosave: true, force: true, changed: "x" })).toBe("proceed");
  });
  it("a manual save over a changed disk asks", () => {
    expect(saveConflictAction({ autosave: false, force: false, changed: "x" })).toBe("ask");
  });
  it("an autosave over a changed disk refuses without asking", () => {
    expect(saveConflictAction({ autosave: true, force: false, changed: "x" })).toBe("refuse");
  });
});
```

Run: `npm test -- electron/save-conflict.test.ts` (FAIL), then implement:

```js
// electron/save-conflict.js
// One rule for what a save may do when the file changed underneath us.
// Extracted from main.js so the autosave-must-never-dialog invariant is a
// tested fact instead of an if-statement nobody can see.
//
// force means the renderer already put the question to the user (the in-app
// conflict dialog) and they chose to overwrite; asking again would be a
// second prompt for an answered question. autosave means nobody is looking:
// a dialog would interrupt typing, and a blind write would destroy the other
// writer's work, so the only correct move is to refuse and let the renderer
// surface its non-modal strip.
function saveConflictAction({ autosave = false, force = false, changed = null } = {}) {
  if (force || changed === null) return "proceed";
  return autosave ? "refuse" : "ask";
}

module.exports = { saveConflictAction };
```

- [ ] **Step 2: Use the rule in main.js**

In the `save-file` handler, accept `autosave = false` in the args and replace
the decision around the existing dialog:

```js
handle("save-file", async (_event, { filePath, content, force = false, autosave = false }) => {
  try {
    const access = fileGrants.canWrite(filePath);
    if (!access.ok) return { success: false, error: access.error };

    const changed = diskChangedSince(access.path);
    const action = saveConflictAction({ autosave, force, changed });
    if (action === "refuse") {
      // Nobody is watching an autosave. Hand the newer disk content back so
      // the renderer's strip/dialog can offer the real choice.
      return { success: false, code: "disk-changed", path: access.path, content: changed };
    }
    if (action === "ask") {
      const { response } = await dialog.showMessageBox(mainWindow, {
        // ... existing options verbatim (type, buttons, message, detail) ...
      });
      if (response === 2) return { success: false, canceled: true };
      if (response === 0) {
        rememberDisk(access.path, changed);
        return { success: false, code: "reloaded", path: access.path, content: changed };
      }
      // response === 1: overwrite; fall through.
    }
    // ... existing snapshotBeforeWrite / writeFileAtomic / rememberDisk /
    // setCurrentDoc / return, unchanged ...
```

Add `const { saveConflictAction } = require("./save-conflict");` next to the
other local requires. In `src/lib/electron.ts`, extend the `saveFile` args
with `autosave?: boolean` and widen `code` to `"reloaded" | "disk-changed"`.

- [ ] **Step 3: Arm autosave in the renderer**

In `page.tsx`:

1. `handleSave` becomes `({ force = false, autosave = false } = {})`,
   passes `autosave` to `api.saveFile`, and handles the refusal:

```ts
    if (res?.code === "disk-changed" && typeof res.content === "string") {
      // The strip is the surface for this; autosave suspends via
      // autosaveEligible until the user resolves it.
      setDiskChange(res.content);
      return "changed-on-disk";
    }
```

2. One scheduler per document identity:

```ts
  const saveRef = useRef(handleSave);
  useEffect(() => { saveRef.current = handleSave; }, [handleSave]);
  const autosaveRef = useRef<Autosave | null>(null);
  useEffect(() => {
    const a = createAutosave({
      save: async () => (await saveRef.current({ autosave: true })) === null,
    });
    autosaveRef.current = a;
    return () => a.cancel();
  }, [filePath]);
```

3. Eligibility, next to the other derived flags (and mirrored into a ref for
   the edit path):

```ts
  const autosaveEligible =
    filePath !== null &&
    docEditable &&
    diskChange === null &&
    !showDiskConflict &&
    // In rich-visible modes a probe-blocked document must not autosave; in
    // pure source mode CodeMirror is byte-faithful and always safe.
    (mode === "edit" || !richBlocked);
  const autosaveEligibleRef = useRef(autosaveEligible);
  useEffect(() => { autosaveEligibleRef.current = autosaveEligible; }, [autosaveEligible]);
```

4. The single edit entry point arms it; editors receive `editContent`
   instead of `doc.edit`:

```ts
  const editContent = useCallback(
    (md: string) => {
      doc.edit(md);
      if (autosaveEligibleRef.current) autosaveRef.current?.noteChange();
    },
    [doc]
  );
```

5. Manual save is the flush: at the top of `handleSave`'s manual path
   (`if (!autosave) autosaveRef.current?.cancel();`) so ⌘S never races a
   pending timer into a double write.

- [ ] **Step 4: Page-level autosave tests**

```tsx
// src/app/page.autosave.test.tsx
// Same vi.mock preamble and boot helper as page.save.test.tsx.
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";
import Home from "./page";

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "start\n" };

describe("autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("writes the buffer about a second after an edit, marked as autosave", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    installBridge({ getInitialFile: vi.fn(async () => OPEN), saveFile } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    // Drive the edit through the rich editor handle the app exposes for CDP
    // (rich-view.tsx window.__markieEditor). Its onUpdate then flows through
    // the real 250ms serializer debounce and into editContent.
    const editor = (window as unknown as { __markieEditor: { commands: { setContent(c: string): void } } }).__markieEditor;
    await act(async () => { editor.commands.setContent("start edited"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });  // serializer
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); }); // autosave idle
    await waitFor(() =>
      expect(saveFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: OPEN.path, autosave: true })
      )
    );
  });

  it("routes an autosave disk conflict into the strip and stops retrying", async () => {
    const saveFile = vi.fn(async () => ({
      success: false,
      code: "disk-changed" as const,
      content: "theirs\n",
    }));
    installBridge({ getInitialFile: vi.fn(async () => OPEN), saveFile } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    const editor = (window as unknown as { __markieEditor: { commands: { setContent(c: string): void } } }).__markieEditor;
    await act(async () => { editor.commands.setContent("mine"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(await screen.findByText(/changed on disk|reload/i)).toBeInTheDocument();
    const calls = saveFile.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(saveFile.mock.calls.length).toBe(calls);
  });
});
```

Match the strip's actual copy (`disk-change.tsx`) in the text queries.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run lint && npm run build && wc -l src/app/page.tsx`
Expected: green, including every pre-existing save/conflict page suite.

- [ ] **Step 6: Commit**

```bash
git add electron/save-conflict.js electron/save-conflict.test.ts electron/main.js src/lib/electron.ts src/app/page.tsx src/app/page.autosave.test.tsx
git commit -m "$(cat <<'MSG'
Autosave: typing lands on disk within a second, never via a dialog or a blind overwrite

Constraint: The rich-loss gate from phase 1 is a hard precondition; autosave
  arms only where the serializer is proven faithful or the user overrode.
Rejected: Retrying refused autosaves | a disk conflict needs a human, and
  the existing strip is the surface for it.
Confidence: medium
Scope-risk: broad
Directive: saveConflictAction owns the ask/refuse decision; never add a
  dialog to the autosave path.
Tested: save-conflict unit suite, page autosave and conflict-strip tests,
  all existing save/conflict page suites green.
Not-tested: Long-session battery/IO profile of 1s-cadence saves (watch in
  dogfooding).
MSG
)"
```

---

## Task 8: Flush on every transition (switch, new, close, quit) plus web beforeunload

**Files:**
- Create: `electron/close-flush.js`
- Create: `electron/close-flush.test.ts`
- Modify: `electron/main.js` (close interception in `createWindow`, one
  module-scope `ipcMain.on("app-close-ready", ...)`)
- Modify: `electron/preload.js` (`onAppWillClose`, `appCloseReady`)
- Modify: `src/lib/electron.ts` (both members)
- Modify: `src/app/page.tsx` (settle in loadFile/newFile; app-will-close
  subscription; beforeunload web fallback)
- Modify: `src/test/mock-bridge.ts` (model the new subscription)
- Create: `src/app/page.flush.test.tsx`

**Interfaces:**
- Produces:
  - Channels `app-will-close` (main sends) and `app-close-ready` (renderer
    sends via `ipcRenderer.send`).
  - `createCloseFlusher({ send, onReady, timeoutMs, destroy, setTimer, clearTimer })`
    returning `{ requestClose(): void; isSettled(): boolean }`.
  - Page-level `settleDocument(): Promise<void>` reused by Task 9.

- [ ] **Step 1: Failing test for the close flusher**

```ts
// electron/close-flush.test.ts
import { describe, expect, it, vi } from "vitest";
const { createCloseFlusher } = require("./close-flush.js");

describe("createCloseFlusher", () => {
  it("destroys after the renderer reports ready", () => {
    vi.useFakeTimers();
    let ready: () => void = () => {};
    const destroy = vi.fn();
    const send = vi.fn();
    const f = createCloseFlusher({
      send,
      onReady: (cb: () => void) => { ready = cb; },
      timeoutMs: 2000,
      destroy,
    });
    f.requestClose();
    expect(send).toHaveBeenCalledWith("app-will-close");
    expect(destroy).not.toHaveBeenCalled();
    ready();
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(destroy).toHaveBeenCalledTimes(1); // late timeout is a no-op
    vi.useRealTimers();
  });

  it("destroys after the timeout when the renderer hangs", () => {
    vi.useFakeTimers();
    const destroy = vi.fn();
    const f = createCloseFlusher({
      send: vi.fn(),
      onReady: () => {},
      timeoutMs: 2000,
      destroy,
    });
    f.requestClose();
    vi.advanceTimersByTime(1999);
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("requestClose is idempotent while pending", () => {
    const destroy = vi.fn();
    const send = vi.fn();
    const f = createCloseFlusher({ send, onReady: () => {}, timeoutMs: 2000, destroy });
    f.requestClose();
    f.requestClose();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
```

Run to fail, then implement:

```js
// electron/close-flush.js
// The window may not die with a keystroke in flight. Main asks the renderer
// to settle (flush autosave, write the draft), waits for app-close-ready,
// and only then destroys; a hung renderer gets a hard cap so quit can never
// wedge. Pure and injected so the handshake tests without a window.
function createCloseFlusher({
  send,
  onReady,
  timeoutMs = 2000,
  destroy,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let state = "idle"; // idle | pending | settled
  let timer = null;

  const settle = () => {
    if (state === "settled") return;
    state = "settled";
    if (timer) clearTimer(timer);
    timer = null;
    destroy();
  };

  onReady(settle);

  return {
    requestClose() {
      if (state !== "idle") return;
      state = "pending";
      send("app-will-close");
      timer = setTimer(settle, timeoutMs);
    },
    isSettled() {
      return state === "settled";
    },
  };
}

module.exports = { createCloseFlusher };
```

- [ ] **Step 2: Wire into main.js**

Module scope (so the IPC contract test sees the literal
`ipcMain.on("app-close-ready"`):

```js
let _closeReadyCb = null;
ipcMain.on("app-close-ready", () => {
  if (_closeReadyCb) _closeReadyCb();
});
```

Inside `createWindow()` after the window exists:

```js
  const { createCloseFlusher } = require("./close-flush");
  const closeFlusher = createCloseFlusher({
    send: (ch) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch);
    },
    onReady: (cb) => { _closeReadyCb = cb; },
    destroy: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    },
  });
  mainWindow.on("close", (event) => {
    if (closeFlusher.isSettled() || !rendererReady) return; // let it close
    event.preventDefault();
    closeFlusher.requestClose();
  });
```

`mainWindow.destroy()` bypasses the close event, so the handshake terminates.
Cmd+Q flows through the same interception: quit closes the window, the
handler settles once, then `window-all-closed` quits as today.

Preload additions inside `exposeInMainWorld`:

```js
  onAppWillClose: (cb) => subscribe("app-will-close", cb),
  appCloseReady: () => ipcRenderer.send("app-close-ready"),
```

`src/lib/electron.ts`: `onAppWillClose(cb: () => void): (() => void) | undefined;`
and `appCloseReady(): void;`.

- [ ] **Step 3: Renderer settle on transitions**

In `page.tsx`:

1. One settle helper (Task 9 extends it with the final draft write):

```ts
  // Everything that must land before the buffer is replaced or the window
  // dies: the pending autosave. Failure is tolerated on purpose: a blocked
  // transition traps the user, and the draft journal (Task 9) holds the rest.
  const settleDocument = useCallback(async () => {
    try {
      await autosaveRef.current?.flush();
    } catch {
      // the draft journal has it
    }
  }, []);
```

2. `loadFile` and `handleNewFile` start with `await settleDocument();`
   (make both async; callers already tolerate promises).
3. In the once-registered IPC effect:

```ts
      api.onAppWillClose?.(() => {
        void (async () => {
          try {
            await handlersRef.current.settle();
          } finally {
            getElectronAPI()?.appCloseReady?.();
          }
        })();
      }),
```

   with `settle: settleDocument` added to `handlersRef` and kept current in
   the same effect that refreshes the other handlers.
4. Web fallback (non-Electron only); add `isDirty` to the `docRef` payload:

```ts
  useEffect(() => {
    if (getElectronAPI()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (docRef.current.isDirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
```

- [ ] **Step 4: Page-level flush tests**

```tsx
// src/app/page.flush.test.tsx (page.save preamble; fake timers like
// page.autosave.test.tsx)
it("flushes the pending autosave before opening another file", async () => {
  const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
  const second = { name: "b.md", path: "/notes/b.md", content: "second\n" };
  const openFile = vi.fn(async () => second);
  installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    saveFile,
    openFile,
  } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("start");
  const editor = (window as unknown as { __markieEditor: { commands: { setContent(c: string): void } } }).__markieEditor;
  await act(async () => { editor.commands.setContent("unsaved edit"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // serializer only
  await act(async () => { emit("onMenuOpenFile"); });
  await waitFor(() => expect(saveFile).toHaveBeenCalled());
  expect(saveFile.mock.calls[0][0].content).toMatch(/unsaved edit/);
  expect(await screen.findByText("second")).toBeInTheDocument();
});

it("answers app-will-close with appCloseReady after settling", async () => {
  const appCloseReady = vi.fn();
  installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    saveFile: vi.fn(async () => ({ success: true, path: OPEN.path })),
    appCloseReady,
  } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("start");
  await act(async () => { emit("onAppWillClose"); });
  await waitFor(() => expect(appCloseReady).toHaveBeenCalled());
});
```

`src/test/mock-bridge.ts` needs `onAppWillClose` in its subscription map;
follow how `onMenuSave` and `emit` are modeled there.

- [ ] **Step 5: Run everything, commit**

Run: `npm test && npm run lint && npm run build`

```bash
git add electron/close-flush.js electron/close-flush.test.ts electron/main.js electron/preload.js src/lib/electron.ts src/app/page.tsx src/app/page.flush.test.tsx src/test/mock-bridge.ts
git commit -m "$(cat <<'MSG'
Never drop an in-flight edit again: settle the document before swap, close, and quit

Constraint: This closes the verified P0 (silent discard on switch, new file,
  close, quit); the draft journal covers the pathless-buffer remainder next.
Rejected: Blocking close until the renderer answers, uncapped | a hung
  renderer must never wedge quit; the 2s cap plus the draft journal loses
  nothing.
Confidence: medium
Scope-risk: moderate
Directive: mainWindow.destroy() is the only sanctioned exit from the close
  handshake; never re-enter close() without isSettled().
Tested: close-flush unit suite, page flush-on-open and close-handshake tests.
Not-tested: Real quit on a packaged build (covered by the packaged smoke at
  release time).
MSG
)"
```

---

## Task 9: Draft journal (crash safety) and boot recovery

**Files:**
- Create: `electron/drafts.js`
- Create: `electron/drafts.test.ts`
- Modify: `electron/main.js` (lazy `drafts()` accessor + three handlers)
- Modify: `electron/preload.js`, `src/lib/electron.ts`
- Create: `src/components/draft-strip.tsx`
- Modify: `src/app/page.tsx` (draft debounce, clear-on-save, boot recovery)
- Create: `src/app/page.draft.test.tsx`

**Interfaces:**
- Produces:
  - `createDrafts({ dir, fs?, path?, crypto?, now?, maxAgeDays?, maxTotalBytes? })`
    with `save({ path, name }, content)`, `check({ fileMtime })`,
    `read(key)`, `discard(key)`.
  - `DraftEntry = { key: string; path: string | null; name: string | null; savedAt: string; bytes: number }`
  - IPC `draft-save`, `draft-check` (entries come back with `content`
    attached), `draft-discard`; API members `draftSave`, `draftCheck`,
    `draftDiscard`.
  - The empty-content save clears the entry (this is how "committed save
    discards the draft" is expressed with three channels).

- [ ] **Step 1: Failing unit tests**

```ts
// electron/drafts.test.ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createDrafts } = require("./drafts.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "markie-drafts-"));

describe("drafts", () => {
  it("saves, lists, reads, and discards a pathful draft", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: "/notes/a.md", name: "a.md" }, "draft body");
    const entries = d.check({ fileMtime: () => 0 }); // file older than draft
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/notes/a.md");
    expect(d.read(entries[0].key)).toBe("draft body");
    d.discard(entries[0].key);
    expect(d.check({ fileMtime: () => 0 })).toHaveLength(0);
  });

  it("hides a draft older than the file (the save landed)", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: "/notes/a.md", name: "a.md" }, "old draft");
    const entries = d.check({ fileMtime: () => Date.now() + 60_000 });
    expect(entries).toHaveLength(0);
  });

  it("keeps one untitled draft, recoverable while non-empty", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: null, name: null }, "untitled work");
    const entries = d.check({ fileMtime: () => null });
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBeNull();
  });

  it("an empty save clears the draft instead of storing emptiness", () => {
    const d = createDrafts({ dir: tmp() });
    d.save({ path: null, name: null }, "something");
    d.save({ path: null, name: null }, "");
    expect(d.check({ fileMtime: () => null })).toHaveLength(0);
  });

  it("prunes drafts past maxAgeDays", () => {
    let t = Date.parse("2026-08-01T00:00:00Z");
    const d = createDrafts({ dir: tmp(), now: () => new Date(t), maxAgeDays: 7 });
    d.save({ path: "/notes/a.md", name: "a.md" }, "x");
    t = Date.parse("2026-08-20T00:00:00Z");
    d.save({ path: "/notes/b.md", name: "b.md" }, "y"); // triggers prune
    const entries = d.check({ fileMtime: () => 0 });
    expect(entries.map((e) => e.path)).toEqual(["/notes/b.md"]);
  });
});
```

- [ ] **Step 2: Implement drafts.js**

```js
// electron/drafts.js
// The write-ahead net under autosave. The debounced file write is at most a
// second behind the buffer; this journal is at most one serializer tick
// behind THAT, lives in userData (never beside the user's file), and exists
// so a crash or kill mid-burst costs nothing. Injected fs/clock, the same
// testability pattern as snapshots.js.
const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");

const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function keyFor(docPath, { path = nodePath, crypto = nodeCrypto } = {}) {
  if (!docPath) return "untitled";
  const absolute = path.resolve(String(docPath));
  const hash = crypto.createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  const base = path.basename(absolute).replace(/[^\w.\- ]/g, "_").slice(0, 60) || "document";
  return `${hash}-${base}`;
}

function createDrafts(options = {}) {
  const {
    dir,
    fs = nodeFs,
    path = nodePath,
    crypto = nodeCrypto,
    now = () => new Date(),
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = options;

  const root = path.join(dir, "drafts");
  const indexFile = path.join(root, "index.json");

  function readIndex() {
    try {
      return JSON.parse(fs.readFileSync(indexFile, "utf-8"));
    } catch {
      return {};
    }
  }

  function writeIndex(index) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = indexFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(index), "utf-8");
    fs.renameSync(tmp, indexFile);
  }

  const fileFor = (key) => path.join(root, `${key}.md`);

  function remove(index, key) {
    try {
      fs.rmSync(fileFor(key), { force: true });
    } catch {
      // an unremovable draft is not worth failing over
    }
    delete index[key];
  }

  function prune(index) {
    const cutoff = now().getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    const entries = Object.entries(index).sort(
      (a, b) => Date.parse(a[1].savedAt) - Date.parse(b[1].savedAt)
    );
    let total = 0;
    for (const [key, meta] of entries) {
      if (Date.parse(meta.savedAt) < cutoff) remove(index, key);
      else total += meta.bytes || 0;
    }
    for (const [key, meta] of entries) {
      if (total <= maxTotalBytes) break;
      if (!index[key]) continue;
      total -= meta.bytes || 0;
      remove(index, key);
    }
  }

  return {
    save(docKey, content) {
      const key = keyFor(docKey && docKey.path, { path, crypto });
      const index = readIndex();
      if (!String(content || "").trim()) {
        remove(index, key);
        writeIndex(index);
        return { ok: true, cleared: true };
      }
      fs.mkdirSync(root, { recursive: true });
      const tmp = fileFor(key) + ".tmp";
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, fileFor(key));
      index[key] = {
        path: (docKey && docKey.path) || null,
        name: (docKey && docKey.name) || null,
        savedAt: now().toISOString(),
        bytes: Buffer.byteLength(content, "utf-8"),
      };
      prune(index);
      writeIndex(index);
      return { ok: true };
    },

    check({ fileMtime }) {
      const index = readIndex();
      const out = [];
      for (const [key, meta] of Object.entries(index)) {
        if (meta.path) {
          const mtime = fileMtime(meta.path);
          // The file caught up (a later save landed): the draft is stale.
          if (mtime !== null && mtime >= Date.parse(meta.savedAt)) continue;
        }
        out.push({ key, ...meta });
      }
      return out.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    },

    read(key) {
      try {
        return fs.readFileSync(fileFor(key), "utf-8");
      } catch {
        return null;
      }
    },

    discard(key) {
      const index = readIndex();
      remove(index, key);
      writeIndex(index);
      return { ok: true };
    },
  };
}

module.exports = { createDrafts, keyFor, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_TOTAL_BYTES };
```

Run: `npm test -- electron/drafts.test.ts` until green.

- [ ] **Step 3: IPC and renderer wiring**

`main.js` (near the snapshots lazy accessor, same style):

```js
let _drafts = null;
function drafts() {
  if (!_drafts) {
    const { createDrafts } = require("./drafts");
    _drafts = createDrafts({ dir: app.getPath("userData") });
  }
  return _drafts;
}

handle("draft-save", (_e, { path: p, name, content }) =>
  drafts().save({ path: p ?? null, name: name ?? null }, String(content ?? "")),
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) });
handle("draft-check", () =>
  drafts()
    .check({
      fileMtime: (p) => {
        try { return fs.statSync(p).mtimeMs; } catch { return null; }
      },
    })
    .map((entry) => ({ ...entry, content: drafts().read(entry.key) })),
  { onFailure: () => [] });
handle("draft-discard", (_e, key) => drafts().discard(String(key || "")), {
  onFailure: () => ({ ok: false }),
});
```

Preload: `draftSave: (args) => ipcRenderer.invoke("draft-save", args)`,
`draftCheck: () => ipcRenderer.invoke("draft-check")`,
`draftDiscard: (key) => ipcRenderer.invoke("draft-discard", key)`.
`electron.ts` members typed accordingly.

Renderer (`page.tsx`):

1. Draft write on dirt, debounced 250ms, regardless of eligibility (even a
   pathless or rich-blocked buffer deserves crash safety):

```ts
  useEffect(() => {
    if (!isDirty) return;
    const t = setTimeout(() => {
      getElectronAPI()?.draftSave?.({
        path: filePath,
        name: fileName,
        content: docRef.current.content,
      });
    }, 250);
    return () => clearTimeout(t);
  }, [content, isDirty, filePath, fileName]);
```

2. After every committed save (`doc.markSaved` call sites in `handleSave`
   and `handleSaveAs`): `void getElectronAPI()?.draftSave?.({ path, name,
   content: "" })` (the empty-save-clears rule).
3. `settleDocument` (Task 8) gains a final synchronous-ish draft push before
   resolving: write the current buffer once more when dirty, so close never
   races the 250ms debounce.
4. Boot recovery: after the boot effect resolves the initial document, call
   `draftCheck()`; pick the entry matching the loaded path, or the pathless
   entry when the buffer is untitled; store it in
   `const [recoveredDraft, setRecoveredDraft] = useState<DraftEntry & { content: string | null } | null>(null)`
   and render the strip in the document column next to `DiskChangeStrip`:

```tsx
  {recoveredDraft && recoveredDraft.content !== null && (
    <DraftStrip
      savedAt={recoveredDraft.savedAt}
      onRestore={() => {
        loadFile({
          name: recoveredDraft.name ?? "untitled.md",
          content: recoveredDraft.content!,
          path: recoveredDraft.path,
          unsaved: true,
        });
        setRecoveredDraft(null);
      }}
      onDiscard={() => {
        void getElectronAPI()?.draftDiscard?.(recoveredDraft.key);
        setRecoveredDraft(null);
      }}
    />
  )}
```

The strip component:

```tsx
// src/components/draft-strip.tsx
"use client";

// How long ago, in words a strip has room for.
function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 1) return "moments ago";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function DraftStrip({
  savedAt,
  onRestore,
  onDiscard,
}: {
  savedAt: string;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="status"
      data-markie-draft-strip
      className="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-foreground flex items-center gap-2"
    >
      <span className="min-w-0 flex-1">
        Markie recovered unsaved changes from {relativeTime(savedAt)}.
      </span>
      <button
        type="button"
        onClick={onRestore}
        className="h-6 px-2 rounded-md border border-border hover:bg-accent/40 text-[11.5px]"
      >
        Restore
      </button>
      <button
        type="button"
        onClick={onDiscard}
        className="h-6 px-2 rounded-md text-muted hover:text-foreground text-[11.5px]"
      >
        Discard
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Page-level recovery test**

```tsx
// src/app/page.draft.test.tsx (page.save preamble)
import userEvent from "@testing-library/user-event";

it("offers a recovered draft on boot and restores it dirty", async () => {
  const draftCheck = vi.fn(async () => [
    {
      key: "abc-notes.md",
      path: OPEN.path,
      name: OPEN.name,
      savedAt: new Date().toISOString(),
      bytes: 10,
      content: "recovered body",
    },
  ]);
  installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    draftCheck,
  } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("start");
  await userEvent.click(await screen.findByRole("button", { name: /restore/i }));
  expect(await screen.findByText("recovered body")).toBeInTheDocument();
  await waitFor(() => expect(document.title).toMatch(/^• /)); // dirty dot
});

it("discard removes the draft without touching the buffer", async () => {
  const draftDiscard = vi.fn(async () => ({ ok: true }));
  installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    draftCheck: vi.fn(async () => [
      { key: "k", path: OPEN.path, name: OPEN.name, savedAt: new Date().toISOString(), bytes: 3, content: "zzz" },
    ]),
    draftDiscard,
  } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("start");
  await userEvent.click(await screen.findByRole("button", { name: /discard/i }));
  expect(draftDiscard).toHaveBeenCalledWith("k");
  expect(screen.queryByText("zzz")).not.toBeInTheDocument();
});
```

- [ ] **Step 5: Run everything, commit**

Run: `npm test && npm run lint && npm run build`

```bash
git add electron/drafts.js electron/drafts.test.ts electron/main.js electron/preload.js src/lib/electron.ts src/components/draft-strip.tsx src/app/page.tsx src/app/page.draft.test.tsx
git commit -m "$(cat <<'MSG'
Journal the buffer ahead of the debounce so a crash costs one tick, not a document

Constraint: Autosave waits up to a second; the kill window in between must
  hold nothing unrecoverable, including the never-saved untitled buffer.
Rejected: Prompting to save the untitled buffer on close | the journal makes
  the prompt unnecessary and closing stays instant.
Confidence: high
Scope-risk: moderate
Tested: drafts unit suite (staleness, pruning, untitled, empty-clears),
  page boot-recovery and discard tests.
Not-tested: An actual SIGKILL mid-burst (manual checklist in Task 12).
MSG
)"
```

---

## Task 10: History store with authorship and retention

**Files:**
- Create: `electron/history.js`
- Create: `electron/history.test.ts`
- Modify: `electron/main.js` (`snapshotBeforeWrite` goes through history;
  watcher captures external versions; `refreshRevertMenuItem` reads history)

**Interfaces:**
- Consumes: `createSnapshots`, `slugFor`, `stampFor` from
  `electron/snapshots.js` (unchanged file). The store DIRECTORY stays
  `userData/snapshots/`, so every existing 0.4.x snapshot is already a
  version and nothing migrates (Spec 4.6).
- Produces `createHistory({ dir, fs?, path?, crypto?, now?, caps? })`:
  - `capture(filePath, nextContent, { author }): { ok?: true; skipped?: string }`
  - `captureExternal(filePath)`: records current disk content as an
    `"external"` version, deduped by content hash
  - `list(filePath): Array<{ stamp, iso, author, bytes }>` newest first
  - `read(filePath, stamp): string | null`
  - `planRetention(entries, nowMs, caps)` exported pure for tests
  - Retention defaults (Spec 4.6): keep all newer than 24h; one per hour to
    7 days; one per day to 30 days; drop older; always keep the newest 5;
    caps 200 versions per file, 500MB global.

- [ ] **Step 1: Failing tests (retention is the heart; test it pure)**

```ts
// electron/history.test.ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createHistory, planRetention } = require("./history.js");

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-26T12:00:00Z");
const entry = (ageMs: number, bytes = 100) => ({
  stamp: new Date(NOW - ageMs).toISOString().replace(/:/g, "-"),
  ms: NOW - ageMs,
  bytes,
});

describe("planRetention", () => {
  it("keeps everything from the last 24h", () => {
    const entries = [entry(1 * HOUR), entry(2 * HOUR), entry(23 * HOUR)];
    expect(planRetention(entries, NOW, {})).toEqual([]);
  });

  it("thins 1-7 day old versions to one per hour", () => {
    const entries = [
      entry(2 * DAY),
      entry(2 * DAY + 10 * 60_000),
      entry(2 * DAY + 20 * 60_000),
    ];
    const drop = planRetention(entries, NOW, { keepNewest: 0 });
    expect(drop).toHaveLength(2); // one survivor per hour bucket
  });

  it("thins 7-30 day old versions to one per day and drops older than 30d", () => {
    const entries = [entry(10 * DAY), entry(10 * DAY + 2 * HOUR), entry(40 * DAY)];
    const drop = planRetention(entries, NOW, { keepNewest: 0 });
    expect(drop).toHaveLength(2);
  });

  it("never drops below the newest-5 floor, whatever the age", () => {
    const entries = [entry(40 * DAY), entry(41 * DAY), entry(42 * DAY), entry(43 * DAY), entry(44 * DAY)];
    expect(planRetention(entries, NOW, {})).toEqual([]);
  });

  it("enforces the per-file cap oldest-first", () => {
    const entries = Array.from({ length: 205 }, (_, i) => entry(i * 60_000));
    const drop = planRetention(entries, NOW, { maxPerFile: 200 });
    expect(drop).toHaveLength(5);
  });
});

describe("createHistory", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "markie-history-"));

  it("captures with authorship and lists newest first", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "v1");
    const h = createHistory({ dir });
    expect(h.capture(target, "v2", { author: "user" }).ok).toBe(true);
    fs.writeFileSync(target, "v2");
    expect(h.capture(target, "v3", { author: "user" }).ok).toBe(true);
    const list = h.list(target);
    expect(list).toHaveLength(2);
    expect(list[0].author).toBe("user");
    expect(h.read(target, list[1].stamp)).toBe("v1");
  });

  it("captureExternal records the disk content once per distinct content", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "agent wrote this");
    const h = createHistory({ dir });
    expect(h.captureExternal(target).ok).toBe(true);
    expect(h.captureExternal(target).skipped).toBe("duplicate");
    expect(h.list(target)[0].author).toBe("external");
  });

  it("reads legacy snapshots (no meta) as author unknown", () => {
    const dir = tmp();
    const target = path.join(dir, "doc.md");
    fs.writeFileSync(target, "v1");
    const { createSnapshots } = require("./snapshots.js");
    createSnapshots({ dir }).capture(target, "v2"); // a pre-0.5.0 snapshot
    const h = createHistory({ dir });
    expect(h.list(target)[0].author).toBe("unknown");
  });
});
```

- [ ] **Step 2: Implement history.js**

```js
// electron/history.js
// Every committed save is a version; the store is the existing snapshots
// directory, so 0.4.x snapshots are already the oldest versions and nothing
// migrates. What this adds over snapshots.js: an author per version (user vs
// external), content-hash dedupe, and time-shaped retention, because
// autosave would blow through a flat 20-per-file cap in an afternoon.
const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");
const { createSnapshots, slugFor, stampFor } = require("./snapshots.js");

const DEFAULT_CAPS = {
  keepAllMs: 24 * 3600_000,
  hourlyUntilMs: 7 * 24 * 3600_000,
  dailyUntilMs: 30 * 24 * 3600_000,
  keepNewest: 5,
  maxPerFile: 200,
  maxTotalBytes: 500 * 1024 * 1024,
};

// entries: [{ stamp, ms, bytes }] in any order. Returns stamps to delete.
function planRetention(entries, nowMs, caps = {}) {
  const c = { ...DEFAULT_CAPS, ...caps };
  const sorted = [...entries].sort((a, b) => b.ms - a.ms); // newest first
  const drop = new Set();
  const seenHour = new Set();
  const seenDay = new Set();
  sorted.forEach((e, i) => {
    if (i < c.keepNewest) return; // the floor
    const age = nowMs - e.ms;
    if (age <= c.keepAllMs) return;
    if (age <= c.hourlyUntilMs) {
      const bucket = Math.floor(e.ms / 3600_000);
      if (seenHour.has(bucket)) drop.add(e.stamp);
      else seenHour.add(bucket);
      return;
    }
    if (age <= c.dailyUntilMs) {
      const bucket = Math.floor(e.ms / (24 * 3600_000));
      if (seenDay.has(bucket)) drop.add(e.stamp);
      else seenDay.add(bucket);
      return;
    }
    drop.add(e.stamp);
  });
  // Per-file cap, oldest dropped first, applied after time thinning.
  const kept = sorted.filter((e) => !drop.has(e.stamp));
  for (let i = kept.length - 1; i >= c.maxPerFile; i--) drop.add(kept[i].stamp);
  return [...drop];
}

function createHistory(options = {}) {
  const {
    dir,
    fs = nodeFs,
    path = nodePath,
    crypto = nodeCrypto,
    now = () => new Date(),
    caps = {},
  } = options;
  const snaps = createSnapshots({
    dir, fs, path, crypto, now,
    // Neutralize the old flat caps; retention below is the real policy.
    maxPerFile: Number.MAX_SAFE_INTEGER,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  });
  const c = { ...DEFAULT_CAPS, ...caps };

  const metaFile = (filePath) => path.join(snaps.dirFor(filePath), "meta.json");

  function readMeta(filePath) {
    try {
      return JSON.parse(fs.readFileSync(metaFile(filePath), "utf-8"));
    } catch {
      return {};
    }
  }
  function writeMeta(filePath, meta) {
    try {
      fs.writeFileSync(metaFile(filePath), JSON.stringify(meta), "utf-8");
    } catch {
      // metadata is best effort; the version bytes matter more
    }
  }

  function entryList(filePath) {
    return snaps.list(filePath).map((name) => {
      const stamp = name.replace(/\.md$/, "");
      // Stamps are ISO strings with colons swapped for dashes; the first two
      // swaps are in the time part. Reverse just enough to parse.
      const iso = stamp.replace(
        /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)/,
        "$1:$2:$3"
      );
      const ms = Date.parse(iso) || 0;
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(snaps.dirFor(filePath), name)).size;
      } catch { /* gone between list and stat */ }
      return { stamp, ms, bytes };
    });
  }

  function retain(filePath) {
    const dropStamps = planRetention(entryList(filePath), now().getTime(), c);
    if (!dropStamps.length) return;
    const meta = readMeta(filePath);
    for (const stamp of dropStamps) {
      try {
        fs.rmSync(path.join(snaps.dirFor(filePath), `${stamp}.md`), { force: true });
      } catch { /* best effort */ }
      delete meta[stamp];
    }
    writeMeta(filePath, meta);
  }

  function newestContentHash(filePath) {
    const names = snaps.list(filePath);
    if (!names.length) return null;
    try {
      const latest = fs.readFileSync(
        path.join(snaps.dirFor(filePath), names[names.length - 1]),
        "utf-8"
      );
      return crypto.createHash("sha256").update(latest, "utf8").digest("hex");
    } catch {
      return null;
    }
  }

  function record(filePath, nextContent, author) {
    let previous;
    try {
      previous = fs.readFileSync(filePath, "utf-8");
    } catch {
      return { skipped: "no-file" };
    }
    const prevHash = crypto.createHash("sha256").update(previous, "utf8").digest("hex");
    if (prevHash === newestContentHash(filePath)) return { skipped: "duplicate" };
    const res = snaps.capture(filePath, nextContent);
    if (!res.ok) return res;
    const stamp = path.basename(res.path).replace(/\.md$/, "");
    const meta = readMeta(filePath);
    meta[stamp] = { author, iso: now().toISOString() };
    writeMeta(filePath, meta);
    retain(filePath);
    return res;
  }

  return {
    capture(filePath, nextContent, { author = "user" } = {}) {
      return record(filePath, nextContent, author);
    },
    captureExternal(filePath) {
      // nextContent undefined: snapshots.capture stores whatever is on disk,
      // which for an external edit is exactly the version to record.
      return record(filePath, undefined, "external");
    },
    list(filePath) {
      const meta = readMeta(filePath);
      return entryList(filePath)
        .sort((a, b) => b.ms - a.ms)
        .map((e) => ({
          stamp: e.stamp,
          iso: (meta[e.stamp] && meta[e.stamp].iso) || new Date(e.ms).toISOString(),
          author: (meta[e.stamp] && meta[e.stamp].author) || "unknown",
          bytes: e.bytes,
        }));
    },
    read(filePath, stamp) {
      try {
        return fs.readFileSync(
          path.join(snaps.dirFor(filePath), `${String(stamp)}.md`),
          "utf-8"
        );
      } catch {
        return null;
      }
    },
    has(filePath) {
      return snaps.has(filePath);
    },
    root: snaps.root,
  };
}

module.exports = { createHistory, planRetention, DEFAULT_CAPS, slugFor, stampFor };
```

The dedupe rule makes `capture` right after `captureExternal` of identical
content a no-op, which is exactly the double the watcher-plus-save sequence
would otherwise record. `snapshots.js` itself is untouched; the global
500MB cap is enforced through `planRetention`'s per-file passes plus the
existing prune helpers being neutralized, so if the total-size test proves
tricky, add a `pruneTotal`-style pass over `snaps.root` inside `retain`
mirroring `snapshots.js:124-132`.

- [ ] **Step 3: Wire into main.js**

- Add a lazy `history()` accessor beside `snapshots()`
  (`createHistory({ dir: app.getPath("userData") })`), and change
  `snapshotBeforeWrite` (main.js:92) to call
  `history().capture(filePath, nextContent, { author: "user" })`.
- In `watchOpenFile`'s change callback, after `changed !== null`, add
  `try { history().captureExternal(filePath); } catch { /* best effort */ }`
  before sending `file-changed-on-disk`.
- `refreshRevertMenuItem` switches from `snapshots().has(...)` to
  `history().has(...)`; delete the now-unused `snapshots()` accessor if
  nothing else uses it.

Run: `npm test -- electron/history.test.ts && npm test` (the existing
`snapshots.test.ts` stays green, untouched).

- [ ] **Step 4: Commit**

```bash
git add electron/history.js electron/history.test.ts electron/main.js
git commit -m "$(cat <<'MSG'
Turn the snapshot pile into real history: authored versions with age-aware retention

Constraint: Autosave commits a version per burst; the flat 20-per-file cap
  would discard a morning's work by lunch, so retention is time-shaped.
Rejected: A parallel history store beside snapshots/ | the existing snapshots
  ARE the version chain; reusing the directory migrates 0.4.x users for free.
Confidence: high
Scope-risk: moderate
Directive: snapshots.js stays untouched as the storage primitive; policy
  lives only in history.js.
Tested: planRetention pure suite; capture/list/read/external/legacy tests;
  full suite green.
Not-tested: Multi-hundred-version folders on slow disks (caps bound it).
MSG
)"
```

---

## Task 11: History UI (dialog, menu, palette, IPC)

**Files:**
- Modify: `electron/main.js` (channels `history-list`, `history-read`;
  File menu item becomes "History…" sending `menu-history`; delete the
  native `revertToSnapshot` picker)
- Modify: `electron/preload.js`, `src/lib/electron.ts`
- Create: `src/components/history-dialog.tsx`
- Create: `src/components/history-dialog.test.tsx`
- Modify: `src/components/doc-toolbar.tsx` (clock icon), `src/app/page.tsx`
- Check: `src/lib/menu-accelerators.test.ts` and
  `electron/desktop-intents.test.ts` for assertions naming the old menu item

**Interfaces:**
- Consumes: `history()` (Task 10), `lineDiff` from `src/lib/line-diff.ts`,
  `loadFile(..., unsaved: true)` restore semantics.
- Produces: API members `historyList(path)`, `historyRead({ path, stamp })`,
  subscription `onMenuHistory`; `HistoryEntry = { stamp, iso, author, bytes }`.

- [ ] **Step 1: Main-process handlers and menu**

```js
handle("history-list", (_e, p) => history().list(String(p || "")), {
  onFailure: () => [],
});
handle("history-read", (_e, { path: p, stamp }) => ({
  content: history().read(String(p || ""), String(stamp || "")),
}), { onFailure: () => ({ content: null }) });
```

Menu: keep `REVERT_MENU_ID`, change the label to `"History…"`, and the click
to `mainWindow.webContents.send("menu-history")`. Delete the
`revertToSnapshot` implementation (main.js:1814+) once the renderer path is
in. Keep the enablement rule via `history().has(currentDocPath)`.
Preload: `historyList`, `historyRead`, `onMenuHistory` subscription.

- [ ] **Step 2: Failing component test**

```tsx
// src/components/history-dialog.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { HistoryDialog } from "@/components/history-dialog";

const ENTRIES = [
  { stamp: "2026-08-26T10-00-00.000Z", iso: "2026-08-26T10:00:00.000Z", author: "user", bytes: 20 },
  { stamp: "2026-08-26T09-00-00.000Z", iso: "2026-08-26T09:00:00.000Z", author: "external", bytes: 18 },
];

describe("HistoryDialog", () => {
  it("lists versions with author chips and restores one", async () => {
    installBridge({
      historyList: vi.fn(async () => ENTRIES),
      historyRead: vi.fn(async ({ stamp }: { stamp: string }) => ({
        content: stamp === ENTRIES[0].stamp ? "newer\n" : "older\n",
      })),
    } as never);
    const onRestore = vi.fn();
    render(
      <HistoryDialog
        filePath="/n/a.md"
        fileName="a.md"
        currentContent={"current\n"}
        onRestore={onRestore}
        onClose={() => {}}
      />
    );
    expect(await screen.findByText(/external edit/i)).toBeInTheDocument();
    const restores = await screen.findAllByRole("button", { name: /restore/i });
    await userEvent.click(restores[1]);
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("older\n"));
  });

  it("shows the empty state when there are no versions", async () => {
    installBridge({ historyList: vi.fn(async () => []) } as never);
    render(
      <HistoryDialog filePath="/n/a.md" fileName="a.md" currentContent="" onRestore={() => {}} onClose={() => {}} />
    );
    expect(await screen.findByText(/no versions yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Implement the dialog**

Follow `conflict-dialog.tsx` for the modal scaffold and token usage
(`rounded-xl`, `markie-scrim-strong`, `var(--surface-2)`):

```tsx
// src/components/history-dialog.tsx
// Per-document version history. Versions come from main's history store;
// diff counts are computed lazily against the next-older version with the
// existing lineDiff, one read per visible row, cached in state.
"use client";
import { useEffect, useState } from "react";
import { getElectronAPI } from "@/lib/electron";
import { lineDiff } from "@/lib/line-diff";

export interface HistoryEntry {
  stamp: string;
  iso: string;
  author: string;
  bytes: number;
}

const AUTHOR_LABEL: Record<string, string> = {
  user: "You",
  external: "External edit",
  unknown: "Unknown",
};

const INITIAL_ROWS = 30;

export function HistoryDialog({
  filePath,
  fileName,
  currentContent,
  onRestore,
  onClose,
}: {
  filePath: string;
  fileName: string;
  currentContent: string;
  onRestore: (content: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [contents, setContents] = useState<Record<string, string | null>>({});
  const [shown, setShown] = useState(INITIAL_ROWS);

  useEffect(() => {
    let alive = true;
    getElectronAPI()
      ?.historyList?.(filePath)
      .then((list) => {
        if (alive) setEntries(Array.isArray(list) ? list : []);
      });
    return () => {
      alive = false;
    };
  }, [filePath]);

  useEffect(() => {
    if (!entries) return;
    let alive = true;
    void (async () => {
      const api = getElectronAPI();
      for (const e of entries.slice(0, shown)) {
        if (contents[e.stamp] !== undefined) continue;
        const res = await api?.historyRead?.({ path: filePath, stamp: e.stamp });
        if (!alive) return;
        setContents((prev) => ({ ...prev, [e.stamp]: res?.content ?? null }));
      }
    })();
    return () => {
      alive = false;
    };
    // contents is deliberately read, not depended on: each pass fills gaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, shown, filePath]);

  const diffFor = (i: number): string => {
    if (!entries) return "";
    const mine = contents[entries[i].stamp];
    const older = i + 1 < entries.length ? contents[entries[i + 1].stamp] : "";
    if (mine == null || older == null) return "";
    const d = lineDiff(older, mine);
    return `+${d.added}  -${d.removed}`;
  };

  return (
    <div
      className="markie-scrim-strong fixed inset-0 z-[110] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[70vh] rounded-xl border border-border shadow-2xl flex flex-col"
        style={{ background: "var(--surface-2)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[13px] text-foreground">History: {fileName}</span>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {entries === null ? (
            <div className="p-4 text-[12px] text-muted">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="p-4 text-[12px] text-muted">
              No versions yet. Markie records one every time this document is saved.
            </div>
          ) : (
            entries.slice(0, shown).map((e, i) => (
              <div
                key={e.stamp}
                className="rounded-md px-2 py-1.5 hover:bg-accent/40 flex items-center gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-foreground">
                    {new Date(e.iso).toLocaleString()}
                  </div>
                  <div className="text-[10.5px] text-muted">
                    {AUTHOR_LABEL[e.author] ?? e.author}
                    {diffFor(i) && (
                      <span className="ml-2 tabular-nums">{diffFor(i)}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => {
                    const c = contents[e.stamp];
                    if (typeof c === "string") onRestore(c);
                  }}
                  className="h-6 px-2 rounded-md border border-border text-[11px] hover:bg-accent/40 shrink-0"
                >
                  Restore
                </button>
              </div>
            ))
          )}
          {entries && shown < entries.length && (
            <button
              onClick={() => setShown((n) => n + 50)}
              className="w-full py-1.5 text-[11px] text-muted hover:text-foreground"
            >
              Show older
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

(`currentContent` is accepted for a future current-vs-latest diff row; it is
unused in the initial render logic and may be dropped if lint objects,
adjusting the test accordingly.)

- [ ] **Step 4: Page wiring**

- `const [showHistory, setShowHistory] = useState(false);`
- IPC effect: `api.onMenuHistory?.(() => setShowHistory(true)),`
- Palette command:
  `{ id: "history", title: "History…", group: "File", keywords: "versions restore snapshot revert previous", run: () => setShowHistory(true) }`
- Mount beside the other dialogs:

```tsx
      {showHistory && filePath && (
        <HistoryDialog
          filePath={filePath}
          fileName={fileName ?? "this document"}
          currentContent={content}
          onClose={() => setShowHistory(false)}
          onRestore={(c) => {
            loadFile({
              name: fileName ?? "untitled.md",
              content: c,
              path: filePath,
              unsaved: true,
            });
            setShowHistory(false);
          }}
        />
      )}
```

- `DocToolbar`: add an `onHistory?: () => void` prop rendering a clock icon
  button next to the print button (same styling); page passes
  `() => setShowHistory(true)`. Update `doc-toolbar.test.ts` for the new
  control.

- [ ] **Step 5: Run everything, commit**

Run: `npm test && npm run lint && npm run build && wc -l src/app/page.tsx`

```bash
git add electron/main.js electron/preload.js src/lib/electron.ts src/components/history-dialog.tsx src/components/history-dialog.test.tsx src/components/doc-toolbar.tsx src/app/page.tsx
git commit -m "$(cat <<'MSG'
Put file history where the user can see it: per-version diffs, authors, one-click restore

Constraint: Restore must never blind-overwrite; it loads the version as an
  unsaved buffer so the user commits it deliberately, same as snapshot
  revert always did.
Rejected: Keeping the native snapshot picker | it showed filenames, not
  diffs or authors, and could not preview.
Confidence: medium
Scope-risk: moderate
Tested: Dialog component tests (list, restore, empty), IPC contract green,
  menu/doc-toolbar tests updated.
Not-tested: Very long histories in the UI beyond the show-older path.
MSG
)"
```

---

## Task 12: Interaction regression net (autosave x watcher x collab x CSV)

**Files:**
- Create: `src/app/page.autosave-interactions.test.tsx`
- Modify (only if a test exposes a real bug): the wiring from Tasks 7-11

**Interfaces:** none new; this task pins invariants.

- [ ] **Step 1: Write the tests (they should pass; a failure is a real bug)**

```tsx
// src/app/page.autosave-interactions.test.tsx
// Same preamble and fake-timer setup as page.autosave.test.tsx.

it("autosave keeps writing the CSV encoding to disk", async () => {
  const CSV = { name: "t.csv", path: "/n/t.csv", content: "a,b\n1,2\n" };
  const saveFile = vi.fn(async () => ({ success: true, path: CSV.path }));
  installBridge({ getInitialFile: vi.fn(async () => CSV), saveFile } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("1"); // table rendered from CSV
  const editor = (window as unknown as { __markieEditor: { commands: { setContent(c: string): void } } }).__markieEditor;
  await act(async () => {
    editor.commands.setContent("| a | b |\n| --- | --- |\n| 1 | 3 |");
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  await waitFor(() => expect(saveFile).toHaveBeenCalled());
  expect(saveFile.mock.calls[0][0].content).toMatch(/^a,b/); // CSV, not markdown
});

it("suspends autosave while a disk change is pending", async () => {
  const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
  installBridge({ getInitialFile: vi.fn(async () => OPEN), saveFile } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("start");
  await act(async () => {
    emit("onFileChangedOnDisk", { path: OPEN.path, content: "theirs\n" });
  });
  const editor = (window as unknown as { __markieEditor: { commands: { setContent(c: string): void } } }).__markieEditor;
  await act(async () => { editor.commands.setContent("mine while conflicted"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(saveFile).not.toHaveBeenCalled(); // suspended until resolved
});

it("does not docPush from an autosave during a live collab session", async () => {
  // Follow the collab mocking used by the existing page tests if present
  // (search for collabCfg/registryGet mocks in page.conflict.test.tsx).
  // If the harness cannot mock a live session, assert the inverse invariant
  // that IS reachable: a solo autosave calls docPush exactly like a manual
  // save does today, and leave a comment naming the uncovered variant.
  const docPush = vi.fn(async () => ({ ok: true }));
  const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
  installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    saveFile,
    docPush,
  } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("start");
  const editor = (window as unknown as { __markieEditor: { commands: { setContent(c: string): void } } }).__markieEditor;
  await act(async () => { editor.commands.setContent("solo edit"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  await waitFor(() => expect(saveFile).toHaveBeenCalled());
  await waitFor(() => expect(docPush).toHaveBeenCalled());
});
```

- [ ] **Step 2: Manual crash-safety checklist (run once, record results)**

With `npm run native:restore && npm run electron:dev` (restore the Node
build afterwards for tests, per CONTRIBUTING):

1. Open a file, type, `kill -9` the Electron processes within a second.
   Relaunch: the draft strip offers the lost keystrokes.
2. Type, close the window with the red button immediately: the file on disk
   holds the edit (flush-on-close).
3. Edit the same file from another editor while Markie holds unsaved
   changes: the in-app strip appears, no native dialog, autosave holds off.
4. Rich-open a file with footnotes: the loss banner shows; the file on disk
   never changes while the banner is up.

Record outcomes in the commit's `Tested:` trailer.

- [ ] **Step 3: Run everything, commit**

Run: `npm test && npm run lint && npm run build`

```bash
git add src/app/page.autosave-interactions.test.tsx
git commit -m "$(cat <<'MSG'
Pin the autosave truce lines: watcher, collab push, CSV, and conflict suspension

Constraint: Autosave shares the document with a disk watcher, a sync engine,
  and a CSV encoder; each boundary gets a test so a refactor cannot cross it
  silently.
Confidence: high
Scope-risk: narrow
Tested: Interaction suite green; manual kill/close/external-edit checklist
  run on electron:dev with results recorded here.
Not-tested: Windows/Linux watcher timing differences.
MSG
)"
```

---

# Phase 3: Virtual project/block organization

Read Spec sections 5.1 through 5.9 in full before starting this phase. The
SQLite DDL in Spec 5.7 is a human checkpoint: implement it exactly; if the
work forces a deviation, stop and escalate rather than improvising.

## Task 13: Main-process front matter extractor

**Files:**
- Create: `electron/frontmatter.js`
- Create: `electron/frontmatter.test.ts`

**Interfaces:**
- Produces: `extractMarkieMeta(text): { project: string | null; block: string | null }`
  consumed by Task 15's meta pipeline. Dependency-free CJS (packaged main
  code cannot use js-yaml, which is a devDependency).
- A parity test ties its front matter BOUNDARY detection to
  `src/lib/front-matter.ts` (Task 3) so the two runtimes agree on what a
  front matter block even is.

- [ ] **Step 1: Failing tests**

```ts
// electron/frontmatter.test.ts
import { describe, expect, it } from "vitest";
const { extractMarkieMeta } = require("./frontmatter.js");

describe("extractMarkieMeta", () => {
  it("reads a block-style markie mapping", () => {
    const md = "---\ntitle: X\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\nbody\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "Markie", block: "organized-workspace" });
  });

  it("reads an inline markie mapping", () => {
    const md = "---\nmarkie: { project: \"My App\", block: 'auth flow' }\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "My App", block: "auth flow" });
  });

  it("reads project without block", () => {
    const md = "---\nmarkie:\n  project: Solo\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "Solo", block: null });
  });

  it("ignores markie keys nested under other mappings", () => {
    const md = "---\nouter:\n  markie:\n    project: Nope\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: null, block: null });
  });

  it("returns nulls with no front matter, unterminated fences, or no markie key", () => {
    expect(extractMarkieMeta("# Just a doc\n")).toEqual({ project: null, block: null });
    expect(extractMarkieMeta("---\nmarkie:\n  project: X\n")).toEqual({ project: null, block: null });
    expect(extractMarkieMeta("---\ntitle: X\n---\n")).toEqual({ project: null, block: null });
  });

  it("handles quotes, comments, and CRLF", () => {
    const md = "---\r\nmarkie:\r\n  # which project\r\n  project: \"Quoted Name\"\r\n  block: 'single'\r\n---\r\n";
    expect(extractMarkieMeta(md)).toEqual({ project: "Quoted Name", block: "single" });
  });

  it("treats empty values as absent", () => {
    const md = "---\nmarkie:\n  project: \n  block: real\n---\n";
    expect(extractMarkieMeta(md)).toEqual({ project: null, block: "real" });
  });
});
```

- [ ] **Step 2: Run to fail, implement**

```js
// electron/frontmatter.js
// Reads exactly one thing from a document: the markie:{project,block}
// declaration in leading YAML front matter. Hand-rolled because packaged
// main-process code has no YAML dependency, and deliberately narrow: this is
// not a YAML parser, it is a reader for the one shape Markie documents (and
// the MCP write path) produce. Anything it cannot read safely reads as
// absent, never as an error.
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

function unquote(raw) {
  const t = String(raw ?? "").trim();
  const m = /^"(.*)"$|^'(.*)'$/.exec(t);
  const v = m ? (m[1] !== undefined ? m[1] : m[2]) : t;
  return v || null;
}

function fromInline(rest) {
  // markie: { project: X, block: Y }
  const inner = rest.replace(/^\{/, "").replace(/\}\s*$/, "");
  const out = { project: null, block: null };
  for (const part of inner.split(",")) {
    const m = /^\s*(project|block)\s*:\s*(.+?)\s*$/.exec(part);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

function extractMarkieMeta(text) {
  const src = String(text || "");
  const fm = FRONT_MATTER_RE.exec(src);
  if (!fm) return { project: null, block: null };
  const lines = fm[1].split(/\r?\n/);
  let inMarkie = false;
  const out = { project: null, block: null };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inMarkie) {
      if (indent !== 0) continue; // nested under some other key
      const m = /^markie\s*:\s*(.*)$/.exec(trimmed);
      if (m) {
        if (m[1].trim().startsWith("{")) return fromInline(m[1].trim());
        inMarkie = true;
      }
    } else {
      if (indent === 0) break; // left the markie block
      const m = /^(project|block)\s*:\s*(.*)$/.exec(trimmed);
      if (m) out[m[1]] = unquote(m[2]);
    }
  }
  return out;
}

module.exports = { extractMarkieMeta, FRONT_MATTER_RE };
```

- [ ] **Step 3: Boundary parity test**

Append to `electron/frontmatter.test.ts` (text-level parity, the
ipc-contract style):

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

it("uses the same front matter boundary as src/lib/front-matter.ts", () => {
  // Both runtimes must agree on what a front matter block IS, or the app
  // and the main-process extractor read different documents. Text-level
  // parity, the ipc-contract style: extract each file's FRONT_MATTER_RE
  // literal, strip plain capture parens (the extractor captures the body,
  // the splitter does not), and compare the remaining source.
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const literal = (src: string) => {
    const m = /FRONT_MATTER_RE = \/(.+)\/;/.exec(src);
    expect(m, "FRONT_MATTER_RE literal not found").toBeTruthy();
    // Drop non-(?:...) capture parens so a body-capturing variant compares
    // equal to the plain splitter.
    return m![1].replace(/\((?!\?)/g, "").replace(/(?<!\\)\)(?!\S*\()/g, "");
  };
  // Compare the boundary DECISION prefix (everything up to the closing
  // fence alternatives); the tail newline handling may differ.
  const prefix = (s: string) => s.slice(0, s.indexOf("(?:---|"));
  expect(prefix(literal(read("./frontmatter.js")))).toBe(
    prefix(literal(read("../src/lib/front-matter.ts")))
  );
});
```

If the paren-stripping regex proves brittle, simplify: assert both files
contain the fragments `^---\r?\n` and `(?:---|\.\.\.)` in their
FRONT_MATTER_RE lines. The goal is that a future editor of one file trips
over the other; exact mechanics are yours.

- [ ] **Step 4: Run, commit**

Run: `npm test -- electron/frontmatter.test.ts && npm test && npm run lint`

```bash
git add electron/frontmatter.js electron/frontmatter.test.ts
git commit -m "$(cat <<'MSG'
Read the markie front matter declaration in main, with no YAML dependency

Constraint: Packaged main-process code ships only three native deps; js-yaml
  is renderer-only, so the extractor is hand-rolled and deliberately narrow.
Rejected: Full YAML parsing in main | the only consumer needs two keys from
  one known shape, and a partial parser that fails open (nulls) is safer.
Confidence: high
Scope-risk: narrow
Tested: Block/inline/quoted/CRLF/nested/absent cases; boundary parity with
  the renderer splitter.
Not-tested: Exotic YAML (anchors, multiline scalars) reads as absent by
  design.
MSG
)"
```

---

## Task 14: Registry schema v1 (user_version, decisions, meta, cache)

**Files:**
- Modify: `electron/registry.js` (getDB migration + new statement helpers)
- Modify: `electron/registry.test.ts` (migration + new-table suites)

This is the Spec 5.7 HUMAN CHECKPOINT. Create exactly the tables in the spec
DDL, no more, no fewer. The spec review that approved this plan is the
sign-off; a deviation discovered mid-task is a stop-and-escalate.

**Interfaces:**
- Produces registry functions (all following the existing prepared-statement
  style, all taking/returning plain objects):
  - `schemaVersion(): number`
  - `metaUpsertMany(rows: Array<{ path, mtimeMs, birthtimeMs, fmProject, fmBlock, repoName }>)`
  - `metaAll(): Array<{ path, mtime_ms, birthtime_ms, fm_project, fm_block, repo_name }>`
  - `pinsAll()`, `pinSet({ path, project, blockId })`, `pinClear(path)`
  - `blocksAll()`, `blockUpsert(row)`, `blockSetName(blockId, customName)`,
    `blockMerge(blockId, intoBlockId)`
  - `assignmentsGet(fingerprint)` (returns [] when the stored fingerprint
    differs), `assignmentsSave(fingerprint, rows)`
  - `projectsConfigGet(key)`, `projectsConfigSet(key, value)`

- [ ] **Step 1: Failing migration tests**

Extend `electron/registry.test.ts` (it already stubs Electron and adapts
node:sqlite; reuse its `makeAdapter`/loader plumbing):

```ts
describe("schema v1 migration", () => {
  it("stamps user_version 1 and creates the projects tables", () => {
    // fresh DB via the existing test harness
    expect(registry.schemaVersion()).toBe(1);
    // Tables exist: inserting through the helpers works.
    registry.metaUpsertMany([
      { path: "/a.md", mtimeMs: 5, birthtimeMs: 1, fmProject: "P", fmBlock: null, repoName: "repo" },
    ]);
    expect(registry.metaAll()).toHaveLength(1);
    registry.pinSet({ path: "/a.md", project: "P2", blockId: null });
    expect(registry.pinsAll()).toHaveLength(1);
    registry.pinClear("/a.md");
    expect(registry.pinsAll()).toHaveLength(0);
  });

  it("is idempotent: reopening an already-migrated database changes nothing", () => {
    // close + reopen through the harness; schemaVersion still 1, data intact
  });

  it("keeps user decisions when derived tables are dropped", () => {
    registry.blockUpsert({
      block_id: "b1", project: "P", auto_name: "auto", custom_name: "My Block",
      merged_into: null, created_at: "2026-08-26", updated_at: "2026-08-26",
    });
    registry.assignmentsSave("fp1", [
      { path: "/a.md", project: "P", blockId: "b1", source: "derived", mtimeMs: 5 },
    ]);
    // A different fingerprint invalidates the cache but not the decisions.
    expect(registry.assignmentsGet("fp2")).toEqual([]);
    expect(registry.blocksAll()[0].custom_name).toBe("My Block");
  });

  it("merge records survive and chain", () => {
    registry.blockUpsert({ block_id: "b1", project: "P", auto_name: "a", custom_name: null, merged_into: null, created_at: "t", updated_at: "t" });
    registry.blockUpsert({ block_id: "b2", project: "P", auto_name: "b", custom_name: null, merged_into: null, created_at: "t", updated_at: "t" });
    registry.blockMerge("b1", "b2");
    const b1 = registry.blocksAll().find((b: { block_id: string }) => b.block_id === "b1");
    expect(b1.merged_into).toBe("b2");
  });
});
```

Adapt to the harness's actual import/reset mechanics (it poisons the module
loader; look at how existing cases get a fresh `registry`). If
`db.pragma("user_version")` needs adapter support, extend the test adapter's
`pragma` shim to run `PRAGMA user_version` / `PRAGMA user_version = N`
through node:sqlite; do not weaken registry.js for the adapter.

- [ ] **Step 2: Implement in registry.js**

In `getDB()`, after the existing `share_role` guarded ALTER:

```js
  // Schema versioning starts at 0.5.0. Version 0 is every database that
  // predates it; the PRAGMA-guarded share_role ALTER above predates
  // versioning and stays as-is so any skipped-version database still heals.
  const version = db.pragma("user_version", { simple: true });
  if (version < 1) {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS md_meta (
          path         TEXT PRIMARY KEY,
          mtime_ms     REAL NOT NULL,
          birthtime_ms REAL,
          fm_project   TEXT,
          fm_block     TEXT,
          repo_name    TEXT,
          scanned_at   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_pins (
          path       TEXT PRIMARY KEY,
          project    TEXT NOT NULL,
          block_id   TEXT,
          pinned_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_blocks (
          block_id    TEXT PRIMARY KEY,
          project     TEXT NOT NULL,
          auto_name   TEXT NOT NULL,
          custom_name TEXT,
          merged_into TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_assignments (
          path        TEXT PRIMARY KEY,
          project     TEXT NOT NULL,
          block_id    TEXT,
          source      TEXT NOT NULL,
          mtime_ms    REAL NOT NULL,
          fingerprint TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects_config (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.pragma("user_version = 1");
    });
    migrate();
  }
```

Then the helpers (same file, same style as `listRoots`/`track`; every path
canonicalized through `canonicalPath`):

```js
function schemaVersion() {
  return getDB().pragma("user_version", { simple: true });
}

// ── Projects: per-file metadata extracted from the index ──
function metaUpsertMany(rows) {
  const d = getDB();
  const up = d.prepare(
    `INSERT INTO md_meta (path, mtime_ms, birthtime_ms, fm_project, fm_block, repo_name, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       birthtime_ms = excluded.birthtime_ms,
       fm_project = excluded.fm_project,
       fm_block = excluded.fm_block,
       repo_name = excluded.repo_name,
       scanned_at = excluded.scanned_at`
  );
  const now = new Date().toISOString();
  const tx = d.transaction((list) => {
    for (const r of list) {
      up.run(
        canonicalPath(r.path), r.mtimeMs || 0, r.birthtimeMs ?? null,
        r.fmProject ?? null, r.fmBlock ?? null, r.repoName ?? null, now
      );
    }
  });
  tx(rows);
}

function metaAll() {
  return getDB().prepare("SELECT * FROM md_meta").all();
}

// ── Projects: user decisions (precious) ──
function pinsAll() {
  return getDB().prepare("SELECT * FROM project_pins").all();
}
function pinSet({ path: p, project, blockId }) {
  getDB()
    .prepare(
      `INSERT INTO project_pins (path, project, block_id, pinned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         project = excluded.project, block_id = excluded.block_id,
         pinned_at = excluded.pinned_at`
    )
    .run(canonicalPath(p), project, blockId ?? null, new Date().toISOString());
}
function pinClear(p) {
  getDB().prepare("DELETE FROM project_pins WHERE path = ?").run(canonicalPath(p));
}

function blocksAll() {
  return getDB().prepare("SELECT * FROM project_blocks").all();
}
function blockUpsert(row) {
  getDB()
    .prepare(
      `INSERT INTO project_blocks (block_id, project, auto_name, custom_name, merged_into, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(block_id) DO UPDATE SET
         project = excluded.project,
         auto_name = excluded.auto_name,
         updated_at = excluded.updated_at`
    )
    .run(
      row.block_id, row.project, row.auto_name, row.custom_name ?? null,
      row.merged_into ?? null, row.created_at, row.updated_at
    );
}
function blockSetName(blockId, customName) {
  getDB()
    .prepare("UPDATE project_blocks SET custom_name = ?, updated_at = ? WHERE block_id = ?")
    .run(customName ?? null, new Date().toISOString(), blockId);
}
function blockMerge(blockId, intoBlockId) {
  getDB()
    .prepare("UPDATE project_blocks SET merged_into = ?, updated_at = ? WHERE block_id = ?")
    .run(intoBlockId, new Date().toISOString(), blockId);
}

// ── Projects: derived assignment cache (disposable) ──
function assignmentsGet(fingerprint) {
  const rows = getDB()
    .prepare("SELECT * FROM project_assignments WHERE fingerprint = ?")
    .all(fingerprint);
  return rows;
}
function assignmentsSave(fingerprint, rows) {
  const d = getDB();
  const wipe = d.prepare("DELETE FROM project_assignments");
  const ins = d.prepare(
    `INSERT OR REPLACE INTO project_assignments (path, project, block_id, source, mtime_ms, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = d.transaction((list) => {
    wipe.run();
    for (const r of list) {
      ins.run(canonicalPath(r.path), r.project, r.blockId ?? null, r.source, r.mtimeMs || 0, fingerprint);
    }
  });
  tx(rows);
}

function projectsConfigGet(key) {
  const row = getDB().prepare("SELECT value FROM projects_config WHERE key = ?").get(key);
  return row ? row.value : null;
}
function projectsConfigSet(key, value) {
  getDB()
    .prepare(
      `INSERT INTO projects_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, String(value), new Date().toISOString());
}
```

Export them all from `module.exports`.

- [ ] **Step 3: Run, commit**

Run: `npm test -- electron/registry.test.ts && npm test && npm run lint`

```bash
git add electron/registry.js electron/registry.test.ts
git commit -m "$(cat <<'MSG'
Registry schema v1: user_version plus the projects tables, decisions kept precious

Constraint: Schema changes are a CONSTITUTION human checkpoint; this DDL is
  the one approved in the 0.5.0 design spec (section 5.7), verbatim.
Rejected: Reusing PRAGMA-guarded ALTERs for five new tables | user_version
  gives future migrations one number to reason about instead of N probes.
Confidence: high
Scope-risk: moderate
Directive: project_pins and project_blocks hold user decisions and must
  never be dropped by a cache rebuild; md_meta and project_assignments are
  disposable by contract.
Tested: Fresh-migration, idempotent-reopen, decisions-survive-cache-drop,
  and merge-chain cases through the node:sqlite adapter.
Not-tested: better-sqlite3-specific pragma behavior (covered at runtime by
  the packaged smoke).
MSG
)"
```

---

## Task 15: Metadata pipeline (birthtime, front matter, repo root) joined into the index

**Files:**
- Create: `electron/mdmeta.js`
- Create: `electron/mdmeta.test.ts`
- Modify: `electron/main.js` (`mdRescanAndNotify` and the `mdindex-scan` /
  `mdindex-refresh` handlers join meta into rows)

**Interfaces:**
- Consumes: `extractMarkieMeta` (Task 13), registry meta helpers (Task 14),
  index rows `{ path, name, dir, mtimeMs }` (mdindex).
- Produces:
  - `refreshMeta(rows, deps)` where deps injects `{ registry, readHead,
    statBirthtime, findRepoRoot }`; updates `md_meta` incrementally for rows
    whose mtime changed; returns `{ updated: number }`.
  - `withMeta(rows, metaByPath)` pure join returning rows plus
    `{ birthtimeMs, fmProject, fmBlock, repoName }`.
  - `findRepoRoot(dir, { home, exists, cache })`: nearest ancestor with a
    `.git` entry, stopping at `home`; returns the repo DIRECTORY NAME or
    null; per-directory cache Map.
  - Renderer-visible index rows (both `mdindex-scan` responses and
    `mdindex-updated` payloads) gain those four additive fields.

- [ ] **Step 1: Failing tests**

```ts
// electron/mdmeta.test.ts
import { describe, expect, it, vi } from "vitest";
const { refreshMeta, withMeta, findRepoRoot } = require("./mdmeta.js");

describe("findRepoRoot", () => {
  it("names the nearest ancestor containing .git, stopping at home", () => {
    const exists = (p: string) => p === "/home/u/code/proj/.git";
    expect(findRepoRoot("/home/u/code/proj/docs", { home: "/home/u", exists, cache: new Map() })).toBe("proj");
    expect(findRepoRoot("/home/u/notes", { home: "/home/u", exists, cache: new Map() })).toBeNull();
  });
  it("caches per directory", () => {
    const exists = vi.fn(() => false);
    const cache = new Map();
    findRepoRoot("/home/u/a/b", { home: "/home/u", exists, cache });
    const calls = exists.mock.calls.length;
    findRepoRoot("/home/u/a/b", { home: "/home/u", exists, cache });
    expect(exists.mock.calls.length).toBe(calls);
  });
});

describe("refreshMeta", () => {
  const row = { path: "/home/u/p/a.md", name: "a.md", dir: "/home/u/p", mtimeMs: 100 };

  it("extracts meta for new files and skips unchanged ones", () => {
    const stored = new Map<string, { mtime_ms: number }>();
    const registry = {
      metaAll: () => [...stored.entries()].map(([p, v]) => ({ path: p, ...v })),
      metaUpsertMany: vi.fn((rows: Array<{ path: string; mtimeMs: number }>) => {
        for (const r of rows) stored.set(r.path, { mtime_ms: r.mtimeMs });
      }),
    };
    const readHead = vi.fn(() => "---\nmarkie:\n  project: P\n---\n");
    const deps = {
      registry,
      readHead,
      statBirthtime: () => 42,
      findRepoRoot: () => "p",
    };
    expect(refreshMeta([row], deps).updated).toBe(1);
    expect(registry.metaUpsertMany).toHaveBeenCalledTimes(1);
    expect(refreshMeta([row], deps).updated).toBe(0); // mtime unchanged
    expect(readHead).toHaveBeenCalledTimes(1);
  });

  it("re-extracts when mtime moves", () => {
    const stored = new Map([["/home/u/p/a.md", { mtime_ms: 50 }]]);
    const registry = {
      metaAll: () => [...stored.entries()].map(([p, v]) => ({ path: p, ...v })),
      metaUpsertMany: vi.fn(),
    };
    const deps = {
      registry,
      readHead: () => "",
      statBirthtime: () => null,
      findRepoRoot: () => null,
    };
    expect(refreshMeta([row], deps).updated).toBe(1);
  });
});

describe("withMeta", () => {
  it("joins stored meta onto index rows", () => {
    const metaByPath = new Map([
      ["/a.md", { birthtime_ms: 1, fm_project: "P", fm_block: "B", repo_name: "r" }],
    ]);
    const joined = withMeta([{ path: "/a.md", name: "a.md", dir: "/", mtimeMs: 9 }], metaByPath);
    expect(joined[0]).toMatchObject({
      birthtimeMs: 1,
      fmProject: "P",
      fmBlock: "B",
      repoName: "r",
    });
  });
});
```

- [ ] **Step 2: Implement mdmeta.js**

```js
// electron/mdmeta.js
// Per-file metadata the taxonomy needs beyond the index row: creation time,
// the markie front matter declaration, and the containing repo's name.
// Incremental on purpose: extraction reads file heads, and reading 12k heads
// on every rescan would turn a cheap stat walk into real IO. Only rows whose
// mtime moved since the stored extraction are touched.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { extractMarkieMeta } = require("./frontmatter");

const HEAD_BYTES = 4096;

function defaultReadHead(p) {
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf-8", 0, read);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function defaultStatBirthtime(p) {
  try {
    const st = fs.statSync(p);
    // Some filesystems report 0 or epoch for birthtime; treat that as unknown.
    return st.birthtimeMs > 0 ? st.birthtimeMs : null;
  } catch {
    return null;
  }
}

function findRepoRoot(dir, { home = os.homedir(), exists = fs.existsSync, cache = new Map() } = {}) {
  let d = dir;
  const walked = [];
  let found = null;
  while (d && (d === home || d.startsWith(home + path.sep))) {
    if (cache.has(d)) {
      found = cache.get(d);
      break;
    }
    walked.push(d);
    if (exists(path.join(d, ".git"))) {
      found = path.basename(d);
      break;
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  for (const w of walked) cache.set(w, found);
  return found;
}

// rows: current index rows. Updates md_meta for new/changed paths only.
function refreshMeta(rows, {
  registry,
  readHead = defaultReadHead,
  statBirthtime = defaultStatBirthtime,
  findRepoRoot: findRoot = findRepoRoot,
  home = os.homedir(),
} = {}) {
  const known = new Map(registry.metaAll().map((m) => [m.path, m.mtime_ms]));
  const repoCache = new Map();
  const pending = [];
  for (const row of rows) {
    if (known.get(row.path) === row.mtimeMs) continue;
    const head = readHead(row.path);
    const meta = extractMarkieMeta(head);
    pending.push({
      path: row.path,
      mtimeMs: row.mtimeMs,
      birthtimeMs: statBirthtime(row.path),
      fmProject: meta.project,
      fmBlock: meta.block,
      repoName: findRoot(row.dir, { home, cache: repoCache }),
    });
  }
  if (pending.length) registry.metaUpsertMany(pending);
  return { updated: pending.length };
}

// Pure join for the IPC payloads. metaByPath: Map<path, md_meta row>.
function withMeta(rows, metaByPath) {
  return rows.map((r) => {
    const m = metaByPath.get(r.path);
    return {
      ...r,
      birthtimeMs: m ? m.birthtime_ms : null,
      fmProject: m ? m.fm_project : null,
      fmBlock: m ? m.fm_block : null,
      repoName: m ? m.repo_name : null,
    };
  });
}

module.exports = { refreshMeta, withMeta, findRepoRoot, HEAD_BYTES };
```

- [ ] **Step 3: Wire into main.js**

- In `mdRescanAndNotify`, after `registry.saveIndexCache(result.files)`:

```js
    try {
      const { refreshMeta } = require("./mdmeta");
      refreshMeta(result.files, { registry });
    } catch (err) {
      logCrash("mdmeta-refresh-failed", err);
    }
```

- Add a joining helper near the mdindex handlers and use it in every place a
  scan result or cache is returned/broadcast (`mdindex-scan` return,
  `mdindex-refresh` return, both `mdindex-updated` sends):

```js
function mdRowsWithMeta(result) {
  if (!result || !Array.isArray(result.files)) return result;
  try {
    const { withMeta } = require("./mdmeta");
    const metaByPath = new Map(registry.metaAll().map((m) => [m.path, m]));
    return { ...result, files: withMeta(result.files, metaByPath) };
  } catch {
    return result; // meta is additive; the index must never fail over it
  }
}
```

- Extend the row type in `src/lib/electron.ts` (find the mdindex scan result
  type; add the four optional fields).

- [ ] **Step 4: Run, commit**

Run: `npm test && npm run lint && npm run build`

```bash
git add electron/mdmeta.js electron/mdmeta.test.ts electron/main.js src/lib/electron.ts
git commit -m "$(cat <<'MSG'
Enrich the index with birthtime, front matter, and repo names, incrementally

Constraint: The first pass reads ~12k file heads once; every later rescan
  must touch only files whose mtime moved, or the index stops being cheap.
Rejected: Reading front matter in the renderer per file | 12k IPC round
  trips versus one joined payload the Browse path already ships.
Confidence: high
Scope-risk: moderate
Tested: refreshMeta incremental/changed cases, repo-root walk + cache,
  withMeta join, full suite.
Not-tested: Cold-start wall time on the real 12,370-file index (measured by
  the Task 23 audit script).
MSG
)"
```

---

## Task 16: Rules engine (markie_rules parsing, globs, substitution, known-good fallback)

**Files:**
- Create: `src/lib/projects/rules.ts`
- Create: `src/lib/projects/rules.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ProjectRule { match: string; project: string; block?: string }
export interface ClusteringTunables { gapHours: number; minFiles: number; maxBlocksPerProject: number }
export interface MarkieRules {
  version: 1;
  clustering: ClusteringTunables;
  rules: ProjectRule[];
  ignore: string[];
}
export const DEFAULT_CLUSTERING: ClusteringTunables; // { gapHours: 24, minFiles: 1, maxBlocksPerProject: 30 }
export function parseRules(markdown: string): { rules: MarkieRules | null; error: string | null };
export function compileGlob(pattern: string, home: string): RegExp;
export function applyRules(
  rules: MarkieRules,
  file: { path: string; dir: string; repoName: string | null },
  home: string
): { project: string; block: string | null } | { ignored: true } | null;
```

  consumed by Tasks 17-19 and the audit script (Task 23). `parseRules` takes
  the WHOLE Projects.md markdown (it splits front matter itself via
  `splitFrontMatter`) and reads the `markie_rules` key with js-yaml.

- [ ] **Step 1: Failing tests**

```ts
// src/lib/projects/rules.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLUSTERING,
  applyRules,
  compileGlob,
  parseRules,
} from "@/lib/projects/rules";

const HOME = "/home/u";

const DOC = `---
markie_rules:
  version: 1
  clustering:
    gap_hours: 12
  rules:
    - match: "~/code/**"
      project: "{repo}"
    - match: "~/notes/**"
      project: Notes
      block: "{folder}"
  ignore:
    - "~/scratch/**"
---
# Projects
`;

describe("parseRules", () => {
  it("parses rules, tunables, and ignore globs", () => {
    const { rules, error } = parseRules(DOC);
    expect(error).toBeNull();
    expect(rules?.clustering.gapHours).toBe(12);
    expect(rules?.clustering.minFiles).toBe(DEFAULT_CLUSTERING.minFiles);
    expect(rules?.rules).toHaveLength(2);
    expect(rules?.ignore).toEqual(["~/scratch/**"]);
  });

  it("reports malformed YAML as an error with no rules", () => {
    const { rules, error } = parseRules("---\nmarkie_rules: [unclosed\n---\n");
    expect(rules).toBeNull();
    expect(error).toMatch(/./); // a human-readable parse message
  });

  it("treats a document without markie_rules as empty rules, not an error", () => {
    const { rules, error } = parseRules("---\ntitle: x\n---\nbody");
    expect(error).toBeNull();
    expect(rules?.rules).toEqual([]);
  });

  it("rejects rules missing match or project", () => {
    const bad = `---\nmarkie_rules:\n  rules:\n    - project: NoMatch\n---\n`;
    const { rules, error } = parseRules(bad);
    expect(rules).toBeNull();
    expect(error).toMatch(/match/);
  });
});

describe("compileGlob", () => {
  it("expands ~, * within a segment, ** across segments", () => {
    const re = compileGlob("~/code/**", HOME);
    expect(re.test("/home/u/code/a/b/c.md")).toBe(true);
    expect(re.test("/home/u/notes/a.md")).toBe(false);
    const one = compileGlob("~/notes/*.md", HOME);
    expect(one.test("/home/u/notes/a.md")).toBe(true);
    expect(one.test("/home/u/notes/deep/a.md")).toBe(false);
  });
  it("escapes regex metacharacters in literals", () => {
    const re = compileGlob("~/we(ird)+/**", HOME);
    expect(re.test("/home/u/we(ird)+/x.md")).toBe(true);
  });
});

describe("applyRules", () => {
  const parsed = parseRules(DOC).rules!;
  it("first match wins, with substitutions", () => {
    expect(
      applyRules(parsed, { path: "/home/u/code/myrepo/docs/a.md", dir: "/home/u/code/myrepo/docs", repoName: "myrepo" }, HOME)
    ).toEqual({ project: "myrepo", block: null });
    expect(
      applyRules(parsed, { path: "/home/u/notes/ideas/a.md", dir: "/home/u/notes/ideas", repoName: null }, HOME)
    ).toEqual({ project: "Notes", block: "ideas" });
  });
  it("a {repo} rule without a repo does not match (falls through)", () => {
    expect(
      applyRules(parsed, { path: "/home/u/code/loose.md", dir: "/home/u/code", repoName: null }, HOME)
    ).toBeNull();
  });
  it("ignore wins over everything", () => {
    expect(
      applyRules(parsed, { path: "/home/u/scratch/x.md", dir: "/home/u/scratch", repoName: null }, HOME)
    ).toEqual({ ignored: true });
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/lib/projects/rules.ts
// The user-editable half of the taxonomy: path rules living in Projects.md
// front matter under markie_rules. Parsed with js-yaml (renderer-only
// dependency, already vendored), validated to a strict shape, and NEVER
// allowed to take the view down: a malformed document parses to an error the
// caller pairs with the last known-good rules.
import { load } from "js-yaml";
import { splitFrontMatter } from "@/lib/front-matter";

export interface ProjectRule {
  match: string;
  project: string;
  block?: string;
}
export interface ClusteringTunables {
  gapHours: number;
  minFiles: number;
  maxBlocksPerProject: number;
}
export interface MarkieRules {
  version: 1;
  clustering: ClusteringTunables;
  rules: ProjectRule[];
  ignore: string[];
}

export const DEFAULT_CLUSTERING: ClusteringTunables = {
  gapHours: 24,
  minFiles: 1,
  maxBlocksPerProject: 30,
};

const EMPTY_RULES: MarkieRules = {
  version: 1,
  clustering: DEFAULT_CLUSTERING,
  rules: [],
  ignore: [],
};

export function parseRules(markdown: string): {
  rules: MarkieRules | null;
  error: string | null;
} {
  const { frontMatter } = splitFrontMatter(String(markdown ?? ""));
  if (!frontMatter) return { rules: EMPTY_RULES, error: null };
  const yamlBody = frontMatter
    .replace(/^---\r?\n/, "")
    .replace(/\r?\n(?:---|\.\.\.)(?:\r?\n)?$/, "");
  let doc: unknown;
  try {
    doc = load(yamlBody);
  } catch (err) {
    return { rules: null, error: err instanceof Error ? err.message : String(err) };
  }
  const raw = (doc as { markie_rules?: unknown } | null)?.markie_rules;
  if (raw == null) return { rules: EMPTY_RULES, error: null };
  if (typeof raw !== "object") {
    return { rules: null, error: "markie_rules must be a mapping" };
  }
  const r = raw as Record<string, unknown>;
  const clustering: ClusteringTunables = { ...DEFAULT_CLUSTERING };
  if (typeof r.clustering === "object" && r.clustering !== null) {
    const c = r.clustering as Record<string, unknown>;
    if (typeof c.gap_hours === "number" && c.gap_hours > 0) clustering.gapHours = c.gap_hours;
    if (typeof c.min_files === "number" && c.min_files >= 1) clustering.minFiles = c.min_files;
    if (typeof c.max_blocks_per_project === "number" && c.max_blocks_per_project >= 1) {
      clustering.maxBlocksPerProject = c.max_blocks_per_project;
    }
  }
  const rules: ProjectRule[] = [];
  if (r.rules !== undefined) {
    if (!Array.isArray(r.rules)) return { rules: null, error: "rules must be a list" };
    for (const [i, item] of (r.rules as unknown[]).entries()) {
      const o = item as Record<string, unknown> | null;
      if (!o || typeof o.match !== "string" || !o.match.trim()) {
        return { rules: null, error: `rule ${i + 1} needs a match pattern` };
      }
      if (typeof o.project !== "string" || !o.project.trim()) {
        return { rules: null, error: `rule ${i + 1} needs a project` };
      }
      rules.push({
        match: o.match,
        project: o.project,
        ...(typeof o.block === "string" && o.block.trim() ? { block: o.block } : {}),
      });
    }
  }
  const ignore: string[] = [];
  if (r.ignore !== undefined) {
    if (!Array.isArray(r.ignore)) return { rules: null, error: "ignore must be a list" };
    for (const g of r.ignore as unknown[]) {
      if (typeof g === "string" && g.trim()) ignore.push(g);
    }
  }
  return { rules: { version: 1, clustering, rules, ignore }, error: null };
}

// Minimal glob: ~ expansion, * within a segment, ** across segments.
// Everything else is literal. Backslashes normalize to / before matching so
// Windows paths behave.
export function compileGlob(pattern: string, home: string): RegExp {
  let p = pattern;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + "/" + p.slice(2);
  const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let out = "";
  let i = 0;
  while (i < p.length) {
    if (p.startsWith("**", i)) {
      out += ".*";
      i += 2;
      if (p[i] === "/") i += 1; // "**/" swallows the separator
    } else if (p[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += esc(p[i]);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const normalize = (p: string) => p.replace(/\\/g, "/");

function substitute(
  value: string,
  file: { dir: string; repoName: string | null }
): string | null {
  if (value.includes("{repo}")) {
    if (!file.repoName) return null; // rule cannot apply without a repo
    value = value.split("{repo}").join(file.repoName);
  }
  if (value.includes("{folder}")) {
    const segs = normalize(file.dir).split("/").filter(Boolean);
    const folder = segs[segs.length - 1] ?? "";
    if (!folder) return null;
    value = value.split("{folder}").join(folder);
  }
  return value;
}

export function applyRules(
  rules: MarkieRules,
  file: { path: string; dir: string; repoName: string | null },
  home: string
): { project: string; block: string | null } | { ignored: true } | null {
  const p = normalize(file.path);
  const h = normalize(home);
  for (const g of rules.ignore) {
    if (compileGlob(normalize(g), h).test(p)) return { ignored: true };
  }
  for (const rule of rules.rules) {
    if (!compileGlob(normalize(rule.match), h).test(p)) continue;
    const project = substitute(rule.project, file);
    if (project === null) continue; // substitution unavailable: fall through
    const block = rule.block ? substitute(rule.block, file) : null;
    return { project, block };
  }
  return null;
}
```

Performance note for later tasks: `applyRules` compiles globs per call; the
taxonomy engine (Task 17) must pre-compile once per rules object when
mapping 12k files (hoist `compileGlob` results; add a tiny memo inside
`rules.ts` if profiling in Task 23 shows it matters).

- [ ] **Step 3: Run, commit**

Run: `npm test -- src/lib/projects/rules.test.ts && npm test && npm run lint && npm run build`
(the build check matters here: it proves js-yaml bundles cleanly and the
12MB budget holds.)

```bash
git add src/lib/projects/rules.ts src/lib/projects/rules.test.ts
git commit -m "$(cat <<'MSG'
Parse the user's organization rules from Projects.md, failing safe on bad YAML

Constraint: Malformed YAML must degrade to last-known-good with a warning,
  never to an empty Projects view; parseRules therefore reports errors
  instead of throwing or guessing.
Rejected: A hand-rolled YAML subset in the renderer | js-yaml is already
  vendored, and its parse errors are the warning copy users will read.
Confidence: high
Scope-risk: narrow
Tested: Parse/validate/malformed/absent cases, glob semantics, substitution
  and fall-through, ignore precedence.
Not-tested: Bundle-size delta beyond the CI budget gate (checked by build).
MSG
)"
```

---

## Task 17: Assignment ladder, session clustering, and taxonomy assembly

**Files:**
- Create: `src/lib/projects/assign.ts`
- Create: `src/lib/projects/assign.test.ts`
- Create: `src/lib/projects/cluster.ts`
- Create: `src/lib/projects/cluster.test.ts`
- Create: `src/lib/projects/taxonomy.ts`
- Create: `src/lib/projects/taxonomy.test.ts`

**Interfaces:**
- Consumes: `MarkieRules`, `applyRules`, `DEFAULT_CLUSTERING` (Task 16).
- Produces (consumed by Tasks 20, 22, 23):

```ts
// assign.ts
export interface EngineFile {
  path: string; name: string; dir: string; mtimeMs: number;
  birthtimeMs: number | null;
  fmProject: string | null; fmBlock: string | null;
  repoName: string | null;
}
export interface Pin { path: string; project: string; block_id: string | null }
export const UNFILED = "Unfiled";
export type AssignmentSource = "pin" | "frontmatter" | "rule" | "derived";
export interface ProjectAssignment {
  path: string; project: string;
  fixedBlock: string | null;       // block name fixed by fm/rule, else null
  pinnedBlockId: string | null;    // block id fixed by a pin, else null
  source: AssignmentSource;
}
export function assignProjects(
  files: EngineFile[],
  opts: { pins: Pin[]; rules: MarkieRules; home: string }
): { assignments: ProjectAssignment[]; ignored: number };

// cluster.ts
export interface PriorAssignment { path: string; block_id: string | null; mtime_ms: number }
export interface BlockRecord {
  block_id: string; project: string; auto_name: string;
  custom_name: string | null; merged_into: string | null;
  created_at: string; updated_at: string;
}
export interface DerivedBlocks {
  byPath: Map<string, string>;          // path -> block_id
  blocks: BlockRecord[];                // upserts for the registry
}
export function deriveBlocks(
  project: string,
  files: EngineFile[],                  // the project's derived-source files
  prior: PriorAssignment[],
  knownBlocks: BlockRecord[],
  tunables: ClusteringTunables,
  now?: () => number
): DerivedBlocks;

// taxonomy.ts
export interface FileNode extends EngineFile {}
export interface BlockNode {
  id: string; name: string; made: number; updated: number; files: FileNode[];
}
export interface ProjectNode {
  name: string; made: number; updated: number; fileCount: number;
  blocks: BlockNode[]; isUnfiled: boolean;
}
export interface Taxonomy {
  projects: ProjectNode[];
  totalFiles: number;
  unfiledCount: number;
  assignmentRows: Array<{ path: string; project: string; blockId: string | null; source: AssignmentSource; mtimeMs: number }>;
  blockUpserts: BlockRecord[];
}
export function buildTaxonomy(
  files: EngineFile[],
  opts: {
    pins: Pin[];
    rules: MarkieRules;
    priorAssignments: PriorAssignment[];
    knownBlocks: BlockRecord[];
    home: string;
    now?: () => number;
  }
): Taxonomy;
```

- [ ] **Step 1: Failing tests for the ladder**

```ts
// src/lib/projects/assign.test.ts
import { describe, expect, it } from "vitest";
import { assignProjects, UNFILED, type EngineFile } from "@/lib/projects/assign";
import { parseRules } from "@/lib/projects/rules";

const HOME = "/home/u";
const f = (over: Partial<EngineFile>): EngineFile => ({
  path: "/home/u/x.md", name: "x.md", dir: "/home/u", mtimeMs: 1,
  birthtimeMs: null, fmProject: null, fmBlock: null, repoName: null,
  ...over,
});
const RULES = parseRules(`---
markie_rules:
  rules:
    - match: "~/code/**"
      project: "{repo}"
---
`).rules!;

describe("assignProjects: the precedence ladder", () => {
  it("1. a pin beats front matter, rules, and derivation", () => {
    const file = f({
      path: "/home/u/code/repo1/a.md", dir: "/home/u/code/repo1",
      repoName: "repo1", fmProject: "FM Project",
    });
    const { assignments } = assignProjects([file], {
      pins: [{ path: file.path, project: "Pinned", block_id: "b9" }],
      rules: RULES, home: HOME,
    });
    expect(assignments[0]).toMatchObject({
      project: "Pinned", pinnedBlockId: "b9", source: "pin",
    });
  });

  it("2. front matter beats rules", () => {
    const file = f({
      path: "/home/u/code/repo1/a.md", dir: "/home/u/code/repo1",
      repoName: "repo1", fmProject: "FM Project", fmBlock: "fm-block",
    });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({
      project: "FM Project", fixedBlock: "fm-block", source: "frontmatter",
    });
  });

  it("3. rules beat derivation", () => {
    const file = f({ path: "/home/u/code/repo1/a.md", dir: "/home/u/code/repo1", repoName: "repo1" });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({ project: "repo1", source: "rule" });
  });

  it("4a. fallback: repo name", () => {
    const file = f({ path: "/home/u/elsewhere/repo2/notes/a.md", dir: "/home/u/elsewhere/repo2/notes", repoName: "repo2" });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({ project: "repo2", source: "derived" });
  });

  it("4b. fallback: highest ancestor under a container", () => {
    // ~/Documents/Thesis/chapter1/a.md -> project "Thesis"
    const file = f({
      path: "/home/u/Documents/Thesis/chapter1/a.md",
      dir: "/home/u/Documents/Thesis/chapter1",
    });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0]).toMatchObject({ project: "Thesis", source: "derived" });
  });

  it("4c. a file directly in a container goes to Unfiled", () => {
    const file = f({ path: "/home/u/Desktop/loose.md", dir: "/home/u/Desktop" });
    const { assignments } = assignProjects([file], { pins: [], rules: RULES, home: HOME });
    expect(assignments[0].project).toBe(UNFILED);
  });

  it("ignore rules drop files from the taxonomy and count them", () => {
    const rules = parseRules(`---\nmarkie_rules:\n  ignore:\n    - "~/skip/**"\n---\n`).rules!;
    const { assignments, ignored } = assignProjects(
      [f({ path: "/home/u/skip/a.md", dir: "/home/u/skip" })],
      { pins: [], rules, home: HOME }
    );
    expect(assignments).toHaveLength(0);
    expect(ignored).toBe(1);
  });
});
```

- [ ] **Step 2: Implement assign.ts**

```ts
// src/lib/projects/assign.ts
// The locked precedence ladder, first match wins:
//   1. manual pin  2. front matter  3. path rule  4. derived fallback.
// Derivation here decides only the PROJECT; block derivation (clustering)
// runs later, per project, in cluster.ts.
import { applyRules, type MarkieRules } from "@/lib/projects/rules";

export interface EngineFile {
  path: string;
  name: string;
  dir: string;
  mtimeMs: number;
  birthtimeMs: number | null;
  fmProject: string | null;
  fmBlock: string | null;
  repoName: string | null;
}
export interface Pin { path: string; project: string; block_id: string | null }
export type AssignmentSource = "pin" | "frontmatter" | "rule" | "derived";
export interface ProjectAssignment {
  path: string;
  project: string;
  fixedBlock: string | null;
  pinnedBlockId: string | null;
  source: AssignmentSource;
}

export const UNFILED = "Unfiled";

const norm = (p: string) => p.replace(/\\/g, "/");

// The directories whose direct children are project-shaped. A file living
// DIRECTLY in one of these has no project of its own.
function containers(home: string): string[] {
  const h = norm(home).replace(/\/+$/, "");
  return [h, `${h}/Desktop`, `${h}/Documents`, `${h}/Downloads`];
}

// The highest ancestor of `dir` that sits directly under a container, or
// null (a file living directly in a container has no project of its own).
// Deeper containers win: ~/Documents/Thesis resolves against ~/Documents,
// not against ~.
export function containerChild(dir: string, home: string): string | null {
  const d = norm(dir);
  let best: string | null = null;
  let bestContainerLen = -1;
  for (const c of containers(home)) {
    if (d === c) return null; // the file sits directly in a container
    if (!d.startsWith(c + "/")) continue;
    const rest = d.slice(c.length + 1);
    const first = rest.split("/").filter(Boolean)[0] ?? null;
    if (first && c.length > bestContainerLen) {
      best = first;
      bestContainerLen = c.length;
    }
  }
  return best;
}

export function assignProjects(
  files: EngineFile[],
  opts: { pins: Pin[]; rules: MarkieRules; home: string }
): { assignments: ProjectAssignment[]; ignored: number } {
  const pinByPath = new Map(opts.pins.map((p) => [p.path, p]));
  const out: ProjectAssignment[] = [];
  let ignored = 0;
  for (const file of files) {
    const pin = pinByPath.get(file.path);
    if (pin) {
      out.push({
        path: file.path, project: pin.project,
        fixedBlock: null, pinnedBlockId: pin.block_id, source: "pin",
      });
      continue;
    }
    if (file.fmProject) {
      out.push({
        path: file.path, project: file.fmProject,
        fixedBlock: file.fmBlock, pinnedBlockId: null, source: "frontmatter",
      });
      continue;
    }
    const ruled = applyRules(opts.rules, file, opts.home);
    if (ruled && "ignored" in ruled) {
      ignored += 1;
      continue;
    }
    if (ruled) {
      out.push({
        path: file.path, project: ruled.project,
        fixedBlock: ruled.block, pinnedBlockId: null, source: "rule",
      });
      continue;
    }
    const project = file.repoName ?? containerChild(file.dir, opts.home) ?? UNFILED;
    out.push({
      path: file.path, project,
      fixedBlock: null, pinnedBlockId: null, source: "derived",
    });
  }
  return { assignments: out, ignored };
}
```

Note: the `containerChild` "longest container wins" comparison above
compares a string to a string via a cast that is nonsense as written; fix it
properly during implementation by tracking `bestContainerLen` alongside
`best`. The test (4b/4c) defines the behavior.

- [ ] **Step 3: Failing tests for clustering**

```ts
// src/lib/projects/cluster.test.ts
import { describe, expect, it } from "vitest";
import { deriveBlocks } from "@/lib/projects/cluster";
import { DEFAULT_CLUSTERING } from "@/lib/projects/rules";
import type { EngineFile } from "@/lib/projects/assign";

const HOUR = 3600_000;
const NOW = Date.parse("2026-08-26T12:00:00Z");
const file = (path: string, ageHours: number, dir = "/home/u/p/docs"): EngineFile => ({
  path, name: path.split("/").pop()!, dir,
  mtimeMs: NOW - ageHours * HOUR, birthtimeMs: NOW - ageHours * HOUR - HOUR,
  fmProject: null, fmBlock: null, repoName: null,
});

describe("deriveBlocks", () => {
  it("splits files into sessions at the gap threshold", () => {
    const files = [
      file("/a1.md", 1), file("/a2.md", 2),          // session A
      file("/b1.md", 50), file("/b2.md", 51),        // session B (48h gap)
    ];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const ids = new Set(files.map((f) => res.byPath.get(f.path)));
    expect(ids.size).toBe(2);
    expect(res.byPath.get("/a1.md")).toBe(res.byPath.get("/a2.md"));
    expect(res.byPath.get("/b1.md")).toBe(res.byPath.get("/b2.md"));
  });

  it("names a cluster by its dominant folder", () => {
    const files = [
      file("/home/u/p/auth/a.md", 1, "/home/u/p/auth"),
      file("/home/u/p/auth/b.md", 2, "/home/u/p/auth"),
      file("/home/u/p/misc/c.md", 3, "/home/u/p/misc"),
    ];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(res.blocks[0].auto_name).toBe("auth");
  });

  it("falls back to the newest file's stem, then a dated session name", () => {
    const one = [file("/home/u/p/plan-v2.md", 1, "/home/u/p")];
    const res = deriveBlocks("P", one, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(res.blocks[0].auto_name).toBe("plan-v2");
  });

  it("keeps an unchanged file in its prior block (stability)", () => {
    const files = [file("/a1.md", 1), file("/a2.md", 2)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const priorId = first.byPath.get("/a1.md")!;
    const prior = files.map((f) => ({
      path: f.path, block_id: first.byPath.get(f.path)!, mtime_ms: f.mtimeMs,
    }));
    // Re-derive with one NEW file inside the same window.
    const again = deriveBlocks(
      "P", [...files, file("/a3.md", 1.5)], prior, first.blocks,
      DEFAULT_CLUSTERING, () => NOW
    );
    expect(again.byPath.get("/a1.md")).toBe(priorId);
    expect(again.byPath.get("/a3.md")).toBe(priorId); // joined the near block
  });

  it("routes members of a merged block to the merge target", () => {
    const files = [file("/a1.md", 1)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const id = first.byPath.get("/a1.md")!;
    const merged = first.blocks.map((b) =>
      b.block_id === id ? { ...b, merged_into: "target" } : b
    );
    const prior = [{ path: "/a1.md", block_id: id, mtime_ms: files[0].mtimeMs }];
    const again = deriveBlocks("P", files, prior, merged, DEFAULT_CLUSTERING, () => NOW);
    expect(again.byPath.get("/a1.md")).toBe("target");
  });

  it("adapts the gap when a project would exceed the block cap", () => {
    // 40 files, one every 25 hours: gap 24h would make 40 blocks.
    const files = Array.from({ length: 40 }, (_, i) => file(`/f${i}.md`, i * 25));
    const res = deriveBlocks(
      "P", files, [], [],
      { ...DEFAULT_CLUSTERING, maxBlocksPerProject: 10 }, () => NOW
    );
    const distinct = new Set(files.map((f) => res.byPath.get(f.path)));
    expect(distinct.size).toBeLessThanOrEqual(10);
  });

  it("adopts old ids by majority overlap when adaptation reclusters", () => {
    const files = [file("/a1.md", 1), file("/a2.md", 2), file("/a3.md", 3)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const id = first.byPath.get("/a1.md")!;
    const prior = files.map((f) => ({ path: f.path, block_id: id, mtime_ms: f.mtimeMs }));
    // Force a full recluster by shrinking the cap to 1.
    const res = deriveBlocks(
      "P", files, prior, first.blocks,
      { ...DEFAULT_CLUSTERING, maxBlocksPerProject: 1 }, () => NOW
    );
    expect(res.byPath.get("/a1.md")).toBe(id); // identity survived
  });
});
```

- [ ] **Step 4: Implement cluster.ts**

```ts
// src/lib/projects/cluster.ts
// Work-session clustering: files edited close together in time form one
// block. Everything here is tunable (Projects.md markie_rules.clustering)
// because this WILL be tuned against real data, and everything is stable:
// once a file has a block id, re-derivation moves it only when the file
// itself moved. User renames live in the registry (custom_name) and merges
// (merged_into) are honored here by routing membership to the target.
import type { ClusteringTunables } from "@/lib/projects/rules";
import type { EngineFile } from "@/lib/projects/assign";

export interface PriorAssignment {
  path: string;
  block_id: string | null;
  mtime_ms: number;
}
export interface BlockRecord {
  block_id: string;
  project: string;
  auto_name: string;
  custom_name: string | null;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}
export interface DerivedBlocks {
  byPath: Map<string, string>;
  blocks: BlockRecord[];
}

// Deterministic id: same project + same founding member = same id across
// machines and reruns, so decisions keyed to it stay attached.
function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, "0");
}
const mintId = (project: string, founder: EngineFile) =>
  `b_${hash8(`${project}:${founder.path}:${Math.round(founder.mtimeMs)}`)}`;

// Follow merged_into chains (bounded, cycles tolerated by the bound).
function resolveMerge(id: string, byId: Map<string, BlockRecord>): string {
  let cur = id;
  for (let i = 0; i < 20; i++) {
    const rec = byId.get(cur);
    if (!rec || !rec.merged_into) return cur;
    cur = rec.merged_into;
  }
  return cur;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function dominantFolder(files: EngineFile[]): string | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    const segs = f.dir.replace(/\\/g, "/").split("/").filter(Boolean);
    const folder = segs[segs.length - 1];
    if (!folder) continue;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [folder, n] of counts) {
    if (n > bestN) {
      best = folder;
      bestN = n;
    }
  }
  return best !== null && bestN * 2 >= files.length ? best : null;
}

function autoName(members: EngineFile[]): string {
  const dom = dominantFolder(members);
  if (dom) return dom;
  const newest = [...members].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (newest) return stem(newest.name);
  return "Work session";
}

// Greedy gap clustering over mtime, newest first.
function clusterByGap(files: EngineFile[], gapMs: number): EngineFile[][] {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const clusters: EngineFile[][] = [];
  let current: EngineFile[] = [];
  let lastMtime: number | null = null;
  for (const f of sorted) {
    if (lastMtime !== null && lastMtime - f.mtimeMs > gapMs) {
      clusters.push(current);
      current = [];
    }
    current.push(f);
    lastMtime = f.mtimeMs;
  }
  if (current.length) clusters.push(current);
  return clusters;
}

export function deriveBlocks(
  project: string,
  files: EngineFile[],
  prior: PriorAssignment[],
  knownBlocks: BlockRecord[],
  tunables: ClusteringTunables,
  now: () => number = Date.now
): DerivedBlocks {
  const byId = new Map(knownBlocks.map((b) => [b.block_id, b]));
  const priorByPath = new Map(prior.map((p) => [p.path, p]));
  const byPath = new Map<string, string>();
  const fileByPath = new Map(files.map((f) => [f.path, f]));

  // 1. Stability pass: unchanged files stay where they were.
  const pool: EngineFile[] = [];
  const members = new Map<string, EngineFile[]>(); // blockId -> members
  for (const f of files) {
    const p = priorByPath.get(f.path);
    if (p && p.block_id && p.mtime_ms === f.mtimeMs && byId.has(p.block_id)) {
      const target = resolveMerge(p.block_id, byId);
      byPath.set(f.path, target);
      const arr = members.get(target) ?? [];
      arr.push(f);
      members.set(target, arr);
    } else {
      pool.push(f);
    }
  }

  // 2. New/changed files join the nearest existing block whose time range is
  //    within the gap, else pool for fresh clustering.
  const gapMs = tunables.gapHours * 3600_000;
  const ranges = new Map<string, { min: number; max: number }>();
  for (const [id, m] of members) {
    const times = m.map((x) => x.mtimeMs);
    ranges.set(id, { min: Math.min(...times), max: Math.max(...times) });
  }
  const stillPool: EngineFile[] = [];
  for (const f of pool) {
    let joined: string | null = null;
    let bestDist = Infinity;
    for (const [id, r] of ranges) {
      const dist =
        f.mtimeMs >= r.min && f.mtimeMs <= r.max
          ? 0
          : Math.min(Math.abs(f.mtimeMs - r.min), Math.abs(f.mtimeMs - r.max));
      if (dist <= gapMs && dist < bestDist) {
        joined = id;
        bestDist = dist;
      }
    }
    if (joined) {
      byPath.set(f.path, joined);
      const arr = members.get(joined) ?? [];
      arr.push(f);
      members.set(joined, arr);
      const r = ranges.get(joined)!;
      ranges.set(joined, {
        min: Math.min(r.min, f.mtimeMs),
        max: Math.max(r.max, f.mtimeMs),
      });
    } else {
      stillPool.push(f);
    }
  }

  // 3. Fresh clustering for the remainder.
  const freshClusters = clusterByGap(stillPool, gapMs);
  for (const cluster of freshClusters) {
    const founder = cluster[cluster.length - 1]; // oldest member founds it
    const id = mintId(project, founder);
    for (const f of cluster) byPath.set(f.path, id);
    members.set(id, [...(members.get(id) ?? []), ...cluster]);
  }

  // 4. Adaptive cap: if the project holds too many blocks, recluster
  //    EVERYTHING with doubled gaps until under the cap, adopting old ids by
  //    majority overlap so renames stay attached.
  let effectiveGap = gapMs;
  let finalMembers = members;
  while (finalMembers.size > tunables.maxBlocksPerProject) {
    effectiveGap *= 2;
    const reclustered = clusterByGap(files, effectiveGap);
    const adopted = new Map<string, EngineFile[]>();
    for (const cluster of reclustered) {
      // Which old id covers most of this cluster?
      const votes = new Map<string, number>();
      for (const f of cluster) {
        const old = byPath.get(f.path);
        if (old) votes.set(old, (votes.get(old) ?? 0) + 1);
      }
      let bestId: string | null = null;
      let bestVotes = 0;
      for (const [id, n] of votes) {
        if (n > bestVotes) {
          bestId = id;
          bestVotes = n;
        }
      }
      const founder = cluster[cluster.length - 1];
      const id = bestId && bestVotes * 2 >= cluster.length ? bestId : mintId(project, founder);
      adopted.set(id, [...(adopted.get(id) ?? []), ...cluster]);
    }
    finalMembers = adopted;
    if (effectiveGap > 365 * 24 * 3600_000) break; // never loop forever
  }
  byPath.clear();
  for (const [id, m] of finalMembers) for (const f of m) byPath.set(f.path, id);

  // 5. Materialize block records (upserts). Names: keep existing auto_name
  //    for known ids (naming stability); name new ids from members.
  const nowIso = new Date(now()).toISOString();
  const seenNames = new Set<string>();
  const blocks: BlockRecord[] = [];
  const ordered = [...finalMembers.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map((f) => f.mtimeMs));
    const maxB = Math.max(...b[1].map((f) => f.mtimeMs));
    return maxA - maxB; // oldest first so dedup suffixes hit newer blocks
  });
  for (const [id, m] of ordered) {
    const known = byId.get(id);
    let name = known ? known.auto_name : autoName(m);
    if (!known) {
      let candidate = name;
      let n = 2;
      while (seenNames.has(candidate)) candidate = `${name} (${n++})`;
      name = candidate;
    }
    seenNames.add(name);
    const times = m.map((f) => f.mtimeMs);
    const births = m.map((f) => f.birthtimeMs ?? f.mtimeMs);
    blocks.push({
      block_id: id,
      project,
      auto_name: name,
      custom_name: known ? known.custom_name : null,
      merged_into: known ? known.merged_into : null,
      created_at: known ? known.created_at : new Date(Math.min(...births)).toISOString(),
      updated_at: new Date(Math.max(...times)).toISOString(),
    });
  }
  return { byPath, blocks };
}
```

- [ ] **Step 5: Failing tests for taxonomy assembly, then implement**

```ts
// src/lib/projects/taxonomy.test.ts
import { describe, expect, it } from "vitest";
import { buildTaxonomy } from "@/lib/projects/taxonomy";
import { parseRules } from "@/lib/projects/rules";
import type { EngineFile } from "@/lib/projects/assign";

const HOME = "/home/u";
const NOW = Date.parse("2026-08-26T12:00:00Z");
const HOUR = 3600_000;
const f = (path: string, ageHours: number, over: Partial<EngineFile> = {}): EngineFile => ({
  path, name: path.split("/").pop()!, dir: path.split("/").slice(0, -1).join("/"),
  mtimeMs: NOW - ageHours * HOUR, birthtimeMs: NOW - ageHours * HOUR,
  fmProject: null, fmBlock: null, repoName: null, ...over,
});
const EMPTY = parseRules("").rules!;

describe("buildTaxonomy", () => {
  it("sorts projects, blocks, and files most-recent-first", () => {
    const files = [
      f("/home/u/Documents/Old/a.md", 100),
      f("/home/u/Documents/Fresh/b.md", 1),
      f("/home/u/Documents/Fresh/c.md", 2),
    ];
    const t = buildTaxonomy(files, {
      pins: [], rules: EMPTY, priorAssignments: [], knownBlocks: [],
      home: HOME, now: () => NOW,
    });
    expect(t.projects.map((p) => p.name)).toEqual(["Fresh", "Old"]);
    const fresh = t.projects[0];
    expect(fresh.blocks[0].files.map((x) => x.name)).toEqual(["b.md", "c.md"]);
  });

  it("groups front matter blocks under their declared names", () => {
    const files = [
      f("/home/u/anywhere/x.md", 1, { fmProject: "App", fmBlock: "auth" }),
      f("/home/u/elsewhere/y.md", 2, { fmProject: "App", fmBlock: "auth" }),
      f("/home/u/etc/z.md", 3, { fmProject: "App", fmBlock: "billing" }),
    ];
    const t = buildTaxonomy(files, {
      pins: [], rules: EMPTY, priorAssignments: [], knownBlocks: [],
      home: HOME, now: () => NOW,
    });
    const app = t.projects.find((p) => p.name === "App")!;
    expect(app.blocks.map((b) => b.name)).toEqual(["auth", "billing"]);
    expect(app.blocks[0].files).toHaveLength(2);
  });

  it("applies custom names over auto names", () => {
    const files = [f("/home/u/Documents/P/a.md", 1)];
    const first = buildTaxonomy(files, {
      pins: [], rules: EMPTY, priorAssignments: [], knownBlocks: [],
      home: HOME, now: () => NOW,
    });
    const blockId = first.assignmentRows[0].blockId!;
    const renamed = buildTaxonomy(files, {
      pins: [], rules: EMPTY,
      priorAssignments: first.assignmentRows.map((r) => ({
        path: r.path, block_id: r.blockId, mtime_ms: r.mtimeMs,
      })),
      knownBlocks: first.blockUpserts.map((b) =>
        b.block_id === blockId ? { ...b, custom_name: "My Feature" } : b
      ),
      home: HOME, now: () => NOW,
    });
    const p = renamed.projects.find((x) => x.name === "P")!;
    expect(p.blocks[0].name).toBe("My Feature");
  });

  it("reports unfiled count and marks the Unfiled project", () => {
    const files = [f("/home/u/Desktop/loose.md", 1)];
    const t = buildTaxonomy(files, {
      pins: [], rules: EMPTY, priorAssignments: [], knownBlocks: [],
      home: HOME, now: () => NOW,
    });
    expect(t.unfiledCount).toBe(1);
    expect(t.projects[0].isUnfiled).toBe(true);
  });

  it("emits assignment rows suitable for the registry cache", () => {
    const files = [f("/home/u/Documents/P/a.md", 1)];
    const t = buildTaxonomy(files, {
      pins: [], rules: EMPTY, priorAssignments: [], knownBlocks: [],
      home: HOME, now: () => NOW,
    });
    expect(t.assignmentRows[0]).toMatchObject({
      path: "/home/u/Documents/P/a.md",
      project: "P",
      source: "derived",
      mtimeMs: files[0].mtimeMs,
    });
    expect(t.assignmentRows[0].blockId).toBeTruthy();
  });
});
```

Implement `taxonomy.ts`:

```ts
// src/lib/projects/taxonomy.ts
// Assembles the full tree the UI renders: assignments (the ladder), then
// per-project block derivation (fixed blocks from fm/rules/pins first,
// clustering for the rest), then most-recent-first ordering everywhere.
import {
  assignProjects,
  UNFILED,
  type AssignmentSource,
  type EngineFile,
  type Pin,
} from "@/lib/projects/assign";
import {
  deriveBlocks,
  type BlockRecord,
  type PriorAssignment,
} from "@/lib/projects/cluster";
import type { MarkieRules } from "@/lib/projects/rules";

export interface BlockNode {
  id: string;
  name: string;
  made: number;
  updated: number;
  files: EngineFile[];
}
export interface ProjectNode {
  name: string;
  made: number;
  updated: number;
  fileCount: number;
  blocks: BlockNode[];
  isUnfiled: boolean;
}
export interface Taxonomy {
  projects: ProjectNode[];
  totalFiles: number;
  unfiledCount: number;
  assignmentRows: Array<{
    path: string;
    project: string;
    blockId: string | null;
    source: AssignmentSource;
    mtimeMs: number;
  }>;
  blockUpserts: BlockRecord[];
}

// A stable id for a block fixed by name (front matter or a rule): the same
// declaration lands in the same block everywhere.
const fixedBlockId = (project: string, block: string) =>
  `f_${project}::${block}`;

export function buildTaxonomy(
  files: EngineFile[],
  opts: {
    pins: Pin[];
    rules: MarkieRules;
    priorAssignments: PriorAssignment[];
    knownBlocks: BlockRecord[];
    home: string;
    now?: () => number;
  }
): Taxonomy {
  const now = opts.now ?? Date.now;
  const { assignments } = assignProjects(files, {
    pins: opts.pins,
    rules: opts.rules,
    home: opts.home,
  });
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const byProject = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const arr = byProject.get(a.project) ?? [];
    arr.push(a);
    byProject.set(a.project, arr);
  }

  const assignmentRows: Taxonomy["assignmentRows"] = [];
  const blockUpserts: BlockRecord[] = [];
  const projects: ProjectNode[] = [];
  const customName = new Map(
    opts.knownBlocks.map((b) => [b.block_id, b.custom_name])
  );

  for (const [project, members] of byProject) {
    const blockMembers = new Map<string, { name: string; files: EngineFile[] }>();
    const toCluster: EngineFile[] = [];
    for (const a of members) {
      const f = fileByPath.get(a.path)!;
      if (a.pinnedBlockId) {
        const id = a.pinnedBlockId;
        const cn = customName.get(id);
        const entry = blockMembers.get(id) ?? { name: cn ?? id, files: [] };
        entry.files.push(f);
        blockMembers.set(id, entry);
        assignmentRows.push({ path: a.path, project, blockId: id, source: a.source, mtimeMs: f.mtimeMs });
      } else if (a.fixedBlock) {
        const id = fixedBlockId(project, a.fixedBlock);
        const cn = customName.get(id);
        const entry = blockMembers.get(id) ?? { name: cn ?? a.fixedBlock, files: [] };
        entry.files.push(f);
        blockMembers.set(id, entry);
        assignmentRows.push({ path: a.path, project, blockId: id, source: a.source, mtimeMs: f.mtimeMs });
      } else {
        toCluster.push(f);
      }
    }

    const derived = deriveBlocks(
      project,
      toCluster,
      opts.priorAssignments,
      opts.knownBlocks.filter((b) => b.project === project),
      opts.rules.clustering,
      now
    );
    blockUpserts.push(...derived.blocks);
    for (const b of derived.blocks) {
      const bFiles = toCluster.filter((f) => derived.byPath.get(f.path) === b.block_id);
      if (!bFiles.length) continue;
      const entry = blockMembers.get(b.block_id) ?? {
        name: b.custom_name ?? b.auto_name,
        files: [],
      };
      entry.name = b.custom_name ?? b.auto_name;
      entry.files.push(...bFiles);
      blockMembers.set(b.block_id, entry);
    }
    for (const f of toCluster) {
      assignmentRows.push({
        path: f.path,
        project,
        blockId: derived.byPath.get(f.path) ?? null,
        source: "derived",
        mtimeMs: f.mtimeMs,
      });
    }

    const blocks: BlockNode[] = [...blockMembers.entries()]
      .map(([id, entry]) => {
        const times = entry.files.map((f) => f.mtimeMs);
        const births = entry.files.map((f) => f.birthtimeMs ?? f.mtimeMs);
        return {
          id,
          name: entry.name,
          made: Math.min(...births),
          updated: Math.max(...times),
          files: [...entry.files].sort((a, b) => b.mtimeMs - a.mtimeMs),
        };
      })
      .sort((a, b) => b.updated - a.updated);

    const allTimes = blocks.map((b) => b.updated);
    const allMade = blocks.map((b) => b.made);
    projects.push({
      name: project,
      made: Math.min(...allMade),
      updated: Math.max(...allTimes),
      fileCount: members.length,
      blocks,
      isUnfiled: project === UNFILED,
    });
  }

  projects.sort((a, b) => b.updated - a.updated);
  return {
    projects,
    totalFiles: assignments.length,
    unfiledCount: byProject.get(UNFILED)?.length ?? 0,
    assignmentRows,
    blockUpserts,
  };
}
```

- [ ] **Step 6: Run everything (engine performance sanity included)**

Run: `npm test -- src/lib/projects && npm test && npm run lint && npm run build`

Add one performance canary to `taxonomy.test.ts`:

```ts
it("handles 12k files in well under a second", () => {
  const files = Array.from({ length: 12_000 }, (_, i) =>
    f(`/home/u/Documents/P${i % 40}/d${i % 7}/f${i}.md`, (i % 500) / 3)
  );
  const started = performance.now();
  const t = buildTaxonomy(files, {
    pins: [], rules: EMPTY, priorAssignments: [], knownBlocks: [],
    home: HOME, now: () => NOW,
  });
  expect(t.totalFiles).toBe(12_000);
  expect(performance.now() - started).toBeLessThan(1000);
});
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/projects/assign.ts src/lib/projects/assign.test.ts src/lib/projects/cluster.ts src/lib/projects/cluster.test.ts src/lib/projects/taxonomy.ts src/lib/projects/taxonomy.test.ts
git commit -m "$(cat <<'MSG'
The organization engine: precedence ladder, stable session clustering, taxonomy tree

Constraint: The ladder order (pin, front matter, rule, derived) and
  most-recent-first sorting are locked decisions; the clustering thresholds
  are deliberately tunable because real data will reshape them.
Rejected: Reclustering from scratch each run | block identity must be
  stable or user renames and merges detach; stability + id adoption by
  majority overlap keeps decisions sticky through re-derivation.
Confidence: medium
Scope-risk: moderate
Directive: Tune clustering via markie_rules.clustering and the Task 23
  audit, never by hardcoding machine-specific values.
Tested: Ladder cases, gap/naming/stability/merge/adaptive-cap clustering,
  taxonomy ordering + custom names + cache rows, 12k-file perf canary.
Not-tested: Real-corpus quality (Task 23 owns that).
MSG
)"
```

---

## Task 18: Projects IPC (state, cache, pins, block decisions)

**Files:**
- Modify: `electron/main.js` (five handlers)
- Modify: `electron/preload.js`, `src/lib/electron.ts`

**Interfaces:**
- Produces channels/API:
  - `projects-state` / `projectsState(): Promise<{ pins, blocks, assignments, fingerprint, rulesKnownGood, rulesError }>`
    where `assignments` are the cached rows for the CURRENT index
    fingerprint ([] on mismatch) and `fingerprint` is
    `registry.indexCacheFingerprint(loadIndexCache())`.
  - `projects-save-cache` / `projectsSaveCache({ fingerprint, assignments, blocks, rulesKnownGood })`:
    persists derived state; also stores the raw known-good rules markdown in
    `projects_config` under `rules-known-good`.
  - `projects-pin` / `projectsPin({ path, project, blockId } | { path, clear: true })`
  - `projects-block-set` / `projectsBlockSet({ blockId, customName } | { blockId, mergeInto })`
- All decisions go straight to the registry helpers from Task 14. Handlers
  are thin: no business logic in main.js.

- [ ] **Step 1: Add the handlers**

```js
// ── Projects: virtual organization state ──
handle("projects-state", () => {
  const cached = registry.loadIndexCache();
  const fingerprint = registry.indexCacheFingerprint(cached);
  return {
    pins: registry.pinsAll(),
    blocks: registry.blocksAll(),
    assignments: registry.assignmentsGet(fingerprint),
    fingerprint,
    rulesKnownGood: registry.projectsConfigGet("rules-known-good"),
    rulesError: registry.projectsConfigGet("rules-error"),
  };
}, { onFailure: (err) => ({ pins: [], blocks: [], assignments: [], fingerprint: "", rulesKnownGood: null, rulesError: errorMessage(err) }) });

handle("projects-save-cache", (_e, { fingerprint, assignments, blocks, rulesKnownGood }) => {
  if (Array.isArray(blocks)) for (const b of blocks) registry.blockUpsert(b);
  if (Array.isArray(assignments)) registry.assignmentsSave(String(fingerprint || ""), assignments);
  if (typeof rulesKnownGood === "string") {
    registry.projectsConfigSet("rules-known-good", rulesKnownGood);
    registry.projectsConfigSet("rules-error", "");
  }
  return { ok: true };
}, { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) });

handle("projects-pin", (_e, args) => {
  if (args && args.clear) registry.pinClear(args.path);
  else registry.pinSet(args);
  return { ok: true };
}, { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) });

handle("projects-block-set", (_e, { blockId, customName, mergeInto }) => {
  if (typeof mergeInto === "string") registry.blockMerge(blockId, mergeInto);
  else registry.blockSetName(blockId, customName ?? null);
  return { ok: true };
}, { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) });
```

Shape note: `blockUpsert` takes the snake_case `BlockRecord` row shape the
engine emits (`block_id`, `auto_name`, `custom_name`, `merged_into`,
`created_at`, `updated_at`); Task 14 defined it that way, and
`projects-save-cache` passes the engine's `blockUpserts` through untouched.
One shape, end to end.

Preload:

```js
  projectsState: () => ipcRenderer.invoke("projects-state"),
  projectsSaveCache: (args) => ipcRenderer.invoke("projects-save-cache", args),
  projectsPin: (args) => ipcRenderer.invoke("projects-pin", args),
  projectsBlockSet: (args) => ipcRenderer.invoke("projects-block-set", args),
```

`src/lib/electron.ts`: the four members, typed against the Task 17
interfaces (import types from `@/lib/projects/...` is fine; electron.ts is
renderer code).

- [ ] **Step 2: Verify the contract, run, commit**

Run: `npm test -- electron/ipc-contract.test.ts && npm test && npm run lint && npm run build`

```bash
git add electron/main.js electron/preload.js src/lib/electron.ts electron/registry.js electron/registry.test.ts
git commit -m "$(cat <<'MSG'
Expose the projects state over IPC as thin pass-throughs to the registry

Constraint: main.js is untyped and untested; every handler here is a
  one-line delegation so the logic stays in tested modules.
Confidence: high
Scope-risk: narrow
Tested: IPC contract test (three files in lockstep), registry helpers
  already covered by Task 14.
Not-tested: Renderer consumption (next tasks).
MSG
)"
```

---

## Task 19: Projects.md bootstrap and the renderer projects hook

**Files:**
- Create: `electron/projects-config.js`
- Create: `electron/projects-config.test.ts`
- Modify: `electron/main.js` (channels `projects-config`,
  `projects-write-overview`)
- Modify: `electron/preload.js`, `src/lib/electron.ts`
- Create: `src/lib/use-projects.ts`
- Create: `src/lib/use-projects.test.tsx`

**Interfaces:**
- Produces:
  - `ensureProjectsConfig({ dir, fs? }): { path, content, created }` where
    `dir` is the default workspace root (from `electron/workspace.js`
    `defaultRootPath()`; create the root first via the existing helper if
    missing).
  - `writeOverviewSection(content, listing): string` pure: replaces the body
    below the `<!-- markie:overview -->` marker (or appends the marker) with
    the rendered listing.
  - Channels: `projects-config` (returns `{ path, content, created }`),
    `projects-write-overview` (takes `{ listing }`, rewrites the section on
    disk atomically, refuses when the file has unsaved changes in the app;
    the renderer only calls it from an explicit button).
  - `useProjects(refreshKey: number)` hook returning
    `{ taxonomy, loading, rulesError, configPath, refresh, pin, rename, merge }`:
    fetches `projectsState` + `mdindexScan` + `projects-config`, parses
    rules (falling back to known-good on error), runs `buildTaxonomy`, saves
    the cache when the fingerprint moved, and exposes the decision actions.

- [ ] **Step 1: Failing tests for the config module**

```ts
// electron/projects-config.test.ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { ensureProjectsConfig, writeOverviewSection, DEFAULT_PROJECTS_MD } = require("./projects-config.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "markie-projcfg-"));

describe("ensureProjectsConfig", () => {
  it("creates Projects.md with the default template once", () => {
    const dir = tmp();
    const first = ensureProjectsConfig({ dir });
    expect(first.created).toBe(true);
    expect(first.path).toBe(path.join(dir, "Projects.md"));
    expect(first.content).toContain("markie_rules");
    const second = ensureProjectsConfig({ dir });
    expect(second.created).toBe(false);
  });

  it("never overwrites an existing document", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "Projects.md"), "user content");
    expect(ensureProjectsConfig({ dir }).content).toBe("user content");
  });
});

describe("writeOverviewSection", () => {
  it("replaces everything below the marker", () => {
    const doc = "---\nmarkie_rules: {}\n---\n# Projects\n\n<!-- markie:overview -->\nold listing\n";
    const next = writeOverviewSection(doc, "- ProjectA (3 files)\n");
    expect(next).toContain("<!-- markie:overview -->\n- ProjectA (3 files)\n");
    expect(next).not.toContain("old listing");
  });

  it("appends the marker when missing", () => {
    const doc = "---\nmarkie_rules: {}\n---\n# Projects\n";
    const next = writeOverviewSection(doc, "- P (1 file)\n");
    expect(next).toMatch(/<!-- markie:overview -->\n- P \(1 file\)\n$/);
  });
});
```

- [ ] **Step 2: Implement projects-config.js**

```js
// electron/projects-config.js
// The user's organization document. Created once with a template that
// teaches the format; after that it is the user's file: Markie only ever
// rewrites the region below the overview marker, and only when the user
// asks it to from the Projects view.
const nodeFs = require("fs");
const nodePath = require("path");

const OVERVIEW_MARKER = "<!-- markie:overview -->";

const DEFAULT_PROJECTS_MD = `---
markie_rules:
  version: 1
  clustering:
    gap_hours: 24
    min_files: 1
    max_blocks_per_project: 30
  rules: []
  ignore: []
---
# Projects

This document controls how Markie organizes your markdown into projects and
blocks. Edit the rules above like any front matter; Markie re-reads them on
save. A rule looks like:

\`\`\`yaml
rules:
  - match: "~/Desktop/Coding/**"
    project: "{repo}"
  - match: "~/Documents/Notes/**"
    project: Notes
    block: "{folder}"
\`\`\`

{repo} becomes the containing git repository's name; {folder} becomes the
file's parent folder. Files matching an \`ignore\` glob stay out of the
Projects views entirely.

${OVERVIEW_MARKER}
(The Projects view can write a listing of your projects here.)
`;

function ensureProjectsConfig({ dir, fs = nodeFs, path = nodePath } = {}) {
  const target = path.join(dir, "Projects.md");
  try {
    const existing = fs.readFileSync(target, "utf-8");
    return { path: target, content: existing, created: false };
  } catch {
    // fall through to create
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, DEFAULT_PROJECTS_MD, "utf-8");
  return { path: target, content: DEFAULT_PROJECTS_MD, created: true };
}

function writeOverviewSection(content, listing) {
  const src = String(content ?? "");
  const idx = src.indexOf(OVERVIEW_MARKER);
  const body = `${OVERVIEW_MARKER}\n${String(listing ?? "")}`;
  if (idx === -1) {
    const sep = src.endsWith("\n") ? "\n" : "\n\n";
    return src + sep + body;
  }
  return src.slice(0, idx) + body;
}

module.exports = { ensureProjectsConfig, writeOverviewSection, DEFAULT_PROJECTS_MD, OVERVIEW_MARKER };
```

Main.js handlers (thin; use `workspace.js` for the root):

```js
handle("projects-config", () => {
  const workspace = require("./workspace");
  const dir = workspace.defaultRootPath();
  const { ensureProjectsConfig } = require("./projects-config");
  return ensureProjectsConfig({ dir });
}, { onFailure: (err) => ({ path: "", content: "", created: false, error: errorMessage(err) }) });

handle("projects-write-overview", (_e, { listing }) => {
  const workspace = require("./workspace");
  const { ensureProjectsConfig, writeOverviewSection } = require("./projects-config");
  const cfg = ensureProjectsConfig({ dir: workspace.defaultRootPath() });
  const next = writeOverviewSection(cfg.content, String(listing ?? ""));
  writeFileAtomic(cfg.path, next);
  rememberDisk(cfg.path, next);
  return { ok: true, path: cfg.path };
}, { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) });
```

(`defaultRootPath` must be exported from `workspace.js`; it exists as a
module-level function, add it to the exports if it is not there.)
Preload + electron.ts: `projectsConfig()`, `projectsWriteOverview({ listing })`.

- [ ] **Step 3: The renderer hook with failing tests**

```tsx
// src/lib/use-projects.test.tsx
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { useProjects } from "@/lib/use-projects";

const ROWS = [
  { path: "/home/u/Documents/P/a.md", name: "a.md", dir: "/home/u/Documents/P", mtimeMs: 1000, birthtimeMs: 900, fmProject: null, fmBlock: null, repoName: null },
];

function bridge(over: Record<string, unknown> = {}) {
  return installBridge({
    projectsState: vi.fn(async () => ({
      pins: [], blocks: [], assignments: [], fingerprint: "fp1",
      rulesKnownGood: null, rulesError: null,
    })),
    projectsSaveCache: vi.fn(async () => ({ ok: true })),
    projectsConfig: vi.fn(async () => ({ path: "/home/u/Documents/Markie/Projects.md", content: "", created: false })),
    mdindexScan: vi.fn(async () => ({ files: ROWS, scannedAt: "now" })),
    ...over,
  } as never);
}

describe("useProjects", () => {
  it("computes a taxonomy from index rows and saves the cache", async () => {
    const api = bridge();
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.taxonomy?.projects[0].name).toBe("P");
    expect(api.projectsSaveCache).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: "fp1" })
    );
  });

  it("falls back to known-good rules and surfaces the error on malformed config", async () => {
    const api = bridge({
      projectsConfig: vi.fn(async () => ({
        path: "/p/Projects.md",
        content: "---\nmarkie_rules: [broken\n---\n",
        created: false,
      })),
      projectsState: vi.fn(async () => ({
        pins: [], blocks: [], assignments: [], fingerprint: "fp1",
        rulesKnownGood: "---\nmarkie_rules:\n  rules: []\n---\n",
        rulesError: null,
      })),
    });
    const { result } = renderHook(() => useProjects(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rulesError).toMatch(/./);
    expect(result.current.taxonomy).not.toBeNull(); // known-good kept it alive
  });
});
```

Note: `mdindexScan` is the existing channel Browse uses; check its exact
member name in `src/lib/electron.ts` (`mdindexScan` or similar) and match
it. Implement:

```ts
// src/lib/use-projects.ts
"use client";
// The renderer half of the projects engine: pulls index rows + decisions,
// parses rules (with last-known-good fallback), computes the taxonomy, and
// persists the derived cache when the index fingerprint moves. All heavy
// logic is in src/lib/projects/*; this hook is orchestration only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getElectronAPI } from "@/lib/electron";
import { parseRules, type MarkieRules } from "@/lib/projects/rules";
import { buildTaxonomy, type Taxonomy } from "@/lib/projects/taxonomy";
import type { EngineFile } from "@/lib/projects/assign";

// Path segments arrive normalized from the index; home comes from the config
// path's shape (everything above /Documents/... or the workspace root).
function homeFromConfigPath(configPath: string): string {
  const norm = configPath.replace(/\\/g, "/");
  const m = /^(.*)\/(?:Documents|OneDrive\/Documents)\/Markie\/Projects\.md$/.exec(norm);
  return m ? m[1] : norm.split("/").slice(0, 3).join("/");
}

export function useProjects(refreshKey: number) {
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [loading, setLoading] = useState(true);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const savedFingerprint = useRef<string | null>(null);

  const refresh = useCallback(() => setBump((n) => n + 1), []);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.projectsState) {
      setLoading(false);
      return;
    }
    let alive = true;
    void (async () => {
      setLoading(true);
      const [state, cfg, scan] = await Promise.all([
        api.projectsState!(),
        api.projectsConfig!(),
        api.mdindexScan!(),
      ]);
      if (!alive) return;
      setConfigPath(cfg?.path ?? null);
      // Rules: current document first, last-known-good on error.
      let rules: MarkieRules | null = null;
      let error: string | null = null;
      const parsed = parseRules(cfg?.content ?? "");
      if (parsed.rules) {
        rules = parsed.rules;
      } else {
        error = parsed.error;
        const fallback = state?.rulesKnownGood ? parseRules(state.rulesKnownGood) : null;
        rules = fallback?.rules ?? parseRules("").rules;
      }
      setRulesError(error);
      const files = (Array.isArray(scan?.files) ? scan.files : []) as EngineFile[];
      const home = homeFromConfigPath(cfg?.path ?? "");
      const t = buildTaxonomy(files, {
        pins: state?.pins ?? [],
        rules: rules!,
        priorAssignments: (state?.assignments ?? []).map(
          (a: { path: string; block_id: string | null; mtime_ms: number }) => a
        ),
        knownBlocks: state?.blocks ?? [],
        home,
      });
      if (!alive) return;
      setTaxonomy(t);
      setLoading(false);
      // Persist the derived cache when the index moved (or first run), and
      // record the rules that produced it as known-good when they parsed.
      const fp = state?.fingerprint ?? "";
      if (fp && savedFingerprint.current !== fp) {
        savedFingerprint.current = fp;
        void api.projectsSaveCache!({
          fingerprint: fp,
          assignments: t.assignmentRows.map((r) => ({
            path: r.path, project: r.project, blockId: r.blockId,
            source: r.source, mtimeMs: r.mtimeMs,
          })),
          blocks: t.blockUpserts,
          ...(error === null ? { rulesKnownGood: cfg?.content ?? "" } : {}),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey, bump]);

  const pin = useCallback(
    async (path: string, project: string, blockId: string | null) => {
      await getElectronAPI()?.projectsPin?.({ path, project, blockId });
      refresh();
    },
    [refresh]
  );
  const unpin = useCallback(
    async (path: string) => {
      await getElectronAPI()?.projectsPin?.({ path, clear: true });
      refresh();
    },
    [refresh]
  );
  const rename = useCallback(
    async (blockId: string, customName: string) => {
      await getElectronAPI()?.projectsBlockSet?.({ blockId, customName });
      refresh();
    },
    [refresh]
  );
  const merge = useCallback(
    async (blockId: string, mergeInto: string) => {
      await getElectronAPI()?.projectsBlockSet?.({ blockId, mergeInto });
      refresh();
    },
    [refresh]
  );

  return useMemo(
    () => ({ taxonomy, loading, rulesError, configPath, refresh, pin, unpin, rename, merge }),
    [taxonomy, loading, rulesError, configPath, refresh, pin, unpin, rename, merge]
  );
}
```

Wire the assignment-row shape carefully: `projects-state` returns registry
rows (`block_id`, `mtime_ms` snake_case); `buildTaxonomy` consumes
`PriorAssignment` with exactly those names (Task 17 defined them
snake_case for this reason). The save path converts back to the camelCase
args `projects-save-cache` expects; keep the two shapes visibly distinct.

- [ ] **Step 4: Run, commit**

Run: `npm test && npm run lint && npm run build`

```bash
git add electron/projects-config.js electron/projects-config.test.ts electron/main.js electron/preload.js src/lib/electron.ts src/lib/use-projects.ts src/lib/use-projects.test.tsx
git commit -m "$(cat <<'MSG'
Projects.md exists from first use, and the renderer computes the taxonomy from it

Constraint: The config is a real markdown document the user edits in Markie;
  Markie only ever writes below the overview marker, and only on request.
Rejected: Auto-regenerating the listing on every recompute | background
  writes to an open user document fight the editor and the disk watcher.
Confidence: medium
Scope-risk: moderate
Directive: Malformed rules must keep rendering the last known-good taxonomy
  with a visible error; an empty Projects view is a bug, not a fallback.
Tested: Config create/idempotence/overview-section tests, hook taxonomy +
  known-good-fallback tests.
Not-tested: OneDrive-relocated Documents on Windows (path logic lives in
  workspace.js, already tested there).
MSG
)"
```

---

## Task 20: Files tab rebuilt on the taxonomy (with the Folders sub-view kept)

**Files:**
- Create: `src/components/projects-tree.tsx`
- Create: `src/components/projects-tree.test.tsx`
- Modify: `src/components/library.tsx` (default tab, v2 key migration,
  Files tab content, Projects/Folders sub-toggle)
- Modify: `src/components/library.test.tsx` (tab expectations)

**Interfaces:**
- Consumes: `useProjects` (Task 19).
- Produces: `<ProjectsTree taxonomy onOpenPath activePath onNotice />` and
  the `initialLibTab()` migration rule:
  - storage key becomes `markie.libtab.v2`
  - stored v2 value wins; else legacy v1 `"recent"` maps to `"recent"`;
    anything else (including absence) maps to `"files"` (Spec 5.8: absence
    is not a choice; an explicit Recent click is).
  - a second key `markie.filesview.v1` remembers the Files tab's sub-view
    (`"projects"` default | `"folders"`).

- [ ] **Step 1: Failing tests for the migration rule**

Extract the rule into `src/lib/library-state.ts` (it already exists for
library logic; check its exports and add):

```ts
// added to src/lib/library-state.ts
export type LibTab = "recent" | "files";
export function initialLibTab(
  readKey: (key: string) => string | null
): LibTab {
  const v2 = readKey("markie.libtab.v2");
  if (v2 === "recent" || v2 === "files") return v2;
  return readKey("markie.libtab.v1") === "recent" ? "recent" : "files";
}
```

```ts
// added to src/lib/library-state.test.ts
import { initialLibTab } from "@/lib/library-state";

describe("initialLibTab", () => {
  const store = (m: Record<string, string>) => (k: string) => m[k] ?? null;
  it("defaults new users to files", () => {
    expect(initialLibTab(store({}))).toBe("files");
  });
  it("keeps an explicit legacy recent choice", () => {
    expect(initialLibTab(store({ "markie.libtab.v1": "recent" }))).toBe("recent");
  });
  it("migrates a legacy files choice to files", () => {
    expect(initialLibTab(store({ "markie.libtab.v1": "files" }))).toBe("files");
  });
  it("v2 always wins", () => {
    expect(
      initialLibTab(store({ "markie.libtab.v1": "files", "markie.libtab.v2": "recent" }))
    ).toBe("recent");
  });
});
```

- [ ] **Step 2: Failing component test for the tree**

```tsx
// src/components/projects-tree.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectsTree } from "@/components/projects-tree";
import type { Taxonomy } from "@/lib/projects/taxonomy";

const NOW = Date.now();
const TAXONOMY: Taxonomy = {
  totalFiles: 3,
  unfiledCount: 0,
  assignmentRows: [],
  blockUpserts: [],
  projects: [
    {
      name: "Markie", made: NOW - 1000, updated: NOW, fileCount: 2, isUnfiled: false,
      blocks: [
        {
          id: "b1", name: "organized-workspace", made: NOW - 1000, updated: NOW,
          files: [
            { path: "/p/plan.md", name: "plan.md", dir: "/p", mtimeMs: NOW, birthtimeMs: NOW - 500, fmProject: null, fmBlock: null, repoName: null },
          ],
        },
      ],
    },
  ],
};

describe("ProjectsTree", () => {
  it("renders project > block > file and opens on click", async () => {
    const onOpenPath = vi.fn();
    render(
      <ProjectsTree taxonomy={TAXONOMY} activePath={null} onOpenPath={onOpenPath} filter="" />
    );
    expect(screen.getByText("Markie")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Markie"));
    await userEvent.click(screen.getByText("organized-workspace"));
    await userEvent.click(screen.getByText("plan.md"));
    expect(onOpenPath).toHaveBeenCalledWith("/p/plan.md");
  });

  it("filters across projects, blocks, and file names", () => {
    render(
      <ProjectsTree taxonomy={TAXONOMY} activePath={null} onOpenPath={() => {}} filter="zzz" />
    );
    expect(screen.queryByText("Markie")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Implement the tree and rewire library.tsx**

`projects-tree.tsx`: a compact expandable tree. Requirements: projects
collapsed by default except the two most recently updated; counts and
relative updated-times on project and block rows (reuse the relativeTime
helper pattern from Task 9; extract it to `src/lib/relative-time.ts` with a
two-line test since two components now need it); files show name +
updated time; the active path row is highlighted like the Library's
`isActive` styling; filter prop hides non-matching subtrees (match against
project name, block name, file name, and path, case-insensitive). Keep it
under ~200 lines by composing three small row components. Use only tokens
(`text-muted`, `bg-accent`, `border-border`) and existing text sizes
(`text-[12.5px]` rows, `text-[9px]` badges), matching `library.tsx` rows.

`library.tsx` changes:

1. Replace the `TAB_KEY` initializer with `initialLibTab((k) => localStorage.getItem(k))`
   in a try/catch; `pickTab` writes `markie.libtab.v2`.
2. The Files tab body becomes:

```tsx
        ) : libTab === "files" ? (
          filesSub === "folders" ? (
            <FilesView
              activePath={activePath}
              refreshKey={refreshKey}
              onOpenPath={onOpenPath}
              onNotice={filesNotice}
            />
          ) : (
            <>
              {projects.rulesError && (
                <div className="mx-2 mb-1 rounded-md border border-[color:var(--status-yellow)] px-2 py-1.5 text-[10.5px] text-[var(--status-yellow)]">
                  Projects.md has a rules error: {projects.rulesError}. Using
                  the last working rules.
                </div>
              )}
              <ProjectsTree
                taxonomy={projects.taxonomy}
                activePath={activePath}
                onOpenPath={onOpenPath}
                filter={filter}
              />
            </>
          )
        ) : (
```

   with `const projects = useProjects(refreshKey);` at the top of the
   component (the hook no-ops in web mode) and a
   `const [filesSub, setFilesSub] = useState<"projects" | "folders">(...)`
   persisted under `markie.filesview.v1`.
3. A small segmented control (same styling as the Recent/Files toggle, one
   size down) rendered only when `view === "library" && libTab === "files"`,
   switching Projects/Folders.
4. The filter input currently renders only for the recent tab
   (`libTab === "recent"`); make it render for the files tab too and pass it
   through to `ProjectsTree`.

Update `library.test.tsx`: the default-tab expectations flip to Files, plus
one new case per migration rule (set localStorage before render, assert the
rendered tab). Follow the existing test file's setup for localStorage
seeding.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run lint && npm run build`
Expected: green. Check `library.test.tsx` failures carefully: they should
only be the deliberate default-tab flips.

- [ ] **Step 5: Commit**

```bash
git add src/components/projects-tree.tsx src/components/projects-tree.test.tsx src/components/library.tsx src/components/library.test.tsx src/lib/library-state.ts src/lib/library-state.test.ts src/lib/relative-time.ts src/lib/relative-time.test.ts
git commit -m "$(cat <<'MSG'
Files tab shows your work organized, not an empty folder tree

Constraint: Files becomes the default tab (locked decision); a user who ever
  explicitly clicked Recent keeps Recent via the v1-to-v2 key migration.
Rejected: Deleting the workspace folder tree | it is the only surface with
  mkdir/rename/trash; it stays one sub-toggle away under Folders.
Confidence: medium
Scope-risk: moderate
Tested: Tab migration rules, tree render/open/filter, library tab-flip
  updates, full suite.
Not-tested: Real-corpus tree ergonomics (Task 23 audits it).
MSG
)"
```

---

## Task 21: The full-width view kind in the left rail

**Files:**
- Modify: `src/lib/left-rail.ts`
- Modify: `src/lib/left-rail.test.ts`
- Modify: `src/components/activity-bar.tsx` (Projects button)
- Modify: `src/components/activity-bar.test.tsx`
- Modify: `src/app/page.tsx` (routing, shortcut, palette entry)

**Interfaces:**
- Produces:

```ts
export type FullView = "projects";
export type LeftView = PanelView | "edit" | FullView;
export function isFullView(view: LeftView): view is FullView;
export function showDocumentArea(state: LeftState): boolean; // false only in a full view
// selectLeftView handles "projects": opening closes the panel and replaces
// the document area; clicking again returns to previousPanel with the panel
// open (the same round trip the pencil makes).
```

- [ ] **Step 1: Failing left-rail tests**

Append to `src/lib/left-rail.test.ts` (match its existing style):

```ts
describe("full-width views", () => {
  const base = { panelOpen: true, richVisible: true, canEdit: true } as const;

  it("projects opens full-width: panel closed, document hidden", () => {
    const next = selectLeftView({ ...base, view: "library" }, "projects");
    expect(next).toEqual({ view: "projects", panelOpen: false });
    expect(showDocumentArea({ ...base, view: "projects", panelOpen: false })).toBe(false);
    expect(showSidePanel({ ...base, view: "projects", panelOpen: false })).toBe(false);
  });

  it("clicking projects again returns to the previous panel", () => {
    const next = selectLeftView(
      { ...base, view: "projects", panelOpen: false },
      "projects",
      "browse"
    );
    expect(next).toEqual({ view: "browse", panelOpen: true });
  });

  it("a panel click from projects restores the document area", () => {
    const next = selectLeftView({ ...base, view: "projects", panelOpen: false }, "library");
    expect(next).toEqual({ view: "library", panelOpen: true });
    expect(showDocumentArea({ ...base, view: "library", panelOpen: true })).toBe(true);
  });

  it("edit from projects behaves like edit from anywhere", () => {
    const next = selectLeftView({ ...base, view: "projects", panelOpen: false }, "edit");
    expect(next).toEqual({ view: "edit", panelOpen: false });
  });

  it("the format rail never shows in a full view", () => {
    expect(showFormatRail({ ...base, view: "projects", panelOpen: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Extend left-rail.ts**

```ts
// added/changed in src/lib/left-rail.ts

// ...and one that is neither a panel nor the rail: a view that takes over
// the document area entirely. The Library side panel stays available; a
// full view is additional navigation, not a replacement for it.
export type FullView = "projects";
export type LeftView = PanelView | "edit" | FullView;

export function isFullView(view: LeftView): view is FullView {
  return view === "projects";
}

// The document (editor panes, doc toolbar) renders except while a
// full-width view holds the document area.
export function showDocumentArea(state: LeftState): boolean {
  return !isFullView(state.view);
}
```

In `selectLeftView`, before the existing branches:

```ts
  if (clicked === "projects") {
    if (current.view === "projects") return { view: previousPanel, panelOpen: true };
    return { view: "projects", panelOpen: false };
  }
```

`showFormatRail` already requires `view === "edit"`, so no change; verify
`showSidePanel` returns false for projects via `isPanelView` (it does).

- [ ] **Step 3: Activity bar button + page routing**

`activity-bar.tsx`: add between the Library and Browse NavButtons:

```tsx
      <NavButton label="Projects (⇧⌘L)" active={activeView === "projects"} onClick={() => onSelectView("projects")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </NavButton>
```

Note `active` for a full view ignores `panelOpen` (there is none); the local
`isActive` helper needs a branch:
`v === "edit" || v === "projects" ? activeView === v : panelOpen && activeView === v`.
Extend `activity-bar.test.tsx` accordingly.

`page.tsx`:

- `selectView` works unchanged (it delegates to `selectLeftView`); confirm
  `lastPanelRef` only records panel views:
  `if (isPanelView(next.view)) lastPanelRef.current = next.view;` (adjust
  the existing `next.view !== "edit"` condition, which would now wrongly
  record "projects").
- Keyboard: in the ⌘-switch, `case "l": if (e.shiftKey) selectView("projects") else selectView("library")`
  (⌘L behavior unchanged; ⇧⌘L opens Projects). Note the existing handler
  reads `e.key`, and Shift turns "l" into "L": normalize with
  `e.key.toLowerCase()` for this case only, leaving other cases untouched.
- Palette: `{ id: "projects", title: "Projects", group: "File", shortcut: "⇧⌘L", keywords: "organize blocks workspace virtual folders", run: () => selectView("projects") }`.
- Rendering: wrap the document column (the `flex-1 min-w-0 flex flex-col`
  div holding banner/toolbar/panes) in `showDocumentArea(leftState)` and add
  the alternative:

```tsx
        {showDocumentArea(leftState) ? (
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {/* existing document column children, unchanged */}
          </div>
        ) : (
          <ProjectsView
            onOpenPath={(p) => {
              selectView("projects"); // toggles back to the previous panel
              openPath(p);
            }}
            refreshKey={libRefreshKey}
          />
        )}
```

(`ProjectsView` arrives in Task 22; for THIS task commit, render a
placeholder `<div data-markie-projects-view className="flex-1" />` behind
the same conditional so the routing is testable and the tree stays green,
and note it in the commit message. Alternatively land Tasks 21 and 22 as one
PR-sized unit; the split exists so the pure rail logic gets its own review.)

- [ ] **Step 4: Run, commit**

Run: `npm test && npm run lint && npm run build && wc -l src/app/page.tsx`

```bash
git add src/lib/left-rail.ts src/lib/left-rail.test.ts src/components/activity-bar.tsx src/components/activity-bar.test.tsx src/app/page.tsx
git commit -m "$(cat <<'MSG'
Teach the left rail a third kind of view: one that takes the document area

Constraint: left-rail.ts is small, pure, and fully tested; the full-view
  concept had to land there, not as page-level boolean soup.
Rejected: A modal or a routed page for Projects | the activity bar is where
  view selection already lives, and the round-trip semantics mirror the
  pencil's.
Confidence: high
Scope-risk: narrow
Directive: lastPanelRef records only panel views; a full view must never
  become the "previous panel".
Tested: New selectLeftView/showDocumentArea cases, activity bar button
  tests, existing rail tests green.
Not-tested: The full view's content (next task; a placeholder renders).
MSG
)"
```

---

## Task 22: The full-width Projects view

**Files:**
- Create: `src/components/projects-view.tsx`
- Create: `src/components/projects-view.test.tsx`
- Modify: `src/app/page.tsx` (replace the Task 21 placeholder)

**Interfaces:**
- Consumes: `useProjects` (Task 19), `relative-time` (Task 20),
  `LossRisk`-free (no editor coupling).
- Produces: `<ProjectsView onOpenPath refreshKey />`.

Layout (Spec 5.8, a planner design call flagged for human review): header
with title, search, and summary stats; master-detail body; left column of
projects (most-recent-first, Unfiled visually muted); right pane of the
selected project's blocks as sections with inline rename, made/updated
times, counts, file rows, drag-to-pin, block menu (Rename / Merge into),
row menu (Move to project / Move to block / Unpin), header actions
("Update listing in Projects.md", "Open Projects.md").

- [ ] **Step 1: Failing component tests**

```tsx
// src/components/projects-view.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { ProjectsView } from "@/components/projects-view";

const NOW = Date.now();
const ROWS = [
  { path: "/home/u/Documents/Markie/plan.md", name: "plan.md", dir: "/home/u/Documents/Markie", mtimeMs: NOW, birthtimeMs: NOW - 5000, fmProject: null, fmBlock: null, repoName: null },
  { path: "/home/u/Documents/Thesis/ch1.md", name: "ch1.md", dir: "/home/u/Documents/Thesis", mtimeMs: NOW - 50 * 3600_000, birthtimeMs: null, fmProject: null, fmBlock: null, repoName: null },
];

function bridge(over: Record<string, unknown> = {}) {
  return installBridge({
    projectsState: vi.fn(async () => ({
      pins: [], blocks: [], assignments: [], fingerprint: "fp",
      rulesKnownGood: null, rulesError: null,
    })),
    projectsSaveCache: vi.fn(async () => ({ ok: true })),
    projectsConfig: vi.fn(async () => ({ path: "/home/u/Documents/Markie/Projects.md", content: "", created: false })),
    projectsPin: vi.fn(async () => ({ ok: true })),
    projectsBlockSet: vi.fn(async () => ({ ok: true })),
    projectsWriteOverview: vi.fn(async () => ({ ok: true })),
    mdindexScan: vi.fn(async () => ({ files: ROWS, scannedAt: "now" })),
    ...over,
  } as never);
}

describe("ProjectsView", () => {
  it("lists projects most-recent-first and opens a file", async () => {
    const onOpenPath = vi.fn();
    bridge();
    render(<ProjectsView onOpenPath={onOpenPath} refreshKey={0} />);
    const projectRows = await screen.findAllByRole("button", { name: /Markie|Thesis/ });
    expect(projectRows[0].textContent).toMatch(/Markie/); // newer first
    await userEvent.click(await screen.findByText("plan.md"));
    expect(onOpenPath).toHaveBeenCalledWith("/home/u/Documents/Markie/plan.md");
  });

  it("renames a block inline and persists the decision", async () => {
    const api = bridge();
    render(<ProjectsView onOpenPath={() => {}} refreshKey={0} />);
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByLabelText(/rename block/i));
    const input = screen.getByRole("textbox", { name: /block name/i });
    await userEvent.clear(input);
    await userEvent.type(input, "release planning{Enter}");
    await waitFor(() =>
      expect(api.projectsBlockSet).toHaveBeenCalledWith(
        expect.objectContaining({ customName: "release planning" })
      )
    );
  });

  it("filters everything from the search box", async () => {
    bridge();
    render(<ProjectsView onOpenPath={() => {}} refreshKey={0} />);
    await screen.findByText("plan.md");
    await userEvent.type(screen.getByPlaceholderText(/search/i), "thesis");
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
    expect(screen.getByText("ch1.md")).toBeInTheDocument();
  });

  it("shows the summary stats", async () => {
    bridge();
    render(<ProjectsView onOpenPath={() => {}} refreshKey={0} />);
    await screen.findByText("plan.md");
    expect(screen.getByText(/2 files/i)).toBeInTheDocument();
    expect(screen.getByText(/2 projects/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement**

Structure sketch (implementers own the fine detail; the tests and the token
constraints define done):

```tsx
// src/components/projects-view.tsx
// The full-width organization surface. This does not replace the Library
// panel: it is where organizing is comfortable (wide layout, whole
// hierarchy, timestamps, drag-to-pin), while the panel stays the quick
// navigator.
"use client";
import { useMemo, useState } from "react";
import { useProjects } from "@/lib/use-projects";
import { relativeTime } from "@/lib/relative-time";
import { getElectronAPI } from "@/lib/electron";
import type { ProjectNode, BlockNode } from "@/lib/projects/taxonomy";

export function ProjectsView({
  onOpenPath,
  refreshKey,
}: {
  onOpenPath: (path: string) => void;
  refreshKey: number;
}) {
  const projects = useProjects(refreshKey);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // ...filtering: match project/block/file names + paths, case-insensitive;
  // a matching project keeps all children, a matching block keeps its files.

  // Header: title, search input, stats line
  //   {n projects} · {n blocks} · {n files} · {unfiled} unfiled
  //   [Update listing in Projects.md] [Open Projects.md]
  // Body: grid grid-cols-[260px_1fr]
  //   Left: project rows (button, name, count badge, relative updated),
  //         sorted as delivered (taxonomy is already most-recent-first),
  //         Unfiled row styled text-muted with a dashed border.
  //   Right: for the selected (or first) project, block sections:
  //         header row: name (inline-editable via a pencil button,
  //         aria-label "Rename block", input aria-label "Block name"),
  //         made {relativeTime(made)} · updated {relativeTime(updated)} ·
  //         {files.length} files, a menu (Merge into…, which lists the
  //         project's other blocks), and the file rows
  //         (name, muted dir, relative updated; click = onOpenPath;
  //         draggable, with block sections + project rows as drop targets
  //         calling projects.pin(path, project, blockId)).
  // Empty states: no taxonomy yet ("Markie is indexing…"), a project with
  // one block collapses the block chrome, rulesError banner like Task 20's.
  // All colors via tokens; radius per the scale (cards rounded-md).
  return (
    <div data-markie-projects-view className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
      {/* header + body as above */}
    </div>
  );
}
```

Implementation notes that are requirements, not suggestions:

- Sorting comes from the taxonomy; never re-sort in the component.
- Inline rename commits on Enter or blur, cancels on Escape (copy the
  settled-edit pattern from `files-view.tsx` beginEdit/cancelEdit/submitEdit
  to avoid the double-commit bug documented there).
- Drag-to-pin uses the HTML5 API like `files-view.tsx` does (`draggable`,
  `onDragStart` records the path, `onDrop` on block/project targets calls
  `projects.pin`).
- "Update listing in Projects.md" builds the listing text from the taxonomy
  (`- {project} ({fileCount} files)\n  - {block} ({n})` lines) and calls
  `projectsWriteOverview({ listing })`, then flashes a small confirmation
  line (reuse the notice pattern).
- "Open Projects.md" calls `onOpenPath(projects.configPath!)`.
- Dark/light: verify by running the existing theme audit if it samples this
  surface; at minimum eyeball both modes in `electron:dev`.

- [ ] **Step 3: Replace the Task 21 placeholder in page.tsx**

Swap the placeholder div for `<ProjectsView onOpenPath={...} refreshKey={libRefreshKey} />`
as sketched in Task 21 Step 3.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run lint && npm run build && wc -l src/app/page.tsx`
Expected: green; page.tsx must still be at or under its Task 6 line count
plus the ~15 lines of view routing.

- [ ] **Step 5: Commit**

```bash
git add src/components/projects-view.tsx src/components/projects-view.test.tsx src/app/page.tsx
git commit -m "$(cat <<'MSG'
A full-width Projects view: the workspace, organized, one keystroke away

Constraint: This is additional navigation; the Library panel keeps every
  existing capability, and a file click lands you back in the editor.
Rejected: Reusing the side-panel width for organization work | timestamps,
  hierarchy, and drag targets need room; that is the point of the view.
Confidence: medium
Scope-risk: moderate
Directive: The taxonomy owns all ordering; the view must never re-sort.
Tested: Open/rename/filter/stats component tests; both color modes checked
  by hand in electron:dev.
Not-tested: Drag-and-drop in jsdom (exercised manually; the pin IPC itself
  is covered).
MSG
)"
```

---

## Task 23: Real-data verification and tuning loop

**Files:**
- Create: `scripts/projects-audit.mjs`
- Create: `scripts/projects-audit.test.ts` (pure parts only)

**Interfaces:**
- Consumes: the engine via a dynamic import of the BUILT renderer modules is
  not possible (they are TS); instead the script re-implements NOTHING and
  imports the engine through vitest-adjacent tooling is also unavailable.
  Resolution: run the engine through `npx tsx` is a new dependency, so NO.
  The script therefore runs under `node --experimental-strip-types`, which
  Node 22 supports and the server already uses
  (`server/package.json` scripts). Import the engine TS files directly with
  explicit relative paths and strip-types.
- Produces: a report on stdout plus a JSON file under
  `.autoloop/runs/projects-audit-<timestamp>.json`.

- [ ] **Step 1: Write the script**

```js
// scripts/projects-audit.mjs
// Runs the 0.5.0 organization engine against the REAL device index, read
// only, and reports what the taxonomy would show. This is the release gate
// for the clustering heuristic: if the numbers are junk, the heuristic gets
// tuned, not the report.
//
// Usage: node --experimental-strip-types scripts/projects-audit.mjs
//        [--db <path to registry.db>] [--home <home>] [--json]
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const home = flag("--home") ?? homedir();
const dbPath =
  flag("--db") ??
  path.join(home, "Library", "Application Support", "markie", "registry.db");

const { parseRules } = await import("../src/lib/projects/rules.ts");
const { buildTaxonomy } = await import("../src/lib/projects/taxonomy.ts");

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare("SELECT path, name, mtime_ms FROM md_index_cache").all();
const metaRows = (() => {
  try {
    return db.prepare("SELECT * FROM md_meta").all();
  } catch {
    return []; // pre-migration database: run with empty meta
  }
})();
const pins = (() => {
  try { return db.prepare("SELECT * FROM project_pins").all(); } catch { return []; }
})();
const blocks = (() => {
  try { return db.prepare("SELECT * FROM project_blocks").all(); } catch { return []; }
})();
const metaByPath = new Map(metaRows.map((m) => [m.path, m]));

const files = rows.map((r) => {
  const m = metaByPath.get(r.path);
  return {
    path: r.path,
    name: r.name,
    dir: path.dirname(r.path),
    mtimeMs: r.mtime_ms,
    birthtimeMs: m ? m.birthtime_ms : null,
    fmProject: m ? m.fm_project : null,
    fmBlock: m ? m.fm_block : null,
    repoName: m ? m.repo_name : null,
  };
});

// Rules: read the real Projects.md when it exists.
let rulesDoc = "";
try {
  rulesDoc = fs.readFileSync(path.join(home, "Documents", "Markie", "Projects.md"), "utf-8");
} catch { /* defaults */ }
const parsed = parseRules(rulesDoc);
const rules = parsed.rules ?? parseRules("").rules;

const started = Date.now();
const t = buildTaxonomy(files, {
  pins: pins.map((p) => ({ path: p.path, project: p.project, block_id: p.block_id })),
  rules,
  priorAssignments: [],
  knownBlocks: blocks,
  home,
});
const ms = Date.now() - started;

const singletonBlocks = t.projects.flatMap((p) => p.blocks).filter((b) => b.files.length === 1).length;
const totalBlocks = t.projects.reduce((n, p) => n + p.blocks.length, 0);
const report = {
  generatedAt: new Date().toISOString(),
  indexedFiles: files.length,
  engineMs: ms,
  projects: t.projects.length,
  blocks: totalBlocks,
  unfiled: t.unfiledCount,
  unfiledPct: files.length ? Math.round((t.unfiledCount / files.length) * 1000) / 10 : 0,
  singletonBlockPct: totalBlocks ? Math.round((singletonBlocks / totalBlocks) * 1000) / 10 : 0,
  rulesError: parsed.error,
  top20: t.projects.slice(0, 20).map((p) => ({
    name: p.name,
    files: p.fileCount,
    blocks: p.blocks.length,
    updated: new Date(p.updated).toISOString(),
  })),
};

console.log(`\nMarkie projects audit  (${report.indexedFiles} files, engine ${ms}ms)\n`);
console.log(`projects: ${report.projects}   blocks: ${report.blocks}   unfiled: ${report.unfiled} (${report.unfiledPct}%)   singleton blocks: ${report.singletonBlockPct}%`);
if (report.rulesError) console.log(`RULES ERROR: ${report.rulesError}`);
console.log("\nTop projects:");
for (const p of report.top20) {
  console.log(`  ${p.name.padEnd(32)} ${String(p.files).padStart(5)} files  ${String(p.blocks).padStart(3)} blocks  updated ${p.updated}`);
}
console.log("\nSample tree (5 most recent projects):");
for (const p of t.projects.slice(0, 5)) {
  console.log(`  ${p.name}`);
  for (const b of p.blocks.slice(0, 6)) {
    console.log(`    [${b.name}]  ${b.files.length} files  updated ${new Date(b.updated).toISOString().slice(0, 10)}`);
    for (const f of b.files.slice(0, 3)) console.log(`      ${f.name}`);
  }
}

const outDir = path.join(process.cwd(), ".autoloop", "runs");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `projects-audit-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nReport written to ${outFile}`);

// Gates (Spec 5.9). Exit nonzero so a runner can gate on them.
let failed = false;
if (report.unfiledPct >= 20) {
  console.error(`GATE FAILED: unfiled ${report.unfiledPct}% (must be < 20%)`);
  failed = true;
}
const over = t.projects.filter((p) => p.blocks.length > rules.clustering.maxBlocksPerProject);
if (over.length) {
  console.error(`GATE FAILED: ${over.length} projects exceed the block cap after adaptation`);
  failed = true;
}
process.exit(failed ? 1 : 0);
```

Add an npm script: `"projects:audit": "node --experimental-strip-types scripts/projects-audit.mjs"`.

Verify `--experimental-strip-types` can import the engine chain (rules.ts
imports js-yaml and front-matter.ts; both are dependency-clean for Node).
If the `@/lib/...` alias inside the engine files breaks strip-types
imports, change the engine's INTERNAL imports to relative paths
(`./rules`, `./assign`); that is a mechanical sweep and keeps vitest green.

- [ ] **Step 2: Run it against the real machine (the release gate)**

Run: `npm run projects:audit`

This runs against the owner's live registry (~12,370 indexed files),
read-only. Expected outcome per Spec 5.9:

- Unfiled below 20%.
- No project over the block cap after adaptation.
- The printed sample tree reads like the owner's actual work. This last
  gate is human: show the owner the output and get an explicit yes.

If a gate fails, this is a FINDING: tune `DEFAULT_CLUSTERING`, the naming
rule, or the container list; re-run vitest and the audit; repeat. Record
each tuning change and its measured effect in the commit message. Do not
ship the feature with failing gates, and do not adjust the gates to pass.

Note the first run may show `md_meta` empty (the app has not run the Task 15
pipeline yet). In that case run the app once (`npm run native:restore &&
npm run electron:dev`, open the Files tab, wait for the index) or accept
front-matter-free derivation for the audit and say so in the results.

- [ ] **Step 3: Commit**

```bash
git add scripts/projects-audit.mjs package.json
git commit -m "$(cat <<'MSG'
Audit the taxonomy against the real index before anyone ships it

Constraint: The release gate is the owner's machine: ~12,370 files must
  organize into a tree he recognizes, with Unfiled under 20%.
Rejected: Gating only on synthetic fixtures | the clustering thresholds are
  guesses until real mtimes hit them.
Confidence: high
Scope-risk: narrow
Tested: Audit run on the live registry; numbers and the tuning trail
  recorded here: <fill in actual project/block/unfiled counts>.
Not-tested: Other people's corpora; the tunables in Projects.md are the
  escape hatch.
MSG
)"
```

---

# Phase 4: MCP and agent instructions

All MCP work is additive (Spec 6.4, human checkpoint pre-cleared for exactly
these additions): a new `instructions` field, two new OPTIONAL tool
parameters, updated descriptions, and internal fixes. Never rename a tool,
never add a required parameter, never change an existing result shape.
`mcp/` stays dependency-free and imports nothing from outside `mcp/`. MCP
tests run with `node --test mcp/lib.test.mjs`; put new MCP test cases in that
file so `init.sh` and CI keep working unchanged.

## Task 24: initialize instructions + markie_write_md project/block

**Files:**
- Create: `mcp/conventions.mjs`
- Modify: `mcp/markie-mcp.mjs` (initialize result, TOOLS descriptions,
  markie_write_md handler)
- Modify: `mcp/lib.test.mjs` (new cases)

**Interfaces:**
- Produces:
  - `INSTRUCTIONS` string exported from `mcp/conventions.mjs`.
  - `applyMarkieFrontMatter(content, { project, block }): string` exported
    from `mcp/conventions.mjs`: injects or merges a
    `markie: { project, block }` mapping into leading front matter,
    preserving every other front matter byte.
  - `markie_write_md` inputSchema gains optional `project` and `block`
    string properties.

- [ ] **Step 1: Failing tests**

Append to `mcp/lib.test.mjs`:

```js
import { INSTRUCTIONS, applyMarkieFrontMatter } from "./conventions.mjs";

test("INSTRUCTIONS teach the organization conventions", () => {
  assert.ok(INSTRUCTIONS.length > 200);
  assert.match(INSTRUCTIONS, /markie_find_md/);
  assert.match(INSTRUCTIONS, /project/);
  assert.match(INSTRUCTIONS, /block/);
  assert.match(INSTRUCTIONS, /front matter/i);
});

test("applyMarkieFrontMatter adds front matter to a bare document", () => {
  const out = applyMarkieFrontMatter("# Doc\n", { project: "App", block: "auth" });
  assert.equal(
    out,
    "---\nmarkie:\n  project: App\n  block: auth\n---\n# Doc\n"
  );
});

test("applyMarkieFrontMatter merges into existing front matter, preserving other keys", () => {
  const src = "---\ntitle: T\nmarkie:\n  project: Old\n---\nbody\n";
  const out = applyMarkieFrontMatter(src, { project: "New", block: "b" });
  assert.match(out, /title: T/);
  assert.match(out, /project: New/);
  assert.match(out, /block: b/);
  assert.doesNotMatch(out, /project: Old/);
  assert.match(out, /^---\n/);
});

test("applyMarkieFrontMatter quotes values that need it and skips empties", () => {
  const out = applyMarkieFrontMatter("x\n", { project: "My: App", block: null });
  assert.match(out, /project: "My: App"/);
  assert.doesNotMatch(out, /block:/);
});
```

- [ ] **Step 2: Implement conventions.mjs**

```js
// mcp/conventions.mjs
// What every connected agent should know about Markie, surfaced through the
// MCP initialize handshake (clients hand `instructions` to the model) and
// applied by the write path. Self-contained: no imports from outside mcp/.

export const INSTRUCTIONS = `Markie is the user's local markdown workspace: a
desktop app that renders, organizes, and versions the .md files on this
computer. These tools operate on the user's real files.

Which tool when:
- markie_find_md: search the device-wide markdown index (name or path,
  newest first). Use it BEFORE writing to avoid creating duplicates of a
  document that already exists.
- markie_read_md / markie_write_md: read or write one file by absolute path.
- markie_open_in_markie: show a file to the user in the Markie app. Open a
  document after writing it when the user asked to see the result.
- markie_list_skills: the user's agent instruction files (CLAUDE.md,
  AGENTS.md, skills), grouped by tool.

Organization conventions (Markie groups files into projects and blocks):
- When you write a document, declare where it belongs with the optional
  project and block parameters of markie_write_md, or with front matter:
  ---
  markie:
    project: <the repo or product this belongs to>
    block: <the unit of work, e.g. the feature or investigation>
  ---
- Keep ONE block per unit of work: a feature, a bug hunt, a report series.
- Name blocks after the work ("auth-flow", "q3-report"), never after dates.
- Reuse the user's existing project names (markie_find_md shows paths;
  a repo's documents belong to a project named like the repo).
- Do not invent deep hierarchies: project > block > file is the whole tree.`;

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(\r?\n|$)/;

function yamlValue(v) {
  const s = String(v);
  return /[:#\-?{}[\],&*!|>'"%@`\n]/.test(s) || s !== s.trim()
    ? JSON.stringify(s)
    : s;
}

function markieLines({ project, block }) {
  const lines = ["markie:"];
  if (project) lines.push(`  project: ${yamlValue(project)}`);
  if (block) lines.push(`  block: ${yamlValue(block)}`);
  return lines.join("\n");
}

// Remove an existing top-level `markie:` mapping (the key line plus its
// indented children) from a front matter body.
function stripMarkieBlock(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (skipping) {
      if (line.trim() && indent === 0) skipping = false;
      else continue;
    }
    if (indent === 0 && /^markie\s*:/.test(line.trim())) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

export function applyMarkieFrontMatter(content, { project, block } = {}) {
  const src = String(content ?? "");
  if (!project && !block) return src;
  const decl = markieLines({ project, block });
  const m = FRONT_MATTER_RE.exec(src);
  if (!m) {
    return `---\n${decl}\n---\n${src}`;
  }
  const kept = stripMarkieBlock(m[1]);
  const body = src.slice(m[0].length);
  const fmBody = kept ? `${kept}\n${decl}` : decl;
  return `---\n${fmBody}\n---\n${body}`;
}
```

- [ ] **Step 3: Wire into markie-mcp.mjs**

1. Import: `import { INSTRUCTIONS, applyMarkieFrontMatter } from "./conventions.mjs";`
2. Initialize result gains the field:

```js
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "markie-mcp", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
```

3. `markie_write_md` inputSchema properties gain:

```js
        project: {
          type: "string",
          description:
            "Optional: the Markie project this document belongs to (written into markie front matter)",
        },
        block: {
          type: "string",
          description:
            "Optional: the block (unit of work) inside the project",
        },
```

   and the handler becomes:

```js
    case "markie_write_md": {
      const g = guardPath(args.path, HOME, { mode: "write" });
      if (!g.ok) throw new Error(g.error);
      const body = applyMarkieFrontMatter(String(args.content ?? ""), {
        project: typeof args.project === "string" ? args.project : null,
        block: typeof args.block === "string" ? args.block : null,
      });
      // ... existing mkdir + O_NOFOLLOW write of `body`, unchanged ...
```

4. Update the `markie_write_md` description to mention the convention:
   append `" Declare project/block so Markie files the document in the
   right place."`

- [ ] **Step 4: Round-trip proof into the taxonomy**

Append one integration-shaped case to `mcp/lib.test.mjs` asserting that what
the write path produces is what the app's extractor reads. mcp cannot import
`electron/frontmatter.js`; assert against the exact expected bytes instead
(the extractor's own test suite already covers reading this shape; Task 13's
fixtures use the same layout):

```js
test("the write path emits the exact shape the app's extractor reads", () => {
  const out = applyMarkieFrontMatter("# Plan\n", { project: "Markie", block: "organized-workspace" });
  assert.equal(
    out,
    "---\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\n# Plan\n"
  );
});
```

- [ ] **Step 5: Run, commit**

Run: `node --test mcp/lib.test.mjs && npm test && npm run lint`

```bash
git add mcp/conventions.mjs mcp/markie-mcp.mjs mcp/lib.test.mjs
git commit -m "$(cat <<'MSG'
Teach connected agents what Markie is and how to file their writing

Constraint: MCP tool shape is a human checkpoint; everything here is
  additive (instructions field, two optional params) per the approved spec.
Rejected: A separate markie_organize tool | the declaration belongs on the
  write itself, where the agent already is.
Confidence: high
Scope-risk: narrow
Directive: instructions is client-agnostic (Claude, Codex, GPT apps all
  surface it); never move the conventions into Claude-only surfaces.
Tested: Instructions content, front matter injection/merge/quoting, exact
  write-path-to-extractor byte parity.
Not-tested: How each client renders instructions (out of our hands).
MSG
)"
```

---

## Task 25: Shared classify module fixes markie_list_skills cache noise

**Files:**
- Create: `mcp/agent-classify.mjs`
- Create: `mcp/agent-classify.d.mts`
- Modify: `mcp/lib.mjs` (import instead of local copy)
- Modify: `src/lib/agent-files.ts` (import instead of local copy)
- Modify: `mcp/lib.test.mjs`, `src/lib/agent-files.test.ts` (parity case)

**Interfaces:**
- Produces `mcp/agent-classify.mjs` exporting `CACHED_SEGMENTS`,
  `isCachedAgentPath(path)`, `classifyAgentFile(path, name)`; consumed by
  BOTH runtimes. The import direction is fixed: `src/` may import from
  `mcp/` (Next bundles it; `allowJs: true` and the `.d.mts` type it), `mcp/`
  must never import from `src/` or `electron/` (packaging invariant in the
  `scan.mjs` header).

- [ ] **Step 1: Failing test (the drift bug itself)**

Append to `mcp/lib.test.mjs`:

```js
test("markie_list_skills classification hides plugin-cache noise like the app does", () => {
  // The bug: a skill cloned into ~/.claude/plugins/cache showed in MCP
  // results while the app's Skills panel hid it.
  assert.equal(
    classifyAgentFile("/home/u/.claude/plugins/cache/foo/SKILL.md", "SKILL.md"),
    null
  );
  assert.equal(
    classifyAgentFile("/home/u/.claude/skills/mine/SKILL.md", "SKILL.md"),
    "claude"
  );
});
```

Run `node --test mcp/lib.test.mjs`: the first assertion FAILS against the
current `mcp/lib.mjs` copy (it lacks the cache filter). That failure is the
bug, pinned.

- [ ] **Step 2: Extract the shared module**

```js
// mcp/agent-classify.mjs
// The ONE definition of "which agent tool does this file belong to", shared
// by the app (src/lib/agent-files.ts imports this) and the MCP server
// (lib.mjs). It lives in mcp/ because the MCP server must stay
// self-contained for packaging; the app may reach in, the reverse is
// forbidden.

// Folders that hold copies of somebody else's files; nothing in a cache is
// authored here, so nothing in a cache is one of "your agent files".
export const CACHED_SEGMENTS = [
  "/plugins/cache/",
  "/plugins/marketplaces/",
  "/bundled-marketplaces/",
  "/vendor_imports/",
  "/.tmp/",
  "/tmp/",
  "/node_modules/",
  "/.git/",
  "/caches/",
  "/.cache/",
  "/.trash/",
  "/.removed-skills/",
  "/backups/",
  "/shell-snapshots/",
  "/paste-cache/",
  "/browser-profiles/",
  "/file-history/",
];

export function isCachedAgentPath(path) {
  const p = String(path).toLowerCase().replace(/\\/g, "/");
  return CACHED_SEGMENTS.some((segment) => p.includes(segment));
}

export function classifyAgentFile(path, name) {
  const n = String(name).toLowerCase();
  const p = String(path).toLowerCase().replace(/\\/g, "/");
  if (isCachedAgentPath(p)) return null;
  if (n === "claude.md" || p.includes("/.claude/")) return "claude";
  if (n === "agents.md" || p.includes("/.codex/")) return "openai";
  if (n === "gemini.md") return "gemini";
  if (n === ".cursorrules" || p.includes("/.cursor/rules/")) return "cursor";
  return null;
}
```

```ts
// mcp/agent-classify.d.mts
export declare const CACHED_SEGMENTS: string[];
export declare function isCachedAgentPath(path: string): boolean;
export declare function classifyAgentFile(
  path: string,
  name: string
): "claude" | "openai" | "gemini" | "cursor" | null;
```

- [ ] **Step 3: Point both runtimes at it**

- `mcp/lib.mjs`: delete its local `classifyAgentFile` (lines 135-144) and
  add `export { classifyAgentFile, isCachedAgentPath } from "./agent-classify.mjs";`
  (keep `AGENT_TOOLS` and `groupSkills` where they are; `groupSkills` now
  calls the imported classifier).
- `src/lib/agent-files.ts`: delete `CACHED_SEGMENTS`, `isCachedAgentPath`,
  and the body of `classifyAgentFile` (lines 50-97); replace with:

```ts
import {
  classifyAgentFile as sharedClassify,
  isCachedAgentPath,
} from "../../mcp/agent-classify.mjs";

export { isCachedAgentPath };
export function classifyAgentFile(path: string, name: string): AgentTool | null {
  return sharedClassify(path, name);
}
```

If `npm run build` rejects the outside-src import (Next config or TS
include), the fallback is a `paths` alias in tsconfig
(`"#agent-classify": ["../mcp/agent-classify.mjs"]`); if THAT also fights
the toolchain, stop and reduce scope: keep both copies and add the
text-parity test from Step 4 as the drift guard, noting the deviation in
the commit. Do not burn more than an hour on bundler wrestling.

- [ ] **Step 4: Parity guard**

Append to `src/lib/agent-files.test.ts`:

```ts
import { classifyAgentFile as mcpClassify } from "../../mcp/agent-classify.mjs";

it("classifies identically to the MCP server over a fixture table", () => {
  const cases: Array<[string, string]> = [
    ["/h/.claude/skills/x/SKILL.md", "SKILL.md"],
    ["/h/.claude/plugins/cache/y/SKILL.md", "SKILL.md"],
    ["/h/repo/CLAUDE.md", "CLAUDE.md"],
    ["/h/repo/AGENTS.md", "AGENTS.md"],
    ["/h/.codex/notes.md", "notes.md"],
    ["/h/repo/GEMINI.md", "GEMINI.md"],
    ["/h/.cursor/rules/style.md", "style.md"],
    ["/h/plain.md", "plain.md"],
    ["/h/backups/CLAUDE.md", "CLAUDE.md"],
  ];
  for (const [p, n] of cases) {
    expect(classifyAgentFile(p, n)).toBe(mcpClassify(p, n));
  }
});
```

(After Step 3 both call the same function, making this trivially green; its
value is catching a future re-fork.)

- [ ] **Step 5: Run everything, commit**

Run: `node --test mcp/lib.test.mjs && npm test && npm run lint && npm run build`
Also verify packaging safety: `npm run electron:pack:mac:arm64` is slow; the
cheaper proof is `node --test mcp/lib.test.mjs` executed from a COPY of the
`mcp/` directory alone (`cp -r mcp /tmp/mcp-iso && cd /tmp/mcp-iso && node
--test lib.test.mjs`): it must pass in isolation, proving mcp/ still has no
outside imports. Add that as a comment in the commit if run.

```bash
git add mcp/agent-classify.mjs mcp/agent-classify.d.mts mcp/lib.mjs mcp/lib.test.mjs src/lib/agent-files.ts src/lib/agent-files.test.ts
git commit -m "$(cat <<'MSG'
One classifier for agent files: MCP stops listing the plugin-cache noise the app hides

Constraint: mcp/ must stay import-isolated for extraResource packaging, so
  the shared module lives inside mcp/ and the app reaches in, never the
  reverse.
Rejected: Documenting keep-in-sync harder | the drift already happened once
  (isCachedAgentPath never made it to the mirror).
Confidence: high
Scope-risk: narrow
Tested: The pinned drift case, cross-runtime parity table, mcp/ isolation
  run, full suites.
Not-tested: Windows path classification differences (both sides normalize
  backslashes identically).
MSG
)"
```

---

## Task 26: Budget the MCP scan

**Files:**
- Modify: `mcp/scan.mjs` (walk gains the budget)
- Modify: `mcp/markie-mcp.mjs` (scan() passes nothing; defaults apply)
- Modify: `mcp/lib.test.mjs` (budget cases + constant parity)

**Interfaces:**
- Produces: `walk(rootDir, { home, budget, now, stats })` where `budget`
  merges over `DEFAULT_BUDGET = { maxFiles: 200000, maxMs: 30000, maxDepth: 24 }`
  (exported), mirroring `electron/mdindex.js` semantics: hitting a limit
  returns what was found; `stats` reports `{ files, dirs, ms, truncated, reason }`.

- [ ] **Step 1: Failing tests**

Append to `mcp/lib.test.mjs` (build a deep fixture tree in a temp dir):

```js
import { walk, DEFAULT_BUDGET } from "./scan.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync as readFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("walk stops at maxFiles and reports truncation", async () => {
  const root = mkdtempSync(join(tmpdir(), "markie-scanbudget-"));
  for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.md`), "x");
  const stats = {};
  const rows = await walk(root, { home: root, budget: { maxFiles: 3 }, stats });
  assert.equal(rows.length, 3);
  assert.equal(stats.truncated, true);
  assert.equal(stats.reason, "files");
});

test("walk stops descending past maxDepth", async () => {
  const root = mkdtempSync(join(tmpdir(), "markie-scandepth-"));
  let dir = root;
  for (let i = 0; i < 5; i++) {
    dir = join(dir, `d${i}`);
    mkdirSync(dir);
    writeFileSync(join(dir, `f${i}.md`), "x");
  }
  const stats = {};
  const rows = await walk(root, { home: root, budget: { maxDepth: 2 }, stats });
  assert.ok(rows.length < 5);
  assert.equal(stats.truncated, true);
});

test("budget defaults mirror electron/mdindex.js", () => {
  const mdindexSrc = readFs(new URL("../electron/mdindex.js", import.meta.url), "utf8");
  const m = /DEFAULT_BUDGET = \{ maxFiles: (\d+), maxMs: (\d+), maxDepth: (\d+) \}/.exec(mdindexSrc);
  assert.ok(m, "mdindex DEFAULT_BUDGET literal not found");
  assert.equal(DEFAULT_BUDGET.maxFiles, Number(m[1]));
  assert.equal(DEFAULT_BUDGET.maxMs, Number(m[2]));
  assert.equal(DEFAULT_BUDGET.maxDepth, Number(m[3]));
});
```

(Reading `../electron/mdindex.js` in a TEST is fine; tests are not packaged.
The server code itself keeps zero outside imports.)

- [ ] **Step 2: Implement**

Port the budget mechanics from `electron/mdindex.js` `walk` (lines 179-247)
into `mcp/scan.mjs`, keeping the existing exclusion logic untouched:

```js
export const DEFAULT_BUDGET = { maxFiles: 200000, maxMs: 30000, maxDepth: 24 };

export async function walk(rootDir, { home, budget = {}, now = Date.now, stats = {} } = {}) {
  const baseHome = home ?? rootDir;
  const limits = { ...DEFAULT_BUDGET, ...budget };
  const startedAt = now();
  const allow = allowlist(baseHome);
  const out = [];
  let dirs = 0;
  let stopped = null;
  let depthCapped = false;
  async function visit(dir, depth) {
    if (stopped) return;
    if (depth > limits.maxDepth) {
      depthCapped = true;
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirs += 1;
    const subdirs = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldDescend(full, ent.name, baseHome, allow)) subdirs.push(full);
      } else if (ent.isFile() && MD_RE.test(ent.name)) {
        if (out.length >= limits.maxFiles) {
          stopped = "files";
          return;
        }
        let mtimeMs = 0;
        try { mtimeMs = (await fsp.stat(full)).mtimeMs; } catch { /* keep 0 */ }
        out.push({ path: full, name: ent.name, dir, mtimeMs });
      }
    }
    if (now() - startedAt > limits.maxMs) {
      stopped = "time";
      return;
    }
    for (const d of subdirs) {
      if (stopped) return;
      await visit(d, depth + 1);
    }
  }
  await visit(rootDir, 0);
  stats.files = out.length;
  stats.dirs = dirs;
  stats.ms = now() - startedAt;
  stats.truncated = !!stopped || depthCapped;
  stats.reason = stopped || (depthCapped ? "depth" : null);
  return out;
}
```

Keep the header comment's "keep in sync with electron/mdindex.js" note and
point it at the new parity test.

- [ ] **Step 3: Run, commit**

Run: `node --test mcp/lib.test.mjs && npm test && npm run lint`

```bash
git add mcp/scan.mjs mcp/lib.test.mjs
git commit -m "$(cat <<'MSG'
Give the MCP scan the same budget the app's index has had all along

Constraint: markie_find_md walks $HOME on first call; unbounded, one
  pathological tree turns a tool call into minutes of disk pressure.
Rejected: Importing electron/mdindex.js | mcp/ stays packaging-isolated; a
  test-level constant parity check holds the mirrors together instead.
Confidence: high
Scope-risk: narrow
Tested: maxFiles/maxDepth truncation with temp trees, budget-constant
  parity against mdindex.js.
Not-tested: maxMs on a real slow disk (same mechanism as the tested caps).
MSG
)"
```

---

## Task 27: Plugin skill and the Agents dialog copy

**Files:**
- Create: `mcp/skills/markie-conventions/SKILL.md`
- Modify: `mcp/.claude-plugin/plugin.json` (declare the skill if the plugin
  format requires explicit registration; check how the marketplace plugin
  loads skills: if skills are auto-discovered from a `skills/` directory
  adjacent to the plugin manifest, place it accordingly under `mcp/`)
- Modify: `src/components/agents-dialog.tsx` (conventions line + example)
- Modify or create: the agents-dialog test (`src/components/` has no
  agents-dialog test today; add `agents-dialog.test.tsx` with the new copy
  assertions)

**Interfaces:** none programmatic; deliverables are the skill document and
dialog copy.

- [ ] **Step 1: Write the skill**

```markdown
---
name: markie-conventions
description: Conventions for writing and organizing markdown through the Markie MCP server. Use whenever writing documents for the user via markie_write_md, or when the user asks to organize, file, or find their markdown.
---

# Markie conventions

Markie is the user's local markdown workspace. It organizes files into
projects (a repo or product) containing blocks (units of work). Files never
move on disk; organization is metadata.

## Writing documents

1. Search before you write: `markie_find_md` with a few keywords. Update the
   existing document instead of creating `plan-v2-final.md`.
2. Declare where the document belongs. Either pass `project` and `block` to
   `markie_write_md`, or write front matter yourself:

   ```yaml
   ---
   markie:
     project: bevrly
     block: checkout-redesign
   ---
   ```

3. One block per unit of work: a feature, an investigation, a report series.
   Reuse the block name across that work's documents.
4. Name blocks after the work, not the date: `auth-flow`, not `march-notes`.
5. Match existing project names. A document about a repo belongs to a
   project named like the repo folder.

## Showing results

When the user asked for a document, finish with `markie_open_in_markie` on
the file you wrote so it renders in front of them.
```

If plugin skills need explicit manifest registration, add the minimal field
the format requires; verify by inspecting how the installed Markie plugin
surfaces skills in Claude Code (`/help` or the skills listing) after a local
`claude plugin` reinstall, and record the verification in the commit.

- [ ] **Step 2: Update the Agents dialog copy**

In `agents-dialog.tsx`, under the existing intro paragraph (lines 75-79),
add one paragraph:

```tsx
        <p className="text-[12px] text-muted leading-relaxed">
          Connected agents also receive organization instructions
          automatically: they declare a <code>project</code> and{" "}
          <code>block</code> when writing, so new documents land organized in
          your Projects view instead of loose on disk. Works with Claude
          Code, Codex, and any MCP client.
        </p>
```

New `src/components/agents-dialog.test.tsx` (mock `mcpInfo` via the bridge;
assert the Claude command block, the Codex block, and the new conventions
paragraph render).

- [ ] **Step 3: Run, commit**

Run: `npm test && npm run lint && npm run build && node --test mcp/lib.test.mjs`

```bash
git add mcp/skills/markie-conventions/SKILL.md mcp/.claude-plugin/plugin.json src/components/agents-dialog.tsx src/components/agents-dialog.test.tsx
git commit -m "$(cat <<'MSG'
Ship the organization conventions where agents actually look: a plugin skill and honest dialog copy

Constraint: Claude Code users get conventions without reading docs; other
  MCP clients get the same content via the initialize instructions.
Confidence: medium
Scope-risk: narrow
Tested: Dialog copy component test; skill file lints as valid front matter;
  plugin skill surfaced in a local Claude Code install (recorded here).
Not-tested: Codex/GPT-side skill ergonomics (they rely on instructions).
MSG
)"
```

---

# Phase 5: Server (share-takeover fix)

Server work happens in `server/` (its own package, its own `npm test`,
148 cases at baseline). This phase never deploys, never touches production
data or credentials, and never runs migrations against anything but local
test databases. `server/markie.db` on the dev machine is disposable.

## Task 28: Security upgrades first (better-auth, hono)

**Files:**
- Modify: `server/package.json`, `server/package-lock.json`

- [ ] **Step 1: Upgrade with the tests as the referee**

```bash
cd server
npm install better-auth@^1.6.22
npm install hono@latest
npm test
npm audit --omit dev
```

Expected: all 148 cases green on the upgraded versions BEFORE any behavior
change lands, and `npm audit` no longer reports GHSA-qq9h-g4jm-xgf3 (the
better-auth pre-account-hijacking advisory) or the hono CORS ReDoS advisory.
If a test breaks, that is a real behavioral delta in the upgrade: read the
better-auth changelog between 1.6.16 and the installed version, fix the
usage (not the test), and record what changed in the commit message.

- [ ] **Step 2: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "$(cat <<'MSG'
Take the better-auth and hono security fixes before building on the auth surface

Constraint: better-auth 1.6.16 carries GHSA-qq9h-g4jm-xgf3 (pre-account
  hijacking); the verification work in the next task builds on the fixed
  line, not under it.
Confidence: high
Scope-risk: narrow
Tested: All 148 server cases on the upgraded versions; npm audit clean for
  both advisories (output recorded here).
Not-tested: Production deploy (human checkpoint, runbook in Task 29).
MSG
)"
```

---

## Task 29: Email verification gates every pending-share claim

**Files:**
- Modify: `server/src/auth.ts` (requireEmailVerification, hook rework)
- Modify: `server/src/docs.ts` (claim-on-list gated)
- Modify: `server/src/otp-email.ts` (copy for the email-verification type,
  if not already handled)
- Create: `server/src/claim-verified.test.ts`
- Create: `server/src/migrate-verified.ts` (one-time backfill, run by a
  human at deploy)
- Modify: `src/components/sign-in.tsx` (route "email not verified" into the
  existing OTP view)
- Create/extend: `src/components/sign-in.test.tsx` case
- Modify: `docs/RELEASING.md` or `server/README`-equivalent section with
  the deploy runbook (see Step 5)

**Interfaces:**
- Consumes: better-auth >= 1.6.22 (Task 28).
- Produces: the invariant "no pending invite is ever claimed by an account
  whose email ownership is unproven", enforced at every claim site:
  1. signup hook: claim REMOVED from `user.create.after`.
  2. verification hook: claim added on the emailVerified transition
     (`databaseHooks.user.update.after`, idempotent so over-firing is safe).
  3. `docs.ts` list sweep: gated on `user.emailVerified === true`.
  4. `doc-view.ts` `pendingForToken`: intentionally unchanged (possession of
     the emailed token is proof of receipt; it never converts the pending
     row into an account share). Document this in a comment there.

- [ ] **Step 1: Write the attack as a failing test**

```ts
// server/src/claim-verified.test.ts
// The 0.4.x flaw, pinned: registering someone else's email must not inherit
// their pending shares. Follows the direct-DB + auth.api style of the other
// server suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-claim-")), "t.db");
process.env.BETTER_AUTH_SECRET = "markie-claim-test-secret-32-plus-chars!!";

const { auth } = await import("./auth.ts");
const { addPending } = await import("./pending.ts");
const { claimPendingInvites } = await import("./pending.ts");
await import("./docs.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);

// A doc owned by the sharer, with a pending invite to the victim's address.
db.prepare(
  `INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at, deleted_at)
   VALUES ('doc1', 'sharer', 'Doc', 1, 'c', 'h', '2026-01-01', NULL)`
).run();
addPending("doc1", "victim@corp.com", "editor", "sharer");

test("signing up with the victim's email does NOT claim the pending share", async () => {
  await auth.api.signUpEmail({
    body: {
      email: "victim@corp.com",
      password: "attacker-password-123",
      name: "Attacker",
    },
  });
  const share = db
    .prepare("SELECT * FROM shares WHERE doc_id = 'doc1'")
    .get();
  assert.equal(share, undefined, "pending share must not convert at signup");
  const pending = db
    .prepare("SELECT * FROM pending_shares WHERE doc_id = 'doc1'")
    .get();
  assert.ok(pending, "the invite must still be pending");
});

test("verifying the email claims the pending share exactly once", async () => {
  const user = db
    .prepare("SELECT id FROM user WHERE email = 'victim@corp.com'")
    .get() as { id: string };
  // Simulate what better-auth does when the OTP verifies: flip the flag
  // through the auth API's internal adapter path. If the update hook proves
  // hard to trigger through auth.api in tests, call the hook's extracted
  // claim function directly AND add an integration case using the email-otp
  // verify route; the invariant under test is the claim gating.
  db.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").run(user.id);
  claimPendingInvites("victim@corp.com", user.id); // the hook's body
  const share = db
    .prepare("SELECT * FROM shares WHERE doc_id = 'doc1' AND user_id = ?")
    .get(user.id);
  assert.ok(share, "verified owner of the address receives the share");
});

test("the docs listing sweep refuses unverified users", async () => {
  // Add a second pending invite, then list docs as an unverified session.
  addPending("doc1", "second@corp.com", "viewer", "sharer");
  const res = await auth.api.signUpEmail({
    body: { email: "second@corp.com", password: "password-123456", name: "S" },
  });
  // Depending on requireEmailVerification, signup may not return a session.
  // Either way, the sweep must not have fired:
  const share = db
    .prepare("SELECT s.* FROM shares s JOIN user u ON u.id = s.user_id WHERE u.email = 'second@corp.com'")
    .get();
  assert.equal(share, undefined);
});
```

Adapt the better-auth invocation details (`auth.api.signUpEmail` argument
shape, column names `emailVerified` vs `email_verified` in the generated
schema) to what the installed version actually produces; inspect the `user`
table with `.schema` when in doubt. The three invariants are the contract;
the plumbing follows the library.

Run: `(cd server && npm test)`
Expected: the first test FAILS on the current code (the signup hook claims
immediately). That failure is the vulnerability, pinned.

- [ ] **Step 2: Implement the server fix**

`server/src/auth.ts`:

```ts
  emailAndPassword: {
    enabled: true,
    // The share-takeover fix: an account may exist unverified, but nothing
    // that depends on OWNING the address (sign-in, pending-share claims)
    // happens until the address is proven. GHSA-qq9h-g4jm-xgf3 context.
    requireEmailVerification: true,
  },
  databaseHooks: {
    user: {
      // Claims moved out of create: at creation the email is a claim, not a
      // fact. The update hook fires whenever emailVerified flips true
      // (email-otp verification, Google signup which arrives verified, or
      // any future flow); claimPendingInvites is idempotent, so firing more
      // than once is harmless.
      update: {
        after: async (user: { id: string; email: string; emailVerified?: boolean }) => {
          try {
            if (user.emailVerified && user.email) {
              claimPendingInvites(user.email, user.id);
            }
          } catch (err) {
            console.error("claim-on-verify failed:", err);
          }
        },
      },
      create: {
        after: async (user: { id: string; email: string; emailVerified?: boolean }) => {
          try {
            // Google OAuth arrives verified at creation; that is proof.
            if (user.emailVerified && user.email) {
              claimPendingInvites(user.email, user.id);
            }
          } catch (err) {
            console.error("claim-on-signup failed:", err);
          }
        },
      },
    },
  },
```

Also enable signup verification email through the existing OTP plugin:
`emailOTP({ ..., sendVerificationOnSignUp: true })` (check the exact option
name in the installed version; the plugin sends a code with type
`email-verification`, and `otp-email.ts` must have copy for that type; add
it if its switch only covers sign-in and forget-password).

`server/src/docs.ts` (the list sweep):

```ts
  // Sweep invites only for accounts that have PROVEN this address. An
  // unverified session must never harvest shares addressed to an email the
  // caller merely typed at signup.
  try {
    if (user.email && (user as { emailVerified?: boolean }).emailVerified) {
      claimPendingInvites(user.email, user.id);
    }
  } catch (err) {
    console.error("claim-on-list failed:", err);
  }
```

`server/src/doc-view.ts`: add the comment documenting why `pendingForToken`
stays (possession of the emailed link token proves receipt at that
address; nothing account-bound is created).

Audit for any other `claimPendingInvites` call sites
(`grep -rn claimPendingInvites server/src/`); the four listed in the spec
are the complete set as of this writing; if a new one appeared, gate it the
same way.

- [ ] **Step 3: Keep the 148 existing cases green**

Existing suites create users via signup helpers; with
`requireEmailVerification` some flows now refuse. Add ONE shared helper
(e.g. in the test file that owns user creation, or a small
`server/src/test-users.ts`) that creates a user and marks
`emailVerified = 1` directly in the DB, and switch affected suites to it.
The delta must be mechanical (helper adoption), never a weakened assertion.

Run: `(cd server && npm test)` until fully green, including the new suite.

- [ ] **Step 4: Client routing for the verification flow**

`src/components/sign-in.tsx`: in the password submit handler (line ~100),
when the server refuses with the not-verified error (better-auth returns a
403 with an error code; log the actual body once in dev to get the exact
string, then match on it), call `authClient.sendOTP(email)` and
`setView("otp-code")` instead of surfacing a dead error. The existing
`verifyCode` path (`sign-in/email-otp`) both proves the address and signs
in. Add a `sign-in.test.tsx` case: password sign-in rejects with the
not-verified code, the OTP view renders, and `sendOTP` was called (mock
`authClient`).

- [ ] **Step 5: Migration + deploy runbook (document, do not run)**

```ts
// server/src/migrate-verified.ts
// One-time backfill for the 0.5.0 email-verification deploy: accounts
// created before verification existed are grandfathered as verified so
// existing users keep signing in. Residual risk accepted and documented:
// an attacker account created during the vulnerability window that already
// claimed shares cannot be distinguished retroactively; every FUTURE claim
// requires proof. Run once, by a human, against the production DB, after
// the 0.5.0 server deploy:
//   node --experimental-strip-types src/migrate-verified.ts <cutoff-iso>
import Database from "better-sqlite3";

const cutoff = process.argv[2];
if (!cutoff || Number.isNaN(Date.parse(cutoff))) {
  console.error("usage: migrate-verified.ts <cutoff ISO datetime = deploy time>");
  process.exit(1);
}
const db = new Database(process.env.DB_PATH ?? "./markie.db");
const res = db
  .prepare("UPDATE user SET emailVerified = 1 WHERE createdAt < ? AND emailVerified = 0")
  .run(cutoff);
console.log(`verified ${res.changes} pre-existing accounts (created before ${cutoff})`);
```

Add a "0.5.0 server deploy" subsection to `docs/RELEASING.md`: deploy order
(server first, then migration with the deploy timestamp as cutoff), the
residual-risk note above, and the smoke checks (existing account signs in;
new signup requires the code; the attack test's scenario manually verified
against staging if one exists). Publishing/deploying remains a human
checkpoint; nothing in this task touches production.

- [ ] **Step 6: Run everything, commit**

Run: `(cd server && npm test) && npm test && npm run lint && npm run build`

```bash
git add server/src/auth.ts server/src/docs.ts server/src/doc-view.ts server/src/otp-email.ts server/src/claim-verified.test.ts server/src/migrate-verified.ts src/components/sign-in.tsx src/components/sign-in.test.tsx docs/RELEASING.md
git commit -m "$(cat <<'MSG'
No proof of the address, no shares: verification now gates every pending-invite claim

Constraint: The attack was real: register alice@corp.com before Alice and
  inherit every document shared with her. The regression test IS the attack.
Rejected: Requiring verification only at signup | claim-on-list was a
  second, independent takeover path; every claim site is gated, and the
  emailed-token path is documented as proof-by-possession.
Confidence: medium
Scope-risk: broad
Directive: Any future claimPendingInvites call site must check
  emailVerified; the idempotent claim makes over-firing safe, never
  under-gating.
Tested: The attack test (fails on 0.4.x code, passes now), claim-on-verify,
  unverified-list refusal, all 148 existing cases via the verified-user
  helper, client OTP routing test.
Not-tested: Production migration (documented runbook, human-run).
MSG
)"
```

---

## Task 30: Token-path review test (doc-view)

**Files:**
- Modify: `server/src/doc-view.test.ts`

- [ ] **Step 1: Pin the invited-email token behavior**

Add cases to the existing `doc-view.test.ts` suite:

```ts
test("an emailed invite token still opens the doc for an accountless recipient", async () => {
  // addPending returns the token; GET /d/:id?k=<token> renders the doc.
});

test("withdrawing the invite kills the token immediately", async () => {
  // removePending, then the same GET returns the access page (403).
});

test("an unverified account with the same email gains nothing extra from the token path", async () => {
  // The token grants the READ it always granted; no share row appears for
  // the unverified account as a side effect of viewing.
});
```

Fill in the request mechanics from the suite's existing helpers (it already
tests these routes; extend, do not restructure).

- [ ] **Step 2: Run, commit**

Run: `(cd server && npm test)`

```bash
git add server/src/doc-view.test.ts
git commit -m "$(cat <<'MSG'
Pin why the emailed-token path survives the verification change

Constraint: Possession of the emailed token is proof of receipt at that
  address; the fix must not break accountless recipients, and viewing must
  never mint account shares.
Confidence: high
Scope-risk: narrow
Tested: Token opens, withdrawal kills, no share side effects for unverified
  accounts.
MSG
)"
```

---

# Phase 6: Windows updater

## Task 31: Update policy and channel support win32

**Files:**
- Modify: `electron/update-policy.js`
- Modify: `electron/update-policy.test.ts`
- Modify: `electron/update-channel.js`
- Modify: `electron/update-channel.test.ts`

**Interfaces:**
- Produces:
  - `desktopUpdatePolicy({ platform: "win32", isPackaged: true })` returns
    `{ supported: true, platform: "Windows", feed: "latest.yml" }`.
  - `update-channel.js` `feedFor(channel, platform)` becomes
    platform-aware: darwin keeps `latest-mac.yml`/`beta-mac.yml`; win32 maps
    to `latest.yml`/`beta.yml`. Existing darwin call sites keep working
    (platform defaults to `process.platform`).

- [ ] **Step 1: Failing policy tests**

Extend `electron/update-policy.test.ts`:

```ts
it("supports packaged Windows builds", () => {
  const p = desktopUpdatePolicy({ platform: "win32", isPackaged: true, isDev: false });
  expect(p).toMatchObject({ supported: true, platform: "Windows", feed: "latest.yml" });
});

it("still refuses dev builds on Windows", () => {
  expect(
    desktopUpdatePolicy({ platform: "win32", isPackaged: false, isDev: true }).supported
  ).toBe(false);
});

it("still refuses linux with the platform named", () => {
  const p = desktopUpdatePolicy({ platform: "linux", isPackaged: true, isDev: false });
  expect(p.supported).toBe(false);
  expect(p.message).toMatch(/Linux/);
});
```

- [ ] **Step 2: Implement the policy change**

```js
// in electron/update-policy.js
const WINDOWS_UPDATE_FEED = "latest.yml";

// inside desktopUpdatePolicy, replace the blanket non-darwin refusal:
  if (platform === "darwin") {
    return { supported: true, reason: null, platform: "macOS", feed: MACOS_UPDATE_FEED };
  }
  if (platform === "win32") {
    // The signed Windows build is public (download-manifest windows-x64)
    // and electron-builder writes app-update.yml from the manifest's
    // windows feed path, so a packaged install knows its feed URL already.
    return { supported: true, reason: null, platform: "Windows", feed: WINDOWS_UPDATE_FEED };
  }
  const label = platformLabel(platform);
  return {
    supported: false,
    reason: "unsupported-platform",
    message: `Automatic updates are not enabled for ${label} yet.`,
    detail:
      "This local package can be smoke-tested, but Markie publishes signed macOS and Windows update feeds only. The Linux feed stays disabled until signing, feed files, and public download URLs are approved.",
  };
```

Export `WINDOWS_UPDATE_FEED` too.

- [ ] **Step 3: Failing channel tests, then platform-aware feeds**

Extend `electron/update-channel.test.ts` (follow its existing style; it
tests `feedFor`/`updaterSettingsFor`):

```ts
it("names windows feeds without the -mac suffix", () => {
  expect(feedFor("latest", "win32")).toBe("latest.yml");
  expect(feedFor("beta", "win32")).toBe("beta.yml");
});

it("keeps mac feed names for darwin and by default", () => {
  expect(feedFor("latest", "darwin")).toBe("latest-mac.yml");
  expect(feedFor("latest")).toBe(feedFor("latest", process.platform));
});
```

Implement in `update-channel.js`:

```js
const FEEDS = {
  darwin: { [STABLE_CHANNEL]: "latest-mac.yml", [BETA_CHANNEL]: "beta-mac.yml" },
  win32: { [STABLE_CHANNEL]: "latest.yml", [BETA_CHANNEL]: "beta.yml" },
};

function feedFor(channel, platform = process.platform) {
  const table = FEEDS[platform] ?? FEEDS.darwin;
  return table[channel] ?? table[STABLE_CHANNEL];
}
```

Check every `feedFor` caller (grep in `electron/` and `scripts/`) and thread
the platform where a caller is platform-specific; `updaterSettingsFor`
consumers in `main.js` use the process default, which is correct.

- [ ] **Step 4: Run everything (packaged smoke config included)**

Run: `npm test && npm run lint && npm run build`
Also: `npm test -- electron/release-windows.test.ts electron/release-preflight.test.ts`
(they assert release invariants and may reference the old "Windows disabled"
state; update their expectations ONLY where they describe the policy this
task deliberately changed).

- [ ] **Step 5: Commit**

```bash
git add electron/update-policy.js electron/update-policy.test.ts electron/update-channel.js electron/update-channel.test.ts
git commit -m "$(cat <<'MSG'
Let packaged Windows installs update themselves from the feed that already exists

Constraint: download-manifest.json has served a signed public Windows build
  with a windows/latest.yml feed path since 0.4.2; the policy file was the
  only thing still refusing.
Rejected: Enabling Linux in the same pass | no signed artifact, no feed, no
  gate evidence; Windows has all three.
Confidence: high
Scope-risk: moderate
Directive: The beta channel on win32 maps to beta.yml; never point a
  Windows install at a -mac feed.
Tested: Policy matrix (win32 packaged/dev, linux refusal), platform-aware
  feed names, release preflight/windows suites updated and green.
Not-tested: A real update install on Windows hardware; that is the
  release-runbook gate in Task 32.
MSG
)"
```

---

## Task 32: Reconcile the Windows release docs with reality

**Files:**
- Modify: `README.md` (install section, lines 27-38 area)
- Modify: `docs/RELEASING.md` (artifact matrix ~line 90; Windows release
  gate section ~lines 297-310)
- Modify: `electron/release-preflight.test.ts` /
  `electron/release-windows.test.ts` (snippet assertions, same commit)
- Modify: `BACKLOG.md` (the "Sign and publish the Windows build" item moves
  toward Done with this evidence once the human runs the runbook)

- [ ] **Step 1: Fix the README**

Replace the stale install paragraph with the current truth:

```markdown
## Install

Current public downloads: **Apple Silicon macOS**, **Intel macOS**, and
**Windows x64** (signed via Azure Trusted Signing). Linux x64 packaging is
configured locally but not published yet. Server download routes and
Electron Builder share `server/download-manifest.json`, so storage, updater
feeds, and platform status cannot drift apart.

[Download the latest Markie](https://markie.zvndev.com/download)

Release integrations can read the current stable version and platform URLs
from [`/download/latest.json`](https://markie.zvndev.com/download/latest.json).

> Linux downloads are not published yet.
```

(Keep the exact emoji/link formatting conventions the README already uses.)

- [ ] **Step 2: Fix RELEASING.md**

- Artifact matrix row for Windows becomes:
  `| Windows x64 | nsis, zip | Signed public stable download; auto-update from windows/latest.yml as of 0.5.0 | Exact-commit launch smoke on Windows plus Authenticode verification |`
- Rewrite the "Windows release gate" section: the gate list stays (it is
  the recurring per-release checklist, not a one-time state), but the
  framing changes from "before enabling Windows" to "for every Windows
  release", and it gains the updater steps:

```markdown
## Windows release runbook

For every Windows release, on the exact release commit:

1. Dispatch `windows-release.yml` with signing=azure. CI builds, signs,
   installs, launches, uninstalls, and publishes the installer to the
   `windows-signed` prerelease tag.
2. Download the signed artifacts locally and run
   `npm run release:prepare:win` (feed + SHA-512 + size checks).
3. Human checkpoint: explicit approval to publish.
4. `npm run release:publish:win -- --confirm-public-release=<semver>`
   uploads the installer and `windows/latest.yml` to Backblaze B2.
5. Verify: `/download/windows` serves the new installer, and the previous
   public Windows version receives, downloads, installs, and relaunches
   through Check for Updates on real Windows hardware. A release is not
   complete until that update check passes.
```

Match the numbers/scripts to what `scripts/release.mjs` actually implements
(functions around lines 784-1089); where the script and this text disagree,
the script is the truth and the text follows it.

- [ ] **Step 3: Keep the release tests honest**

Run: `npm test -- electron/release-preflight.test.ts electron/release-windows.test.ts`
These suites assert required snippets in the docs; update their expected
strings to the new text in this same commit. If a test asserts something
that is now FALSE (for example "Windows update checks are disabled"), the
assertion follows reality, with a comment naming this task.

- [ ] **Step 4: Run everything, commit**

Run: `npm test && npm run lint && npm run build`

```bash
git add README.md docs/RELEASING.md electron/release-preflight.test.ts electron/release-windows.test.ts BACKLOG.md
git commit -m "$(cat <<'MSG'
Make the three Windows stories agree: manifest, README, and runbook say the same thing

Constraint: download-manifest.json is the sole stable-channel source of
  truth; the README and RELEASING.md now follow it instead of contradicting
  it in both directions.
Rejected: Leaving the docs until the next release | the contradiction is
  what let a public signed build ship while the updater said unsupported.
Confidence: high
Scope-risk: narrow
Directive: Publishing remains a human checkpoint; nothing in 0.5.0 runs
  release:publish:win.
Tested: Release doc-snippet suites updated and green; full gate green.
Not-tested: The runbook end-to-end (human-run at the next Windows release).
MSG
)"
```

---

# Final gate

## Task 33: Full verification and changelog

**Files:**
- Modify: `CHANGELOG.md`
- No other source changes: this task verifies.

- [ ] **Step 1: The whole gate, from clean**

```bash
./init.sh
```

Expected: renderer/Electron vitest (1,175 baseline + everything added, all
green), MCP tests, server tests, lint 0 errors, build under the 12MB
budget. Then:

```bash
npm run projects:audit          # gates still pass on the real index
wc -l src/app/page.tsx          # must be <= 1899
git status                      # clean tree
```

- [ ] **Step 2: Write the changelog entry**

Add a `## 0.5.0` section to `CHANGELOG.md` in the file's existing voice,
covering: autosave with drafts and history (and the rich-editing safety
gate), the Projects organization (Files tab, full-width view, Projects.md,
agent front matter), MCP instructions and fixes, the server email
verification fix (with a security note), and Windows auto-update. Do NOT
bump version files by hand: versioning happens through
`npm run release:version` at release time, by a human (Release Protocol).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'MSG'
Close out 0.5.0: full gate green and the release story written down

Confidence: high
Scope-risk: narrow
Tested: init.sh full gate, projects audit gates, page.tsx line budget,
  clean tree.
Not-tested: Release packaging/notarization (human checkpoint at release).
MSG
)"
```

---

# Execution notes for the orchestrator

- Tasks 1-12 are strictly ordered. Tasks 13-23 are ordered within the phase
  but only depend on Task 6 from phase 2 (the page extraction) and Task 3
  (front-matter split, which Task 16 imports). Tasks 24-27 depend on Task 13
  (the front matter shape) and Task 25 touches `src/lib/agent-files.ts`
  only. Tasks 28-30 and 31-32 are fully independent: they can run in
  parallel worktrees at any point (use `superpowers:using-git-worktrees`).
- Every task ends with the full local gate, not just its own suite. The
  suite is fast (seconds); there is no excuse to skip it.
- If a locked decision in the spec collides with something you find in the
  code, stop and escalate with file:line evidence; do not silently deviate
  (CONSTITUTION: human checkpoints; Spec 2.1 is the precedent).
- `markie-public` (the 0.2.8 mirror repo) is obsolete; never touch it.
