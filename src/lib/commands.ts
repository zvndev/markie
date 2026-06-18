export interface AppCommand {
  id: string;
  title: string;
  group: "File" | "View" | "Format" | "Theme" | "Help";
  shortcut?: string; // display form, e.g. "⌘S"
  keywords?: string;
  run: () => void;
}

interface Ranked {
  command: AppCommand;
  score: number;
}

// Rank: exact prefix > word-boundary prefix > substring > subsequence.
function scoreMatch(haystack: string, query: string): number {
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (h.startsWith(q)) return 100 - h.length * 0.01;
  const words = h.split(/[\s/]+/);
  if (words.some((w) => w.startsWith(q))) return 80 - h.length * 0.01;
  if (h.includes(q)) return 60 - h.indexOf(q) * 0.1;
  // subsequence
  let qi = 0;
  for (const ch of h) {
    if (ch === q[qi]) qi++;
    if (qi === q.length) return 30 - h.length * 0.01;
  }
  return 0;
}

export function filterCommands(
  commands: AppCommand[],
  query: string
): AppCommand[] {
  if (!query.trim()) return commands;
  return commands
    .map(
      (command): Ranked => ({
        command,
        score: Math.max(
          scoreMatch(command.title, query),
          scoreMatch(command.keywords ?? "", query) * 0.9,
          scoreMatch(command.group, query) * 0.5
        ),
      })
    )
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.command);
}
