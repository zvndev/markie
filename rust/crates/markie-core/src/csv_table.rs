//! The lossless model behind the CSV table. A port of Electron's
//! `src/lib/csv-table.ts`.
//!
//! A CSV file is kept as the exact tokens it was written with: every field
//! as its raw source slice (quotes included) and every row with the line
//! ending that followed it. Serializing joins those tokens back, so a file
//! that was opened and saved without edits is byte for byte the file that
//! was opened, whatever its delimiter, quoting, line endings, BOM or
//! trailing newline. An edit rewrites only the tokens of the cells it
//! touched.
//!
//! The fields of the opened file are spans into the text it was parsed from,
//! so opening allocates two flat arrays and nothing per row or per cell. A
//! row is copied out the first time it is edited.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::sync::Arc;

/// What ended a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eol {
    /// A last row with no newline.
    None,
    Lf,
    CrLf,
    Cr,
}

impl Eol {
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::None => "",
            Eol::Lf => "\n",
            Eol::CrLf => "\r\n",
            Eol::Cr => "\r",
        }
    }
}

/// One row: still the opened file's own fields, or its own copy once edited.
#[derive(Clone, Debug)]
enum Row {
    Base { start: u32, len: u32 },
    Own(Arc<[Box<str>]>),
}

#[derive(Clone, Debug)]
pub struct CsvDocument {
    /// The text began with U+FEFF.
    pub bom: bool,
    /// `,`, `;`, a tab or `|`.
    pub delimiter: char,
    /// The line ending new rows get: the file's most common one.
    pub newline: Eol,
    /// Every field in the file is quoted, so new and edited cells are too.
    pub quote_all: bool,
    /// The widest row.
    pub column_count: usize,
    source: Arc<str>,
    /// Every field of the opened file, as (start, end) in `source`.
    spans: Arc<[(u32, u32)]>,
    rows: Vec<Row>,
    eols: Vec<Eol>,
}

const DELIMITERS: [char; 4] = [',', '\t', ';', '|'];

struct Tokens {
    spans: Vec<(u32, u32)>,
    /// Where each row's fields start in `spans`, and how many there are.
    rows: Vec<(u32, u32)>,
    eols: Vec<Eol>,
}

/// One pass, quote aware. A field that opens with a quote runs to its closing
/// quote; anything after that up to the delimiter stays in the same token, so
/// malformed input still round-trips.
fn tokenize(text: &str, start: usize, delimiter: char, max_rows: usize) -> Tokens {
    let bytes = text.as_bytes();
    let delim = delimiter as u8;
    let length = bytes.len();
    let mut out = Tokens { spans: Vec::new(), rows: Vec::new(), eols: Vec::new() };
    if max_rows == usize::MAX {
        // A guess that saves most of the regrowth on a large file.
        out.spans.reserve(length / 8);
        out.rows.reserve(length / 32);
        out.eols.reserve(length / 32);
    }
    let (mut i, mut field_start, mut row_start) = (start, start, 0u32);
    while i < length {
        let mut code = bytes[i];
        if code == b'"' && i == field_start {
            i += 1;
            while i < length {
                if bytes[i] == b'"' {
                    if bytes.get(i + 1) == Some(&b'"') {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            if i >= length {
                break;
            }
            code = bytes[i];
        }
        if code == delim {
            out.spans.push((field_start as u32, i as u32));
            i += 1;
            field_start = i;
        } else if code == b'\n' || code == b'\r' {
            out.spans.push((field_start as u32, i as u32));
            let eol = if code == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                Eol::CrLf
            } else if code == b'\r' {
                Eol::Cr
            } else {
                Eol::Lf
            };
            out.rows.push((row_start, out.spans.len() as u32 - row_start));
            out.eols.push(eol);
            row_start = out.spans.len() as u32;
            i += eol.as_str().len();
            field_start = i;
            if out.rows.len() >= max_rows {
                return out;
            }
        } else {
            i += 1;
        }
    }
    if field_start < length || out.spans.len() as u32 > row_start {
        out.spans.push((field_start as u32, length as u32));
        out.rows.push((row_start, out.spans.len() as u32 - row_start));
        out.eols.push(Eol::None);
    }
    out
}

fn bom_len(text: &str) -> usize {
    if text.starts_with('\u{feff}') { '\u{feff}'.len_utf8() } else { 0 }
}

fn is_tsv_name(name: Option<&str>) -> bool {
    name.is_some_and(|n| {
        let lower = n.to_ascii_lowercase();
        lower.ends_with(".tsv") || lower.ends_with(".tab")
    })
}

/// The delimiter a file uses, read from its first rows. A `.tsv` name prefers tabs.
pub fn sniff_delimiter(text: &str, name: Option<&str>) -> char {
    let start = bom_len(text);
    let tsv = is_tsv_name(name);
    let (mut best, mut best_share, mut best_width) = (if tsv { '\t' } else { ',' }, 0f64, 1usize);
    for delimiter in DELIMITERS {
        let tokens = tokenize(text, start, delimiter, 40);
        let sample: Vec<usize> = tokens
            .rows
            .iter()
            .filter(|(s, n)| !(*n == 1 && tokens.spans[*s as usize].0 == tokens.spans[*s as usize].1))
            .map(|(_, n)| *n as usize)
            .collect();
        if sample.is_empty() {
            continue;
        }
        // Row widths in the order they first appear, as a JS Map iterates.
        let mut counts: Vec<(usize, usize)> = Vec::new();
        for size in &sample {
            match counts.iter_mut().find(|(s, _)| s == size) {
                Some(entry) => entry.1 += 1,
                None => counts.push((*size, 1)),
            }
        }
        let (mut width, mut rows_at_width) = (1usize, 0usize);
        for (size, count) in counts {
            if size > 1 && (count > rows_at_width || (count == rows_at_width && size > width)) {
                width = size;
                rows_at_width = count;
            }
        }
        if width <= 1 {
            continue;
        }
        if tsv && delimiter == '\t' {
            return '\t';
        }
        let share = rows_at_width as f64 / sample.len() as f64;
        // Anything but a comma has to hold for most rows: one cell with a "|" or a
        // ";" in it does not make a file pipe or semicolon separated.
        if delimiter != ',' && share <= 0.5 {
            continue;
        }
        if share > best_share || (share == best_share && width > best_width) {
            best = delimiter;
            best_share = share;
            best_width = width;
        }
    }
    best
}

/// A raw token as the value a person reads.
pub fn decode_field(raw: &str) -> Cow<'_, str> {
    if !raw.starts_with('"') {
        return Cow::Borrowed(raw);
    }
    let mut out = String::with_capacity(raw.len());
    let mut i = 1;
    while i < raw.len() {
        let Some(found) = raw[i..].find('"') else {
            out.push_str(&raw[i..]);
            return Cow::Owned(out);
        };
        let next = i + found;
        out.push_str(&raw[i..next]);
        if raw.as_bytes().get(next + 1) == Some(&b'"') {
            out.push('"');
            i = next + 2;
            continue;
        }
        out.push_str(&raw[next + 1..]);
        return Cow::Owned(out);
    }
    Cow::Owned(out)
}

pub fn encode_field(value: &str, delimiter: char, force_quote: bool) -> String {
    if !force_quote && !value.contains(delimiter) && !value.contains(['"', '\r', '\n']) {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// The rows a batch of cell edits replaced, to put back (undo) or to apply
/// again (redo): [`CsvDocument::swap_cells`] turns one into the other.
#[derive(Clone, Debug)]
pub struct CellUndo {
    rows: Vec<(usize, Row)>,
    column_count: usize,
}

impl CsvDocument {
    /// `name` is the file's name: a `.tsv` name reads tabs first.
    pub fn parse(text: &str, name: Option<&str>) -> Self {
        Self::parse_with(text, sniff_delimiter(text, name))
    }

    pub fn parse_with(text: &str, delimiter: char) -> Self {
        let bom = bom_len(text);
        let tokens = tokenize(text, bom, delimiter, usize::MAX);
        let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
        for eol in &tokens.eols {
            match eol {
                Eol::Lf => lf += 1,
                Eol::CrLf => crlf += 1,
                Eol::Cr => cr += 1,
                Eol::None => {}
            }
        }
        let newline = if crlf > lf && crlf >= cr {
            Eol::CrLf
        } else if cr > lf {
            Eol::Cr
        } else {
            Eol::Lf
        };
        // Sampled: a style question, not a correctness one.
        let (mut fields, mut quoted) = (0usize, 0usize);
        for (start, len) in tokens.rows.iter().take(200) {
            for (s, e) in &tokens.spans[*start as usize..(*start + *len) as usize] {
                if s == e {
                    continue;
                }
                fields += 1;
                if text.as_bytes()[*s as usize] == b'"' {
                    quoted += 1;
                }
            }
        }
        let column_count = tokens.rows.iter().map(|(_, n)| *n as usize).max().unwrap_or(0);
        Self {
            bom: bom > 0,
            delimiter,
            newline,
            quote_all: fields > 0 && quoted == fields,
            column_count,
            source: Arc::from(text),
            spans: Arc::from(tokens.spans),
            rows: tokens.rows.into_iter().map(|(start, len)| Row::Base { start, len }).collect(),
            eols: tokens.eols,
        }
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// How many fields the row has in the file.
    pub fn row_len(&self, row: usize) -> usize {
        match self.rows.get(row) {
            Some(Row::Base { len, .. }) => *len as usize,
            Some(Row::Own(cells)) => cells.len(),
            None => 0,
        }
    }

    pub fn eol(&self, row: usize) -> Eol {
        self.eols.get(row).copied().unwrap_or(Eol::None)
    }

    /// The raw token, exactly as written. None for a cell a short row does not have.
    pub fn raw(&self, row: usize, column: usize) -> Option<&str> {
        match self.rows.get(row)? {
            Row::Base { start, len } => {
                if column >= *len as usize {
                    return None;
                }
                let (s, e) = self.spans[*start as usize + column];
                Some(&self.source[s as usize..e as usize])
            }
            Row::Own(cells) => cells.get(column).map(|c| &**c),
        }
    }

    /// The value a person reads; empty for a cell that is not there.
    pub fn cell_value(&self, row: usize, column: usize) -> Cow<'_, str> {
        self.raw(row, column).map_or(Cow::Borrowed(""), decode_field)
    }

    fn row_tokens(&self, row: usize) -> Vec<Box<str>> {
        (0..self.row_len(row)).map(|c| Box::from(self.raw(row, c).unwrap_or(""))).collect()
    }

    fn is_blank_line(&self, row: usize) -> bool {
        self.row_len(row) == 1 && self.raw(row, 0) == Some("")
    }

    fn recount_columns(&mut self) {
        self.column_count = (0..self.rows.len()).map(|r| self.row_len(r)).max().unwrap_or(0);
    }

    pub fn serialize(&self) -> String {
        let mut out = String::with_capacity(self.source.len() + 64);
        if self.bom {
            out.push('\u{feff}');
        }
        let mut delimiter = [0u8; 4];
        let delimiter: &str = self.delimiter.encode_utf8(&mut delimiter);
        for (r, row) in self.rows.iter().enumerate() {
            match row {
                Row::Base { start, len } => {
                    // The row as it stood in the file, delimiters and all, in one copy.
                    if *len > 0 {
                        let first = self.spans[*start as usize].0 as usize;
                        let last = self.spans[(*start + *len) as usize - 1].1 as usize;
                        out.push_str(&self.source[first..last]);
                    }
                }
                Row::Own(cells) => {
                    for (c, cell) in cells.iter().enumerate() {
                        if c > 0 {
                            out.push_str(delimiter);
                        }
                        out.push_str(cell);
                    }
                }
            }
            out.push_str(self.eols[r].as_str());
        }
        out
    }

    /// False when the value is what the cell already says: nothing changes.
    pub fn set_cell(&mut self, row: usize, column: usize, value: &str) -> bool {
        if row >= self.rows.len() {
            return false;
        }
        let raw = self.raw(row, column);
        if raw.map_or(Cow::Borrowed(""), decode_field) == value {
            return false;
        }
        let was_quoted = raw.is_some_and(|r| r.starts_with('"'));
        let force = was_quoted || (self.quote_all && raw.is_none_or(str::is_empty));
        let token = encode_field(value, self.delimiter, force);
        let mut next = self.row_tokens(row);
        // A short row grows to reach the cell; the cells between stay empty.
        while next.len() < column {
            next.push(Box::from(if self.quote_all { "\"\"" } else { "" }));
        }
        if column < next.len() {
            next[column] = token.into();
        } else {
            next.push(token.into());
        }
        self.column_count = self.column_count.max(next.len());
        self.rows[row] = Row::Own(next.into());
        true
    }

    /// Several cells in one step. None when nothing changed; otherwise what
    /// puts the old cells back.
    pub fn set_cells(&mut self, edits: &[(usize, usize, &str)]) -> Option<CellUndo> {
        let mut undo = CellUndo { rows: Vec::new(), column_count: self.column_count };
        let mut changed = false;
        for (row, column, value) in edits {
            let Some(before) = self.rows.get(*row).cloned() else { continue };
            if self.set_cell(*row, *column, value) {
                changed = true;
                if !undo.rows.iter().any(|(r, _)| r == row) {
                    undo.rows.push((*row, before));
                }
            }
        }
        changed.then_some(undo)
    }

    /// Put back what `undo` holds and leave in it what was there, so the same
    /// value undoes and then redoes.
    pub fn swap_cells(&mut self, undo: &mut CellUndo) {
        for (row, saved) in &mut undo.rows {
            if let Some(current) = self.rows.get_mut(*row) {
                std::mem::swap(current, saved);
            }
        }
        std::mem::swap(&mut self.column_count, &mut undo.column_count);
    }

    /// A new row before `at` (the row count appends), empty unless `values` fill it.
    pub fn insert_row(&mut self, at: usize, values: &[&str]) {
        let index = at.min(self.rows.len());
        let width = self.column_count.max(values.len()).max(1);
        let row: Vec<Box<str>> =
            (0..width).map(|c| encode_field(values.get(c).copied().unwrap_or(""), self.delimiter, self.quote_all).into()).collect();
        let row = Row::Own(row.into());
        let count = self.rows.len();
        if index == count && count > 0 && self.eols[count - 1] == Eol::None {
            // The file has no trailing newline, and still has none afterwards.
            self.eols[count - 1] = self.newline;
            self.rows.push(row);
            self.eols.push(Eol::None);
        } else {
            self.rows.insert(index, row);
            self.eols.insert(index, self.newline);
        }
        self.recount_columns();
    }

    /// False when no index names a row.
    pub fn delete_rows(&mut self, indices: &[usize]) -> bool {
        let count = self.rows.len();
        let mut drop = vec![false; count];
        let mut any = false;
        for index in indices {
            if *index < count {
                drop[*index] = true;
                any = true;
            }
        }
        if !any {
            return false;
        }
        let ended_without_newline = self.eols[count - 1] == Eol::None;
        let mut keep = drop.iter().map(|d| !d);
        self.rows.retain(|_| keep.next().unwrap_or(true));
        let mut keep = drop.iter().map(|d| !d);
        self.eols.retain(|_| keep.next().unwrap_or(true));
        if ended_without_newline && let Some(last) = self.eols.last_mut() {
            *last = Eol::None;
        }
        self.recount_columns();
        true
    }

    /// A new empty column before `at` (the column count appends). Blank lines stay blank.
    pub fn insert_column(&mut self, at: usize) {
        let index = at.min(self.column_count);
        let empty = if self.quote_all { "\"\"" } else { "" };
        let only_row = self.rows.len() <= 1;
        for r in 0..self.rows.len() {
            if (self.is_blank_line(r) && !only_row) || self.row_len(r) < index {
                continue;
            }
            let mut next = self.row_tokens(r);
            next.insert(index, Box::from(empty));
            self.rows[r] = Row::Own(next.into());
        }
        self.recount_columns();
    }

    /// False when no index names a column.
    pub fn delete_columns(&mut self, columns: &[usize]) -> bool {
        let mut drop = vec![false; self.column_count];
        let mut any = false;
        for column in columns {
            if *column < self.column_count {
                drop[*column] = true;
                any = true;
            }
        }
        if !any {
            return false;
        }
        for r in 0..self.rows.len() {
            if self.is_blank_line(r) {
                continue;
            }
            let before = self.row_len(r);
            let mut next: Vec<Box<str>> =
                self.row_tokens(r).into_iter().enumerate().filter(|(c, _)| !drop[*c]).map(|(_, cell)| cell).collect();
            if next.len() == before {
                continue;
            }
            if next.is_empty() {
                next.push(Box::from(""));
            }
            self.rows[r] = Row::Own(next.into());
        }
        self.recount_columns();
        true
    }
}

// ---------------------------------------------------------------------------
// Reading values: numbers, headers, sorting, filtering. View only.

/// JavaScript's `\s`, which is also what its `trim` removes.
fn is_js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn is_currency(c: char) -> bool {
    matches!(c, '$' | '€' | '£' | '¥')
}

fn is_group_gap(c: char) -> bool {
    matches!(c, ' ' | '\u{a0}' | '\'')
}

/// `/^\d{1,3}(?:SEP\d{3})+$/` for one kind of separator.
fn grouped_by(digits: &str, is_separator: impl Fn(char) -> bool) -> bool {
    let mut parts = digits.split(is_separator);
    let Some(first) = parts.next() else { return false };
    if first.is_empty() || first.len() > 3 || !first.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let mut groups = 0;
    for part in parts {
        if part.len() != 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        groups += 1;
    }
    groups > 0
}

/// `/^\d{1,3}(?:[  ']\d{3})+(?:[.,]\d+)?$/`
fn grouped_by_space(digits: &str) -> bool {
    let (whole, fraction) = match digits.rfind(['.', ',']) {
        Some(at) => (&digits[..at], Some(&digits[at + 1..])),
        None => (digits, None),
    };
    if fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    grouped_by(whole, is_group_gap)
}

/// The number a cell shows, or None. `decimal_comma` settles "1,234" for
/// files that use ";" between fields.
pub fn parse_number(value: &str, decimal_comma: bool) -> Option<f64> {
    let text = js_trim(value);
    if text.is_empty() || text.encode_utf16().count() > 40 {
        return None;
    }
    // /^[-+]?(?:[$€£¥]\s?)?(\d[\d.,'  ]*|[.,]\d+)(?:\s?[%$€£¥])?$/
    let mut body = text.strip_prefix(['-', '+']).unwrap_or(text);
    if let Some(rest) = body.strip_prefix(is_currency) {
        body = rest;
        let mut chars = body.chars();
        if chars.next().is_some_and(is_js_space) {
            body = chars.as_str();
        }
    }
    if let Some(rest) = body.strip_suffix(|c: char| c == '%' || is_currency(c)) {
        body = rest;
        // The one space the pattern allows before the sign, when the digits cannot hold it.
        if let Some(last) = body.chars().next_back()
            && is_js_space(last)
            && !is_group_gap(last)
        {
            body = &body[..body.len() - last.len_utf8()];
        }
    }
    let mut chars = body.chars();
    let first = chars.next()?;
    let matched = if first.is_ascii_digit() {
        chars.all(|c| c.is_ascii_digit() || matches!(c, '.' | ',') || is_group_gap(c))
    } else if first == '.' || first == ',' {
        let rest = chars.as_str();
        !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
    } else {
        false
    };
    if !matched {
        return None;
    }
    let mut digits = js_trim(body).to_string();
    if digits.contains(is_group_gap) {
        if !grouped_by_space(&digits) {
            return None;
        }
        digits.retain(|c| !is_group_gap(c));
    }
    let (last_comma, last_dot) = (digits.rfind(','), digits.rfind('.'));
    match (last_comma, last_dot) {
        (Some(comma), Some(dot)) => {
            digits = if comma > dot { digits.replace('.', "").replacen(',', ".", 1) } else { digits.replace(',', "") };
        }
        (Some(comma), None) => {
            let grouped = grouped_by(&digits, |c| c == ',');
            if grouped && !decimal_comma {
                digits = digits.replace(',', "");
            } else if digits.find(',') == Some(comma) {
                digits = digits.replacen(',', ".", 1);
            } else if grouped {
                digits = digits.replace(',', "");
            } else {
                return None;
            }
        }
        (None, Some(dot)) => {
            let grouped = grouped_by(&digits, |c| c == '.');
            if digits.find('.') != Some(dot) {
                if !grouped {
                    return None;
                }
                digits = digits.replace('.', "");
            } else if decimal_comma && grouped {
                digits = digits.replacen('.', "", 1);
            }
        }
        (None, None) => {}
    }
    // What is left is digits around at most one dot, which JavaScript's
    // Number and Rust's parser read alike.
    let number: f64 = digits.parse().ok()?;
    if !number.is_finite() {
        return None;
    }
    Some(if text.starts_with('-') { -number } else { number })
}

const SAMPLE_ROWS: usize = 400;

impl CsvDocument {
    fn decimal_comma(&self) -> bool {
        self.delimiter == ';'
    }

    /// Which columns hold numbers, from a sample of the rows after `first_row`.
    pub fn numeric_columns(&self, first_row: usize) -> Vec<bool> {
        let decimal_comma = self.decimal_comma();
        let mut filled = vec![0usize; self.column_count];
        let mut numeric = vec![0usize; self.column_count];
        let end = self.rows.len().min(first_row + SAMPLE_ROWS);
        for r in first_row..end {
            for c in 0..self.row_len(r) {
                let value = self.cell_value(r, c);
                if js_trim(&value).is_empty() {
                    continue;
                }
                filled[c] += 1;
                if parse_number(&value, decimal_comma).is_some() {
                    numeric[c] += 1;
                }
            }
        }
        filled.iter().zip(&numeric).map(|(count, n)| *count > 0 && *n as f64 >= *count as f64 * 0.9).collect()
    }

    /// Whether the first row reads as column names. It does unless it is
    /// clearly data: one of its cells is a number in a column whose other
    /// rows are numbers.
    pub fn first_row_is_header(&self) -> bool {
        if self.rows.len() < 2 {
            return self.rows.len() == 1;
        }
        let numeric = self.numeric_columns(1);
        let decimal_comma = self.decimal_comma();
        !(0..self.row_len(0)).any(|c| numeric.get(c).copied().unwrap_or(false) && parse_number(&self.cell_value(0, c), decimal_comma).is_some())
    }

    /// The number in a cell, read the way this file writes numbers.
    pub fn cell_number(&self, row: usize, column: usize) -> Option<f64> {
        parse_number(&self.cell_value(row, column), self.decimal_comma())
    }
}

/// "A", "B", ... "Z", "AA": the name of a column with no header.
pub fn column_letter(index: usize) -> String {
    let mut name = Vec::new();
    let mut n = index as i64;
    loop {
        name.push(b'A' + (n % 26) as u8);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CsvSort {
    pub column: usize,
    pub direction: SortDirection,
}

/// A letter without its accent, lower case: what `Intl.Collator` compares at
/// `sensitivity: "base"`, for the Latin letters a CSV usually holds.
fn base_letter(c: char) -> char {
    match c {
        'À'..='Å' | 'à'..='å' | 'Ā'..='ą' => 'a',
        'Ç' | 'ç' | 'Ć'..='č' => 'c',
        'Ď'..='đ' => 'd',
        'È'..='Ë' | 'è'..='ë' | 'Ē'..='ě' => 'e',
        'Ĝ'..='ģ' => 'g',
        'Ĥ'..='ħ' => 'h',
        'Ì'..='Ï' | 'ì'..='ï' | 'Ĩ'..='ı' => 'i',
        'Ĵ' | 'ĵ' => 'j',
        'Ķ' | 'ķ' => 'k',
        'Ĺ'..='ł' => 'l',
        'Ñ' | 'ñ' | 'Ń'..='ň' => 'n',
        'Ò'..='Ö' | 'Ø' | 'ò'..='ö' | 'ø' | 'Ō'..='ő' => 'o',
        'Ŕ'..='ř' => 'r',
        'Ś'..='š' => 's',
        'Ţ'..='ŧ' => 't',
        'Ù'..='Ü' | 'ù'..='ü' | 'Ũ'..='ų' => 'u',
        'Ŵ' | 'ŵ' => 'w',
        'Ý' | 'ý' | 'ÿ' | 'Ŷ'..='Ÿ' => 'y',
        'Ź'..='ž' => 'z',
        other => other.to_lowercase().next().unwrap_or(other),
    }
}

/// Text order as `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`
/// gives it: runs of digits compare as numbers, letters without case or accent.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) if p.is_ascii_digit() && q.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut run = String::new();
                    while let Some(d) = it.peek().copied().filter(char::is_ascii_digit) {
                        run.push(d);
                        it.next();
                    }
                    run
                };
                let (m, n) = (take(&mut x), take(&mut y));
                let (m, n) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let order = m.len().cmp(&n.len()).then_with(|| m.cmp(n));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(p), Some(q)) => {
                let order = base_letter(p).cmp(&base_letter(q));
                if order != Ordering::Equal {
                    return order;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// Whether `field`, lower-cased, holds `needle` (already lower case).
fn contains_lower(field: &str, needle: &str, needle_ascii: bool, scratch: &mut String) -> bool {
    if field.len() < needle.len() {
        // Lower-casing can shorten or lengthen text, but only outside ASCII.
        if field.is_ascii() {
            return false;
        }
    }
    if field.is_ascii() {
        if !needle_ascii {
            return false;
        }
        let (hay, pin) = (field.as_bytes(), needle.as_bytes());
        if pin.is_empty() {
            return true;
        }
        if hay.len() < pin.len() {
            return false;
        }
        let first = pin[0];
        return (0..=hay.len() - pin.len()).any(|i| hay[i].to_ascii_lowercase() == first && hay[i..i + pin.len()].eq_ignore_ascii_case(pin));
    }
    scratch.clear();
    scratch.extend(field.chars().flat_map(char::to_lowercase));
    scratch.contains(needle)
}

impl CsvDocument {
    /// The rows to show, as indices into the file's rows: those after
    /// `first_row` that match the filter, in sorted order. The document is
    /// never changed.
    pub fn view_rows(&self, first_row: usize, filter: &str, sort: Option<CsvSort>, numeric: &[bool]) -> Vec<u32> {
        let needle: String = js_trim(filter).chars().flat_map(char::to_lowercase).collect();
        let needle_ascii = needle.is_ascii();
        let mut order: Vec<u32> = Vec::with_capacity(if needle.is_empty() { self.rows.len().saturating_sub(first_row) } else { 0 });
        let mut scratch = String::new();
        for r in first_row..self.rows.len() {
            if !needle.is_empty() {
                let hit = (0..self.row_len(r)).any(|c| {
                    let raw = self.raw(r, c).unwrap_or("");
                    if raw.starts_with('"') {
                        contains_lower(&decode_field(raw), &needle, needle_ascii, &mut scratch)
                    } else {
                        contains_lower(raw, &needle, needle_ascii, &mut scratch)
                    }
                });
                if !hit {
                    continue;
                }
            }
            order.push(r as u32);
        }
        let Some(sort) = sort else { return order };
        let descending = sort.direction == SortDirection::Desc;
        let flip = |o: Ordering| if descending { o.reverse() } else { o };
        // Empty cells sort last in both directions; ties keep file order
        // (the sort is stable and the rows start in file order).
        if numeric.get(sort.column).copied().unwrap_or(false) {
            let mut keyed: Vec<(Option<f64>, u32)> = order.iter().map(|r| (self.cell_number(*r as usize, sort.column), *r)).collect();
            keyed.sort_by(|(x, _), (y, _)| match (x, y) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(x), Some(y)) => flip(x.partial_cmp(y).unwrap_or(Ordering::Equal)),
            });
            return keyed.into_iter().map(|(_, r)| r).collect();
        }
        let mut keyed: Vec<(Cow<'_, str>, u32)> = order.iter().map(|r| (self.cell_value(*r as usize, sort.column), *r)).collect();
        keyed.sort_by(|(x, _), (y, _)| match (x.is_empty(), y.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => flip(natural_cmp(x, y)),
        });
        keyed.into_iter().map(|(_, r)| r).collect()
    }

    // -----------------------------------------------------------------------
    // Clipboard

    /// A block of cells as delimited text: tab for a spreadsheet, comma for CSV.
    pub fn cells_to_text(&self, rows: &[usize], columns: &[usize], delimiter: char) -> String {
        let mut out = String::new();
        let mut gap = [0u8; 4];
        let gap: &str = delimiter.encode_utf8(&mut gap);
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                out.push('\n');
            }
            for (j, column) in columns.iter().enumerate() {
                if j > 0 {
                    out.push_str(gap);
                }
                out.push_str(&encode_field(&self.cell_value(*row, *column), delimiter, false));
            }
        }
        out
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Pasted text as rows of cells: tab separated when it has tabs, otherwise one cell per line.
pub fn clipboard_to_cells(text: &str) -> Vec<Vec<String>> {
    let mut body = normalize_newlines(text);
    if body.ends_with('\n') {
        body.pop();
    }
    if !body.contains('\t') && !body.contains('\n') {
        return vec![vec![body]];
    }
    let tokens = tokenize(&body, 0, '\t', usize::MAX);
    tokens
        .rows
        .iter()
        .map(|(start, len)| {
            tokens.spans[*start as usize..(*start + *len) as usize].iter().map(|(s, e)| decode_field(&body[*s as usize..*e as usize]).into_owned()).collect()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The raw text view

/// Text typed in an editor that only knows "\n", put back in the shape the
/// file had: its line ending and its BOM.
pub fn restore_text_shape(original: &str, edited: &str) -> String {
    let bom = original.starts_with('\u{feff}');
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let bytes = original.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    let newline = if crlf > lf && crlf >= cr {
        "\r\n"
    } else if cr > lf {
        "\r"
    } else {
        "\n"
    };
    let mut text = normalize_newlines(edited);
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    if newline != "\n" {
        text = text.replace('\n', newline);
    }
    if bom { format!("\u{feff}{text}") } else { text }
}

/// The text an "\n"-only editor is given: no BOM, one kind of line ending.
pub fn plain_editor_text(text: &str) -> String {
    normalize_newlines(text.strip_prefix('\u{feff}').unwrap_or(text))
}

pub fn is_csv_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".csv") || lower.ends_with(".tsv")
}

/// A count the way `toLocaleString("en-US")` writes it: 1,234,567.
pub fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A sum as the status line shows it:
/// `Number(sum.toPrecision(12)).toLocaleString("en-US", { maximumFractionDigits: 6 })`.
pub fn format_sum(sum: f64) -> String {
    if !sum.is_finite() {
        return sum.to_string();
    }
    // Twelve significant digits, then at most six after the point.
    let rounded: f64 = format!("{sum:.11e}").parse().unwrap_or(sum);
    let fixed = format!("{:.6}", rounded.abs());
    let (whole, fraction) = fixed.split_once('.').unwrap_or((&fixed, ""));
    let fraction = fraction.trim_end_matches('0');
    let mut out = String::new();
    if rounded < 0. && (whole != "0" || !fraction.is_empty()) {
        out.push('-');
    }
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if !fraction.is_empty() {
        out.push('.');
        out.push_str(fraction);
    }
    out
}

#[cfg(test)]
mod tests;
