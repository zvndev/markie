import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: { user: { id: "u1", email: "a@example.test", name: "A" } as { id: string; email: string; name: string } | null, status: "in" as "in" | "out" | "checking" },
  serverFetch: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ getServerURL: () => "https://api.markiedocs.com" }));
vi.mock("@/lib/auth-store", () => ({ useAuth: () => state.auth }));
vi.mock("@/lib/server-sessions", () => ({ serverFetch: state.serverFetch }));

import { RemoteAgentsPanel } from "./remote-agents-panel";
import { AgentsDialog } from "./agents-dialog";
import { installBridge } from "@/test/mock-bridge";

const URL_ = "https://api.markiedocs.com/mcp";
const SECRET = "mk_agent_SECRETSECRETSECRETSECRETSECRETSECRET12345";

function reply(status: number, body: unknown = null): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Row = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };
const ROWS: Row[] = [
  { id: "t1", name: "Claude on my phone", prefix: "mk_agent_ab1", createdAt: "2026-10-01T12:00:00.000Z", lastUsedAt: "2026-10-20T12:00:00.000Z" },
  { id: "t2", name: "Cursor", prefix: "mk_agent_cd2", createdAt: "2026-10-02T12:00:00.000Z", lastUsedAt: null },
];

// A tiny stand-in for the three routes, keeping the list the server would hold.
function mockServer(initial: Row[] = ROWS) {
  let rows = [...initial];
  state.serverFetch.mockImplementation(async (_origin: string, path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/agent-tokens" && method === "GET") return reply(200, { tokens: rows });
    if (path === "/api/agent-tokens" && method === "POST") {
      const { name } = JSON.parse(init!.body as string);
      const made = { id: "t3", name, token: SECRET, prefix: SECRET.slice(0, 12), createdAt: "2026-10-25T12:00:00.000Z" };
      rows = [{ id: made.id, name, prefix: made.prefix, createdAt: made.createdAt, lastUsedAt: null }, ...rows];
      return reply(201, made);
    }
    const del = /^\/api\/agent-tokens\/(.+)$/.exec(path);
    if (del && method === "DELETE") {
      rows = rows.filter((r) => r.id !== decodeURIComponent(del[1]));
      return reply(204);
    }
    return reply(404, { error: "not found" });
  });
}

const dialog = () => screen.getByRole("dialog", { name: "Remote agents" });
const text = () => dialog().textContent ?? "";
const pres = () => [...dialog().querySelectorAll("pre")].map((p) => p.textContent ?? "");

let clipboard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.auth = { user: { id: "u1", email: "a@example.test", name: "A" }, status: "in" };
  state.serverFetch.mockReset();
  clipboard = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText: clipboard } });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("RemoteAgentsPanel", () => {
  it("lists tokens with name, prefix, created and last used, and never the token itself", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    expect(await screen.findByText("Claude on my phone")).toBeTruthy();
    const phone = screen.getByText("Claude on my phone").closest("li")!;
    expect(phone.textContent).toContain("mk_agent_ab1");
    expect(phone.textContent).toMatch(/Created .*2026/);
    expect(phone.textContent).toMatch(/Last used/);
    expect(screen.getByText("Cursor").closest("li")!.textContent).toContain("Never used");
    expect(state.serverFetch).toHaveBeenCalledWith("https://api.markiedocs.com", "/api/agent-tokens", { method: "GET" });
  });

  it("shows the hosted MCP URL and a setup that names a placeholder before any token exists", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    expect(pres()).toContain(URL_);
    expect(pres()).toContain(`claude mcp add --transport http markie-cloud ${URL_} --header "Authorization: Bearer <token>"`);
    const json = JSON.parse(pres().find((p) => p.startsWith("{"))!);
    expect(json).toEqual({ mcpServers: { "markie-cloud": { type: "http", url: URL_, headers: { Authorization: "Bearer <token>" } } } });
  });

  it("creates a token, shows it once with a copy button and a warning, then fills the setup", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    const create = screen.getByRole("button", { name: "Create token" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "  Claude cloud  " } });
    fireEvent.click(create);

    const group = await screen.findByRole("group", { name: "New token" });
    expect(JSON.parse(state.serverFetch.mock.calls.find((c) => c[2]?.method === "POST")![2].body)).toEqual({ name: "Claude cloud" });
    expect(within(group).getByRole("alert").textContent).toMatch(/will not be shown again/);
    expect(within(group).getByText(SECRET)).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(SECRET));

    expect(pres()).toContain(`claude mcp add --transport http markie-cloud ${URL_} --header "Authorization: Bearer ${SECRET}"`);
    expect(JSON.parse(pres().find((p) => p.startsWith("{"))!).mcpServers["markie-cloud"].headers.Authorization).toBe(`Bearer ${SECRET}`);
    // It joined the list as a row that carries only the prefix.
    const row = screen.getByText("Claude cloud", { selector: "div" }).closest("li")!;
    expect(row.textContent).toContain("mk_agent_");
    expect(row.textContent).not.toContain(SECRET);
    expect((screen.getByLabelText("Token name") as HTMLInputElement).value).toBe("");
  });

  it("forgets the token once it is acknowledged, and a refreshed list never carries it", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByRole("group", { name: "New token" });
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByRole("group", { name: "New token" })).toBeNull();
    expect(text()).not.toContain(SECRET);
    expect(pres().join("\n")).not.toContain(SECRET);
  });

  it("clears the token from the page when the panel closes, and does not write it anywhere", async () => {
    mockServer();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);
    view.unmount();
    expect(document.body.textContent).not.toContain(SECRET);
    // Opening it again starts from the server's list, with nothing remembered.
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(setItem.mock.calls.flat().join(" ")).not.toContain(SECRET);
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls])).not.toContain(SECRET);
  });

  it("revokes only after a confirmation, and drops the row", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
    expect(state.serverFetch.mock.calls.some((c) => c[2]?.method === "DELETE")).toBe(false);
    expect(screen.getByText("Cursor")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
    await waitFor(() => expect(screen.queryByText("Cursor")).toBeNull());
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("Cursor"));
    expect(state.serverFetch).toHaveBeenCalledWith("https://api.markiedocs.com", "/api/agent-tokens/t2", { method: "DELETE" });
    expect(screen.getByText("Claude on my phone")).toBeTruthy();
  });

  it("takes the token off the screen when that token is revoked", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "temp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Revoke temp" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
  });

  it("says why when the server refuses, and keeps what it had", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    const impl = state.serverFetch.getMockImplementation()!;
    state.serverFetch.mockImplementationOnce(async () => reply(400, { error: "You already have 20 active tokens. Revoke one first." }));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "one more" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect((await screen.findByText(/already have 20 active tokens/)).getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("group", { name: "New token" })).toBeNull();
    expect(screen.getByText("Cursor")).toBeTruthy();

    state.serverFetch.mockImplementationOnce(async () => reply(500, { error: `leak ${SECRET}` }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
    expect((await screen.findByText("Markie Cloud refused (500).")).getAttribute("role")).toBe("alert");
    expect(text()).not.toContain(SECRET);
    expect(screen.getByText("Cursor")).toBeTruthy();
    state.serverFetch.mockImplementation(impl);
  });

  it("offers a retry when the list cannot load", async () => {
    mockServer();
    state.serverFetch.mockRejectedValueOnce(new Error("offline"));
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    expect(await screen.findByText(/could not be reached/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Cursor")).toBeTruthy();
  });

  it("explains it needs a sign-in, and calls the server for nothing, when signed out", () => {
    state.auth = { user: null, status: "out" };
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    expect(text()).toMatch(/Remote agents need a Markie Cloud sign-in/);
    expect(screen.queryByLabelText("Token name")).toBeNull();
    expect(pres()).toEqual([]);
    expect(state.serverFetch).not.toHaveBeenCalled();
  });

  it("waits quietly while the sign-in is still being checked", () => {
    state.auth = { user: null, status: "checking" };
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    expect(text()).toMatch(/Checking your Markie Cloud sign-in/);
    expect(state.serverFetch).not.toHaveBeenCalled();
  });

  it("drops the token and the list when the account signs out underneath it", async () => {
    mockServer();
    const view = render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);
    state.auth = { user: null, status: "out" };
    await act(async () => { view.rerender(<RemoteAgentsPanel onClose={vi.fn()} />); });
    expect(document.body.textContent).not.toContain(SECRET);
    expect(text()).toMatch(/need a Markie Cloud sign-in/);
  });

  it("says a token reaches only the documents it made itself", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    expect(text()).toMatch(/read and edit only the documents that same token created/);
    expect(text()).toMatch(/another token made/);
    expect(text()).toMatch(/on this computer/);
    expect(text()).not.toMatch(/never the rest of your Cloud/);
  });

  it("tells the revoker that the token's documents stay", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("documents it made stay in your Cloud"));
  });

  describe("an answer that arrives after the account changed", () => {
    function deferred() {
      let resolve!: (r: Response) => void;
      const promise = new Promise<Response>((r) => { resolve = r; });
      return { promise, resolve };
    }
    const switchTo = async (view: ReturnType<typeof render>, id: string | null) => {
      state.auth = id ? { user: { id, email: `${id}@example.test`, name: id }, status: "in" } : { user: null, status: "out" };
      await act(async () => { view.rerender(<RemoteAgentsPanel onClose={vi.fn()} />); });
    };

    it("never shows account A's new token to account B", async () => {
      mockServer();
      const impl = state.serverFetch.getMockImplementation()!;
      const post = deferred();
      state.serverFetch.mockImplementation(async (origin: string, path: string, init?: RequestInit) =>
        path === "/api/agent-tokens" && init?.method === "POST" ? post.promise : impl(origin, path, init));
      const view = render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "A's agent" } });
      fireEvent.click(screen.getByRole("button", { name: "Create token" }));
      await switchTo(view, "u2");
      await screen.findByText("Cursor");
      await act(async () => { post.resolve(reply(201, { id: "t9", name: "A's agent", token: SECRET, prefix: SECRET.slice(0, 12), createdAt: "2026-10-25T12:00:00.000Z" })); });
      expect(document.body.textContent).not.toContain(SECRET);
      expect(screen.queryByRole("group", { name: "New token" })).toBeNull();
      expect(screen.queryByText("A's agent")).toBeNull();
      expect(pres().join("\n")).not.toContain(SECRET);
      // B is not left stuck on a "Creating…" button either.
      expect((screen.getByRole("button", { name: "Create token" }) as HTMLButtonElement).textContent).toBe("Create token");
    });

    it("does not leave a token hidden in state after a sign-out, to appear on the next sign-in", async () => {
      mockServer();
      const impl = state.serverFetch.getMockImplementation()!;
      const post = deferred();
      state.serverFetch.mockImplementation(async (origin: string, path: string, init?: RequestInit) =>
        path === "/api/agent-tokens" && init?.method === "POST" ? post.promise : impl(origin, path, init));
      const view = render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "A's agent" } });
      fireEvent.click(screen.getByRole("button", { name: "Create token" }));
      await switchTo(view, null);
      await act(async () => { post.resolve(reply(201, { id: "t9", name: "A's agent", token: SECRET, prefix: SECRET.slice(0, 12), createdAt: "2026-10-25T12:00:00.000Z" })); });
      await switchTo(view, "u2");
      await screen.findByText("Cursor");
      expect(document.body.textContent).not.toContain(SECRET);
    });

    it("does not show account A's failed revoke on account B", async () => {
      mockServer();
      const impl = state.serverFetch.getMockImplementation()!;
      const del = deferred();
      state.serverFetch.mockImplementation(async (origin: string, path: string, init?: RequestInit) =>
        init?.method === "DELETE" ? del.promise : impl(origin, path, init));
      const view = render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
      await switchTo(view, "u2");
      await screen.findByText("Cursor");
      await act(async () => { del.resolve(reply(500, { error: "boom" })); });
      expect(screen.queryByText("Markie Cloud refused (500).")).toBeNull();
      expect(screen.getByText("Cursor")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Revoke Cursor" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("does not drop a row of account B because account A's revoke finished", async () => {
      mockServer();
      const impl = state.serverFetch.getMockImplementation()!;
      const del = deferred();
      state.serverFetch.mockImplementation(async (origin: string, path: string, init?: RequestInit) =>
        init?.method === "DELETE" ? del.promise : impl(origin, path, init));
      const view = render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
      await switchTo(view, "u2");
      await screen.findByText("Cursor");
      await act(async () => { del.resolve(reply(204)); });
      expect(screen.getByText("Cursor")).toBeTruthy();
    });
  });

  it("treats a 404 on revoke as already gone and drops the row", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    const impl = state.serverFetch.getMockImplementation()!;
    state.serverFetch.mockImplementation(async (origin: string, path: string, init?: RequestInit) =>
      init?.method === "DELETE" ? reply(404, { error: "not found" }) : impl(origin, path, init));
    fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
    await waitFor(() => expect(screen.queryByText("Cursor")).toBeNull());
    expect(text()).not.toMatch(/does not offer agent tokens/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("a server without agent tokens", () => {
    it("says so and hides the URL, the token form and the setup blocks", async () => {
      state.serverFetch.mockImplementation(async () => reply(404, { error: "not found" }));
      render(<RemoteAgentsPanel onClose={vi.fn()} />);
      expect(await screen.findByText("This server does not offer agent tokens.")).toBeTruthy();
      expect(pres()).toEqual([]);
      expect(screen.queryByLabelText("Token name")).toBeNull();
      expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
      expect(text()).not.toMatch(/Set up your agent/);
      expect(text()).not.toContain("claude mcp add");
    });

    it("keeps showing the setup when only a revoke answers 404", async () => {
      mockServer();
      render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      const impl = state.serverFetch.getMockImplementation()!;
      state.serverFetch.mockImplementation(async (origin: string, path: string, init?: RequestInit) =>
        init?.method === "DELETE" ? reply(404, null) : impl(origin, path, init));
      fireEvent.click(screen.getByRole("button", { name: "Revoke Cursor" }));
      await waitFor(() => expect(screen.queryByText("Cursor")).toBeNull());
      expect(pres()).toContain(URL_);
    });
  });

  describe("focus", () => {
    it("moves into the panel on open and back to the opener on close", async () => {
      mockServer();
      const opener = document.createElement("button");
      opener.textContent = "open";
      document.body.append(opener);
      opener.focus();
      const view = render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      expect(document.activeElement).toBe(dialog());
      view.unmount();
      await waitFor(() => expect(document.activeElement).toBe(opener));
      opener.remove();
    });

    it("keeps Tab inside the panel, wrapping at both ends", async () => {
      mockServer();
      render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      const buttons = [...dialog().querySelectorAll<HTMLElement>("button,input")].filter((el) => !(el as HTMLButtonElement).disabled);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      last.focus();
      fireEvent.keyDown(last, { key: "Tab" });
      expect(document.activeElement).toBe(first);
      first.focus();
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    });
  });

  it("ignores a backdrop click while a token that cannot be shown again is on screen", async () => {
    mockServer();
    const onClose = vi.fn();
    render(<RemoteAgentsPanel onClose={onClose} />);
    await screen.findByText("Cursor");
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);
    const scrim = screen.getByRole("dialog", { name: "Remote agents" }).parentElement!;
    fireEvent.mouseDown(scrim);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pulls focus that leaves the panel back into it", async () => {
    mockServer();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      render(<RemoteAgentsPanel onClose={vi.fn()} />);
      await screen.findByText("Cursor");
      act(() => outside.focus());
      expect(screen.getByRole("dialog", { name: "Remote agents" }).contains(document.activeElement)).toBe(true);
    } finally {
      outside.remove();
    }
  });

  it("reports whether a token that has not been copied is on screen", async () => {
    mockServer();
    const shown = vi.fn();
    const view = render(<RemoteAgentsPanel onClose={vi.fn()} onSecretShownChange={shown} />);
    await screen.findByText("Cursor");
    expect(shown).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);
    await waitFor(() => expect(shown).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(shown).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText(SECRET);
    view.unmount();
    expect(shown).toHaveBeenLastCalledWith(false);
  });

  it("closes on Escape and on the close button", async () => {
    mockServer();
    const onClose = vi.fn();
    render(<RemoteAgentsPanel onClose={onClose} />);
    await screen.findByText("Cursor");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("uses no em-dash in what it shows", async () => {
    mockServer();
    render(<RemoteAgentsPanel onClose={vi.fn()} />);
    await screen.findByText("Cursor");
    expect(text()).not.toContain("—");
  });
});

describe("AgentsDialog entry point", () => {
  it("opens Remote agents from the Markie Cloud settings and keeps Escape for the panel on top", async () => {
    mockServer();
    installBridge({ mcpInfo: vi.fn(async () => ({ serverPath: "/x/markie-mcp.mjs", packaged: true })) });
    const onClose = vi.fn();
    render(<AgentsDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Remote agents/ }));
    await screen.findByText("Cursor");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Remote agents" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("makes the dialog behind the panel inert while it is open, and live again after", async () => {
    mockServer();
    installBridge({ mcpInfo: vi.fn(async () => ({ serverPath: "/x/markie-mcp.mjs", packaged: true })) });
    render(<AgentsDialog onClose={vi.fn()} />);
    const agents = () => screen.getByRole("dialog", { name: "Connect an agent to Markie", hidden: true });
    const open = screen.getByRole("button", { name: /Remote agents/ });
    open.focus();
    fireEvent.click(open);
    await screen.findByText("Cursor");
    expect(agents().hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(agents().hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Remote agents/ })));
  });
});
