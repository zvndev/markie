// Comments on local documents, kept in Markie's own data folder.
//
// The record lives in doc-meta (userData/doc-meta/<slug>/comments.json), never
// in or beside the user's file. Each thread is anchored by quoted text
// (text-anchor.mjs), so it finds its passage again after any edit, including
// an agent rewriting the file, and is listed as detached when the passage is
// gone instead of being dropped.
//
// Two callers, one store:
//   - the renderer, over IPC, as "You"; it anchors against the text in the
//     editor, which may be ahead of the file on disk;
//   - an agent, over the agent bridge, by the MCP client's name; it anchors
//     against the file on disk, because that is the text the agent read.
// Every change calls `changed(path)`, which main turns into an IPC event, so an
// open document shows an agent's comment without a reload.
//
// Electron-free and dependency-injected. The anchor functions are passed in
// because text-anchor.mjs is ESM and this is CommonJS: main loads it with a
// dynamic import and the tests import it directly.
"use strict";

const nodeCrypto = require("crypto");

const KIND = "comments";
const MAX_BODY_CHARS = 10_000;
const MAX_THREADS = 500;
const MAX_COMMENTS_PER_THREAD = 200;
const AGENT_NAME_MAX = 64;
const DEFAULT_AGENT_NAME = "Agent";

// The MCP client's own name for itself, from its `initialize` message, reduced
// to one printable line. Same rule as agent-cloud.js, different fallback: a
// comment needs a name a person reads as a name.
function sanitizeAuthorName(raw) {
  if (typeof raw !== "string") return DEFAULT_AGENT_NAME;
  const line = raw.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  const clipped = Array.from(line).slice(0, AGENT_NAME_MAX).join("").trim();
  return clipped || DEFAULT_AGENT_NAME;
}

function cleanBody(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("A comment needs some text.");
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body.length > MAX_BODY_CHARS) throw new Error(`A comment can be at most ${MAX_BODY_CHARS} characters.`);
  return body;
}

/** "You" for the person at the keyboard, the agent's name otherwise. */
function authorLabel(author) {
  if (author && author.kind === "agent") return sanitizeAuthorName(author.name);
  return "You";
}

/**
 * @param {object} deps
 * @param {ReturnType<import("./doc-meta.js")["createDocMeta"]>} deps.store
 * @param {{ resolveAnchor: Function, locateQuote: Function, makeAnchor: Function, isAnchor: Function }} deps.anchors
 * @param {(path: string) => void} [deps.changed]
 */
function createLocalComments({ store, anchors, changed = () => {}, now = () => new Date(), crypto = nodeCrypto }) {
  const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;

  function load(filePath) {
    const rec = store.read(filePath, KIND);
    const threads = rec && Array.isArray(rec.threads) ? rec.threads.filter((t) => t && typeof t.id === "string") : [];
    return { version: 1, threads };
  }

  function save(filePath, rec) {
    store.write(filePath, KIND, rec);
    try {
      changed(filePath);
    } catch {
      // a window that cannot be told is not a reason to fail the write
    }
  }

  function findThread(rec, threadId) {
    const thread = rec.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`No comment thread ${String(threadId)} on this document.`);
    return thread;
  }

  /**
   * Threads as stored, each with where its quote is in `text` now. A thread
   * whose quote cannot be found comes back with status "detached" rather
   * than being left out.
   */
  function list(filePath, text, { includeResolved = true } = {}) {
    const rec = load(filePath);
    const out = [];
    for (const thread of rec.threads) {
      if (!includeResolved && thread.status === "resolved") continue;
      const range = typeof text === "string" ? anchors.resolveAnchor(text, thread.anchor) : null;
      out.push({
        ...thread,
        anchored: !!range,
        range: range || null,
      });
    }
    return out;
  }

  function newComment(author, body) {
    return { id: id("c"), author, body: cleanBody(body), createdAt: now().toISOString() };
  }

  function addThread(filePath, anchor, body, author) {
    if (!anchors.isAnchor(anchor)) throw new Error("That selection cannot be commented on.");
    const rec = load(filePath);
    if (rec.threads.length >= MAX_THREADS) throw new Error(`This document already has ${MAX_THREADS} comment threads.`);
    const thread = {
      id: id("t"),
      anchor: { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix, start: anchor.start },
      status: "open",
      createdAt: now().toISOString(),
      comments: [newComment(author, body)],
    };
    rec.threads.push(thread);
    save(filePath, rec);
    return thread;
  }

  function reply(filePath, threadId, body, author) {
    const rec = load(filePath);
    const thread = findThread(rec, threadId);
    if (thread.comments.length >= MAX_COMMENTS_PER_THREAD) throw new Error("This thread is full. Start a new one.");
    const comment = newComment(author, body);
    thread.comments.push(comment);
    // A reply to a resolved thread reopens it: someone still has something to say.
    if (thread.status === "resolved") {
      thread.status = "open";
      delete thread.resolvedAt;
      delete thread.resolvedBy;
    }
    save(filePath, rec);
    return thread;
  }

  function setStatus(filePath, threadId, status, author) {
    if (status !== "open" && status !== "resolved") throw new Error("A thread is open or resolved.");
    const rec = load(filePath);
    const thread = findThread(rec, threadId);
    thread.status = status;
    if (status === "resolved") {
      thread.resolvedAt = now().toISOString();
      thread.resolvedBy = author;
    } else {
      delete thread.resolvedAt;
      delete thread.resolvedBy;
    }
    save(filePath, rec);
    return thread;
  }

  // Only the person at the keyboard deletes, and only their own comments. An
  // agent can reply and resolve; it cannot make anyone's words disappear.
  function removeOwn(filePath, threadId, commentId) {
    const rec = load(filePath);
    const thread = findThread(rec, threadId);
    const comment = thread.comments.find((c) => c.id === commentId);
    if (!comment) throw new Error("That comment is already gone.");
    if (!comment.author || comment.author.kind !== "user") throw new Error("You can delete only your own comments.");
    thread.comments = thread.comments.filter((c) => c.id !== commentId);
    if (thread.comments.length === 0) rec.threads = rec.threads.filter((t) => t.id !== threadId);
    save(filePath, rec);
    return { deleted: commentId, threadRemoved: thread.comments.length === 0 };
  }

  return {
    list,
    // The renderer: the anchor was made against the text in the editor.
    addFromUser: (filePath, anchor, body) => addThread(filePath, anchor, body, { kind: "user" }),
    replyFromUser: (filePath, threadId, body) => reply(filePath, threadId, body, { kind: "user" }),
    setStatusFromUser: (filePath, threadId, status) => setStatus(filePath, threadId, status, { kind: "user" }),
    removeOwn,
    // An agent: the quote is located in the file as it is on disk.
    addFromAgent(filePath, text, { quote, body, occurrence, prefix, suffix, agent }) {
      const at = anchors.locateQuote(text, quote, { occurrence, prefix, suffix });
      if (!at.ok) throw new Error(at.error);
      const anchor = anchors.makeAnchor(text, at.start, at.end);
      if (!anchor) throw new Error("That quote cannot be commented on.");
      return addThread(filePath, anchor, body, { kind: "agent", name: sanitizeAuthorName(agent) });
    },
    replyFromAgent: (filePath, threadId, body, agent) =>
      reply(filePath, threadId, body, { kind: "agent", name: sanitizeAuthorName(agent) }),
    resolveFromAgent: (filePath, threadId, agent) =>
      setStatus(filePath, threadId, "resolved", { kind: "agent", name: sanitizeAuthorName(agent) }),
  };
}

// What an agent reads back: plain names, the quote, where it is now, and the
// conversation. No internal author objects to interpret.
function threadForAgent(thread) {
  return {
    thread_id: thread.id,
    status: thread.status,
    anchored: thread.anchored !== false,
    quote: thread.anchor ? thread.anchor.exact : "",
    ...(thread.range ? { start: thread.range.start, end: thread.range.end } : {}),
    ...(thread.status === "resolved" && thread.resolvedBy ? { resolved_by: authorLabel(thread.resolvedBy) } : {}),
    comments: (thread.comments || []).map((c) => ({
      comment_id: c.id,
      author: authorLabel(c.author),
      body: c.body,
      created_at: c.createdAt,
    })),
  };
}

module.exports = {
  createLocalComments,
  threadForAgent,
  authorLabel,
  sanitizeAuthorName,
  MAX_BODY_CHARS,
  MAX_THREADS,
};
