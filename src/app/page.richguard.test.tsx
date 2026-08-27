import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

import Home from "./page";

// Reference-link definitions are consumed by the parser; with an intervening
// block the pipeline cannot reconstruct them, so this document must gate.
const GATED = {
  name: "refs.md",
  path: "/notes/refs.md",
  content:
    "See [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n",
};
// Footnotes and wrapped prose are pipeline-safe now (layers 1 and 2); this
// document must NOT gate.
const CLEAN = {
  name: "notes.md",
  path: "/notes/notes.md",
  content: "Wrapped\nprose.[^1]\n\n[^1]: the note\n",
};

const guard = () => document.querySelector("[data-markie-rich-guard]");
// The component publishes the live editor for automation; the banner is only
// worth anything if the editor behind it is actually locked.
const richEditable = () =>
  (window as unknown as { __markieEditor?: { isEditable: boolean } | null })
    .__markieEditor?.isEditable;

beforeEach(() => {
  localStorage.clear();
});

describe("rich loss guard", () => {
  it("locks rich editing for an unreconstructable document, unlocks on override", async () => {
    installBridge({ getInitialFile: vi.fn(async () => GATED) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(guard()).not.toBeNull());
    expect(guard()!.textContent).toMatch(/rich editing is off/i);
    await waitFor(() => expect(richEditable()).toBe(false));
    await userEvent.click(
      screen.getByRole("button", { name: /edit rich anyway/i })
    );
    await waitFor(() => expect(guard()).toBeNull());
    await waitFor(() => expect(richEditable()).toBe(true));
  });

  it("remembers the override for that document across a reopen", async () => {
    installBridge({ getInitialFile: vi.fn(async () => GATED) } as Partial<ElectronAPI>);
    const first = render(<Home />);
    await waitFor(() => expect(guard()).not.toBeNull());
    await userEvent.click(
      screen.getByRole("button", { name: /edit rich anyway/i })
    );
    await waitFor(() => expect(guard()).toBeNull());
    first.unmount();

    installBridge({ getInitialFile: vi.fn(async () => GATED) } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText(/Unrelated paragraph/);
    expect(guard()).toBeNull();
  });

  it("shows no banner for a layered-safe document (footnote + wrap)", async () => {
    installBridge({ getInitialFile: vi.fn(async () => CLEAN) } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText(/prose/);
    expect(guard()).toBeNull();
    await waitFor(() => expect(richEditable()).toBe(true));
  });
});
