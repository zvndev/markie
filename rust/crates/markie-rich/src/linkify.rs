//! A small linkify, matching what markdown-it's linkify (linkify-it) does
//! with the addresses real documents hold. It is not the whole of
//! linkify-it: international hosts are not converted to punycode.

/// linkify-it's default TLDs, plus every two-letter country code.
const TLDS: &[&str] = &[
    "biz", "com", "edu", "gov", "net", "org", "pro", "web", "xxx", "aero", "asia", "coop", "info",
    "museum", "name", "shop",
];

fn tld_ok(tld: &str) -> bool {
    (tld.len() == 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
        || TLDS.iter().any(|t| t.eq_ignore_ascii_case(tld))
}

fn host_ok(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    if !labels
        .iter()
        .all(|l| !l.is_empty() && l.chars().all(|c| c.is_alphanumeric() || c == '-') && !l.starts_with('-'))
    {
        return false;
    }
    tld_ok(labels.last().unwrap())
}

/// Find the first link in `s`: (start, end, href).
pub fn find(s: &str) -> Option<(usize, usize, String)> {
    let mut word_start = None;
    for (i, ch) in s.char_indices().chain(std::iter::once((s.len(), ' '))) {
        if ch.is_whitespace() {
            if let Some(ws) = word_start.take() {
                if let Some((a, b, href)) = in_word(&s[ws..i]) {
                    return Some((ws + a, ws + b, href));
                }
            }
        } else if word_start.is_none() {
            word_start = Some(i);
        }
    }
    None
}

fn in_word(w: &str) -> Option<(usize, usize, String)> {
    // Leading punctuation is not part of a link.
    let lead = w.find(|c: char| c.is_alphanumeric()).unwrap_or(w.len());
    for scheme in ["https://", "http://", "ftp://", "mailto:"] {
        if let Some(pos) = find_ci(w, scheme) {
            if pos > 0 && w[..pos].chars().last().is_some_and(|c| c.is_alphanumeric()) {
                continue;
            }
            let end = trim_tail(w, pos + scheme.len());
            if end > pos + scheme.len() {
                let text = &w[pos..end];
                return Some((pos, end, crate::parse::normalize_href(text)));
            }
        }
    }
    let body = &w[lead..];
    if body.is_empty() {
        return None;
    }
    // Email.
    if let Some(at) = body.find('@') {
        let local = &body[..at];
        let end = trim_tail(body, at + 1);
        let domain = &body[at + 1..end];
        if !local.is_empty()
            && local.chars().all(|c| c.is_alphanumeric() || "._%+-".contains(c))
            && host_ok(domain)
        {
            return Some((lead, lead + end, format!("mailto:{}", &body[..end])));
        }
        return None;
    }
    // www. or a bare domain.
    let end = trim_tail(body, 0);
    let text = &body[..end];
    let host_end = text.find(['/', ':', '?', '#']).unwrap_or(text.len());
    let host = &text[..host_end];
    let www = host.len() > 4 && host.get(..4).is_some_and(|h| h.eq_ignore_ascii_case("www."));
    if www || host_ok(host) {
        if !host_ok(host) && !www {
            return None;
        }
        return Some((lead, lead + end, crate::parse::normalize_href(&format!("http://{text}"))));
    }
    None
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.to_ascii_lowercase();
    h.find(needle)
}

/// End of a link that starts before `from`: drop trailing punctuation and
/// a closing bracket that has no opener inside the link.
fn trim_tail(w: &str, from: usize) -> usize {
    let mut end = w.len();
    loop {
        let Some(last) = w[..end].chars().last() else { return end };
        if end <= from {
            return end;
        }
        if ".,;:!?'\"*_~".contains(last) {
            end -= last.len_utf8();
            continue;
        }
        if last == ')' || last == ']' || last == '>' {
            let (open, close) = match last {
                ')' => ('(', ')'),
                ']' => ('[', ']'),
                _ => ('<', '>'),
            };
            let s = &w[..end];
            let opens = s.matches(open).count();
            let closes = s.matches(close).count();
            if closes > opens {
                end -= 1;
                continue;
            }
        }
        return end;
    }
}
