import { DEFAULT_APPEARANCE, ZOOM_STEPS, stepZoom } from "./doc-appearance";

// One remembered zoom for every editor in the documents workspace, so a text
// file, an RTF and a Word document open at the size the reader last chose.
// Like the Markdown viewer's zoom it is a way of looking, never written into
// the file.
const KEY = "markie.documents.zoom.v1";

export function readDocumentZoom(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    if (Number.isFinite(value) && value > 0) return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], value));
  } catch { /* storage unavailable */ }
  return DEFAULT_APPEARANCE.zoom;
}

export function writeDocumentZoom(zoom: number): void {
  try { localStorage.setItem(KEY, String(zoom)); } catch { /* still applies this session */ }
}

/** The menu's ⌘+ / ⌘- / ⌘0, as zoom commands, applied to a zoom level. */
export function zoomForCommand(current: number, command: string): number | null {
  if (command === "zoom-in") return stepZoom(current, 1);
  if (command === "zoom-out") return stepZoom(current, -1);
  if (command === "view-zoom-reset") return DEFAULT_APPEARANCE.zoom;
  return null;
}

export const ZOOM_COMMANDS = ["zoom-in", "zoom-out", "view-zoom-reset"] as const;

// A trackpad pinch arrives as a stream of small ctrl+wheel deltas. Collect
// them so one deliberate pinch moves one or two steps, not twenty.
const PINCH_STEP = 60;
const PINCH_IDLE_MS = 220;

export function createPinchZoom(onStep: (direction: 1 | -1) => void) {
  let total = 0, last = 0;
  return (event: Pick<WheelEvent, "ctrlKey" | "deltaY" | "deltaMode" | "timeStamp">): boolean => {
    if (!event.ctrlKey) return false;
    if (event.timeStamp - last > PINCH_IDLE_MS) total = 0;
    last = event.timeStamp;
    total += event.deltaMode === 1 ? event.deltaY * 20 : event.deltaY;
    while (Math.abs(total) >= PINCH_STEP) {
      const direction = total < 0 ? 1 : -1;
      total += direction * PINCH_STEP;
      onStep(direction);
    }
    return true;
  };
}
