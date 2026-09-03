import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareAccess, ShareMember } from "@/lib/auth-client";
import { installBridge } from "@/test/mock-bridge";

const me = vi.fn();
const access = vi.fn();
const list = vi.fn();
const getPublicLink = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const createPublicLink = vi.fn();
const revokePublicLink = vi.fn();

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: () => me() },
  sharesClient: {
    access: (...a: unknown[]) => access(...a),
    list: (...a: unknown[]) => list(...a),
    getPublicLink: (...a: unknown[]) => getPublicLink(...a),
    add: (...a: unknown[]) => add(...a),
    remove: (...a: unknown[]) => remove(...a),
    createPublicLink: (...a: unknown[]) => createPublicLink(...a),
    revokePublicLink: (...a: unknown[]) => revokePublicLink(...a),
  },
}));

const getDocTheme = vi.fn();
const setDocTheme = vi.fn();
vi.mock("@/lib/theme-sync", () => ({
  getDocTheme: (...a: unknown[]) => getDocTheme(...a),
  setDocTheme: (...a: unknown[]) => setDocTheme(...a),
}));

import { ShareDialog } from "./share-dialog";

const OWNER: ShareAccess = { role: "owner", canRead: true, canEdit: true, canManage: true };
const VIEWER: ShareAccess = { role: "viewer", canRead: true, canEdit: false, canManage: false };

const member = (o: Partial<ShareMember> = {}): ShareMember => ({
  user_id: "u2",
  role: "viewer",
  created_at: "2026-01-01",
  email: "grace@markie.app",
  name: "Grace Hopper",
  ...o,
});

function renderDialog(props: Partial<React.ComponentProps<typeof ShareDialog>> = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const view = render(
    <ShareDialog
      docId="doc-1"
      fileName="notes.md"
      onClose={onClose}
      onChanged={onChanged}
      {...props}
    />
  );
  return { ...view, onClose, onChanged };
}

beforeEach(() => {
  installBridge();
  me.mockResolvedValue({ id: "u1", name: "Ada Lovelace", email: "ada@markie.app" });
  access.mockResolvedValue(OWNER);
  list.mockResolvedValue([]);
  getPublicLink.mockResolvedValue(null);
  getDocTheme.mockResolvedValue(null);
  setDocTheme.mockResolvedValue(true);
  add.mockResolvedValue({ ok: true, status: "shared" });
  remove.mockResolvedValue(true);
  createPublicLink.mockResolvedValue("https://markie.app/s/tok");
  revokePublicLink.mockResolvedValue(true);
});

describe("ShareDialog", () => {
  it("shows the owner's access and a private, unshared document", async () => {
    renderDialog();
    // "Your access" summary, plus the owner's own row in the member list
    expect(await screen.findAllByText("Owner")).toHaveLength(2);
    expect(screen.getByRole("dialog", { name: "Share" })).toHaveAttribute(
      "aria-modal",
      "true"
    );
    expect(
      await screen.findByText("Only you can open this document.")
    ).toBeInTheDocument();
    expect(screen.getByText("Not shared with anyone yet.")).toBeInTheDocument();
    expect(
      document.querySelector('[data-markie-access-line][data-public="false"]')
    ).not.toBeNull();
  });

  it("names everyone with access, and marks a pending invite as not joined", async () => {
    list.mockResolvedValue([
      member(),
      member({ user_id: null, email: "alan@markie.app", name: null, pending: true }),
    ]);
    renderDialog();

    expect(await screen.findByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.getByText("grace@markie.app")).toBeInTheDocument();
    expect(screen.getByText("alan@markie.app")).toBeInTheDocument();
    expect(screen.getByText("Invited, not joined yet")).toBeInTheDocument();
    expect(
      screen.getByText("Only you and 1 person and 1 invited can open this document.")
    ).toBeInTheDocument();
  });

  it("invites someone and reports what happens next", async () => {
    const user = userEvent.setup();
    add.mockResolvedValue({ ok: true, status: "invited" });
    const { onChanged } = renderDialog();

    await user.type(
      await screen.findByPlaceholderText("person@example.com"),
      "  Alan@Markie.app  "
    );
    await user.selectOptions(screen.getByLabelText("Role"), "editor");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(add).toHaveBeenCalledWith("doc-1", "alan@markie.app", "editor");
    expect(
      await screen.findByText(/Invited alan@markie.app/)
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByPlaceholderText("person@example.com")).toHaveValue("");
  });

  it("surfaces an invite failure and keeps the typed address", async () => {
    const user = userEvent.setup();
    add.mockResolvedValue({ ok: false, error: "That address bounced." });
    renderDialog();

    await user.type(
      await screen.findByPlaceholderText("person@example.com"),
      "alan@markie.app"
    );
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(await screen.findByText("That address bounced.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("person@example.com")).toHaveValue(
      "alan@markie.app"
    );
  });

  it("keeps Invite disabled until there is an address", async () => {
    renderDialog();
    expect(await screen.findByRole("button", { name: "Invite" })).toBeDisabled();
  });

  it("changes a member's role and removes them", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([member()]);
    const { onChanged } = renderDialog();

    await user.selectOptions(
      await screen.findByLabelText("What Grace Hopper can do"),
      "editor"
    );
    expect(add).toHaveBeenCalledWith("doc-1", "grace@markie.app", "editor");

    await user.click(screen.getByRole("button", { name: "Remove Grace Hopper" }));
    expect(remove).toHaveBeenCalledWith("doc-1", "u2");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("removes a pending invite by its email", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([
      member({ user_id: null, email: "alan@markie.app", name: null, pending: true }),
    ]);
    renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Remove alan@markie.app" })
    );
    expect(remove).toHaveBeenCalledWith("doc-1", "alan@markie.app");
  });

  it("asks before publishing, and only publishes on confirmation", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(
      await screen.findByLabelText("General access"),
      "link"
    );
    expect(createPublicLink).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Anyone who gets the link will be able to read “notes.md”/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep it private" }));
    expect(createPublicLink).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText("General access"), "link");
    await user.click(screen.getByRole("button", { name: "Publish it" }));
    expect(createPublicLink).toHaveBeenCalledWith("doc-1");

    expect(await screen.findByLabelText("Public link")).toHaveValue(
      "https://markie.app/s/tok"
    );
    expect(
      screen.getByText(
        "Anyone on the internet with the link can read this document, without signing in."
      )
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-markie-access-line][data-public="true"]')
    ).not.toBeNull();
  });

  it("reports a failed publish instead of pretending it worked", async () => {
    const user = userEvent.setup();
    createPublicLink.mockResolvedValue(null);
    renderDialog();

    await user.selectOptions(await screen.findByLabelText("General access"), "link");
    await user.click(screen.getByRole("button", { name: "Publish it" }));

    expect(
      await screen.findByText(
        "Public link unavailable — check your connection and try again."
      )
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Public link")).toBeNull();
  });

  it("revokes an existing link and warns what that breaks", async () => {
    const user = userEvent.setup();
    getPublicLink.mockResolvedValue("https://markie.app/s/tok");
    renderDialog();

    expect(
      await screen.findByText(
        "The existing link stops working immediately for everyone who has it."
      )
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("General access"), "restricted");
    expect(revokePublicLink).toHaveBeenCalledWith("doc-1");
    await waitFor(() => expect(screen.queryByLabelText("Public link")).toBeNull());
  });

  it("opens the public page through the desktop bridge", async () => {
    const user = userEvent.setup();
    getPublicLink.mockResolvedValue("https://markie.app/s/tok");
    const bridge = installBridge();
    renderDialog();

    await user.click(
      await screen.findByRole("button", { name: "See what a stranger sees ↗" })
    );
    expect(bridge.openExternal).toHaveBeenCalledWith("https://markie.app/s/tok");
  });

  it("copies the link and confirms it", async () => {
    const user = userEvent.setup();
    getPublicLink.mockResolvedValue("https://markie.app/s/tok");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("https://markie.app/s/tok");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("pins the owner's theme for viewers", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderDialog();
    const checkbox = await screen.findByRole("checkbox", { name: /Viewers see my theme/ });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    expect(setDocTheme).toHaveBeenCalledWith("doc-1", expect.objectContaining({}));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(checkbox).toBeChecked();
  });

  it("rolls the theme pin back when the server refuses", async () => {
    const user = userEvent.setup();
    setDocTheme.mockResolvedValue(false);
    renderDialog();
    const checkbox = await screen.findByRole("checkbox", { name: /Viewers see my theme/ });
    await user.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it("hides every owner-only control from a viewer", async () => {
    access.mockResolvedValue(VIEWER);
    list.mockResolvedValue([member()]);
    renderDialog();

    expect(await screen.findByText("Viewer")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("person@example.com")).toBeNull();
    expect(screen.queryByLabelText("General access")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Grace Hopper" })).toBeNull();
    expect(screen.getByText("Only the owner can create a public link.")).toBeInTheDocument();
    // the role is shown as a fact, not a control
    expect(screen.queryByLabelText("What Grace Hopper can do")).toBeNull();
    expect(
      within(screen.getByRole("dialog")).getByText("Can view")
    ).toBeInTheDocument();
  });

  it("says access could not be loaded rather than guessing", async () => {
    access.mockResolvedValue(null);
    renderDialog();
    expect(await screen.findByText("Access unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Access details could not be loaded. Sign in again or check your connection before changing sharing."
      )
    ).toBeInTheDocument();
  });

  it("closes on Escape, the × button, and the scrim", async () => {
    const user = userEvent.setup();
    const { container, onClose } = renderDialog();
    await screen.findAllByText("Owner");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close share dialog" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(container.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("files that will not travel", () => {
  beforeEach(() => {
    access.mockResolvedValue(OWNER);
    list.mockResolvedValue([]);
    getPublicLink.mockResolvedValue(null);
  });

  it("says so, and counts them, before anything is shared", async () => {
    renderDialog({ body: "![a](shot.png)\n\n[spec](spec.pdf)" });
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("2 files on this computer");
    expect(note).toHaveTextContent(/gap where they are/i);
  });

  it("reads as one file when there is one", async () => {
    renderDialog({ body: "![a](shot.png)" });
    expect(await screen.findByRole("note")).toHaveTextContent("1 file on this computer");
  });

  it("stays quiet for a document of plain words", async () => {
    renderDialog({ body: "# Title\n\nJust words." });
    await screen.findByRole("dialog");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("stays quiet when the pictures are already inlined", async () => {
    // Export folds them in, and a document that has been through it carries
    // everything it needs.
    renderDialog({ body: "![a](data:image/png;base64,AAAA)" });
    await screen.findByRole("dialog");
    expect(screen.queryByRole("note")).toBeNull();
  });
});
