import { describe, expect, it, vi } from "vitest";
import {
  findRepoRoot as findRepoRootJs,
  refreshMeta as refreshMetaJs,
  withMeta,
} from "./mdmeta.js";

// mdmeta.js is CommonJS with injectable seams, so TypeScript infers its option
// bags from the defaults and loses the parameters that have none. Same problem
// mdindex.test.ts solves the same way: name the seams here, once, rather than
// grow a .d.ts for a module only the main process requires.
interface RepoRootOptions {
  home?: string;
  exists?: (p: string) => boolean;
  cache?: Map<string, string | null>;
}
interface MetaRow {
  path: string;
  mtimeMs: number;
  birthtimeMs: number | null;
  fmProject: string | null;
  fmBlock: string | null;
  repoName: string | null;
}
interface RefreshDeps {
  registry: {
    metaAll: () => Array<{ path: string; mtime_ms: number }>;
    metaUpsertMany: (rows: MetaRow[]) => void;
  };
  readHead?: (p: string) => string;
  statBirthtime?: (p: string) => number | null;
  findRepoRoot?: (dir: string, opts: RepoRootOptions) => string | null;
  budgetMs?: number;
  now?: () => number;
}
type IndexRow = { path: string; name: string; dir: string; mtimeMs: number };

const findRepoRoot = findRepoRootJs as unknown as (
  dir: string,
  options?: RepoRootOptions
) => string | null;
const refreshMeta = refreshMetaJs as unknown as (
  rows: IndexRow[],
  deps: RefreshDeps
) => { updated: number; remaining: number };

interface StoredMeta {
  path: string;
  mtime_ms: number;
  birthtime_ms?: number | null;
  fm_project?: string | null;
  fm_block?: string | null;
  repo_name?: string | null;
}

describe("findRepoRoot", () => {
  it("names the nearest ancestor containing .git, stopping at home", () => {
    const exists = (p: string) => p === "/home/u/code/proj/.git";
    expect(
      findRepoRoot("/home/u/code/proj/docs", { home: "/home/u", exists, cache: new Map() })
    ).toBe("proj");
    expect(findRepoRoot("/home/u/notes", { home: "/home/u", exists, cache: new Map() })).toBeNull();
  });

  it("prefers the nearest repo when repos nest", () => {
    const exists = (p: string) =>
      p === "/home/u/code/outer/.git" || p === "/home/u/code/outer/inner/.git";
    expect(
      findRepoRoot("/home/u/code/outer/inner/docs", {
        home: "/home/u",
        exists,
        cache: new Map(),
      })
    ).toBe("inner");
  });

  it("never climbs above home", () => {
    const exists = (p: string) => p === "/home/.git";
    expect(findRepoRoot("/home/u/x", { home: "/home/u", exists, cache: new Map() })).toBeNull();
  });

  it("stays out of directories that are not under home at all", () => {
    const exists = vi.fn(() => true);
    expect(findRepoRoot("/Volumes/Ext/notes", { home: "/home/u", exists, cache: new Map() })).toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });

  it("caches per directory", () => {
    const exists = vi.fn(() => false);
    const cache = new Map();
    findRepoRoot("/home/u/a/b", { home: "/home/u", exists, cache });
    const calls = exists.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    findRepoRoot("/home/u/a/b", { home: "/home/u", exists, cache });
    expect(exists.mock.calls.length).toBe(calls);
  });

  it("caches the answer for every directory on the way up, not just the hit", () => {
    const exists = vi.fn((p: string) => p === "/home/u/repo/.git");
    const cache = new Map();
    findRepoRoot("/home/u/repo/a/b/c", { home: "/home/u", exists, cache });
    const calls = exists.mock.calls.length;
    // A sibling deep inside the same repo must not walk again.
    expect(findRepoRoot("/home/u/repo/a/b", { home: "/home/u", exists, cache })).toBe("repo");
    expect(exists.mock.calls.length).toBe(calls);
  });
});

describe("refreshMeta", () => {
  const row = { path: "/home/u/p/a.md", name: "a.md", dir: "/home/u/p", mtimeMs: 100 };

  function fakeRegistry(seed: StoredMeta[] = []) {
    const stored = new Map(seed.map((m) => [m.path, m]));
    return {
      stored,
      metaAll: () => [...stored.values()],
      metaUpsertMany: vi.fn((rows: Array<{ path: string; mtimeMs: number }>) => {
        for (const r of rows) stored.set(r.path, { path: r.path, mtime_ms: r.mtimeMs });
      }),
    };
  }

  it("extracts meta for new files and skips unchanged ones", () => {
    const registry = fakeRegistry();
    const readHead = vi.fn(() => "---\nmarkie:\n  project: P\n---\n");
    const deps = { registry, readHead, statBirthtime: () => 42, findRepoRoot: () => "p" };

    expect(refreshMeta([row], deps).updated).toBe(1);
    expect(registry.metaUpsertMany).toHaveBeenCalledTimes(1);
    expect(registry.metaUpsertMany.mock.calls[0][0][0]).toMatchObject({
      path: row.path,
      birthtimeMs: 42,
      fmProject: "P",
      fmBlock: null,
      repoName: "p",
    });

    expect(refreshMeta([row], deps).updated).toBe(0); // mtime unchanged
    expect(readHead).toHaveBeenCalledTimes(1);
  });

  it("re-extracts when mtime moves", () => {
    const registry = fakeRegistry([{ path: row.path, mtime_ms: 50 }]);
    const deps = {
      registry,
      readHead: () => "",
      statBirthtime: () => null,
      findRepoRoot: () => null,
    };
    expect(refreshMeta([row], deps).updated).toBe(1);
  });

  it("writes nothing at all when the whole index is unchanged", () => {
    const registry = fakeRegistry([{ path: row.path, mtime_ms: 100 }]);
    const readHead = vi.fn(() => "");
    refreshMeta([row], { registry, readHead, statBirthtime: () => null, findRepoRoot: () => null });
    expect(registry.metaUpsertMany).not.toHaveBeenCalled();
    expect(readHead).not.toHaveBeenCalled();
  });

  it("stops at the time budget and reports what is left", () => {
    const registry = fakeRegistry();
    const rows = Array.from({ length: 5 }, (_, i) => ({
      path: `/home/u/p/f${i}.md`,
      name: `f${i}.md`,
      dir: "/home/u/p",
      mtimeMs: 1,
    }));
    // A clock that advances 10ms per read, against a 25ms budget.
    let clock = 0;
    const readHead = vi.fn(() => {
      clock += 10;
      return "";
    });
    const res = refreshMeta(rows, {
      registry,
      readHead,
      statBirthtime: () => null,
      findRepoRoot: () => null,
      budgetMs: 25,
      now: () => clock,
    });
    expect(res.updated).toBe(3);
    expect(res.remaining).toBe(2);
    expect(readHead).toHaveBeenCalledTimes(3);
  });

  it("finishes the leftovers on the next slice without redoing the first", () => {
    const registry = fakeRegistry();
    const rows = Array.from({ length: 4 }, (_, i) => ({
      path: `/home/u/p/f${i}.md`,
      name: `f${i}.md`,
      dir: "/home/u/p",
      mtimeMs: 1,
    }));
    let clock = 0;
    const readHead = vi.fn(() => {
      clock += 10;
      return "";
    });
    const deps = {
      registry,
      readHead,
      statBirthtime: () => null,
      findRepoRoot: () => null,
      budgetMs: 15,
      now: () => clock,
    };
    const first = refreshMeta(rows, deps);
    expect(first.updated).toBe(2);
    clock = 0;
    const second = refreshMeta(rows, deps);
    expect(second.updated).toBe(2);
    expect(second.remaining).toBe(0);
    expect(readHead).toHaveBeenCalledTimes(4); // never twice for one file
    expect(registry.stored.size).toBe(4);
  });

  it("reports nothing remaining when there is no budget to run out of", () => {
    const registry = fakeRegistry();
    const res = refreshMeta([row], {
      registry,
      readHead: () => "",
      statBirthtime: () => null,
      findRepoRoot: () => null,
    });
    expect(res).toEqual({ updated: 1, remaining: 0 });
  });

  it("shares one repo cache across the whole batch", () => {
    const registry = fakeRegistry();
    const findRepo = vi.fn((_dir: string, opts: RepoRootOptions) => {
      opts.cache?.set("seen", null);
      return "repo";
    });
    refreshMeta(
      [row, { ...row, path: "/home/u/p/b.md" }],
      { registry, readHead: () => "", statBirthtime: () => null, findRepoRoot: findRepo }
    );
    const firstCache = findRepo.mock.calls[0][1].cache;
    const secondCache = findRepo.mock.calls[1][1].cache;
    expect(firstCache).toBeInstanceOf(Map);
    expect(secondCache).toBe(firstCache);
  });
});

describe("withMeta", () => {
  it("joins stored meta onto index rows", () => {
    const metaByPath = new Map([
      ["/a.md", { birthtime_ms: 1, fm_project: "P", fm_block: "B", repo_name: "r" }],
    ]);
    const joined = withMeta([{ path: "/a.md", name: "a.md", dir: "/", mtimeMs: 9 }], metaByPath);
    expect(joined[0]).toMatchObject({
      path: "/a.md",
      name: "a.md",
      mtimeMs: 9,
      birthtimeMs: 1,
      fmProject: "P",
      fmBlock: "B",
      repoName: "r",
    });
  });

  it("fills nulls for rows the meta pass has not reached yet", () => {
    const joined = withMeta([{ path: "/b.md", name: "b.md", dir: "/", mtimeMs: 9 }], new Map());
    expect(joined[0]).toMatchObject({
      birthtimeMs: null,
      fmProject: null,
      fmBlock: null,
      repoName: null,
    });
  });
});
