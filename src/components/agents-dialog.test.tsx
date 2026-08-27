import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import type { ElectronAPI } from "@/lib/electron";
import { AgentsDialog } from "./agents-dialog";

const SERVER = "/Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs";

function renderDialog(overrides: Partial<ElectronAPI> = {}) {
  installBridge({
    mcpInfo: vi.fn(async () => ({ serverPath: SERVER, packaged: true })),
    ...overrides,
  });
  return render(<AgentsDialog onClose={vi.fn()} />);
}

// The pre element holding a copyable block, found by the text inside it.
function block(fragment: string): HTMLElement {
  const pre = screen
    .getAllByRole("dialog")[0]
    .querySelectorAll("pre");
  const hit = [...pre].find((el) => el.textContent?.includes(fragment));
  if (!hit) throw new Error(`no block containing ${fragment}`);
  return hit as HTMLElement;
}

describe("AgentsDialog", () => {
  it("hands the user a Claude Code command with the real server path", async () => {
    renderDialog();
    await waitFor(() =>
      expect(block("claude mcp add markie").textContent).toBe(
        `claude mcp add markie -- node ${SERVER}`
      )
    );
  });

  it("hands the user a Codex config block with the real server path", async () => {
    renderDialog();
    await waitFor(() => {
      const text = block("[mcp_servers.markie]").textContent ?? "";
      expect(text).toContain('command = "node"');
      expect(text).toContain(SERVER);
    });
  });

  it("does not uppercase the Codex config path in the label", async () => {
    // The label sat inside a `uppercase` span, so the one place the dialog
    // named the file rendered as ~/.CODEX/CONFIG.TOML, which is not a path.
    renderDialog();
    const label = await screen.findByText(/add to ~\/\.codex\/config\.toml/);
    const styles = getComputedStyle(label);
    expect(styles.textTransform === "uppercase").toBe(false);
    let node: HTMLElement | null = label;
    while (node) {
      expect(node.className).not.toMatch(/\buppercase\b/);
      node = node.parentElement;
    }
  });

  it("leads with what the user gets and keeps the privacy line", async () => {
    renderDialog();
    const dialog = screen.getAllByRole("dialog")[0];
    expect(
      within(dialog).getByText(/Runs on demand, on this computer/)
    ).toBeTruthy();
    expect(within(dialog).getByText(/Nothing is uploaded/)).toBeTruthy();
    // The dev-first framing the product review flagged.
    expect(dialog.textContent).not.toMatch(/guard-railed/i);
    expect(dialog.textContent).not.toMatch(/local MCP server/i);
  });

  it("explains that connected agents file what they write, in any client", async () => {
    renderDialog();
    const dialog = screen.getAllByRole("dialog")[0];
    expect(dialog.textContent).toMatch(/organization\s+conventions/);
    expect(block("markie:").textContent).toContain("project: bevrly");
    expect(block("markie:").textContent).toContain("block: checkout-redesign");
    expect(dialog.textContent).toMatch(/Claude\s+Code, Codex, and any other MCP client/);
  });

  it("writes no em-dashes into the user's copy", async () => {
    renderDialog();
    await waitFor(() => expect(block("claude mcp add markie")).toBeTruthy());
    expect(screen.getAllByRole("dialog")[0].textContent).not.toContain("—");
  });

  it("falls back to the bundled path and says so outside the desktop app", async () => {
    installBridge({ mcpInfo: undefined as unknown as ElectronAPI["mcpInfo"] });
    render(<AgentsDialog onClose={vi.fn()} />);
    expect(block("claude mcp add markie").textContent).toContain(
      "/Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs"
    );
    expect(
      screen.getByText(/Open this from the Markie desktop app/)
    ).toBeTruthy();
  });
});
