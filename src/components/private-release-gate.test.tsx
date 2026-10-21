import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateReleaseGate } from "./private-release-gate";
import { emit, installBridge } from "@/test/mock-bridge";
import { adoptAuthToken } from "@/lib/auth-client";

vi.mock("./sign-in", () => ({ SignInForm: ({ onDone, allowGoogle }: { onDone: () => void; allowGoogle?: boolean }) => <button onClick={onDone} data-google={allowGoogle === false ? "off" : "on"}>Existing Markie sign-in</button> }));
vi.mock("@/lib/auth-client", () => ({ getAuthToken: () => "synthetic-token", getServerURL: () => "https://api.markiedocs.com", pushSyncConfig: vi.fn(), adoptAuthToken: vi.fn() }));
vi.mock("@/lib/auth-store", () => ({ authStore: { refresh: vi.fn(async () => undefined) } }));
// The nonce check itself is covered in auth-state.test.ts; here only its verdict matters.
vi.mock("@/lib/auth-state", () => ({ resolveAuthDeepLink: (url: string) => url.includes("state=good")
  ? { ok: true, token: "google-token", origin: "https://api.markiedocs.com" }
  : { ok: false, reason: "no-pending-state" } }));
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
  it("offers Google and finishes its sign-in from the deep link while locked", async () => {
    const authorize = vi.fn(async () => ({ ...locked, authorized: true }));
    installBridge({ privateReleaseAuthOrigin: locked.authOrigin, privateReleaseStatus: async () => locked, privateReleaseAuthorize: authorize });
    render(<PrivateReleaseGate><p>Document shell</p></PrivateReleaseGate>);
    expect(await screen.findByRole("button", { name: "Existing Markie sign-in" })).toHaveAttribute("data-google", "on");
    emit("onDeepLink", "markie://auth?token=forged&state=bad");
    expect(adoptAuthToken).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
    emit("onDeepLink", "markie://auth?token=google-token&state=good");
    expect(await screen.findByText("Document shell")).toBeInTheDocument();
    expect(adoptAuthToken).toHaveBeenCalledWith("google-token"); expect(authorize).toHaveBeenCalledTimes(1);
  });
  it("leaves normal builds available after their native status check", async () => {
    installBridge({ privateReleaseStatus: async () => ({ ...locked, required: false, authorized: true }) });
    render(<PrivateReleaseGate><p>Normal document shell</p></PrivateReleaseGate>);
    expect(await screen.findByText("Normal document shell")).toBeInTheDocument();
  });
});
