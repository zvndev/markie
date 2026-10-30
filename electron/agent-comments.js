// What an agent may do with comments on a local document, through the agent
// bridge: list them, add one on a quoted passage, reply, and resolve.
//
// Markie's main process is the only writer of the comment store, so the MCP
// server asks here instead of touching userData itself. The MCP server fences
// the path first (mcp/lib.mjs guardPath, the same rule as markie_read_md); this
// checks again, because the bridge is the boundary that actually writes:
//   - an absolute path to a markdown file that exists, inside the home folder,
//     judged after symlinks are resolved;
//   - nothing here reads more of the file than the anchor needs, and nothing
//     here ever writes to it. Comments live in Markie's data folder.
//
// Local comments are a super-nightly feature. A stable build has no UI to show
// them, so it refuses with a message that says so, rather than storing comments
// the user can never see.
//
// Pure and dependency-injected so it is tested without Electron.
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const { threadForAgent } = require("./local-comments.js");

const COMMENTABLE = /\.(md|markdown|mdx)$/i;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const NOT_NIGHTLY =
  "Comments on local documents are only in the Markie super-nightly build for now. This Markie build cannot show them, so nothing was saved.";

/**
 * @param {object} deps
 * @param {() => Promise<ReturnType<import("./local-comments.js")["createLocalComments"]>>} deps.loadComments
 *   the store, loaded on first use (main imports its ESM anchor module lazily)
 * @param {string} deps.home
 * @param {() => boolean} deps.enabled   true in a super-nightly (or dev) build
 * @param {() => boolean} deps.unlocked  false while a private build is locked
 */
function createAgentComments({ loadComments, home, enabled, unlocked = () => true, fs = nodeFs }) {
  const realHome = (() => {
    try {
      return fs.realpathSync(home);
    } catch {
      return home;
    }
  })();

  async function gate() {
    if (!enabled()) throw new Error(NOT_NIGHTLY);
    if (!unlocked()) throw new Error("Markie is locked. Sign in to Markie first.");
    return loadComments();
  }

  function resolveDoc(raw) {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("Give the absolute path of a markdown file.");
    const expanded = raw.startsWith("~/") ? nodePath.join(home, raw.slice(2)) : raw;
    if (!nodePath.isAbsolute(expanded)) throw new Error("Give the absolute path of a markdown file.");
    let real;
    try {
      real = fs.realpathSync(expanded);
    } catch {
      throw new Error(`No such file: ${expanded}`);
    }
    const rel = nodePath.relative(realHome, real);
    if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) throw new Error("path must be inside your home folder");
    if (!COMMENTABLE.test(real)) throw new Error("Comments work on markdown files (.md, .markdown, .mdx).");
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`Not a file: ${real}`);
    if (st.size > MAX_DOC_BYTES) throw new Error(`${nodePath.basename(real)} is too large to comment on.`);
    return real;
  }

  function readText(real) {
    return fs.readFileSync(real, "utf8");
  }

  function threadId(params) {
    const value = params.thread_id;
    if (typeof value !== "string" || !value.trim()) throw new Error("thread_id is required. Get it from markie_list_comments.");
    return value.trim();
  }

  // A thread as the agent should see it after a change: with where its quote
  // is in the file now, or marked detached.
  function current(comments, real, id) {
    const found = comments.list(real, readText(real)).find((t) => t.id === id);
    return found ? threadForAgent(found) : null;
  }

  async function list(params) {
    const comments = await gate();
    const real = resolveDoc(params.path);
    const threads = comments
      .list(real, readText(real), { includeResolved: params.include_resolved === true })
      .map(threadForAgent);
    return {
      path: real,
      count: threads.length,
      detached: threads.filter((t) => !t.anchored).length,
      threads,
    };
  }

  async function add(params) {
    const comments = await gate();
    const real = resolveDoc(params.path);
    const occurrence = params.occurrence === undefined || params.occurrence === null ? undefined : Number(params.occurrence);
    const thread = comments.addFromAgent(real, readText(real), {
      quote: params.quote,
      body: params.body,
      occurrence,
      prefix: typeof params.prefix === "string" ? params.prefix : undefined,
      suffix: typeof params.suffix === "string" ? params.suffix : undefined,
      agent: params.agent,
    });
    return { path: real, thread: current(comments, real, thread.id) };
  }

  async function reply(params) {
    const comments = await gate();
    const real = resolveDoc(params.path);
    const thread = comments.replyFromAgent(real, threadId(params), params.body, params.agent);
    return { path: real, thread: current(comments, real, thread.id) };
  }

  async function resolve(params) {
    const comments = await gate();
    const real = resolveDoc(params.path);
    const thread = comments.resolveFromAgent(real, threadId(params), params.agent);
    return { path: real, thread: current(comments, real, thread.id) };
  }

  return {
    handlers: {
      comments_list: list,
      comments_add: add,
      comments_reply: reply,
      comments_resolve: resolve,
    },
  };
}

module.exports = { createAgentComments, NOT_NIGHTLY, COMMENTABLE };
