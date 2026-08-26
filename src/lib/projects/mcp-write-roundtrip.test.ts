// The declaration an agent makes through the MCP server has to survive the
// whole chain, not just the helper that writes it: MCP tool call -> bytes on
// disk -> the main process front matter extractor -> the taxonomy's precedence
// ladder. Every link is real here (the server runs as a child process, the
// extractor is the shipped CommonJS module) because the drift this release
// already found once lived exactly in the gap between two mirrored copies.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTaxonomy } from "@/lib/projects/taxonomy";
import { parseRules } from "@/lib/projects/rules";
import type { EngineFile } from "@/lib/projects/assign";

const require = createRequire(import.meta.url);
const { extractMarkieMeta } = require("../../../electron/frontmatter.js") as {
  extractMarkieMeta: (text: string) => { project: string | null; block: string | null };
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER = join(REPO_ROOT, "mcp", "markie-mcp.mjs");

interface RpcResponse {
  id: number;
  result?: {
    instructions?: string;
    content?: { text: string }[];
    isError?: boolean;
  };
}

function startServer(home: string) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (msg: RpcResponse) => void>();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as RpcResponse;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return {
    request(method: string, params?: unknown) {
      const id = nextId++;
      const done = new Promise<RpcResponse>((resolve) => pending.set(id, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return done;
    },
    close: () => child.kill(),
  };
}

describe("an MCP-declared project/block reaches the taxonomy", () => {
  let home: string;
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "markie-mcp-roundtrip-")));
    server = startServer(home);
  });
  afterAll(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("files the written document under the declared project and block", async () => {
    await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "roundtrip", version: "0" },
    });

    const target = join(home, "Coding", "notes", "plan.md");
    const write = await server.request("tools/call", {
      name: "markie_write_md",
      arguments: {
        path: target,
        content: "# Plan\n\nWhat we are doing.\n",
        project: "markie",
        block: "organized-workspace",
      },
    });
    expect(write.result?.isError).toBeUndefined();

    // Link 2: the shipped extractor reads the bytes the server actually wrote.
    const meta = extractMarkieMeta(readFileSync(target, "utf8"));
    expect(meta).toEqual({ project: "markie", block: "organized-workspace" });

    // Link 3: the taxonomy's ladder honors it at precedence 2, ahead of the
    // path/clustering fallback that would otherwise have named this "notes".
    const mtimeMs = statSync(target).mtimeMs;
    const file: EngineFile = {
      path: target,
      name: "plan.md",
      dir: dirname(target),
      mtimeMs,
      birthtimeMs: mtimeMs,
      fmProject: meta.project,
      fmBlock: meta.block,
      repoName: null,
    };
    const taxonomy = buildTaxonomy([file], {
      pins: [],
      rules: parseRules("").rules!,
      priorAssignments: [],
      knownBlocks: [],
      home,
    });

    expect(taxonomy.projects.map((p) => p.name)).toEqual(["markie"]);
    expect(taxonomy.projects[0].blocks.map((b) => b.name)).toEqual(["organized-workspace"]);
    expect(taxonomy.projects[0].blocks[0].files.map((f) => f.path)).toEqual([target]);
    expect(taxonomy.assignmentRows[0].source).toBe("frontmatter");
  });

  it("hands the same conventions to the client on initialize", async () => {
    const init = await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "roundtrip", version: "0" },
    });
    const instructions = init.result?.instructions ?? "";
    expect(instructions).toMatch(/markie:\n {2}project:/);
    expect(instructions).toMatch(/never after a date/);
    expect(instructions).toMatch(/Files never move/);
  });
});
