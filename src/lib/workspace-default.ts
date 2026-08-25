import type { ElectronAPI } from "@/lib/electron";

type WorkspaceAPI = Pick<
  ElectronAPI,
  "wsRoots" | "wsDefaultPath" | "wsCreateDefault"
>;

export interface WorkspaceBootstrapResult {
  roots: string[];
  defaultPath: string;
  created: boolean;
  error?: string;
}

export async function ensureDefaultWorkspaceRoot(
  api: WorkspaceAPI
): Promise<WorkspaceBootstrapResult> {
  const [roots, rawDefault] = await Promise.all([
    api.wsRoots(),
    api.wsDefaultPath(),
  ]);
  const defaultPath = typeof rawDefault === "string" ? rawDefault : "";

  // wsRoots answers `[]` on failure, but safeApi can still fold a rejected
  // invoke into `{ error }` — which has no `.length` and is not a list.
  const known = Array.isArray(roots) ? roots : [];
  if (known.length > 0) {
    return { roots: known, defaultPath, created: false };
  }

  const created = await api.wsCreateDefault();
  if (created.error) {
    return { roots: [], defaultPath, created: false, error: created.error };
  }

  const refreshed = await api.wsRoots();
  const list = Array.isArray(refreshed) ? refreshed : [];
  return {
    roots: list.length > 0 ? list : created.path ? [created.path] : [],
    defaultPath,
    created: true,
  };
}
