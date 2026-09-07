// The source pane, loaded on first use.
//
// CodeMirror, its markdown grammar and the table of lazily loaded code
// languages are a good share of the renderer bundle, and a launch into Rich
// view never runs any of it. This wrapper puts the real editor
// (src/components/editor.tsx, the only module allowed to import from
// @codemirror) behind a dynamic import, shows the document's own text while
// the chunk arrives, and offers a preload so a launch into Rich view has the
// editor ready before the first switch to Source.
import { lazy, Suspense } from "react";
import type { EditorProps } from "@/components/editor";

const load = () => import("@/components/editor");
const LazyEditor = lazy(() => load().then((m) => ({ default: m.Editor })));

let preloaded = false;
/** Fetch the editor chunk when the app is idle, so the first Source view is instant. */
export function preloadSourceEditor(): void {
  if (preloaded) return;
  preloaded = true;
  const idle =
    typeof window !== "undefined" && "requestIdleCallback" in window
      ? (cb: () => void) => window.requestIdleCallback(cb, { timeout: 2000 })
      : (cb: () => void) => setTimeout(cb, 0);
  idle(() => void load().catch(() => {}));
}

// Only the head of the document: the placeholder stands for a few dozen
// milliseconds, and laying out every line of a large file would cost more
// than the wait it covers. Bounded in characters as well as lines, because a
// document can be one line of several megabytes; the placeholder is a picture
// of the top of the document, not the document.
const PLACEHOLDER_LINES = 200;
const PLACEHOLDER_CHARS = 64_000;

function SourcePlaceholder({ value }: { value: string }) {
  const head = value.slice(0, PLACEHOLDER_CHARS).split("\n", PLACEHOLDER_LINES).join("\n");
  return (
    <pre
      data-markie-source-loading
      aria-busy="true"
      className="h-full m-0 overflow-hidden px-3 py-2 font-mono text-[13px] leading-[1.5] text-muted whitespace-pre-wrap"
    >
      {head}
    </pre>
  );
}

export function SourceEditor(props: EditorProps) {
  return (
    <Suspense fallback={<SourcePlaceholder value={props.value} />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}
