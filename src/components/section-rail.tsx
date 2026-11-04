// The section rail: a column of short tick marks at the left edge of a long
// document, one per H1 to H3, modeled on the T3 Code thread minimap.
//
// Ticks are stacked compactly and centred in the rail rather than placed at
// their heading's scroll position. Placed proportionally, short sections
// collide into clumps too tight to point at and long ones leave gaps, so the
// rail stops reading as an outline; stacked, every heading gets the same
// target and the shape of the document reads at a glance.
//
// It behaves like the minimap too. At rest the ticks for the part of the
// document on screen are brighter. Pointing at the rail magnifies the tick
// under the pointer and, less, its neighbours, like the macOS Dock, and a
// card beside it previews that section; moving along the rail scrubs: the
// magnification follows and the card swaps its text in place. The card waits
// a moment before it first opens, so crossing the rail on the way somewhere
// else does not flash it, and lingers a moment after the pointer leaves.
//
// Scrubbing never re-renders the ticks. The pointer's tick is kept in a ref
// and only the few ticks within reach of it get a new --boost; the growth
// itself is a CSS transform (globals.css, [data-markie-section-rail]), so a
// 500-heading rail does no layout while the pointer moves.
//
// The rich view and the source view each supply the headings and how to find
// and reach them (RichSectionRail below; SourceSectionRail, mounted by the
// CodeMirror wrapper in src/components/editor.tsx). It ships to every build;
// it started behind nightlyFeaturesEnabled() and left the gate on 2026-11-03.
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import {
  activeSectionIndex,
  clipSnippet,
  extractSections,
  lastSectionInView,
  levelsThatFit,
  magnification,
  MAGNIFY_FALLOFF,
  MAGNIFY_GROWTH,
  railWanted,
  SNIPPET_CHARS,
  tickPitch,
  TICK_LENGTH,
  TICK_MAX_LENGTH,
  type Section,
  type SectionLevel,
  type SourceSection,
} from "@/lib/section-outline";

/**
 * Where a tick starts, from the rail's left edge, and the width that takes
 * the pointer. The rich view's rail floats in an empty margin and stands off
 * its edge as the T3 minimap does; the source view's is a narrow column of its
 * own beside the line numbers.
 */
const GEOMETRY = {
  overlay: { inset: 14, width: 30 },
  column: { inset: 8, width: 24 },
} as const;
/** The rail's drawn width past the tick inset: room for the longest magnified tick. */
const DRAWN_PAST_INSET = TICK_MAX_LENGTH + 4;
const CARD_WIDTH = 320;
/** Space between the longest tick and the card, as in the T3 minimap. */
const CARD_GAP = 6;
const EDGE = 8;
/** How long the pointer rests on the rail before the card first opens. */
export const CARD_OPEN_DELAY = 180;
/** How long the card stays after the pointer leaves the rail. */
export const CARD_CLOSE_DELAY = 120;

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
  /** Index into the shown ticks. */
  index: number;
  /** Viewport y of the tick's middle. */
  top: number;
  left: number;
}

interface Shown {
  section: Section;
  index: number;
}

function reduceMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function SectionRail({ sections, scroller, measure, onSelect, placement }: SectionRailProps) {
  const { inset, width } = GEOMETRY[placement];
  const drawnWidth = inset + DRAWN_PAST_INSET;
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  });
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(-1);
  const [lastInView, setLastInView] = useState(-1);
  const [railHeight, setRailHeight] = useState(0);
  // The section last chosen from the rail; see activeSectionIndex. For the
  // first second it wins outright, so a smooth scroll on its way there does
  // not light every tick it passes.
  const pin = useRef<{ index: number; at: number } | null>(null);
  const refresh = useRef<() => void>(() => {});

  // Scroll, resize and content changes all come down to the same questions:
  // is the document long enough, and which sections are on screen.
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
      const tops = measureRef.current();
      const pinned = pin.current;
      let next = activeSectionIndex(tops, scrollTop, clientHeight, scrollHeight, pinned?.index ?? null);
      if (pinned) {
        if (performance.now() - pinned.at < 1000) next = pinned.index;
        else if (next !== pinned.index) pin.current = null;
      }
      setActive(next);
      setLastInView(lastSectionInView(tops, scrollTop, clientHeight));
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
  const shown = useMemo<Shown[]>(() => {
    const deepest = levelsThatFit(
      sections.map((s) => s.level),
      railHeight
    );
    return sections.flatMap((section, index) => (section.level <= deepest ? [{ section, index }] : []));
  }, [sections, railHeight]);
  const pitch = tickPitch(shown.length, railHeight) ?? 4;
  // The ticks lit at rest: from the section at the reading line to the last
  // one that has come into view. Before the first heading, from the top.
  let activeShown = -1;
  let inViewEnd = -1;
  for (let i = 0; i < shown.length; i++) {
    if (shown[i].index <= active) activeShown = i;
    if (shown[i].index <= lastInView) inViewEnd = i;
  }
  const inViewStart = activeShown >= 0 ? activeShown : inViewEnd >= 0 ? 0 : -1;

  const [card, setCard] = useState<Card | null>(null);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const nav = useRef<HTMLElement>(null);
  const cardId = useId();

  // The tick under the pointer (or keyboard focus), outside React state so
  // scrubbing does not re-render the rail.
  const hot = useRef(-1);
  const cardOpen = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = undefined;
  };

  const placeCard = useCallback((index: number): Card | null => {
    const button = buttons.current[index];
    const railRect = nav.current?.getBoundingClientRect();
    if (!button || !railRect) return null;
    const rect = button.getBoundingClientRect();
    const left = Math.min(railRect.left + drawnWidth + CARD_GAP, Math.max(EDGE, window.innerWidth - CARD_WIDTH - EDGE));
    return { index, top: rect.top + rect.height / 2, left };
  }, [drawnWidth]);

  const showCard = useCallback(
    (index: number) => {
      const next = placeCard(index);
      cardOpen.current = !!next;
      setCard(next);
    },
    [placeCard]
  );

  const hideCard = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = undefined;
    cardOpen.current = false;
    setCard(null);
  }, []);

  /** Grow the ticks around `index` (-1: none) and shrink the ones around the last. */
  const magnify = useCallback((index: number) => {
    const before = hot.current;
    if (before === index) return;
    hot.current = index;
    const reach = reduceMotion() ? 0 : MAGNIFY_FALLOFF.length - 1;
    const touched = new Set<number>();
    for (const center of [before, index]) {
      if (center < 0) continue;
      for (let i = center - reach; i <= center + reach; i++) touched.add(i);
    }
    for (const i of touched) {
      const tick = buttons.current[i]?.firstElementChild as HTMLElement | null | undefined;
      if (!tick) continue;
      const distance = index < 0 ? Infinity : Math.abs(i - index);
      const boost = distance <= reach ? magnification(distance) : 0;
      if (boost) tick.style.setProperty("--boost", String(boost));
      else tick.style.removeProperty("--boost");
      if (distance === 0) tick.setAttribute("data-hot", "");
      else tick.removeAttribute("data-hot");
    }
    if (index >= 0) nav.current?.setAttribute("data-scrubbing", "");
    else nav.current?.removeAttribute("data-scrubbing");
  }, []);

  /**
   * Point at tick `index`. The card opens after CARD_OPEN_DELAY the first
   * time (at once from the keyboard) and then follows straight away, with no
   * close and reopen between ticks.
   */
  const point = useCallback(
    (index: number, from: "pointer" | "keyboard") => {
      magnify(index);
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
      if (cardOpen.current || from === "keyboard") {
        clearTimeout(openTimer.current);
        openTimer.current = undefined;
        showCard(index);
      } else if (!openTimer.current) {
        openTimer.current = setTimeout(() => {
          openTimer.current = undefined;
          if (hot.current >= 0) showCard(hot.current);
        }, CARD_OPEN_DELAY);
      }
    },
    [magnify, showCard]
  );

  /** The pointer left: the magnification eases back at once, the card a moment later. */
  const leave = useCallback(() => {
    magnify(-1);
    clearTimeout(openTimer.current);
    openTimer.current = undefined;
    if (!cardOpen.current || closeTimer.current) return;
    closeTimer.current = setTimeout(hideCard, CARD_CLOSE_DELAY);
  }, [magnify, hideCard]);

  const dismiss = useCallback(() => {
    magnify(-1);
    hideCard();
  }, [magnify, hideCard]);

  useEffect(() => () => clearTimers(), []);

  // The card sits beside its tick; resizing the window moves the tick, so the
  // card goes.
  useEffect(() => {
    if (!card) return;
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [card, dismiss]);

  // The tick the card describes points at it, for a screen reader.
  useEffect(() => {
    const button = card ? buttons.current[card.index] : null;
    button?.setAttribute("aria-describedby", cardId);
    return () => button?.removeAttribute("aria-describedby");
  }, [card, cardId]);

  useEffect(() => {
    if (!visible) {
      hot.current = -1;
      hideCard();
    }
  }, [visible, hideCard]);

  // New ticks: forget the old magnification; React drew them fresh.
  useEffect(() => {
    hot.current = -1;
    nav.current?.removeAttribute("data-scrubbing");
    if (cardOpen.current) hideCard();
  }, [shown, hideCard]);

  const select = useCallback(
    (shownIndex: number) => {
      const index = shown[shownIndex]?.index;
      if (index === undefined) return;
      pin.current = { index, at: performance.now() };
      onSelect(index);
      refresh.current();
    },
    [shown, onSelect]
  );

  // One tab stop for the whole rail; arrows move between ticks.
  const tabStop = focusAt ?? (activeShown >= 0 ? activeShown : 0);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const from = buttons.current.findIndex((b) => b === document.activeElement);
    if (event.key === "Escape") {
      if (card || hot.current >= 0) {
        event.preventDefault();
        dismiss();
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

  // Ticks are flush, so the pointer is always over one while it is on the
  // rail: no gap between ticks for the card to drop out in.
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    const button = (event.target as Element).closest?.("button[data-tick-index]");
    if (button) point(Number(button.getAttribute("data-tick-index")), "pointer");
  };

  const onFocusTick = useCallback(
    (index: number) => {
      setFocusAt(index);
      point(index, "keyboard");
    },
    [point]
  );

  if (!visible || shown.length === 0) return null;

  const cardSection = card ? shown[card.index]?.section : undefined;
  const rail = (
    <nav
      ref={nav}
      aria-label="Sections"
      data-markie-section-rail
      onKeyDown={onKeyDown}
      onPointerMove={onPointerMove}
      onPointerLeave={leave}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
          dismiss();
          setFocusAt(null);
        }
      }}
      className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-center"
      style={{ width: drawnWidth, ["--growth" as string]: MAGNIFY_GROWTH, ["--max" as string]: TICK_MAX_LENGTH }}
    >
      {/* The column scrolls when even the tightest rail does not fit. Only
          the ticks take the pointer; the drawn width beyond them is for the
          magnified ticks to grow into. */}
      <div className="max-h-full overflow-y-auto py-2 [scrollbar-width:none]" onScroll={dismiss}>
        <Ticks
          shown={shown}
          pitch={pitch}
          activeShown={activeShown}
          inViewStart={inViewStart}
          inViewEnd={inViewEnd}
          tabStop={tabStop}
          inset={inset}
          width={width}
          buttons={buttons}
          onSelect={select}
          onFocusTick={onFocusTick}
        />
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
        <div data-markie-section-rail-host className="relative z-10 h-full shrink-0" style={{ width }}>
          {rail}
        </div>
      )}
      {card && cardSection
        ? createPortal(<SectionCard id={cardId} card={card} section={cardSection} />, document.body)
        : null}
    </>
  );
}

interface TicksProps {
  shown: readonly Shown[];
  pitch: number;
  activeShown: number;
  inViewStart: number;
  inViewEnd: number;
  tabStop: number;
  inset: number;
  width: number;
  buttons: MutableRefObject<(HTMLButtonElement | null)[]>;
  onSelect: (shownIndex: number) => void;
  onFocusTick: (shownIndex: number) => void;
}

// Memoised: the card opening, closing and following the pointer re-renders
// the rail, never the ticks.
const Ticks = memo(function Ticks({ shown, pitch, activeShown, inViewStart, inViewEnd, tabStop, inset, width, buttons, onSelect, onFocusTick }: TicksProps) {
  buttons.current.length = shown.length;
  return (
    <>
      {shown.map(({ section, index }, i) => {
        const inView = i >= inViewStart && i <= inViewEnd;
        return (
          <button
            key={index}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            aria-label={section.text}
            aria-current={i === activeShown ? "location" : undefined}
            tabIndex={i === tabStop ? 0 : -1}
            data-level={section.level}
            data-tick-index={i}
            onClick={() => onSelect(i)}
            onFocus={() => onFocusTick(i)}
            className="pointer-events-auto relative block cursor-pointer outline-none"
            style={{ width, height: pitch }}
          >
            <span
              aria-hidden="true"
              data-section-tick=""
              data-in-view={inView || undefined}
              style={{ left: inset, width: TICK_MAX_LENGTH, ["--len" as string]: TICK_LENGTH[section.level as SectionLevel] }}
            />
          </button>
        );
      })}
    </>
  );
});

/** The preview beside the tick: the heading on one line, then the start of its section. */
function SectionCard({ id, card, section }: { id: string; card: Card; section: Section }) {
  const ref = useRef<HTMLDivElement>(null);
  // Centred on its tick, but kept on screen at the top and bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const half = el.offsetHeight / 2;
    const top = Math.min(Math.max(card.top, EDGE + half), window.innerHeight - EDGE - half);
    el.style.top = `${top}px`;
  });
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-markie-section-card
      className="pointer-events-none fixed z-[80] rounded-lg border border-border bg-surface px-3 pt-2.5 pb-3 text-foreground"
      style={{ top: card.top, left: card.left, width: CARD_WIDTH, maxWidth: `calc(100vw - ${EDGE * 2}px)`, transform: "translateY(-50%)" }}
    >
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5">{section.text}</div>
        <span aria-hidden="true" className="shrink-0 font-mono text-[10px] leading-5 text-muted">
          H{section.level}
        </span>
      </div>
      <div className="mt-1 line-clamp-3 text-[12.5px] leading-5 text-muted">
        {section.snippet || "No text before the next heading."}
      </div>
    </div>
  );
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
  const [state, setState] = useState<{ scroller: HTMLElement; sections: Section[]; headings: HTMLElement[] } | null>(null);

  useEffect(() => {
    if (!editor) {
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
  }, [editor]);

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

/**
 * The rail for a rendered, read-only document (the web's read view): the
 * same headings the rich view reads, the top-level H1 to H3 of `root`.
 * `content` is whatever changes when the document does, so the headings are
 * read again.
 */
export function HtmlSectionRail({ root, scroller, content }: { root: HTMLElement | null; scroller: HTMLElement | null; content: unknown }) {
  const [state, setState] = useState<{ sections: Section[]; headings: HTMLElement[] } | null>(null);
  useEffect(() => {
    setState(root ? readRichSections(root) : null);
  }, [root, content]);

  const measure = useCallback(() => {
    if (!state || !scroller) return [];
    return state.headings.map((h) => contentTop(scroller, h));
  }, [state, scroller]);
  const onSelect = useCallback(
    (index: number) => {
      const heading = state?.headings[index];
      if (scroller && heading?.isConnected) scrollToTop(scroller, contentTop(scroller, heading));
    },
    [state, scroller]
  );

  if (!state || !scroller) return null;
  return <SectionRail sections={state.sections} scroller={scroller} measure={measure} onSelect={onSelect} placement="overlay" />;
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
  const [sections, setSections] = useState<SourceSection[]>(() => extractSections(markdown));

  // Parsing the whole text on every keystroke would be wasted on a rail that
  // only needs to be right once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setSections(extractSections(markdown)), 200);
    return () => clearTimeout(timer);
  }, [markdown]);

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

  return <SectionRail sections={sections} scroller={scroller} measure={measure} onSelect={onSelect} placement="column" />;
}
