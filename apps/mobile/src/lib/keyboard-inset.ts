// How much of the screen the on-screen keyboard covers. The web view keeps its
// full height when the keyboard opens (no keyboard plugin resizes it), so a
// screen that types into a full-height box pads itself by this much instead,
// and its nav bar and buttons stay in view.
import { useEffect, useState } from "react";

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      setInset(covered > 80 ? covered : 0);
      // iOS scrolls the whole page up to show the caret. The screen is fixed
      // to the window, so that scroll only hides the nav bar: undo it.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
