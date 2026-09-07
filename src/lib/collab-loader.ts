// Loads the live-session runtime (src/lib/collab-runtime.ts) the first time a
// shared document needs it, and hands it out synchronously ever after, so
// only the first shared document of a launch sees the pane wait for it.
import { useEffect, useState } from "react";

export type CollabRuntime = typeof import("@/lib/collab-runtime");

let cached: CollabRuntime | null = null;
let loading: Promise<CollabRuntime> | null = null;

export function loadCollabRuntime(): Promise<CollabRuntime> {
  if (cached) return Promise.resolve(cached);
  loading ??= import("@/lib/collab-runtime").then((runtime) => {
    cached = runtime;
    return runtime;
  });
  return loading;
}

/** The runtime if it has already been loaded, else null. */
export function cachedCollabRuntime(): CollabRuntime | null {
  return cached;
}

/**
 * The runtime once `wanted`, null until it has loaded (and always null when
 * not wanted). A component keyed per session mounts fresh for each one, so
 * the cached fast path is what makes the second session instant.
 */
export function useCollabRuntime(wanted: boolean): CollabRuntime | null {
  const [runtime, setRuntime] = useState<CollabRuntime | null>(() => (wanted ? cached : null));
  useEffect(() => {
    if (!wanted || runtime) return;
    let live = true;
    loadCollabRuntime().then((loaded) => {
      if (live) setRuntime(loaded);
    });
    return () => {
      live = false;
    };
  }, [wanted, runtime]);
  return wanted ? runtime : null;
}
