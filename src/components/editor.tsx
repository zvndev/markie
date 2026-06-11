"use client";

import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";

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

export function Editor({ value, onChange, readOnly = false }: EditorProps) {
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
      theme="dark"
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
