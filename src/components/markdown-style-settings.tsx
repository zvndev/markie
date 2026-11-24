// Settings › Appearance › Markdown style. How headings, lists, tables and the
// rest are drawn, apart from colours and faces: six presets, your own saved
// styles, and the way into the editor that builds one.
import "./markdown-style.css";
import { useEffect, useId, useRef, useState } from "react";
import { COLOR_MODE_CHANGED_EVENT } from "@/lib/color-mode";
import {
  MARKDOWN_STYLE_PRESETS,
  activeMarkdownStyleName,
  chooseMarkdownStyle,
  deleteMarkdownStyle,
  duplicateMarkdownStyle,
  findMarkdownStylePreset,
  markdownStyleEdited,
  newMarkdownStyleProfileId,
  renameMarkdownStyle,
  type MarkdownStyleStore,
} from "@/lib/markdown-style";
import { MARKDOWN_STYLE_STORE_EVENT, commitMarkdownStyleStore, loadMarkdownStyleStore } from "@/lib/markdown-style-store";
import { pushCloudThemes } from "@/lib/theme-sync";
import { MarkdownStyleEditor } from "./markdown-style-editor";
import { MarkdownStyleScope } from "./markdown-style-scope";

function useMarkdownStyleSettings() {
  const [store, setStore] = useState<MarkdownStyleStore>(loadMarkdownStyleStore);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The palette, another window's sync and a template change can all move the
  // store while this is open; re-read rather than keep a stale copy.
  useEffect(() => {
    const sync = () => setStore(loadMarkdownStyleStore());
    window.addEventListener(MARKDOWN_STYLE_STORE_EVENT, sync);
    window.addEventListener(COLOR_MODE_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(MARKDOWN_STYLE_STORE_EVENT, sync);
      window.removeEventListener(COLOR_MODE_CHANGED_EVENT, sync);
    };
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

  return {
    store,
    // A slider fires on every tick; the account copy only needs the value settled on.
    commit: (next: MarkdownStyleStore, live = false) => {
      setStore(commitMarkdownStyleStore(next));
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = null;
      if (live) {
        pushTimer.current = setTimeout(() => {
          pushTimer.current = null;
          pushCloudThemes();
        }, 600);
      } else {
        pushCloudThemes(); // no-op when signed out
      }
    },
  };
}

export function MarkdownStyleSection() {
  const { store, commit } = useMarkdownStyleSettings();
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const titleId = useId();
  const profile = store.profiles.find((entry) => entry.id === store.activeId);
  const edited = markdownStyleEdited(store);
  const newId = () => newMarkdownStyleProfileId(store.profiles.map((entry) => entry.id));

  const rename = () => {
    if (profile && renaming?.trim()) commit(renameMarkdownStyle(store, profile.id, renaming));
    setRenaming(null);
  };

  return (
    <section className="mb-5" aria-labelledby={titleId} data-markdown-style-section="">
      <div className="mb-3">
        <h3 id={titleId} className="markie-overlay-section">Markdown style</h3>
        <div className="text-[11px] text-muted mt-1">
          How headings, lists, tables and the rest are drawn, and in which typefaces. A style works with any template&apos;s colours. Every style but Spacious brings its own fonts; one you choose yourself under Typography is used instead.
        </div>
      </div>

      <div className="markie-template-grid mb-3" role="radiogroup" aria-label="Markdown styles">
        {MARKDOWN_STYLE_PRESETS.map((preset) => (
          <StyleCard
            key={preset.id}
            name={preset.name}
            description={preset.description}
            badge={store.activeId === preset.id && edited ? "Edited" : undefined}
            // The card of the style in use shows it as it is being drawn, edits included.
            style={store.activeId === preset.id && edited ? store.draft : { base: preset.id }}
            selected={store.activeId === preset.id}
            onSelect={() => commit(chooseMarkdownStyle(store, preset.id))}
          />
        ))}
        {store.profiles.map((entry) => (
          <StyleCard
            key={entry.id}
            name={entry.name}
            description={`Your style, built on ${findMarkdownStylePreset(entry.style.base)?.name ?? "Spacious"}`}
            badge={store.activeId === entry.id && edited ? "Edited" : undefined}
            style={store.activeId === entry.id && edited ? store.draft : entry.style}
            selected={store.activeId === entry.id}
            onSelect={() => commit(chooseMarkdownStyle(store, entry.id))}
          />
        ))}
      </div>

      <div className="markie-style-actions">
        <span className="text-[11px] text-muted min-w-0 truncate" data-markdown-style-current="">
          In use: {activeMarkdownStyleName(store)}
        </span>
        {renaming !== null && profile ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              rename();
            }}
          >
            <input
              autoFocus
              aria-label="New name for this style"
              value={renaming}
              maxLength={60}
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // Leaves the field, not the Settings dialog.
                  event.stopPropagation();
                  event.nativeEvent.stopImmediatePropagation();
                  setRenaming(null);
                }
              }}
              className="markie-style-name-field"
            />
            <button type="submit" disabled={!renaming.trim()} data-primary="true" className="markie-overlay-button markie-style-button">Rename</button>
            <button type="button" onClick={() => setRenaming(null)} className="markie-overlay-button markie-style-button">Cancel</button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {profile ? (
              <>
                <button type="button" onClick={() => commit(deleteMarkdownStyle(store, profile.id))} className="markie-overlay-button markie-style-button">Delete</button>
                <button type="button" onClick={() => setRenaming(profile.name)} className="markie-overlay-button markie-style-button">Rename</button>
              </>
            ) : null}
            <button type="button" onClick={() => commit(duplicateMarkdownStyle(store, store.activeId, newId()))} className="markie-overlay-button markie-style-button">
              Duplicate
            </button>
            <button type="button" onClick={() => setEditing(true)} data-markdown-style-customize="" data-primary="true" className="markie-overlay-button markie-style-button">
              Customize…
            </button>
          </div>
        )}
      </div>

      {editing ? <MarkdownStyleEditor store={store} onCommit={commit} onClose={() => setEditing(false)} /> : null}
    </section>
  );
}

// A miniature document drawn in the style itself, so a card cannot disagree
// with what the style does.
function StyleCard({
  name,
  description,
  badge,
  style,
  selected,
  onSelect,
}: {
  name: string;
  description: string;
  badge?: string;
  style: unknown;
  selected: boolean;
  onSelect: () => void;
}) {
  const descriptionId = useId();
  return (
    <button type="button" role="radio" aria-checked={selected} aria-label={name} aria-describedby={descriptionId} onClick={onSelect} className="markie-template-card">
      <MarkdownStyleScope style={style} className="markie-style-card-preview">
        <div className="markdown-body" aria-hidden="true">
          <h1>Field notes</h1>
          <p>
            Read the <a>tide table</a> before you set out.
          </p>
          <ul>
            <li>Trim the lamp</li>
            <li>Sign the log</li>
          </ul>
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Wind</th>
                <th>Sea</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Mon</td>
                <td>NW 5</td>
                <td>Calm</td>
              </tr>
              <tr>
                <td>Tue</td>
                <td>W 7</td>
                <td>Rough</td>
              </tr>
            </tbody>
          </table>
        </div>
      </MarkdownStyleScope>
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
