#!/usr/bin/env node
// Markie MCP server (stdio): a device-wide document workspace for AI agents.
// Lets Claude Code, Codex & friends find, search, read, write, and open the
// documents on this computer: markdown notes and docs, plain text and data
// files, Word, RTF, OpenDocument and HTML, and agent/skill files
// (~/.claude/skills, ~/.codex, CLAUDE.md, AGENTS.md, …). Speaks MCP over
// newline-delimited JSON-RPC.
//
// Dependency-free pure Node. Mirrors Markie's device index (electron/mdindex.js)
// so it sees exactly what the app's Browse/Skills panels see, and runs the
// app's own global search (doc-text.cjs) so it finds what the app finds.
//
// Register with Claude Code:
//   claude mcp add markie -- node /path/to/markie-mcp.mjs
import { readFile, mkdir, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  guardPath,
  matchQuery,
  groupSkills,
  markieOpenCommand,
  READ_FORMATS,
  WRITE_FORMATS,
  checkWritableContent,
  parseFormats,
  readOnlyWriteRefusal,
} from "./lib.mjs";
import docText from "./doc-text.cjs";
import { INSTRUCTIONS, applyMarkieFrontMatter } from "./conventions.mjs";
import { MARKDOWN_GUIDE, GUIDE_URI } from "./markdown-guide.mjs";
import { checkMarkdown } from "./check-md.mjs";
import { walkAll } from "./scan.mjs";
import { askMarkie } from "./agent-client.mjs";
import { createRequire } from "node:module";

// Read the version from package.json so the MCP handshake can never drift from
// the released version (it was pinned at 0.2.9 while the app shipped 0.2.11).
const SERVER_VERSION = createRequire(import.meta.url)("./package.json").version;

const HOME = homedir();

// Cache the device scan for the process lifetime; writes invalidate it so new
// files surface in the next find. The walk runs under DEFAULT_BUDGET, so a
// pathological tree costs a bounded amount of disk instead of minutes. It
// starts at home and at each configured skills folder outside it.
let _scan = null;
let _scanStats = {};
async function scan() {
  if (!_scan) {
    const stats = {};
    _scan = await walkAll(HOME, { stats });
    _scanStats = stats;
  }
  return _scan;
}

// A scan cut short by its budget, said out loud. A budget that silently
// returns half the disk is worse than a slow scan: the agent would conclude the
// document does not exist and write a duplicate.
function truncationNote() {
  if (!_scanStats.truncated) return undefined;
  return `The device scan stopped early (limit: ${_scanStats.reason}) after ${_scanStats.files} files, so some documents on this computer were not searched.`;
}

function clampLimit(value, fallback, max) {
  return Math.min(Math.max(Number(value) || fallback, 1), max);
}

const mtimeIso = (ms) => (ms ? new Date(ms).toISOString() : null);

// How long one markie_search_documents call may spend reading document text.
// The app's search box allows 1.8 s because a person is typing; an agent asked
// a question and can wait longer for a more complete answer. Past it the
// search still matches names and paths, and says it was partial.
const SEARCH_MAX_MS = 6000;
const MAX_QUERY_CHARS = 200;

const FORMAT_IDS = READ_FORMATS.join(", ");
const formatsSchema = {
  type: "array",
  items: { type: "string", enum: [...READ_FORMATS] },
  description: `Optional: only these formats. Any of ${FORMAT_IDS}. Leave out for every format.`,
};

const FORMAT_LABEL = {
  docx: "a Word document (.docx)",
  odt: "an OpenDocument text file (.odt)",
  rtf: "a rich text file (.rtf)",
  html: "an HTML page",
};

// ---- tools ----

const TOOLS = [
  {
    name: "markie_find_documents",
    description:
      `Find documents anywhere on this computer by name or path (case-insensitive), newest first, with each one's format. Covers every type Markie indexes: ${FORMAT_IDS}. Leave query empty to list everything. Mirrors what Markie's Browse panel shows. To find a document by what it says, use markie_search_documents.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match in the name or path" },
        formats: formatsSchema,
        limit: { type: "number", description: "Max results (default 50, max 500)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "markie_search_documents",
    description:
      "Search inside documents: every word of the query must appear in the name, the path, or the document's text. Reads the text of markdown, plain text, data files, Word (.docx), OpenDocument (.odt), RTF and HTML, the same way Markie's global search (Shift-Command-F) does, and ranks the same way: name matches first, then text, then path, newest first. Returns path, name, format, last modified time, and an excerpt around the first hit in the text. Legacy .doc files match by name and path only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find. All of them must match." },
        formats: formatsSchema,
        limit: { type: "number", description: "Max results (default 20, max 200)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_read_document",
    description:
      "Read any document Markie indexes, by absolute path. Markdown, plain text, CSV, JSON, YAML, XML and Darkmown (.wd) come back exactly as written. Word (.docx), OpenDocument (.odt), RTF and HTML come back as extracted plain text, labelled as read-only: formatting, pictures and layout are left out, and that text cannot be written back. Legacy .doc cannot be read this way; open it in Markie instead.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_write_document",
    description:
      "Create or overwrite a text document: markdown (.md/.markdown/.mdx), plain text (.txt/.text/.log), .csv, .json, .yaml/.yml, .xml or Darkmown (.wd). Same fences as markie_write_md: under your home folder only, never inside excluded dirs (node_modules, tmp, hidden dirs) or the agent/skill folders. JSON is checked before anything is written. Word, RTF, OpenDocument, legacy .doc and HTML are never written here; open those in Markie for the user to edit. project and block apply to markdown only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, ~ allowed" },
        content: { type: "string", description: "Full new file content" },
        project: {
          type: "string",
          description:
            "Optional, markdown only: the Markie project this document belongs to (written into markie front matter)",
        },
        block: {
          type: "string",
          description:
            "Optional, markdown only: the block (unit of work) inside the project. Name it after the work, not the date.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_find_md",
    description:
      "Find markdown files anywhere on this computer (matches name or path, case-insensitive), newest first. Leave query empty to list everything. The markdown-only form of markie_find_documents, kept for existing setups.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match in the name or path" },
        limit: { type: "number", description: "Max results (default 50, max 500)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "markie_read_md",
    description: "Read a markdown file's contents by absolute path. For any other document type, use markie_read_document.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_write_md",
    description:
      "Create or overwrite a markdown file. Only .md/.markdown/.mdx under your home folder, never inside excluded dirs (node_modules, tmp, hidden dirs except the skill roots). Markie picks up changes on reopen. Declare project/block so Markie files the document in the right place.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, ~ allowed" },
        content: { type: "string", description: "Full new markdown content" },
        project: {
          type: "string",
          description:
            "Optional: the Markie project this document belongs to (written into markie front matter)",
        },
        block: {
          type: "string",
          description:
            "Optional: the block (unit of work) inside the project. Name it after the work, not the date.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_list_skills",
    description:
      "List the agent/skill instruction files on this computer (CLAUDE.md, AGENTS.md, GEMINI.md, ~/.claude/skills, ~/.codex, .cursor rules), grouped by tool. Great for finding and editing skills.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "markie_open_in_markie",
    description:
      "Open a document in the Markie app, in front of the user: markdown, plain text, CSV, JSON, YAML, XML, Darkmown, Word (.docx and legacy .doc), RTF, OpenDocument or HTML.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_cloud_status",
    description:
      "Is this file in the user's Markie Cloud, and what is its private link? Asks the running Markie app. Returns synced, syncState, server and privateLink (null until synced). The private link opens only for the user and people they shared it with, after signing in, on any browser or phone.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_cloud_sync",
    description:
      "Put a Markdown or plain text file in the user's Markie Cloud, or push its latest text if it is already there, and return its private link. The Markie app does the upload with the user's own sign-in, and asks the user to allow it the first time unless they chose to always allow it, so this call can wait on them. The file stays private: only the user can open the link until they share it. Use it when the user asks for a hosted, synced, cloud, or private Markie copy, or a link they can open away from this computer. Write the file first with markie_write_document.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_cloud_public_link",
    description:
      "Get, or with create true make, a public link for a file already in Markie Cloud. Anyone holding a public link can read and download the document without an account. Only set create when the user explicitly asked for a public link in this conversation; a private link is what they get otherwise. Markie asks the user to confirm every public link it makes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, ~ allowed" },
        create: { type: "boolean", description: "Make the link if there is none. Only when the user asked for a public link." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_cloud_revoke_public_link",
    description:
      "Turn off a file's public link, so it stops working for everyone holding it. The private link keeps working.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_check_md",
    description:
      "Check a markdown file against what Markie can actually display, and say what will not. Reports every image and link target (does the file exist, is the extension one Markie draws, does it sit beside the document) and every HTML tag whose fate differs between the editor and an export, with line numbers and both halves. ok is false only for something that renders nowhere: a missing local file, an embed of a kind Markie cannot draw, or markup the sanitizer drops. Static analysis of the text plus one existence check per local file: nothing is rendered and the app is never opened. Run it after writing a document that has a picture, a clip, or inline HTML in it.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_guide",
    description:
      "What Markie renders, with an example of each: how to size a picture, centre a line, or turn a video address into a card, where a picture has to live to display at all, which inline HTML the editor keeps, and what is dropped silently. Read it before writing a document with pictures, video, audio or formatting in it. Static text, no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// The same guide, addressable. A resource is the right MCP shape for a document
// the model may want to pull in on its own, but resources are optional in the
// protocol and some clients never surface them, and this server may assume no
// particular client (see the conventions.mjs header). So the guide is a tool as
// well, and both read the one string.
const RESOURCES = [
  {
    uri: GUIDE_URI,
    name: "What Markie renders",
    description:
      "The markdown and inline HTML Markie displays, where local pictures, video and audio have to live, what is silently dropped, and which other document types the tools read and write.",
    mimeType: "text/markdown",
  },
];

// Write one guarded path. The guard already vetted every ancestor segment
// (under home, no excluded dirs, not an agent/skill folder), so creating
// missing parents stays inside an allowed tree.
async function writeGuarded(path, body) {
  await mkdir(dirname(path), { recursive: true });
  // O_NOFOLLOW so a symlink planted between the guard and this write cannot
  // redirect it. path is already fully resolved, so a legitimate link in the
  // requested path was followed before we got here.
  const fh = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644
  );
  try {
    await fh.writeFile(body, "utf8");
  } finally {
    await fh.close();
  }
  _scan = null; // new file should show up in the next find
  return `Wrote ${Buffer.byteLength(body)} bytes to ${path}`;
}

function frontMatterArgs(args) {
  return {
    project: typeof args.project === "string" ? args.project : null,
    block: typeof args.block === "string" ? args.block : null,
  };
}

function findRows(rows, { query, formats, limit }) {
  const allowed = formats ? new Set(formats) : null;
  return rows
    .filter((r) => (!allowed || allowed.has(r.format)) && matchQuery(r, query))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

async function readDocument(input) {
  const g = guardPath(input, HOME, { formats: READ_FORMATS });
  if (!g.ok) throw new Error(g.error);
  if (g.format === "doc") {
    throw new Error(
      "Legacy Word .doc files cannot be read through MCP. Their text only comes out of the reader Markie runs when the document is opened, so open it with markie_open_in_markie, or ask the user to save it as .docx."
    );
  }
  let info;
  try {
    info = await stat(g.path);
  } catch {
    throw new Error(`No such file: ${g.path}`);
  }
  if (!info.isFile()) throw new Error(`Not a file: ${g.path}`);
  const limit = docText.byteLimit(g.format);
  if (info.size > limit) {
    throw new Error(
      `${g.path} is ${(info.size / 1048576).toFixed(1)} MB, over the ${limit / 1048576} MB read limit for ${g.format} files. Open it in Markie instead.`
    );
  }
  const bytes = await readFile(g.path);
  if (docText.TEXT_FORMATS.has(g.format)) {
    const text = docText.decodeText(bytes);
    if (text === null) throw new Error(`${g.path} holds binary data, not ${g.format} text.`);
    return text;
  }
  const text = docText.textFromBytes(bytes, g.format);
  if (text === null) {
    throw new Error(
      `No text could be extracted from ${g.path}. It may be damaged, encrypted, or not really ${FORMAT_LABEL[g.format]}. Open it in Markie instead.`
    );
  }
  const cut = text.length >= docText.MAX_TEXT_CHARS ? " Only the first part of the text is shown." : "";
  return `[Extracted read-only text from ${FORMAT_LABEL[g.format]}. Formatting, pictures and layout are left out, and this text cannot be written back to the file. To change the document, open it in Markie with markie_open_in_markie.${cut}]\n\n${text}`;
}

async function runTool(name, args) {
  switch (name) {
    case "markie_find_documents": {
      const rows = await scan();
      const formats = parseFormats(args.formats);
      const hits = findRows(rows, { query: args.query, formats, limit: clampLimit(args.limit, 50, 500) }).map(
        (r) => ({ path: r.path, name: r.name, dir: r.dir, format: r.format, mtime: mtimeIso(r.mtimeMs) })
      );
      const result = { count: hits.length, files: hits };
      const truncated = truncationNote();
      if (truncated) result.truncated = truncated;
      return result;
    }
    case "markie_search_documents": {
      const query = typeof args.query === "string" ? args.query.trim().slice(0, MAX_QUERY_CHARS) : "";
      if (!query) throw new Error("query is required. To list documents without searching their text, use markie_find_documents.");
      const formats = parseFormats(args.formats);
      const rows = await scan();
      const found = await docText.searchDocuments(rows, query, {
        formats,
        limit: clampLimit(args.limit, 20, 200),
        maxMs: SEARCH_MAX_MS,
        // Agents run tool calls side by side; one search must not cancel another.
        supersede: false,
      });
      const results = found.results.map((r) => {
        const hit = { path: r.path, name: r.name, format: r.format, mtime: mtimeIso(r.mtimeMs) };
        if (r.excerpt) hit.excerpt = r.excerpt;
        return hit;
      });
      const result = { count: results.length, searched: found.total, results };
      if (found.partial) {
        result.partial =
          "The search stopped reading document text before it reached every file, so older documents were matched by name and path only. Narrow it with formats or a more specific query.";
      }
      const truncated = truncationNote();
      if (truncated) result.truncated = truncated;
      return result;
    }
    case "markie_read_document":
      return await readDocument(args.path);
    case "markie_write_document": {
      const refusal = readOnlyWriteRefusal(args.path);
      if (refusal) throw new Error(refusal);
      const g = guardPath(args.path, HOME, { mode: "write", formats: WRITE_FORMATS });
      if (!g.ok) throw new Error(g.error);
      const fm = frontMatterArgs(args);
      if (g.format !== "markdown" && (fm.project || fm.block)) {
        throw new Error(
          `project and block are markdown front matter, and a ${g.format} file has nowhere to keep them. Leave them out, or write a .md file. Nothing was written.`
        );
      }
      const content = String(args.content ?? "");
      const body = g.format === "markdown" ? applyMarkieFrontMatter(content, fm) : content;
      const problem = checkWritableContent(body, g.format);
      if (problem) throw new Error(`${problem} Nothing was written.`);
      return await writeGuarded(g.path, body);
    }
    case "markie_find_md": {
      const rows = await scan();
      const hits = findRows(rows, { query: args.query, formats: ["markdown"], limit: clampLimit(args.limit, 50, 500) }).map(
        (r) => ({ path: r.path, name: r.name, dir: r.dir })
      );
      const result = { count: hits.length, files: hits };
      const truncated = truncationNote();
      if (truncated) result.truncated = truncated;
      return result;
    }
    case "markie_read_md": {
      const g = guardPath(args.path, HOME);
      if (!g.ok) throw new Error(g.error);
      return await readFile(g.path, "utf8");
    }
    case "markie_write_md": {
      const g = guardPath(args.path, HOME, { mode: "write" });
      if (!g.ok) throw new Error(g.error);
      const body = applyMarkieFrontMatter(String(args.content ?? ""), frontMatterArgs(args));
      return await writeGuarded(g.path, body);
    }
    case "markie_list_skills": {
      // Agent instruction files are markdown. The scan now carries every
      // document type, and a .codex log or config is not a skill.
      const rows = (await scan()).filter((r) => r.format === "markdown");
      return groupSkills(rows, { home: HOME }).map((grp) => ({
        tool: grp.label,
        files: grp.files.map((f) => ({ path: f.path, name: f.name })),
      }));
    }
    case "markie_open_in_markie": {
      const g = guardPath(args.path, HOME, { formats: READ_FORMATS });
      if (!g.ok) throw new Error(g.error);
      try {
        await stat(g.path);
      } catch {
        throw new Error(`No such file: ${g.path}`);
      }
      const launcher = markieOpenCommand(g.path);
      if (!launcher.ok) throw new Error(launcher.error);
      const child = spawn(launcher.command, launcher.args, {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      return launcher.message;
    }
    case "markie_cloud_status":
    case "markie_cloud_sync":
    case "markie_cloud_public_link":
    case "markie_cloud_revoke_public_link": {
      // Fence the path here too, so an agent learns the rule from this server;
      // the app checks again before it touches anything.
      const g = guardPath(args.path, HOME, { formats: ["markdown", "text"] });
      if (!g.ok) throw new Error(g.error);
      const method = name.replace(/^markie_/, "");
      const params = { path: g.path, ...(name === "markie_cloud_public_link" ? { create: args.create === true } : {}) };
      return await askMarkie(method, params);
    }
    case "markie_check_md": {
      const g = guardPath(args.path, HOME);
      if (!g.ok) throw new Error(g.error);
      return checkMarkdown(await readFile(g.path, "utf8"), g.path);
    }
    case "markie_guide":
      return MARKDOWN_GUIDE;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- MCP plumbing (newline-delimited JSON-RPC over stdio) ----

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "markie-mcp", version: SERVER_VERSION },
          // Clients hand this to the model at connect time: what Markie is,
          // which tool to reach for, and how to file what it writes.
          instructions: INSTRUCTIONS,
        },
      });
    } else if (method === "notifications/initialized") {
      // notification — no response
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "resources/list") {
      send({ jsonrpc: "2.0", id, result: { resources: RESOURCES } });
    } else if (method === "resources/templates/list") {
      // Nothing here is parameterized, but a client that asks must get a list
      // rather than "method not found", which some of them treat as a fault.
      send({ jsonrpc: "2.0", id, result: { resourceTemplates: [] } });
    } else if (method === "resources/read") {
      if (params?.uri !== GUIDE_URI) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown resource: ${params?.uri}` },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              { uri: GUIDE_URI, mimeType: "text/markdown", text: MARKDOWN_GUIDE },
            ],
          },
        });
      }
    } else if (method === "tools/call") {
      const out = await runTool(params.name, params.arguments ?? {});
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: typeof out === "string" ? out : JSON.stringify(out, null, 2),
            },
          ],
        },
      });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      });
    }
  }
});
