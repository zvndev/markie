import { describe, expect, it } from "vitest";
import { diffText, TextCollabBinding, TEXT_COLLAB_KEY } from "./text-collab";
import { loadCollabRuntime } from "./collab-loader";

describe("diffText", () => {
  it("reduces inserts, deletes, and replacements to one span", () => {
    expect(diffText("hello", "hello")).toBeNull();
    expect(diffText("hello", "hello world")).toEqual({ index: 5, deleteCount: 0, insert: " world" });
    expect(diffText("hello world", "hello")).toEqual({ index: 5, deleteCount: 6, insert: "" });
    expect(diffText("hello world", "hello there")).toEqual({ index: 6, deleteCount: 5, insert: "there" });
    expect(diffText("", "abc")).toEqual({ index: 0, deleteCount: 0, insert: "abc" });
    expect(diffText("abc", "")).toEqual({ index: 0, deleteCount: 3, insert: "" });
  });

  it("never splits a surrogate pair at either boundary", () => {
    const op = diffText("a😀b", "a😁b")!;
    expect("a😀b".slice(0, op.index) + op.insert + "a😀b".slice(op.index + op.deleteCount)).toBe("a😁b");
    expect(op.insert).toBe("😁");
  });
});

describe("TextCollabBinding over real Yjs docs", () => {
  it("converges two clients editing the same shared text", async () => {
    const { Y } = await loadCollabRuntime();
    const docA = new Y.Doc(), docB = new Y.Doc();
    const textA = docA.getText(TEXT_COLLAB_KEY), textB = docB.getText(TEXT_COLLAB_KEY);
    const remoteA: string[] = [], remoteB: string[] = [];
    const a = new TextCollabBinding(docA, textA, (t) => remoteA.push(t));
    const b = new TextCollabBinding(docB, textB, (t) => remoteB.push(t));
    const sync = () => {
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    };

    // A seeds the room from its local file; B receives it as a remote edit.
    docA.transact(() => a.seedIfEmpty("shared notes\n"));
    expect(b.seedIfEmpty("other copy")).toBe(true); // not yet synced: B's room is empty locally
    sync();
    // Both seeds raced before the first sync (the server seed lock prevents
    // this in production); what matters here is both sides converge and keep
    // converging through ordinary concurrent edits.
    expect(textA.toString()).toBe(textB.toString());
    const base = textA.toString();

    a.applyLocal(`${base}from A\n`);
    b.applyLocal(`${base}from B\n`);
    sync();
    expect(textA.toString()).toBe(textB.toString());
    expect(textA.toString()).toContain("from A");
    expect(textA.toString()).toContain("from B");
    expect(remoteA.at(-1)).toBe(textA.toString());
    expect(remoteB.at(-1)).toBe(textB.toString());

    // A local echo (the parent handing our own text back) is not an edit.
    const before = Y.encodeStateVector(docA);
    a.applyLocal(textA.toString());
    expect([...Y.encodeStateVector(docA)]).toEqual([...before]);

    a.dispose(); b.dispose();
    docA.destroy(); docB.destroy();
  });
});
