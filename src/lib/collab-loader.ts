// Loads the live-session runtime (src/lib/collab-runtime.ts) the first time a
// shared document needs it, and hands it out synchronously ever after, so
// only the first shared document of a launch sees the pane wait for it.
import { useEffect, useState } from "react";

export type CollabRuntime = typeof import("@/lib/collab-runtime");

let cached: CollabRuntime | null = null;
let loading: Promise<CollabRuntime> | null = null;

export function loadCollabRuntime(): Promise<CollabRuntime> {
  if (cached) return Promise.resolve(cached);
  // A load that fails (a packaged chunk missing or corrupt, a disk that would
  // not read it just then) is not remembered: the next shared document
  // imports again instead of inheriting one rejection for the whole launch.
  loading ??= import("@/lib/collab-runtime").then(
    (runtime) => {
      cached = runtime;
      return runtime;
    },
    (err: unknown) => {
      loading = null;
      throw err;
    }
  );
  return loading;
}

/** The runtime if it has already been loaded, else null. */
export function cachedCollabRuntime(): CollabRuntime | null {
  return cached;
}

export interface CollabRuntimeState {
  /** The runtime once it is in; null while it loads, when it failed, and when it is not wanted. */
  runtime: CollabRuntime | null;
  /** This mount's load failed. The document is still there to edit alone. */
  failed: boolean;
}

const NOT_LOADED: CollabRuntimeState = { runtime: null, failed: false };

/**
 * The runtime once `wanted`, null until it has loaded (and always null when
 * not wanted), with `failed` set when the load did not succeed. A component
 * keyed per session mounts fresh for each one, so the cached fast path is
 * what makes the second session instant, and a failed load is tried again by
 * the next mount rather than by this one.
 */
export function useCollabRuntime(wanted: boolean): CollabRuntimeState {
  const [state, setState] = useState<CollabRuntimeState>(() =>
    wanted && cached ? { runtime: cached, failed: false } : NOT_LOADED
  );
  useEffect(() => {
    if (!wanted || state.runtime || state.failed) return;
    let live = true;
    loadCollabRuntime().then(
      (loaded) => {
        if (live) setState({ runtime: loaded, failed: false });
      },
      () => {
        if (live) setState({ runtime: null, failed: true });
      }
    );
    return () => {
      live = false;
    };
  }, [wanted, state.runtime, state.failed]);
  return wanted ? state : NOT_LOADED;
}
