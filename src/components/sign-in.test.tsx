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

// Only the network surface is replaced. authFailureCode is a pure reader of a
// response body, and a test that stubbed it would stop checking that the form
// recognises the reason the server actually sends.
vi.mock("@/lib/auth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-client")>()),
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
const USER = { id: "u1", name: "Ada", email: "ada@markie.app" };
// What the server really answers a password signup with email verification on:
// the account is made, and no session comes back until the address is proven.
const UNPROVEN_SIGNUP = { ok: true, status: 200, data: { token: null, user: USER } };
const NOT_VERIFIED = {
  ok: false,
  status: 403,
  data: { message: "Email not verified", code: "EMAIL_NOT_VERIFIED" },
};

beforeEach(() => {
  installBridge();
  me.mockResolvedValue(null);
  signInEmail.mockResolvedValue(ok);
  signUpEmail.mockResolvedValue(UNPROVEN_SIGNUP);
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

  it("a wrong password is still a wrong password", async () => {
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
    // No code goes out for a failure that a code cannot fix.
    expect(sendOTP).not.toHaveBeenCalled();
  });

  it("a signup that does come back signed in goes straight through", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    signUpEmail.mockResolvedValue({ ok: true, status: 200, data: { token: "t", user: USER } });
    me.mockResolvedValue(USER);
    render(<SignInForm reason="account" onDone={onDone} />);
    await toPassword(user);
    await user.click(screen.getByRole("button", { name: "New here? Create account" }));
    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.type(screen.getByPlaceholderText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sendOTP).not.toHaveBeenCalled();
  });
});

// The server will not let an account act until the address behind it is
// proven. Neither answer it gives for that is a failure the user can read.
describe("SignInForm — an address that has not been proven", () => {
  const toPassword = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Use a password instead" }));
  };

  const signUp = async (user: ReturnType<typeof userEvent.setup>) => {
    await toPassword(user);
    await user.click(screen.getByRole("button", { name: "New here? Create account" }));
    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.type(screen.getByPlaceholderText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Create account" }));
  };

  it("sends a code when a signup comes back with no session", async () => {
    const user = userEvent.setup();
    render(<SignInForm reason="account" />);
    await signUp(user);

    await vi.waitFor(() => expect(sendOTP).toHaveBeenCalledWith("ada@markie.app"));
    expect(await screen.findByPlaceholderText("6-digit code")).toBeInTheDocument();
    expect(screen.getByText(/Prove this address is yours/)).toBeInTheDocument();
    expect(screen.getByText(/We\s+sent a code to/)).toBeInTheDocument();
  });

  it("sends a code instead of blaming the password when sign-in is refused", async () => {
    const user = userEvent.setup();
    signInEmail.mockResolvedValue(NOT_VERIFIED);
    render(<SignInForm reason="account" />);
    await toPassword(user);
    await user.type(screen.getByPlaceholderText("you@work.com"), "ada@markie.app");
    await user.type(screen.getByPlaceholderText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await vi.waitFor(() => expect(sendOTP).toHaveBeenCalledWith("ada@markie.app"));
    expect(screen.getByText(/Prove this address is yours/)).toBeInTheDocument();
    expect(screen.queryByText("That email and password don't match.")).toBeNull();
  });

  it("says the code replaces the password, because it does", async () => {
    const user = userEvent.setup();
    render(<SignInForm reason="account" />);
    await signUp(user);
    expect(await screen.findByText(/takes the place of the password you typed/)).toBeInTheDocument();
  });

  it("finishes the account when the code is entered", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<SignInForm reason="account" onDone={onDone} />);
    await signUp(user);

    await user.type(await screen.findByPlaceholderText("6-digit code"), "123456");
    me.mockResolvedValue(USER);
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(verifyOTP).toHaveBeenCalledWith("ada@markie.app", "123456");
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("a wrong code leaves the user on the code screen with a way forward", async () => {
    const user = userEvent.setup();
    verifyOTP.mockResolvedValue({ ok: false, status: 400 });
    render(<SignInForm reason="account" />);
    await signUp(user);

    await user.type(await screen.findByPlaceholderText("6-digit code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That code isn't right, or it expired. Send a new one."
    );
    // Still here, still able to ask for another one.
    expect(screen.getByPlaceholderText("6-digit code")).toBeInTheDocument();
    sendOTP.mockClear();
    await user.click(screen.getByRole("button", { name: "Resend code" }));
    expect(sendOTP).toHaveBeenCalledWith("ada@markie.app");
  });

  it("drops the explanation when the user starts over with another address", async () => {
    const user = userEvent.setup();
    render(<SignInForm reason="account" />);
    await signUp(user);
    await user.click(await screen.findByRole("button", { name: "Use a different email" }));
    await user.type(screen.getByPlaceholderText("you@work.com"), "someone@else.io");
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(await screen.findByText("Code sent to")).toBeInTheDocument();
    expect(screen.queryByText(/Prove this address is yours/)).toBeNull();
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
