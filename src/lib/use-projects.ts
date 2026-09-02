"use client";
// The renderer half of the projects engine: pulls index rows plus decisions,
// parses rules (with last-known-good fallback), computes the taxonomy, and
// persists the derived cache when the index fingerprint moves. All the heavy
// logic is in src/lib/projects/*; this hook is orchestration only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getElectronAPI, type MdRow } from "@/lib/electron";
import { inferHomePath } from "@/lib/path-display";
import { parseRules, type MarkieRules } from "@/lib/projects/rules";
import { buildTaxonomy, type Taxonomy } from "@/lib/projects/taxonomy";
import type { EngineFile } from "@/lib/projects/assign";

export interface ProjectsHandle {
  taxonomy: Taxonomy | null;
  // The real home directory, for shortening the paths a row shows.
  home: string;
  // True only until the first taxonomy exists. A recompute over fresh index
  // rows keeps the old tree on screen rather than flashing an empty state.
  loading: boolean;
  // Set when the index itself is still being built, so the view can say that
  // instead of claiming the user has no markdown.
  scanning: boolean;
  // Set while the metadata behind the taxonomy is still being extracted. The
  // tree computed right now would be wrong (repo names missing folds whole
  // machines into one project), so views wait rather than show it.
  preparing: boolean;
  rulesError: string | null;
  configPath: string | null;
  available: boolean;
  refresh: () => void;
  pin: (path: string, project: string, blockId: string | null) => Promise<void>;
  unpin: (path: string) => Promise<void>;
  rename: (blockId: string, customName: string) => Promise<void>;
  merge: (blockId: string, mergeInto: string) => Promise<void>;
  renameProject: (project: string, customName: string | null) => Promise<void>;
  createProject: (name: string) => Promise<void>;
}

// The index rows carry the four metadata fields as optionals (they are joined
// in after the scan). The engine wants them settled.
function toEngineFiles(rows: MdRow[]): EngineFile[] {
  return rows.map((r) => ({
    path: r.path,
    name: r.name,
    dir: r.dir,
    mtimeMs: r.mtimeMs,
    birthtimeMs: r.birthtimeMs ?? null,
    fmProject: r.fmProject ?? null,
    fmBlock: r.fmBlock ?? null,
    repoName: r.repoName ?? null,
  }));
}

export function useProjects(refreshKey: number): ProjectsHandle {
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [home, setHome] = useState("");
  // Derived rather than stored: without a desktop bridge there is nothing to
  // load, and setting that synchronously inside the effect is a cascading
  // render React now rejects outright.
  const [loaded, setLoaded] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const savedFingerprint = useRef<string | null>(null);
  const available = Boolean(getElectronAPI()?.projectsState);
  const loading = available && !loaded;

  const refresh = useCallback(() => setBump((n) => n + 1), []);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.projectsState || !api.projectsConfig || !api.mdIndexScan) return;
    let alive = true;

    const compute = async (override?: {
      files: MdRow[];
      scannedAt: string | null;
      metaPending?: boolean;
    }) => {
      const [state, cfg, scan] = await Promise.all([
        api.projectsState!(),
        api.projectsConfig!(),
        override ? Promise.resolve(null) : api.mdIndexScan!(),
      ]);
      if (!alive) return;
      setConfigPath(cfg?.path ?? null);

      // Rules: the current document first, last-known-good on a parse error.
      // An empty view is a bug, not a fallback.
      let error: string | null = null;
      const parsed = parseRules(cfg?.content ?? "");
      let rules: MarkieRules | null = parsed.rules;
      if (!rules) {
        error = parsed.error;
        const fallback = state?.rulesKnownGood ? parseRules(state.rulesKnownGood) : null;
        rules = fallback?.rules ?? parseRules("").rules;
      }
      setRulesError(error);

      const rows = override ? override.files : Array.isArray(scan?.files) ? scan.files : [];
      const scannedAt = override ? override.scannedAt : (scan?.scannedAt ?? null);
      const metaPending = Boolean(override ? override.metaPending : scan?.metaPending);
      const files = toEngineFiles(rows);
      const home = cfg?.home || inferHomePath(rows.map((r) => r.path)) || "";
      const next = buildTaxonomy(files, {
        pins: state?.pins ?? [],
        rules: rules!,
        priorAssignments: state?.assignments ?? [],
        knownBlocks: state?.blocks ?? [],
        projectNames: state?.projectNames ?? [],
        home,
      });
      if (!alive) return;
      setTaxonomy(next);
      setHome(home);
      // "No projects yet" and "we have not looked yet" are different answers,
      // and only one of them is the user's fault. Browse used to say the
      // former while a walk of 12,000 files was still running.
      setScanning(rows.length === 0 && !scannedAt);
      setPreparing(metaPending);
      setLoaded(true);

      // Persist the derived state when the index moved (or on a first run),
      // and record the rules that produced it as known-good when they parsed.
      const fp = state?.fingerprint ?? "";
      if (fp && savedFingerprint.current !== fp) {
        savedFingerprint.current = fp;
        void api.projectsSaveCache?.({
          fingerprint: fp,
          assignments: next.assignmentRows.map((r) => ({
            path: r.path,
            project: r.project,
            blockId: r.blockId,
            source: r.source,
            mtimeMs: r.mtimeMs,
          })),
          blocks: next.blockUpserts,
          ...(error === null ? { rulesKnownGood: cfg?.content ?? "" } : {}),
        });
      }
    };

    void compute();

    // The metadata pass runs after the scan, so the first tree is drawn before
    // repo names exist. Main re-broadcasts when it finishes; recompute rather
    // than leave the user looking at a worse answer than we now have.
    const off = api.onMdIndexUpdated?.((payload) => {
      if (!alive) return;
      if (Array.isArray(payload?.files)) {
        void compute({
          files: payload.files,
          scannedAt: payload.scannedAt ?? null,
          metaPending: payload.metaPending,
        });
      } else {
        void compute();
      }
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [refreshKey, bump]);

  const act = useCallback(
    async (run: (api: NonNullable<ReturnType<typeof getElectronAPI>>) => Promise<unknown>) => {
      const api = getElectronAPI();
      if (!api) return;
      await run(api);
      refresh();
    },
    [refresh]
  );

  const pin = useCallback(
    (path: string, project: string, blockId: string | null) =>
      act((api) => api.projectsPin?.({ path, project, blockId }) ?? Promise.resolve()),
    [act]
  );
  const unpin = useCallback(
    (path: string) => act((api) => api.projectsPin?.({ path, clear: true }) ?? Promise.resolve()),
    [act]
  );
  const rename = useCallback(
    (blockId: string, customName: string) =>
      act((api) => api.projectsBlockSet?.({ blockId, customName }) ?? Promise.resolve()),
    [act]
  );
  const merge = useCallback(
    (blockId: string, mergeInto: string) =>
      act((api) => api.projectsBlockSet?.({ blockId, mergeInto }) ?? Promise.resolve()),
    [act]
  );
  const renameProject = useCallback(
    (project: string, customName: string | null) =>
      act((api) => api.projectsProjectSet?.({ project, customName }) ?? Promise.resolve()),
    [act]
  );
  const createProject = useCallback(
    (name: string) => act((api) => api.projectsCreate?.({ name }) ?? Promise.resolve()),
    [act]
  );

  return useMemo(
    () => ({
      taxonomy,
      home,
      loading,
      scanning,
      preparing,
      rulesError,
      configPath,
      available,
      refresh,
      pin,
      unpin,
      rename,
      merge,
      renameProject,
      createProject,
    }),
    [
      taxonomy,
      home,
      loading,
      scanning,
      preparing,
      rulesError,
      configPath,
      available,
      refresh,
      pin,
      unpin,
      rename,
      merge,
      renameProject,
      createProject,
    ]
  );
}
