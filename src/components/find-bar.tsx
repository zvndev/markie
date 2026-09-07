import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  findMatches,
  matchAtOrAfter,
  matchLabel,
  stepMatch,
  type Match,
} from "@/lib/doc-search";
import type { FindTarget } from "@/lib/find-target";

interface FindBarProps {
  open: boolean;
  // Opened straight into replace mode (⌥⌘F), rather than find alone.
  withReplace: boolean;
  // The pane being searched. Null while no editor is mounted.
  target: FindTarget | null;
  // Read-only shares can be searched but not rewritten.
  canReplace: boolean;
  // Changes whenever the document changes underneath the bar, so the match set
  // is recomputed instead of pointing at text that has moved.
  revision: string;
  onClose: () => void;
}

const fieldClass =
  "bg-transparent text-[12px] text-foreground placeholder:text-muted outline-none w-[168px]";

// How far the search trails the field. A burst of typing runs one search
// instead of one per letter, and a search is a full scan of the document text.
const QUERY_DEBOUNCE_MS = 100;

// A pill toggle for one search option. Pressed state has to be legible at a
// glance, because getting Aa wrong silently changes what you find.
function Toggle({
  on,
  onClick,
  label,
  title,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={`h-[20px] min-w-[22px] px-1.5 rounded text-[11px] leading-none transition-colors ${
        on
          ? "bg-accent text-foreground"
          : "text-muted hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {label}
    </button>
  );
}

function ActionButton({
  onClick,
  disabled,
  children,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-[22px] px-2 rounded text-[11px] text-muted hover:text-foreground hover:bg-accent/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted transition-colors whitespace-nowrap"
    >
      {children}
    </button>
  );
}

export function FindBar({
  open,
  withReplace,
  target,
  canReplace,
  revision,
  onClose,
}: FindBarProps) {
  const [query, setQuery] = useState("");
  // What the match set is actually computed from: the field, a beat later.
  const [activeQuery, setActiveQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [current, setCurrent] = useState(-1);
  // Bumped after every replacement. The document changes inside the editor
  // immediately, but the page's copy of it arrives debounced, and searching a
  // stale copy would replace the wrong text on the next click.
  const [edits, setEdits] = useState(0);

  const findInput = useRef<HTMLInputElement>(null);
  // Where the caret was when the bar opened, so the first match found is the
  // one nearest what you were reading.
  const caretOnOpen = useRef(0);

  useEffect(() => {
    if (query === activeQuery) return;
    const timer = setTimeout(() => setActiveQuery(query), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, activeQuery]);

  const matches = useMemo<Match[]>(() => {
    if (!open || !target || !activeQuery) return [];
    return findMatches(target.text(), activeQuery, { caseSensitive, wholeWord });
    // revision and edits are deps on purpose: both mean the text changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target, activeQuery, caseSensitive, wholeWord, revision, edits]);

  useEffect(() => {
    if (!open) return;
    caretOnOpen.current = target?.caret() ?? 0;
    setShowReplace((already) => already || withReplace);
    findInput.current?.focus();
    findInput.current?.select();
  }, [open, withReplace, target]);

  // Keep the current match sensible as the set changes: hold position while it
  // still exists, otherwise start again from where the caret was.
  useEffect(() => {
    if (!open) return;
    setCurrent((previous) => {
      if (matches.length === 0) return -1;
      if (previous >= 0 && previous < matches.length) return previous;
      return matchAtOrAfter(matches, caretOnOpen.current);
    });
  }, [matches, open]);

  useEffect(() => {
    if (!open || !target) return;
    target.highlight(matches, current);
    const match = matches[current];
    if (match) target.reveal(match);
  }, [matches, current, open, target]);

  const step = useCallback(
    (delta: number) => setCurrent((c) => stepMatch(matches.length, c, delta)),
    [matches.length]
  );

  // The field runs a beat ahead of the match set (QUERY_DEBOUNCE_MS). A step
  // in that beat would walk the previous query's matches under a field that
  // says something else, so Enter and the arrows settle the field first: the
  // next render lands on what it says, and the step after that moves.
  const settledQuery = query === activeQuery;
  const settleOrStep = useCallback(
    (delta: number) => {
      if (settledQuery) step(delta);
      else setActiveQuery(query);
    },
    [settledQuery, step, query]
  );

  // ⌘G steps from anywhere, including with the caret back in the document.
  // Bound here rather than on the page because the bar is what knows which
  // match is current.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.code !== "KeyG") return;
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step]);

  const close = useCallback(() => {
    target?.release(matches[current] ?? null);
    onClose();
  }, [target, matches, current, onClose]);

  // A replacement inside that beat would rewrite what the previous query
  // found, so it waits for the set to catch up rather than settling it: a
  // click that meant "replace" must not become "search again".
  const replaceCurrent = useCallback(() => {
    const match = matches[current];
    if (!match || !target || !canReplace || !settledQuery) return;
    target.replace([match], replacement);
    setEdits((n) => n + 1);
  }, [matches, current, target, canReplace, replacement, settledQuery]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0 || !target || !canReplace || !settledQuery) return;
    target.replace(matches, replacement);
    setCurrent(-1);
    setEdits((n) => n + 1);
  }, [matches, target, canReplace, replacement, settledQuery]);

  // Escape and Enter are handled here rather than on window so they only mean
  // this while the bar has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      settleOrStep(e.shiftKey ? -1 : 1);
    }
  };

  // Hidden rather than unmounted, so reopening offers the search you just ran.
  if (!open) return null;

  const count = matchLabel(matches.length, current);
  const empty = matches.length === 0;

  return (
    <div
      data-markie-find-bar
      onKeyDown={onKeyDown}
      role="search"
      aria-label="Find in document"
      className="absolute top-2 right-3 z-[60] rounded-lg border border-border shadow-2xl px-2 py-1.5 flex flex-col gap-1.5"
      style={{ background: "var(--surface-2)" }}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setShowReplace((v) => !v)}
          title={showReplace ? "Hide replace" : "Show replace"}
          aria-label={showReplace ? "Hide replace" : "Show replace"}
          aria-expanded={showReplace}
          className="h-[22px] w-[16px] text-muted hover:text-foreground text-[10px] leading-none"
        >
          {showReplace ? "▾" : "▸"}
        </button>

        <div
          className={`flex items-center gap-1 rounded-md border px-2 h-[26px] ${
            activeQuery && empty ? "border-[var(--status-red)]" : "border-border"
          }`}
          style={{ background: "var(--surface)" }}
        >
          <input
            ref={findInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            className={fieldClass}
          />
          <Toggle
            on={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
            label="Aa"
            title="Match case"
          />
          <Toggle
            on={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
            label="ab"
            title="Whole word"
          />
        </div>

        <span
          className="text-[11px] text-muted tabular-nums w-[64px] text-right"
          aria-live="polite"
        >
          {activeQuery ? count : ""}
        </span>

        <ActionButton
          onClick={() => settleOrStep(-1)}
          disabled={empty}
          title="Previous match (⇧⏎)"
        >
          ↑
        </ActionButton>
        <ActionButton
          onClick={() => settleOrStep(1)}
          disabled={empty}
          title="Next match (⏎)"
        >
          ↓
        </ActionButton>
        <ActionButton onClick={close} title="Close (Esc)">
          ✕
        </ActionButton>
      </div>

      {showReplace && (
        <div className="flex items-center gap-1.5 pl-[22px]">
          <div
            className="flex items-center rounded-md border border-border px-2 h-[26px]"
            style={{ background: "var(--surface)" }}
          >
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace"
              aria-label="Replace with"
              spellCheck={false}
              className={fieldClass}
            />
          </div>
          {canReplace ? (
            <>
              <ActionButton
                onClick={replaceCurrent}
                disabled={current < 0 || !settledQuery}
                title="Replace this match"
              >
                Replace
              </ActionButton>
              <ActionButton
                onClick={replaceAll}
                disabled={empty || !settledQuery}
                title="Replace every match"
              >
                All
              </ActionButton>
            </>
          ) : (
            // Saying why beats a pair of dead buttons.
            <span className="text-[11px] text-muted px-1">
              View only
            </span>
          )}
        </div>
      )}
    </div>
  );
}
