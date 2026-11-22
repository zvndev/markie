//! CSV documents as Electron edits them (`src/lib/csv.ts`, page.tsx
//! `fromDisk` and `toDisk`): the file stays CSV on disk, the editors hold
//! its first table as a GFM pipe table, so View edits the cells in the rich
//! editor and Source shows the table's Markdown. Saving writes the first
//! table back as CSV, and a manual save says when anything else was left out.

use markie_core::csv::{parse, serialize};
use markie_core::formats::FormatKind;

fn cell_to_markdown(cell: &str) -> String {
    cell.replace('|', "\\|").replace("\r\n", " ").replace('\n', " ")
}

fn markdown_to_cell(cell: &str) -> String {
    cell.replace("\\|", "|")
}

/// `csvToMarkdownTable`.
pub(super) fn csv_to_markdown_table(csv: &str) -> String {
    let rows: Vec<Vec<String>> = parse(csv).into_iter().filter(|r| !(r.len() == 1 && r[0].is_empty())).collect();
    if rows.is_empty() {
        return String::new();
    }
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let norm = |r: &Vec<String>| {
        let mut cells: Vec<String> = r.iter().map(|c| cell_to_markdown(c)).collect();
        cells.resize(cols, String::new());
        format!("| {} |", cells.join(" | "))
    };
    let mut lines = vec![norm(&rows[0]), format!("| {} |", vec!["---"; cols].join(" | "))];
    lines.extend(rows[1..].iter().map(norm));
    lines.join("\n") + "\n"
}

fn is_delimiter(cell: &str) -> bool {
    let c = cell.strip_prefix(':').unwrap_or(cell);
    let c = c.strip_suffix(':').unwrap_or(c);
    !c.is_empty() && c.chars().all(|ch| ch == '-')
}

/// `markdownTableToCSV`: the first pipe table only.
pub(super) fn markdown_table_to_csv(markdown: &str) -> String {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut in_table = false;
    for line in markdown.split('\n') {
        let is_row = line.trim().starts_with('|');
        if !in_table && is_row {
            in_table = true;
        }
        if !in_table {
            continue;
        }
        if !is_row {
            break;
        }
        let t = line.trim();
        let t = t.strip_prefix('|').unwrap_or(t);
        let t = t.strip_suffix('|').unwrap_or(t);
        let mut cells = Vec::new();
        let mut current = String::new();
        let mut escaped = false;
        for ch in t.chars() {
            if escaped {
                current.push('\\');
                current.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '|' {
                cells.push(current.trim().to_string());
                current.clear();
            } else {
                current.push(ch);
            }
        }
        cells.push(current.trim().to_string());
        if cells.iter().all(|c| is_delimiter(c)) {
            continue;
        }
        rows.push(cells.iter().map(|c| markdown_to_cell(c)).collect());
    }
    serialize(&rows)
}

/// `csvDropsContent`: lines a CSV save leaves out, and whether there was a table.
pub(super) fn csv_drops_content(markdown: &str) -> (usize, bool) {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let start = lines.iter().position(|l| l.trim().starts_with('|'));
    let Some(start) = start else {
        return (lines.iter().filter(|l| !l.trim().is_empty()).count(), false);
    };
    let end = lines[start + 1..].iter().position(|l| !l.trim().starts_with('|')).map_or(lines.len(), |i| start + 1 + i);
    let dropped = lines.iter().enumerate().filter(|(i, l)| !(start..end).contains(i) && !l.trim().is_empty()).count();
    (dropped, true)
}

/// The banner a manual CSV save shows, when it left something out.
pub(super) fn csv_save_note(markdown: &str) -> Option<String> {
    let (dropped, has_table) = csv_drops_content(markdown);
    if dropped == 0 {
        return None;
    }
    Some(if has_table {
        format!("Saved as CSV: {dropped} line{} outside the first table are not in that file.", if dropped == 1 { "" } else { "s" })
    } else {
        "Saved as CSV: this document has no table, so the file is empty.".into()
    })
}

/// page.tsx `fromDisk`.
pub(super) fn from_disk(format: FormatKind, raw: &str) -> String {
    if format == FormatKind::Csv { csv_to_markdown_table(raw) } else { raw.to_string() }
}

/// page.tsx `toDisk`.
pub(super) fn to_disk(format: FormatKind, text: &str) -> String {
    if format == FormatKind::Csv { markdown_table_to_csv(text) } else { text.to_string() }
}

#[cfg(test)]
mod tests {
    use super::{csv_drops_content, csv_save_note, csv_to_markdown_table, markdown_table_to_csv};

    /// Electron's own outputs on the same inputs
    /// (`rust/scripts/parity/source-cases.mjs`).
    #[test]
    fn source_conversions_match_electron() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/source_electron.json")).unwrap();
        let mut bad = Vec::new();
        for c in fixture["formatTables"].as_array().unwrap() {
            let (i, o) = (c["in"].as_str().unwrap(), c["out"].as_str().unwrap());
            let mine = markie_core::format_tables::format_markdown_tables(i);
            if mine != o {
                bad.push(format!("formatMarkdownTables {i:?}\n  electron {o:?}\n  rs       {mine:?}"));
            }
        }
        for c in fixture["csvToMarkdown"].as_array().unwrap() {
            let (i, o) = (c["in"].as_str().unwrap(), c["out"].as_str().unwrap());
            let mine = csv_to_markdown_table(i);
            if mine != o {
                bad.push(format!("csvToMarkdownTable {i:?}\n  electron {o:?}\n  rs       {mine:?}"));
            }
        }
        for c in fixture["markdownToCsv"].as_array().unwrap() {
            let (i, o) = (c["in"].as_str().unwrap(), c["out"].as_str().unwrap());
            let mine = markdown_table_to_csv(i);
            if mine != o {
                bad.push(format!("markdownTableToCSV {i:?}\n  electron {o:?}\n  rs       {mine:?}"));
            }
            let d = &c["drops"];
            let (lines, table) = csv_drops_content(i);
            if (lines as u64, table) != (d["droppedLines"].as_u64().unwrap(), d["hasTable"].as_bool().unwrap()) {
                bad.push(format!("csvDropsContent {i:?}: electron {d}, rs ({lines}, {table})"));
            }
        }
        for c in fixture["stats"].as_array().unwrap() {
            let i = c["in"].as_str().unwrap();
            let o = &c["out"];
            let s = markie_core::stats::compute(i);
            let mine = [s.words, s.chars, s.chars_no_spaces, s.lines, s.headings, s.code_blocks, s.links, s.reading_minutes];
            let theirs = ["words", "chars", "charsNoSpaces", "lines", "headings", "codeBlocks", "links", "readingTimeMin"]
                .map(|k| o[k].as_u64().unwrap() as usize);
            if mine != theirs {
                bad.push(format!("computeStats {i:?}: electron {theirs:?}, rs {mine:?}"));
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }

    #[test]
    fn csv_becomes_a_pipe_table() {
        assert_eq!(csv_to_markdown_table("a,b\n1,2\n3\n"), "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |\n");
        assert_eq!(csv_to_markdown_table("x|y,\"multi\nline\"\n"), "| x\\|y | multi line |\n| --- | --- |\n");
        assert_eq!(csv_to_markdown_table(""), "");
        assert_eq!(csv_to_markdown_table("\n\n"), "");
    }

    #[test]
    fn the_first_table_goes_back_to_csv() {
        let md = "| name | note |\n| :--- | ---: |\n| Ann | a\\|b |\n| Bo | \"q\", here |\n\ntext\n| later | table |\n";
        assert_eq!(markdown_table_to_csv(md), "name,note\nAnn,a|b\nBo,\"\"\"q\"\", here\"\n");
    }

    #[test]
    fn round_trip_keeps_cells() {
        let csv = "id,city,amount\n1,\"Paris, FR\",3.5\n2,Oslo,\n";
        assert_eq!(markdown_table_to_csv(&csv_to_markdown_table(csv)), csv);
    }

    #[test]
    fn saving_says_what_was_left_out() {
        assert_eq!(csv_save_note("| a |\n| --- |\n| 1 |\n"), None);
        assert_eq!(csv_save_note("# Title\n| a |\n| --- |\n"), Some("Saved as CSV: 1 line outside the first table are not in that file.".into()));
        assert_eq!(csv_save_note("one\ntwo\n"), Some("Saved as CSV: this document has no table, so the file is empty.".into()));
    }
}
