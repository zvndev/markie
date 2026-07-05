import type { ElectronAPI } from "@/lib/electron";
import { readLibrarySnapshot, type LibrarySnapshot } from "./library-state";
import {
  ensureDefaultWorkspaceRoot,
  type WorkspaceBootstrapResult,
} from "./workspace-default";

type LibraryStartupAPI = Pick<ElectronAPI, "libraryState"> &
  Partial<Pick<ElectronAPI, "wsRoots" | "wsDefaultPath" | "wsCreateDefault">>;

export interface LibraryStartupSnapshot extends LibrarySnapshot {
  workspace: WorkspaceBootstrapResult | null;
}

function hasWorkspaceAPI(
  api: LibraryStartupAPI
): api is LibraryStartupAPI &
  Pick<ElectronAPI, "wsRoots" | "wsDefaultPath" | "wsCreateDefault"> {
  return Boolean(api.wsRoots && api.wsDefaultPath && api.wsCreateDefault);
}

function workspaceBootstrapError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  const detail = raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
  return `Markie couldn't set up its default workspace: ${detail}`;
}

export async function readLibraryStartupSnapshot(
  api: LibraryStartupAPI
): Promise<LibraryStartupSnapshot> {
  let workspace: WorkspaceBootstrapResult | null = null;
  if (hasWorkspaceAPI(api)) {
    try {
      workspace = await ensureDefaultWorkspaceRoot(api);
    } catch (error) {
      workspace = {
        roots: [],
        defaultPath: "",
        created: false,
        error: workspaceBootstrapError(error),
      };
    }
  }

  const library = await readLibrarySnapshot(api);
  return {
    ...library,
    workspace,
    error: library.error ?? workspace?.error ?? null,
  };
}
