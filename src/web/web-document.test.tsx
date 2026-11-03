import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The web editor around a cloud document: its pictures are read where the
// read view reads them, the Share dialog warns only about files Markie Cloud
// does not hold, and on a phone-width screen what doesn't fit the bar is in
// the "…" menu rather than off the page.
const API = "https://docs.example.test";

const cloud = vi.hoisted(() => ({ openTextDoc: vi.fn(), openPlatformDoc: vi.fn(), missingDocAssets: vi.fn() }));
vi.mock("./cloud", async (original) => ({ ...(await original<typeof import("./cloud")>()), ...cloud }));

const shareProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("@/components/share-dialog", () => ({
  ShareDialog: (props: Record<string, unknown>) => { shareProps.last = props; return <div role="dialog" aria-label="Share" />; },
}));
vi.mock("@/components/rich-view", () => ({ RichView: () => <div data-rich-stub /> }));
vi.mock("@/components/doc-toolbar", () => ({ DocToolbar: () => null }));
vi.mock("@/components/section-rail", () => ({ RichSectionRail: () => null }));
vi.mock("@/lib/use-rich-safety", () => ({
  useRichSafety: () => ({ assess: () => {}, armed: true, blocked: false, preparing: false, risks: [], override: () => {} }),
}));

const { resolveAssetSrc } = await import("@/lib/asset-url");
const auth = await import("@/lib/auth-client");
const { WebDocument } = await import("./web-document");

const USER = { id: "u1", email: "owner@example.test", name: "Owner" };
const MD = "# Report\n\n![Chart](img/chart.png)\n\n![Gone](img/gone.png)\n";

beforeEach(() => {
  auth.startWebSession(API, "tok_abcdefghijklmnop");
  vi.spyOn(auth.sharesClient, "list").mockResolvedValue([]);
  cloud.openTextDoc.mockResolvedValue({ store: "docs", id: "doc-1", name: "Report.md", content: MD, version: 2, role: "owner" });
  cloud.missingDocAssets.mockResolvedValue(["img/gone.png"]);
  shareProps.last = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function open(extra: Partial<React.ComponentProps<typeof WebDocument>> = {}) {
  return render(<WebDocument id="doc-1" user={USER} onLibrary={() => {}} onOpen={() => {}} onSessionEnded={() => {}} onView={() => {}} onHideBar={() => {}} {...extra} />);
}

describe("the web editor", () => {
  it("resolves the document's own pictures through its asset route, and stops when it closes", async () => {
    const { unmount } = open();
    await screen.findByText("Report.md");
    // Not /app/d/doc-1/img/chart.png, which is what the page's own address made of it.
    expect(resolveAssetSrc("img/chart.png")).toBe(`${API}/d/doc-1/assets?ref=${encodeURIComponent("img/chart.png")}`);
    unmount();
    expect(resolveAssetSrc("img/chart.png")).toBe("img/chart.png");
  });

  it("warns in Share only about the files Markie Cloud doesn't hold", async () => {
    open();
    await screen.findByText("Report.md");
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(shareProps.last?.missingCloudFiles).toBe(1));
    expect(cloud.missingDocAssets).toHaveBeenCalledWith("doc-1", ["img/chart.png", "img/gone.png"]);
    expect(shareProps.last?.body).toBeUndefined();
  });

  it("keeps Rich and Source and Hide reachable from the menu on a narrow screen", async () => {
    const onHideBar = vi.fn();
    open({ onHideBar });
    await screen.findByText("Report.md");
    // The bar's own copies are hidden below the sm breakpoint...
    expect(screen.getByRole("group", { name: "View" }).className).toMatch(/\bhidden\b.*\bsm:flex\b/);
    expect(document.querySelector("[data-web-bar-hide]")?.className).toMatch(/\bhidden\b.*\bsm:flex\b/);
    // ...and the menu carries them there, and only there.
    fireEvent.click(screen.getByRole("button", { name: "Document menu" }));
    const menu = screen.getByRole("menu");
    const source = within(menu).getByRole("menuitemradio", { name: "Source" });
    expect(source.className).toMatch(/\bsm:hidden\b/);
    expect(within(menu).getByRole("menuitemradio", { name: /Rich view/ }).getAttribute("aria-checked")).toBe("true");
    act(() => { fireEvent.click(source); });
    expect(screen.getByRole("button", { name: "Source", pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Document menu" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Hide the bar" }));
    expect(onHideBar).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to edit on a Word, RTF or ODT file Markie keeps read-only", async () => {
    cloud.openTextDoc.mockResolvedValue(null);
    cloud.openPlatformDoc.mockResolvedValue({ name: "Table.rtf", version: 1, role: "owner", bytes: new TextEncoder().encode(String.raw`{\rtf1\ansi A\cell B\cell\row}`) });
    open();
    await screen.findByText("Table.rtf");
    expect(document.querySelector('[data-web-save-state="readonly"]')?.textContent).toBe("View only");
    fireEvent.click(screen.getByRole("button", { name: "Document menu" }));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Rename…" })).toBeNull();
  });
});
