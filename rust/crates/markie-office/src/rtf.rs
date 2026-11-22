//! Original, deliberately bounded implementation of Microsoft RTF 1.9.1 prose
//! (Unicode RTF, font and color tables, paragraph formatting, character text,
//! and table rows and cells). Ported from `src/lib/office/rtf.ts`.
//! Unsupported semantics keep the original stream readable and exportable, but
//! never editable. Any table makes the document read-only.

use crate::codepages::single_byte_table;
use crate::error::{OfficeError, Result};
use crate::model::*;
use crate::rich_text_model::*;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOKENS: usize = 250_000;
const MAX_TEXT: usize = 1_000_000;

fn error(message: &str) -> OfficeError {
    OfficeError::docx("invalid-rtf", message)
}

#[derive(Clone, Debug)]
enum Token {
    Word { name: String, value: Option<i64> },
    Byte(u8),
    Symbol(u8),
    Binary,
    Group(Group),
}

#[derive(Clone, Debug)]
struct Group {
    tokens: Vec<Token>,
    start: usize,
    end: usize,
}

fn lex(bytes: &[u8]) -> Result<Group> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(error("RTF file exceeds the supported byte budget."));
    }
    let mut cursor = 0usize;
    let mut count = 0usize;
    fn group(bytes: &[u8], cursor: &mut usize, count: &mut usize, depth: usize) -> Result<Group> {
        if depth > 128 || bytes.get(*cursor) != Some(&b'{') {
            return Err(error("Invalid or excessively nested RTF group."));
        }
        let start = *cursor;
        *cursor += 1;
        let mut tokens = Vec::new();
        while *cursor < bytes.len() {
            *count += 1;
            if *count > MAX_TOKENS {
                return Err(error("RTF exceeds the supported token budget."));
            }
            let byte = bytes[*cursor];
            *cursor += 1;
            if byte == b'}' {
                return Ok(Group { tokens, start, end: *cursor });
            }
            if byte == b'{' {
                *cursor -= 1;
                tokens.push(Token::Group(group(bytes, cursor, count, depth + 1)?));
                continue;
            }
            if byte == b'\n' || byte == b'\r' {
                continue;
            }
            if byte != b'\\' {
                if byte == 0 {
                    return Err(error("Unexpected null byte in RTF text."));
                }
                tokens.push(Token::Byte(byte));
                continue;
            }
            if *cursor == bytes.len() {
                return Err(error("Truncated RTF escape."));
            }
            let next = bytes[*cursor];
            *cursor += 1;
            if next == b'\'' {
                let hex = bytes.get(*cursor..*cursor + 2).filter(|h| h.iter().all(u8::is_ascii_hexdigit));
                let Some(hex) = hex else { return Err(error("Invalid RTF hexadecimal escape.")) };
                let value = u8::from_str_radix(std::str::from_utf8(hex).unwrap_or("00"), 16).unwrap_or(0);
                *cursor += 2;
                tokens.push(Token::Byte(value));
                continue;
            }
            if !next.is_ascii_alphabetic() {
                tokens.push(Token::Symbol(next));
                continue;
            }
            let mut name = String::from(next as char);
            while *cursor < bytes.len() && bytes[*cursor].is_ascii_alphabetic() {
                if name.len() >= 32 {
                    return Err(error("RTF control word is too long."));
                }
                name.push(bytes[*cursor] as char);
                *cursor += 1;
            }
            let mut sign = 1i64;
            if bytes.get(*cursor) == Some(&b'-') {
                sign = -1;
                *cursor += 1;
                if !bytes.get(*cursor).is_some_and(u8::is_ascii_digit) {
                    return Err(error("Malformed RTF parameter."));
                }
            }
            let number_start = *cursor;
            while *cursor < bytes.len() && bytes[*cursor].is_ascii_digit() {
                *cursor += 1;
            }
            if *cursor - number_start > 9 {
                return Err(error("RTF parameter exceeds the supported range."));
            }
            let value = (*cursor != number_start).then(|| {
                sign * std::str::from_utf8(&bytes[number_start..*cursor]).unwrap_or("0").parse::<i64>().unwrap_or(0)
            });
            if bytes.get(*cursor) == Some(&b' ') {
                *cursor += 1;
            }
            if name == "bin" {
                match value {
                    Some(v) if v >= 0 && *cursor + v as usize <= bytes.len() => {
                        *cursor += v as usize;
                        tokens.push(Token::Binary);
                    }
                    _ => return Err(error("Truncated RTF binary data.")),
                }
            } else {
                tokens.push(Token::Word { name, value });
            }
        }
        Err(error("Unclosed RTF group."))
    }
    let result = group(bytes, &mut cursor, &mut count, 0)?;
    while cursor < bytes.len() && matches!(bytes[cursor], b'\n' | b'\r' | b' ' | b'\t') {
        cursor += 1;
    }
    if cursor != bytes.len() {
        return Err(error("Unexpected data outside the RTF root group."));
    }
    match result.tokens.first() {
        Some(Token::Word { name, value: Some(1) }) if name == "rtf" => Ok(result),
        _ => Err(error("The file is not an RTF 1 document.")),
    }
}

fn charset_codepage(charset: i64) -> Option<i64> {
    Some(match charset {
        0 => 1252,
        77 => 10000,
        128 => 932,
        129 => 949,
        134 => 936,
        136 => 950,
        161 => 1253,
        162 => 1254,
        163 => 1258,
        177 => 1255,
        178 => 1256,
        186 => 1257,
        204 => 1251,
        222 => 874,
        238 => 1250,
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq)]
struct Font {
    name: String,
    charset: Option<i64>,
    codepage: Option<i64>,
    family: String,
}

#[derive(Debug)]
pub(crate) struct RtfOwner {
    bytes: Vec<u8>,
    retained: Vec<Vec<u8>>,
    fonts: Vec<(i64, Font)>,
    default_family: String,
}

/// An opened RTF document: the shared projection plus its owned source.
#[derive(Clone, Debug)]
pub struct RtfDocument {
    pub(crate) native: NativeDocument,
    pub(crate) owner: Arc<RtfOwner>,
}

impl std::ops::Deref for RtfDocument {
    type Target = RichDocument;
    fn deref(&self) -> &RichDocument {
        &self.native.doc
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct ParagraphState {
    alignment: Option<String>,
    spacing_before_points: Option<f64>,
    spacing_after_points: Option<f64>,
    line_spacing_multiple: Option<f64>,
}

fn paragraph_defaults() -> ParagraphState {
    ParagraphState {
        alignment: Some("left".into()),
        spacing_before_points: Some(0.0),
        spacing_after_points: Some(0.0),
        line_spacing_multiple: Some(1.0),
    }
}

#[derive(Clone, Debug)]
struct State {
    style: RunStyle,
    font: Option<i64>,
    uc: i64,
    paragraph: ParagraphState,
    line: Option<i64>,
    multiple: Option<i64>,
    in_table: bool,
}

fn is_table_formatting(name: &str) -> bool {
    matches!(name, "trowd" | "lastrow" | "itap" | "cellx" | "gaph" | "taflags" | "irow" | "irowband")
        || ["tr", "cl", "tbl", "ts"].iter().any(|p| name.len() > p.len() && name.starts_with(p))
}

fn symbol_text(name: u8) -> Option<&'static str> {
    Some(match name {
        b'\\' => "\\",
        b'{' => "{",
        b'}' => "}",
        b'~' => "\u{a0}",
        b'-' => "\u{ad}",
        b'_' => "\u{2011}",
        _ => return None,
    })
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

struct Reader<'a> {
    bytes: &'a [u8],
    unsupported: Vec<String>,
    retained: Vec<Vec<u8>>,
    fonts: Vec<(i64, Font)>,
    font_names: BTreeSet<String>,
    colors: Vec<Option<String>>,
    default_font: Option<i64>,
    codepage: i64,
    text_length: usize,
    body_started: bool,
    page: PageLayout,
    paragraphs: Vec<ParagraphInput>,
    layout: Vec<BlockInput>,
    cell: Vec<usize>,
    row: Vec<Vec<usize>>,
    table_rows: Vec<Vec<Vec<usize>>>,
    table_seen: bool,
    runs: Vec<RunInput>,
    pending_high: Option<u16>,
}

impl Reader<'_> {
    fn warn(&mut self, name: &str) {
        if self.unsupported.len() < 64 && !self.unsupported.iter().any(|w| w == name) {
            self.unsupported.push(name.to_string());
        }
    }
    fn font(&self, id: i64) -> Option<&Font> {
        self.fonts.iter().find(|(i, _)| *i == id).map(|(_, f)| f)
    }
    fn decode(&mut self, values: &[u8], cp: i64) -> String {
        if values.is_empty() {
            return String::new();
        }
        if cp == 65001 {
            return match std::str::from_utf8(values) {
                Ok(s) => s.to_string(),
                Err(_) => {
                    self.warn(&format!("invalid-codepage-{cp}-bytes"));
                    String::from_utf8_lossy(values).to_string()
                }
            };
        }
        let encoding = match cp {
            932 => Some(encoding_rs::SHIFT_JIS),
            936 => Some(encoding_rs::GBK),
            949 => Some(encoding_rs::EUC_KR),
            950 => Some(encoding_rs::BIG5),
            _ => None,
        };
        if let Some(encoding) = encoding {
            let (decoded, had_errors) = encoding.decode_without_bom_handling(values);
            if had_errors {
                self.warn(&format!("invalid-codepage-{cp}-bytes"));
            }
            return decoded.into_owned();
        }
        let Some(table) = single_byte_table(cp) else {
            self.warn(&format!("codepage-{cp}"));
            return "\u{fffd}".repeat(values.len());
        };
        let mut out = String::with_capacity(values.len());
        let mut invalid = false;
        for &b in values {
            if b < 0x80 {
                out.push(b as char);
            } else {
                match char::from_u32(table[(b - 0x80) as usize] as u32).filter(|c| *c != '\0') {
                    Some(c) => out.push(c),
                    None => {
                        invalid = true;
                        out.push('\u{fffd}');
                    }
                }
            }
        }
        if invalid {
            self.warn(&format!("invalid-codepage-{cp}-bytes"));
        }
        out
    }
    fn font_codepage(&self, font: Option<i64>) -> i64 {
        let entry = font.and_then(|f| self.font(f));
        if let Some(cp) = entry.and_then(|e| e.codepage) {
            return cp;
        }
        if let Some(charset) = entry.and_then(|e| e.charset)
            && charset != 1
        {
            return charset_codepage(charset).unwrap_or(-charset);
        }
        self.codepage
    }
    fn family_for(&mut self, state: &State) -> Option<String> {
        let font = state.font.or(self.default_font);
        match font {
            None => Some("Times New Roman".into()),
            Some(f) => {
                let name = self.font(f).map(|x| x.name.clone());
                if name.is_none() {
                    self.warn(&format!("missing-font-{f}"));
                }
                name
            }
        }
    }
    fn append(&mut self, text: &str, state: &State) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        self.body_started = true;
        self.text_length += utf16_len(text);
        if self.text_length > MAX_TEXT {
            return Err(error("RTF text exceeds the supported display budget."));
        }
        let family = self.family_for(state);
        let mut style = state.style.clone();
        if let Some(f) = family {
            style.font_family = Some(f);
        }
        if let Some(previous) = self.runs.last_mut()
            && previous.style == style
        {
            previous.text.push_str(text);
        } else {
            self.runs.push(RunInput { text: text.to_string(), style });
        }
        Ok(())
    }
    fn close_row(&mut self) {
        if !self.cell.is_empty() {
            self.row.push(std::mem::take(&mut self.cell));
        }
        if !self.row.is_empty() {
            self.table_rows.push(std::mem::take(&mut self.row));
        }
    }
    fn close_table(&mut self) {
        self.close_row();
        if !self.table_rows.is_empty() {
            self.layout.push(BlockInput::Table(std::mem::take(&mut self.table_rows)));
        }
    }
    fn finish(&mut self, state: &State, cell_end: bool) {
        let mut current = state.paragraph.clone();
        if let Some(line) = state.line {
            if state.multiple == Some(1) && line > 0 {
                current.line_spacing_multiple = Some(line as f64 / 240.0);
            } else if line != 0 {
                self.warn("absolute-line-spacing");
            }
        }
        let family = self.family_for(state);
        let index = self.paragraphs.len();
        let runs = if self.runs.is_empty() {
            let mut style = state.style.clone();
            if let Some(f) = family {
                style.font_family = Some(f);
            }
            vec![RunInput { text: String::new(), style }]
        } else {
            std::mem::take(&mut self.runs)
        };
        self.paragraphs.push(ParagraphInput {
            runs,
            alignment: current.alignment,
            spacing_before_points: current.spacing_before_points,
            spacing_after_points: current.spacing_after_points,
            line_spacing_multiple: current.line_spacing_multiple,
            ..Default::default()
        });
        self.body_started = true;
        if cell_end || state.in_table {
            self.table_seen = true;
            self.warn("table");
            self.cell.push(index);
            if cell_end {
                self.row.push(std::mem::take(&mut self.cell));
            }
        } else {
            self.close_table();
            self.layout.push(BlockInput::Paragraph(index));
        }
    }

    fn font_table(&mut self, group: &Group, inherited_uc: i64) {
        if self.body_started || !self.fonts.is_empty() {
            self.warn("late-or-duplicate-font-table");
        }
        struct Entry {
            id: Option<i64>,
            charset: Option<i64>,
            cp: Option<i64>,
            values: Vec<u8>,
            name_text: Vec<u16>,
            fallback: i64,
            family: String,
        }
        let mut e = Entry { id: None, charset: None, cp: None, values: vec![], name_text: Vec::new(), fallback: 0, family: "fnil".into() };
        fn flush_bytes(r: &mut Reader, e: &mut Entry) {
            let cp = e.cp.unwrap_or(r.codepage);
            let values = std::mem::take(&mut e.values);
            let decoded = r.decode(&values, cp);
            e.name_text.extend(decoded.encode_utf16());
        }
        fn flush(r: &mut Reader, e: &mut Entry) {
            flush_bytes(r, e);
            let Some(id) = e.id else {
                return;
            };
            let name = String::from_utf16_lossy(&e.name_text).trim().to_string();
            let bad_char = name.chars().any(|c| matches!(c, ';' | '{' | '}' | '\\') || (c as u32) < 0x20 || c == '\u{7f}');
            if name.is_empty() || r.font(id).is_some() || r.font_names.contains(&name) || utf16_len(&name) > 200 || bad_char {
                r.warn("invalid-font-table");
            } else {
                r.font_names.insert(name.clone());
                r.fonts.push((id, Font { name, charset: e.charset, codepage: e.cp, family: e.family.clone() }));
            }
            e.id = None;
            e.charset = None;
            e.cp = None;
            e.values.clear();
            e.name_text.clear();
            e.family = "fnil".into();
        }
        fn visit(r: &mut Reader, e: &mut Entry, tokens: &[Token], inherited: i64) {
            let mut uc = inherited;
            for t in tokens {
                match t {
                    Token::Group(g) => {
                        e.fallback = 0;
                        visit(r, e, &g.tokens, uc);
                        e.fallback = 0;
                        continue;
                    }
                    Token::Byte(v) => {
                        if e.fallback > 0 {
                            e.fallback -= 1;
                        } else if *v == b';' {
                            flush(r, e);
                        } else {
                            e.values.push(*v);
                        }
                        continue;
                    }
                    _ => {}
                }
                flush_bytes(r, e);
                if e.fallback > 0 {
                    e.fallback -= 1;
                    continue;
                }
                let Token::Word { name, value } = t else {
                    r.warn("font-table-extension");
                    continue;
                };
                const FAMILIES: [&str; 8] = ["fnil", "froman", "fswiss", "fmodern", "fscript", "fdecor", "ftech", "fbidi"];
                match name.as_str() {
                    "f" => {
                        if e.id.is_some() || value.is_none_or(|v| v < 0) {
                            r.warn("invalid-font-table");
                        }
                        e.id = *value;
                    }
                    "fcharset" => e.charset = *value,
                    "cpg" => e.cp = *value,
                    n if FAMILIES.contains(&n) => e.family = n.to_string(),
                    "uc" if value.is_some_and(|v| (0..=32).contains(&v)) => uc = value.unwrap_or(1),
                    "u" if value.is_some_and(|v| (-32768..=32767).contains(&v)) => {
                        let unit = (value.unwrap_or(0) & 65535) as u16;
                        e.name_text.push(unit);
                        e.fallback = uc;
                    }
                    "fonttbl" => {}
                    n => r.warn(&format!("font-{n}")),
                }
            }
        }
        visit(self, &mut e, &group.tokens, inherited_uc);
        if e.id.is_some() || e.values.iter().any(|v| *v != b' ') || !String::from_utf16_lossy(&e.name_text).trim().is_empty() {
            self.warn("unterminated-font-entry");
        }
    }

    fn color_table(&mut self, group: &Group) {
        if self.body_started || !self.colors.is_empty() {
            self.warn("late-or-duplicate-color-table");
        }
        let mut rgb: [Option<i64>; 3] = [None; 3];
        for t in &group.tokens {
            match t {
                Token::Byte(b';') => {
                    let any = rgb.iter().any(Option::is_some);
                    self.colors.push(any.then(|| rgb.iter().map(|v| format!("{:02x}", v.unwrap_or(0))).collect()));
                    rgb = [None; 3];
                }
                Token::Word { name, value } if ["red", "green", "blue"].contains(&name.as_str()) => {
                    let Some(v) = value.filter(|v| (0..=255).contains(v)) else {
                        self.warn("invalid-color-table");
                        continue;
                    };
                    rgb[["red", "green", "blue"].iter().position(|n| n == name).unwrap_or(0)] = Some(v);
                }
                Token::Word { name, .. } if name == "colortbl" || name == "expandedcolortbl" => {}
                Token::Symbol(b'*') | Token::Byte(b' ') => {}
                _ => self.warn("color-table-extension"),
            }
        }
        if rgb.iter().any(Option::is_some) {
            self.warn("unterminated-color-entry");
        }
    }

    /// RTF 1.9.1 Information Group. Only passive properties are retained, as
    /// canonical Unicode text, because the body writer changes the code page.
    fn info_group(&mut self, group: &Group, state: &State) -> Option<Vec<u8>> {
        const TEXT_FIELDS: [&str; 10] = ["title", "subject", "author", "manager", "company", "operator", "category", "keywords", "comment", "doccomm"];
        const TIME_FIELDS: [&str; 4] = ["creatim", "revtim", "printim", "buptim"];
        const NUMBERS: [&str; 8] = ["version", "vern", "edmins", "nofpages", "nofwords", "nofchars", "nofcharsws", "id"];
        let time_bounds = |n: &str| -> Option<(i64, i64)> {
            Some(match n {
                "yr" => (0, 9999),
                "mo" => (1, 12),
                "dy" => (1, 31),
                "hr" => (0, 23),
                "min" => (0, 59),
                "sec" => (0, 59),
                _ => return None,
            })
        };
        let start = |g: &Group| usize::from(matches!(g.tokens.first(), Some(Token::Symbol(b'*'))));
        let whitespace = |t: &Token| matches!(t, Token::Byte(9 | 32));
        let cp = self.font_codepage(state.font.or(self.default_font));
        let property_text = |r: &mut Reader, tokens: &[Token]| -> Option<String> {
            let (mut uc, mut fallback) = (state.uc, 0i64);
            let mut result: Vec<u16> = Vec::new();
            let mut pending: Vec<u8> = Vec::new();
            for token in tokens {
                match token {
                    Token::Group(_) | Token::Binary => return None,
                    Token::Byte(b) => {
                        if fallback > 0 {
                            fallback -= 1;
                        } else {
                            pending.push(*b);
                        }
                        continue;
                    }
                    _ => {}
                }
                let decoded = r.decode(&std::mem::take(&mut pending), cp);
                result.extend(decoded.encode_utf16());
                match token {
                    Token::Word { name, value } => {
                        if !["uc", "u", "line", "tab"].contains(&name.as_str()) {
                            return None;
                        }
                        let bad = match name.as_str() {
                            "uc" => value.is_none_or(|v| !(0..=32).contains(&v)),
                            "u" => value.is_none_or(|v| !(-32768..=32767).contains(&v)),
                            _ => value.is_some(),
                        };
                        if bad {
                            return None;
                        }
                        if fallback > 0 {
                            fallback -= 1;
                            continue;
                        }
                        match name.as_str() {
                            "uc" => uc = value.unwrap_or(1),
                            "u" => {
                                result.push((value.unwrap_or(0) & 65535) as u16);
                                fallback = uc;
                            }
                            "line" => result.push(10),
                            _ => result.push(9),
                        }
                    }
                    Token::Symbol(s) => {
                        let text = symbol_text(*s)?;
                        if fallback > 0 {
                            fallback -= 1;
                            continue;
                        }
                        result.extend(text.encode_utf16());
                    }
                    _ => return None,
                }
            }
            let decoded = r.decode(&pending, cp);
            result.extend(decoded.encode_utf16());
            if fallback > 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&result))
        };
        let header = group.tokens.get(start(group))?;
        if !matches!(header, Token::Word { name, value: None } if name == "info") {
            return None;
        }
        let mut fields: BTreeSet<String> = BTreeSet::new();
        let mut pieces: Vec<String> = Vec::new();
        for token in &group.tokens[start(group) + 1..] {
            if whitespace(token) {
                continue;
            }
            let nested = if let Token::Group(g) = token { Some(g) } else { None };
            let first = match nested {
                Some(g) => g.tokens.get(start(g))?,
                None => token,
            };
            let Token::Word { name, value } = first else { return None };
            if !fields.insert(name.clone()) {
                return None;
            }
            let tail: &[Token] = match nested {
                Some(g) => &g.tokens[start(g) + 1..],
                None => &[],
            };
            if NUMBERS.contains(&name.as_str()) {
                let v = value.filter(|v| *v >= 0)?;
                if tail.iter().any(|t| !whitespace(t)) {
                    return None;
                }
                pieces.push(format!("\\{name}{v}"));
            } else if nested.is_some() && value.is_none() && TEXT_FIELDS.contains(&name.as_str()) {
                let value = property_text(self, tail)?;
                pieces.push(format!("{{\\{name}\\uc1 {}}}", escape_text(&value)));
            } else if nested.is_some() && value.is_none() && TIME_FIELDS.contains(&name.as_str()) {
                let mut seen = BTreeSet::new();
                let mut time = String::new();
                for part in tail {
                    if whitespace(part) {
                        continue;
                    }
                    let Token::Word { name: p, value: Some(v) } = part else { return None };
                    let (min, max) = time_bounds(p)?;
                    if !seen.insert(p.clone()) || *v < min || *v > max {
                        return None;
                    }
                    time.push_str(&format!("\\{p}{v}"));
                }
                pieces.push(format!("{{\\{name}{time}}}"));
            } else {
                return None;
            }
        }
        Some(format!("{{\\info{}}}", pieces.join("")).into_bytes())
    }

    fn visit(&mut self, group: &Group, inherited: &State, is_root: bool) -> Result<()> {
        let mut state = inherited.clone();
        if !is_root {
            let first = group.tokens.first();
            let dest_token = if matches!(first, Some(Token::Symbol(b'*'))) { group.tokens.get(1) } else { first };
            let dest = match dest_token {
                Some(Token::Word { name, .. }) => Some(name.as_str()),
                _ => None,
            };
            match dest {
                Some("fonttbl") => {
                    self.font_table(group, state.uc);
                    return Ok(());
                }
                // TextEdit writes the same table twice (plain plus expanded form). The first wins.
                Some("colortbl" | "expandedcolortbl") => {
                    if self.colors.is_empty() {
                        self.color_table(group);
                    }
                    return Ok(());
                }
                Some("info") => {
                    match self.info_group(group, &state) {
                        Some(info) => self.retained.push(info),
                        None => self.warn("info"),
                    }
                    return Ok(());
                }
                Some("generator") => {
                    // Only plain ASCII generator metadata is byte-stable under the canonical writer.
                    let start = if matches!(first, Some(Token::Symbol(_))) { 2 } else { 1 };
                    let unstable = group.tokens.iter().skip(start).any(|t| {
                        !matches!(t, Token::Byte(b) if *b < 128) && !matches!(t, Token::Symbol(b'\\' | b'{' | b'}'))
                    });
                    if unstable {
                        self.warn("generator-extension");
                    }
                    self.retained.push(self.bytes[group.start..group.end].to_vec());
                    return Ok(());
                }
                _ => {}
            }
            const SUPPRESSED: [&str; 24] = [
                "info", "stylesheet", "pict", "object", "field", "footnote", "annotation", "header", "footer", "headerl", "headerr", "footerl",
                "footerr", "listtable", "listoverridetable", "revtbl", "filetbl", "xmlnstbl", "datastore", "themedata", "colorschememapping",
                "upr", "ud", "nonesttables",
            ];
            if SUPPRESSED.contains(&dest.unwrap_or("")) || matches!(first, Some(Token::Symbol(b'*'))) {
                let name = dest.unwrap_or("unknown-destination").to_string();
                self.warn(&name);
                return Ok(());
            }
        }
        let mut pending: Vec<u8> = Vec::new();
        let mut fallback = 0i64;
        macro_rules! flush {
            () => {
                if !pending.is_empty() {
                    let cp = self.font_codepage(state.font.or(self.default_font));
                    let text = self.decode(&std::mem::take(&mut pending), cp);
                    self.append(&text, &state)?;
                }
            };
        }
        for (index, token) in group.tokens.iter().enumerate() {
            if let Token::Byte(b) = token {
                if fallback > 0 {
                    fallback -= 1;
                } else {
                    pending.push(*b);
                }
                continue;
            }
            flush!();
            if let Token::Group(g) = token {
                fallback = 0;
                self.visit(g, &state, false)?;
                continue;
            }
            if fallback > 0 {
                fallback -= 1;
                continue;
            }
            let (name, value) = match token {
                Token::Binary => {
                    self.warn("binary-data");
                    continue;
                }
                Token::Symbol(s) => {
                    if let Some(text) = symbol_text(*s) {
                        self.append(text, &state)?;
                    } else if *s == b'\n' || *s == b'\r' {
                        self.finish(&state, false);
                    } else {
                        self.warn(&format!("symbol-{}", *s as char));
                    }
                    continue;
                }
                Token::Word { name, value } => (name.as_str(), *value),
                _ => continue,
            };
            let required = |min: i64, max: i64| value.is_some_and(|v| v >= min && v <= max);
            const NO_PARAMETER: [&str; 22] = [
                "ansi", "plain", "pard", "ulnone", "ql", "qc", "qr", "qj", "par", "tab", "line", "emdash", "endash", "bullet", "lquote", "rquote",
                "ldblquote", "rdblquote", "enspace", "emspace", "qmspace", "landscape",
            ];
            if value.is_some() && NO_PARAMETER.contains(&name) {
                self.warn(&format!("unexpected-{name}-parameter"));
            }
            if name == "rtf" && is_root && index == 0 {
                continue;
            }
            match name {
                "ansi" => {}
                "ansicpg" => {
                    if self.body_started || !required(1, 65535) {
                        self.warn("invalid-codepage");
                    } else {
                        self.codepage = value.unwrap_or(1252);
                    }
                }
                "deff" => {
                    if self.body_started || !required(0, 65535) {
                        self.warn("invalid-default-font");
                    } else {
                        self.default_font = value;
                    }
                }
                "uc" => {
                    if !required(0, 32) {
                        return Err(error("Invalid RTF Unicode fallback count."));
                    }
                    state.uc = value.unwrap_or(1);
                }
                "u" => {
                    if !required(-32768, 32767) {
                        return Err(error("Invalid signed RTF Unicode code unit."));
                    }
                    let v = value.unwrap_or(0);
                    let unit = (if v < 0 { v + 65536 } else { v }) as u16;
                    self.append_unit(unit, &state)?;
                    fallback = state.uc;
                }
                "plain" => {
                    state.style = RunStyle { font_size_points: Some(12.0), ..Default::default() };
                    state.font = self.default_font;
                }
                "pard" => {
                    state.paragraph = paragraph_defaults();
                    state.line = None;
                    state.multiple = None;
                    state.in_table = false;
                }
                "intbl" => {
                    state.in_table = true;
                    self.table_seen = true;
                    self.warn("table");
                }
                "cell" => self.finish(&state, true),
                "row" => {
                    if !self.runs.is_empty() {
                        self.finish(&state, true);
                    }
                    self.close_row();
                    self.table_seen = true;
                    self.warn("table");
                }
                // A nested table is shown flattened: each inner cell becomes a paragraph of the outer cell.
                "nestcell" => {
                    let inner = State { in_table: true, ..state.clone() };
                    self.finish(&inner, false);
                    self.warn("nested-table");
                }
                "nestrow" => self.warn("nested-table"),
                n if is_table_formatting(n) => {
                    self.table_seen = true;
                    self.warn("table");
                }
                n if self.table_seen && n.starts_with("brdr") => {}
                "b" | "i" | "ul" => {
                    if value.is_some_and(|v| v != 0 && v != 1) {
                        self.warn(&format!("invalid-{name}"));
                    }
                    match name {
                        "b" => state.style.bold = Some(value != Some(0)),
                        "i" => state.style.italic = Some(value != Some(0)),
                        _ => state.style.underline = Some(if value == Some(0) { "none" } else { "single" }.into()),
                    }
                }
                "ulnone" => state.style.underline = Some("none".into()),
                "fs" => {
                    if !required(2, 800) {
                        self.warn("unsupported-font-size");
                    } else {
                        state.style.font_size_points = Some(value.unwrap_or(24) as f64 / 2.0);
                    }
                }
                "f" => {
                    if !required(0, 65535) {
                        self.warn("invalid-font-reference");
                    } else {
                        state.font = value;
                    }
                }
                "cf" => {
                    if !required(0, self.colors.len() as i64 - 1) {
                        self.warn("missing-color");
                    } else {
                        state.style.color = self.colors[value.unwrap_or(0) as usize].clone();
                    }
                }
                "ql" | "qc" | "qr" | "qj" => {
                    let a = match name {
                        "ql" => "left",
                        "qc" => "center",
                        "qr" => "right",
                        _ => "both",
                    };
                    state.paragraph.alignment = Some(a.into());
                }
                "sb" | "sa" => {
                    if !required(0, 31680) {
                        self.warn("unsupported-paragraph-spacing");
                    } else {
                        let v = Some(value.unwrap_or(0) as f64 / 20.0);
                        if name == "sb" {
                            state.paragraph.spacing_before_points = v;
                        } else {
                            state.paragraph.spacing_after_points = v;
                        }
                    }
                }
                "sl" => {
                    if !required(-31680, 31680) {
                        self.warn("invalid-line-spacing");
                    } else {
                        state.line = value;
                    }
                }
                "slmult" => {
                    if !required(0, 1) || state.line.is_none() {
                        self.warn("invalid-line-spacing-multiple");
                    } else {
                        state.multiple = value;
                    }
                }
                "par" => self.finish(&state, false),
                "tab" | "line" | "emdash" | "endash" | "bullet" | "lquote" | "rquote" | "ldblquote" | "rdblquote" | "enspace" | "emspace"
                | "qmspace" => {
                    let text = match name {
                        "tab" => "\t",
                        "line" => "\n",
                        "emdash" => "\u{2014}",
                        "endash" => "\u{2013}",
                        "bullet" => "\u{2022}",
                        "lquote" => "\u{2018}",
                        "rquote" => "\u{2019}",
                        "ldblquote" => "\u{201c}",
                        "rdblquote" => "\u{201d}",
                        "enspace" => "\u{2002}",
                        "emspace" => "\u{2003}",
                        _ => "\u{2005}",
                    };
                    if name == "enspace" || name == "emspace" {
                        self.warn("nonbreaking-font-relative-space");
                    }
                    self.append(text, &state)?;
                }
                "paperw" | "paperh" | "margt" | "margb" | "margl" | "margr" => {
                    if self.body_started || !required(0, 31680) {
                        self.warn("unsupported-page-layout");
                    } else {
                        let v = value.unwrap_or(0) as f64 / 20.0;
                        match name {
                            "paperw" => self.page.width_points = v,
                            "paperh" => self.page.height_points = v,
                            "margt" => self.page.margin_top_points = v,
                            "margb" => self.page.margin_bottom_points = v,
                            "margl" => self.page.margin_left_points = v,
                            _ => self.page.margin_right_points = v,
                        }
                    }
                }
                "landscape" => {
                    if self.body_started {
                        self.warn("late-landscape");
                    } else {
                        self.page.orientation = Orientation::Landscape;
                    }
                }
                // Producer identity, viewer window state and Cocoa layout hints carry no content.
                "cocoartf" | "cocoatextscaling" | "cocoaplatform" | "vieww" | "viewh" | "viewkind" | "viewscale" | "viewzk" | "viewnobound"
                | "deftab" | "tx" | "pardirnatural" | "partightenfactor" => {}
                other => self.warn(other),
            }
        }
        flush!();
        if is_root && (!self.runs.is_empty() || self.paragraphs.is_empty()) {
            self.finish(&state, false);
        }
        if is_root {
            self.close_table();
        }
        Ok(())
    }

    /// `\u` units may be surrogate halves; pair them with the previous run's tail.
    fn append_unit(&mut self, unit: u16, state: &State) -> Result<()> {
        if (0xdc00..=0xdfff).contains(&unit)
            && let Some(last) = self.runs.last_mut()
            && last.text.ends_with('\u{fffd}')
            && let Some(high) = self.pending_high.take()
        {
            last.text.pop();
            last.text.push_str(&String::from_utf16_lossy(&[high, unit]));
            return Ok(());
        }
        self.pending_high = if (0xd800..=0xdbff).contains(&unit) { Some(unit) } else { None };
        self.append(&String::from_utf16_lossy(&[unit]), state)
    }
}

fn escape_text(text: &str) -> String {
    let mut result = String::new();
    for c in text.chars() {
        match c {
            '\\' | '{' | '}' => {
                result.push('\\');
                result.push(c);
            }
            '\n' => result.push_str("\\line "),
            '\t' => result.push_str("\\tab "),
            c if (32..127).contains(&(c as u32)) => result.push(c),
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let code = *unit as i32;
                    result.push_str(&format!("\\u{}?", if code > 32767 { code - 65536 } else { code }));
                }
            }
        }
    }
    result
}

pub fn open_rtf(input: &[u8]) -> Result<RtfDocument> {
    let bytes = input.to_vec();
    let root = lex(&bytes)?;
    let mut reader = Reader {
        bytes: &bytes,
        unsupported: vec![],
        retained: vec![],
        fonts: vec![],
        font_names: BTreeSet::new(),
        colors: vec![],
        default_font: None,
        codepage: 1252,
        text_length: 0,
        body_started: false,
        page: DEFAULT_PAGE_LAYOUT,
        paragraphs: vec![],
        layout: vec![],
        cell: vec![],
        row: vec![],
        table_rows: vec![],
        table_seen: false,
        runs: vec![],
        pending_high: None,
    };
    let initial = State {
        style: RunStyle { font_size_points: Some(12.0), ..Default::default() },
        font: None,
        uc: 1,
        paragraph: paragraph_defaults(),
        line: None,
        multiple: None,
        in_table: false,
    };
    reader.visit(&root, &initial, true)?;
    let page = reader.page;
    if page.width_points <= 0.0
        || page.height_points <= 0.0
        || page.margin_left_points + page.margin_right_points >= page.width_points
        || page.margin_top_points + page.margin_bottom_points >= page.height_points
    {
        reader.warn("invalid-page-layout");
    }
    let diagnostics = if reader.unsupported.is_empty() {
        vec![]
    } else {
        vec![Diagnostic::warning(
            "rtf-unsupported",
            format!(
                "This RTF uses unsupported features ({}). It is read-only; original bytes are preserved.",
                reader.unsupported.join(", ")
            ),
        )]
    };
    let blocks = reader.layout.iter().any(|b| matches!(b, BlockInput::Table(_))).then(|| reader.layout.clone());
    let native = create_rich_snapshot(
        Format::Rtf,
        &reader.paragraphs,
        SnapshotOptions { page_layout: Some(page), diagnostics, can_edit: Some(reader.unsupported.is_empty()), blocks, ..Default::default() },
    )?;
    let default_family = match reader.default_font {
        None => "Times New Roman".to_string(),
        Some(f) => reader.font(f).map_or("Times New Roman".to_string(), |x| x.name.clone()),
    };
    let owner = RtfOwner { retained: reader.retained, fonts: reader.fonts, default_family, bytes: Vec::new() };
    Ok(RtfDocument { native, owner: Arc::new(RtfOwner { bytes, ..owner }) })
}

fn default_runs(owner: &RtfOwner) -> RunStyle {
    RunStyle { font_family: Some(owner.default_family.clone()), font_size_points: Some(12.0), ..Default::default() }
}
fn defaults_for_paragraph() -> ParagraphDefaults {
    let p = paragraph_defaults();
    ParagraphDefaults {
        alignment: p.alignment,
        spacing_before_points: p.spacing_before_points,
        spacing_after_points: p.spacing_after_points,
        line_spacing_multiple: p.line_spacing_multiple,
    }
}

pub fn apply_rtf_operations(document: &RtfDocument, operations: &[Operation]) -> Result<RtfDocument> {
    let source = &document.owner;
    let mut next = apply_simple_rich_operations(&document.native, operations)?;
    let changed = next != document.native;
    if changed {
        next = rebase_simple_rich_defaults(&next, &default_runs(source), &defaults_for_paragraph())?;
    }
    representable(&next)?;
    if changed {
        lex(&encode_rtf(&next, source)?)?;
    }
    Ok(RtfDocument { native: next, owner: source.clone() })
}

pub fn replace_rtf_text(document: &RtfDocument, edits: &[TextEdit]) -> Result<RtfDocument> {
    let source = &document.owner;
    let mut next = replace_simple_rich_text(&document.native, edits)?;
    if next != document.native {
        next = rebase_simple_rich_defaults(&next, &default_runs(source), &defaults_for_paragraph())?;
        representable(&next)?;
        lex(&encode_rtf(&next, source)?)?;
    }
    Ok(RtfDocument { native: next, owner: source.clone() })
}

/// Snapshots may only replace each other within one opened source lineage.
pub fn is_same_rtf_source(first: &RtfDocument, second: &RtfDocument) -> bool {
    Arc::ptr_eq(&first.owner, &second.owner)
}

fn representable(document: &NativeDocument) -> Result<()> {
    let exact = |value: f64, factor: f64| (value * factor - js_round(value * factor)).abs() < 1e-7;
    let unsupported = |m: &str| OfficeError::docx("unsupported-operation", m);
    for p in &document.paragraphs {
        for r in &p.runs {
            if r.style.font_size_points.is_some_and(|s| !exact(s, 2.0)) {
                return Err(unsupported("RTF font sizes must use half-point steps."));
            }
            if r.style.underline.as_deref().is_some_and(|u| !u.is_empty() && u != "none" && u != "single") {
                return Err(unsupported("This RTF editor supports single underline only."));
            }
            if r.style.font_family.as_deref().is_some_and(|f| f.contains([';', '{', '}', '\\'])) {
                return Err(unsupported("This font name is outside the supported RTF subset."));
            }
        }
        if ![p.spacing_before_points.unwrap_or(0.0), p.spacing_after_points.unwrap_or(0.0)].iter().all(|v| exact(*v, 20.0))
            || p.line_spacing_multiple.is_some_and(|v| !exact(v, 240.0))
        {
            return Err(unsupported("This spacing cannot be represented exactly in RTF units."));
        }
    }
    let l = document.page_layout;
    if ![l.width_points, l.height_points, l.margin_top_points, l.margin_right_points, l.margin_bottom_points, l.margin_left_points]
        .iter()
        .all(|v| exact(*v, 20.0))
    {
        return Err(unsupported("This page layout cannot be represented exactly in RTF units."));
    }
    Ok(())
}

fn encode_rtf(document: &NativeDocument, source: &RtfOwner) -> Result<Vec<u8>> {
    let mut fonts: Vec<String> = Vec::new();
    let mut push_font = |f: &str| {
        if !fonts.iter().any(|x| x == f) {
            fonts.push(f.to_string());
        }
    };
    push_font(&source.default_family);
    for (_, font) in &source.fonts {
        push_font(&font.name);
    }
    for p in &document.paragraphs {
        for r in &p.runs {
            if let Some(f) = r.style.font_family.as_deref().filter(|f| !f.is_empty()) {
                push_font(f);
            }
        }
    }
    let mut colors: Vec<String> = Vec::new();
    for p in &document.paragraphs {
        for r in &p.runs {
            if let Some(c) = r.style.color.as_deref().filter(|c| !c.is_empty() && *c != "auto")
                && !colors.iter().any(|x| x == c)
            {
                colors.push(c.to_string());
            }
        }
    }
    let original: HashMap<&str, &Font> = source.fonts.iter().map(|(_, f)| (f.name.as_str(), f)).collect();
    // Font names are table text, not executable RTF. A semicolon is a table delimiter, not escapable.
    if fonts.iter().any(|f| f.contains([';', '\r', '\n', '\t'])) {
        return Err(OfficeError::docx("rtf-font-name", "This font name cannot be represented safely in an RTF font table."));
    }
    let mut text = String::from("{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl");
    for (i, font) in fonts.iter().enumerate() {
        let o = original.get(font.as_str());
        text.push_str(&format!(
            "{{\\f{i}\\{}{}{} {};}}",
            o.map_or("fnil", |f| f.family.as_str()),
            o.and_then(|f| f.charset).map_or(String::new(), |c| format!("\\fcharset{c}")),
            o.and_then(|f| f.codepage).map_or(String::new(), |c| format!("\\cpg{c}")),
            escape_text(font)
        ));
    }
    text.push_str("}{\\colortbl;");
    for color in &colors {
        if color.len() != 6 || !color.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(OfficeError::docx("rtf-color", "Invalid RTF color."));
        }
        let channel = |i: usize| u8::from_str_radix(&color[i..i + 2], 16).unwrap_or(0);
        text.push_str(&format!("\\red{}\\green{}\\blue{};", channel(0), channel(2), channel(4)));
    }
    text.push('}');
    let mut result = text.into_bytes();
    for group in &source.retained {
        result.extend_from_slice(group);
    }
    let l = document.page_layout;
    let twips = |v: f64| js_number(js_round(v * 20.0));
    let mut body = format!(
        "\\paperw{}\\paperh{}\\margl{}\\margr{}\\margt{}\\margb{}{}",
        twips(l.width_points),
        twips(l.height_points),
        twips(l.margin_left_points),
        twips(l.margin_right_points),
        twips(l.margin_top_points),
        twips(l.margin_bottom_points),
        if l.orientation == Orientation::Landscape { "\\landscape" } else { "" }
    );
    for paragraph in &document.paragraphs {
        let align = match paragraph.alignment.as_deref().unwrap_or("left") {
            "center" => "qc",
            "right" => "qr",
            "both" => "qj",
            _ => "ql",
        };
        body.push_str(&format!(
            "\\pard\\{align}\\sb{}\\sa{}",
            twips(paragraph.spacing_before_points.unwrap_or(0.0)),
            twips(paragraph.spacing_after_points.unwrap_or(0.0))
        ));
        if let Some(m) = paragraph.line_spacing_multiple {
            body.push_str(&format!("\\sl{}\\slmult1", js_number(js_round(m * 240.0))));
        }
        body.push(' ');
        for run in &paragraph.runs {
            let s = &run.style;
            // Explicit resets make each run independent; properties stay active for the paragraph mark.
            let font = s
                .font_family
                .as_deref()
                .filter(|f| !f.is_empty())
                .map_or(String::new(), |f| format!("\\f{}", fonts.iter().position(|x| x == f).unwrap_or(0)));
            body.push_str(&format!(
                "\\plain{font}\\fs{}{}{}{}{} {}",
                js_number(js_round(s.font_size_points.unwrap_or(12.0) * 2.0)),
                if s.bold == Some(true) { "\\b" } else { "" },
                if s.italic == Some(true) { "\\i" } else { "" },
                if s.underline.as_deref().is_some_and(|u| !u.is_empty() && u != "none") { "\\ul" } else { "" },
                s.color
                    .as_deref()
                    .filter(|c| !c.is_empty() && *c != "auto")
                    .map_or(String::new(), |c| format!("\\cf{}", colors.iter().position(|x| x == c).map_or(0, |i| i + 1))),
                escape_text(&run.text)
            ));
        }
        body.push_str("\\par\n");
    }
    body.push('}');
    result.extend_from_slice(body.as_bytes());
    if result.len() > MAX_BYTES {
        return Err(OfficeError::docx("rtf-budget", "Edited RTF exceeds the supported byte budget."));
    }
    Ok(result)
}

/// Untouched documents return their original bytes.
pub fn export_rtf(document: &RtfDocument) -> Result<Vec<u8>> {
    let source = &document.owner;
    if !document.modified {
        return Ok(source.bytes.clone());
    }
    if !document.can_edit {
        return Err(OfficeError::docx("rtf-read-only", "Unsupported RTF content cannot be rewritten."));
    }
    representable(&document.native)?;
    let result = encode_rtf(&document.native, source)?;
    let reopened = open_rtf(&result)?;
    if !reopened.can_edit || reopened.text != document.text {
        return Err(OfficeError::docx("rtf-roundtrip", "Edited RTF cannot be reopened faithfully within the supported subset."));
    }
    Ok(result)
}

pub fn create_rtf(text: &str) -> Result<RtfDocument> {
    let body: String = text.split('\n').map(|part| format!("{}\\par ", escape_text(part))).collect();
    open_rtf(format!("{{\\rtf1\\ansi\\ansicpg1252\\uc1 {body}}}").as_bytes())
}
