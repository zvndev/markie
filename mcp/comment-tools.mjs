// Comment tools: an agent comments on a local markdown file, and the user sees
// it in Markie beside the passage it is about.
//
// The comments live in the Markie app's own data folder, never in or beside
// the file, and the app is the only process that writes them. So each tool
// fences the path here exactly like markie_read_md (an agent may comment only
// on a file it could read), then asks the running app over its agent bridge
// (agent-client.mjs), which launches Markie on macOS if it is closed. The app
// checks the path again and refuses when the build has no comment UI.
import { guardPath } from "./lib.mjs";

const PATH = { type: "string", description: "Absolute path of the markdown file, ~ allowed" };
const THREAD_ID = { type: "string", description: "The thread_id from markie_list_comments or markie_add_comment" };

export const COMMENT_TOOLS = [
  {
    name: "markie_list_comments",
    description:
      "List the comment threads on a local markdown file, as the user sees them in Markie. Each thread has a thread_id, its status (open or resolved), the quote it is attached to, whether that quote is still in the file (anchored; a thread whose text was edited away is detached, never deleted), start and end character offsets of the quote in the file now, and its comments in order with author and time. The user's own comments have the author \"You\". Open threads only, unless include_resolved is true. Asks the running Markie app, which starts if it is closed.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH,
        include_resolved: { type: "boolean", description: "Also list resolved threads. Default false." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_add_comment",
    description:
      "Comment on a passage of a local markdown file. quote is the exact text the comment is about, copied from the file as it is on disk (markie_read_md), at most 2000 characters; line breaks may differ. If the quote appears more than once, say which with occurrence (1 for the first from the top) or with prefix or suffix, a few words just before or after it. The comment shows in Markie beside that text under your name, immediately if the document is open, and stays attached while the file is edited. It never changes the file. Returns the new thread with its thread_id.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH,
        quote: { type: "string", description: "The exact text to comment on, as it appears in the file" },
        body: { type: "string", description: "The comment" },
        occurrence: {
          type: "integer",
          minimum: 1,
          description: "Which appearance of the quote, counted from the top, when it appears more than once",
        },
        prefix: { type: "string", description: "Text just before the quote, to pick one appearance" },
        suffix: { type: "string", description: "Text just after the quote, to pick one appearance" },
      },
      required: ["path", "quote", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_reply_comment",
    description:
      "Reply in a comment thread on a local markdown file, under your name. Replying to a resolved thread reopens it. Use it to answer the user where they asked, then make the change they asked for with markie_write_md.",
    inputSchema: {
      type: "object",
      properties: { path: PATH, thread_id: THREAD_ID, body: { type: "string", description: "The reply" } },
      required: ["path", "thread_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_resolve_comment",
    description:
      "Mark a comment thread on a local markdown file as resolved, for example once you have made the change it asked for. The thread stays in Markie's resolved list, and the user can reopen it.",
    inputSchema: {
      type: "object",
      properties: { path: PATH, thread_id: THREAD_ID },
      required: ["path", "thread_id"],
      additionalProperties: false,
    },
  },
];

export const COMMENT_TOOL_NAMES = new Set(COMMENT_TOOLS.map((t) => t.name));

const METHODS = {
  markie_list_comments: "comments_list",
  markie_add_comment: "comments_add",
  markie_reply_comment: "comments_reply",
  markie_resolve_comment: "comments_resolve",
};

/**
 * The bridge method and params for a comment tool call, or throws the reason
 * it is refused. Nothing reaches the app for a path the read tools refuse.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ home: string, agent?: string, env?: NodeJS.ProcessEnv }} ctx
 */
export function commentRequest(name, args, { home, agent, env = process.env }) {
  const method = METHODS[name];
  if (!method) throw new Error(`Unknown tool: ${name}`);
  const g = guardPath(args.path, home, { env });
  if (!g.ok) throw new Error(g.error);
  const params = { path: g.path };
  const who = typeof agent === "string" && agent.trim() ? agent : "Agent";
  switch (name) {
    case "markie_list_comments":
      params.include_resolved = args.include_resolved === true;
      break;
    case "markie_add_comment":
      if (typeof args.quote !== "string" || !args.quote.trim()) throw new Error("quote is required: the exact text the comment is about.");
      if (typeof args.body !== "string" || !args.body.trim()) throw new Error("body is required: what the comment says.");
      params.quote = args.quote;
      params.body = args.body;
      if (args.occurrence !== undefined) params.occurrence = args.occurrence;
      if (typeof args.prefix === "string") params.prefix = args.prefix;
      if (typeof args.suffix === "string") params.suffix = args.suffix;
      params.agent = who;
      break;
    case "markie_reply_comment":
      if (typeof args.thread_id !== "string" || !args.thread_id.trim()) throw new Error("thread_id is required. Get it from markie_list_comments.");
      if (typeof args.body !== "string" || !args.body.trim()) throw new Error("body is required: what the reply says.");
      params.thread_id = args.thread_id;
      params.body = args.body;
      params.agent = who;
      break;
    case "markie_resolve_comment":
      if (typeof args.thread_id !== "string" || !args.thread_id.trim()) throw new Error("thread_id is required. Get it from markie_list_comments.");
      params.thread_id = args.thread_id;
      params.agent = who;
      break;
  }
  return { method, params };
}

export const MARKIE_NOT_RUNNING_FOR_COMMENTS =
  "Markie isn't running, and could not be started. Open the Markie app and try again. Comments are kept by the app.";
