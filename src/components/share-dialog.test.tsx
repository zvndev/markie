import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareAccess, ShareContact, ShareMember } from "@/lib/auth-client";
import { installBridge } from "@/test/mock-bridge";

const me = vi.fn();
const access = vi.fn();
const list = vi.fn();
const contacts = vi.fn();
const getPublicLink = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const createPublicLink = vi.fn();
const revokePublicLink = vi.fn();

vi.mock("@/lib/auth-client", () => {
  const client = {
    access: (...a: unknown[]) => access(...a),
    list: (...a: unknown[]) => list(...a),
    contacts: (...a: unknown[]) => contacts(...a),
    getPublicLink: (...a: unknown[]) => getPublicLink(...a),
    add: (...a: unknown[]) => add(...a),
    remove: (...a: unknown[]) => remove(...a),
    createPublicLink: (...a: unknown[]) => createPublicLink(...a),
    revokePublicLink: (...a: unknown[]) => revokePublicLink(...a),
  };
  return {
    authClient: { me: () => me() },
    getServerURL: () => "https://api.markie.test",
    sharesClient: client,
    // Another server's client: the same calls, so one set of mocks answers both.
    makeSharesClient: () => client,
  };
});

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

const CONTACTS: ShareContact[] = [
  { email: "alan@markie.app", name: "Alan Turing" },
  { email: "alice@example.com", name: null },
  { email: "grace@markie.app", name: "Grace Hopper" },
];

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

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

const field = () => screen.findByRole("combobox", { name: "Add people by email" });

beforeEach(() => {
  installBridge();
  me.mockResolvedValue({ id: "u1", name: "Ada Lovelace", email: "ada@markie.app" });
  access.mockResolvedValue(OWNER);
  list.mockResolvedValue([]);
  contacts.mockResolvedValue(CONTACTS);
  getPublicLink.mockResolvedValue(null);
  add.mockResolvedValue({ ok: true, status: "member" });
  remove.mockResolvedValue(true);
  createPublicLink.mockResolvedValue("https://markie.app/s/tok");
  revokePublicLink.mockResolvedValue(true);
});

describe("ShareDialog", () => {
  it("opens like Docs: title, add field, owner, Restricted, Copy link and Done", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: 'Share "notes.md"' });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await field()).toHaveAttribute("placeholder", "Add people by email");
    expect(await screen.findByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace (you)")).toBeInTheDocument();
    expect(screen.getByLabelText("General access")).toHaveValue("restricted");
    expect(
      screen.getByText("Only people with access can open with the link")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    // Gone: the access panel, the "only you" box, and the theme pin.
    expect(screen.queryByText("Your access")).toBeNull();
    expect(screen.queryByText("Only you can open this document.")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // No role or Send until there is someone to send to.
    expect(screen.queryByLabelText("Role")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
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
  });

  describe("adding people", () => {
    it("suggests people shared with before, by name or email", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.type(await field(), "al");

      const options = within(await screen.findByRole("listbox")).getAllByRole("option");
      expect(options.map((o) => o.textContent)).toEqual([
        "ATAlan Turingalan@markie.app",
        "AEalice@example.com",
      ]);
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("never suggests someone who already has access", async () => {
      const user = userEvent.setup();
      list.mockResolvedValue([member()]);
      renderDialog();
      await screen.findByText("Grace Hopper");
      await user.type(await field(), "grace");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("moves through suggestions with the arrow keys and picks one with Enter", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.type(await field(), "al");
      await screen.findByRole("listbox");

      await user.keyboard("{ArrowDown}");
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
      await user.keyboard("{ArrowDown}");
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
      await user.keyboard("{ArrowUp}{Enter}");

      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(await field()).toHaveValue("");
      // A pending address brings out the role and Send, like Docs.
      expect(screen.getByLabelText("Role")).toHaveValue("viewer");
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });

    it("picks a suggestion with the mouse", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.type(await field(), "turing");
      await user.click(await screen.findByRole("option", { name: /Alan Turing/ }));
      expect(screen.getByRole("button", { name: "Don't add alan@markie.app" })).toBeInTheDocument();
    });

    it("closes the suggestions on Escape without closing the dialog", async () => {
      const user = userEvent.setup();
      const { onClose } = renderDialog();
      await user.type(await field(), "al");
      await screen.findByRole("listbox");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("invites a typed address with the chosen role and reports what happens next", async () => {
      const user = userEvent.setup();
      add.mockResolvedValue({ ok: true, status: "invited" });
      const { onChanged } = renderDialog();

      await user.type(await field(), "  New@Markie.app{Enter}");
      await user.selectOptions(screen.getByLabelText("Role"), "editor");
      await user.click(screen.getByRole("button", { name: "Send" }));

      expect(add).toHaveBeenCalledWith("doc-1", "new@markie.app", "editor");
      expect(await screen.findByText(/Invited new@markie.app/)).toBeInTheDocument();
      expect(onChanged).toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    });

    it("sends an address still in the field without pressing Enter first", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.type(await field(), "bob@markie.app");
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(add).toHaveBeenCalledWith("doc-1", "bob@markie.app", "viewer");
      expect(await screen.findByText("Shared with bob@markie.app.")).toBeInTheDocument();
    });

    it("refuses something that is not an email", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.type(await field(), "bob{Enter}");
      expect(await screen.findByText('"bob" is not an email address.')).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    });

    it("surfaces an invite failure and keeps the address to try again", async () => {
      const user = userEvent.setup();
      add.mockResolvedValue({ ok: false, error: "That address bounced." });
      renderDialog();

      await user.type(await field(), "alan@markie.app{Enter}");
      await user.click(screen.getByRole("button", { name: "Send" }));

      expect(await screen.findByText("That address bounced.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Don't add alan@markie.app" })).toBeInTheDocument();
    });
  });

  it("changes a member's role and removes them from the same menu", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([member()]);
    const { onChanged } = renderDialog();

    await user.selectOptions(
      await screen.findByLabelText("What Grace Hopper can do"),
      "editor"
    );
    expect(add).toHaveBeenCalledWith("doc-1", "grace@markie.app", "editor");

    await user.selectOptions(screen.getByLabelText("What Grace Hopper can do"), "remove");
    expect(remove).toHaveBeenCalledWith("doc-1", "u2");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("removes a pending invite by its email", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([
      member({ user_id: null, email: "alan@markie.app", name: null, pending: true }),
    ]);
    renderDialog();
    await user.selectOptions(
      await screen.findByLabelText("What alan@markie.app can do"),
      "remove"
    );
    expect(remove).toHaveBeenCalledWith("doc-1", "alan@markie.app");
  });

  describe("general access", () => {
    it("publishes in one step when set to Anyone with the link", async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.selectOptions(await screen.findByLabelText("General access"), "link");
      expect(createPublicLink).toHaveBeenCalledWith("doc-1");
      expect(
        await screen.findByText(/Anyone on the internet with the link can view/)
      ).toBeInTheDocument();
      expect(screen.getByLabelText("General access")).toHaveValue("link");
      // No confirmation box in the way.
      expect(screen.queryByRole("button", { name: "Publish it" })).toBeNull();
    });

    it("reports a failed publish instead of pretending it worked", async () => {
      const user = userEvent.setup();
      createPublicLink.mockResolvedValue(null);
      renderDialog();

      await user.selectOptions(await screen.findByLabelText("General access"), "link");
      expect(
        await screen.findByText("Couldn't turn on the link. Check your connection and try again.")
      ).toBeInTheDocument();
      expect(screen.getByLabelText("General access")).toHaveValue("restricted");
    });

    it("revokes the link when set back to Restricted", async () => {
      const user = userEvent.setup();
      getPublicLink.mockResolvedValue("https://markie.app/s/tok");
      renderDialog();

      await waitFor(() => expect(screen.getByLabelText("General access")).toHaveValue("link"));
      await user.selectOptions(screen.getByLabelText("General access"), "restricted");
      expect(revokePublicLink).toHaveBeenCalledWith("doc-1");
      await waitFor(() =>
        expect(screen.getByLabelText("General access")).toHaveValue("restricted")
      );
    });

    it("opens the public page through the desktop bridge", async () => {
      const user = userEvent.setup();
      getPublicLink.mockResolvedValue("https://markie.app/s/tok");
      const bridge = installBridge();
      renderDialog();

      await user.click(await screen.findByRole("button", { name: "See what a stranger sees" }));
      expect(bridge.openExternal).toHaveBeenCalledWith("https://markie.app/s/tok");
    });
  });

  describe("Copy link", () => {
    it("copies the private document link while Restricted", async () => {
      const user = userEvent.setup();
      const writeText = stubClipboard();
      renderDialog();

      await user.click(screen.getByRole("button", { name: "Copy link" }));
      expect(writeText).toHaveBeenCalledWith("https://api.markie.test/d/doc-1");
      expect(await screen.findByRole("button", { name: "Link copied" })).toBeInTheDocument();
    });

    it("copies the public link once anyone with the link can view", async () => {
      const user = userEvent.setup();
      getPublicLink.mockResolvedValue("https://markie.app/s/tok");
      const writeText = stubClipboard();
      renderDialog();

      await waitFor(() => expect(screen.getByLabelText("General access")).toHaveValue("link"));
      await user.click(screen.getByRole("button", { name: "Copy link" }));
      expect(writeText).toHaveBeenCalledWith("https://markie.app/s/tok");
    });

    it("builds the private link on the document's own server", async () => {
      const user = userEvent.setup();
      const writeText = stubClipboard();
      renderDialog({ server: "https://docs.example.org/" });

      await user.click(screen.getByRole("button", { name: "Copy link" }));
      expect(writeText).toHaveBeenCalledWith("https://docs.example.org/d/doc-1");
    });
  });

  it("shows a viewer the people read-only, with Copy link and no invite field", async () => {
    access.mockResolvedValue(VIEWER);
    list.mockResolvedValue([member()]);
    renderDialog();

    expect(await screen.findByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Add people by email" })).toBeNull();
    expect(screen.queryByLabelText("General access")).toBeNull();
    expect(screen.queryByLabelText("What Grace Hopper can do")).toBeNull();
    expect(screen.getByText("Restricted")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Viewer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(contacts).not.toHaveBeenCalled();
  });

  it("says access could not be loaded rather than guessing", async () => {
    access.mockResolvedValue(null);
    renderDialog();
    expect(
      await screen.findByText(
        /Access details could not be loaded. Sign in again or check your connection/
      )
    ).toBeInTheDocument();
  });

  it("closes on Escape, the × button, Done, and the scrim", async () => {
    const user = userEvent.setup();
    const { container, onClose } = renderDialog();
    await screen.findByText("Owner");
    // Focus starts in the field; an empty field lets Escape through.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close share dialog" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(3);
    await user.click(container.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});

describe("files that will not travel", () => {
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
