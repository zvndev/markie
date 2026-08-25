import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";

// The gate reads the shared auth store; its behavior is proven in
// auth-store.test.ts, so here the session is just a value the test sets.
let auth: { status: "checking" | "in" | "out"; user: unknown };
vi.mock("@/lib/auth-store", () => ({
  useAuth: () => auth,
  authStore: { refresh: vi.fn(), signOut: vi.fn() },
}));
// The gate renders the real SignInForm when signed out; its flows have their
// own suite (sign-in.test.tsx), so a stub keeps this one about the gate.
vi.mock("@/components/sign-in", () => ({
  SignInForm: ({ reason }: { reason: string }) => (
    <div data-testid="sign-in-form">reason:{reason}</div>
  ),
}));

vi.mock("@/components/share-dialog", () => ({
  ShareDialog: ({ docId, fileName }: { docId: string; fileName: string }) => (
    <div data-testid="share-dialog">
      {docId}:{fileName}
    </div>
  ),
}));

import { ShareGate } from "./share-gate";

const TOKEN_KEY = "markie.token.v1";

function props(overrides: Partial<React.ComponentProps<typeof ShareGate>> = {}) {
  return {
    filePath: "/docs/notes.md",
    fileName: "notes.md",
    content: "# hi",
    onClose: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  auth = { status: "in", user: { id: "u1", email: "a@b.c" } };
  localStorage.setItem(TOKEN_KEY, "tok");
});
afterEach(() => localStorage.clear());

describe("ShareGate", () => {
  it("asks for a saved file first", async () => {
    installBridge();
    render(<ShareGate {...props({ filePath: null })} />);
    expect(
      await screen.findByText("Save this document to a file before you share it.")
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Share this document" })).toHaveAttribute(
      "aria-modal",
      "true"
    );
  });

  it("offers the sign-in form in place when signed out", async () => {
    auth = { status: "out", user: null };
    installBridge();
    render(<ShareGate {...props()} />);

    // The form renders inside the gate — signing in re-resolves the share in
    // place instead of dropping it and bouncing through Settings.
    const form = await screen.findByTestId("sign-in-form");
    expect(form).toHaveTextContent("reason:share");
    expect(screen.getByRole("dialog", { name: "Sign in to share" })).toHaveAttribute(
      "aria-modal",
      "true"
    );
  });

  it("resolves the share once the store publishes the session", async () => {
    auth = { status: "checking", user: null };
    const registryGet = vi.fn(async () => ({ cloud_doc_id: "cloud-9" }));
    installBridge({ registryGet: registryGet as never });
    const { rerender } = render(<ShareGate {...props()} />);
    // Still checking: neither the dialog nor the sign-in form may flash.
    expect(screen.queryByTestId("sign-in-form")).toBeNull();
    expect(screen.queryByTestId("share-dialog")).toBeNull();

    auth = { status: "in", user: { id: "u1", email: "a@b.c" } };
    rerender(<ShareGate {...props()} />);
    expect(await screen.findByTestId("share-dialog")).toHaveTextContent("cloud-9:notes.md");
  });

  it("offers to sync a local-only file, then opens the real dialog", async () => {
    const user = userEvent.setup();
    const registryGet = vi
      .fn()
      .mockResolvedValueOnce({ cloud_doc_id: null })
      .mockResolvedValueOnce({ cloud_doc_id: "cloud-1" });
    const docSyncOn = vi.fn(async () => ({ ok: true }));
    installBridge({ registryGet: registryGet as never, docSyncOn });
    const p = props();
    render(<ShareGate {...p} />);

    expect(await screen.findByText(/is only on this Mac/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sync and share" }));

    expect(docSyncOn).toHaveBeenCalledWith({
      path: "/docs/notes.md",
      name: "notes.md",
      content: "# hi",
    });
    expect(p.onChanged).toHaveBeenCalled();
    expect(await screen.findByTestId("share-dialog")).toHaveTextContent(
      "cloud-1:notes.md"
    );
  });

  it("goes straight to the dialog for an already-synced file", async () => {
    installBridge({
      registryGet: vi.fn(async () => ({ cloud_doc_id: "cloud-9" })) as never,
    });
    render(<ShareGate {...props()} />);
    expect(await screen.findByTestId("share-dialog")).toHaveTextContent("cloud-9:notes.md");
  });

  it("explains a failed lookup and retries on demand", async () => {
    const user = userEvent.setup();
    const registryGet = vi
      .fn()
      .mockRejectedValueOnce(new Error("db gone"))
      .mockResolvedValueOnce({ cloud_doc_id: "cloud-2" });
    installBridge({ registryGet: registryGet as never });
    render(<ShareGate {...props()} />);

    expect(
      await screen.findByText("Couldn't check whether this file is synced. Try again.")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("share-dialog")).toBeInTheDocument();
  });

  it("surfaces a sync error from the main process", async () => {
    const user = userEvent.setup();
    installBridge({
      registryGet: vi.fn(async () => ({ cloud_doc_id: null })) as never,
      docSyncOn: vi.fn(async () => ({ error: "Server refused the push." })),
    });
    const p = props();
    render(<ShareGate {...p} />);

    await user.click(await screen.findByRole("button", { name: "Sync and share" }));
    expect(await screen.findByText("Server refused the push.")).toBeInTheDocument();
    expect(p.onChanged).not.toHaveBeenCalled();
  });

  it("surfaces a thrown sync failure", async () => {
    const user = userEvent.setup();
    installBridge({
      registryGet: vi.fn(async () => ({ cloud_doc_id: null })) as never,
      docSyncOn: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    render(<ShareGate {...props()} />);
    await user.click(await screen.findByRole("button", { name: "Sync and share" }));
    expect(
      await screen.findByText(
        "Couldn't sync this file. Check your connection and try again."
      )
    ).toBeInTheDocument();
  });

  it("says so when the window has no bridge at all", async () => {
    installBridge({ registryGet: undefined as never });
    render(<ShareGate {...props()} />);
    expect(
      await screen.findByText("Sharing isn't available in this window.")
    ).toBeInTheDocument();
  });

  it("closes on Escape, the × button, and a click on the scrim", async () => {
    const user = userEvent.setup();
    installBridge({
      registryGet: vi.fn(async () => ({ cloud_doc_id: null })) as never,
    });
    const p = props();
    const { container } = render(<ShareGate {...p} />);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(p.onClose).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(p.onClose).toHaveBeenCalledTimes(2);

    await user.click(container.firstElementChild as HTMLElement);
    expect(p.onClose).toHaveBeenCalledTimes(3);
  });
});
