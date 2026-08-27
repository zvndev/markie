const POSIX_HOME_RE = /^\/(?:Users|home)\/[^/\\]+/;
const WINDOWS_HOME_RE = /^[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+/i;

function isWindowsPath(input: string) {
  return /^[A-Za-z]:[\\/]/.test(input) || input.includes("\\");
}

function displaySeparator(input: string, home: string) {
  return isWindowsPath(input) || isWindowsPath(home) ? "\\" : "/";
}

function pathStartsWithHome(input: string, home: string) {
  if (!input || !home) return false;
  const normalizedInput = input.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedHome = home.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = isWindowsPath(input) || isWindowsPath(home);
  const p = windows ? normalizedInput.toLowerCase() : normalizedInput;
  const h = windows ? normalizedHome.toLowerCase() : normalizedHome;
  return p === h || p.startsWith(`${h}/`);
}

export function inferHomePath(paths: string[]) {
  for (const input of paths) {
    const p = input.trim();
    if (!p) continue;
    const windows = p.match(WINDOWS_HOME_RE);
    if (windows) return windows[0];
    const posix = p.match(POSIX_HOME_RE);
    if (posix) return posix[0];
  }
  return "";
}

export function compactHomePath(input: string, home: string, showFullHome: boolean) {
  if (!pathStartsWithHome(input, home)) return input;
  const rest = input.slice(home.length).replace(/^[\\/]/, "");
  if (!rest) return showFullHome ? "~" : "";
  if (!showFullHome) return rest;
  return `~${displaySeparator(input, home)}${rest}`;
}

// The directory a file sits in, sized for a table row rather than for a shell.
// The Projects rows used to print the whole absolute path, so every line in
// the list opened with the same forty characters of somebody's home directory
// and the file name lost the race for attention. Home folds to "~", and
// anything deeper than `keep` segments keeps only the last ones, because the
// tail is the part that says which piece of work this is. The full path stays
// one hover away on the row itself.
export function compactDir(dir: string, home: string, keep = 2) {
  const input = String(dir ?? "");
  if (!input) return "";
  const sep = displaySeparator(input, home);
  const compact = compactHomePath(input, home, true);
  const segments = compact.split(/[\\/]/).filter(Boolean);
  if (segments.length <= keep) return segments.join(sep);
  return `…${sep}${segments.slice(-keep).join(sep)}`;
}
