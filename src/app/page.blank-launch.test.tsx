import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markWelcomeSeen } from "@/lib/first-run";
import { installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

import Home from "./page";

beforeEach(() => {
  localStorage.clear();
});

describe("launching with nothing to open", () => {
  // After the one-time welcome, a launch without a file used to open a
  // made-up "Northstar Sprint Brief". Nobody should ever see demo content.
  it("opens an empty page once the welcome has been seen", async () => {
    markWelcomeSeen();
    installBridge({ getInitialFile: vi.fn(async () => null) });
    const { container } = render(<Home />);
    await waitFor(() => expect(container.querySelector(".markdown-body, .cm-content")).not.toBeNull());
    expect(container.textContent).not.toMatch(/Northstar|Sprint Brief/);
  });

  it("opens an empty page when the launch file cannot be read", async () => {
    markWelcomeSeen();
    installBridge({ getInitialFile: vi.fn(async () => { throw new Error("boom"); }) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<Home />);
    await waitFor(() => expect(container.querySelector(".markdown-body, .cm-content")).not.toBeNull());
    expect(container.textContent).not.toMatch(/Northstar|Sprint Brief/);
  });
});
