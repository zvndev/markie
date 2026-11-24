import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The read view: a shared document opens to read, never into the editor;
// Edit is for an account that may edit; a signed-out member link shows the
// sign-in and nothing of the document; the bar goes away and comes back.
const loadDoc = vi.fn();
vi.mock("./web-document", () => ({ loadDoc: (id: string) => loadDoc(id) }));
const loadDocLinks = vi.fn();
vi.mock("./cloud", async (original) => ({ ...(await original<typeof import("./cloud")>()), loadDocLinks: (id: string) => loadDocLinks(id) }));

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
  loadDocLinks.mockReset();
  loadDocLinks.mockResolvedValue(new Map());
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
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe(`${API}/s/${TOKEN}/raw`);
    expect(fetcher.mock.calls[0][1]?.credentials).toBe("omit");
    expect(fetcher.mock.calls[1][0]).toBe(`${API}/s/${TOKEN}/links`);
    expect(fetcher.mock.calls[1][1]?.credentials).toBe("omit");
    expect(document.querySelector("[data-web-edit]")).toBeNull();
    expect(document.querySelector("[data-web-sign-in-to-edit]")).toBeNull();
  });

  it("draws a member's CSV as a read-only table", async () => {
    loadDoc.mockResolvedValue({ ...doc("viewer"), name: "Sales.csv", kind: "text", text: "region;total\r\nNord;1,5\r\nSüd;2,25\r\n" });
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    const grid = await screen.findByRole("grid");
    expect(grid.getAttribute("aria-readonly")).toBe("true");
    expect(Array.from(grid.querySelectorAll("[role=columnheader]")).map((h) => h.textContent)).toEqual(["region", "total"]);
    expect(Array.from(grid.querySelectorAll("[role=gridcell]")).map((c) => c.textContent)).toEqual(["Nord", "1,5", "Süd", "2,25"]);
    fireEvent.doubleClick(screen.getByText("Nord"));
    expect(screen.queryByRole("textbox", { name: "Edit cell" })).toBeNull();
    // The file itself is one switch away, and Export still offers it.
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(document.querySelector(".csv-table-text")?.textContent).toContain("Nord;1,5");
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("draws a public link's CSV as a table, though the server files it under markdown", async () => {
    document.head.innerHTML = '<meta name="markie-doc-name" content="prices.csv"><meta name="markie-doc-format" content="markdown">';
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      url.endsWith("/raw") ? new Response("item,price\nTea,3.50\n", { status: 200 }) : new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    render(<DocView route={{ kind: "public", token: TOKEN }} apiOrigin={API} user={null} onEdit={() => {}} />);
    const grid = await screen.findByRole("grid");
    expect(Array.from(grid.querySelectorAll("[role=gridcell]")).map((c) => c.textContent)).toEqual(["Tea", "3.50"]);
    expect(document.querySelector("[data-web-view-csv]")).toBeTruthy();
  });

  it("shows a public link to a Live Doc as gone, without reading anything", async () => {
    document.head.innerHTML = '<meta name="markie-doc-name" content="Team.wd"><meta name="markie-doc-format" content="darkmown">';
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("# source", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    render(<DocView route={{ kind: "public", token: TOKEN }} apiOrigin={API} user={null} onEdit={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-web-view-notice="gone"]')).toBeTruthy());
    expect(fetcher).not.toHaveBeenCalled();
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
    // The title is set in an effect, and React may run that a task later than
    // the commit that shows the heading: on a slow machine the heading is on
    // the page while the tab still reads "Opening document". So the title is
    // waited for, not read the moment the heading appears.
    await screen.findByRole("heading", { name: "Sign in to read this document" });
    await waitFor(() => expect(document.title).toBe("Sign in to read this · Markie"));
    cleanup();
    // Signed in, but not shared with this account: nothing says sign in.
    loadDoc.mockResolvedValue(null);
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "This account can't open this document" });
    await waitFor(() => expect(document.title).toBe("Can't open this document · Markie"));
    cleanup();
    loadDoc.mockResolvedValue(doc("owner"));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    await waitFor(() => expect(document.title).toBe("Plan.md · Markie"));
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

  it("sends a member's link to another page to that page's read view, not the Library", async () => {
    loadDoc.mockResolvedValue({ ...doc("owner"), text: "[Step 1](step-1.md) [Step 2](step%202.md#top) [Secret](secret.md) [Draft](draft.md) [Spec](spec.pdf)" });
    loadDocLinks.mockResolvedValue(new Map([["step-1.md", { href: "/d/id-1" }], ["step 2.md", { href: "/d/id-2" }], ["secret.md", { muted: true }]]));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    const step1 = await screen.findByText("Step 1");
    expect(loadDocLinks).toHaveBeenCalledWith("doc-1");
    expect(step1.getAttribute("href")).toBe("/d/id-1");
    expect(screen.getByText("Step 2").getAttribute("href")).toBe("/d/id-2");
    // Not shared with this reader, and never uploaded: no way to navigate.
    for (const [text, title] of [["Secret", "This document isn't shared with you."], ["Draft", "This page isn't in Markie Cloud, so it can't open here."]]) {
      const muted = screen.getByText(text);
      expect(muted.hasAttribute("href")).toBe(false);
      expect(muted.classList.contains("doc-link-muted")).toBe(true);
      expect(muted.getAttribute("title")).toBe(title);
    }
    // Not a document: left as written.
    expect(screen.getByText("Spec").getAttribute("href")).toBe("spec.pdf");
  });

  it("sends a public page's link to the other public page the server names", async () => {
    document.head.innerHTML = '<meta name="markie-doc-name" content="Home.md"><meta name="markie-doc-format" content="markdown">';
    const links = { links: [{ ref: "step-1.md", href: "/s/" + "c".repeat(43) }, { ref: "step-2.md", muted: true }, { ref: "evil.md", href: "https://evil.test/s/x" }] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.endsWith("/links") ? new Response(JSON.stringify(links), { status: 200 }) : new Response("[One](step-1.md) [Two](step-2.md) [Evil](evil.md)", { status: 200 })));
    render(<DocView route={{ kind: "public", token: TOKEN }} apiOrigin={API} user={null} onEdit={() => {}} />);
    const one = await screen.findByText("One");
    expect(one.getAttribute("href")).toBe("/s/" + "c".repeat(43));
    expect(screen.getByText("Two").hasAttribute("href")).toBe(false);
    // Only a path on this host is taken from the answer.
    expect(screen.getByText("Evil").hasAttribute("href")).toBe(false);
  });
});
