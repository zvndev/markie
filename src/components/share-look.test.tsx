// @vitest-environment jsdom
// The Share dialog's "Readers see my look": an owner pins their theme and
// Markdown style to the document, sees when theirs has moved on, and unpins.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocLook } from "@/lib/theme-sync";

const docLookState = vi.fn();
const setDocLook = vi.fn();
vi.mock("@/lib/theme-sync", () => ({
  docLookState: (id: string) => docLookState(id),
  setDocLook: (id: string, look: DocLook | null) => setDocLook(id, look),
}));

const { ShareLook } = await import("./share-look");
const { MARKIE_DARK } = await import("@/lib/theme");
const { applyMarkdownStyleChoice } = await import("@/lib/markdown-style-store");
const { applyMarkdownStyle } = await import("@/lib/markdown-style");

beforeEach(() => {
  localStorage.clear();
  docLookState.mockReset();
  setDocLook.mockReset();
  setDocLook.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  applyMarkdownStyle(null);
});

describe("Readers see my look", () => {
  it("shows nothing until the server has said what is pinned, and nothing when it cannot say", async () => {
    docLookState.mockResolvedValue("unknown");
    const { container } = render(<ShareLook docId="doc-1" />);
    await waitFor(() => expect(docLookState).toHaveBeenCalledWith("doc-1"));
    expect(container.innerHTML).toBe("");
  });

  it("pins the theme and the Markdown style in use", async () => {
    applyMarkdownStyleChoice("editorial");
    docLookState.mockResolvedValue({ pinned: false, look: null });
    render(<ShareLook docId="doc-1" />);
    const toggle = await screen.findByRole("switch", { name: "Readers see my look" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Markie theme, Editorial style/)).toBeTruthy();
    docLookState.mockResolvedValue({ pinned: true, look: { tokens: MARKIE_DARK.tokens, style: { base: "editorial", name: "Editorial" } } });
    fireEvent.click(toggle);
    await waitFor(() => expect(setDocLook).toHaveBeenCalledWith("doc-1", { tokens: MARKIE_DARK.tokens, style: { base: "editorial", name: "Editorial" } }));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("On: Markie theme, Editorial style.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("says when the owner's look has moved on, and updates the pin", async () => {
    applyMarkdownStyleChoice("compact");
    docLookState.mockResolvedValue({ pinned: true, look: { tokens: MARKIE_DARK.tokens, style: { base: "editorial" } } });
    render(<ShareLook docId="doc-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    await waitFor(() => expect(setDocLook).toHaveBeenCalledWith("doc-1", { tokens: MARKIE_DARK.tokens, style: { base: "compact", name: "Compact" } }));
  });

  it("unpins, and says so when the server would not take the change", async () => {
    docLookState.mockResolvedValue({ pinned: true, look: { tokens: MARKIE_DARK.tokens, style: null } });
    setDocLook.mockResolvedValue(false);
    render(<ShareLook docId="doc-1" />);
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(setDocLook).toHaveBeenCalledWith("doc-1", null));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
