//! Lossless dotenv parsing for the vault's key editor: `src/lib/vault/dotenv.ts`.
//!
//! Every logical line keeps its exact source text and line ending, so a file
//! parsed and serialized without edits comes back byte-identical. An edit
//! rebuilds only the line it touches. Lines that are not `KEY=value` are kept
//! verbatim as malformed lines.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Newline {
    Lf,
    CrLf,
    Cr,
}

impl Newline {
    pub fn as_str(self) -> &'static str {
        match self {
            Newline::Lf => "\n",
            Newline::CrLf => "\r\n",
            Newline::Cr => "\r",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quote {
    None,
    Double,
    Single,
    Backtick,
}

impl Quote {
    fn of_char(c: char) -> Option<Quote> {
        match c {
            '"' => Some(Quote::Double),
            '\'' => Some(Quote::Single),
            '`' => Some(Quote::Backtick),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    pub value: String,
    pub exported: bool,
    pub quote: Quote,
    /// raw == lead + key + separator + value_source + trail
    pub lead: String,
    pub separator: String,
    pub value_source: String,
    pub trail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineKind {
    Blank,
    Comment { text: String },
    Malformed { reason: &'static str },
    Entry(Entry),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    /// Stable identity for UI rows. Not part of the file.
    pub id: usize,
    /// Exact source text without its terminator. Multi-line quoted values keep their inner breaks.
    pub raw: String,
    /// None only for a last line without a terminator.
    pub eol: Option<Newline>,
    pub kind: LineKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DotenvDocument {
    pub lines: Vec<Line>,
    /// Terminator for lines added by edits: the file's first line ending, or LF.
    pub newline: Newline,
    pub next_id: usize,
}

/// Upper bound on how far an open quote may reach.
const MAX_QUOTED_LINES: usize = 1000;

pub fn is_valid_dotenv_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// `.env`, `prod.env`, `Untitled.env`, `.env.local`, `.env.production.local`.
pub fn is_env_file_name(name: &str) -> bool {
    let normalized = name.replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or("").to_lowercase();
    basename == ".env" || basename.ends_with(".env") || (basename.starts_with(".env.") && js_len(&basename) > 5)
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn unescape_double_quoted(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some(e @ ('"' | '\\')) => out.push(e),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn escape_double_quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\\' | '"' => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

/// Byte index of the closing quote in `value` (which starts with the opening one).
fn closing_quote(value: &str, quote: char) -> Option<usize> {
    let mut iter = value.char_indices().skip(1);
    while let Some((i, c)) = iter.next() {
        if quote == '"' && c == '\\' {
            iter.next();
            continue;
        }
        if c == quote {
            return Some(i);
        }
    }
    None
}

fn leading_blanks(s: &str) -> usize {
    s.len() - s.trim_start_matches([' ', '\t']).len()
}

/// `/^[ \t]*(?:#.*)?$/`, where `.` stops at JavaScript line terminators.
fn trail_ok(trail: &str) -> bool {
    let rest = &trail[leading_blanks(trail)..];
    rest.is_empty() || (rest.starts_with('#') && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
}

enum Logical {
    Line(LineKind),
    Unclosed(char),
}

fn parse_logical(source: &str) -> Logical {
    let indent = &source[..leading_blanks(source)];
    let rest = &source[indent.len()..];
    if rest.is_empty() {
        return Logical::Line(LineKind::Blank);
    }
    if rest.starts_with('#') {
        return Logical::Line(LineKind::Comment { text: rest.to_string() });
    }
    let export_prefix = match rest.strip_prefix("export") {
        Some(after) if leading_blanks(after) > 0 => &rest[..6 + leading_blanks(after)],
        _ => "",
    };
    let lead = format!("{indent}{export_prefix}");
    let after_lead = &source[lead.len()..];
    let Some(equals) = after_lead.find('=') else {
        return Logical::Line(LineKind::Malformed { reason: "This line has no = sign." });
    };
    let key_source = &after_lead[..equals];
    let key = key_source.trim_end_matches([' ', '\t']);
    if !is_valid_dotenv_key(key) {
        return Logical::Line(LineKind::Malformed { reason: "This line's key is not a valid name." });
    }
    let after_equals = &after_lead[equals + 1..];
    let gap = &after_equals[..leading_blanks(after_equals)];
    let separator = format!("{}={gap}", &key_source[key.len()..]);
    let value_text = &after_equals[gap.len()..];
    let exported = !export_prefix.is_empty();
    if let Some(first) = value_text.chars().next().filter(|c| Quote::of_char(*c).is_some()) {
        let Some(close) = closing_quote(value_text, first) else {
            return Logical::Unclosed(first);
        };
        let value_source = &value_text[..close + 1];
        let trail = &value_text[close + 1..];
        if !trail_ok(trail) {
            return Logical::Line(LineKind::Malformed { reason: "This line has text after its closing quote." });
        }
        let inner = &value_source[1..value_source.len() - 1];
        return Logical::Line(LineKind::Entry(Entry {
            key: key.to_string(),
            value: if first == '"' { unescape_double_quoted(inner) } else { inner.to_string() },
            exported,
            quote: Quote::of_char(first).unwrap(),
            lead,
            separator,
            value_source: value_source.to_string(),
            trail: trail.to_string(),
        }));
    }
    // An unquoted `#` starts a comment only after whitespace, so URL fragments survive.
    let comment = if !gap.is_empty() && value_text.starts_with('#') {
        Some(0)
    } else {
        value_text.find(" #").into_iter().chain(value_text.find("\t#")).min()
    };
    let before_comment = comment.map_or(value_text, |c| &value_text[..c]);
    let value = before_comment.trim_end_matches([' ', '\t']);
    Logical::Line(LineKind::Entry(Entry {
        key: key.to_string(),
        value: value.to_string(),
        exported,
        quote: Quote::None,
        lead,
        separator,
        value_source: value.to_string(),
        trail: value_text[value.len()..].to_string(),
    }))
}

fn physical_lines(text: &str) -> Vec<(&str, Option<Newline>)> {
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        let eol = match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => Some((Newline::CrLf, 2)),
            b'\r' => Some((Newline::Cr, 1)),
            b'\n' => Some((Newline::Lf, 1)),
            _ => None,
        };
        if let Some((nl, len)) = eol {
            lines.push((&text[start..i], Some(nl)));
            i += len;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < text.len() {
        lines.push((&text[start..], None));
    }
    lines
}

pub fn parse_dotenv(text: &str) -> DotenvDocument {
    let physical = physical_lines(text);
    let mut lines: Vec<Line> = Vec::new();
    let mut index = 0;
    while index < physical.len() {
        let id = lines.len();
        let (line_text, eol) = physical[index];
        let quote = match parse_logical(line_text) {
            Logical::Line(kind) => {
                lines.push(Line { id, raw: line_text.to_string(), eol, kind });
                index += 1;
                continue;
            }
            Logical::Unclosed(q) => q,
        };
        let mut joined = line_text.to_string();
        let mut closed = None;
        let mut next = index + 1;
        while next < physical.len() && next - index <= MAX_QUOTED_LINES {
            joined.push_str(physical[next - 1].1.map_or("", Newline::as_str));
            joined.push_str(physical[next].0);
            if physical[next].0.contains(quote)
                && let Logical::Line(kind) = parse_logical(&joined)
            {
                closed = Some((next, kind));
                break;
            }
            next += 1;
        }
        match closed {
            Some((end, kind @ LineKind::Entry(_))) => {
                lines.push(Line { id, raw: joined, eol: physical[end].1, kind });
                index = end + 1;
            }
            _ => {
                lines.push(Line {
                    id,
                    raw: line_text.to_string(),
                    eol,
                    kind: LineKind::Malformed { reason: "This line's quoted value is never closed." },
                });
                index += 1;
            }
        }
    }
    let newline = physical.iter().find_map(|(_, eol)| *eol).unwrap_or(Newline::Lf);
    let next_id = lines.len();
    DotenvDocument { lines, newline, next_id }
}

pub fn serialize_dotenv(document: &DotenvDocument) -> String {
    let mut text = String::new();
    for line in &document.lines {
        text.push_str(&line.raw);
        text.push_str(line.eol.map_or("", Newline::as_str));
    }
    text
}

fn needs_quoting(value: &str) -> bool {
    value.chars().any(|c| js_space(c) || matches!(c, '#' | '"' | '\'' | '`' | '\\'))
}

/// Source text for a value, keeping the previous quote style when it can hold the value.
pub fn format_dotenv_value(value: &str, previous: Quote) -> String {
    let has = |set: &[char]| value.contains(set);
    match previous {
        Quote::Single if !has(&['\'', '\r', '\n']) => format!("'{value}'"),
        Quote::Backtick if !has(&['`', '\r', '\n']) => format!("`{value}`"),
        Quote::None if !needs_quoting(value) => value.to_string(),
        _ => format!("\"{}\"", escape_double_quoted(value)),
    }
}

fn quote_of(value_source: &str) -> Quote {
    value_source.chars().next().and_then(Quote::of_char).unwrap_or(Quote::None)
}

fn rebuild_entry(line: &Line, entry: &Entry, key: Option<&str>, value: Option<&str>) -> Line {
    let key = key.unwrap_or(&entry.key).to_string();
    let value_source = match value {
        None => entry.value_source.clone(),
        Some(v) => format_dotenv_value(v, entry.quote),
    };
    let quote = quote_of(&value_source);
    // A bare value written directly before a `# comment` would swallow it, so keep them apart.
    let trail = if quote == Quote::None && !value_source.is_empty() && entry.trail.starts_with('#') {
        format!(" {}", entry.trail)
    } else {
        entry.trail.clone()
    };
    let raw = format!("{}{}{}{}{}", entry.lead, key, entry.separator, value_source, trail);
    let updated = Entry { key, value: value.unwrap_or(&entry.value).to_string(), quote, value_source, trail, ..entry.clone() };
    Line { id: line.id, raw, eol: line.eol, kind: LineKind::Entry(updated) }
}

pub fn update_dotenv_entry(document: &DotenvDocument, id: usize, key: Option<&str>, value: Option<&str>) -> DotenvDocument {
    let lines = document
        .lines
        .iter()
        .map(|line| match &line.kind {
            LineKind::Entry(entry) if line.id == id => rebuild_entry(line, entry, key, value),
            _ => line.clone(),
        })
        .collect();
    DotenvDocument { lines, ..document.clone() }
}

pub fn add_dotenv_entry(document: &DotenvDocument, key: &str, value: &str) -> DotenvDocument {
    let mut lines = document.lines.clone();
    // Keep whether the file ends with a line break.
    let mut eol = Some(document.newline);
    if let Some(last) = lines.last_mut()
        && last.eol.is_none()
    {
        last.eol = Some(document.newline);
        eol = None;
    }
    let value_source = format_dotenv_value(value, Quote::None);
    lines.push(Line {
        id: document.next_id,
        raw: format!("{key}={value_source}"),
        eol,
        kind: LineKind::Entry(Entry {
            key: key.to_string(),
            value: value.to_string(),
            exported: false,
            quote: quote_of(&value_source),
            lead: String::new(),
            separator: "=".into(),
            value_source,
            trail: String::new(),
        }),
    });
    DotenvDocument { lines, newline: document.newline, next_id: document.next_id + 1 }
}

pub fn remove_dotenv_line(document: &DotenvDocument, id: usize) -> DotenvDocument {
    let Some(index) = document.lines.iter().position(|l| l.id == id) else {
        return document.clone();
    };
    let mut lines: Vec<Line> = document.lines.iter().filter(|l| l.id != id).cloned().collect();
    if index == lines.len() && document.lines[index].eol.is_none()
        && let Some(last) = lines.last_mut()
    {
        last.eol = None;
    }
    DotenvDocument { lines, ..document.clone() }
}

/// Keys assigned by more than one line. With most loaders the last one wins.
pub fn duplicate_dotenv_keys(document: &DotenvDocument) -> std::collections::BTreeSet<String> {
    let mut seen = std::collections::HashSet::new();
    let mut duplicates = std::collections::BTreeSet::new();
    for line in &document.lines {
        if let LineKind::Entry(e) = &line.kind
            && !e.key.is_empty()
            && !seen.insert(e.key.clone())
        {
            duplicates.insert(e.key.clone());
        }
    }
    duplicates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(doc: &DotenvDocument) -> Vec<(String, String)> {
        doc.lines
            .iter()
            .filter_map(|l| match &l.kind {
                LineKind::Entry(e) => Some((e.key.clone(), e.value.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn round_trips_byte_for_byte() {
        let text = "# c\r\n\nexport A=1 # note\r\nB = \"x\\ny\" \nC='a#b'\rD=http://x/#frag\nE=\"multi\nline\"\nbad line\nF=\"open";
        let doc = parse_dotenv(text);
        assert_eq!(serialize_dotenv(&doc), text);
        assert_eq!(doc.newline, Newline::CrLf);
        assert_eq!(
            entries(&doc),
            vec![
                ("A".into(), "1".into()),
                ("B".into(), "x\ny".into()),
                ("C".into(), "a#b".into()),
                ("D".into(), "http://x/#frag".into()),
                ("E".into(), "multi\nline".into()),
            ]
        );
        assert!(matches!(doc.lines.last().unwrap().kind, LineKind::Malformed { .. }));
    }

    #[test]
    fn edits_touch_only_their_line() {
        let doc = parse_dotenv("A=1 #c\nB='q'");
        let doc = update_dotenv_entry(&doc, 0, None, Some("two words"));
        let doc = update_dotenv_entry(&doc, 1, None, Some("it's"));
        assert_eq!(serialize_dotenv(&doc), "A=\"two words\" #c\nB=\"it's\"");
        let doc = add_dotenv_entry(&doc, "C", "x");
        assert_eq!(serialize_dotenv(&doc), "A=\"two words\" #c\nB=\"it's\"\nC=x");
        let doc = remove_dotenv_line(&doc, 2);
        assert_eq!(serialize_dotenv(&doc), "A=\"two words\" #c\nB=\"it's\"");
        let glued = update_dotenv_entry(&parse_dotenv("A=\"x\"#c"), 0, None, Some("y"));
        assert_eq!(serialize_dotenv(&glued), "A=\"y\"#c");
    }

    #[test]
    fn names_and_duplicates() {
        assert!(is_env_file_name("/a/b/.env"));
        assert!(is_env_file_name("C:\\x\\Prod.ENV"));
        assert!(is_env_file_name(".env.local"));
        assert!(!is_env_file_name("env.txt"));
        let doc = parse_dotenv("A=1\nB=2\nA=3\n");
        assert_eq!(duplicate_dotenv_keys(&doc).into_iter().collect::<Vec<_>>(), vec!["A".to_string()]);
    }
}
