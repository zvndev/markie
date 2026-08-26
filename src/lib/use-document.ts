"use client";
// The document buffer, extracted from page.tsx so autosave, drafts, and
// flush-on-transition have one owner to attach to instead of five useStates
// scattered through a 1,900-line component. Behavior is a byte-for-byte copy
// of what page.tsx did; the existing page.*.test.tsx suites are the proof.
import { useCallback, useMemo, useRef, useState } from "react";

export interface LoadPayload {
  name: string;
  content: string;
  path: string | null;
  unsaved?: boolean;
}

/** Same shape React's setState accepts, because a transform needs the live buffer. */
export type EditInput = string | ((previous: string) => string);

export function useDocument() {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);

  // The buffer as of the last write to it, which is ahead of `content`
  // whenever React has not re-rendered yet. Autosave can fire from a timer in
  // that window, and a save must never write the text as it stood one
  // serializer tick ago; latest() is what it reads.
  const latestRef = useRef("");
  const write = useCallback((md: EditInput) => {
    const value = typeof md === "function" ? md(latestRef.current) : md;
    latestRef.current = value;
    setContent(value);
  }, []);

  const edit = write;

  const applyExternal = useCallback(
    (md: string) => {
      write(md);
      setSavedContent(md);
    },
    [write]
  );

  const load = useCallback(
    (data: LoadPayload) => {
      write(data.content);
      setFileName(data.name);
      setFilePath(data.path);
      // A snapshot/draft restore arrives with unsaved:true: savedContent keeps
      // its previous value so the document shows dirty until the user commits.
      if (!data.unsaved) setSavedContent(data.content);
    },
    [write]
  );

  const reset = useCallback(() => {
    write("");
    setSavedContent("");
    setFileName(null);
    setFilePath(null);
  }, [write]);

  const markSaved = useCallback((md: string) => setSavedContent(md), []);

  const setLocation = useCallback((path: string | null, name: string | null) => {
    setFilePath(path);
    setFileName(name);
  }, []);

  const latest = useCallback(() => latestRef.current, []);

  return useMemo(
    () => ({
      content,
      savedContent,
      fileName,
      filePath,
      isDirty: content !== savedContent,
      latest,
      edit,
      applyExternal,
      load,
      reset,
      markSaved,
      setLocation,
    }),
    [
      content,
      savedContent,
      fileName,
      filePath,
      latest,
      edit,
      applyExternal,
      load,
      reset,
      markSaved,
      setLocation,
    ]
  );
}
