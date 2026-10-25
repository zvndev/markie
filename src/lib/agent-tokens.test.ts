import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ serverFetch: vi.fn(), origin: "https://api.markiedocs.com" }));
vi.mock("@/lib/auth-client", () => ({ getServerURL: () => mocks.origin }));
vi.mock("@/lib/server-sessions", () => ({ serverFetch: mocks.serverFetch }));

import { claudeCodeSetupCommand, createAgentToken, genericMcpConfig, hostedMcpUrl, listAgentTokens, offersNoAgentTokens, revokeAgentToken } from "./agent-tokens";

const reply = (status: number, body: unknown = null) => ({ ok: status < 300, status, json: async () => body }) as Response;

beforeEach(() => {
  mocks.serverFetch.mockReset();
  mocks.origin = "https://api.markiedocs.com";
});

describe("agent token client", () => {
  it("builds the hosted MCP URL from the signed-in server, self-hosted ones included", () => {
    expect(hostedMcpUrl()).toBe("https://api.markiedocs.com/mcp");
    expect(hostedMcpUrl("https://notes.example.test/")).toBe("https://notes.example.test/mcp");
  });

  it("writes the Claude Code command and a JSON config exactly", () => {
    expect(claudeCodeSetupCommand("https://h/mcp", "TOK")).toBe('claude mcp add --transport http markie-cloud https://h/mcp --header "Authorization: Bearer TOK"');
    expect(JSON.parse(genericMcpConfig("https://h/mcp", "TOK"))).toEqual({
      mcpServers: { "markie-cloud": { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer TOK" } } },
    });
  });

  it("calls the contract routes through the app's authenticated fetch", async () => {
    mocks.serverFetch.mockResolvedValueOnce(reply(200, { tokens: [] }));
    mocks.serverFetch.mockResolvedValueOnce(reply(201, { id: "a", name: "n", token: "mk_agent_x", prefix: "mk_agent_x", createdAt: 1 }));
    mocks.serverFetch.mockResolvedValueOnce(reply(204));
    await listAgentTokens();
    await createAgentToken("n");
    expect(await revokeAgentToken("a/b")).toEqual({ ok: true, data: true });
    expect(mocks.serverFetch.mock.calls.map((c) => [c[0], c[1], c[2].method])).toEqual([
      ["https://api.markiedocs.com", "/api/agent-tokens", "GET"],
      ["https://api.markiedocs.com", "/api/agent-tokens", "POST"],
      ["https://api.markiedocs.com", "/api/agent-tokens/a%2Fb", "DELETE"],
    ]);
  });

  it("skips malformed rows rather than failing the list", async () => {
    mocks.serverFetch.mockResolvedValueOnce(reply(200, { tokens: [{ id: "a", name: "ok", prefix: "p", createdAt: "x", lastUsedAt: null }, { name: "no id" }, null, 4] }));
    const res = await listAgentTokens();
    expect(res.ok && res.data.map((t) => t.id)).toEqual(["a"]);
  });

  it("refuses a create answer that carries no token", async () => {
    mocks.serverFetch.mockResolvedValueOnce(reply(201, { id: "a", name: "n" }));
    const res = await createAgentToken("n");
    expect(res.ok).toBe(false);
  });

  it("turns failures into words and never echoes a secret from the body", async () => {
    mocks.serverFetch.mockResolvedValueOnce(reply(401, { error: "unauthorized" }));
    expect(await listAgentTokens()).toMatchObject({ ok: false, status: 401, message: expect.stringMatching(/sign-in has expired/) });
    mocks.serverFetch.mockRejectedValueOnce(new Error("net"));
    expect(await listAgentTokens()).toMatchObject({ ok: false, status: 0, message: expect.stringMatching(/could not be reached/) });
    mocks.serverFetch.mockResolvedValueOnce(reply(404, { error: "not found" }));
    expect(await listAgentTokens()).toMatchObject({ ok: false, message: "This server does not offer agent tokens." });
    mocks.serverFetch.mockResolvedValueOnce(reply(400, { error: "bad mk_agent_LEAK" }));
    expect(await createAgentToken("n")).toMatchObject({ ok: false, message: "Markie Cloud refused (400)." });
    mocks.serverFetch.mockResolvedValueOnce(reply(409, { error: "You already have 20 active tokens." }));
    expect(await createAgentToken("n")).toMatchObject({ ok: false, message: "You already have 20 active tokens." });
  });

  it("reads a 404 on revoke as already gone, and 204 as revoked", async () => {
    mocks.serverFetch.mockResolvedValueOnce(reply(404, { error: "not found" }));
    expect(await revokeAgentToken("a")).toEqual({ ok: true, data: true });
    mocks.serverFetch.mockResolvedValueOnce(reply(204));
    expect(await revokeAgentToken("a")).toEqual({ ok: true, data: true });
  });

  it("still reports the other failures of a revoke", async () => {
    mocks.serverFetch.mockResolvedValueOnce(reply(401, null));
    expect(await revokeAgentToken("a")).toMatchObject({ ok: false, status: 401 });
    mocks.serverFetch.mockResolvedValueOnce(reply(500, null));
    expect(await revokeAgentToken("a")).toMatchObject({ ok: false, message: "Markie Cloud refused (500)." });
    mocks.serverFetch.mockRejectedValueOnce(new Error("net"));
    expect(await revokeAgentToken("a")).toMatchObject({ ok: false, status: 0 });
  });

  it("keeps 'does not offer agent tokens' for the list and create routes", async () => {
    mocks.serverFetch.mockResolvedValueOnce(reply(404, null));
    expect(await listAgentTokens()).toMatchObject({ ok: false, status: 404, message: "This server does not offer agent tokens." });
    mocks.serverFetch.mockResolvedValueOnce(reply(405, null));
    expect(await createAgentToken("n")).toMatchObject({ ok: false, message: "This server does not offer agent tokens." });
    expect([404, 405, 501].every(offersNoAgentTokens)).toBe(true);
    expect([200, 204, 400, 401, 429, 500].some(offersNoAgentTokens)).toBe(false);
  });
});
