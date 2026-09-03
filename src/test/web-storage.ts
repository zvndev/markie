// Node 26 defines `localStorage` and `sessionStorage` as globals of its own,
// inert unless the process was started with --localstorage-file. Vitest's jsdom
// environment copies a window key onto the global only when the key is not
// already there (`if (k in global) return keysArray.includes(k)` in
// getWindowKeys, and neither storage is on its list), so from the day Node
// added them, jsdom's real storage stopped being installed and every test that
// touched storage threw in its own beforeEach reading Node's undefined one.
//
// After populateGlobal, `window` IS globalThis, so jsdom's own window is no
// longer reachable to borrow the real object from. This is a stub, in the same
// spirit as the matchMedia and ResizeObserver stubs next door: Storage is a
// small, fully specified interface, and these tests only need it to behave.
class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    // Missing is null, not undefined, and the whole app leans on that.
    return this.#entries.has(String(key)) ? (this.#entries.get(String(key)) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#entries.delete(String(key));
  }

  clear(): void {
    this.#entries.clear();
  }
}

// Setup files run once per test file, and each file gets its own empty
// storage, the way it used to get its own jsdom window. A stub kept across
// files would let one file's saved theme decide another file's assertions.
for (const key of ["localStorage", "sessionStorage"] as const) {
  const existing = (globalThis as unknown as Record<string, unknown>)[key];
  const ours = existing instanceof MemoryStorage;
  if (existing && !ours && typeof (existing as Storage).setItem === "function") continue;
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
}
