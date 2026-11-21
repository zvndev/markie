// The Node half of the Markie RS interop check (run by interop/run.sh, after
// the Rust export phase and before the Rust import phase).
//
// Everything here is the web app's own code: yjs, @tiptap/y-tiptap (the
// y-prosemirror binding TipTap's Collaboration extension uses), the rich
// editor's extension list and tiptap-markdown's serializer.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { Editor, type JSONContent } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from "@tiptap/y-tiptap";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { formatMarkdownTables } from "@/lib/format-tables";

const DIR = process.env.MARKIE_INTEROP_DIR;
const run = DIR ? it : it.skip;

type Room = Array<
  | { name: string; attrs: Record<string, unknown>; children: Room }
  | { text: Array<{ insert: string; attributes: Record<string, unknown> }> }
>;

// The same shape as room::to_json on the Rust side.
function roomJson(parent: Y.XmlFragment | Y.XmlElement): Room {
  const out: Room = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      const runs: Array<{ insert: string; attributes: Record<string, unknown> }> = [];
      for (const d of child.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>) {
        const attributes = Object.fromEntries(
          Object.entries(d.attributes ?? {}).filter(([, v]) => v !== null),
        );
        const last = runs[runs.length - 1];
        if (last && JSON.stringify(last.attributes) === JSON.stringify(attributes)) last.insert += d.insert;
        else runs.push({ insert: d.insert, attributes });
      }
      out.push({ text: runs });
    } else if (child instanceof Y.XmlElement) {
      const attrs = Object.fromEntries(
        Object.entries(child.getAttributes()).filter(([, v]) => v !== null && v !== undefined),
      );
      out.push({ name: child.nodeName, attrs: sortKeys(attrs), children: roomJson(child) });
    }
  }
  return out;
}

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))) as T;
}

// Key order is not meaningful in either JSON, and neither is the order of a
// text node's marks: y-prosemirror lists them in the order the XmlText's
// format attributes were written, and ProseMirror's schema.text sorts them
// by rank (Mark.setFrom) when the editor reads the room. Compare canonically.
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => {
          if (k === "marks" && Array.isArray(x)) {
            const sorted = [...x].sort((m, n) => ((m as { type: string }).type < (n as { type: string }).type ? -1 : 1));
            return [k, canon(sorted)];
          }
          return [k, canon(x)];
        }),
    );
  }
  return v;
}

function stripTrailingEmpty(json: JSONContent): JSONContent {
  const content = [...(json.content ?? [])];
  while (content.length) {
    const last = content[content.length - 1];
    if (last.type === "paragraph" && !(last.content && last.content.length)) content.pop();
    else break;
  }
  return { ...json, content };
}

const scratch = new Editor({ extensions: richBaseExtensions({ collab: true }), content: "" });
const markdownOf = (json: JSONContent) => {
  scratch.commands.setContent(json, { emitUpdate: false });
  return (scratch.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
};

/** The room TipTap itself seeds from a markdown body. */
function tiptapRoom(markdown: string): Y.Doc {
  scratch.commands.setContent(markdown, { emitUpdate: false });
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(scratch.state.doc, doc.getXmlFragment("default"));
  return doc;
}

const norm = (s: string) => formatMarkdownTables(s).replace(/\n+$/, "") + "\n";

run("rust rooms read as TipTap's own, and TipTap rooms go back to Rust", async () => {
  const dir = DIR!;
  mkdirSync(join(dir, "node"), { recursive: true });
  const index = JSON.parse(readFileSync(join(dir, "rust/index.json"), "utf8")) as Array<{
    name: string;
    file: string;
    markdown: string;
  }>;
  const report: Record<string, unknown>[] = [];
  let structural = 0;
  let markdownSame = 0;
  let markdownSource = 0;
  for (const c of index) {
    // Rust -> Node.
    const fromRust = new Y.Doc();
    Y.applyUpdate(fromRust, readFileSync(join(dir, "rust", `${c.file}.bin`)));
    const rustJson = stripTrailingEmpty(yXmlFragmentToProsemirrorJSON(fromRust.getXmlFragment("default")));
    const body = c.markdown.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, "");
    const tiptap = tiptapRoom(body);
    const tiptapJson = stripTrailingEmpty(yXmlFragmentToProsemirrorJSON(tiptap.getXmlFragment("default")));
    const same = JSON.stringify(canon(rustJson)) === JSON.stringify(canon(tiptapJson));
    if (same) structural++;
    // The Rust room through tiptap-markdown: what a web client would save.
    const fromRustMd = markdownOf(rustJson);
    const tiptapMd = markdownOf(tiptapJson);
    if (norm(fromRustMd) === norm(tiptapMd)) markdownSame++;
    if (norm(fromRustMd) === norm(body)) markdownSource++;
    report.push({
      name: c.name,
      structural: same,
      markdownEqualsTiptap: norm(fromRustMd) === norm(tiptapMd),
      markdownEqualsSource: norm(fromRustMd) === norm(body),
      ...(same ? {} : { rust: rustJson, tiptap: tiptapJson }),
      fromRustMd,
    });
    // Node -> Rust: the TipTap-seeded room, as an update.
    writeFileSync(join(dir, "node", `${c.file}.bin`), Y.encodeStateAsUpdate(tiptap));
  }

  // A real editor bound to a room Rust seeded: the live-collaboration path.
  const base = readFileSync(join(dir, "rust/edit-base.bin"));
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, base);
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...richBaseExtensions({ collab: true }), Collaboration.configure({ document: ydoc })],
  });
  await new Promise((r) => setTimeout(r, 50));
  const before = Y.encodeStateVector(ydoc);
  const opened = editor.getJSON();
  // End of the first paragraph (node 1, after the heading).
  let firstParaEnd = -1;
  let seen = 0;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "paragraph" && seen++ === 0) firstParaEnd = offset + node.nodeSize - 1;
  });
  editor
    .chain()
    .insertContentAt(firstParaEnd, [
      { type: "text", text: " " },
      { type: "text", text: "Node", marks: [{ type: "italic" }] },
    ])
    .run();
  editor
    .chain()
    .insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added by Node." }],
    })
    .run();
  await new Promise((r) => setTimeout(r, 50));
  const nodeEdit = Y.encodeStateAsUpdate(ydoc, before);
  writeFileSync(join(dir, "node/edit-node.bin"), nodeEdit);
  const nodeEditMd = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();

  // Concurrent: the Rust edit arrives after the Node edit was made.
  Y.applyUpdate(ydoc, readFileSync(join(dir, "rust/edit-rust.bin")));
  await new Promise((r) => setTimeout(r, 50));
  const frag = ydoc.getXmlFragment("default");
  const converged = roomJson(frag);
  // Drop TipTap's trailing empty paragraph, as Rust does.
  while (converged.length) {
    const last = converged[converged.length - 1] as { name?: string; children?: Room };
    if (last.name === "paragraph" && last.children && last.children.length === 0) converged.pop();
    else break;
  }
  writeFileSync(join(dir, "node/converged.json"), JSON.stringify(canon(converged)));
  const convergedMd = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
  // The editor shows both edits.
  const text = editor.getText();
  const editorHasBoth = text.includes("stays put. Node") && text.includes("Rust bold") && text.includes("Added by Node.");
  // Rust's own file after its edit, read by TipTap, is the room's document.
  const rustMd = readFileSync(join(dir, "rust/edit-rust.md"), "utf8");
  const rustOnly = new Y.Doc();
  Y.applyUpdate(rustOnly, base);
  Y.applyUpdate(rustOnly, readFileSync(join(dir, "rust/edit-rust.bin")));
  const rustRoomJson = stripTrailingEmpty(yXmlFragmentToProsemirrorJSON(rustOnly.getXmlFragment("default")));
  const rustFileJson = stripTrailingEmpty(yXmlFragmentToProsemirrorJSON(tiptapRoom(rustMd).getXmlFragment("default")));
  const rustEditMatchesItsFile = JSON.stringify(canon(rustRoomJson)) === JSON.stringify(canon(rustFileJson));
  editor.destroy();

  // Optional corpus agreement.
  let corpus: Record<string, unknown> | null = null;
  const corpusIndex = join(dir, "corpus/index.json");
  if (existsSync(corpusIndex)) {
    const entries = JSON.parse(readFileSync(corpusIndex, "utf8")) as Array<{ file: string; body: string; bin: string }>;
    let docsEqual = 0;
    let blocks = 0;
    let blocksEqual = 0;
    const mismatches: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      const r = new Y.Doc();
      Y.applyUpdate(r, readFileSync(join(dir, "corpus", e.bin)));
      const rj = stripTrailingEmpty(yXmlFragmentToProsemirrorJSON(r.getXmlFragment("default")));
      const tj = stripTrailingEmpty(yXmlFragmentToProsemirrorJSON(tiptapRoom(e.body).getXmlFragment("default")));
      const rc = (rj.content ?? []).map((n) => JSON.stringify(canon(n)));
      const tc = (tj.content ?? []).map((n) => JSON.stringify(canon(n)));
      // Blocks in common, by longest common subsequence.
      const lcs = Array.from({ length: rc.length + 1 }, () => new Array(tc.length + 1).fill(0));
      for (let i = rc.length - 1; i >= 0; i--)
        for (let j = tc.length - 1; j >= 0; j--)
          lcs[i][j] = rc[i] === tc[j] ? 1 + lcs[i + 1][j + 1] : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      blocks += tc.length;
      blocksEqual += lcs[0][0];
      if (lcs[0][0] === tc.length && rc.length === tc.length) docsEqual++;
      else if (mismatches.length < 120) {
        const k = rc.findIndex((x, i) => x !== tc[i]);
        const a = rc[k] ?? "";
        const b = tc[k] ?? "";
        let d = 0;
        while (d < a.length && a[d] === b[d]) d++;
        const from = Math.max(0, d - 80);
        mismatches.push({ file: e.file, rust: a.slice(from, d + 120), tiptap: b.slice(from, d + 120) });
      }
    }
    corpus = { docs: entries.length, docsEqual, blocks, blocksEqual, mismatches };
  }

  const summary = {
    rustToNode: { total: index.length, structural, markdownEqualsTiptap: markdownSame, markdownEqualsSource: markdownSource },
    rustEditMatchesItsFile,
    editorHasBoth,
    opened,
    nodeEditMd,
    convergedMd,
    corpus,
    cases: report,
  };
  writeFileSync(join(dir, "node/report.json"), JSON.stringify(summary, null, 2));
  expect(structural, "Rust rooms structurally equal to TipTap's").toBe(index.length);
  expect(markdownSame).toBe(index.length);
  expect(rustEditMatchesItsFile).toBe(true);
  expect(editorHasBoth).toBe(true);
}, 600_000);
