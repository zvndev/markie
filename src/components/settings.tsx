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
import {
  allThemes,
  applyTheme,
  findTheme,
  loadThemeStore,
  saveThemeStore,
  type ThemePreset,
  type ThemeTokens,
} from "@/lib/theme";
import { pushCloudThemes } from "@/lib/theme-sync";

type SettingsSection = "account" | "appearance" | "advanced";

interface SettingsProps {
  onClose: () => void;
  // bumps when auth changes out-of-band (e.g. Google deep-link sign-in)
  authNonce: number;
  // which section to open on mount (Theme quick-access opens "appearance")
  initialSection?: SettingsSection;
}

type AuthView = "password" | "otp-email" | "otp-code";

const SECTIONS: Array<[SettingsSection, string]> = [
  ["account", "Account"],
  ["appearance", "Appearance"],
  ["advanced", "Advanced"],
];

export function Settings({ onClose, authNonce, initialSection = "account" }: SettingsProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
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

  const inputClass = "markie-overlay-field w-full text-[13px] px-3 py-2";
  const buttonClass =
    "markie-overlay-button w-full text-[13px] py-2 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-50";

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel overlay-panel-enter w-[480px] max-w-[92vw] max-h-[84vh] overflow-y-auto rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-settings-title"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id="markie-settings-title" className="text-[14px] font-semibold text-foreground">
            Settings
          </h2>
          <button onClick={onClose} aria-label="Close settings" className="markie-overlay-close">
            ×
          </button>
        </div>

        <div className="flex gap-1 mb-5 border-b border-border" role="tablist" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={section === id}
              onClick={() => setSection(id)}
              className={`markie-overlay-button -mb-px px-3 py-2 text-[12px] border-b-2 ${
                section === id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {section === "account" && (
          <>
            {checking ? (
              <div className="text-[12px] text-muted">Checking session…</div>
            ) : user ? (
              <div>
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
                    className="markie-overlay-button text-[12px] text-muted hover:text-foreground border border-border rounded-md px-3 py-1.5"
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
              <div className="space-y-2">
                <div className="mb-3">
                  <div className="text-[14px] font-semibold text-foreground">Sign in to Markie</div>
                  <div className="text-[12px] text-muted mt-0.5">
                    Sync and share across your devices.
                  </div>
                </div>
                {authView === "password" && (
                  <>
                    {isSignUp && (
                      <input
                        className={inputClass}
                        placeholder="Name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    )}
                    <input
                      className={inputClass}
                      placeholder="Email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
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
                    <button
                      className="text-[11px] text-muted hover:text-foreground"
                      onClick={() => setAuthView("password")}
                    >
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
                    <button
                      className="text-[11px] text-muted hover:text-foreground"
                      onClick={() => setAuthView("otp-email")}
                    >
                      Resend code
                    </button>
                  </>
                )}
                <button
                  className="markie-overlay-button w-full text-[13px] py-2 rounded-md border border-border text-foreground/90 hover:bg-accent/40"
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
                {error && <div className="text-[12px] text-[var(--status-red)]">{error}</div>}
              </div>
            )}
          </>
        )}

        {section === "appearance" && <AppearanceSection />}

        {section === "advanced" && (
          <div>
            <div className="markie-overlay-section mb-2">Server &amp; sync settings</div>
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
            <div className="text-[11px] text-muted mt-2">
              Point Markie at a different sync server. Leave the default unless you self-host.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const newPresetId = () => `custom-${Date.now()}`;

const COLOR_FIELDS: Array<[keyof ThemeTokens, string]> = [
  ["background", "Background"],
  ["surface", "Surface"],
  ["foreground", "Text"],
  ["muted", "Muted text"],
  ["border", "Borders"],
  ["accent", "Accent"],
  ["link", "Links"],
];

function AppearanceSection() {
  const [store, setStore] = useState(loadThemeStore);
  const active = findTheme(store, store.activeId);

  const commit = (next: typeof store) => {
    setStore(next);
    saveThemeStore(next);
    applyTheme(findTheme(next, next.activeId).tokens);
    pushCloudThemes(); // no-op when signed out
  };

  const selectTheme = (id: string) => commit({ ...store, activeId: id });

  const updateToken = <K extends keyof ThemeTokens>(key: K, value: ThemeTokens[K]) => {
    if (active.builtIn) {
      // editing a built-in forks it into a custom preset
      const fork: ThemePreset = {
        id: newPresetId(),
        name: `${active.name} Copy`,
        tokens: { ...active.tokens, [key]: value },
      };
      commit({
        activeId: fork.id,
        custom: [...store.custom, fork],
      });
      return;
    }
    const custom = store.custom.map((t) =>
      t.id === active.id ? { ...t, tokens: { ...t.tokens, [key]: value } } : t
    );
    commit({ ...store, custom });
  };

  const deleteActive = () => {
    if (active.builtIn) return;
    commit({
      activeId: "markie-dark",
      custom: store.custom.filter((t) => t.id !== active.id),
    });
  };

  return (
    <div>
      <div className="markie-overlay-section mb-2">Theme</div>
      <div className="flex flex-wrap gap-2 mb-5">
        {allThemes(store).map((t) => (
          <button
            key={t.id}
            onClick={() => selectTheme(t.id)}
            className={`markie-overlay-button px-3 py-1.5 rounded-md text-[12px] border ${
              t.id === store.activeId
                ? "border-foreground/40 text-foreground bg-accent"
                : "border-border text-muted hover:text-foreground"
            }`}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5">
        {COLOR_FIELDS.map(([key, label]) => (
          <label key={key} className="flex items-center justify-between text-[12px] text-muted">
            {label}
            <input
              type="color"
              value={String(active.tokens[key])}
              onChange={(e) => updateToken(key, e.target.value)}
              className="markie-overlay-field w-8 h-6 bg-transparent cursor-pointer"
            />
          </label>
        ))}
      </div>

      <div className="space-y-3 mb-5">
        <label className="flex items-center justify-between text-[12px] text-muted">
          Font size — {active.tokens.fontSize}px
          <input
            type="range"
            min={13}
            max={22}
            value={active.tokens.fontSize}
            onChange={(e) => updateToken("fontSize", Number(e.target.value))}
            className="markie-overlay-field w-52"
          />
        </label>
        <label className="flex items-center justify-between text-[12px] text-muted">
          Content width — {active.tokens.contentWidth}px
          <input
            type="range"
            min={560}
            max={1200}
            step={16}
            value={active.tokens.contentWidth}
            onChange={(e) => updateToken("contentWidth", Number(e.target.value))}
            className="markie-overlay-field w-52"
          />
        </label>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-[11px] text-muted">
          {active.builtIn
            ? "Editing a built-in theme saves it as a copy."
            : `Custom preset: ${active.name}`}
        </span>
        {!active.builtIn && (
          <button onClick={deleteActive} className="text-[11px] text-muted hover:text-foreground">
            Delete preset
          </button>
        )}
      </div>
    </div>
  );
}
