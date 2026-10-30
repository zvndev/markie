// The shape of the version history panel, as pure functions: which section a
// version falls in, which autosaves fold into one row, and what to call who
// wrote it. The component only renders what these return.
import type { HistoryEntry } from "@/lib/electron";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Autosaves this close to the newest one in a run fold under it. */
export const COLLAPSE_WINDOW_MS = 30 * MINUTE;

export interface VersionRow {
  /** The newest version in the run: the row the panel shows. */
  lead: HistoryEntry;
  /** Older versions folded under it, newest first. Empty for a single row. */
  minor: HistoryEntry[];
}

export interface VersionGroup {
  key: string;
  label: string;
  rows: VersionRow[];
}

export function versionMs(entry: Pick<HistoryEntry, "iso">): number {
  const ms = Date.parse(entry.iso);
  return Number.isFinite(ms) ? ms : 0;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Calendar days, not 24-hour blocks: 11pm last night is "Yesterday" at 8am.
function daysAgo(ms: number, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(ms))) / DAY);
}

/**
 * Today, Yesterday, This week (the five days before that), then the month by
 * name, with the year once it is not this year.
 */
export function sectionFor(ms: number, now: Date): { key: string; label: string } {
  const days = daysAgo(ms, now);
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "yesterday", label: "Yesterday" };
  if (days < 7) return { key: "week", label: "This week" };
  const d = new Date(ms);
  const month = d.toLocaleDateString("en-US", { month: "long" });
  const label = d.getFullYear() === now.getFullYear() ? month : `${month} ${d.getFullYear()}`;
  return { key: `m-${d.getFullYear()}-${d.getMonth()}`, label };
}

/** Who wrote a version, as one key: two agents are two authors. */
export function authorKey(entry: Pick<HistoryEntry, "author" | "agent">): string {
  return entry.author === "agent" ? `agent:${entry.agent ?? ""}` : entry.author;
}

/**
 * Group newest-first entries into sections, folding runs of unnamed versions
 * by the same author within COLLAPSE_WINDOW_MS of the run's newest version
 * into one expandable row. A named version always gets its own row, because
 * standing out from the autosaves is the point of naming it.
 */
export function groupVersions(
  entries: HistoryEntry[],
  now: Date,
  { windowMs = COLLAPSE_WINDOW_MS }: { windowMs?: number } = {}
): VersionGroup[] {
  const groups: VersionGroup[] = [];
  let group: VersionGroup | null = null;
  let row: VersionRow | null = null;
  for (const entry of entries) {
    const ms = versionMs(entry);
    const section = sectionFor(ms, now);
    if (!group || group.key !== section.key) {
      group = { ...section, rows: [] };
      groups.push(group);
      row = null;
    }
    const folds =
      row !== null &&
      !entry.name &&
      !row.lead.name &&
      authorKey(entry) === authorKey(row.lead) &&
      versionMs(row.lead) - ms <= windowMs;
    if (folds && row) {
      row.minor.push(entry);
    } else {
      row = { lead: entry, minor: [] };
      group.rows.push(row);
    }
  }
  return groups;
}

/** "October 30, 2:30 PM", with the year once it is not this year. */
export function formatVersionTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** "Today, 2:30 PM" for the header, like the row but anchored to the day. */
export function formatVersionHeading(iso: string, now: Date): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = daysAgo(d.getTime(), now);
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return formatVersionTime(iso, now);
}

// What MCP clients call themselves in `initialize`, and what a person calls
// them. Anything not listed is shown as the client sent it.
const KNOWN_AGENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude",
  "claude desktop": "Claude",
  "codex-mcp-client": "Codex",
  codex: "Codex",
  "cursor-vscode": "Cursor",
  cursor: "Cursor",
  windsurf: "Windsurf",
  "visual studio code": "VS Code",
  zed: "Zed",
  "gemini-cli-mcp-client": "Gemini CLI",
  opencode: "OpenCode",
  t3code: "T3 Code",
  "t3-code": "T3 Code",
};

export function agentDisplayName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name || name === "an agent") return "An agent";
  return KNOWN_AGENTS[name.toLowerCase()] ?? name;
}

export function authorLabel(entry: Pick<HistoryEntry, "author" | "agent">): string {
  switch (entry.author) {
    case "user":
      return "You";
    case "agent":
      return agentDisplayName(entry.agent);
    case "external":
      return "External edit";
    default:
      return "Unknown";
  }
}

// One colour per author, stable across sessions. You are always blue, outside
// edits are grey, and each agent gets its own hue from its name.
const AGENT_HUES = ["var(--purple)", "var(--orange)", "var(--green)", "var(--yellow)", "#2dd4bf", "#f472b6"];

export function authorColor(entry: Pick<HistoryEntry, "author" | "agent">): string {
  if (entry.author === "user") return "var(--blue)";
  if (entry.author !== "agent") return "var(--muted)";
  const name = agentDisplayName(entry.agent);
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AGENT_HUES[h % AGENT_HUES.length];
}
