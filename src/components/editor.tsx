"use client";

import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import {
  editorThemeForTokens,
  findTheme,
  loadThemeStore,
  THEME_APPLIED_EVENT,
  type ThemeTokens,
} from "@/lib/theme";

const theme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  // Live sessions lock the source pane — edits must flow through the
  // collaborative View so they reach the shared Yjs doc
  readOnly?: boolean;
}

function currentEditorTheme(): "light" | "dark" {
  const store = loadThemeStore();
  return editorThemeForTokens(findTheme(store, store.activeId).tokens);
}

export function Editor({ value, onChange, readOnly = false }: EditorProps) {
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

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      extensions={[
        markdown({ base: markdownLanguage, codeLanguages: languages }),
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
