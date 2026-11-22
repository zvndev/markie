//! Which video links become a card, and what the card is made of. A port of
//! `src/lib/embeds.ts` (the server keeps a copy too). Used by the export
//! renderer for the thumbnail card and by the video island for the player.

use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    YouTube,
    Vimeo,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Embed {
    pub provider: Provider,
    pub id: String,
    /// The address as it was written, which is what the file keeps.
    pub url: String,
    /// Seconds into the video to start, when the link says so.
    pub start: Option<u64>,
}

const YOUTUBE_HOSTS: &[&str] = &["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"];
const VIMEO_HOSTS: &[&str] = &["vimeo.com", "www.vimeo.com", "player.vimeo.com"];

/// Every origin a card may load a player from.
pub const EMBED_FRAME_ORIGINS: &[&str] = &["https://www.youtube-nocookie.com", "https://player.vimeo.com"];

fn youtube_id(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let parts: Vec<&str> = url.path().split('/').filter(|p| !p.is_empty()).collect();
    let id = if host == "youtu.be" {
        parts.first().map(|s| s.to_string())
    } else if parts.first() == Some(&"watch") {
        url.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned())
    } else if matches!(parts.first(), Some(&("shorts" | "embed" | "live" | "v"))) {
        parts.get(1).map(|s| s.to_string())
    } else {
        None
    }?;
    (id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then_some(id)
}

fn vimeo_id(url: &Url) -> Option<String> {
    let path = url.path();
    let rest = path.strip_prefix('/')?;
    let rest = rest.strip_prefix("video/").unwrap_or(rest);
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    ((6..=12).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_digit())).then(|| rest.to_string())
}

fn start_seconds(url: &Url) -> Option<u64> {
    let raw = url.query_pairs().find(|(k, _)| k == "t").or_else(|| url.query_pairs().find(|(k, _)| k == "start"))?.1.into_owned();
    if raw.is_empty() {
        return None;
    }
    let digits = raw.strip_suffix('s').unwrap_or(&raw);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        return digits.parse::<u64>().ok().filter(|n| *n > 0);
    }
    // 1h2m3s, each part optional, in that order.
    let mut total = 0u64;
    let mut rest = raw.as_str();
    let mut any = false;
    for unit in ['h', 'm', 's'] {
        if let Some(at) = rest.find(unit) {
            let n = &rest[..at];
            if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            total += n.parse::<u64>().ok()? * match unit {
                'h' => 3600,
                'm' => 60,
                _ => 1,
            };
            rest = &rest[at + 1..];
            any = true;
        }
    }
    (rest.is_empty() && any && total > 0).then_some(total)
}

/// The embed a link stands for, or None when it is just a link.
pub fn parse_embed(raw: &str) -> Option<Embed> {
    let text = raw.trim();
    let lower = text.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    let url = Url::parse(text).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let (provider, id) = if YOUTUBE_HOSTS.contains(&host.as_str()) {
        (Provider::YouTube, youtube_id(&url)?)
    } else if VIMEO_HOSTS.contains(&host.as_str()) {
        (Provider::Vimeo, vimeo_id(&url)?)
    } else {
        return None;
    };
    Some(Embed { provider, id, url: text.to_string(), start: start_seconds(&url) })
}

impl Embed {
    pub fn label(&self) -> &'static str {
        match self.provider {
            Provider::YouTube => "YouTube",
            Provider::Vimeo => "Vimeo",
        }
    }

    /// The player address. The YouTube one is the nocookie host.
    pub fn frame_url(&self) -> String {
        match self.provider {
            Provider::YouTube => format!(
                "https://www.youtube-nocookie.com/embed/{}?autoplay=1&rel=0{}",
                self.id,
                self.start.map(|s| format!("&start={s}")).unwrap_or_default()
            ),
            Provider::Vimeo => format!(
                "https://player.vimeo.com/video/{}?autoplay=1{}",
                self.id,
                self.start.map(|s| format!("#t={s}s")).unwrap_or_default()
            ),
        }
    }

    pub fn frame_origin(&self) -> &'static str {
        match self.provider {
            Provider::YouTube => EMBED_FRAME_ORIGINS[0],
            Provider::Vimeo => EMBED_FRAME_ORIGINS[1],
        }
    }

    /// A picture for the card without asking anyone. Vimeo has none.
    pub fn thumbnail_url(&self) -> Option<String> {
        match self.provider {
            Provider::YouTube => Some(format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", self.id)),
            Provider::Vimeo => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cases src/lib/embeds.test.ts pins.
    #[test]
    fn parses_like_the_typescript() {
        let e = parse_embed("https://youtu.be/dQw4w9WgXcQ?t=1m30s").unwrap();
        assert_eq!((e.provider, e.id.as_str(), e.start), (Provider::YouTube, "dQw4w9WgXcQ", Some(90)));
        assert_eq!(e.frame_url(), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=90");
        let w = parse_embed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s").unwrap();
        assert_eq!(w.start, Some(42));
        assert!(parse_embed("https://youtube.com/watch?v=short").is_none());
        let v = parse_embed("https://vimeo.com/123456789").unwrap();
        assert_eq!(v.frame_url(), "https://player.vimeo.com/video/123456789?autoplay=1");
        assert!(v.thumbnail_url().is_none());
        assert!(parse_embed("ftp://youtu.be/dQw4w9WgXcQ").is_none());
        assert!(parse_embed("https://example.com/watch?v=dQw4w9WgXcQ").is_none());
    }
}
