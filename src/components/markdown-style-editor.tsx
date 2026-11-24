// The style editor: build your own look for how Markdown is drawn. Presets
// first, then one row per element (headings, lists, tables, ...) with its
// details behind it, and beside them a live preview of a sample document
// that uses every element. Every change is drawn at once, in the preview and
// in the app, as an unsaved edit ("Spacious (edited)") until it is saved as
// a named style.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  MARKDOWN_STYLE_CHOICES,
  MARKDOWN_STYLE_CHOICE_LABELS,
  MARKDOWN_STYLE_FONT_KEYS,
  MARKDOWN_STYLE_GROUPS,
  MARKDOWN_STYLE_NUMBERS,
  MARKDOWN_STYLE_NUMBER_LABELS,
  MARKDOWN_STYLE_PRESETS,
  activeMarkdownStyle,
  activeMarkdownStyleName,
  chooseMarkdownStyle,
  discardMarkdownStyleDraft,
  editMarkdownStyle,
  findMarkdownStylePreset,
  markdownStyleEdited,
  markdownStyleGroupChanged,
  newMarkdownStyleProfileId,
  resetMarkdownStyleGroup,
  resolveMarkdownStyle,
  saveMarkdownStyleAs,
  saveMarkdownStyleEdits,
  type MarkdownStyleChoiceKey,
  type MarkdownStyleGroup,
  type MarkdownStyleNumberKey,
  type MarkdownStyleStore,
} from "@/lib/markdown-style";
import { findTypeface } from "@/lib/fonts/registry";
import { loadCodeFont } from "@/lib/fonts/code-font";
import { loadThemeStore } from "@/lib/theme";
import { FontPicker, type FontChoice } from "./font-library";
import { MarkdownStyleScope } from "./markdown-style-scope";
import { SelectChevron } from "./select-chevron";

// Where the preview scrolls to when an element's row is opened, so the thing
// being changed is the thing in view.
const GROUP_TARGET: Record<string, string> = {
  headings: "h2",
  spacing: "p",
  bullets: "ul",
  numbered: "ol",
  "list-layout": "ul",
  tasks: ".contains-task-list, .task-list-item",
  tables: "table",
  quotes: "blockquote",
  code: "pre",
  dividers: "hr",
  images: "img",
  links: "h5",
};

export function MarkdownStyleEditor({
  store,
  onCommit,
  onClose,
}: {
  store: MarkdownStyleStore;
  /** Save and paint. `live` marks a slider tick, so the account copy can wait for the value settled on. */
  onCommit: (next: MarkdownStyleStore, live?: boolean) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);

  const style = activeMarkdownStyle(store);
  const resolved = resolveMarkdownStyle(style);
  const edited = markdownStyleEdited(store);
  const profile = store.profiles.find((entry) => entry.id === store.activeId);
  const presetName = findMarkdownStylePreset(resolved.base)?.name ?? "Spacious";
  // A face the person picked themselves stands over the style's (theme.ts findTheme).
  const ownFonts = ownFontChoices();

  // The render pipeline is large and only needed here, so it loads with the editor.
  useEffect(() => {
    let live = true;
    void Promise.all([import("@/lib/markdown-html"), import("@/lib/markdown-style-sample")]).then(([{ renderMarkdownHTML }, { MARKDOWN_STYLE_SAMPLE }]) => {
      if (live) setHtml(renderMarkdownHTML(MARKDOWN_STYLE_SAMPLE));
    });
    return () => {
      live = false;
    };
  }, []);

  // Escape closes the editor, not the Settings dialog behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An open font menu takes its own Escape.
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      event.stopPropagation();
      if (naming !== null) setNaming(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [naming, onClose]);

  const toggle = (group: MarkdownStyleGroup) => {
    const next = open === group.id ? null : group.id;
    setOpen(next);
    if (!next) return;
    const target = preview.current?.querySelector(GROUP_TARGET[group.id] ?? "h1");
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // The typefaces are the whole page; there is nowhere to scroll to.
    if (group.id !== "typefaces") target?.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
  };

  const saveAs = () => {
    const name = (naming ?? "").trim();
    if (!name) return;
    onCommit(saveMarkdownStyleAs(store, name, newMarkdownStyleProfileId(store.profiles.map((entry) => entry.id))));
    setNaming(null);
  };

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[110] flex items-center justify-center"
      data-markdown-style-editor=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="markie-overlay-panel overlay-panel-enter markie-style-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="markie-style-editor-head">
          <div className="markie-style-editor-title">
            <h2 id={titleId} className="text-[14px] font-semibold text-foreground">Markdown style</h2>
            <div className="text-[11px] text-muted mt-0.5 truncate" data-markdown-style-name="">
              {activeMarkdownStyleName(store)}
              {edited ? ". Not saved yet." : ""}
            </div>
          </div>
          {naming !== null ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                saveAs();
              }}
            >
              <input
                autoFocus
                aria-label="Name for the new style"
                value={naming}
                maxLength={60}
                onChange={(event) => setNaming(event.target.value)}
                className="markie-style-name-field"
              />
              <button type="submit" disabled={!naming.trim()} data-primary="true" className="markie-overlay-button markie-style-button">Save</button>
              <button type="button" onClick={() => setNaming(null)} className="markie-overlay-button markie-style-button">Cancel</button>
            </form>
          ) : (
            <>
              {edited ? (
                <button type="button" onClick={() => onCommit(discardMarkdownStyleDraft(store))} className="markie-overlay-button markie-style-button">
                  Discard changes
                </button>
              ) : null}
              {edited && profile ? (
                <button type="button" onClick={() => onCommit(saveMarkdownStyleEdits(store))} data-primary="true" className="markie-overlay-button markie-style-button">
                  Save to {profile.name}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setNaming(profile ? `${profile.name} copy` : edited ? `My ${presetName}` : `${presetName} copy`)}
                data-primary={edited && !profile ? "true" : undefined}
                data-markdown-style-save-as=""
                className="markie-overlay-button markie-style-button"
              >
                Save as new style…
              </button>
            </>
          )}
          <button onClick={onClose} aria-label="Close the style editor" className="markie-overlay-close">×</button>
        </div>

        <div className="markie-style-editor-body">
          <div className="markie-style-controls">
            <div className="markie-overlay-section">Start from</div>
            <div className="markie-style-start" role="radiogroup" aria-label="Start from a style">
              {MARKDOWN_STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={store.activeId === preset.id}
                  title={preset.description}
                  onClick={() => onCommit(chooseMarkdownStyle(store, preset.id))}
                  className="markie-overlay-button markie-style-chip"
                >
                  {preset.name}
                </button>
              ))}
              {store.profiles.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={store.activeId === entry.id}
                  onClick={() => onCommit(chooseMarkdownStyle(store, entry.id))}
                  className="markie-overlay-button markie-style-chip"
                >
                  {entry.name}
                </button>
              ))}
            </div>

            {MARKDOWN_STYLE_GROUPS.map((group) => {
              const changed = markdownStyleGroupChanged(style, group);
              const expanded = open === group.id;
              return (
                <section key={group.id} className="markie-style-group" data-markdown-style-group={group.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`${titleId}-${group.id}`}
                    onClick={() => toggle(group)}
                    className="markie-overlay-button markie-style-group-head"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-foreground">{group.label}</span>
                      <span className="block text-[11px] text-muted truncate">{expanded ? group.hint : summary(group, resolved)}</span>
                    </span>
                    {changed ? <span className="markie-style-group-dot" title={`Changed from ${presetName}`} aria-label={`Changed from ${presetName}`} /> : null}
                    <SelectChevron />
                  </button>
                  {expanded ? (
                    <div id={`${titleId}-${group.id}`} className="markie-style-group-body">
                      {group.choices.map((key) => (
                        <ChoiceRow
                          key={key}
                          choice={key}
                          value={resolved.choices[key]}
                          onChange={(value) => onCommit(editMarkdownStyle(store, { choices: { [key]: value } }))}
                        />
                      ))}
                      {group.numbers.map((key) => (
                        <NumberRow
                          key={key}
                          number={key}
                          value={resolved.numbers[key]}
                          onChange={(value) => onCommit(editMarkdownStyle(store, { numbers: { [key]: value } }), true)}
                        />
                      ))}
                      {group.id === "typefaces" && ownFonts ? (
                        <p className="text-[11px] text-muted" data-markdown-style-own-fonts="">
                          You chose {ownFonts} yourself in Typography, and that choice is used instead. Reset it there to see this style&apos;s.
                        </p>
                      ) : null}
                      {group.id === "images" ? (
                        <p className="text-[11px] text-muted">A caption is italic text on the line straight after a picture.</p>
                      ) : null}
                      <div>
                        <button
                          type="button"
                          disabled={!changed}
                          onClick={() => onCommit(resetMarkdownStyleGroup(store, group))}
                          className="markie-overlay-button markie-style-button"
                        >
                          Reset to {presetName}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>

          <MarkdownStyleScope style={style} className="markie-style-preview" data-markdown-style-preview="">
            <div ref={preview} className="markdown-body" aria-label="Preview of a sample document" role="document">
              {html === null ? <p className="text-muted">Drawing the sample…</p> : <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />}
            </div>
          </MarkdownStyleScope>
        </div>
      </div>
    </div>
  );
}

/** Which faces the person set themselves, in words, or "" for none. */
function ownFontChoices(): string {
  const typography = loadThemeStore().typography ?? {};
  const own = [typography.bodyFont ? "the text font" : "", typography.headingFont ? "the heading font" : "", loadCodeFont() ? "the code font" : ""].filter(Boolean);
  return own.length > 1 ? `${own.slice(0, -1).join(", ")} and ${own[own.length - 1]}` : (own[0] ?? "");
}

/** What a closed row says about itself: its current choices, in words. */
function summary(group: MarkdownStyleGroup, resolved: ReturnType<typeof resolveMarkdownStyle>): string {
  const parts = group.choices.slice(0, 3).map((key) => (MARKDOWN_STYLE_CHOICE_LABELS[key].options as Record<string, string>)[resolved.choices[key]]);
  if (parts.length < 3) for (const key of group.numbers.slice(0, 3 - parts.length)) parts.push(MARKDOWN_STYLE_NUMBER_LABELS[key].format(resolved.numbers[key]));
  return parts.join(", ");
}

/** A typeface choice as the font picker's list: the template's own first, then every face by group. */
function faceChoices(choice: MarkdownStyleChoiceKey): FontChoice[] {
  const labels = MARKDOWN_STYLE_CHOICE_LABELS[choice].options as Record<string, string>;
  return (MARKDOWN_STYLE_CHOICES[choice] as readonly string[]).map((id) => {
    const face = findTypeface(id);
    return { id, label: labels[id], stack: face?.stack ?? "inherit", group: face?.group };
  });
}

function ChoiceRow({ choice, value, onChange }: { choice: MarkdownStyleChoiceKey; value: string; onChange: (value: string) => void }) {
  const { label, options } = MARKDOWN_STYLE_CHOICE_LABELS[choice];
  // Thirty faces do not fit a row of chips: a typeface gets the font picker,
  // each name drawn in its own face.
  if ((MARKDOWN_STYLE_FONT_KEYS as readonly string[]).includes(choice)) {
    return (
      <div data-markdown-style-font={choice}>
        <FontPicker label={label} value={value} choices={faceChoices(choice)} onChange={onChange} />
      </div>
    );
  }
  return (
    <div>
      <div className="text-[11px] text-muted mb-1.5">{label}</div>
      <div className="markie-style-options" role="radiogroup" aria-label={label}>
        {(MARKDOWN_STYLE_CHOICES[choice] as readonly string[]).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            data-markdown-style-option={`${choice}:${option}`}
            onClick={() => onChange(option)}
            className="markie-overlay-button markie-style-chip"
          >
            {(options as Record<string, string>)[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumberRow({ number, value, onChange }: { number: MarkdownStyleNumberKey; value: number; onChange: (value: number) => void }) {
  const id = useId();
  const { min, max, step } = MARKDOWN_STYLE_NUMBERS[number];
  const { label, format } = MARKDOWN_STYLE_NUMBER_LABELS[number];
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label htmlFor={id} className="text-[11px] text-muted">{label}</label>
        <span className="text-[11px] text-muted tabular-nums">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Math.round(Number(event.target.value) * 1000) / 1000)}
        className="markie-range"
        style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      />
    </div>
  );
}
