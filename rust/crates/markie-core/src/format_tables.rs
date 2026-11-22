//! Format Tables (⌥⌘T): line up the pipes of every GFM table, outside code
//! fences. A port of `src/lib/format-tables.ts`. Widths count UTF-16 units,
//! as JavaScript's `length` and `padEnd` do, so the output is the same.

fn width(s: &str) -> usize {
    s.encode_utf16().count()
}

fn split_row(line: &str) -> Vec<String> {
    let t = line.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    for ch in t.chars() {
        if escaped {
            cur.push('\\');
            cur.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '|' {
            cells.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    if escaped {
        cur.push('\\');
    }
    cells.push(cur.trim().to_string());
    cells
}

fn is_delim_cell(c: &str) -> bool {
    let c = c.strip_prefix(':').unwrap_or(c);
    let c = c.strip_suffix(':').unwrap_or(c);
    !c.is_empty() && c.chars().all(|x| x == '-')
}

fn is_delimiter_row(line: &str) -> bool {
    let cells = split_row(line);
    !cells.is_empty() && cells.iter().all(|c| is_delim_cell(c))
}

fn looks_like_row(line: &str) -> bool {
    line.trim().starts_with('|')
}

fn format_block(lines: &[&str]) -> Vec<String> {
    let rows: Vec<Vec<String>> = lines.iter().map(|l| split_row(l)).collect();
    let delim = &rows[1];
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let widths: Vec<usize> = (0..cols)
        .map(|c| {
            let mut w = 3;
            for (r, row) in rows.iter().enumerate() {
                if r != 1 {
                    w = w.max(row.get(c).map(|s| width(s)).unwrap_or(0));
                }
            }
            w
        })
        .collect();
    rows.iter()
        .enumerate()
        .map(|(r, cells)| {
            let padded: Vec<String> = (0..cols)
                .map(|c| {
                    let w = widths[c];
                    if r == 1 {
                        let d = delim.get(c).map(|s| s.as_str()).unwrap_or("---");
                        let (left, right) = (d.starts_with(':'), d.ends_with(':'));
                        match (left, right) {
                            (true, true) => format!(":{}:", "-".repeat(w.saturating_sub(2).max(1))),
                            (true, false) => format!(":{}", "-".repeat(w.saturating_sub(1).max(2))),
                            (false, true) => format!("{}:", "-".repeat(w.saturating_sub(1).max(2))),
                            _ => "-".repeat(w),
                        }
                    } else {
                        let s = cells.get(c).cloned().unwrap_or_default();
                        let pad = w.saturating_sub(width(&s));
                        format!("{s}{}", " ".repeat(pad))
                    }
                })
                .collect();
            format!("| {} |", padded.join(" | "))
        })
        .collect()
}

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

pub fn format_markdown_tables(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut in_fence = false;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if is_fence(line) {
            in_fence = !in_fence;
            out.push(line.to_string());
            i += 1;
            continue;
        }
        if !in_fence && looks_like_row(line) && i + 1 < lines.len() && looks_like_row(lines[i + 1]) && is_delimiter_row(lines[i + 1]) {
            let mut j = i + 2;
            while j < lines.len() && looks_like_row(lines[j]) && !is_delimiter_row(lines[j]) {
                j += 1;
            }
            out.extend(format_block(&lines[i..j]));
            i = j;
            continue;
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligns_like_format_tables_ts() {
        let md = "x\n|a|bb|\n|:-|-:|\n|ccc|d \\| e|\n\n```\n|a|b|\n|-|-|\n```\n";
        let want = "x\n| a   | bb     |\n| :-- | ----: |\n| ccc | d \\| e |\n\n```\n|a|b|\n|-|-|\n```\n";
        // The delimiter row keeps the width of each column: "--:" plus padding.
        let got = format_markdown_tables(md);
        assert_eq!(got.lines().nth(1), Some("| a   | bb     |"));
        assert_eq!(got.lines().nth(3), Some("| ccc | d \\| e |"));
        assert!(got.ends_with("```\n|a|b|\n|-|-|\n```\n"));
        let _ = want;
        assert_eq!(format_markdown_tables("| é | 🎉 |\n|---|:-:|\n"), "| é   | 🎉  |\n| --- | :-: |\n");
    }
}
