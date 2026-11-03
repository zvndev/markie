import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The read view: a shared document opens to read, never into the editor;
// Edit is for an account that may edit; a signed-out member link shows the
// sign-in and nothing of the document; the bar goes away and comes back.
const loadDoc = vi.fn();
vi.mock("./web-document", () => ({ loadDoc: (id: string) => loadDoc(id) }));

const { DocView } = await import("./doc-view");

const API = "https://api.example.test";
const USER = { id: "u1", email: "reader@example.test", name: "Reader" };
const TOKEN = "b".repeat(64);
const MD = "# Plan\n\nShip it.\n\n![Chart](data:image/png;base64,iVBORw0KGgo=)\n\n## Two\n\nMore.\n";

function doc(role: "owner" | "editor" | "viewer") {
  return { store: "docs", id: "doc-1", name: "Plan.md", version: 3, role, kind: "markdown", text: MD, textMetadata: null, office: null };
}

beforeEach(() => {
  localStorage.clear();
  loadDoc.mockReset();
  document.head.innerHTML = "";
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the read view", () => {
  it("draws a member's document with Copy all, Export and Edit for an editor", async () => {
    loadDoc.mockResolvedValue(doc("editor"));
    const onEdit = vi.fn();
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={onEdit} />);
    await screen.findByRole("heading", { name: "Plan" });
    expect(screen.getByText("Plan.md")).toBeTruthy();
    expect(document.querySelector("[data-markie-copy-all]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(onEdit).toHaveBeenCalledWith("doc-1");
  });

  it("offers a view-only member no Edit", async () => {
    loadDoc.mockResolvedValue(doc("viewer"));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    expect(document.querySelector("[data-web-edit]")).toBeNull();
  });

  it("shows a signed-out member link the sign-in, with nothing of the document", async () => {
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={null} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Sign in to read this document" });
    expect(loadDoc).not.toHaveBeenCalled();
    const edit = screen.getByRole("link", { name: "Sign in to edit" });
    expect(edit.getAttribute("href")).toBe(`${API}/auth/web-signin?next=%2Fd%2Fdoc-1`);
  });

  it("names nobody's document to an account that cannot read it", async () => {
    loadDoc.mockResolvedValue(null);
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "This account can't open this document" });
    expect(document.querySelector('[data-web-view-notice="no-access"]')?.textContent).toContain(USER.email);
    expect(document.querySelector("[data-web-view-title]")?.textContent).toBe("");
    expect(screen.getByRole("link", { name: "Sign in with a different account" }).getAttribute("href")).toContain("switch=1");
  });

  it("reads a public link with no credentials and offers no Edit to a stranger", async () => {
    document.head.innerHTML = '<meta name="markie-doc-name" content="Plan.md"><meta name="markie-doc-format" content="markdown">';
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(MD, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    render(<DocView route={{ kind: "public", token: TOKEN }} apiOrigin={API} user={null} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${API}/s/${TOKEN}/raw`);
    expect(fetcher.mock.calls[0][1]?.credentials).toBe("omit");
    expect(document.querySelector("[data-web-edit]")).toBeNull();
    expect(document.querySelector("[data-web-sign-in-to-edit]")).toBeNull();
  });

  it("puts the bar away and brings it back, remembering the choice", async () => {
    loadDoc.mockResolvedValue(doc("owner"));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    fireEvent.click(screen.getByRole("button", { name: "Hide the bar" }));
    expect(document.querySelector("[data-web-view-bar]")).toBeNull();
    expect(localStorage.getItem("markie.web.bar-hidden.view")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Show the bar" }));
    expect(document.querySelector("[data-web-view-bar]")).toBeTruthy();
    act(() => { fireEvent.keyDown(document.body, { key: "Escape" }); });
    expect(document.querySelector("[data-web-view-bar]")).toBeNull();
  });

  it("titles the tab for the state the page is in", async () => {
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={null} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Sign in to read this document" });
    expect(document.title).toBe("Sign in to read this · Markie");
    cleanup();
    // Signed in, but not shared with this account: nothing says sign in.
    loadDoc.mockResolvedValue(null);
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "This account can't open this document" });
    expect(document.title).toBe("Can't open this document · Markie");
    cleanup();
    loadDoc.mockResolvedValue(doc("owner"));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    expect(document.title).toBe("Plan.md · Markie");
  });

  it("offers no Edit for a Word, RTF or ODT file Markie keeps read-only", async () => {
    // An RTF with a table: its owner opens it, and the editor would refuse
    // every change, so the read view must not offer one.
    const office = (canEdit: boolean) => ({ ...doc("owner"), name: "Table.rtf", kind: "office", text: "A B", store: "platform",
      office: { format: "rtf", canEdit, text: "A B" } });
    loadDoc.mockResolvedValue(office(false));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-view-state="ready"]')).toBeTruthy());
    expect(document.querySelector("[data-web-edit]")).toBeNull();
    cleanup();
    loadDoc.mockResolvedValue(office(true));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-web-edit]")).toBeTruthy());
  });

  it("makes a picture a keyboard stop that opens the viewer", async () => {
    loadDoc.mockResolvedValue(doc("owner"));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    const img = await screen.findByRole("button", { name: "Enlarge picture: Chart" });
    expect(img.tabIndex).toBe(0);
    fireEvent.keyDown(img, { key: "Enter" });
    await waitFor(() => expect(document.querySelector("[data-markie-lightbox-image]")).toBeTruthy());
  });
});
