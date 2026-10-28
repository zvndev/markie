// Writing on the phone: a document's source in one full-screen box, saved to
// Markie Cloud through the same versioned route the desktop's sync uses. A
// save that started from an old version is refused by the server, never
// merged over, so an edit here can't silently undo one made on the computer.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { ApiError, type ApiClient } from "../lib/api";
import type { DocFormat } from "../lib/docs";
import { haptics } from "../lib/native";
import { useKeyboardInset } from "../lib/keyboard-inset";
import { applyMarkdownAction, type MarkdownAction } from "../lib/markdown-edits";
import { displayName } from "../lib/recent";
import { Screen } from "../components/screen";
import { AlertIcon } from "../components/icons";

/** What the editor opens: a version of a cloud document, or text that isn't in the cloud yet. */
export type EditorDraft =
  | { kind: "cloud"; id: string; name: string; format: DocFormat; content: string; version: number }
  | { kind: "new"; name: string; format: DocFormat; content: string };

interface EditorProps {
  api: ApiClient;
  draft: EditorDraft;
  /** reload: the document changed elsewhere, so the screen underneath should read it again. */
  onCancel: (reload?: boolean) => void;
  /** The saved document's id. A new document has just been created under it. */
  onSaved: (saved: { id: string; name: string; created: boolean }) => void;
  onUnauthorized: () => void;
  /** Android's back button asks the editor first, so unsaved text isn't dropped. */
  backGuard: MutableRefObject<(() => void) | null>;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "conflict" }
  | { status: "error"; message: string };

const MARKDOWN_ACTIONS: { action: MarkdownAction; label: string; text: string }[] = [
  { action: "heading", label: "Heading", text: "H" },
  { action: "bold", label: "Bold", text: "B" },
  { action: "italic", label: "Italic", text: "I" },
  { action: "list", label: "Bulleted list", text: "•" },
  { action: "task", label: "Checklist", text: "☐" },
  { action: "link", label: "Link", text: "Link" },
  { action: "code", label: "Code", text: "</>" },
];

export function EditorScreen({ api, draft, onCancel, onSaved, onUnauthorized, backGuard }: EditorProps) {
  const [value, setValue] = useState(draft.content);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const box = useRef<HTMLTextAreaElement>(null);
  const keyboard = useKeyboardInset();
  const dirty = value !== draft.content;
  const isNew = draft.kind === "new";
  const prose = draft.format === "markdown" || (draft.format === "text" && /\.(txt|text)$/i.test(draft.name));

  const cancel = useCallback(() => {
    if (save.status === "saving") return;
    if (dirty && !window.confirm(isNew ? "Discard this document? It hasn't been saved." : "Discard your changes? They haven't been saved.")) return;
    onCancel();
  }, [dirty, isNew, onCancel, save.status]);

  useEffect(() => {
    backGuard.current = cancel;
    return () => { if (backGuard.current === cancel) backGuard.current = null; };
  }, [backGuard, cancel]);

  // A new document starts with the caret in it; an existing one opens to read first.
  useEffect(() => {
    if (!isNew) return;
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isNew]);

  const write = useCallback(async (asCopy: boolean) => {
    setSave({ status: "saving" });
    try {
      if (draft.kind === "cloud" && !asCopy) {
        const saved = await api.saveDoc({ id: draft.id, name: draft.name, content: value, baseVersion: draft.version });
        haptics.success();
        onSaved({ id: saved.id, name: draft.name, created: false });
        return;
      }
      const name = asCopy ? copyName(draft.name) : draft.name;
      const created = await api.createDoc({ name, content: value });
      haptics.success();
      onSaved({ id: created.id, name, created: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
      if (error instanceof ApiError && error.status === 409 && error.code === "conflict") { setSave({ status: "conflict" }); return; }
      setSave({ status: "error", message: error instanceof Error ? error.message : "Couldn't save. Try again." });
    }
  }, [api, draft, onSaved, onUnauthorized, value]);

  const format = useCallback((action: MarkdownAction) => {
    const el = box.current;
    if (!el) return;
    haptics.selection();
    const next = applyMarkdownAction({ value, start: el.selectionStart, end: el.selectionEnd }, action);
    setValue(next.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  }, [value]);

  const saving = save.status === "saving";
  const canSave = !saving && (isNew || dirty);

  return (
    <Screen
      title={displayName(draft.name)}
      leading={<button type="button" className="m-nav-text" onClick={cancel} disabled={saving}>Cancel</button>}
      actions={
        <button type="button" className="m-nav-text m-nav-text-strong" onClick={() => void write(false)} disabled={!canSave}>
          {saving ? <span className="m-spinner m-spinner-small" aria-hidden="true" /> : null}
          {saving ? "Saving" : isNew ? "Create" : "Save"}
        </button>
      }
      fill
      className="m-editor-screen"
    >
      <div className="m-editor" style={{ paddingBottom: keyboard }}>
        {save.status === "conflict" ? (
          <div className="m-editor-banner" role="alert">
            <AlertIcon size={18} />
            <div>
              <strong>Someone saved this document while you were editing.</strong>
              <p>Your text is still here. Keep it as a separate copy, or throw it away and read the newer version.</p>
              <div className="m-editor-banner-actions">
                <button type="button" className="m-button m-button-small m-button-primary" onClick={() => void write(true)}>Save as a copy</button>
                <button type="button" className="m-button m-button-small m-button-secondary" onClick={() => onCancel(true)}>Discard mine</button>
              </div>
            </div>
          </div>
        ) : null}
        {save.status === "error" ? <p className="m-editor-error" role="alert">{save.message}</p> : null}
        {draft.format === "markdown" ? (
          <div className="m-editor-tools" role="toolbar" aria-label="Formatting">
            {MARKDOWN_ACTIONS.map((item) => (
              <button
                key={item.action}
                type="button"
                className={`m-editor-tool m-editor-tool-${item.action}`}
                aria-label={item.label}
                // Keeps the selection: a tap that moved focus would collapse it first.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => format(item.action)}
              >
                {item.text}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={box}
          className={`m-editor-text${prose ? "" : " is-code"}`}
          value={value}
          onChange={(event) => { setValue(event.target.value); if (save.status === "error") setSave({ status: "idle" }); }}
          aria-label={`Text of ${displayName(draft.name)}`}
          spellCheck={prose}
          autoCorrect={prose ? "on" : "off"}
          autoCapitalize={prose ? "sentences" : "none"}
          readOnly={saving}
        />
      </div>
    </Screen>
  );
}

/** "Plan.md" becomes "Plan (copy).md". */
export function copyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (copy)${name.slice(dot)}` : `${name} (copy)`;
}
