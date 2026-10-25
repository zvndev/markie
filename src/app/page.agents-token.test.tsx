import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";

const SECRET = "mk_agent_PAGETESTSECRETPAGETESTSECRETPAGETEST12345";
const server = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => ({ id: "u1", name: "A", email: "a@example.com" }) },
  sharesClient: { access: async () => null, list: async () => [], sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => "test-token",
  getServerURL: () => "https://api.markiedocs.com",
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));
vi.mock("@/lib/server-sessions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server-sessions")>()), serverFetch: server.fetch }));

import Home from "./page";
import { authStore } from "@/lib/auth-store";

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "opened content\n" };
const NEXT = { name: "next.md", path: "/notes/next.md", content: "second document\n" };
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

async function boot() {
  await authStore.refresh();
  installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    mcpInfo: vi.fn(async () => ({ serverPath: "/x/markie-mcp.mjs", packaged: true })),
  } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText("opened content");
}

async function openRemoteAgents() {
  fireEvent.click(screen.getByRole("button", { name: "Connect an agent (MCP)" }));
  fireEvent.click(await screen.findByRole("button", { name: /Remote agents/ }));
  await screen.findByRole("dialog", { name: "Remote agents" });
}

async function createToken() {
  fireEvent.change(await screen.findByLabelText("Token name"), { target: { value: "Claude cloud" } });
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  await screen.findByText(SECRET);
}

beforeEach(() => {
  localStorage.clear();
  server.fetch.mockReset();
  server.fetch.mockImplementation(async (_origin: string, path: string, init?: RequestInit) => {
    if (path === "/api/agent-tokens" && init?.method === "POST") {
      return reply(201, { id: "t1", name: "Claude cloud", token: SECRET, prefix: SECRET.slice(0, 12), createdAt: "2026-10-25T12:00:00.000Z" });
    }
    return reply(200, { tokens: [] });
  });
});

describe("a document opening while the Agents dialog is up", () => {
  it("keeps the dialog, and the new token in it, until the token is copied", async () => {
    await boot();
    await openRemoteAgents();
    await createToken();

    await act(async () => { emit("onFileOpened", NEXT); });
    await screen.findByText("second document");
    expect(screen.getByRole("dialog", { name: "Remote agents" })).toBeTruthy();
    expect(screen.getByText(SECRET)).toBeTruthy();
  });

  it("closes the dialog on a document open once the token has been copied", async () => {
    await boot();
    await openRemoteAgents();
    await createToken();
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));

    await act(async () => { emit("onFileOpened", NEXT); });
    await screen.findByText("second document");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remote agents" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Connect an agent to Markie" })).toBeNull();
  });

  it("still closes the dialog on a document open when no token is showing", async () => {
    await boot();
    await openRemoteAgents();
    await screen.findByLabelText("Token name");

    await act(async () => { emit("onFileOpened", NEXT); });
    await screen.findByText("second document");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remote agents" })).toBeNull());
  });
});
