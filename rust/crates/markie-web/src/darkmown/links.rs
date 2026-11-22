//! Which links and pictures a `.wd` preview keeps. The port of
//! `src/lib/darkmown/links.ts` and the matching rules in
//! `electron/darkmown-preview.js` (main checks again, so both run here too:
//! the sanitizer decides what reaches the frame, the host decides what opens).

use url::Url;

const MAX_URL: usize = 8192;
const MAX_REF: usize = 2048;
const MAIL_FIELDS: &[&str] = &["subject", "body", "cc", "bcc"];
const PICTURE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"];

/// `/^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/`
fn address(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else { return false };
    if local.is_empty() || local.len() > 64 || !local.bytes().all(|b| b.is_ascii_alphanumeric() || b"._%+-".contains(&b)) {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let (tld, rest) = labels.split_last().unwrap();
    if !(2..=63).contains(&tld.len()) || !tld.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    rest.iter().all(|l| {
        let b = l.as_bytes();
        !b.is_empty()
            && b.len() <= 63
            && b[0].is_ascii_alphanumeric()
            && b[b.len() - 1].is_ascii_alphanumeric()
            && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
    })
}

fn address_list(value: &str) -> bool {
    let parts: Vec<&str> = value.split(',').map(str::trim).collect();
    !parts.is_empty() && parts.len() <= 20 && parts.iter().all(|p| address(p))
}

fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn js_len(s: &str) -> usize {
    crate::json::js_len(s)
}

/// An http(s) page or a simple mail draft, normalized; anything else is None.
pub fn darkmown_link_target(value: &str) -> Option<String> {
    if value.is_empty() || js_len(value) > MAX_URL {
        return None;
    }
    if value.chars().any(|c| (c as u32) <= 0x20 || c == '\u{7f}' || c == '\\') {
        return None;
    }
    let url = Url::parse(value).ok()?;
    match url.scheme() {
        "http" | "https" => {
            let lower = value.to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                return None;
            }
            if url.host_str().is_none_or(str::is_empty) || !url.username().is_empty() || url.password().is_some() {
                return None;
            }
            Some(url.to_string())
        }
        "mailto" => {
            if url.fragment().is_some() {
                return None;
            }
            let to = decode_uri_component(url.path())?;
            if !to.is_empty() && !address_list(&to) {
                return None;
            }
            let mut fields = 0;
            for (key, field) in url.query_pairs() {
                let name = key.to_ascii_lowercase();
                fields += 1;
                if !MAIL_FIELDS.contains(&name.as_str()) || fields > 8 || js_len(&field) > 2000 {
                    return None;
                }
                if name != "body" && (field.contains('\r') || field.contains('\n')) {
                    return None;
                }
                if (name == "cc" || name == "bcc") && !address_list(&field) {
                    return None;
                }
            }
            if to.is_empty() && fields == 0 {
                return None;
            }
            Some(url.to_string())
        }
        _ => None,
    }
}

fn has_scheme(s: &str) -> bool {
    match s.find(':') {
        Some(c) if c > 0 => {
            let scheme = &s[..c];
            scheme.as_bytes()[0].is_ascii_alphabetic() && scheme.bytes().all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
        }
        _ => false,
    }
}

fn control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}' || c == '\\')
}

/// The picture reference as written, when it names an image file inside the
/// document's own folder.
pub fn darkmown_picture_ref(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() || js_len(raw) > MAX_REF || control(raw) {
        return None;
    }
    if raw.starts_with('/') || has_scheme(raw) {
        return None;
    }
    let bare = raw.split('#').next()?.split('?').next()?;
    let decoded = decode_uri_component(bare).unwrap_or_else(|| bare.to_string());
    if decoded.is_empty() || decoded.starts_with('/') || (decoded.len() >= 2 && decoded.as_bytes()[0].is_ascii_alphabetic() && decoded.as_bytes()[1] == b':') || control(&decoded) {
        return None;
    }
    if decoded.split('/').any(|seg| seg == "..") {
        return None;
    }
    let ext = decoded.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
    PICTURE_EXT.contains(&ext.as_str()).then(|| raw.to_string())
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The address of a picture inside a scope main issued for this document.
pub fn darkmown_picture_url(base: &str, reference: &str) -> String {
    format!("{base}/{}", encode_uri_component(reference))
}

/// A base exactly as the host issues it: `markie-asset://wd-<32 hex>`.
pub fn is_darkmown_picture_base(value: &str) -> bool {
    value.strip_prefix("markie-asset://wd-").is_some_and(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// `relativeRef` (main's check of a picture request's path).
pub fn relative_ref(raw: &str) -> Option<&str> {
    if raw.is_empty() || js_len(raw) > MAX_REF || control(raw) || raw.starts_with('/') || has_scheme(raw) {
        return None;
    }
    let bare = raw.split('#').next()?.split('?').next()?;
    let bare = decode_uri_component(bare).unwrap_or_else(|| bare.to_string());
    if bare.is_empty() || bare.starts_with('/') || (bare.len() >= 2 && bare.as_bytes()[0].is_ascii_alphabetic() && bare.as_bytes()[1] == b':') || control(&bare) {
        return None;
    }
    (!bare.split('/').any(|s| s == "..")).then_some(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cases from src/lib/darkmown/links.test.ts.
    #[test]
    fn link_targets() {
        assert_eq!(darkmown_link_target("https://example.com/a?b=1#c").as_deref(), Some("https://example.com/a?b=1#c"));
        assert_eq!(darkmown_link_target("HTTPS://EXAMPLE.com").as_deref(), Some("https://example.com/"));
        assert_eq!(darkmown_link_target("mailto:ada@example.com?subject=Hi").as_deref(), Some("mailto:ada@example.com?subject=Hi"));
        assert_eq!(darkmown_link_target("mailto:?subject=x").as_deref(), Some("mailto:?subject=x"));
        assert_eq!(darkmown_link_target("mailto:"), None);
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://user:pw@example.com",
            "markie://open",
            "/relative",
            "https:example.com",
            "https://exa mple.com",
            "mailto:a@example.com?bcc=x%0aBcc:evil@x.com",
            "mailto:a@example.com?to=b@example.com",
            "mailto:a@example.com#frag",
            "https://ex\\ample.com",
        ] {
            assert_eq!(darkmown_link_target(bad), None, "{bad}");
        }
    }

    #[test]
    fn picture_refs() {
        assert_eq!(darkmown_picture_ref(" pics/a.png ").as_deref(), Some("pics/a.png"));
        assert_eq!(darkmown_picture_ref("a%20b.JPG?x").as_deref(), Some("a%20b.JPG?x"));
        for bad in ["../a.png", "/a.png", "https://x/a.png", "a.txt", "c:/a.png", "a/%2e%2e/b.png", "data:image/png;base64,x"] {
            assert_eq!(darkmown_picture_ref(bad), None, "{bad}");
        }
        assert_eq!(darkmown_picture_url("markie-asset://wd-0123456789abcdef0123456789abcdef", "a b.png"), "markie-asset://wd-0123456789abcdef0123456789abcdef/a%20b.png");
        assert!(is_darkmown_picture_base("markie-asset://wd-0123456789abcdef0123456789abcdef"));
        assert!(!is_darkmown_picture_base("markie-asset://wd-0123456789ABCDEF0123456789abcdef"));
    }
}
