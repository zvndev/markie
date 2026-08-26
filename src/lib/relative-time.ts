// How long ago, in words. Two forms because two surfaces need different room:
// a strip has a sentence to spare, a tree row has about three characters.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / MINUTE);
  if (min < 1) return "moments ago";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// The badge form: "now", "5m", "3h", "2d", "3w", "5mo", "2y". Never wider than
// four characters, so a row's name never has to give up space for its date.
export function shortAgo(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return "";
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  const days = Math.floor(delta / DAY);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

// The long form for a timestamp we hold as a number rather than an ISO string.
export function longAgo(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return "";
  return relativeTime(new Date(ms).toISOString(), now);
}
