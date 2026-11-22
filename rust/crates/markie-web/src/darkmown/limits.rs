//! `validateDarkmownPreviewSource` (`mcp/darkmown-limits.mjs`): cheap checks
//! before a compiler is started at all.

use crate::json::js_len;

pub const DARKMOWN_SOURCE_LIMIT: usize = 128_000;
pub const DARKMOWN_OUTPUT_LIMIT: usize = 1_000_000;
const LOOP_WORK_BUDGET: f64 = 20_000_000.0;
const PIPE_ARGUMENT_LIMIT: usize = 200;
const TOO_BIG: &str = "Interactive preview supports up to 128,000 characters and 5,000 lines. Your source remains available to edit and save.";

fn quoted_strings(s: &str) -> Vec<&str> {
    // /"[^"]*"/g
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(a) = rest.find('"') {
        match rest[a + 1..].find('"') {
            Some(b) => {
                out.push(&rest[a..a + 1 + b + 1]);
                rest = &rest[a + 1 + b + 1..];
            }
            None => break,
        }
    }
    out
}

/// preview.ts `compileDarkmownPreview`'s first check, ahead of the worker's
/// own limits: a source past 200,000 UTF-16 units is refused in these words.
pub fn check_preview_size(source: &str) -> Result<(), String> {
    if js_len(source) > 200_000 {
        Err("Darkmown preview is limited to 200,000 characters".into())
    } else {
        Ok(())
    }
}

pub fn validate_preview_source(source: &str) -> Result<(), String> {
    let length = js_len(source);
    if length > DARKMOWN_SOURCE_LIMIT {
        return Err(TOO_BIG.into());
    }
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    if lines.len() > 5_000 {
        return Err(TOO_BIG.into());
    }
    let computed_lines = lines.iter().filter(|l| l.strip_prefix(":computed").is_some_and(|r| r.is_empty() || r.starts_with(char::is_whitespace))).count();
    let expansions = normalized.matches('{').count() + computed_lines;
    if length * expansions.max(1) > 1_000_000 {
        return Err("This source exceeds the interactive preview complexity budget. Your source remains available to edit and save.".into());
    }
    let mut body: &str = &normalized;
    if normalized.starts_with("---\n")
        && let Some(end) = normalized[3..].find("\n---").map(|e| e + 3)
    {
        let skip = end + 4 + usize::from(normalized.as_bytes().get(end + 4) == Some(&b'\n'));
        body = normalized.get(skip..).unwrap_or("");
    }
    let mut fence: Option<String> = None;
    let mut loops = 0usize;
    let mut deepest = 0usize;
    let mut growth: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for line in body.split('\n') {
        let marker = {
            let c = line.chars().next();
            match c {
                Some(ch @ ('`' | '~')) => {
                    let n = line.chars().take_while(|x| *x == ch).count();
                    (n >= 3).then(|| line[..n].to_string())
                }
                _ => None,
            }
        };
        if let Some(f) = &fence {
            if let Some(m) = &marker
                && m.chars().next() == f.chars().next()
                && m.len() >= f.len()
            {
                fence = None;
            }
            continue;
        }
        if marker.is_some() {
            fence = marker;
            continue;
        }
        let word = |w: &str| line.strip_prefix(w).is_some_and(|r| r.is_empty() || r.starts_with(char::is_whitespace));
        if word("@include") {
            return Err("Included files are not available in this interactive preview yet. Your source remains available to edit and save.".into());
        }
        if word("@loop") {
            loops += 1;
            deepest = deepest.max(loops);
        } else if word("@endloop") {
            loops = loops.saturating_sub(1);
        }
        // /^:computed\s+([\w$]+)\s*=(.*)$/
        if let Some(rest) = line.strip_prefix(":computed")
            && rest.starts_with(char::is_whitespace)
        {
            let rest = rest.trim_start();
            let name_len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).unwrap_or(rest.len());
            let name = &rest[..name_len];
            let after = rest[name_len..].trim_start();
            if !name.is_empty()
                && let Some(expr) = after.strip_prefix('=')
            {
                let mut stripped = expr.to_string();
                for q in quoted_strings(expr) {
                    stripped = stripped.replacen(q, "", 1);
                }
                let mut reads = Vec::new();
                let b = stripped.as_bytes();
                let mut i = 0;
                while i < b.len() {
                    let c = b[i] as char;
                    if c.is_ascii_alphabetic() || c == '_' || c == '$' {
                        let start = i;
                        while i < b.len() && ((b[i] as char).is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                            i += 1;
                        }
                        reads.push(*growth.get(&stripped[start..i]).unwrap_or(&1));
                    } else if c.is_ascii_digit() {
                        while i < b.len() && ((b[i] as char).is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                            i += 1;
                        }
                    } else {
                        i += 1;
                    }
                }
                let total = if expr.contains('+') { reads.iter().sum() } else { reads.iter().copied().max().unwrap_or(1).max(1) };
                if total > 64 {
                    return Err("This chain of text concatenation could grow too large for an interactive preview. Your source remains available to edit and save.".into());
                }
                growth.insert(name.to_string(), total);
            }
        }
        // /\{[^{}]*\|([^{}]*)\}/g
        let mut rest = line;
        while let Some(open) = rest.find('{') {
            let tail = &rest[open + 1..];
            let Some(close) = tail.find(['{', '}']) else { break };
            if tail.as_bytes()[close] == b'{' {
                rest = &tail[close..];
                continue;
            }
            let inner = &tail[..close];
            if let Some(bar) = inner.find('|')
                && quoted_strings(&inner[bar + 1..]).iter().any(|q| js_len(q) > PIPE_ARGUMENT_LIMIT)
            {
                return Err("Format pipelines in an interactive preview take arguments up to 200 characters. Your source remains available to edit and save.".into());
            }
            rest = &tail[close + 1..];
        }
    }
    let rows = lines.iter().map(|l| l.matches(',').count() + 1).max().unwrap_or(1) as f64;
    if length as f64 * rows.powi(deepest as i32) > LOOP_WORK_BUDGET {
        return Err("These loops could draw too many rows for an interactive preview. Your source remains available to edit and save.".into());
    }
    Ok(())
}

#[cfg(test)]
mod size_tests {
    #[test]
    fn past_200000_characters_the_preview_says_so_first() {
        let long = "a".repeat(200_001);
        assert_eq!(super::check_preview_size(&long).unwrap_err(), "Darkmown preview is limited to 200,000 characters");
        // 150,000 passes this check and meets the worker's 128,000 limit.
        let mid = "a".repeat(150_000);
        assert!(super::check_preview_size(&mid).is_ok());
        assert!(super::validate_preview_source(&mid).unwrap_err().starts_with("Interactive preview supports up to 128,000"));
        // UTF-16 units, as JavaScript's length counts them.
        assert!(super::check_preview_size(&"😀".repeat(100_001)).is_err());
    }
}
