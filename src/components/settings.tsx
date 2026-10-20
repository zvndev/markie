import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
  getLinkPreviewsEnabled,
  linkPreviewsEnabledOnServer,
  setLinkPreviewsEnabled,
  subscribeLinkPreviews,
} from "@/lib/link-previews";
import {
  activeTemplate,
  deleteCustomPreset,
  editColors,
  findTemplate,
  findTheme,
  HEADING_SAME_AS_BODY,
  loadThemeStore,
  presetForTone,
  presetTone,
  resetToTemplate,
  setTypography,
  templateVariant,
  THEME_TEMPLATES,
  TYPEFACES,
  TYPOGRAPHY_LIMITS,
  typefaceStack,
  typographyOf,
  type ThemePreset,
  type ThemeStore,
  type ThemeTokens,
  type ThemeTone,
  type ThemeTypography,
} from "@/lib/theme";
import {
  applyColorMode,
  applyCustomPreset,
  applyTemplate,
  COLOR_MODE_CHANGED_EVENT,
  commitThemeStore,
  getColorMode,
  resolveColorMode,
  type ColorMode,
} from "@/lib/color-mode";
import { pushCloudThemes } from "@/lib/theme-sync";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { LinkedIdentities } from "./linked-identities";
import { DefaultAppsSection } from "./default-apps-section";
import { SelectChevron } from "./select-chevron";

export type SettingsSection = "account" | "appearance" | "files" | "advanced";

interface SettingsProps {
  onClose: () => void;
  // which section to open on mount (Theme quick-access opens "appearance")
  initialSection?: SettingsSection;
}

// Add a section by extending SettingsSection and appending a row here; the tab
// strip and the initialSection prop both read from this list.
const SECTIONS: Array<[SettingsSection, string]> = [
  ["account", "Account"],
  ["appearance", "Appearance"],
  ["files", "Files"],
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
        className="markie-overlay-panel overlay-panel-enter w-[680px] max-w-[94vw] max-h-[86vh] overflow-y-auto rounded-xl p-5"
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
                <LinkedIdentities accountId={user.id} />
              </div>
            ) : (
              <SignInForm reason="account" />
            )}
          </>
        )}

        {section === "appearance" && <AppearanceSection />}

        {section === "files" && <DefaultAppsSection />}

        {section === "advanced" && (
          <div>
            <BetaChannelSetting />
            <LinkPreviewSetting />
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

// The only way into the early-access (beta) channel. Deliberately lives here and
// nowhere else: an unlisted channel you can only join from inside the app is
// what makes an early release withdrawable without anything public to retract.
// The stored setting is still `beta` in update-channel.json; only the words
// changed when early access became the first stage of every release.
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
          Get new versions early
          <span className="block text-[11px] text-muted/80 mt-0.5 leading-relaxed">
            New versions reach you first, and everyone else a few days later.
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

// On by default, because a preview is the useful behaviour. Off is a real
// position though: with previews on, the sites a document links to learn that
// somebody paused over them.
function LinkPreviewSetting() {
  // The switch reads the preference itself rather than holding a copy, so a
  // second window moving it is reflected here without a reload.
  const enabled = useSyncExternalStore(
    subscribeLinkPreviews,
    getLinkPreviewsEnabled,
    linkPreviewsEnabledOnServer
  );

  return (
    <div className="mb-5">
      <div className="markie-overlay-section mb-2">Links</div>
      <label className="flex items-start justify-between gap-3 text-[12px] text-muted py-1">
        <span>
          Preview links on hover
          <span className="block text-[11px] text-muted/80 mt-0.5 leading-relaxed">
            Rest the pointer on a link and Markie fetches the page&rsquo;s title, summary
            and picture. Nothing is fetched when you open a document, only when you
            point at a link, and the site you point at can tell that somebody looked.
          </span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setLinkPreviewsEnabled(e.target.checked)}
        />
      </label>
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

const COLOR_FIELDS: Array<[keyof ThemeTokens & keyof Omit<ThemeTokens, keyof ThemeTypography>, string]> = [
  ["background", "Background"],
  ["surface", "Surface"],
  ["foreground", "Text"],
  ["muted", "Muted text"],
  ["border", "Borders"],
  ["accent", "Accent"],
  ["link", "Links"],
];

const COLOR_MODES: Array<[ColorMode, string]> = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "System"],
];

const toneLabel = (tone: ThemeTone) => (tone === "light" ? "Light" : "Dark");

function useThemeSettings() {
  const [store, setStore] = useState<ThemeStore>(loadThemeStore);
  const [mode, setMode] = useState<ColorMode>(getColorMode);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The toolbar, the palette and the OS can all change the mode while this
  // panel is open; re-read rather than keep a stale copy.
  useEffect(() => {
    const sync = () => {
      setMode(getColorMode());
      setStore(loadThemeStore());
    };
    window.addEventListener(COLOR_MODE_CHANGED_EVENT, sync);
    return () => window.removeEventListener(COLOR_MODE_CHANGED_EVENT, sync);
  }, []);

  useEffect(
    () => () => {
      if (pushTimer.current) {
        clearTimeout(pushTimer.current);
        pushCloudThemes();
      }
    },
    []
  );

  // Sliders and color wells fire on every tick; the account copy only needs
  // the value the person settled on.
  const pushSoon = () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      pushCloudThemes();
    }, 600);
  };
  const pushNow = () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = null;
    pushCloudThemes(); // no-op when signed out
  };

  const tone = resolveColorMode(mode);
  return {
    store,
    mode,
    tone,
    pickMode: (next: ColorMode) => {
      applyColorMode(next);
      setMode(next);
      setStore(loadThemeStore());
    },
    pickTemplate: (id: string) => {
      setStore(applyTemplate(id));
      pushNow();
    },
    pickCustom: (id: string) => {
      setStore(applyCustomPreset(id));
      setMode(getColorMode());
      pushNow();
    },
    commit: (next: ThemeStore, live = false) => {
      setStore(commitThemeStore(next, tone));
      if (live) pushSoon();
      else pushNow();
    },
  };
}

function AppearanceSection() {
  const { store, mode, tone, pickMode, pickTemplate, pickCustom, commit } = useThemeSettings();
  const [colorsOpen, setColorsOpen] = useState(false);
  const template = activeTemplate(store);
  const current = presetForTone(store, tone);
  const tokens = findTheme(store, current.id).tokens;
  const typography = typographyOf(tokens);
  const customized =
    Object.keys(store.overrides ?? {}).length > 0 || Object.keys(store.typography ?? {}).length > 0;

  const updateTypography = (patch: Partial<ThemeTypography>) => commit(setTypography(store, patch), true);
  const updateColor = (key: (typeof COLOR_FIELDS)[number][0], value: string) =>
    commit(editColors(store, tone, { [key]: value }, newPresetId()), true);

  return (
    <div className="markie-appearance">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <div className="markie-overlay-section">Templates</div>
          <div className="text-[11px] text-muted mt-1">
            Each template has a light and a dark version. The mode picks which one you see.
          </div>
        </div>
        <div className="markie-segmented-control" role="group" aria-label="Color mode">
          {COLOR_MODES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              onClick={() => pickMode(id)}
              className="markie-segmented-option"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="markie-template-grid mb-5" role="radiogroup" aria-label="Style templates">
        {THEME_TEMPLATES.map((t) => (
          <TemplateCard
            key={t.id}
            name={t.name}
            description={t.description}
            preset={templateVariant(t, tone)}
            typography={t.typography}
            selected={t.id === template.id}
            badge={t.id === template.id && store.overrides?.[tone] ? "Customized" : undefined}
            onSelect={() => pickTemplate(t.id)}
          />
        ))}
      </div>

      {store.custom.length > 0 && (
        <div className="mb-5">
          <div className="markie-overlay-section mb-2">Your presets</div>
          <div className="markie-template-grid" role="radiogroup" aria-label="Your presets">
            {store.custom.map((preset) => {
              const presetTemplate = findTemplate(preset.templateId);
              return (
                <TemplateCard
                  key={preset.id}
                  name={preset.name}
                  description={`${presetTemplate ? `${presetTemplate.name}, ` : ""}${toneLabel(presetTone(preset)).toLowerCase()} only`}
                  preset={preset}
                  typography={typographyOf(preset.tokens)}
                  selected={preset.id === current.id}
                  onSelect={() => pickCustom(preset.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      <section className="markie-settings-group mb-4" aria-labelledby="markie-typography-title">
        <div className="flex items-center justify-between mb-3">
          <h3 id="markie-typography-title" className="markie-overlay-section">Typography</h3>
          <span className="text-[11px] text-muted">Applies to both versions of {template.name}</span>
        </div>
        <div className="markie-typography-layout">
          <div className="space-y-3 min-w-0">
            <div className="grid grid-cols-2 gap-2">
              <FontMenu
                label="Body font"
                value={typography.bodyFont}
                options={TYPEFACES.map((f) => [f.id, f.label, f.stack] as const)}
                onChange={(bodyFont) => commit(setTypography(store, { bodyFont }))}
              />
              <FontMenu
                label="Heading font"
                value={typography.headingFont}
                options={[
                  [HEADING_SAME_AS_BODY, "Same as body", typefaceStack(typography.bodyFont)] as const,
                  ...TYPEFACES.map((f) => [f.id, f.label, f.stack] as const),
                ]}
                onChange={(headingFont) => commit(setTypography(store, { headingFont }))}
              />
            </div>
            <RangeRow
              label="Text size"
              value={typography.fontSize}
              display={`${typography.fontSize} px`}
              {...TYPOGRAPHY_LIMITS.fontSize}
              onChange={(fontSize) => updateTypography({ fontSize })}
            />
            <RangeRow
              label="Line height"
              value={typography.lineHeight}
              display={typography.lineHeight.toFixed(2)}
              {...TYPOGRAPHY_LIMITS.lineHeight}
              onChange={(lineHeight) => updateTypography({ lineHeight: Math.round(lineHeight * 100) / 100 })}
            />
            <RangeRow
              label="Paragraph spacing"
              value={typography.paragraphGap}
              display={`${typography.paragraphGap.toFixed(1)} em`}
              {...TYPOGRAPHY_LIMITS.paragraphGap}
              onChange={(paragraphGap) => updateTypography({ paragraphGap: Math.round(paragraphGap * 10) / 10 })}
            />
            <RangeRow
              label="Content width"
              value={typography.contentWidth}
              display={`${typography.contentWidth} px`}
              {...TYPOGRAPHY_LIMITS.contentWidth}
              onChange={(contentWidth) => updateTypography({ contentWidth })}
            />
          </div>
          <Specimen />
        </div>
      </section>

      <section className="markie-settings-group mb-4">
        <button
          type="button"
          aria-expanded={colorsOpen}
          aria-controls="markie-custom-colors"
          onClick={() => setColorsOpen((open) => !open)}
          className="markie-overlay-button markie-disclosure w-full flex items-center justify-between gap-3 text-left"
        >
          <span>
            <span className="markie-overlay-section block">Customize colors</span>
            <span className="block text-[11px] text-muted mt-1">
              {current.builtIn
                ? `Changes save a copy of ${current.name} that stands in for ${toneLabel(tone).toLowerCase()} mode.`
                : `Editing ${current.name}, used in ${toneLabel(tone).toLowerCase()} mode.`}
            </span>
          </span>
          <SelectChevron />
        </button>
        {colorsOpen && (
          <div id="markie-custom-colors" className="grid grid-cols-2 gap-x-5 gap-y-2.5 mt-3">
            {COLOR_FIELDS.map(([key, label]) => (
              <label key={key} className="markie-color-row">
                <input
                  type="color"
                  value={String(tokens[key])}
                  onChange={(e) => updateColor(key, e.target.value)}
                  className="markie-color-well"
                />
                <span className="flex-1 text-[12px] text-foreground">{label}</span>
                <span className="text-[11px] text-muted tabular-nums">{String(tokens[key]).toUpperCase()}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-[11px] text-muted min-w-0 truncate">
          {current.builtIn ? `${current.name}${customized ? ", with your typography" : ""}` : `Custom preset: ${current.name}`}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {!current.builtIn && (
            <button
              type="button"
              onClick={() => commit(deleteCustomPreset(store, current.id, tone))}
              className="markie-overlay-button rounded-md px-2.5 py-1 text-[11px] text-muted hover:text-foreground"
            >
              Delete preset
            </button>
          )}
          <button
            type="button"
            disabled={!customized}
            onClick={() => commit(resetToTemplate(store, tone))}
            className="markie-overlay-button rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-40 disabled:hover:text-muted"
          >
            Reset to template
          </button>
        </div>
      </div>
    </div>
  );
}

// A miniature page painted in the preset's own colors and faces: a sidebar, an
// "Aa" in the heading face, a line in the body face and a link-colored rule.
function TemplateCard({
  name,
  description,
  preset,
  typography,
  selected,
  badge,
  onSelect,
}: {
  name: string;
  description: string;
  preset: ThemePreset;
  typography: ThemeTypography;
  selected: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  const descriptionId = useId();
  const t = preset.tokens;
  const body = typefaceStack(typography.bodyFont);
  const heading = typography.headingFont === HEADING_SAME_AS_BODY ? body : typefaceStack(typography.headingFont);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={name}
      aria-describedby={descriptionId}
      onClick={onSelect}
      className="markie-template-card"
    >
      <span
        className="markie-template-preview"
        aria-hidden="true"
        style={{ background: t.background, borderColor: t.border, color: t.foreground }}
      >
        <span className="markie-template-rail" style={{ background: t.surface, borderColor: t.border }}>
          <span style={{ background: t.muted }} />
          <span style={{ background: t.muted }} />
          <span style={{ background: t.muted }} />
        </span>
        <span className="markie-template-page">
          <span className="markie-template-aa" style={{ fontFamily: heading }}>Aa</span>
          <span className="markie-template-line" style={{ fontFamily: body, color: t.muted }}>
            The quiet page
          </span>
          <span className="markie-template-rule" style={{ background: t.link }} />
        </span>
        <span className="markie-template-dot" style={{ background: t.link, boxShadow: `0 0 0 2px ${t.background}` }} />
      </span>
      <span className="markie-template-meta">
        <span className="markie-template-name">{name}</span>
        {selected ? (
          <span className="markie-template-check" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5 10 17 19 7" />
            </svg>
          </span>
        ) : null}
      </span>
      <span id={descriptionId} className="markie-template-description">
        {badge ? <span className="markie-template-badge">{badge}</span> : null}
        {description}
      </span>
    </button>
  );
}

// Reads the same CSS variables the document does, so it cannot drift from
// what a real document looks like with these settings.
function Specimen() {
  return (
    <div className="markie-specimen" aria-label="Typography preview" role="img">
      <div
        className="markdown-body"
        style={{ fontSize: "var(--doc-font-size, 16px)", fontFamily: "var(--doc-font-family, inherit)" }}
      >
        <h3>On reading slowly</h3>
        <p>
          A good page gets out of the way. The measure is comfortable, the lines have room to
          breathe, and <a href="#specimen" tabIndex={-1} onClick={(e) => e.preventDefault()}>links</a> are
          easy to find without shouting.
        </p>
        <p>Every paragraph is given the same calm space before the next one begins.</p>
      </div>
    </div>
  );
}

function RangeRow({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label htmlFor={id} className="text-[12px] text-foreground">
          {label}
        </label>
        <span className="text-[11px] text-muted tabular-nums">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="markie-range"
        style={{ "--fill": fill } as CSSProperties}
      />
    </div>
  );
}

// A select-like disclosure in the shape of QueryMenu (library filters), with
// each face named in itself so the choice can be made by eye.
function FontMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string, string]>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.find(([key]) => key === value) ?? options[0];
  useDismissibleLayer(open, root, () => setOpen(false));
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Closes the menu, not the whole Settings dialog behind it.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % buttons.length
        : event.key === "ArrowUp"
          ? (index - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    if (next >= 0) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  };
  return (
    <div ref={root} className="relative min-w-0">
      <div className="text-[11px] text-muted mb-1" id={`${id}-label`}>
        {label}
      </div>
      <button
        ref={trigger}
        type="button"
        aria-label={`${label}: ${selected[1]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-open={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="markie-select-button w-full"
      >
        <span className="markie-select-label text-[12.5px] text-foreground" style={{ fontFamily: selected[2] }}>
          {selected[1]}
        </span>
        <SelectChevron />
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={keys}
          className="markie-menu-panel overlay-popover-enter absolute top-full left-0 z-30 mt-1.5 w-full min-w-[180px] max-h-[260px] overflow-y-auto rounded-[10px] p-1"
        >
          {options.map(([key, title, stack]) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={value === key}
              onClick={() => {
                onChange(key);
                close();
              }}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-accent/40 focus:bg-accent focus:outline-none"
            >
              <span style={{ fontFamily: stack }}>{title}</span>
              <span aria-hidden="true" className="flex h-3.5 w-3.5 items-center justify-center text-[11px]">
                {value === key ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

