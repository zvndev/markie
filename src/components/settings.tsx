"use client";

import { useCallback, useEffect, useState } from "react";
import {
  authClient,
  getServerURL,
  setServerURL,
  getSyncEnabled,
  setSyncEnabled,
  type MarkieUser,
} from "@/lib/auth-client";
import { getElectronAPI } from "@/lib/electron";

interface SettingsProps {
  onClose: () => void;
  // bumps when auth changes out-of-band (e.g. Google deep-link sign-in)
  authNonce: number;
}

type AuthView = "password" | "otp-email" | "otp-code";

export function Settings({ onClose, authNonce }: SettingsProps) {
  const [user, setUser] = useState<MarkieUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [authView, setAuthView] = useState<AuthView>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState(getSyncEnabled);
  const [server, setServer] = useState(getServerURL);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    const u = await authClient.me();
    setUser(u);
    setChecking(false);
  }, []);

  useEffect(() => {
    let alive = true;
    authClient.me().then((u) => {
      if (!alive) return;
      setUser(u);
      setChecking(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Re-check the session when auth changes out-of-band (Google deep-link
  // sign-in lands a token via markie://). Without this the open modal stays
  // stuck on the sign-in form after the browser hands the session back.
  useEffect(() => {
    if (authNonce === 0) return;
    let alive = true;
    authClient.me().then((u) => {
      if (!alive) return;
      setUser(u);
      setChecking(false);
    });
    return () => {
      alive = false;
    };
  }, [authNonce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<{ ok: boolean; status: number }>) => {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(
        res.status === 0
          ? "Can't reach the Markie server."
          : res.status === 401
            ? "Invalid credentials."
            : `Request failed (${res.status}).`
      );
      return false;
    }
    return true;
  };

  const submitPassword = async () => {
    const ok = await run(() =>
      isSignUp
        ? authClient.signUpEmail(email, password, name || email.split("@")[0])
        : authClient.signInEmail(email, password)
    );
    if (ok) refresh();
  };

  const submitOTPEmail = async () => {
    const ok = await run(() => authClient.sendOTP(email));
    if (ok) setAuthView("otp-code");
  };

  const submitOTPCode = async () => {
    const ok = await run(() => authClient.verifyOTP(email, otp));
    if (ok) refresh();
  };

  const inputClass =
    "w-full text-[13px] bg-background border border-border rounded-md px-3 py-2 text-foreground outline-none focus:border-foreground/30";
  const buttonClass =
    "w-full text-[13px] py-2 rounded-md bg-accent text-foreground hover:opacity-90 transition-opacity disabled:opacity-50";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[440px] max-w-[92vw] max-h-[84vh] overflow-y-auto rounded-xl border border-border shadow-2xl p-5"
        style={{ background: "var(--surface-2)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[14px] font-semibold text-foreground">Settings</h2>
          <button onClick={onClose} aria-label="Close settings" className="text-muted hover:text-foreground">
            ×
          </button>
        </div>

        {/* Account */}
        <div className="text-[10px] uppercase tracking-wide text-muted mb-2">Account</div>
        {checking ? (
          <div className="text-[12px] text-muted mb-5">Checking session…</div>
        ) : user ? (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-[13px] text-foreground">{user.name || user.email}</div>
                <div className="text-[11px] text-muted">{user.email}</div>
              </div>
              <button
                onClick={async () => {
                  await authClient.signOut();
                  refresh();
                }}
                className="text-[12px] text-muted hover:text-foreground border border-border rounded-md px-3 py-1.5"
              >
                Sign out
              </button>
            </div>
            <label className="flex items-center justify-between text-[12px] text-muted py-1">
              Sync my documents to the cloud
              <input
                type="checkbox"
                checked={sync}
                onChange={(e) => {
                  setSync(e.target.checked);
                  setSyncEnabled(e.target.checked);
                }}
              />
            </label>
          </div>
        ) : (
          <div className="mb-5 space-y-2">
            {authView === "password" && (
              <>
                {isSignUp && (
                  <input className={inputClass} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
                )}
                <input className={inputClass} placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <input
                  className={inputClass}
                  placeholder="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                />
                <button className={buttonClass} disabled={busy || !email || !password} onClick={submitPassword}>
                  {isSignUp ? "Create account" : "Sign in"}
                </button>
                <div className="flex items-center justify-between text-[11px] text-muted">
                  <button className="hover:text-foreground" onClick={() => setIsSignUp((v) => !v)}>
                    {isSignUp ? "Have an account? Sign in" : "New here? Create account"}
                  </button>
                  <button className="hover:text-foreground" onClick={() => setAuthView("otp-email")}>
                    Email me a code instead
                  </button>
                </div>
              </>
            )}
            {authView === "otp-email" && (
              <>
                <input
                  className={inputClass}
                  placeholder="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitOTPEmail()}
                />
                <button className={buttonClass} disabled={busy || !email} onClick={submitOTPEmail}>
                  Send sign-in code
                </button>
                <button className="text-[11px] text-muted hover:text-foreground" onClick={() => setAuthView("password")}>
                  Back to password
                </button>
              </>
            )}
            {authView === "otp-code" && (
              <>
                <div className="text-[12px] text-muted">Code sent to {email}</div>
                <input
                  className={inputClass}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitOTPCode()}
                />
                <button className={buttonClass} disabled={busy || otp.length < 6} onClick={submitOTPCode}>
                  Verify
                </button>
                <button className="text-[11px] text-muted hover:text-foreground" onClick={() => setAuthView("otp-email")}>
                  Resend code
                </button>
              </>
            )}
            <button
              className="w-full text-[13px] py-2 rounded-md border border-border text-foreground/90 hover:bg-accent/40 transition-colors"
              onClick={() => {
                setError(null);
                const url = authClient.googleSignInURL();
                const api = getElectronAPI();
                if (api?.openExternal) api.openExternal(url);
                else window.open(url, "_blank");
              }}
            >
              Continue with Google
            </button>
            {error && <div className="text-[12px] text-red-400">{error}</div>}
          </div>
        )}

        {/* Advanced */}
        <button
          className="text-[11px] text-muted hover:text-foreground"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "Hide advanced" : "Advanced…"}
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <label className="text-[11px] text-muted block mb-1">Markie server URL</label>
            <input
              className={inputClass}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              onBlur={() => {
                setServerURL(server);
                refresh();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
