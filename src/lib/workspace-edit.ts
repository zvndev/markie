import type { WsResult } from "@/lib/electron";

export type WorkspaceEditKind = "new-folder" | "new-file" | "rename";

export function openedPathAfterWorkspaceEdit(
  kind: WorkspaceEditKind,
  result: WsResult | undefined
): string | null {
  return kind === "new-file" && result?.ok && result.path && !result.error
    ? result.path
    : null;
}
