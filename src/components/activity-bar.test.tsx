import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarkieUser } from "@/lib/auth-client";

// The rail reads the shared auth store; the store's own behavior is proven in
// auth-store.test.ts, so here it is just a value the test sets.
let auth: { status: "checking" | "in" | "out"; user: MarkieUser | null };
vi.mock("@/lib/auth-store", () => ({
  useAuth: () => auth,
}));

import { ActivityBar } from "./activity-bar";

function props(overrides: Partial<React.ComponentProps<typeof ActivityBar>> = {}) {
  return {
    activeView: "library" as const,
    panelOpen: true,
    onSelectView: vi.fn(),
    canFormat: true,
    onNewFile: vi.fn(),
    onAgents: vi.fn(),
    onShortcuts: vi.fn(),
    onAccount: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  auth = { status: "out", user: null };
});

describe("ActivityBar", () => {
  it("labels every rail action for screen readers", async () => {
    render(<ActivityBar {...props()} />);
    for (const label of [
      "New file (⌘N)",
      "Library: recent and projects (⌘L)",
      "Browse all markdown",
      "Shared with you",
      "Skills & agent files",
      "Formatting tools",
      "Connect an agent (MCP)",
      "Keyboard shortcuts (⌘/)",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("routes each button to its own callback", async () => {
    const user = userEvent.setup();
    const p = props();
    render(<ActivityBar {...p} />);

    await user.click(screen.getByRole("button", { name: "New file (⌘N)" }));
    expect(p.onNewFile).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Browse all markdown" }));
    expect(p.onSelectView).toHaveBeenCalledWith("browse");

    await user.click(screen.getByRole("button", { name: "Connect an agent (MCP)" }));
    expect(p.onAgents).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts (⌘/)" }));
    expect(p.onShortcuts).toHaveBeenCalledTimes(1);

    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(p.onAccount).toHaveBeenCalledTimes(1);
  });

  it("marks the open panel's view active and nothing else", () => {
    render(<ActivityBar {...props({ activeView: "shared", panelOpen: true })} />);
    const shared = screen.getByRole("button", { name: "Shared with you" });
    const library = screen.getByRole("button", { name: "Library: recent and projects (⌘L)" });
    expect(shared.classList.contains("bg-accent")).toBe(true);
    expect(library.classList.contains("bg-accent")).toBe(false);
  });

  it("shows no panel view as active while the panel is closed", () => {
    render(<ActivityBar {...props({ activeView: "shared", panelOpen: false })} />);
    expect(
      screen.getByRole("button", { name: "Shared with you" }).classList.contains("bg-accent")
    ).toBe(false);
  });

  it("keeps the formatting view active even with the panel closed", () => {
    render(<ActivityBar {...props({ activeView: "edit", panelOpen: false })} />);
    expect(
      screen.getByRole("button", { name: "Formatting tools" }).classList.contains("bg-accent")
    ).toBe(true);
  });

  it("disables formatting when there is no rich editor to act on", async () => {
    const user = userEvent.setup();
    const p = props({ canFormat: false });
    render(<ActivityBar {...p} />);
    const button = screen.getByRole("button", { name: "Formatting tools" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(p.onSelectView).not.toHaveBeenCalled();
  });

  it("shows the signed-in user's initials and account tooltip", async () => {
    auth = { status: "in", user: { id: "u1", name: "Ada Lovelace", email: "ada@markie.app" } };
    render(<ActivityBar {...props()} />);
    const account = await screen.findByRole("button", { name: "Account" });
    expect(account).toHaveAttribute("title", "Ada Lovelace (Account)");
    expect(account).toHaveTextContent("AL");
  });

  it("falls back to the email when the account has no name", async () => {
    auth = { status: "in", user: { id: "u1", name: "", email: "ada@markie.app" } };
    render(<ActivityBar {...props()} />);
    const account = await screen.findByRole("button", { name: "Account" });
    expect(account).toHaveAttribute("title", "ada@markie.app (Account)");
    expect(account).toHaveTextContent("AM");
  });

  it("follows the auth store from signed out to signed in", async () => {
    const { rerender } = render(<ActivityBar {...props()} />);
    await screen.findByRole("button", { name: "Sign in" });

    auth = { status: "in", user: { id: "u1", name: "Ada Lovelace", email: "ada@markie.app" } };
    rerender(<ActivityBar {...props()} />);
    expect(await screen.findByRole("button", { name: "Account" })).toBeInTheDocument();
  });

  it("stays on the signed-out avatar while the session is still being checked", async () => {
    auth = { status: "checking", user: null };
    render(<ActivityBar {...props()} />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("the rail's destinations", () => {
  it("has no Projects destination of its own", () => {
    // Projects used to be a full-width page reached from here. It is a tab
    // inside the Library panel now, so the rail must not offer a second door
    // to it: an unlabelled icon leading to a page nobody asked for was the
    // exact complaint.
    render(<ActivityBar {...props()} />);
    expect(screen.queryByRole("button", { name: /^Projects/ })).toBeNull();
  });

  it("points at Projects from the Library button, since that is where it lives", () => {
    render(<ActivityBar {...props()} />);
    expect(screen.getByRole("button", { name: /^Library/ })).toHaveAccessibleName(
      expect.stringContaining("projects") as unknown as string
    );
  });

  it("reads as active without a panel being open only for the pencil", () => {
    // The active rail item carries a marker bar; that is the tell, not a
    // class name a hover style also happens to contain.
    const marker = (button: HTMLElement) => button.querySelector("span.absolute");
    const { unmount } = render(
      <ActivityBar {...props({ activeView: "edit", panelOpen: false })} />
    );
    expect(marker(screen.getByRole("button", { name: /^Format/ }))).not.toBeNull();
    unmount();
    // A panel view with the panel shut is not the thing on screen.
    render(<ActivityBar {...props({ activeView: "library", panelOpen: false })} />);
    expect(marker(screen.getByRole("button", { name: /^Library/ }))).toBeNull();
  });

  it("shows each name without waiting for the browser's tooltip delay", () => {
    // The whole rail is bare icons. `title` takes about a second to appear,
    // which is long enough to click the wrong destination and be surprised by
    // where you land, so the name is drawn as a real element instead.
    render(<ActivityBar {...props()} />);
    const button = screen.getByRole("button", { name: /^Library/ });
    expect(button).not.toHaveAttribute("title");

    const tip = screen
      .getAllByRole("tooltip", { hidden: true })
      .find((el) => el.textContent?.startsWith("Library"));
    expect(tip).toBeDefined();
    expect(tip!.textContent).toContain("\u2318L");
  });

  it("names every rail destination in its tooltip", () => {
    render(<ActivityBar {...props()} />);
    const names = screen
      .getAllByRole("tooltip", { hidden: true })
      .map((el) => el.textContent?.trim() ?? "");
    for (const expected of ["New file", "Library", "Browse", "Shared", "Skills"]) {
      expect(names.some((n) => n.startsWith(expected))).toBe(true);
    }
  });

  it("keeps user-facing rail text free of em dashes", () => {
    // Kirby's rule: no em dashes in anything a reader sees rendered.
    render(<ActivityBar {...props()} />);
    const tips = screen.getAllByRole("tooltip", { hidden: true });
    expect(tips.length).toBeGreaterThan(0);
    for (const tip of tips) {
      expect(tip.textContent ?? "").not.toContain("\u2014");
    }
  });
});
