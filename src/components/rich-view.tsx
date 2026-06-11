"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";

interface RichViewProps {
  value: string; // canonical markdown
  onChange: (md: string) => void;
  onEditorReady?: (editor: Editor | null) => void;
}

export function RichView({ value, onChange, onEditorReady }: RichViewProps) {
  // Guards the echo loop: rich edits → onChange(md) → value prop comes back
  // identical and must not re-parse (which would reset the cursor).
  const lastEmitted = useRef<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image,
      Placeholder.configure({ placeholder: "Start typing or open a file" }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
        tightLists: true,
        transformPastedText: true,
      }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const md = (
          editor.storage as unknown as {
            markdown: { getMarkdown(): string };
          }
        ).markdown.getMarkdown();
        lastEmitted.current = md;
        onChange(md);
      }, 250);
    },
  });

  useEffect(() => {
    onEditorReady?.(editor);
    // Test/debug handle for driving the editor via CDP (local desktop app)
    (window as unknown as { __markieEditor?: Editor | null }).__markieEditor =
      editor;
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // External value changes (CodeMirror edits, file opens) re-parse into the editor
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(value);
  }, [value, editor]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  return (
    <div className="h-full overflow-y-auto px-10 py-8">
      <article className="markdown-body max-w-3xl mx-auto">
        <EditorContent editor={editor} />
      </article>
    </div>
  );
}
