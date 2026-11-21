//! Linkify as markdown-it's linkify (linkify-it 5.0.2) does it, for the
//! forms real documents hold: scheme URLs, `www.` hosts, bare domains on
//! linkify-it's TLD list, and email addresses. International hosts are not
//! converted to punycode (TipTap writes `xn--` hrefs for those).

/// linkify-it's `tlds_default`.
const TLDS: &[&str] = &[
    "biz", "com", "edu", "gov", "net", "org", "pro", "web", "xxx", "aero", "asia", "coop", "info",
    "museum", "name", "shop", "рф",
];

/// linkify-it's `tlds_2ch_src_re`: the two-letter country codes, so that
/// `Next.js` or `types.ts` stay words.
const TLDS_2CH: &str = "a[cdefgilmnoqrstuwxz]|b[abdefghijmnorstvwyz]|c[acdfghiklmnoruvwxyz]|d[ejkmoz]|e[cegrstu]|f[ijkmor]|g[abdefghilmnpqrstuwy]|h[kmnrtu]|i[delmnoqrst]|j[emop]|k[eghimnprwyz]|l[abcikrstuvy]|m[acdeghklmnopqrstuvwxyz]|n[acefgilopruz]|om|p[aefghklmnrstwy]|qa|r[eosuw]|s[abcdeghijklmnortuvxyz]|t[cdfghjklmnortvwz]|u[agksyz]|v[aceginu]|w[fs]|y[et]|z[amw]";

fn tld_ok(tld: &str) -> bool {
    let t = tld.to_lowercase();
    if TLDS.contains(&t.as_str()) {
        return true;
    }
    let b = t.as_bytes();
    if b.len() != 2 {
        return false;
    }
    TLDS_2CH.split('|').any(|alt| match alt.find('[') {
        None => alt == t,
        Some(i) => alt.as_bytes()[0] == b[0] && alt[i + 1..alt.len() - 1].as_bytes().contains(&b[1]),
    })
}

/// Whitespace, or the soft-break sentinel the parser leaves in text.
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || c == crate::parse::SOFT_BREAK || c.is_control()
}

fn is_separator(c: char) -> bool {
    c == '<' || c == '>' || c == '｜' || c == crate::parse::TOKEN_BREAK
}

fn is_unicode_punct(c: char) -> bool {
    matches!(c, '–' | '—' | '‘' | '’' | '“' | '”' | '…' | '«' | '»' | '·' | '•' | '、' | '。' | '，')
}

/// linkify-it's pseudo-letter: not space, punctuation, control or separator.
fn is_letter(c: char) -> bool {
    !is_space(c) && !is_separator(c) && !c.is_ascii_punctuation() && !is_unicode_punct(c)
}

/// A host's labels from `i`: (end, start of the last label). Labels are
/// pseudo-letters with inner hyphens, joined by dots.
fn scan_host(s: &str, i: usize) -> Option<(usize, usize)> {
    let mut end = i;
    let mut last_label_start = i;
    let mut labels = 0;
    let mut pos = i;
    loop {
        let label_start = pos;
        let mut j = pos;
        for (k, c) in s[pos..].char_indices() {
            if is_letter(c) || (c == '-' && k > 0) {
                j = pos + k + c.len_utf8();
            } else {
                break;
            }
        }
        if j == label_start || s[label_start..j].ends_with('-') {
            break;
        }
        labels += 1;
        end = j;
        last_label_start = label_start;
        let rest = &s[j..];
        if rest.starts_with('.') && rest[1..].chars().next().is_some_and(is_letter) {
            pos = j + 1;
            continue;
        }
        break;
    }
    if labels == 0 {
        return None;
    }
    // linkify-it's host terminator: not followed by `-`, `_`, or `.-`.
    if matches!(s[end..].chars().next(), Some('-') | Some('_')) || s[end..].starts_with(".-") {
        return None;
    }
    Some((end, last_label_start))
}

/// The port and path after a host, by linkify-it's `src_port` and `src_path`.
fn scan_path(s: &str, mut i: usize) -> usize {
    if let Some(rest) = s[i..].strip_prefix(':') {
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if (1..=5).contains(&digits) {
            i += 1 + digits;
        }
    }
    match s[i..].chars().next() {
        Some('/' | '?' | '#') => {}
        _ => return i,
    }
    let chars: Vec<(usize, char)> = s[i..].char_indices().map(|(k, c)| (i + k, c)).collect();
    let stop = |c: char| is_space(c) || is_separator(c);
    let mut end = i + 1;
    let mut k = 1;
    while k < chars.len() {
        let (at, c) = chars[k];
        let next = chars.get(k + 1).map(|x| x.1);
        if stop(c) {
            break;
        }
        let close = match c {
            '(' => Some(')'),
            '[' => Some(']'),
            '{' => Some('}'),
            '"' => Some('"'),
            '\'' => Some('\''),
            _ => None,
        };
        if let Some(close) = close {
            // A bracket or quote counts only with its pair, in the same run.
            let found = chars[k + 1..].iter().take_while(|x| !stop(x.1)).position(|x| x.1 == close);
            match found {
                Some(n) if !matches!(c, '"' | '\'') || n > 0 => {
                    let (cat, cc) = chars[k + 1 + n];
                    end = cat + cc.len_utf8();
                    k += n + 2;
                    continue;
                }
                // `I'm_king`: an apostrophe before a letter.
                _ if c == '\'' && next.is_some_and(|n| is_letter(n) || n == '-') => {
                    end = at + 1;
                    k += 1;
                    continue;
                }
                _ => break,
            }
        }
        if matches!(c, ')' | ']' | '}') {
            break;
        }
        if matches!(c, '.' | ',' | ';' | '!' | '?') {
            // Allowed inside a path, never at its end.
            match next {
                Some(n) if !stop(n) && (c == ',' || c == '!' || n != c) => {}
                _ => break,
            }
        }
        if c == '-' && s[at..].starts_with("---") {
            break; // a long dash ends the link
        }
        end = at + c.len_utf8();
        k += 1;
    }
    end
}

/// linkify-it's `link_fuzzy` and `schema_search` prefix: the start, or a
/// space, separator or punctuation other than `. : / - _ @`.
fn boundary_before(s: &str, i: usize) -> bool {
    match s[..i].chars().last() {
        None => true,
        Some('.' | ':' | '/' | '-' | '_' | '@') => false,
        Some(c) => is_space(c) || is_separator(c) || c.is_ascii_punctuation() || is_unicode_punct(c),
    }
}

/// `schema_test`'s prefix: anything a fuzzy link allows, and also `.:/-@`;
/// only `_` and letters glue a scheme to the word before it.
fn scheme_boundary_before(s: &str, i: usize) -> bool {
    match s[..i].chars().last() {
        None => true,
        Some('_') => false,
        Some(c) => is_space(c) || is_separator(c) || c.is_ascii_punctuation() || is_unicode_punct(c),
    }
}

/// `tpl_email_fuzzy`'s prefix: the start, a space, `<`, `>`, `｜`, `"` or `(`.
fn email_boundary_before(s: &str, i: usize) -> bool {
    match s[..i].chars().last() {
        None => true,
        Some(c) => is_space(c) || is_separator(c) || c == '"' || c == '(',
    }
}

fn email_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-;:&=+$,._".contains(c)
}

/// Find the first link in `s`: (start, end, href).
pub fn find(s: &str) -> Option<(usize, usize, String)> {
    let lower = s.to_ascii_lowercase();
    for (i, c) in s.char_indices() {
        if is_space(c) {
            continue;
        }
        let email_ok = c.is_alphanumeric() && email_boundary_before(s, i);
        let scheme_ok = scheme_boundary_before(s, i);
        if !boundary_before(s, i) && !email_ok && !scheme_ok {
            continue;
        }
        for scheme in ["https://", "http://", "ftp://", "mailto:"] {
            if !scheme_ok || !lower[i..].starts_with(scheme) {
                continue;
            }
            let h = i + scheme.len();
            if scheme == "mailto:" {
                if let Some(at) = s[h..].find('@') {
                    if s[h..h + at].chars().all(email_name_char) {
                        if let Some((end, label)) = scan_host(s, h + at + 1) {
                            if tld_ok(&s[label..end]) {
                                return Some((i, end, s[i..end].to_string()));
                            }
                        }
                    }
                }
                continue;
            }
            if let Some((hend, _)) = scan_host(s, h) {
                let end = scan_path(s, hend);
                return Some((i, end, crate::parse::normalize_href(&s[i..end])));
            }
        }
        if !c.is_alphanumeric() {
            continue;
        }
        // An email whose name starts here.
        let word_end = s[i..].find(is_space).map(|k| i + k).unwrap_or(s.len());
        if let Some(at_rel) = s[i..word_end].find('@') {
            let at = i + at_rel;
            if at > i && s[i..at].chars().all(email_name_char) && email_boundary_before(s, i) {
                if let Some((end, label)) = scan_host(s, at + 1) {
                    if s[at + 1..end].contains('.') && tld_ok(&s[label..end]) {
                        return Some((i, end, format!("mailto:{}", &s[i..end])));
                    }
                }
            }
        }
        if !boundary_before(s, i) {
            continue;
        }
        // www. or a bare domain.
        if let Some((hend, label)) = scan_host(s, i) {
            if s[i..hend].contains('.') && tld_ok(&s[label..hend]) && !s[hend..].starts_with('@') {
                let end = scan_path(s, hend);
                return Some((i, end, crate::parse::normalize_href(&format!("http://{}", &s[i..end]))));
            }
        }
    }
    None
}
