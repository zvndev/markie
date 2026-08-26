// Google-Docs-style write scheduling, kept pure so the timing rules are
// testable with fake clocks. One rule pair: save after idleMs of quiet, but
// never let a continuous burst outrun maxWaitMs. No retry policy lives here:
// a refused save is the caller's situation to resolve.

export interface AutosaveOptions {
  idleMs?: number;
  maxWaitMs?: number;
  save: () => Promise<boolean>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
}

export interface Autosave {
  noteChange(): void;
  flush(): Promise<boolean>;
  cancel(): void;
  isPending(): boolean;
}

export function createAutosave(opts: AutosaveOptions): Autosave {
  const idleMs = opts.idleMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 5000;
  const setT = opts.setTimer ?? setTimeout;
  const clearT = opts.clearTimer ?? clearTimeout;
  const now = opts.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let burstStart: number | null = null;
  let dirty = false;
  let saving = 0;
  // All saves run on one chain so two writes can never interleave.
  let chain: Promise<boolean> = Promise.resolve(true);

  const clear = () => {
    if (timer !== null) clearT(timer);
    timer = null;
  };

  const commit = (): Promise<boolean> => {
    clear();
    burstStart = null;
    if (!dirty) return chain;
    dirty = false;
    saving += 1;
    chain = chain
      .then(
        () => opts.save(),
        () => opts.save()
      )
      .catch(() => false)
      .finally(() => {
        saving -= 1;
      });
    return chain;
  };

  return {
    noteChange() {
      dirty = true;
      if (burstStart === null) burstStart = now();
      clear();
      const elapsed = now() - burstStart;
      const wait = Math.max(0, Math.min(idleMs, maxWaitMs - elapsed));
      timer = setT(() => {
        timer = null;
        void commit();
      }, wait);
    },
    flush() {
      if (!dirty) return chain;
      return commit();
    },
    cancel() {
      clear();
      burstStart = null;
      dirty = false;
    },
    isPending() {
      return dirty || saving > 0;
    },
  };
}
