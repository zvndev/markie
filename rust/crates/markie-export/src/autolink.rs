//! GFM autolink literals: `www.`, `http://`, `https://` and email addresses in
//! running text become links, as remark-gfm reads them (cmark-gfm's rules).
//! pulldown-cmark has no such extension, so the renderer runs this over each
//! text run outside links and code.

/// One link found in a text run: byte range and the href it gets.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub start: usize,
    pub end: usize,
    pub href: String,
}

/// Every autolink literal in `text`, in order and not overlapping.
/// `prev` is the character just before the run, if any (a boundary check).
pub fn find_all(text: &str, prev: Option<char>) -> Vec<Found> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let before = if i == 0 { prev } else { text[..i].chars().next_back() };
        if let Some(found) = at(text, i, before) {
            i = found.end;
            out.push(found);
            continue;
        }
        i += text[i..].chars().next().map(char::len_utf8).unwrap_or(1);
    }
    out
}

fn boundary(c: Option<char>) -> bool {
    match c {
        None => true,
        Some(c) => c.is_whitespace() || matches!(c, '*' | '_' | '~' | '('),
    }
}

fn at(text: &str, i: usize, before: Option<char>) -> Option<Found> {
    let rest = &text[i..];
    let lower: String = rest.chars().take(8).collect::<String>().to_ascii_lowercase();
    if boundary(before) {
        if lower.starts_with("www.") {
            let end = url_end(text, i, i);
            return (end > i + 4).then(|| Found { start: i, end, href: format!("http://{}", &text[i..end]) });
        }
        for scheme in ["https://", "http://"] {
            if lower.starts_with(scheme) {
                let host = i + scheme.len();
                let end = url_end(text, i, host);
                return (end > host).then(|| Found { start: i, end, href: text[i..end].to_string() });
            }
        }
    }
    // Email: the scan starts at the first character of the local part.
    if email_local(rest.chars().next()?) && !before.is_some_and(|c| email_local(c) || c == '@') {
        let local_end = rest.find(|c: char| !email_local(c)).unwrap_or(rest.len());
        if local_end == 0 || !rest[local_end..].starts_with('@') {
            return None;
        }
        let domain_start = i + local_end + 1;
        let domain = &text[domain_start..];
        let mut end = domain.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))).unwrap_or(domain.len());
        // A trailing dot is punctuation, not part of the address.
        while end > 0 && domain.as_bytes()[end - 1] == b'.' {
            end -= 1;
        }
        let host = &domain[..end];
        if host.is_empty() || !host.contains('.') {
            return None;
        }
        let last = host.as_bytes()[host.len() - 1];
        if last == b'-' || last == b'_' {
            return None;
        }
        let stop = domain_start + end;
        return Some(Found { start: i, end: stop, href: format!("mailto:{}", &text[i..stop]) });
    }
    None
}

fn email_local(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_')
}

/// The end of a www or http(s) autolink that starts at `start` and whose
/// domain starts at `host`, or `host` when the domain is invalid.
fn url_end(text: &str, start: usize, host: usize) -> usize {
    let domain_len = text[host..]
        .find(|c: char| !(c.is_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .unwrap_or(text.len() - host);
    let domain = &text[host..host + domain_len];
    if domain.is_empty() {
        return host;
    }
    // The last two labels may not hold an underscore.
    let labels: Vec<&str> = domain.trim_end_matches('.').split('.').collect();
    if labels.iter().rev().take(2).any(|l| l.contains('_')) || labels.iter().any(|l| l.is_empty()) && labels.len() > 1 {
        return host;
    }
    let mut end = host + domain_len;
    end += text[end..].find(|c: char| c.is_whitespace() || c == '<').unwrap_or(text.len() - end);
    let _ = start;
    trim_trailing(text, host, end)
}

fn trim_trailing(text: &str, from: usize, mut end: usize) -> usize {
    loop {
        let s = &text[from..end];
        let Some(last) = s.chars().next_back() else { return end };
        if matches!(last, '?' | '!' | '.' | ',' | ':' | '*' | '_' | '~' | '\'' | '"') {
            end -= last.len_utf8();
            continue;
        }
        if last == ')' {
            let open = s.matches('(').count();
            let close = s.matches(')').count();
            if close > open {
                end -= 1;
                continue;
            }
        }
        if last == ';' {
            // An entity-looking tail (`&amp;`) is not part of the address.
            if let Some(amp) = s.rfind('&') {
                let name = &s[amp + 1..s.len() - 1];
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()) {
                    end = from + amp;
                    continue;
                }
            }
        }
        return end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_gfm_forms() {
        let f = find_all("see www.example.com and https://a.b/c?d=1. Mail me@example.com.", None);
        let hrefs: Vec<_> = f.iter().map(|f| f.href.as_str()).collect();
        assert_eq!(hrefs, ["http://www.example.com", "https://a.b/c?d=1", "mailto:me@example.com"]);
    }

    #[test]
    fn balances_parentheses() {
        let f = find_all("(https://en.wikipedia.org/wiki/Foo_(bar))", None);
        assert_eq!(f[0].href, "https://en.wikipedia.org/wiki/Foo_(bar)");
    }

    #[test]
    fn needs_a_boundary() {
        assert!(find_all("xwww.example.com", None).is_empty());
        assert!(find_all("https://", None).is_empty());
    }
}
