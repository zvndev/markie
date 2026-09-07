import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
import { conflictingShortcuts } from "@/lib/editor-keymap";
import { findHighlightField, sourceFindTarget } from "@/lib/source-find";
import type { SourceHandle } from "@/lib/source-handle";
import {
  editorThemeForTokens,
  findTheme,
  loadThemeStore,
  THEME_APPLIED_EVENT,
  type ThemeTokens,
} from "@/lib/theme";

// Swallow the shortcuts the app owns so CodeMirror's own binding never runs.
// Returning true marks the key handled here; the event still bubbles to the
// app's window listener, so the app action itself is unaffected.
const appShortcutGuard = Prec.highest(
  keymap.of(conflictingShortcuts().map((key) => ({ key, run: () => true })))
);

const theme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

// This module is the one place outside src/lib/source-find.ts that imports
// from @codemirror, and it is loaded on first use (src/components/source-editor.tsx).
export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  // Live sessions lock the source pane — edits must flow through the
  // collaborative View so they reach the shared Yjs doc
  readOnly?: boolean;
  // Hands the page what it needs from this pane (undo, focus, the find
  // target) without handing it the view. Called with null on unmount so
  // nothing holds a destroyed editor.
  onReady?: (handle: SourceHandle | null) => void;
}

function handleFor(view: EditorView): SourceHandle {
  return {
    undo: () => {
      cmUndo(view);
    },
    redo: () => {
      cmRedo(view);
    },
    focus: () => view.focus(),
    findTarget: () => sourceFindTarget(view),
  };
}

function currentEditorTheme(): "light" | "dark" {
  const store = loadThemeStore();
  return editorThemeForTokens(findTheme(store, store.activeId).tokens);
}

export function Editor({
  value,
  onChange,
  readOnly = false,
  onReady,
}: EditorProps) {
  const [codeTheme, setCodeTheme] = useState<"light" | "dark">(
    currentEditorTheme
  );

  useEffect(() => {
    const onTheme = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          tokens?: ThemeTokens;
          editorTheme?: "light" | "dark";
        }>
      ).detail;
      if (detail?.editorTheme) {
        setCodeTheme(detail.editorTheme);
      } else if (detail?.tokens) {
        setCodeTheme(editorThemeForTokens(detail.tokens));
      }
    };
    window.addEventListener(THEME_APPLIED_EVENT, onTheme);
    return () => window.removeEventListener(THEME_APPLIED_EVENT, onTheme);
  }, []);

  // @uiw/react-codemirror announces creation but not teardown, and this pane is
  // unmounted every time the view mode changes. Without this the find bar would
  // keep searching a destroyed view.
  useEffect(() => () => onReady?.(null), [onReady]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      onCreateEditor={(view) => onReady?.(handleFor(view))}
      extensions={[
        appShortcutGuard,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        findHighlightField,
        theme,
        EditorView.lineWrapping,
      ]}
      theme={codeTheme}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightActiveLine: true,
        foldGutter: true,
        bracketMatching: true,
        indentOnInput: true,
      }}
      className="h-full"
    />
  );
}
