import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";
import { HistoryDialog } from "@/components/history-dialog";

const ENTRIES = [
  { stamp: "2026-08-26T10-00-00.000Z", iso: "2026-08-26T10:00:00.000Z", author: "user", bytes: 20 },
  { stamp: "2026-08-26T09-00-00.000Z", iso: "2026-08-26T09:00:00.000Z", author: "external", bytes: 18 },
];

const bodies: Record<string, string> = {
  [ENTRIES[0].stamp]: "one\ntwo\nthree\n",
  [ENTRIES[1].stamp]: "one\n",
};

function open(overrides: Partial<ElectronAPI> = {}) {
  installBridge({
    historyList: vi.fn(async () => ENTRIES),
    historyRead: vi.fn(async ({ stamp }: { stamp: string }) => ({
      content: bodies[stamp] ?? null,
    })),
    ...overrides,
  } as Partial<ElectronAPI>);
}

describe("HistoryDialog", () => {
  it("lists versions with author chips and restores one", async () => {
    open();
    const onRestore = vi.fn();
    render(
      <HistoryDialog filePath="/n/a.md" fileName="a.md" onRestore={onRestore} onClose={() => {}} />
    );
    expect(await screen.findByText(/external edit/i)).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    const restores = await screen.findAllByRole("button", { name: /restore/i });
    expect(restores).toHaveLength(2);
    await waitFor(() => expect(restores[1]).toBeEnabled());
    await userEvent.click(restores[1]);
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("one\n"));
  });

  it("says how far each version is from the one before it", async () => {
    open();
    render(
      <HistoryDialog filePath="/n/a.md" fileName="a.md" onRestore={() => {}} onClose={() => {}} />
    );
    // The newest version added two lines over the one below it.
    expect(await screen.findByText(/\+2\s+-0/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no versions", async () => {
    open({ historyList: vi.fn(async () => []) } as Partial<ElectronAPI>);
    render(
      <HistoryDialog filePath="/n/a.md" fileName="a.md" onRestore={() => {}} onClose={() => {}} />
    );
    expect(await screen.findByText(/no versions yet/i)).toBeInTheDocument();
  });

  it("cannot restore a version whose bytes could not be read", async () => {
    open({ historyRead: vi.fn(async () => ({ content: null })) } as Partial<ElectronAPI>);
    const onRestore = vi.fn();
    render(
      <HistoryDialog filePath="/n/a.md" fileName="a.md" onRestore={onRestore} onClose={() => {}} />
    );
    const restores = await screen.findAllByRole("button", { name: /restore/i });
    await waitFor(() => expect(restores[0]).toBeDisabled());
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("closes on the close button and on the scrim", async () => {
    open();
    const onClose = vi.fn();
    render(
      <HistoryDialog filePath="/n/a.md" fileName="a.md" onRestore={() => {}} onClose={onClose} />
    );
    await userEvent.click(await screen.findByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
