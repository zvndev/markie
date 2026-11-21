//! Video links that TipTap shows as an embed card (`src/lib/embeds.ts`).

pub fn is_embed(raw: &str) -> bool {
    let text = raw.trim();
    let lower = text.to_ascii_lowercase();
    let rest = match lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        Some(r) => r,
        None => return false,
    };
    let off = text.len() - rest.len();
    let (host, tail) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &text[off + i..]),
        None => (rest, ""),
    };
    let (path, query) = match tail.find('?') {
        Some(i) => (&tail[..i], &tail[i + 1..]),
        None => (tail, ""),
    };
    let path = path.split('#').next().unwrap_or("");
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match host {
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be" | "www.youtube-nocookie.com" => {
            let id = if host == "youtu.be" {
                parts.first().map(|s| s.to_string())
            } else if parts.first() == Some(&"watch") {
                query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("v=").map(|v| v.to_string()))
            } else if matches!(parts.first(), Some(&"shorts" | &"embed" | &"live" | &"v")) {
                parts.get(1).map(|s| s.to_string())
            } else {
                None
            };
            id.is_some_and(|id| {
                id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
        }
        "vimeo.com" | "www.vimeo.com" | "player.vimeo.com" => {
            let p: Vec<&str> = if parts.first() == Some(&"video") { parts[1..].to_vec() } else { parts };
            p.len() == 1 && (6..=12).contains(&p[0].len()) && p[0].chars().all(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}
