import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateReleaseGate } from "./private-release-gate";
import { installBridge } from "@/test/mock-bridge";

vi.mock("./sign-in", () => ({ SignInForm: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>Existing Markie sign-in</button> }));
vi.mock("@/lib/auth-client", () => ({ getAuthToken: () => "synthetic-token", pushSyncConfig: vi.fn(), adoptAuthToken: vi.fn() }));
afterEach(cleanup);
const locked = { required: true, authorized: false, channel: "super-nightly", gitCommit: "abcdef0123456789", authOrigin: "https://api.markiedocs.com" };
describe("private renderer bootstrap gate", () => {
  it("does not mount a document shell until native authorization succeeds", async () => {
    const authorize = vi.fn(async () => ({ ...locked, authorized: true }));
    installBridge({ privateReleaseAuthOrigin: locked.authOrigin, privateReleaseStatus: async () => locked, privateReleaseAuthorize: authorize });
    render(<PrivateReleaseGate><p>Document shell</p></PrivateReleaseGate>);
    expect(screen.queryByText("Document shell")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Authorize this build" }));
    expect(await screen.findByText("Document shell")).toBeInTheDocument(); expect(authorize).toHaveBeenCalledWith("synthetic-token");
  });
  it("keeps unauthorized/offline accounts outside the shell and reuses existing login", async () => {
    installBridge({ privateReleaseAuthOrigin: locked.authOrigin, privateReleaseStatus: async () => locked, privateReleaseAuthorize: async () => locked });
    render(<PrivateReleaseGate><p>Document shell</p></PrivateReleaseGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Existing Markie sign-in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized"); expect(screen.queryByText("Document shell")).toBeNull();
  });
  it("leaves normal builds available after their native status check", async () => {
    installBridge({ privateReleaseStatus: async () => ({ ...locked, required: false, authorized: true }) });
    render(<PrivateReleaseGate><p>Normal document shell</p></PrivateReleaseGate>);
    expect(await screen.findByText("Normal document shell")).toBeInTheDocument();
  });
});
