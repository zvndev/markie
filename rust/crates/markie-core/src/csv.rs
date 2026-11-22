//! CSV parsing for the table view. A port of `src/lib/csv.ts`, which follows
//! RFC 4180 quoting and ignores carriage returns outside quotes.

pub fn parse(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        match ch {
            '"' if field.is_empty() => in_quotes = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(ch),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// `serializeCSV`: rows joined by `\n`, then one `\n`, so no rows is `"\n"`.
pub fn serialize(rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return "\n".into();
    }
    let mut out = String::new();
    for row in rows {
        let cells: Vec<String> = row
            .iter()
            .map(|c| {
                if c.contains([',', '"', '\n', '\r']) {
                    format!("\"{}\"", c.replace('"', "\"\""))
                } else {
                    c.clone()
                }
            })
            .collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_and_newlines() {
        let rows = parse("name,note\r\n\"Smith, J\",\"said \"\"hi\"\"\nthen left\"\nlast,\n");
        assert_eq!(rows, vec![
            vec!["name".to_string(), "note".into()],
            vec!["Smith, J".into(), "said \"hi\"\nthen left".into()],
            vec!["last".into(), "".into()],
        ]);
        assert_eq!(parse(&serialize(&rows)), rows);
    }
}
