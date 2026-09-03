// Whether hovering a link fetches a card for it.
//
// On by default, because a preview is the useful behaviour and a switch nobody
// finds is not a choice. Off is a real position though: with previews on, the
// sites a document links to learn that somebody paused over them, and some
// people do not want their reading to be visible to anyone. So the switch is in
// Settings, it says what it does, and nothing is ever fetched with it off.

const KEY = "markie.linkPreviews.v1";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getLinkPreviewsEnabled(): boolean {
  const store = storage();
  if (!store) return true;
  try {
    // Absent means on. Only an explicit "0" turns it off, so a corrupted or
    // half-written value does not silently disable a feature.
    return store.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setLinkPreviewsEnabled(enabled: boolean): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, enabled ? "1" : "0");
    window.dispatchEvent(new CustomEvent(LINK_PREVIEWS_CHANGED, { detail: enabled }));
  } catch {
    // A machine with no storage keeps the default, which is the useful one.
  }
}

/** Fired when the switch moves, so an open document picks it up at once. */
export const LINK_PREVIEWS_CHANGED = "markie:link-previews-changed";

// The preference is state that lives outside React, in storage that another
// window can change, which is exactly what useSyncExternalStore is for. Reading
// it into useState inside an effect would be a second copy that goes stale.
export function subscribeLinkPreviews(onChange: () => void): () => void {
  window.addEventListener(LINK_PREVIEWS_CHANGED, onChange);
  // Another window of the same app writing the same key.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(LINK_PREVIEWS_CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Server-rendered HTML has no storage to read, and the default is on. */
export const linkPreviewsEnabledOnServer = () => true;
