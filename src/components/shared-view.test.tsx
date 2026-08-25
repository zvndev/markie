import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem } from "@/lib/electron";
import type { SharedByMeDoc } from "@/lib/auth-client";

const sharedByMe = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  sharesClient: { sharedByMe: () => sharedByMe() },
}));

import { SharedView } from "./shared-view";

const item = (o: Partial<LibraryItem> = {}): LibraryItem =>
  ({
    kind: "shared",
    path: null,
    name: "plan.md",
    cloudId: "c1",
    state: "cloud-only",
    lastOpenedAt: null,
    remoteVersion: 2,
    exists: false,
    shared: true,
    ...o,
  }) as LibraryItem;

const doc = (o: Partial<SharedByMeDoc> = {}): SharedByMeDoc => ({
  id: "d1",
  name: "brief.md",
  updated_at: "2026-01-01",
  memberCount: 1,
  pendingCount: 0,
  ...o,
});

function renderView(
  props: Partial<React.ComponentProps<typeof SharedView>> = {}
) {
  const onManage = vi.fn();
  const view = render(
    <SharedView
      sharedWithMe={[]}
      withMeLoading={false}
      renderRow={(i) => <div key={i.name} data-testid="row">{i.name}</div>}
      signedIn
      onManage={onManage}
      refreshKey={0}
      {...props}
    />
  );
  return { onManage, view };
}

beforeEach(() => {
  localStorage.clear();
  sharedByMe.mockReset();
  sharedByMe.mockResolvedValue([]);
});

describe("SharedView — shared with me", () => {
  it("shows a skeleton while the library is still loading", () => {
    renderView({ withMeLoading: true });
    expect(screen.getByText("Loading shared documents")).toBeInTheDocument();
  });

  it("renders one row per doc once they arrive", () => {
    renderView({ sharedWithMe: [item(), item({ name: "spec.md", cloudId: "c2" })] });
    expect(screen.getAllByTestId("row")).toHaveLength(2);
    expect(screen.queryByText("Loading shared documents")).not.toBeInTheDocument();
  });

  it("says the list is empty rather than leaving a blank panel", () => {
    renderView();
    expect(screen.getByText("Nothing shared with you yet")).toBeInTheDocument();
  });

  it("asks a signed-out user to sign in instead of claiming nothing is shared", () => {
    renderView({ signedIn: false });
    expect(screen.getByText("Sign in to see shared docs")).toBeInTheDocument();
  });
});

describe("SharedView — shared by me", () => {
  it("switches tabs and remembers the choice", async () => {
    sharedByMe.mockResolvedValue([doc()]);
    const { view } = renderView();
    await userEvent.click(screen.getByRole("button", { name: "Shared by me" }));
    expect(await screen.findByText("brief.md")).toBeInTheDocument();
    expect(localStorage.getItem("markie.sharedtab.v1")).toBe("by-me");
    view.unmount();
    renderView();
    expect(await screen.findByText("brief.md")).toBeInTheDocument();
  });

  it("counts the people on each doc and opens the manage dialog", async () => {
    sharedByMe.mockResolvedValue([doc({ memberCount: 2, pendingCount: 1 })]);
    const { onManage } = renderView();
    await userEvent.click(screen.getByRole("button", { name: "Shared by me" }));
    const row = await screen.findByTitle("Manage who can access brief.md");
    expect(screen.getByText("2 people · 1 invited")).toBeInTheDocument();
    await userEvent.click(row);
    expect(onManage).toHaveBeenCalledExactlyOnceWith("d1", "brief.md");
  });

  it("shows a skeleton until the request answers", async () => {
    let settle: (docs: SharedByMeDoc[]) => void = () => {};
    sharedByMe.mockReturnValue(new Promise<SharedByMeDoc[]>((r) => (settle = r)));
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Shared by me" }));
    expect(screen.getByText("Loading documents you've shared")).toBeInTheDocument();
    settle([doc()]);
    expect(await screen.findByText("brief.md")).toBeInTheDocument();
  });

  it("says you have shared nothing when the account really is empty", async () => {
    sharedByMe.mockResolvedValue([]);
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Shared by me" }));
    expect(await screen.findByText("You haven't shared anything yet")).toBeInTheDocument();
  });

  it("distinguishes a failed request from an empty account, and retries", async () => {
    // null is the client's "the request failed" answer.
    sharedByMe.mockResolvedValue(null);
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Shared by me" }));
    expect(await screen.findByText("Couldn't load your shared docs")).toBeInTheDocument();
    expect(screen.queryByText("You haven't shared anything yet")).not.toBeInTheDocument();
    const before = sharedByMe.mock.calls.length;

    sharedByMe.mockResolvedValue([doc()]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("brief.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(sharedByMe.mock.calls.length).toBeGreaterThan(before)
    );
  });

  it("treats a rejected request as a failure too", async () => {
    sharedByMe.mockRejectedValue(new Error("offline"));
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Shared by me" }));
    expect(await screen.findByText("Couldn't load your shared docs")).toBeInTheDocument();
  });

  it("asks a signed-out user to sign in and makes no request", async () => {
    renderView({ signedIn: false });
    await userEvent.click(screen.getByRole("button", { name: "Shared by me" }));
    expect(screen.getByText("Sign in to manage sharing")).toBeInTheDocument();
    expect(sharedByMe).not.toHaveBeenCalled();
  });
});
