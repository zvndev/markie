"use client";
// The document buffer, extracted from page.tsx so autosave, drafts, and
// flush-on-transition have one owner to attach to instead of five useStates
// scattered through a 1,900-line component. Behavior is a byte-for-byte copy
// of what page.tsx did; the existing page.*.test.tsx suites are the proof.
import { useCallback, useMemo, useState } from "react";

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

  const edit = useCallback((md: EditInput) => setContent(md), []);

  const applyExternal = useCallback((md: string) => {
    setContent(md);
    setSavedContent(md);
  }, []);

  const load = useCallback((data: LoadPayload) => {
    setContent(data.content);
    setFileName(data.name);
    setFilePath(data.path);
    // A snapshot/draft restore arrives with unsaved:true: savedContent keeps
    // its previous value so the document shows dirty until the user commits.
    if (!data.unsaved) setSavedContent(data.content);
  }, []);

  const reset = useCallback(() => {
    setContent("");
    setSavedContent("");
    setFileName(null);
    setFilePath(null);
  }, []);

  const markSaved = useCallback((md: string) => setSavedContent(md), []);

  const setLocation = useCallback((path: string | null, name: string | null) => {
    setFilePath(path);
    setFileName(name);
  }, []);

  return useMemo(
    () => ({
      content,
      savedContent,
      fileName,
      filePath,
      isDirty: content !== savedContent,
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
      edit,
      applyExternal,
      load,
      reset,
      markSaved,
      setLocation,
    ]
  );
}
