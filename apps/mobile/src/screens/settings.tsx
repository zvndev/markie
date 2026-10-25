// Account, server, appearance, version, and sign out.
import { useEffect, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { StoredSession } from "../lib/session";
import { isMarkieCloud, serverLabel } from "../lib/server-origin";
import { haptics } from "../lib/native";
import type { ThemeMode } from "../lib/theme-mode";
import { Screen } from "../components/screen";

interface SettingsProps {
  session: StoredSession;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  onSignOut: () => Promise<void>;
  onBack: () => void;
}

const MODES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsScreen({ session, themeMode, onThemeMode, onSignOut, onBack }: SettingsProps) {
  const [version, setVersion] = useState<string>(__MARKIE_MOBILE_VERSION__);
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void App.getInfo().then((info) => setVersion(`${info.version} (${info.build})`)).catch(() => undefined);
  }, []);

  return (
    <Screen title="Settings" largeTitle back={{ label: "Recent", onBack }} className="m-settings">
      <h2 className="m-group-heading">Account</h2>
      <div className="m-group">
        <div className="m-group-row">
          <span className="m-group-label">Email</span>
          <span className="m-group-value m-selectable">{session.email}</span>
        </div>
        {session.name && session.name !== session.email ? (
          <div className="m-group-row">
            <span className="m-group-label">Name</span>
            <span className="m-group-value">{session.name}</span>
          </div>
        ) : null}
      </div>

      <h2 className="m-group-heading">Server</h2>
      <div className="m-group">
        <div className="m-group-row">
          <span className="m-group-label">{isMarkieCloud(session.origin) ? serverLabel(session.origin) : "Your server"}</span>
          <span className="m-group-value m-selectable m-mono">{new URL(session.origin).host}</span>
        </div>
      </div>
      <p className="m-group-footer">To use a different server, sign out and choose it under Advanced.</p>

      <h2 className="m-group-heading">Appearance</h2>
      <div className="m-group m-group-padded">
        <div className="m-segmented m-segmented-full" role="radiogroup" aria-label="Theme">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={themeMode === mode.value}
              className={themeMode === mode.value ? "is-selected" : ""}
              onClick={() => { if (themeMode !== mode.value) { haptics.selection(); onThemeMode(mode.value); } }}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <h2 className="m-group-heading">About</h2>
      <div className="m-group">
        <div className="m-group-row">
          <span className="m-group-label">Version</span>
          <span className="m-group-value">{version}</span>
        </div>
      </div>

      <div className="m-group m-group-spaced">
        {confirming ? (
          <div className="m-confirm">
            <p>Sign out of {session.email}? Your documents stay in Markie Cloud.</p>
            <div className="m-confirm-actions">
              <button type="button" className="m-button m-button-secondary" disabled={signingOut} onClick={() => setConfirming(false)}>Cancel</button>
              <button
                type="button"
                className="m-button m-button-destructive"
                disabled={signingOut}
                onClick={async () => { setSigningOut(true); await onSignOut(); }}
              >
                {signingOut ? "Signing out" : "Sign out"}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="m-group-action m-destructive" onClick={() => setConfirming(true)}>Sign out</button>
        )}
      </div>
    </Screen>
  );
}
