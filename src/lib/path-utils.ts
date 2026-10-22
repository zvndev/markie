const lastSeparatorIndex = (value: string) =>
  Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));

export function pathBasename(value: string): string {
  const index = lastSeparatorIndex(value);
  return index === -1 ? value : value.slice(index + 1);
}

export function pathDirname(value: string): string | null {
  const index = lastSeparatorIndex(value);
  if (index === -1) return null;
  if (index === 0) return value[0];
  if (index === 2 && /^[A-Za-z]:[\\/]$/.test(value.slice(0, 3))) {
    return value.slice(0, 3);
  }
  return value.slice(0, index);
}

export function compactWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const documentsRoot = "/Documents/Markie";
  return normalized.endsWith(documentsRoot)
    ? `~${documentsRoot}`
    : pathBasename(value);
}

/** Compare already-authorized paths, never grant access based on this result. */
export function sameDocumentPath(left: string | null, right: string | null, platform?: string): boolean {
  if (!left || !right) return false;
  const normalized = (value: string) => platform === "win32" ? value.replace(/\\/g, "/").toLocaleLowerCase("en-US") : value;
  return normalized(left) === normalized(right);
}
