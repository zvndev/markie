import { useEffect, useState } from "react";
import {
  getServerURL,
  setServerURL,
  getSyncEnabled,
  setSyncEnabled,
} from "@/lib/auth-client";
import { authStore, useAuth } from "@/lib/auth-store";
import { SignInForm } from "@/components/sign-in";
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
  // which section to open on mount (Theme quick-access opens "appearance")
  initialSection?: SettingsSection;
}

const SECTIONS: Array<[SettingsSection, string]> = [
  ["account", "Account"],
  ["appearance", "Appearance"],
  ["advanced", "Advanced"],
];

export function Settings({ onClose, initialSection = "account" }: SettingsProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  // The store owns the session, so Settings no longer probes /api/me itself and
  // no longer needs an authNonce poked at it from page.tsx when a Google
  // deep-link signs the user in behind this dialog.
  const { user, status } = useAuth();
  const [sync, setSync] = useState(getSyncEnabled);
  const [server, setServer] = useState(getServerURL);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const inputClass = "markie-overlay-field w-full text-[13px] px-3 py-2";

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
            {status === "checking" ? (
              <div className="text-[12px] text-muted">Checking session…</div>
            ) : user ? (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-[13px] text-foreground">{user.name || user.email}</div>
                    <div className="text-[11px] text-muted">{user.email}</div>
                  </div>
                  <button
                    onClick={() => authStore.signOut()}
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
              <SignInForm reason="account" />
            )}
          </>
        )}

        {section === "appearance" && <AppearanceSection />}

        {section === "advanced" && (
          <div>
            <BetaChannelSetting />
            <CrashReportingSetting />

            <div className="markie-overlay-section mb-2">Server &amp; sync settings</div>
            <label className="text-[11px] text-muted block mb-1">Markie server URL</label>
            <input
              className={inputClass}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              onBlur={() => {
                setServerURL(server);
                // A different server means a different session, so re-probe
                // rather than keep showing the account from the old one.
                void authStore.refresh();
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

// The only way into the beta channel. Deliberately lives here and nowhere else:
// an unlisted channel you can only join from inside the app is what makes a
// beta release withdrawable without anything public to retract.
function BetaChannelSetting() {
  const [optedIn, setOptedIn] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getElectronAPI()
      ?.updateChannelGet?.()
      .then((s) => {
        if (!alive) return;
        setOptedIn(s.optedIn);
        setVersion(s.currentVersion);
      })
      .catch(() => alive && setOptedIn(false));
    return () => {
      alive = false;
    };
  }, []);

  // Nothing to offer in a browser or an unpackaged dev window.
  if (optedIn === null || !getElectronAPI()?.updateChannelSet) return null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const res = await getElectronAPI()!.updateChannelSet!(next);
    setBusy(false);
    if (!res.ok) {
      // Don't move the switch on a write that didn't stick, or the UI claims a
      // preference the updater will not honour on the next launch.
      setError(res.error ?? "Couldn't change the update channel.");
      return;
    }
    setOptedIn(next);
  };

  return (
    <div className="mb-5">
      <div className="markie-overlay-section mb-2">Updates</div>
      <label className="flex items-start justify-between gap-3 text-[12px] text-muted py-1">
        <span>
          Receive beta updates
          <span className="block text-[11px] text-muted/80 mt-0.5 leading-relaxed">
            Early builds, before they are released to everyone. Expect rough edges.
            Turning this off moves you back to the current stable build.
          </span>
        </span>
        <input
          type="checkbox"
          checked={optedIn}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
        />
      </label>
      {version && (
        <div className="text-[11px] text-muted mt-1">
          You are running Markie {version}.
        </div>
      )}
      {error && <div className="text-[11px] text-[var(--status-red)] mt-1">{error}</div>}
    </div>
  );
}

// Opt-in error reporting. Off by default and only reachable from inside the
// app: Markie tells a new user on first run that their files stay on this Mac,
// and telemetry that turns itself on would make that a lie.
function CrashReportingSetting() {
  const [state, setState] = useState<{ enabled: boolean; available: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getElectronAPI()
      ?.crashConsentGet?.()
      .then((s) => alive && setState(s))
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
  }, []);

  // No DSN in this build means there is nowhere to report to, so offering the
  // switch would be offering nothing.
  if (!state?.available || !getElectronAPI()?.crashConsentSet) return null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const res = await getElectronAPI()!.crashConsentSet!(next);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't change that setting.");
      return;
    }
    setState({ ...state, enabled: next });
  };

  return (
    <div className="mb-5">
      <div className="markie-overlay-section mb-2">Error reporting</div>
      <label className="flex items-start justify-between gap-3 text-[12px] text-muted py-1">
        <span>
          Send crash reports
          <span className="block text-[11px] text-muted/80 mt-0.5 leading-relaxed">
            Off by default. When on, Markie sends the error and where in the code it
            happened, so crashes get fixed. Never your documents, their contents, or
            their file paths.
          </span>
        </span>
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
        />
      </label>
      <button
        className="text-[11px] text-muted hover:text-foreground mt-1"
        onClick={() => getElectronAPI()?.crashLogReveal?.()}
      >
        Show the crash log
      </button>
      {error && <div className="text-[11px] text-[var(--status-red)] mt-1">{error}</div>}
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
