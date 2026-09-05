// Which video links become a card, and what the card is made of.
//
// Kept in step with src/lib/embeds.ts. The server deliberately imports nothing
// from the app's module graph, so this is a copy, and the two test suites pin
// the same examples.
//
// The list is short on purpose. A card draws somebody else's page inside a
// document, so a provider gets in by being one the reader would expect to see
// there, not by having an oEmbed endpoint.

export type EmbedProvider = "youtube" | "vimeo";

export interface Embed {
  provider: EmbedProvider;
  id: string;
  /** The address as it was written, which is what the file keeps. */
  url: string;
  /** Seconds into the video to start, when the link says so. */
  start: number | null;
}

interface ProviderSpec {
  label: string;
  hosts: ReadonlySet<string>;
  idFrom(url: URL): string | null;
  frameOrigin: string;
  frame(id: string, start: number | null): string;
  /** A picture for the card without asking anyone, or null when there is none. */
  thumbnail: ((id: string) => string) | null;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host === "youtu.be") {
    id = parts[0] ?? null;
  } else if (parts[0] === "watch") {
    id = url.searchParams.get("v");
  } else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) {
    id = parts[1] ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

// `t=90`, `t=90s`, `t=1m30s`: the forms YouTube itself writes.
function startSeconds(url: URL): number | null {
  const raw = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (!raw) return null;
  if (/^\d+s?$/.test(raw)) return Number.parseInt(raw, 10) || null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m) return null;
  const total = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return total > 0 ? total : null;
}

const PROVIDERS: Record<EmbedProvider, ProviderSpec> = {
  youtube: {
    label: "YouTube",
    hosts: new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"]),
    idFrom: youtubeId,
    // The nocookie host: the same player, without the tracking cookies the
    // ordinary embed sets before anyone has pressed play.
    frameOrigin: "https://www.youtube-nocookie.com",
    frame: (id, start) =>
      `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ""}`,
    thumbnail: (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  },
  vimeo: {
    label: "Vimeo",
    hosts: new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]),
    idFrom: (url) => {
      const m = /^\/(?:video\/)?(\d{6,12})\/?$/.exec(url.pathname);
      return m ? m[1] : null;
    },
    frameOrigin: "https://player.vimeo.com",
    frame: (id, start) =>
      `https://player.vimeo.com/video/${id}?autoplay=1${start ? `#t=${start}s` : ""}`,
    // Vimeo has no address a thumbnail can be guessed from.
    thumbnail: null,
  },
};

/** Every origin a card may load a player from; the CSP has to list these. */
export const EMBED_FRAME_ORIGINS: readonly string[] = Object.values(PROVIDERS).map((p) => p.frameOrigin);

/** The embed a link stands for, or null when it is just a link. */
export function parseEmbed(raw: string | null | undefined): Embed | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  for (const [provider, spec] of Object.entries(PROVIDERS) as [EmbedProvider, ProviderSpec][]) {
    if (!spec.hosts.has(host)) continue;
    const id = spec.idFrom(url);
    if (!id) return null;
    return { provider, id, url: text, start: startSeconds(url) };
  }
  return null;
}

export function embedLabel(embed: Embed): string {
  return PROVIDERS[embed.provider].label;
}

export function embedFrameUrl(embed: Embed): string {
  return PROVIDERS[embed.provider].frame(embed.id, embed.start);
}

export function embedThumbnailUrl(embed: Embed): string | null {
  const thumb = PROVIDERS[embed.provider].thumbnail;
  return thumb ? thumb(embed.id) : null;
}
