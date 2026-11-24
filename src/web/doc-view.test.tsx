import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The read view: a shared document opens to read, never into the editor;
// Edit is for an account that may edit; a signed-out member link shows the
// sign-in and nothing of the document; the bar goes away and comes back.
const loadDoc = vi.fn();
vi.mock("./web-document", () => ({ loadDoc: (id: string) => loadDoc(id) }));
const loadDocLinks = vi.fn();
const loadDocLook = vi.fn();
vi.mock("./cloud", async (original) => ({
  ...(await original<typeof import("./cloud")>()),
  loadDocLinks: (id: string) => loadDocLinks(id),
  loadDocLook: (id: string) => loadDocLook(id),
}));

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
  loadDocLook.mockReset();
  loadDocLook.mockResolvedValue(null);
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
    // The text, where its links lead, and the look pinned to it: each read
    // with the link alone, never with the browser's session.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][0]).toBe(`${API}/s/${TOKEN}/raw`);
    expect(fetcher.mock.calls[0][1]?.credentials).toBe("omit");
    expect(fetcher.mock.calls.map((call) => call[0]).slice(1).sort()).toEqual([`${API}/s/${TOKEN}/links`, `${API}/s/${TOKEN}/theme`]);
    expect(fetcher.mock.calls[1][1]?.credentials).toBe("omit");
    expect(fetcher.mock.calls[2][1]?.credentials).toBe("omit");
    // The stand-in answered the look with Markdown, which is not a look: the
    // page keeps its own.
    expect(document.querySelector("[data-web-view]")?.hasAttribute("data-pinned-look")).toBe(false);
    expect(document.querySelector("[data-web-edit]")).toBeNull();
    expect(document.querySelector("[data-web-sign-in-to-edit]")).toBeNull();
  });

  const PINNED_TOKENS = { background: "#fbf8f1", surface: "#f2ede2", surface2: "#e9e2d3", foreground: "#2b2620", muted: "#5f564a", border: "#d9cfbc", accent: "#efe1c4", link: "#9a3b12" };

  it("draws a public link in the look its owner pinned, and puts the reader's own back after", async () => {
    document.head.innerHTML = '<meta name="markie-doc-name" content="Plan.md"><meta name="markie-doc-format" content="markdown">';
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.endsWith("/theme")
        ? new Response(JSON.stringify({ tokens: PINNED_TOKENS, style: { base: "minimal", choices: { tableStyle: "zebra", bulletStyle: "} body { display: none" }, numbers: { imageRadius: 1e9 } } }), { status: 200 })
        : url.endsWith("/links") ? new Response(JSON.stringify({ links: [] }), { status: 200 }) : new Response(MD, { status: 200 })));
    const view = render(<DocView route={{ kind: "public", token: TOKEN }} apiOrigin={API} user={null} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    await waitFor(() => expect(document.querySelector("[data-web-view]")?.getAttribute("data-pinned-look")).toBe("colors"));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#fbf8f1");
    // The style is drawn from a scoped stylesheet written by lookup: the
    // known choices are there, the hostile one is not, and the huge number
    // was brought into range.
    const css = document.querySelector("style[data-markie-markdown-style-scope]")?.textContent ?? "";
    expect(css).toContain("tr:nth-child(even)");
    expect(css).toContain("border-radius: 24px");
    expect(css).not.toContain("display: none");
    expect(css).not.toContain("1e9");
    view.unmount();
    expect(document.documentElement.style.getPropertyValue("--background")).not.toBe("#fbf8f1");
  });

  it("keeps a pinned style but not colours that are not plain colours", async () => {
    loadDoc.mockResolvedValue(doc("viewer"));
    const { pinnedLookFrom } = await import("@/lib/pinned-look");
    loadDocLook.mockResolvedValue(pinnedLookFrom({ tokens: { ...PINNED_TOKENS, background: "url(https://evil.test/x.png)" }, style: { base: "compact" } }));
    const before = document.documentElement.style.getPropertyValue("--background");
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    expect(document.querySelector("[data-web-view]")?.getAttribute("data-pinned-look")).toBe("style");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe(before);
    expect(document.querySelector("style[data-markie-markdown-style-scope]")?.textContent).toContain("font-size: 1.6em");
  });

  it("leaves the hosted page's own look when nothing is pinned", async () => {
    loadDoc.mockResolvedValue(doc("viewer"));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByRole("heading", { name: "Plan" });
    expect(document.querySelector("[data-web-view]")?.hasAttribute("data-pinned-look")).toBe(false);
    expect(document.querySelector("style[data-markie-markdown-style-scope]")).toBeNull();
  });

  it("draws a member's CSV as a read-only table", async () => {
    loadDoc.mockResolvedValue({ ...doc("viewer"), name: "Sales.csv", kind: "text", text: "region;total\r\nNord;1,5\r\nSüd;2,25\r\n" });
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    const grid = await screen.findByRole("grid");
    expect(grid.getAttribute("aria-readonly")).toBe("true");
    expect(Array.from(grid.querySelectorAll("[role=columnheader]")).map((h) => h.textContent)).toEqual(["region", "total"]);
    expect(Array.from(grid.querySelectorAll("[role=gridcell]")).map((c) => c.textContent)).toEqual(["Nord", "1,5", "Süd", "2,25"]);
    // The sheet opens on its first cell, and the formula bar shows it as text, not as a field.
    expect(document.querySelector(".csv-table-value")?.textContent).toBe("Nord");
    fireEvent.doubleClick(screen.getByText("Nord", { selector: "[role=gridcell]" }));
    expect(screen.queryByRole("textbox", { name: "Edit cell" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Cell contents" })).toBeNull();
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

  it("sets a document in the fonts of the look its owner pinned, bundled faces included", async () => {
    loadDoc.mockResolvedValue(doc("viewer"));
    // A look whose colours cannot be used (most are missing) still gives its type.
    const { pinnedLookFrom } = await import("@/lib/pinned-look");
    loadDocLook.mockResolvedValue(pinnedLookFrom({ tokens: { background: "#fff", bodyFont: "atkinson", headingFont: "fraunces", lineHeight: 1.9, paragraphGap: 1.1, fontSize: 99 } }));
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByText("Ship it.");
    expect(loadDocLook).toHaveBeenCalledWith("doc-1");
    const article = document.querySelector<HTMLElement>("[data-web-view-content]")!;
    expect(article.style.getPropertyValue("--doc-font-family")).toMatch(/^'Atkinson Hyperlegible Next', system-ui/);
    expect(article.style.getPropertyValue("--doc-heading-family")).toMatch(/^'Fraunces', Georgia/);
    expect(article.style.getPropertyValue("--doc-line-height")).toBe("1.9");
    expect(article.style.getPropertyValue("--doc-paragraph-gap")).toBe("1.1em");
    // Type only: the page keeps its own colours, size and width.
    expect(article.getAttribute("style")).not.toMatch(/background|--doc-font-size|--doc-width/);
  });

  it("paints a whole pinned look by one path: colours, bundled faces and the style's code face together", async () => {
    loadDoc.mockResolvedValue(doc("viewer"));
    const { pinnedLookFrom } = await import("@/lib/pinned-look");
    const { THEME_APPLIED_EVENT } = await import("@/lib/theme");
    loadDocLook.mockResolvedValue(pinnedLookFrom({
      tokens: { ...PINNED_TOKENS, bodyFont: "literata", headingFont: "eb-garamond" },
      style: { base: "technical", choices: { codeFont: "fira-code" } },
    }));
    const painted: Array<Record<string, unknown>> = [];
    const seen = (event: Event) => painted.push((event as CustomEvent<{ tokens: Record<string, unknown> }>).detail.tokens);
    window.addEventListener(THEME_APPLIED_EVENT, seen);
    const view = render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByText("Ship it.");
    await waitFor(() => expect(document.querySelector("[data-web-view]")?.getAttribute("data-pinned-look")).toBe("colors"));
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--background")).toBe("#fbf8f1");
    // The pinned tokens' own faces are what the owner had on screen, so they
    // stand; the style supplies the code face, which only it carries.
    expect(root.getPropertyValue("--doc-font-family")).toMatch(/^'Literata', Georgia/);
    expect(root.getPropertyValue("--doc-heading-family")).toMatch(/^'EB Garamond', Georgia/);
    expect(painted.at(-1)).toMatchObject({ bodyFont: "literata", headingFont: "eb-garamond", codeFont: "fira-code" });
    // Nothing is set on the document itself: the page's theme is the one path.
    expect(document.querySelector<HTMLElement>("[data-web-view-content]")!.getAttribute("style")).toBeNull();
    expect(document.querySelector("style[data-markie-markdown-style-scope]")?.textContent).not.toContain("font-family");
    window.removeEventListener(THEME_APPLIED_EVENT, seen);
    view.unmount();
  });

  it("takes a style's faces when the pinned tokens name none", async () => {
    loadDoc.mockResolvedValue(doc("viewer"));
    const { pinnedLookFrom } = await import("@/lib/pinned-look");
    loadDocLook.mockResolvedValue(pinnedLookFrom({ tokens: PINNED_TOKENS, style: { base: "editorial" } }));
    const view = render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByText("Ship it.");
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--doc-heading-family")).toMatch(/^'Playfair Display'/));
    expect(document.documentElement.style.getPropertyValue("--doc-font-family")).toMatch(/^'Source Serif 4'/);
    view.unmount();
  });

  it("paints nothing from a pinned look whose font is not a font id, and nothing when there is none", async () => {
    loadDoc.mockResolvedValue(doc("viewer"));
    const { pinnedLookFrom } = await import("@/lib/pinned-look");
    loadDocLook.mockResolvedValue(pinnedLookFrom({ tokens: { bodyFont: "x'; } body { display: none", headingFont: "local:nope:Futura", lineHeight: "url(//evil.example)" } }));
    const first = render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByText("Ship it.");
    const style = document.querySelector<HTMLElement>("[data-web-view-content]")!.getAttribute("style") ?? "";
    expect(style).not.toMatch(/evil|display|nope|Futura/);
    expect(document.querySelector<HTMLElement>("[data-web-view-content]")!.style.getPropertyValue("--doc-font-family")).toBe("var(--font-geist-sans)");
    first.unmount();
    loadDocLook.mockResolvedValue(null);
    render(<DocView route={{ kind: "member", id: "doc-1" }} apiOrigin={API} user={USER} onEdit={() => {}} />);
    await screen.findByText("Ship it.");
    expect(document.querySelector<HTMLElement>("[data-web-view-content]")!.getAttribute("style")).toBeNull();
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
