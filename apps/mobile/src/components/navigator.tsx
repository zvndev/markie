// A push/pop stack with the platform's motion: the new screen slides in from
// the right over a dimmed, parallaxed parent, and an edge swipe pulls it back.
// Screens below the top stay mounted, so going back keeps the list where it was.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from "react";

export interface StackEntry {
  key: string;
  node: ReactNode;
}

interface NavigatorProps {
  entries: StackEntry[];
  onPop: () => void;
}

const EDGE = 28;
const LEAVE_MS = 280;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function Navigator({ entries, onPop }: NavigatorProps) {
  // A popped screen stays a moment so it can slide out.
  const [leaving, setLeaving] = useState<StackEntry | null>(null);
  const previous = useRef<StackEntry[]>(entries);
  const [drag, setDrag] = useState<number | null>(null);
  // A swipe that commits finishes its own slide, so the pop that follows
  // must not play the slide-out a second time.
  const [settling, setSettling] = useState(false);
  const swiped = useRef(false);
  const gesture = useRef<{ x: number; y: number; t: number; locked: boolean | null } | null>(null);
  const width = typeof window === "undefined" ? 390 : window.innerWidth;

  useEffect(() => {
    const before = previous.current;
    previous.current = entries;
    if (entries.length < before.length) {
      const popped = before[before.length - 1];
      if (!entries.some((entry) => entry.key === popped.key) && !prefersReducedMotion() && !swiped.current) {
        setLeaving(popped);
        const timer = setTimeout(() => setLeaving(null), LEAVE_MS);
        return () => clearTimeout(timer);
      }
    }
    swiped.current = false;
    setLeaving(null);
  }, [entries]);

  const canSwipe = entries.length > 1;

  function onTouchStart(event: TouchEvent) {
    const point = event.touches[0];
    if (!canSwipe || point.clientX > EDGE) { gesture.current = null; return; }
    gesture.current = { x: point.clientX, y: point.clientY, t: Date.now(), locked: null };
  }

  function onTouchMove(event: TouchEvent) {
    const state = gesture.current;
    if (!state) return;
    const point = event.touches[0];
    const dx = point.clientX - state.x;
    const dy = point.clientY - state.y;
    if (state.locked === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) state.locked = Math.abs(dx) > Math.abs(dy);
    if (!state.locked) return;
    setDrag(Math.max(0, dx));
  }

  function onTouchEnd(event: TouchEvent) {
    const state = gesture.current;
    gesture.current = null;
    if (!state?.locked || drag === null || settling) { if (!settling) setDrag(null); return; }
    const dx = (event.changedTouches[0]?.clientX ?? state.x) - state.x;
    const velocity = dx / Math.max(1, Date.now() - state.t);
    if (dx > width * 0.35 || velocity > 0.5) {
      setSettling(true);
      setDrag(width);
      swiped.current = true;
      setTimeout(() => { setSettling(false); setDrag(null); onPop(); }, 220);
    } else {
      setSettling(true);
      setDrag(0);
      setTimeout(() => { setSettling(false); setDrag(null); }, 220);
    }
  }

  // Focus follows the top screen. The screen underneath turns inert, and a
  // focused control inside it would otherwise leave screen readers (and
  // Android's WebView accessibility tree) pointing at nothing.
  const stackRef = useRef<HTMLDivElement>(null);
  const topKey = entries[entries.length - 1]?.key;
  const firstTop = useRef(true);
  useEffect(() => {
    if (firstTop.current) { firstTop.current = false; return; }
    const items = stackRef.current?.querySelectorAll<HTMLElement>(":scope > .m-stack-item:not([inert])");
    items?.[items.length - 1]?.focus({ preventScroll: true });
  }, [topKey]);

  const shown = leaving ? [...entries, leaving] : entries;
  const topIndex = shown.length - 1;

  return (
    <div ref={stackRef} className="m-stack" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={() => { gesture.current = null; setDrag(null); }}>
      {shown.map((entry, index) => {
        const isTop = index === topIndex;
        const isUnder = index === topIndex - 1;
        const isLeaving = leaving?.key === entry.key;
        const hidden = !isTop && !isUnder;
        let style: CSSProperties | undefined;
        const transition = settling ? "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
        if (drag !== null && isTop) style = { transform: `translate3d(${drag}px,0,0)`, transition, animation: "none" };
        if (drag !== null && isUnder) style = { transform: `translate3d(${-30 + (drag / width) * 30}%,0,0)`, transition, animation: "none" };
        return (
          <div
            key={entry.key}
            className={[
              "m-stack-item",
              // Present from the first render, so the slide-in runs once, on push.
              index > 0 ? "is-pushed" : "",
              isLeaving ? "is-leaving" : "",
              isUnder && !leaving ? "is-under" : "",
              hidden ? "is-hidden" : "",
            ].join(" ")}
            style={style}
            aria-hidden={!isTop || isLeaving ? true : undefined}
            inert={!isTop || isLeaving ? true : undefined}
            tabIndex={-1}
          >
            {entry.node}
          </div>
        );
      })}
    </div>
  );
}
