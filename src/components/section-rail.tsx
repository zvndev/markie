// The section rail: a column of short tick marks at the left edge of a long
// document, one per H1 to H3, modeled on the T3 Code thread minimap.
//
// Ticks are stacked compactly and centred in the rail rather than placed at
// their heading's scroll position. Placed proportionally, short sections
// collide into clumps too tight to point at and long ones leave gaps, so the
// rail stops reading as an outline; stacked, every heading gets the same
// target and the shape of the document reads at a glance.
//
// The rich view and the source view each supply the headings and how to find
// and reach them (RichSectionRail below; SourceSectionRail, mounted by the
// CodeMirror wrapper in src/components/editor.tsx). Super-nightly only, behind
// nightlyFeaturesEnabled().
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { BRAND_COLORS } from "@/lib/brand";
import { nightlyFeaturesEnabled } from "@/lib/nightly";
import {
  activeSectionIndex,
  clipSnippet,
  extractSections,
  levelsThatFit,
  railWanted,
  SNIPPET_CHARS,
  tickPitch,
  TICK_LENGTH,
  type Section,
  type SectionLevel,
  type SourceSection,
} from "@/lib/section-outline";

const RAIL_WIDTH = 24;
const CARD_WIDTH = 280;
const GAP = 8;

export interface SectionRailProps {
  sections: readonly Section[];
  /** The element that scrolls the document. */
  scroller: HTMLElement | null;
  /** Each section's top, in the scroller's content coordinates (scrollTop space). */
  measure: () => number[];
  onSelect: (index: number) => void;
  /**
   * "overlay" floats the rail over the scroller's left padding without taking
   * width (the rich view's empty margin); "column" takes its own 24px (the
   * source view, whose left edge is the line-number gutter).
   */
  placement: "overlay" | "column";
}

interface Card {
  index: number;
  top: number;
  left: number;
}

export function SectionRail({ sections, scroller, measure, onSelect, placement }: SectionRailProps) {
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  });
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(-1);
  const [railHeight, setRailHeight] = useState(0);
  // The section last chosen from the rail; see activeSectionIndex. For the
  // first second it wins outright, so a smooth scroll on its way there does
  // not light every tick it passes.
  const pin = useRef<{ index: number; at: number } | null>(null);
  const refresh = useRef<() => void>(() => {});

  // Scroll, resize and content changes all come down to the same two
  // questions: is the document long enough, and which section is on screen.
  useEffect(() => {
    if (!scroller) {
      setVisible(false);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const { scrollTop, clientHeight, scrollHeight } = scroller;
      setVisible(railWanted(sections.length, scrollHeight, clientHeight));
      setRailHeight(clientHeight);
      const pinned = pin.current;
      let next = activeSectionIndex(measureRef.current(), scrollTop, clientHeight, scrollHeight, pinned?.index ?? null);
      if (pinned) {
        if (performance.now() - pinned.at < 1000) next = pinned.index;
        else if (next !== pinned.index) pin.current = null;
      }
      setActive(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    refresh.current = schedule;
    // New sections renumber the ticks, so an older choice means nothing.
    pin.current = null;
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (observer) {
      observer.observe(scroller);
      // Content growing inside a fixed-size scroller does not resize the
      // scroller itself; its children do.
      for (const child of Array.from(scroller.children)) observer.observe(child);
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [scroller, sections]);

  // Too many headings for the rail's height: drop H3, then H2. A hidden
  // section's place is held by the visible one above it.
  const shown = useMemo(() => {
    const deepest = levelsThatFit(
      sections.map((s) => s.level),
      railHeight
    );
    return sections.flatMap((section, index) => (section.level <= deepest ? [{ section, index }] : []));
  }, [sections, railHeight]);
  const pitch = tickPitch(shown.length, railHeight) ?? 4;
  let activeShown = -1;
  for (let i = 0; i < shown.length && shown[i].index <= active; i++) activeShown = i;

  const [card, setCard] = useState<Card | null>(null);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const nav = useRef<HTMLElement>(null);
  const cardId = useId();

  const showCard = useCallback((shownIndex: number) => {
    const button = buttons.current[shownIndex];
    const railRect = nav.current?.getBoundingClientRect();
    if (!button || !railRect) return;
    const rect = button.getBoundingClientRect();
    const left = Math.min(railRect.right + 4, Math.max(GAP, window.innerWidth - CARD_WIDTH - GAP));
    setCard({ index: shownIndex, top: rect.top + rect.height / 2, left });
  }, []);
  const hideCard = useCallback(() => setCard(null), []);

  // The card sits beside its tick; scrolling the rail or the window moves the
  // tick, so the card goes.
  useEffect(() => {
    if (!card) return;
    window.addEventListener("resize", hideCard);
    return () => window.removeEventListener("resize", hideCard);
  }, [card, hideCard]);

  useEffect(() => {
    if (!visible) setCard(null);
  }, [visible]);

  // One tab stop for the whole rail; arrows move between ticks.
  const tabStop = focusAt ?? (activeShown >= 0 ? activeShown : 0);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const from = buttons.current.findIndex((b) => b === document.activeElement);
    if (event.key === "Escape") {
      if (card) {
        event.preventDefault();
        hideCard();
      }
      return;
    }
    if (from < 0) return;
    const to =
      event.key === "ArrowDown"
        ? Math.min(shown.length - 1, from + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, from - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? shown.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    setFocusAt(to);
    buttons.current[to]?.focus();
  };

  if (!visible || shown.length === 0) return null;

  const cardSection = card ? shown[card.index]?.section : undefined;
  const rail = (
    <nav
      ref={nav}
      aria-label="Sections"
      data-markie-section-rail
      onKeyDown={onKeyDown}
      onMouseLeave={hideCard}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
          hideCard();
          setFocusAt(null);
        }
      }}
      className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-center"
      style={{ width: RAIL_WIDTH }}
    >
      <div className="pointer-events-auto max-h-full overflow-y-auto py-2 [scrollbar-width:none]" onScroll={hideCard}>
        {shown.map(({ section, index }, i) => {
          const isActive = i === activeShown;
          return (
            <button
              key={index}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              aria-label={section.text}
              aria-current={isActive ? "location" : undefined}
              aria-describedby={card?.index === i ? cardId : undefined}
              tabIndex={i === tabStop ? 0 : -1}
              data-level={section.level}
              data-active={isActive || undefined}
              onClick={() => {
                pin.current = { index, at: performance.now() };
                onSelect(index);
                refresh.current();
              }}
              onMouseEnter={() => showCard(i)}
              onFocus={() => {
                setFocusAt(i);
                showCard(i);
              }}
              className="group flex w-full cursor-pointer items-center pl-2 outline-none"
              style={{ height: pitch }}
            >
              <span
                aria-hidden="true"
                className={`block h-[2px] rounded-full transition-[background-color,width] duration-100 ${
                  isActive
                    ? ""
                    : "bg-muted/45 group-hover:bg-foreground/80 group-focus-visible:bg-foreground/80"
                } group-focus-visible:outline group-focus-visible:outline-1 group-focus-visible:outline-offset-2 group-focus-visible:outline-foreground/60`}
                style={{
                  width: TICK_LENGTH[section.level as SectionLevel],
                  backgroundColor: isActive ? BRAND_COLORS.red : undefined,
                }}
              />
            </button>
          );
        })}
      </div>
    </nav>
  );

  return (
    <>
      {placement === "overlay" ? (
        // Zero width in the layout, so the document does not move when the
        // rail appears; the rail itself floats over the scroller's padding.
        <div data-markie-section-rail-host className="relative z-10 w-0 shrink-0">
          {rail}
        </div>
      ) : (
        <div data-markie-section-rail-host className="relative h-full shrink-0" style={{ width: RAIL_WIDTH }}>
          {rail}
        </div>
      )}
      {card && cardSection
        ? createPortal(
            <div
              id={cardId}
              role="tooltip"
              data-markie-section-card
              className="pointer-events-none fixed z-[80] rounded-lg border border-border bg-surface px-3 py-2 text-foreground shadow-lg"
              style={{ top: card.top, left: card.left, width: CARD_WIDTH, maxWidth: "calc(100vw - 16px)", transform: "translateY(-50%)" }}
            >
              <div className="truncate text-[12px] font-semibold leading-snug">{cardSection.text}</div>
              {cardSection.snippet ? (
                <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted">{cardSection.snippet}</div>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function reduceMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Scroll so `top` (content coordinates) sits at the top of the view, below the scroller's scroll-padding. */
export function scrollToTop(scroller: HTMLElement, top: number): void {
  const padding = parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
  const target = Math.max(0, top - padding);
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top: target, behavior: reduceMotion() ? "auto" : "smooth" });
  } else {
    scroller.scrollTop = target;
  }
}

const HEADING_TAGS: Record<string, SectionLevel> = { H1: 1, H2: 2, H3: 3 };

/** The rich view's sections, read from the editor's own DOM: its top-level H1 to H3. */
export function readRichSections(root: HTMLElement): { sections: Section[]; headings: HTMLElement[] } {
  const sections: Section[] = [];
  const headings: HTMLElement[] = [];
  for (const el of Array.from(root.children)) {
    const level = HEADING_TAGS[el.tagName];
    if (!level) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    // A section runs to the next heading at its own level or above, so the
    // preview reads on into its subsections, as in the source view.
    let snippet = "";
    const ends = (tag: string) => /^H[1-6]$/.test(tag) && Number(tag[1]) <= level;
    for (let next = el.nextElementSibling; next && !ends(next.tagName); next = next.nextElementSibling) {
      if (snippet.length >= SNIPPET_CHARS) break;
      // Code is not preview text, the same rule as the source view.
      if (next.tagName === "PRE") continue;
      const words = (next.textContent ?? "").replace(/\s+/g, " ").trim();
      if (words) snippet += `${snippet ? " " : ""}${words}`;
    }
    sections.push({ level, text, snippet: clipSnippet(snippet) });
    headings.push(el as HTMLElement);
  }
  return { sections, headings };
}

function contentTop(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** The rail for the rich view, mounted beside it in the rich pane. */
export function RichSectionRail({ editor }: { editor: Editor | null }) {
  const [enabled] = useState(() => nightlyFeaturesEnabled());
  const [state, setState] = useState<{ scroller: HTMLElement; sections: Section[]; headings: HTMLElement[] } | null>(null);

  useEffect(() => {
    if (!enabled || !editor) {
      setState(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      timer = undefined;
      if (editor.isDestroyed) return setState(null);
      let dom: HTMLElement;
      try {
        dom = editor.view.dom as HTMLElement;
      } catch {
        return setState(null);
      }
      const scroller = dom.closest<HTMLElement>(".markie-document-scroll");
      if (!scroller) return setState(null);
      setState({ scroller, ...readRichSections(dom) });
    };
    // Every document change, typed, pasted, loaded or from a live peer, is a
    // transaction; reading the DOM once typing pauses is plenty.
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 250);
    };
    read();
    editor.on("transaction", onTransaction);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("transaction", onTransaction);
    };
  }, [enabled, editor]);

  const measure = useCallback(() => {
    if (!state) return [];
    return state.headings.map((h) => contentTop(state.scroller, h));
  }, [state]);
  const onSelect = useCallback(
    (index: number) => {
      const heading = state?.headings[index];
      if (state && heading?.isConnected) scrollToTop(state.scroller, contentTop(state.scroller, heading));
    },
    [state]
  );

  if (!state) return null;
  return (
    <SectionRail
      sections={state.sections}
      scroller={state.scroller}
      measure={measure}
      onSelect={onSelect}
      placement="overlay"
    />
  );
}

export interface SourceSectionRailProps {
  markdown: string;
  scroller: HTMLElement;
  /** The top of a 0-based line, in the scroller's content coordinates. */
  lineTop: (line: number) => number;
  /** Bring a 0-based line to the top of the view. */
  scrollToLine: (line: number) => void;
}

/**
 * The rail for the source view. Headings come from the markdown text, so the
 * editor only has to say where a line is and how to get there.
 */
export function SourceSectionRail({ markdown, scroller, lineTop, scrollToLine }: SourceSectionRailProps) {
  const [enabled] = useState(() => nightlyFeaturesEnabled());
  const [sections, setSections] = useState<SourceSection[]>(() => (enabled ? extractSections(markdown) : []));

  // Parsing the whole text on every keystroke would be wasted on a rail that
  // only needs to be right once typing pauses.
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => setSections(extractSections(markdown)), 200);
    return () => clearTimeout(timer);
  }, [enabled, markdown]);

  const lineTopRef = useRef(lineTop);
  const scrollRef = useRef(scrollToLine);
  useLayoutEffect(() => {
    lineTopRef.current = lineTop;
    scrollRef.current = scrollToLine;
  });
  const measure = useCallback(() => sections.map((s) => lineTopRef.current(s.line)), [sections]);
  const onSelect = useCallback((index: number) => {
    const section = sections[index];
    if (section) scrollRef.current(section.line);
  }, [sections]);

  if (!enabled) return null;
  return <SectionRail sections={sections} scroller={scroller} measure={measure} onSelect={onSelect} placement="column" />;
}
