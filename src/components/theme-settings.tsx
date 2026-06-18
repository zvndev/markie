"use client";

import { useEffect, useState } from "react";
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

interface ThemeSettingsProps {
  onClose: () => void;
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

export function ThemeSettings({ onClose }: ThemeSettingsProps) {
  const [store, setStore] = useState(loadThemeStore);
  const active = findTheme(store, store.activeId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commit = (next: typeof store) => {
    setStore(next);
    saveThemeStore(next);
    applyTheme(findTheme(next, next.activeId).tokens);
    pushCloudThemes(); // no-op when signed out
  };

  const selectTheme = (id: string) => commit({ ...store, activeId: id });

  const updateToken = <K extends keyof ThemeTokens>(
    key: K,
    value: ThemeTokens[K]
  ) => {
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
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[84vh] overflow-y-auto rounded-xl border border-border shadow-2xl p-5"
        style={{ background: "var(--surface-2)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[14px] font-semibold text-foreground">Theme</h2>
          <button onClick={onClose} aria-label="Close theme settings" className="text-muted hover:text-foreground">
            ×
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mb-5">
          {allThemes(store).map((t) => (
            <button
              key={t.id}
              onClick={() => selectTheme(t.id)}
              className={`px-3 py-1.5 rounded-md text-[12px] border transition-all ${
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
                className="w-8 h-6 rounded border border-border bg-transparent cursor-pointer"
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
              className="w-52"
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
              className="w-52"
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
    </div>
  );
}
