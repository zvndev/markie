// Font pickers built on the font registry (src/lib/fonts/registry.ts).
//
//   FontPicker            one grouped menu, every choice shown in its own face
//   CodeFontPicker        the picker for document code
//   LocalFontsPanel       fonts installed on this computer, offered for the
//                         body, the headings or code
//   FontLibraryControls   the two above together, as Settings places them
//
// All of them deal in typeface ids. None of them knows where a body or a
// heading font is stored: the caller passes the value and takes the change.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { SelectChevron } from "./select-chevron";
import {
  BUNDLED_FAMILIES,
  TYPEFACE_GROUP_LABELS,
  TYPEFACE_LIST,
  adoptLocalTypeface,
  codeTypefaces,
  parseLocalTypefaceId,
  type Typeface,
  type TypefaceGroup,
} from "@/lib/fonts/registry";
import { CODE_FONT_CHANGED_EVENT, CODE_FONT_DEFAULT, loadCodeFont, saveCodeFont } from "@/lib/fonts/code-font";
import { canListLocalFonts, knownLocalFonts, listLocalFonts, type LocalFontFamily } from "@/lib/fonts/local-fonts";

export interface FontChoice {
  id: string;
  label: string;
  /** The CSS the label is drawn in. */
  stack: string;
  group?: TypefaceGroup;
  /** A short remark after the name, such as "Only on this computer". */
  note?: string;
}

const GROUP_ORDER: TypefaceGroup[] = ["system", "sans", "readable", "rounded", "serif", "display", "mono", "local"];

/** Typefaces as picker choices, a local one named plainly with its remark beside it. */
export function fontChoices(faces: readonly Typeface[]): FontChoice[] {
  return faces.map((face) => ({
    id: face.id,
    label: face.localOnly ? (parseLocalTypefaceId(face.id)?.family ?? face.label) : face.label,
    stack: face.stack,
    group: face.group,
    note: face.localOnly ? "Only on this computer" : undefined,
  }));
}

/** Every typeface a Markdown document can be set in, as picker choices. */
export function allFontChoices(): FontChoice[] {
  return fontChoices(TYPEFACE_LIST);
}

function grouped(choices: readonly FontChoice[]): Array<{ group: TypefaceGroup | undefined; items: FontChoice[] }> {
  const loose = choices.filter((choice) => !choice.group);
  const sections = GROUP_ORDER.map((group) => ({ group, items: choices.filter((choice) => choice.group === group) })).filter((section) => section.items.length);
  return [...(loose.length ? [{ group: undefined, items: loose }] : []), ...sections];
}

/**
 * A select-like menu of typefaces under group headings, each drawn in itself.
 * The same shape and keys as the menus in Settings.
 */
export function FontPicker({ label, value, choices, onChange }: { label: string; value: string; choices: readonly FontChoice[]; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = choices.find((choice) => choice.id === value) ?? choices[0];
  const sections = useMemo(() => grouped(choices), [choices]);
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
      // Closes the menu, not the dialog behind it.
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
      event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
      : event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
      : -1;
    if (next >= 0) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  };
  return (
    <div ref={root} className="relative min-w-0">
      <div className="text-[11px] text-muted mb-1" id={`${id}-label`}>{label}</div>
      <button
        ref={trigger}
        type="button"
        aria-label={`${label}: ${selected?.label ?? ""}`}
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
        <span className="markie-select-label text-[12.5px] text-foreground" style={{ fontFamily: selected?.stack }}>{selected?.label}</span>
        <SelectChevron />
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={keys}
          className="markie-menu-panel overlay-popover-enter absolute top-full left-0 z-30 mt-1.5 w-full min-w-[220px] max-h-[300px] overflow-y-auto rounded-[10px] p-1"
        >
          {sections.map((section) => (
            <div key={section.group ?? "none"} role="group" aria-label={section.group ? TYPEFACE_GROUP_LABELS[section.group] : undefined}>
              {section.group ? <div aria-hidden="true" className="px-2 pt-2 pb-1 text-[10.5px] uppercase tracking-wide text-muted">{TYPEFACE_GROUP_LABELS[section.group]}</div> : null}
              {section.items.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === choice.id}
                  aria-label={choice.note ? `${choice.label}, ${choice.note.toLowerCase()}` : choice.label}
                  onClick={() => {
                    onChange(choice.id);
                    close();
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-accent/40 focus:bg-accent focus:outline-none"
                >
                  <span className="min-w-0 truncate" style={{ fontFamily: choice.stack }}>{choice.label}</span>
                  <span aria-hidden="true" className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                    {choice.note ? <span>{choice.note}</span> : null}
                    <span className="flex h-3.5 w-3.5 items-center justify-center text-foreground">{value === choice.id ? "✓" : ""}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const DEFAULT_CODE_CHOICE: FontChoice = { id: CODE_FONT_DEFAULT, label: "Default", stack: "var(--font-geist-mono)" };

/** The code font as stored on this computer, kept in step with other pickers. */
export function useCodeFont(): [string, (id: string) => void] {
  const [codeFont, setCodeFont] = useState(loadCodeFont);
  useEffect(() => {
    const sync = () => setCodeFont(loadCodeFont());
    window.addEventListener(CODE_FONT_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CODE_FONT_CHANGED_EVENT, sync);
  }, []);
  return [codeFont, (id) => setCodeFont(saveCodeFont(id))];
}

/** The font code blocks and inline code are set in. Monospace faces only. */
export function CodeFontPicker({ label = "Code font" }: { label?: string }) {
  const [codeFont, setCodeFont] = useCodeFont();
  // Read on each render: a local font adopted a moment ago is in the list.
  const choices = [DEFAULT_CODE_CHOICE, ...fontChoices(codeTypefaces())];
  return <FontPicker label={label} value={codeFont} choices={choices} onChange={setCodeFont} />;
}

export type FontSlot = "body" | "heading" | "code";

/**
 * Fonts installed on this computer. Listed only when asked, because a browser
 * asks permission first. Choosing one stores an id that also names a bundled
 * face, which is what a hosted link or another person sees instead.
 */
export function LocalFontsPanel({ onUse }: { onUse: (slot: FontSlot, id: string) => void }) {
  const [fonts, setFonts] = useState<LocalFontFamily[] | null>(knownLocalFonts);
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "refused">("idle");
  const [used, setUsed] = useState<string | null>(null);
  if (!canListLocalFonts()) return null;
  const show = async () => {
    setState("loading");
    try {
      setFonts(await listLocalFonts());
      setState("idle");
    } catch {
      setState("refused");
    }
  };
  const use = (font: LocalFontFamily, slot: FontSlot) => {
    const face = font.id ? adoptLocalTypeface(font.id) : null;
    if (!face) return;
    onUse(slot, face.id);
    const fallback = parseLocalTypefaceId(face.id)?.fallback.family;
    setUsed(`${font.family} is only on this computer. A shared link or another person sees ${fallback} instead.`);
  };
  const needle = filter.trim().toLowerCase();
  const shown = (fonts ?? []).filter((font) => font.id && (!needle || font.family.toLowerCase().includes(needle))).slice(0, 400);
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted mb-1">Fonts on this computer</div>
      {fonts === null ? (
        <>
          <button type="button" className="markie-select-button" onClick={show} disabled={state === "loading"}>
            <span className="markie-select-label text-[12.5px] text-foreground">{state === "loading" ? "Reading fonts…" : "Show fonts on this computer"}</span>
          </button>
          <p className="mt-1 text-[11px] text-muted" role={state === "refused" ? "alert" : undefined}>
            {state === "refused"
              ? "Markie was not allowed to list this computer's fonts."
              : "A font from this computer shows only here. Shared links and other people see a bundled font instead."}
          </p>
        </>
      ) : (
        <>
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Search ${fonts.length} fonts`}
            aria-label="Search fonts on this computer"
            className="markie-overlay-field mb-1 h-7 w-full px-2 text-[12px]"
          />
          <ul aria-label="Fonts on this computer" className="markie-menu-panel max-h-[190px] overflow-y-auto rounded-[10px] p-1">
            {shown.map((font) => (
              <li key={font.family} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[13px] text-foreground">
                <span className="min-w-0 truncate" style={{ fontFamily: `'${font.family.replace(/[^A-Za-z0-9 ._+&-]/g, "")}'` }}>{font.family}</span>
                <span className="flex shrink-0 gap-1">
                  {(font.kind === "mono" ? (["code", "body", "heading"] as const) : (["body", "heading"] as const)).map((slot) => (
                    <button
                      key={slot}
                      type="button"
                      aria-label={`Use ${font.family} for ${slot === "heading" ? "headings" : slot}`}
                      onClick={() => use(font, slot)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-accent/40 hover:text-foreground focus:bg-accent focus:outline-none"
                    >
                      {slot === "body" ? "Body" : slot === "heading" ? "Headings" : "Code"}
                    </button>
                  ))}
                </span>
              </li>
            ))}
            {shown.length === 0 ? <li className="px-2 py-1 text-[12px] text-muted">No font matches.</li> : null}
          </ul>
          <p className="mt-1 text-[11px] text-muted" aria-live="polite">
            {used ?? "Only on this computer. Shared links and other people see a bundled font instead."}
          </p>
        </>
      )}
    </div>
  );
}

const LICENSE_NAMES = { "OFL-1.1": "SIL Open Font License 1.1", "Apache-2.0": "Apache License 2.0" } as const;

/** Which fonts ship with Markie and under what license. The license texts are in the build. */
export function BundledFontNotice() {
  return (
    <details className="text-[11px] text-muted">
      <summary className="cursor-pointer">Fonts included with Markie</summary>
      <ul className="mt-1 space-y-0.5">
        {BUNDLED_FAMILIES.map((family) => (
          <li key={family.id}>{family.family}, {LICENSE_NAMES[family.license]}, version {family.version}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * What Settings adds below its body and heading menus: the code font, and the
 * fonts on this computer. `onBodyFont` and `onHeadingFont` take a typeface id
 * and store it wherever the theme keeps those.
 */
export function FontLibraryControls({ onBodyFont, onHeadingFont }: { onBodyFont: (id: string) => void; onHeadingFont: (id: string) => void }) {
  const [, setCodeFont] = useCodeFont();
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <CodeFontPicker />
        <LocalFontsPanel onUse={(slot, id) => (slot === "body" ? onBodyFont(id) : slot === "heading" ? onHeadingFont(id) : setCodeFont(id))} />
      </div>
      <BundledFontNotice />
    </div>
  );
}
