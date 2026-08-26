"use client";

// The one sign-in surface in Markie.
//
// This used to live inline in settings.tsx, which meant sign-in was a place you
// had to already know about: Share sent you to Settings and left you to work
// out why. Now the form takes a `reason`, so whatever sent you here says so at
// the top, and Settings renders the same component instead of its own copy.
//
// Method order is deliberate. Google is the smoothest path on a desktop app
// that can hand off to the system browser, an emailed code is the one that
// works for everyone, and a password is a preference rather than a default.

import { useState } from "react";
import { authClient, authFailureCode } from "@/lib/auth-client";
import { authStore } from "@/lib/auth-store";
import { authErrorMessage, signInReasonCopy, type AuthContext, type SignInReason } from "@/lib/auth-errors";
import { getElectronAPI } from "@/lib/electron";

type View = "choose" | "otp-code" | "password" | "reset-request" | "reset-verify";

interface SignInFormProps {
  reason: SignInReason;
  /** Fired once a session actually exists. */
  onDone?: () => void;
}

const FIELD = "markie-overlay-field w-full text-[13px] px-3 py-2 rounded-md";
const PRIMARY =
  "markie-overlay-button w-full text-[13px] py-2 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-50";
const SECONDARY =
  "markie-overlay-button w-full text-[13px] py-2 rounded-md border border-border text-foreground/90 hover:bg-accent/40 disabled:opacity-50";
const LINK = "text-[11px] text-muted hover:text-foreground";

export function SignInForm({ reason, onDone }: SignInFormProps) {
  const [view, setView] = useState<View>("choose");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  // True while the code on screen is proving an address rather than signing in
  // with one. Same input, same Verify, same Resend: only the copy differs, and
  // the difference matters because the user did not ask for a code this time.
  const [proving, setProving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = signInReasonCopy(reason);

  // Every request funnels through here so no call site can invent its own error
  // string or forget to clear the last one.
  const run = async (
    context: AuthContext,
    fn: () => Promise<{ ok: boolean; status: number }>
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(authErrorMessage(res.status, context));
      return false;
    }
    return true;
  };

  // A session now exists, so tell the store; every auth-aware surface in the
  // app updates from that one call.
  const landed = async () => {
    await authStore.refresh();
    onDone?.();
  };

  const startGoogle = () => {
    setError(null);
    // Null means we couldn't mint the nonce that proves the returning deep link
    // belongs to this sign-in. Starting anyway would fail at the other end with
    // nothing to explain it.
    const url = authClient.googleSignInURL();
    if (!url) {
      setError("Couldn't start Google sign-in on this machine. Use an email code instead.");
      return;
    }
    const api = getElectronAPI();
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, "_blank");
  };

  const sendCode = async () => {
    if (await run("otp-send", () => authClient.sendOTP(email))) {
      setOtp("");
      setView("otp-code");
    }
  };

  // The account exists but the address behind it was never proven, so a code
  // goes out and the code view explains itself. Sending from here is what lets
  // that view say a code is on its way and mean it.
  const proveAddress = async () => {
    setProving(true);
    setOtp("");
    setView("otp-code");
    await run("otp-send", () => authClient.sendOTP(email));
  };

  const verifyCode = async () => {
    if (await run("otp-verify", () => authClient.verifyOTP(email, otp))) {
      setProving(false);
      await landed();
    }
  };

  const submitPassword = async () => {
    const context = isSignUp ? "password-signup" : "password-signin";
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = isSignUp
      ? await authClient.signUpEmail(email, password, name || email.split("@")[0])
      : await authClient.signInEmail(email, password);
    setBusy(false);
    // Two different answers, one situation: the address has not been proven.
    // A signup succeeds with no session to show for it, and a sign-in on an
    // account in that state is refused outright. Both used to end here, the
    // first looking like nothing happened and the second claiming the password
    // was wrong.
    const unproven = res.ok
      ? isSignUp && !res.data?.token
      : res.status === 403 && authFailureCode(res.data) === "EMAIL_NOT_VERIFIED";
    if (unproven) {
      await proveAddress();
      return;
    }
    if (!res.ok) {
      setError(authErrorMessage(res.status, context));
      return;
    }
    await landed();
  };

  const requestReset = async () => {
    if (await run("reset-request", () => authClient.requestPasswordReset(email))) {
      setOtp("");
      setPassword("");
      setView("reset-verify");
    }
  };

  const submitReset = async () => {
    if (await run("reset-verify", () => authClient.resetPassword(email, otp, password))) {
      // better-auth resets the credential but does not hand back a session, so
      // finish the job with the password we just set rather than dropping the
      // user back at a login form to type it a third time.
      const signedIn = await run("password-signin", () =>
        authClient.signInEmail(email, password)
      );
      if (signedIn) await landed();
      else {
        setView("password");
        setNotice("Password updated. Sign in with your new password.");
      }
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[14px] font-semibold text-foreground">{copy.title}</div>
        <div className="text-[12px] text-muted mt-1 leading-relaxed">{copy.body}</div>
      </div>

      {view === "choose" && (
        <>
          <button className={PRIMARY} onClick={startGoogle} disabled={busy}>
            Continue with Google
          </button>

          <div className="flex items-center gap-3 py-1" aria-hidden="true">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <input
            className={FIELD}
            placeholder="you@work.com"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email && sendCode()}
          />
          <button className={SECONDARY} disabled={busy || !email} onClick={sendCode}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
          <div className="text-[11px] text-muted">
            No account yet? A code makes one.
          </div>
          <button className={LINK} onClick={() => setView("password")}>
            Use a password instead
          </button>
        </>
      )}

      {view === "otp-code" && (
        <>
          {proving ? (
            <div className="text-[12px] text-muted leading-relaxed">
              <span className="text-foreground">Prove this address is yours.</span> We
              sent a code to <span className="text-foreground">{email}</span>. Enter it
              to finish signing in. Because this account was never verified, the code
              takes the place of the password you typed, so use a code from now on.
            </div>
          ) : (
            <div className="text-[12px] text-muted">
              Code sent to <span className="text-foreground">{email}</span>
            </div>
          )}
          <input
            className={FIELD}
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.target.value.trim())}
            onKeyDown={(e) => e.key === "Enter" && otp.length >= 6 && verifyCode()}
          />
          <button className={PRIMARY} disabled={busy || otp.length < 6} onClick={verifyCode}>
            {busy ? "Verifying…" : "Verify"}
          </button>
          <div className="flex items-center justify-between">
            <button className={LINK} onClick={sendCode} disabled={busy}>
              Resend code
            </button>
            <button
              className={LINK}
              onClick={() => {
                setProving(false);
                setView("choose");
              }}
            >
              Use a different email
            </button>
          </div>
        </>
      )}

      {view === "password" && (
        <>
          {isSignUp && (
            <input
              className={FIELD}
              placeholder="Name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <input
            className={FIELD}
            placeholder="you@work.com"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className={FIELD}
            placeholder="Password"
            type="password"
            autoComplete={isSignUp ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email && password && submitPassword()}
          />
          <button className={PRIMARY} disabled={busy || !email || !password} onClick={submitPassword}>
            {isSignUp ? "Create account" : "Sign in"}
          </button>
          <div className="flex items-center justify-between">
            <button className={LINK} onClick={() => setIsSignUp((v) => !v)}>
              {isSignUp ? "Have an account? Sign in" : "New here? Create account"}
            </button>
            {!isSignUp && (
              <button className={LINK} onClick={() => setView("reset-request")}>
                Forgot?
              </button>
            )}
          </div>
          <button className={LINK} onClick={() => setView("choose")}>
            Back to Google and email codes
          </button>
        </>
      )}

      {view === "reset-request" && (
        <>
          <div className="text-[12px] text-muted leading-relaxed">
            We&apos;ll email you a code to set a new password.
          </div>
          <input
            className={FIELD}
            placeholder="you@work.com"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email && requestReset()}
          />
          <button className={PRIMARY} disabled={busy || !email} onClick={requestReset}>
            {busy ? "Sending…" : "Send reset code"}
          </button>
          <button className={LINK} onClick={() => setView("password")}>
            Back to sign in
          </button>
        </>
      )}

      {view === "reset-verify" && (
        <>
          <div className="text-[12px] text-muted">
            Code sent to <span className="text-foreground">{email}</span>
          </div>
          <input
            className={FIELD}
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.target.value.trim())}
          />
          <input
            className={FIELD}
            placeholder="New password (8+ characters)"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && otp.length >= 6 && password.length >= 8 && submitReset()
            }
          />
          <button
            className={PRIMARY}
            disabled={busy || otp.length < 6 || password.length < 8}
            onClick={submitReset}
          >
            {busy ? "Updating…" : "Set password and sign in"}
          </button>
          <button className={LINK} onClick={requestReset} disabled={busy}>
            Resend code
          </button>
        </>
      )}

      {notice && <div className="text-[12px] text-muted">{notice}</div>}
      {error && (
        <div className="text-[12px] text-[var(--status-red)]" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

interface SignInDialogProps {
  reason: SignInReason;
  onClose: () => void;
  onDone?: () => void;
}

/** Modal wrapper, for the surfaces that gate on sign-in (Share, sync). */
export function SignInDialog({ reason, onClose, onDone }: SignInDialogProps) {
  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel overlay-panel-enter w-[400px] max-w-[92vw] rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Sign in to Markie"
      >
        <div className="flex justify-end -mt-1 -mr-1">
          <button className="markie-overlay-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <SignInForm
          reason={reason}
          onDone={() => {
            onDone?.();
            onClose();
          }}
        />
      </div>
    </div>
  );
}
