//! electron/skill-frontmatter.js `parseFrontmatter`, ported line for line, for
//! the one field the Skills view shows: a SKILL.md's `description`.
//!
//! Its quirks are kept on purpose (a `>` block with no indented line swallows
//! the keys after it, an empty `key:` keeps an earlier value), because the
//! Skills view must describe a skill exactly as Electron does.
//! `tests/goldens/frontmatter.json` is Electron's own output for each case.
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

static FRONT_MATTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A---[ \t]*\r?\n((?s:.)*?)\r?\n---[ \t]*(?:\r?\n|\z)").expect("front matter")
});
// JavaScript's `.` stops at \n, \r, U+2028 and U+2029, and `$` is the end of
// the line here, so the rest of the key's line may hold none of them.
static KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:([^\n\r\u{2028}\u{2029}]*)\z").expect("key")
});
static BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A([|>])([+-]?)([0-9]*)([+-]?)[ \t]*\z").expect("block"));

enum Field {
    Text(String),
    Map,
}

/// JavaScript's `String.prototype.trim` whitespace, which adds U+FEFF.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn indent_of(line: &str) -> usize {
    line.encode_utf16().count() - line.trim_start_matches(js_space).encode_utf16().count()
}

/// `line.slice(n)` in UTF-16 units.
fn slice_from(line: &str, n: usize) -> String {
    let units: Vec<u16> = line.encode_utf16().collect();
    String::from_utf16_lossy(units.get(n..).unwrap_or_default())
}

fn scalar(raw: &str) -> Option<String> {
    let value = js_trim(raw);
    if value.is_empty() {
        return None;
    }
    if let Some(inner) = value.strip_prefix('"') {
        // /[^\\]"$/: the closing quote is not escaped.
        let mut tail = value.chars().rev();
        let closed = tail.next() == Some('"') && tail.next().is_some_and(|c| c != '\\');
        if value.chars().count() < 2 || !closed {
            return None;
        }
        let inner = &inner[..inner.len() - 1];
        return Some(
            inner
                .replace("\\n", "\n")
                .replace("\\t", "\t")
                .replace("\\\"", "\"")
                .replace("\\\\", "\\"),
        );
    }
    if value.starts_with('\'') {
        if value.chars().count() < 2 || !value.ends_with('\'') {
            return None;
        }
        return Some(value[1..value.len() - 1].replace("''", "'"));
    }
    if value.starts_with(['[', '{', '&', '*', '!', '#']) {
        return None;
    }
    // value.replace(/\s+#.*$/, ""): the leftmost run of spaces before a `#`.
    let mut cut = value.len();
    let mut chars = value.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if !js_space(c) {
            continue;
        }
        while chars.next_if(|(_, s)| js_space(*s)).is_some() {}
        if let Some(&(hash, '#')) = chars.peek()
            && !value[hash..].contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        {
            cut = at;
            break;
        }
    }
    let out = js_trim(&value[..cut]);
    (!out.is_empty()).then(|| out.to_owned())
}

fn block_scalar(lines: &[&str], start: usize, header: &regex::Captures) -> (String, usize) {
    let style = &header[1];
    let chomp = if header[2].is_empty() { &header[4] } else { &header[2] };
    let mut indent: usize = header[3].parse().unwrap_or(0);
    let mut i = start;
    let mut body: Vec<String> = Vec::new();
    while i < lines.len() {
        let line = lines[i];
        if js_trim(line).is_empty() {
            body.push(String::new());
            i += 1;
            continue;
        }
        if indent == 0 {
            indent = indent_of(line);
        }
        if indent_of(line) < indent {
            break;
        }
        body.push(slice_from(line, indent));
        i += 1;
    }
    while body.last().is_some_and(String::is_empty) {
        body.pop();
    }
    let mut value = if style == "|" {
        body.join("\n")
    } else {
        let mut acc = String::new();
        for (index, line) in body.iter().enumerate() {
            if index == 0 {
                acc = line.clone();
            } else if line.is_empty() || body[index - 1].is_empty() {
                acc = format!("{acc}\n{line}");
            } else {
                acc = format!("{acc} {line}");
            }
        }
        acc
    };
    if chomp != "-" && !value.is_empty() {
        value.push('\n');
    }
    (value, i)
}

fn nested_map(lines: &[&str], start: usize) -> (bool, usize) {
    let mut i = start;
    let mut found = false;
    while i < lines.len() {
        let line = lines[i];
        if js_trim(line).is_empty() {
            i += 1;
            continue;
        }
        if indent_of(line) == 0 {
            break;
        }
        if let Some(m) = KEY.captures(js_trim(line))
            && scalar(&m[2]).is_some()
        {
            found = true;
        }
        i += 1;
    }
    (found, i)
}

/// The description Electron's index records for a SKILL.md: the trimmed
/// `description` string from its front matter, or none.
pub fn description(markdown: &str) -> Option<String> {
    let found = FRONT_MATTER.captures(markdown)?;
    let block = found.get(1).map_or("", |m| m.as_str());
    let lines: Vec<&str> = block
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut fields: HashMap<String, Field> = HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if js_trim(line).is_empty()
            || line.trim_start_matches(js_space).starts_with('#')
            || indent_of(line) != 0
        {
            i += 1;
            continue;
        }
        let Some(entry) = KEY.captures(line) else {
            i += 1;
            continue;
        };
        let key = entry[1].to_owned();
        let rest = entry.get(2).map_or("", |m| m.as_str());
        if let Some(header) = BLOCK.captures(js_trim(rest)) {
            let (value, next) = block_scalar(&lines, i + 1, &header);
            fields.insert(key, Field::Text(value));
            i = next;
            continue;
        }
        if js_trim(rest).is_empty() {
            let (map, next) = nested_map(&lines, i + 1);
            if map {
                fields.insert(key, Field::Map);
            }
            i = next;
            continue;
        }
        if let Some(value) = scalar(rest) {
            fields.insert(key, Field::Text(value));
        }
        i += 1;
    }
    match fields.remove("description") {
        Some(Field::Text(value)) if !js_trim(&value).is_empty() => Some(js_trim(&value).to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_electrons_parse_frontmatter() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/goldens/frontmatter.json")).unwrap();
        let mut wrong = Vec::new();
        for case in &cases {
            let text = case["text"].as_str().unwrap();
            let want = case["description"].as_str();
            let got = super::description(text);
            if got.as_deref() != want {
                wrong.push(format!("{text:?}: electron {want:?}, rs {got:?}"));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }
}
