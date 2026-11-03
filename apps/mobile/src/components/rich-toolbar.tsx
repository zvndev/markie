// The formatting row that sits on top of the keyboard while the rich editor
// has focus. Every button runs the desktop format rail's own command
// (src/components/format-rail.tsx COMMON), so the phone and the computer
// format a document identically; only the size of the targets differs.
import type { ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { COMMON, railActiveStates } from "@/components/format-rail";
import { haptics } from "../lib/native";

interface RichToolbarProps {
  editor: Editor;
  /** Read-only: the row shows only what still applies (commenting). */
  locked: boolean;
  onLink: () => void;
  /** Present when this document takes comments; enabled with a selection. */
  onComment?: () => void;
}

// The order a thumb reaches for them: inline marks, then blocks.
const ORDER = ["bold", "italic", "h1", "h2", "h3", "bullet", "ordered", "task", "quote", "strike", "code", "codeblock", "table", "hr"];
const BUTTONS = ORDER.map((key) => COMMON.find((button) => button.key === key)).filter((button): button is (typeof COMMON)[number] => !!button);

// Solo documents undo through TipTap's history; live ones through the room's
// own undo manager. Either way the command may be missing for a moment.
function can(editor: Editor | null, command: "undo" | "redo"): boolean {
  if (!editor || editor.isDestroyed) return false;
  try {
    const check = editor.can() as unknown as Record<string, (() => boolean) | undefined>;
    return typeof check[command] === "function" ? !!check[command]!() : false;
  } catch {
    return false;
  }
}

export function RichToolbar({ editor, locked, onLink, onComment }: RichToolbarProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      active: railActiveStates(e),
      selecting: !!e && !e.state.selection.empty,
      canUndo: can(e, "undo"),
      canRedo: can(e, "redo"),
    }),
  });
  const run = (fn: () => void) => { haptics.selection(); fn(); };
  return (
    <div className="m-keyboard-bar m-rich-tools" role="toolbar" aria-label="Formatting">
      {onComment ? (
        <ToolButton label="Comment on the selection" className="m-tool-comment" disabled={!state.selecting} onClick={() => run(onComment)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M12 7.5v6M9 10.5h6" /></svg>
        </ToolButton>
      ) : null}
      {locked ? null : (
        <>
          <ToolButton label="Undo" disabled={!state.canUndo} onClick={() => run(() => editor.chain().focus().undo().run())}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
          </ToolButton>
          <ToolButton label="Redo" disabled={!state.canRedo} onClick={() => run(() => editor.chain().focus().redo().run())}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
          </ToolButton>
          <span className="m-tool-divider" aria-hidden="true" />
          {BUTTONS.map((button) => (
            <ToolButton
              key={button.key}
              label={button.title.replace(/\s*\(.*\)$/, "")}
              className={`m-tool-${button.key}`}
              active={button.active ? !!button.active(state.active) : false}
              onClick={() => run(() => button.run(editor))}
            >
              {button.label}
            </ToolButton>
          ))}
          <ToolButton label={state.active.link ? "Remove link" : "Link"} active={!!state.active.link} onClick={() => run(onLink)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
          </ToolButton>
        </>
      )}
    </div>
  );
}

export function ToolButton({ label, active = false, disabled = false, className = "", onClick, children }: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`m-tool${active ? " is-active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keeps the editor's focus and selection: a tap that moved focus would collapse it first.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
