import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as anchors from "./text-anchor.mjs";
const { createDocMeta } = require("./doc-meta.js");
const { createLocalComments, threadForAgent } = require("./local-comments.js");
const { createAgentComments, NOT_NIGHTLY } = require("./agent-comments.js");
const { createAgentBridge } = require("./agent-bridge.js");

const dirs: string[] = [];
const tmp = (base = os.tmpdir()) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(base, "mlc-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const TEXT = "# Plan\n\nShip the comments panel this week.\n\nThen the history panel.\n";

function setup() {
  const userData = tmp();
  const home = tmp();
  const doc = path.join(home, "plan.md");
  fs.writeFileSync(doc, TEXT);
  const changes: string[] = [];
  const store = createDocMeta({ dir: userData });
  const comments = createLocalComments({ store, anchors, changed: (p: string) => changes.push(p) });
  return { userData, home, doc, store, comments, changes };
}

describe("local comments store", () => {
  it("adds a thread from the app as You and one from an agent under its name", () => {
    const { doc, comments, changes } = setup();
    const anchor = anchors.makeAnchor(TEXT, TEXT.indexOf("comments panel"), TEXT.indexOf("comments panel") + 14);
    comments.addFromUser(doc, anchor, "Is this realistic?");
    comments.addFromAgent(doc, TEXT, { quote: "history panel", body: "Next week instead?", agent: "Claude Code" });
    const listed = comments.list(doc, TEXT).map(threadForAgent);
    expect(listed.map((t: { quote: string }) => t.quote)).toEqual(["comments panel", "history panel"]);
    expect(listed[0].comments[0].author).toBe("You");
    expect(listed[1].comments[0].author).toBe("Claude Code");
    expect(listed.every((t: { anchored: boolean }) => t.anchored)).toBe(true);
    expect(changes).toEqual([doc, doc]);
  });

  it("lists a thread whose text is gone as detached, and keeps it", () => {
    const { doc, comments } = setup();
    comments.addFromAgent(doc, TEXT, { quote: "history panel", body: "x", agent: "A" });
    const [t] = comments.list(doc, TEXT.replace("history panel", "changelog"));
    expect(t.anchored).toBe(false);
    expect(t.range).toBeNull();
    expect(comments.list(doc, TEXT)[0].anchored).toBe(true);
  });

  it("reply reopens a resolved thread; resolve records who resolved it", () => {
    const { doc, comments } = setup();
    const t = comments.addFromAgent(doc, TEXT, { quote: "history panel", body: "x", agent: "Codex" });
    comments.resolveFromAgent(doc, t.id, "Codex");
    let [listed] = comments.list(doc, TEXT).map(threadForAgent);
    expect(listed).toMatchObject({ status: "resolved", resolved_by: "Codex" });
    comments.replyFromUser(doc, t.id, "Not done yet");
    [listed] = comments.list(doc, TEXT).map(threadForAgent);
    expect(listed.status).toBe("open");
    expect(listed.comments.map((c: { author: string }) => c.author)).toEqual(["Codex", "You"]);
  });

  it("deletes only the user's own comments, and drops an emptied thread", () => {
    const { doc, comments } = setup();
    const t = comments.addFromAgent(doc, TEXT, { quote: "history panel", body: "agent", agent: "A" });
    const after = comments.replyFromUser(doc, t.id, "mine");
    const mine = after.comments[1];
    expect(() => comments.removeOwn(doc, t.id, t.comments[0].id)).toThrow(/only your own/);
    comments.removeOwn(doc, t.id, mine.id);
    expect(comments.list(doc, TEXT)[0].comments).toHaveLength(1);

    const own = comments.addFromUser(doc, anchors.makeAnchor(TEXT, 0, 6), "solo");
    expect(comments.removeOwn(doc, own.id, own.comments[0].id)).toMatchObject({ threadRemoved: true });
    expect(comments.list(doc, TEXT)).toHaveLength(1);
  });

  it("refuses an empty body, a bad anchor, and an unknown thread", () => {
    const { doc, comments } = setup();
    expect(() => comments.addFromUser(doc, anchors.makeAnchor(TEXT, 0, 6), "   ")).toThrow();
    expect(() => comments.addFromUser(doc, { exact: "" }, "x")).toThrow();
    expect(() => comments.replyFromUser(doc, "t_nope", "x")).toThrow(/No comment thread/);
  });

  it("keeps threads across a rename Markie makes", () => {
    const { doc, store, comments } = setup();
    comments.addFromAgent(doc, TEXT, { quote: "history panel", body: "x", agent: "A" });
    const renamed = path.join(path.dirname(doc), "renamed.md");
    fs.renameSync(doc, renamed);
    store.move(doc, renamed);
    expect(comments.list(renamed, TEXT)).toHaveLength(1);
    expect(comments.list(doc, TEXT)).toHaveLength(0);
  });
});

describe("comment handlers on the agent bridge", () => {
  function handlers(over: { enabled?: boolean; unlocked?: boolean } = {}) {
    const ctx = setup();
    const agent = createAgentComments({
      loadComments: async () => ctx.comments,
      home: ctx.home,
      enabled: () => over.enabled ?? true,
      unlocked: () => over.unlocked ?? true,
    });
    return { ...ctx, h: agent.handlers };
  }

  it("lists, adds, replies and resolves through the bridge protocol", async () => {
    const { h, doc } = handlers();
    const dir = path.join(tmp("/tmp"), ".markie");
    const bridge = createAgentBridge({ dir, instance: "c0ffee", handlers: h });
    await bridge.start();
    try {
      const call = (method: string, params: object) =>
        bridge.dispatch(JSON.stringify({ token: bridge.token, method, params }));
      const added = await call("comments_add", { path: doc, quote: "comments panel", body: "Too much?", agent: "Claude Code" });
      expect(added.ok).toBe(true);
      const id = added.result.thread.thread_id;
      expect(added.result.thread).toMatchObject({ quote: "comments panel", anchored: true, start: TEXT.indexOf("comments panel") });
      expect((await call("comments_reply", { path: doc, thread_id: id, body: "Fine", agent: "Claude Code" })).ok).toBe(true);
      expect((await call("comments_resolve", { path: doc, thread_id: id, agent: "Claude Code" })).result.thread.status).toBe("resolved");
      expect((await call("comments_list", { path: doc })).result.count).toBe(0);
      const all = await call("comments_list", { path: doc, include_resolved: true });
      expect(all.result.threads[0].comments.map((c: { body: string }) => c.body)).toEqual(["Too much?", "Fine"]);
    } finally {
      bridge.stop();
    }
  });

  it("refuses in a build without the comment UI, so nothing is stored unseen", async () => {
    const { h, doc, store } = handlers({ enabled: false });
    await expect(h.comments_add({ path: doc, quote: "comments panel", body: "x" })).rejects.toThrow(NOT_NIGHTLY);
    expect(store.read(doc, "comments")).toBeNull();
  });

  it("refuses while a private build is locked", async () => {
    const { h, doc } = handlers({ unlocked: false });
    await expect(h.comments_list({ path: doc })).rejects.toThrow(/locked/);
  });

  it("refuses paths an agent could not read: outside home, not markdown, relative, missing", async () => {
    const { h, home } = handlers();
    const outside = path.join(tmp(), "secret.md");
    fs.writeFileSync(outside, "x");
    await expect(h.comments_list({ path: outside })).rejects.toThrow(/home folder/);
    const txt = path.join(home, "notes.txt");
    fs.writeFileSync(txt, "x");
    await expect(h.comments_list({ path: txt })).rejects.toThrow(/markdown/);
    await expect(h.comments_list({ path: "plan.md" })).rejects.toThrow(/absolute/);
    await expect(h.comments_list({ path: path.join(home, "nope.md") })).rejects.toThrow(/No such file/);
    // A link inside home that points out of it is judged by where it lands.
    const link = path.join(home, "link.md");
    fs.symlinkSync(outside, link);
    await expect(h.comments_list({ path: link })).rejects.toThrow(/home folder/);
  });

  it("explains an ambiguous quote instead of guessing", async () => {
    const { h, doc } = handlers();
    await expect(h.comments_add({ path: doc, quote: "panel", body: "x" })).rejects.toThrow(/appears 2 times/);
    const res = await h.comments_add({ path: doc, quote: "panel", body: "x", occurrence: 2 });
    expect(res.thread.start).toBe(TEXT.lastIndexOf("panel"));
  });

  it("names an agent that gave no usable name Agent", async () => {
    const { h, doc } = handlers();
    const res = await h.comments_add({ path: doc, quote: "history", body: "x", agent: "\u0000​ " });
    expect(res.thread.comments[0].author).toBe("Agent");
  });
});
