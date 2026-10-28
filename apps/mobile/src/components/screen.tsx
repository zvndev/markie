// One screen: a translucent navigation bar over a scrolling body, with the
// platform's large-title behavior (the big title scrolls away and the bar's
// small title fades in) and, where a screen asks for it, pull to refresh.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject, type TouchEvent } from "react";
import { haptics } from "../lib/native";
import { ChevronLeft } from "./icons";

const PULL_TRIGGER = 72;
const PULL_MAX = 120;
const PULL_HOLD = 56;

interface ScreenProps {
  title: string;
  /** Shown big at the top of the body; the bar's own title appears once it scrolls away. */
  largeTitle?: boolean;
  back?: { label: string; onBack: () => void };
  /** In place of the back button, for a screen that is cancelled rather than left. */
  leading?: ReactNode;
  actions?: ReactNode;
  /** Sits under the large title and scrolls with it (search, filters). */
  header?: ReactNode;
  onRefresh?: () => Promise<void>;
  /** Called when the body nears its end, for paging. */
  onNearEnd?: () => void;
  children: ReactNode;
  className?: string;
  bodyRef?: RefObject<HTMLDivElement | null>;
  /** The body does not scroll; its child fills it (a Darkmown frame scrolls itself). */
  fill?: boolean;
}

export function Screen({ title, largeTitle = false, back, leading, actions, header, onRefresh, onNearEnd, children, className = "", bodyRef, fill = false }: ScreenProps) {
  const localBody = useRef<HTMLDivElement>(null);
  const body = bodyRef ?? localBody;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [collapsed, setCollapsed] = useState(!largeTitle);
  const [scrolled, setScrolled] = useState(false);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touch = useRef<{ startY: number; armed: boolean; fired: boolean } | null>(null);

  const onScroll = useCallback(() => {
    const el = body.current;
    if (!el) return;
    const top = el.scrollTop;
    setScrolled(top > 2);
    if (largeTitle) {
      const titleHeight = titleRef.current?.offsetHeight ?? 44;
      setCollapsed(top > titleHeight - 6);
    }
    if (onNearEnd && el.scrollHeight - top - el.clientHeight < 600) onNearEnd();
  }, [body, largeTitle, onNearEnd]);

  useEffect(() => { onScroll(); }, [onScroll]);

  const refresh = useCallback(async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    setPull(PULL_HOLD);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
      setPull(0);
    }
  }, [onRefresh]);

  const touchHandlers = onRefresh
    ? {
        onTouchStart: (event: TouchEvent) => {
          if (refreshing || (body.current?.scrollTop ?? 0) > 0) { touch.current = null; return; }
          touch.current = { startY: event.touches[0].clientY, armed: false, fired: false };
        },
        onTouchMove: (event: TouchEvent) => {
          const state = touch.current;
          if (!state || refreshing) return;
          const delta = event.touches[0].clientY - state.startY;
          if (delta <= 0 || (body.current?.scrollTop ?? 0) > 0) { setPull(0); return; }
          // Rubber-band: the further the pull, the less each point moves.
          const distance = Math.min(PULL_MAX, delta * 0.5);
          setPull(distance);
          const armed = distance >= PULL_TRIGGER;
          if (armed && !state.fired) { haptics.tap(); state.fired = true; }
          if (!armed) state.fired = false;
          state.armed = armed;
        },
        onTouchEnd: () => {
          const state = touch.current;
          touch.current = null;
          if (state?.armed && !refreshing) void refresh();
          else if (!refreshing) setPull(0);
        },
      }
    : {};

  const progress = Math.min(1, pull / PULL_TRIGGER);

  return (
    <section className={`m-screen ${className}`}>
      <header className={`m-navbar${scrolled ? " is-scrolled" : ""}`}>
        <div className="m-navbar-side m-navbar-leading">
          {back ? (
            <button type="button" className="m-nav-back" onClick={back.onBack} aria-label={`Back to ${back.label}`}>
              <ChevronLeft size={24} />
              <span>{back.label}</span>
            </button>
          ) : leading ?? null}
        </div>
        <div className={`m-navbar-title${collapsed ? " is-visible" : ""}`} aria-hidden={!collapsed}>{title}</div>
        <div className="m-navbar-side m-navbar-trailing">{actions}</div>
      </header>
      <div
        ref={body}
        className={`m-screen-body${fill ? " is-fill" : ""}${onRefresh ? " is-refreshable" : ""}`}
        onScroll={onScroll}
        {...touchHandlers}
      >
        {onRefresh ? (
          <div className={`m-refresh${refreshing ? " is-refreshing" : ""}`} style={{ height: pull }} aria-hidden={!refreshing}>
            <svg className="m-refresh-spinner" width="26" height="26" viewBox="0 0 26 26" style={{ opacity: progress, transform: refreshing ? undefined : `rotate(${progress * 270}deg)` }}>
              <circle cx="13" cy="13" r="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={`${refreshing ? 46 : progress * 54} 63`} />
            </svg>
            {refreshing ? <span className="m-visually-hidden" role="status">Refreshing</span> : null}
          </div>
        ) : null}
        <div className="m-screen-content" style={pull && !refreshing ? { transition: "none" } : undefined}>
          {largeTitle ? <h1 ref={titleRef} className="m-large-title">{title}</h1> : null}
          {header}
          {children}
        </div>
      </div>
    </section>
  );
}
