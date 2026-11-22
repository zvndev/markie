//! Link previews: which URLs Markie may fetch, and the few strings a preview
//! card is made of. A port of the pure half of `electron/link-preview.js`.
//! The fetch itself (DNS pinned to the checked address, 512 KB cap, 6 s
//! timeout, 4 redirects) lands with the networking in phase 3.

use std::net::IpAddr;
use std::sync::LazyLock;

use regex::Regex;
use url::Url;

pub const MAX_HTML_BYTES: usize = 512 * 1024;
pub const MAX_IMAGE_BYTES: usize = 512 * 1024;
pub const MAX_REDIRECTS: usize = 4;
pub const TIMEOUT_MS: u64 = 6000;
const MAX_TEXT: usize = 300;
const MAX_URL_LENGTH: usize = 8192;

/// True for any address a preview must never reach: loopback, private,
/// link-local (including cloud metadata), carrier NAT, documentation and
/// benchmark ranges, multicast, and every IPv6 address outside 2000::/3.
pub fn is_private_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            a == 0
                || a == 10
                || a == 127
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            let (a, b) = (seg[0], seg[1]);
            !(0x2000..=0x3fff).contains(&a)
                || (a == 0x2001 && (b < 0x200 || b == 0xdb8))
                || a == 0x2002
                || (a == 0x3fff && b < 0x1000)
        }
    }
}

static SENSITIVE_PARAM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:token|authorization|password|passwd|secret|signature|credential|session)|(?:^|[-_])(?:key|auth|code|jwt|sig)(?:$|[-_])").unwrap()
});
static SENSITIVE_EXACT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:accessToken|apiKey|clientSecret)$").unwrap());
static SENSITIVE_HASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:token|secret|password|credential|authorization)\s*(?:=|%3d)").unwrap());
static SENSITIVE_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/(?:reset[-_]?password|password[-_]?reset|magic[-_]?link|auth/callback)(?:/|$)").unwrap()
});

/// The URL to fetch for a preview, or `None` when Markie must not fetch it:
/// not http(s), local hosts, credentials, explicit ports, anything that looks
/// like a secret or a one-time sign-in link. The fragment is dropped.
pub fn parse_target(raw: &str) -> Option<Url> {
    if raw.len() > MAX_URL_LENGTH {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return None;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_address(ip) {
            return None;
        }
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    if url.query_pairs().any(|(k, _)| SENSITIVE_PARAM.is_match(&k) || SENSITIVE_EXACT.is_match(&k)) {
        return None;
    }
    if url.fragment().is_some_and(|f| SENSITIVE_HASH.is_match(f)) || SENSITIVE_PATH.is_match(url.path()) {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PreviewMeta {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image_url: Option<String>,
}

/// JavaScript's `\s`, which `clean` collapses and trims: Unicode white
/// space without U+0085, plus U+FEFF.
fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// `String.fromCodePoint` as the card shows it: a lone surrogate becomes
/// U+FFFD, as the renderer draws it.
fn from_code_point(code: u64) -> Option<char> {
    if code > 0x10ffff {
        return None;
    }
    Some(char::from_u32(code as u32).unwrap_or('\u{fffd}'))
}

/// `Number.parseInt(digits, radix)`: the longest valid prefix, or None.
fn js_parse_int(digits: &str, radix: u32) -> Option<u64> {
    let prefix: String = digits.chars().take_while(|c| c.is_digit(radix)).collect();
    let trimmed = prefix.trim_start_matches('0');
    if prefix.is_empty() {
        return None;
    }
    if trimmed.len() > 8 {
        return Some(u64::MAX);
    }
    Some(u64::from_str_radix(if trimmed.is_empty() { "0" } else { trimmed }, radix).unwrap_or(u64::MAX))
}

/// `decodeEntities` in `electron/link-preview.js`.
fn decode_entities(text: &str) -> String {
    static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&(#x?[0-9a-f]+|[a-z]+);").unwrap());
    ENTITY
        .replace_all(text, |c: &regex::Captures<'_>| {
            let key = c[1].to_lowercase();
            let named = match key.as_str() {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" | "#x27" => Some('\''),
                "nbsp" => Some(' '),
                _ => None,
            };
            let code = named.or_else(|| {
                let n = if let Some(hex) = key.strip_prefix("#x") {
                    js_parse_int(hex, 16)
                } else {
                    key.strip_prefix('#').and_then(|d| js_parse_int(d, 10))
                };
                n.and_then(from_code_point)
            });
            code.map_or_else(|| c[0].to_string(), String::from)
        })
        .into_owned()
}

/// `clean`: entities decoded, white space collapsed, and at most `MAX_TEXT`
/// UTF-16 units, as JavaScript counts and slices them.
fn clean(text: &str) -> String {
    let decoded = decode_entities(text);
    let flat = decoded.split(is_js_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let units: Vec<u16> = flat.encode_utf16().collect();
    if units.len() <= MAX_TEXT {
        return flat;
    }
    let cut = String::from_utf16_lossy(&units[..MAX_TEXT - 1]);
    format!("{}…", cut.trim_end_matches(is_js_space))
}

/// The preview strings from a page's `<head>`, by string scan only. A line
/// for line port of `parseMeta`.
pub fn parse_meta(html: &str) -> PreviewMeta {
    static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<meta\b([^>]*?)/?>").unwrap());
    static ATTR: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap()
    });
    static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
    let lower = html.to_ascii_lowercase();
    let head = &html[..lower.find("</head>").unwrap_or(html.len())];
    let mut found: Vec<(String, String)> = Vec::new();
    for tag in META.captures_iter(head) {
        // Later attributes of the same name win, as `attrs.set` does.
        let mut attrs: Vec<(String, String)> = Vec::new();
        for a in ATTR.captures_iter(&tag[1]) {
            let name = a[1].to_lowercase();
            let value = a.get(2).or(a.get(3)).or(a.get(4)).map_or("", |m| m.as_str()).to_string();
            match attrs.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = value,
                None => attrs.push((name, value)),
            }
        }
        let attr = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty());
        let key = attr("property").or_else(|| attr("name")).unwrap_or("").to_lowercase();
        let content = attr("content");
        if let Some(content) = content {
            if !key.is_empty() && !found.iter().any(|(f, _)| *f == key) {
                found.push((key, content.to_string()));
            }
        }
    }
    let get = |k: &str| found.iter().find(|(f, _)| f == k).map(|(_, v)| v.clone());
    let pick = |keys: &[&str]| keys.iter().filter_map(|k| get(k)).map(|v| clean(&v)).find(|v| !v.is_empty());
    PreviewMeta {
        // `pick(...) || (titleTag ? clean(titleTag[1]) : null)`: an empty
        // title tag gives "", which the card treats as no title.
        title: pick(&["og:title", "twitter:title"]).or_else(|| TITLE.captures(head).map(|c| clean(&c[1]))),
        description: pick(&["og:description", "twitter:description", "description"]),
        site_name: pick(&["og:site_name", "application-name"]),
        image_url: get("og:image").or_else(|| get("twitter:image")).or_else(|| get("og:image:url")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_private_and_secret_targets() {
        assert!(parse_target("https://example.com/post#intro").is_some_and(|u| u.fragment().is_none()));
        for bad in [
            "http://localhost/x",
            "http://127.0.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.5/",
            "http://[::1]/",
            "https://example.com:8443/",
            "https://user:pw@example.com/",
            "https://example.com/?token=abc",
            "https://example.com/?api_key=abc",
            "https://example.com/auth/callback?x=1",
            "https://printer.local/",
            "file:///etc/passwd",
        ] {
            assert!(parse_target(bad).is_none(), "{bad}");
        }
        assert!(!is_private_address("8.8.8.8".parse().unwrap()));
        assert!(is_private_address("100.64.1.1".parse().unwrap()));
        assert!(!is_private_address("2606:4700::1111".parse().unwrap()));
        assert!(is_private_address("fe80::1".parse().unwrap()));
    }

    #[test]
    fn reads_the_card_strings() {
        let html = r#"<html><head><title> Fallback  title </title>
            <meta property="og:title" content="Ship it &amp; rest">
            <meta name='description' content='A   short&#x27;s description'>
            <meta property=og:site_name content=Example>
            <meta property="og:image" content="https://example.com/i.png"/>
            </head><body><meta property="og:title" content="ignored"></body></html>"#;
        assert_eq!(
            parse_meta(html),
            PreviewMeta {
                title: Some("Ship it & rest".into()),
                description: Some("A short's description".into()),
                site_name: Some("Example".into()),
                image_url: Some("https://example.com/i.png".into()),
            }
        );
        assert_eq!(parse_meta("<title>Only</title>").title.as_deref(), Some("Only"));
    }
}
