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
  const [roots, defaultPath] = await Promise.all([
    api.wsRoots(),
    api.wsDefaultPath(),
  ]);

  if (roots.length > 0) {
    return { roots, defaultPath, created: false };
  }

  const created = await api.wsCreateDefault();
  if (created.error) {
    return { roots: [], defaultPath, created: false, error: created.error };
  }

  const refreshed = await api.wsRoots();
  return {
    roots: refreshed.length > 0 ? refreshed : created.path ? [created.path] : [],
    defaultPath,
    created: true,
  };
}
