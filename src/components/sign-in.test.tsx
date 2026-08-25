import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";

const me = vi.fn();
const signInEmail = vi.fn();
const signUpEmail = vi.fn();
const sendOTP = vi.fn();
const verifyOTP = vi.fn();
const requestPasswordReset = vi.fn();
const resetPassword = vi.fn();
const googleSignInURL = vi.fn();

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    me: () => me(),
    signInEmail: (...a: unknown[]) => signInEmail(...a),
    signUpEmail: (...a: unknown[]) => signUpEmail(...a),
    sendOTP: (...a: unknown[]) => sendOTP(...a),
    verifyOTP: (...a: unknown[]) => verifyOTP(...a),
    requestPasswordReset: (...a: unknown[]) => requestPasswordReset(...a),
    resetPassword: (...a: unknown[]) => resetPassword(...a),
    signOut: vi.fn(async () => undefined),
    googleSignInURL: () => googleSignInURL(),
  },
}));

import { SignInForm, SignInDialog } from "./sign-in";

const ok = { ok: true, status: 200 };

beforeEach(() => {
  installBridge();
  me.mockResolvedValue(null);
  signInEmail.mockResolvedValue(ok);
  signUpEmail.mockResolvedValue(ok);
  sendOTP.mockResolvedValue(ok);
  verifyOTP.mockResolvedValue(ok);
  requestPasswordReset.mockResolvedValue(ok);
  resetPassword.mockResolvedValue(ok);
  googleSignInURL.mockReturnValue("https://accounts.google/auth?state=n");
});

describe("SignInForm — choose view", () => {
  it("names the reason it is asking, per surface", () => {
    const { rerender } = render(<SignInForm reason="share" />);
    expect(screen.getByText("Sign in to share")).toBeInTheDocument();
    rerender(<SignInForm reason="sync" />);
    expect(screen.getByText("Sign in to sync")).toBeInTheDocument();
    rerender(<SignInForm reason="account" />);
    expect(screen.getByText("Sign in to Markie")).toBeInTheDocument();
  });

  it("opens Google sign-in through the desktop bridge", async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    render(<SignInForm reason="account" />);
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://accounts.google/auth?state=n");
  });

  it("refuses to start Google sign-in it cannot secure", async () => {
    const user = userEvent.setup();
    googleSignInURL.mockReturnValue(null);
    const bridge = installBridge();
    render(<SignInForm reason="account" />);
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(bridge.openExternal).not.toHaveBeenCalled();
    expect(
      screen.getByText("Couldn't start Google sign-in on this machine. Use an email code instead.")
    ).toBeInTheDocument();
  });
});

describe("SignInForm — email code", () => {
  it("walks through the email-code sign-in", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<SignInForm reason="account" onDone={onDone} />);

    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(sendOTP).toHaveBeenCalledWith("ada@markie.app");
    expect(await screen.findByText("ada@markie.app")).toBeInTheDocument();

    const verify = screen.getByRole("button", { name: "Verify" });
    expect(verify).toBeDisabled();
    await user.type(screen.getByPlaceholderText("6-digit code"), "123456");
    me.mockResolvedValue({ id: "u1", name: "", email: "ada@markie.app" });
    await user.click(verify);
    expect(verifyOTP).toHaveBeenCalledWith("ada@markie.app", "123456");
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("names a failed code rather than saying nothing", async () => {
    const user = userEvent.setup();
    sendOTP.mockResolvedValue({ ok: false, status: 0 });
    render(<SignInForm reason="account" />);
    await user.type(screen.getByPlaceholderText("you@work.com"), "a@b.c");
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Can't reach Markie's server. Check your connection."
    );
  });
});

describe("SignInForm — password", () => {
  const toPassword = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Use a password instead" }));
  };

  it("signs in with an email and password", async () => {
    const user = userEvent.setup();
    render(<SignInForm reason="account" />);
    await toPassword(user);

    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.type(screen.getByPlaceholderText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signInEmail).toHaveBeenCalledWith("ada@markie.app", "hunter2");
  });

  it("names the failure rather than saying nothing", async () => {
    const user = userEvent.setup();
    signInEmail.mockResolvedValue({ ok: false, status: 401 });
    render(<SignInForm reason="account" />);
    await toPassword(user);

    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.type(screen.getByPlaceholderText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That email and password don't match."
    );
  });

  it("switches to sign-up and defaults the name from the email", async () => {
    const user = userEvent.setup();
    render(<SignInForm reason="account" />);
    await toPassword(user);

    await user.click(screen.getByRole("button", { name: "New here? Create account" }));
    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.type(screen.getByPlaceholderText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(signUpEmail).toHaveBeenCalledWith("ada@markie.app", "hunter2", "ada");
  });
});

describe("SignInForm — forgotten password", () => {
  it("resets with a code and finishes signed in", async () => {
    const user = userEvent.setup();
    render(<SignInForm reason="account" />);
    await user.click(screen.getByRole("button", { name: "Use a password instead" }));
    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.click(screen.getByRole("button", { name: "Forgot?" }));

    expect(
      screen.getByText("We'll email you a code to set a new password.")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(requestPasswordReset).toHaveBeenCalledWith("ada@markie.app");

    await user.type(await screen.findByPlaceholderText("6-digit code"), "123456");
    const setBtn = screen.getByRole("button", { name: "Set password and sign in" });
    expect(setBtn).toBeDisabled(); // no new password yet
    await user.type(screen.getByPlaceholderText("New password (8+ characters)"), "longenough");
    await user.click(setBtn);

    expect(resetPassword).toHaveBeenCalledWith("ada@markie.app", "123456", "longenough");
    // The job was signing in, not just setting a password.
    expect(signInEmail).toHaveBeenCalledWith("ada@markie.app", "longenough");
  });

  it("does not reveal whether the account exists", async () => {
    const user = userEvent.setup();
    requestPasswordReset.mockResolvedValue({ ok: false, status: 404 });
    render(<SignInForm reason="account" />);
    await user.click(screen.getByRole("button", { name: "Use a password instead" }));
    await user.type(screen.getByPlaceholderText("you@work.com"), "who@knows.io");
    await user.click(screen.getByRole("button", { name: "Forgot?" }));
    await user.click(screen.getByRole("button", { name: "Send reset code" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/no such|not found|doesn't exist/i);
  });
});

describe("SignInDialog", () => {
  it("closes from the × button and names itself to screen readers", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SignInDialog reason="sync" onClose={onClose} />);
    expect(screen.getByText("Sign in to sync")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Sign in to Markie" })).toHaveAttribute(
      "aria-modal",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
