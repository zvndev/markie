//! The `markie: { project, block }` declaration in leading front matter.
//! A port of `electron/frontmatter.js`: deliberately narrow, never an error.

use std::sync::LazyLock;

use regex::Regex;

/// Same boundary as `src/lib/front-matter.ts`.
pub static FRONT_MATTER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n((?s:.*?))\r?\n(?:---|\.\.\.)(?:\r?\n|$)").unwrap());

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MarkieMeta {
    pub project: Option<String>,
    pub block: Option<String>,
}

/// The whole front matter block, delimiters included, or "" when there is none.
pub fn split_front_matter(md: &str) -> (&str, &str) {
    match FRONT_MATTER_RE.find(md) {
        Some(m) => (&md[..m.end()], &md[m.end()..]),
        None => ("", md),
    }
}

fn unquote(raw: &str) -> Option<String> {
    let t = raw.trim();
    let v = if t.len() >= 2 && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\''))) {
        &t[1..t.len() - 1]
    } else {
        t
    };
    (!v.is_empty()).then(|| v.to_string())
}

fn set(out: &mut MarkieMeta, key: &str, value: Option<String>) {
    if key == "project" {
        out.project = value;
    } else {
        out.block = value;
    }
}

fn from_inline(rest: &str) -> MarkieMeta {
    static PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(project|block)\s*:\s*(.+?)\s*$").unwrap());
    let inner = rest.strip_prefix('{').unwrap_or(rest);
    let inner = inner.trim_end();
    let inner = inner.strip_suffix('}').unwrap_or(inner);
    let mut out = MarkieMeta::default();
    for part in inner.split(',') {
        if let Some(c) = PART.captures(part) {
            set(&mut out, &c[1], unquote(&c[2]));
        }
    }
    out
}

pub fn extract_markie_meta(text: &str) -> MarkieMeta {
    static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^markie\s*:\s*(.*)$").unwrap());
    static FIELD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(project|block)\s*:\s*(.*)$").unwrap());
    let Some(fm) = FRONT_MATTER_RE.captures(text) else { return MarkieMeta::default() };
    let mut in_markie = false;
    let mut out = MarkieMeta::default();
    for line in fm[1].split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if !in_markie {
            if indent != 0 {
                continue;
            }
            if let Some(m) = KEY.captures(trimmed) {
                let rest = m[1].trim();
                if rest.starts_with('{') {
                    return from_inline(rest);
                }
                in_markie = true;
            }
        } else {
            if indent == 0 {
                break;
            }
            if let Some(m) = FIELD.captures(trimmed) {
                set(&mut out, &m[1], unquote(&m[2]));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_block_and_inline_forms() {
        let block = "---\ntitle: x\nmarkie:\n  project: \"Markie\"\n  block: 'Launch'\nother: 1\n---\nbody";
        assert_eq!(
            extract_markie_meta(block),
            MarkieMeta { project: Some("Markie".into()), block: Some("Launch".into()) }
        );
        let inline = "---\r\nmarkie: { project: Alpha, block: Beta }\r\n---\r\n";
        assert_eq!(
            extract_markie_meta(inline),
            MarkieMeta { project: Some("Alpha".into()), block: Some("Beta".into()) }
        );
        assert_eq!(extract_markie_meta("no front matter"), MarkieMeta::default());
        let nested = "---\nmeta:\n  markie:\n    project: X\n---\n";
        assert_eq!(extract_markie_meta(nested), MarkieMeta::default());
        assert_eq!(extract_markie_meta("---\nmarkie:\n  project: \"\"\n---\n").project, None);
    }

    #[test]
    fn splits_front_matter() {
        assert_eq!(split_front_matter("---\na: 1\n...\nbody"), ("---\na: 1\n...\n", "body"));
        assert_eq!(split_front_matter("body").0, "");
    }
}
