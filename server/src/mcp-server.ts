// The hosted Markie MCP: POST /mcp, for remote agents that hold an agent
// token and have no desktop app nearby (docs/mobile/AGENT-LINKS-CONTRACT.md).
//
// Streamable HTTP in its simplest legal form: every JSON-RPC request is
// answered with one application/json response, and nothing is streamed, so
// GET (the server-to-client stream) and DELETE (ending a session) are 405.
// There are no sessions: the bearer token is the whole identity, checked on
// every request. Written in the style of the dependency-free mcp/markie-mcp.mjs.
//
// Every tool goes through agent-docs.ts, the same functions the REST routes
// use, so the one rule holds here too: a token reaches only the documents it
// created itself.
import { Hono, type Context } from "hono";
import { type AgentPrincipal } from "./agent-tokens.ts";
import {
  AGENT_LIST_MAX,
  PASTE_INSTRUCTION,
  agentAuth,
  chargeAgentWrite,
  type AgentEnv,
  createAgentDoc,
  listAgentDocs,
  readAgentDoc,
  updateAgentDoc,
  type AgentResult,
} from "./agent-docs.ts";
import { SERVER_VERSION } from "./deployment.ts";
// A generated copy of mcp/markdown-guide.mjs (scripts/sync-markdown-guide.mjs):
// the server's build context does not include mcp/.
import { MARKDOWN_GUIDE } from "./generated/markdown-guide.mjs";

// The one protocol version this endpoint speaks. initialize always answers
// with it, which per the MCP handshake tells a client asking for another one
// to disconnect, and a request whose MCP-Protocol-Version header names any
// other version is refused.
export const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS = [
  "Markie Cloud: write documents into the user's private Markie Cloud and hand them a link.",
  "Call markie_guide once before writing, for what Markie renders, including Darkmown (.wd) for documents with live state.",
  "Create with markie_create_document; update your own documents with markie_update_document.",
  "Every document is private to the user. " + PASTE_INSTRUCTION,
].join(" ");

const TOOLS = [
  {
    name: "markie_create_document",
    description:
      "Create a private document in the user's Markie Cloud. The name must end in .md, .markdown, .mdx, .wd (Darkmown, at most 128,000 characters) or .txt; other documents may be up to 2 MB. Returns id, privateLink and markdownLink. " +
      PASTE_INSTRUCTION,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name, for example Plan.md or Budget.wd" },
        content: { type: "string", description: "The full document text" },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_update_document",
    description:
      "Replace the full text of a document this agent token created with markie_create_document. Other documents in the user's Markie Cloud are not reachable and answer not found. A document the user has shared can no longer be changed: create a new one instead. " +
      PASTE_INSTRUCTION,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document id from markie_create_document or markie_list_my_documents" },
        content: { type: "string", description: "The full new document text" },
      },
      required: ["id", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_list_my_documents",
    description:
      "List the documents this agent token created in the user's Markie Cloud, newest first, with privateLink and markdownLink for each. Nothing else in the user's Markie Cloud is listed.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: `Max results (default 50, max ${AGENT_LIST_MAX})` } },
      additionalProperties: false,
    },
  },
  {
    name: "markie_read_my_document",
    description: "Read the full text of a document this agent token created, by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The document id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_guide",
    description:
      "What Markie renders: the markdown it draws, pictures and media, links between documents, and Darkmown (.wd) for interactive documents. Read before writing a document.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

type JsonRpcId = string | number | null;
interface ToolOutcome {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const toolError = (text: string): ToolOutcome => ({ content: [{ type: "text", text }], isError: true });

// A refusal from agent-docs.ts as a tool error the model can act on: the
// sentence as text, and the same body the REST route answers with (for
// example {error: "shared", message}) as structured content.
function fromResult<T extends object>(result: AgentResult<T>, links: boolean): ToolOutcome {
  if (!result.ok) {
    const { error, message } = result.body;
    return {
      ...toolError(`Error: ${message ?? error}${result.status === 404 ? " (no such document among the ones this agent token created)" : ""}`),
      structuredContent: { ...result.body },
    };
  }
  const data = result.data as Record<string, unknown>;
  const text = JSON.stringify(data, null, 2) + (links ? `\n\n${PASTE_INSTRUCTION}` : "");
  return { content: [{ type: "text", text }], structuredContent: data };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function runTool(agent: AgentPrincipal, name: unknown, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case "markie_create_document": {
      const limited = chargeAgentWrite(agent);
      if (limited) return fromResult(limited, false);
      return fromResult(createAgentDoc(agent, { name: args.name, content: args.content }), true);
    }
    case "markie_update_document": {
      const limited = chargeAgentWrite(agent);
      if (limited) return fromResult(limited, false);
      return fromResult(updateAgentDoc(agent, args.id, { content: args.content }), true);
    }
    case "markie_list_my_documents":
      return fromResult(listAgentDocs(agent, args.limit), true);
    case "markie_read_my_document":
      return fromResult(readAgentDoc(agent, args.id), true);
    case "markie_guide":
      return { content: [{ type: "text", text: MARKDOWN_GUIDE }] };
    default:
      throw new RpcError(-32602, `Unknown tool: ${typeof name === "string" ? name : String(name)}`);
  }
}

function handle(agent: AgentPrincipal, method: string, params: unknown): unknown {
  switch (method) {
    case "initialize": {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "markie-cloud", title: "Markie Cloud", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      if (!isObject(params) || typeof params.name !== "string") throw new RpcError(-32602, "tools/call needs a tool name.");
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isObject(args)) throw new RpcError(-32602, "Tool arguments must be an object.");
      return runTool(agent, params.name, args);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

// The token check, answering in JSON-RPC's shape. index.ts runs it ahead of
// the body limit on POST /mcp, so a caller without a live token is answered
// from its headers alone and no body is read on its behalf, chunked bodies
// included; the router runs it again for when it is mounted on its own.
export const mcpAuth = agentAuth((c) => c.json(rpcError(null, -32001, "Unauthorized: send Authorization: Bearer mk_agent_..."), 401));

export const mcpApi = new Hono<AgentEnv>();

mcpApi.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

mcpApi.post("/", mcpAuth, async (c) => {
  const agent = c.get("agent")!;

  // Absent is allowed: a client sends the header only after initialize, and
  // there is no session here to remember what initialize agreed.
  const version = c.req.header("mcp-protocol-version");
  if (version !== undefined && version !== PROTOCOL_VERSION) {
    return c.json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version.slice(0, 40)}`), 400);
  }

  let message: unknown;
  try {
    message = JSON.parse(await c.req.text());
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }
  // Batches left JSON-RPC over MCP in 2025-06-18.
  if (!isObject(message) || message.jsonrpc !== "2.0") return c.json(rpcError(null, -32600, "Invalid Request"), 400);

  // MCP requests carry a string or number id, never null.
  const hasId = "id" in message;
  const id = message.id as unknown;
  if (hasId && typeof id !== "string" && typeof id !== "number") {
    return c.json(rpcError(null, -32600, "Invalid Request: id must be a string or a number"), 400);
  }
  // A notification or a response from the client: accepted, nothing to say.
  if (!hasId || typeof message.method !== "string") {
    if (typeof message.method === "string" || "result" in message || "error" in message) return c.body(null, 202);
    return c.json(rpcError(null, -32600, "Invalid Request"), 400);
  }

  try {
    const result = handle(agent, message.method, message.params);
    return c.json({ jsonrpc: "2.0", id, result });
  } catch (err) {
    if (err instanceof RpcError) return c.json(rpcError(id as JsonRpcId, err.code, err.message));
    console.error("mcp request failed:", err);
    return c.json(rpcError(id as JsonRpcId, -32603, "Internal error"));
  }
});

// No server-to-client stream and no sessions to end.
const notAllowed = (c: Context) => {
  c.header("Allow", "POST");
  return c.json({ error: "method not allowed" }, 405);
};
mcpApi.get("/", notAllowed);
mcpApi.delete("/", notAllowed);
