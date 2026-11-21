//! Original bounded RTF body-text reader, derived only from the public RTF 1.9.1
//! wire specification (<https://go.microsoft.com/fwlink/?LinkId=120924>).
//! Ported from `src/lib/document-import/rtf.ts`. This converts to a NEW
//! plain-text copy; it is never RTF editing or lossless round-tripping.

use super::{DocumentImportError, DocumentImportLimits, ImportErrorCode, ImportResult, ImportedDocumentText, resolve_document_import_limits};
use std::collections::HashMap;

const LOSS_WARNING: &str = "RTF body text was converted to a new plain-text copy. Formatting, page layout, images, headers/footers, comments, footnotes, links and revision semantics are not preserved.";

const OMITTED: &[&str] = &[
    "fonttbl", "filetbl", "colortbl", "stylesheet", "latentstyles", "listtable", "listoverridetable", "revtbl", "rsidtbl", "rsidtable",
    "info", "title", "subject", "author", "manager", "company", "operator", "category", "keywords", "comment", "doccomm", "hlinkbase",
    "creatim", "revtim", "printim", "buptim", "generator", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "footnote",
    "annotation", "atnauthor", "atnid", "atndate", "atnref", "atntime", "bkmkstart", "bkmkend", "fldinst", "datafield", "formfield",
    "pict", "shppict", "nonshppict", "object", "objdata", "objclass", "objname", "objtime", "shp", "shpgrp", "shpinst", "shprslt", "shptxt",
    "private", "userprops", "docvar", "themedata", "colorschememapping", "datastore", "xmlnstbl", "protusertbl", "mmathPr",
    "pn", "list", "listlevel", "leveltext", "levelnumbers", "falt", "fname", "panose", "fontemb", "fontfile", "background",
    "xe", "tc", "rxe", "txe", "nextfile", "template", "do", "aftncn", "aftnsep", "aftnsepc", "ftncn", "ftnsep", "ftnsepc",
];

fn text_control(word: &str) -> Option<&'static str> {
    Some(match word {
        "par" | "line" | "row" | "nestrow" => "\n",
        "tab" | "cell" | "nestcell" => "\t",
        "page" | "sect" => "\n\n",
        "emdash" => "\u{2014}",
        "endash" => "\u{2013}",
        "bullet" => "\u{2022}",
        "lquote" => "\u{2018}",
        "rquote" => "\u{2019}",
        "ldblquote" => "\u{201c}",
        "rdblquote" => "\u{201d}",
        "emspace" => "\u{2003}",
        "enspace" => "\u{2002}",
        "qmspace" => "\u{2005}",
        "ltrmark" => "\u{200e}",
        "rtlmark" => "\u{200f}",
        "zwbo" => "\u{200b}",
        _ => return None,
    })
}

fn symbol(c: u8) -> Option<&'static str> {
    Some(match c {
        b'\\' => "\\",
        b'{' => "{",
        b'}' => "}",
        b'~' => "\u{a0}",
        b'-' => "\u{ad}",
        b'_' => "\u{2011}",
        _ => return None,
    })
}

const VISIBLE_DESTINATIONS: &[&str] = &["field", "fldrslt", "pntext", "listtext"];
const KNOWN_FORMATTING: &[&str] = &[
    "ansi", "fromtext", "b", "i", "ul", "ulnone", "uldb", "strike", "striked", "super", "sub", "nosupersub", "fs", "cf", "cb", "highlight",
    "pard", "s", "cs", "sa", "sb", "sl", "slmult", "li", "ri", "fi", "ql", "qr", "qc", "qj", "keep", "keepn", "widctlpar", "nowidctlpar",
    "fprq", "fnil", "froman", "fswiss", "fmodern", "fscript", "fdecor", "ftech", "fbidi", "fbidis", "lang", "langfe", "deflang", "deflangfe",
    "paperw", "paperh", "margl", "margr", "margt", "margb", "viewkind", "viewscale", "deftab", "sectd", "linex", "ftnbj", "endnhere",
    "trowd", "trgaph", "trleft", "cellx", "intbl", "itap", "ls", "ilvl", "pntext", "listtext", "rtlch", "ltrch", "rtlpar", "ltrpar", "loch", "hich", "dbch",
    "field", "fldrslt", "flddirty", "fldedit", "fldlock", "fldpriv", "nouicompat", "uc", "u", "rtf", "deff", "f", "cpg", "fcharset", "ansicpg", "plain", "v",
];

/// Windows-1252 per the WHATWG Encoding Standard index; 0x81, 0x8D, 0x8F, 0x90
/// and 0x9D are rejected before decoding, as the fatal TypeScript decoder does.
pub(crate) fn windows_1252(byte: u8) -> char {
    const HIGH: [u16; 32] = [
        0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
        0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
    ];
    if (0x80..0xa0).contains(&byte) {
        char::from_u32(HIGH[(byte - 0x80) as usize] as u32).unwrap_or('\u{fffd}')
    } else {
        byte as char
    }
}

#[derive(Clone, Copy)]
struct Font {
    charset: i64,
    codepage: Option<i64>,
}

#[derive(Clone)]
struct Group {
    skip: bool,
    font_table: bool,
    font_definition: Option<i64>,
    font: i64,
    unicode_fallback: i64,
    hidden: bool,
    start: bool,
    starred: bool,
}

fn malformed() -> DocumentImportError {
    DocumentImportError::new(
        ImportErrorCode::Malformed,
        "The RTF structure or character encoding is malformed. The original is unchanged.",
    )
}
fn budget() -> DocumentImportError {
    DocumentImportError::new(ImportErrorCode::LimitExceeded, "RTF conversion exceeded its input, text, nesting or token budget.")
}
fn unsupported(message: &str) -> DocumentImportError {
    DocumentImportError::new(ImportErrorCode::Unsupported, message)
}

/// Ordered, de-duplicated warnings (the TypeScript uses a Set).
struct Warnings(Vec<String>);
impl Warnings {
    fn add(&mut self, w: &str) {
        if !self.0.iter().any(|x| x == w) {
            self.0.push(w.to_string());
        }
    }
}

pub fn extract_rtf_text(bytes: &[u8], limits: DocumentImportLimits) -> ImportResult<ImportedDocumentText> {
    let limits = resolve_document_import_limits(limits)?;
    if bytes.len() > limits.max_input_bytes {
        return Err(budget());
    }
    let mut warnings = Warnings(vec![LOSS_WARNING.to_string()]);
    let mut stack: Vec<Group> = Vec::new();
    let mut fonts: HashMap<i64, Font> = HashMap::new();
    let mut default_font = 0i64;
    let mut position = 0usize;
    let (mut root_seen, mut root_closed, mut header_seen) = (false, false, false);
    let (mut controls, mut nodes, mut fallback) = (0usize, 0usize, 0i64);
    // UTF-16 output so surrogate halves from separate \u controls can pair up.
    let mut out: Vec<u16> = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    let letter = |b: u8| b.is_ascii_alphabetic();
    let digit = |b: u8| b.is_ascii_digit();
    let whitespace = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | b'\r');

    macro_rules! node {
        () => {{
            nodes += 1;
            if nodes > limits.max_nodes {
                return Err(budget());
            }
        }};
    }
    macro_rules! append_units {
        ($units:expr) => {{
            let units: Vec<u16> = $units;
            if units.len() > limits.max_text_code_units - out.len() {
                return Err(budget());
            }
            out.extend(units);
        }};
    }
    macro_rules! flush {
        () => {{
            if !pending.is_empty() {
                node!();
                let decoded: String = pending.iter().map(|b| windows_1252(*b)).collect();
                pending.clear();
                append_units!(decoded.encode_utf16().collect());
            }
        }};
    }
    macro_rules! emit_text {
        ($text:expr) => {{
            let state = stack.last().expect("group");
            if !state.skip && !state.hidden {
                append_units!($text.encode_utf16().collect());
            }
        }};
    }
    macro_rules! emit_byte {
        ($byte:expr) => {{
            let byte: u8 = $byte;
            if fallback > 0 {
                fallback -= 1;
            } else {
                let state = stack.last().expect("group");
                if !(state.skip || state.hidden) {
                    if byte == 0
                        || byte == 127
                        || [0x81, 0x8d, 0x8f, 0x90, 0x9d].contains(&byte)
                        || (byte < 32 && byte != 9 && byte != 10 && byte != 12 && byte != 13)
                    {
                        return Err(malformed());
                    }
                    let font = fonts.get(&state.font).copied();
                    if !fonts.is_empty() && font.is_none() {
                        return Err(malformed());
                    }
                    let bad = match font {
                        Some(Font { codepage: Some(cp), .. }) => cp != 1252 && byte >= 128,
                        Some(f) => f.charset == 2 || (f.charset != 0 && f.charset != 1 && byte >= 128),
                        None => false,
                    };
                    if bad {
                        return Err(unsupported(
                            "RTF text uses an unsupported font code page. Only Windows-1252 ANSI bytes and explicit Unicode text are converted.",
                        ));
                    }
                    if byte >= 128 {
                        warnings.add("RTF ANSI bytes were decoded as Windows-1252; verify regional text.");
                    }
                    pending.push(byte);
                    if pending.len() == 4096 {
                        flush!();
                    }
                }
            }
        }};
    }

    while position < bytes.len() {
        let byte = bytes[position];
        position += 1;
        if root_closed {
            if !whitespace(byte) {
                return Err(malformed());
            }
            continue;
        }
        if !root_seen && whitespace(byte) {
            continue;
        }
        if byte == b'{' {
            flush!();
            fallback = 0; // A brace ends Unicode fallback scanning before the scope delimiter.
            node!();
            if stack.len() >= limits.max_depth {
                return Err(budget());
            }
            let parent = stack.last().cloned();
            if !root_seen {
                root_seen = true;
            } else if parent.is_none() || !header_seen || parent.as_ref().is_some_and(|p| p.starred) {
                return Err(malformed());
            }
            stack.push(match parent {
                Some(p) => Group { start: true, starred: false, ..p },
                None => Group {
                    skip: false,
                    font_table: false,
                    font_definition: None,
                    font: default_font,
                    unicode_fallback: 1,
                    hidden: false,
                    start: true,
                    starred: false,
                },
            });
            continue;
        }
        if stack.is_empty() {
            return Err(malformed());
        }
        if byte == b'}' {
            flush!();
            fallback = 0;
            if stack.last().expect("group").starred || !header_seen {
                return Err(malformed());
            }
            stack.pop();
            if stack.is_empty() {
                root_closed = true;
            }
            continue;
        }
        if byte == b'\n' || byte == b'\r' {
            continue; // Source wrapping, not document paragraphs.
        }
        if byte != b'\\' {
            let state = stack.last_mut().expect("group");
            if !header_seen || state.starred {
                return Err(malformed());
            }
            state.start = false;
            emit_byte!(byte);
            continue;
        }
        flush!();
        node!();
        controls += 1;
        if controls > limits.max_control_words || position >= bytes.len() {
            if position >= bytes.len() {
                return Err(malformed());
            }
            return Err(budget());
        }
        let next = bytes[position];
        position += 1;
        if !letter(next) {
            if !header_seen {
                return Err(malformed());
            }
            if next == b'\'' {
                if position + 2 > bytes.len() {
                    return Err(malformed());
                }
                let (h, l) = (bytes[position], bytes[position + 1]);
                if !h.is_ascii_hexdigit() || !l.is_ascii_hexdigit() {
                    return Err(malformed());
                }
                position += 2;
                let state = stack.last_mut().expect("group");
                if state.starred {
                    return Err(malformed());
                }
                state.start = false;
                let value = u8::from_str_radix(std::str::from_utf8(&[h, l]).unwrap_or("00"), 16).unwrap_or(0);
                emit_byte!(value);
            } else if fallback > 0 {
                fallback -= 1;
            } else if next == b'*' {
                let state = stack.last_mut().expect("group");
                if !state.start || state.starred {
                    return Err(malformed());
                }
                state.starred = true;
            } else {
                let state = stack.last_mut().expect("group");
                if state.starred {
                    return Err(malformed());
                }
                state.start = false;
                if let Some(s) = symbol(next) {
                    emit_text!(s);
                } else if next != b'\n' && next != b'\r' {
                    warnings.add("Unrecognized RTF controls were ignored; verify the converted text.");
                }
            }
            continue;
        }
        let word_start = position - 1;
        while position < bytes.len() && letter(bytes[position]) {
            position += 1;
        }
        if position - word_start > 32 {
            return Err(budget());
        }
        let word = std::str::from_utf8(&bytes[word_start..position]).unwrap_or("").to_string();
        let mut parameter: Option<i64> = None;
        let mut negative = false;
        if bytes.get(position) == Some(&b'-') {
            negative = true;
            position += 1;
            if !bytes.get(position).is_some_and(|b| digit(*b)) {
                return Err(malformed());
            }
        }
        if bytes.get(position).is_some_and(|b| digit(*b)) {
            let number_start = position;
            while position < bytes.len() && digit(bytes[position]) {
                position += 1;
            }
            if position - number_start > 10 {
                return Err(budget());
            }
            let value: i64 = std::str::from_utf8(&bytes[number_start..position]).unwrap_or("0").parse().unwrap_or(0);
            let value = if negative { -value } else { value };
            if !(-2147483648..=2147483647).contains(&value) {
                return Err(malformed());
            }
            parameter = Some(value);
        }
        if bytes.get(position) == Some(&b' ') {
            position += 1; // Exactly one optional delimiter space.
        }
        if word == "bin" {
            if parameter.is_none_or(|p| p < 0) {
                return Err(malformed());
            }
            return Err(unsupported("Binary RTF payloads are not converted. The original file is unchanged."));
        }
        if fallback > 0 {
            fallback -= 1;
            continue;
        }
        let depth = stack.len();
        let state = stack.last_mut().expect("group");
        if !header_seen {
            if depth != 1 || !state.start || word != "rtf" || parameter.is_none() {
                return Err(malformed());
            }
            if parameter != Some(1) {
                return Err(unsupported("Only RTF version 1 documents are converted."));
            }
            header_seen = true;
            state.start = false;
            continue;
        }
        if word == "rtf" {
            return Err(malformed());
        }
        if !state.skip && (word == "upr" || word == "ud") {
            return Err(unsupported(
                "Alternate RTF Unicode destinations are not converted; use a source with explicit Unicode text runs.",
            ));
        }
        let omitted = OMITTED.contains(&word.as_str());
        if (state.starred && !VISIBLE_DESTINATIONS.contains(&word.as_str())) || (state.start && omitted) {
            if !state.skip {
                warnings.add("RTF metadata and non-body destinations were omitted.");
            }
            state.skip = true;
            if word == "fonttbl" {
                state.font_table = true;
            }
            state.starred = false;
        } else if omitted && !state.skip {
            return Err(malformed());
        }
        state.starred = false;
        state.start = false;

        if state.font_table {
            if word == "f" {
                let Some(p) = parameter.filter(|p| *p >= 0) else { return Err(malformed()) };
                state.font_definition = Some(p);
                fonts.entry(p).or_insert(Font { charset: 0, codepage: None });
            } else if word == "fcharset" || word == "cpg" {
                let Some(p) = parameter.filter(|p| *p >= 0) else { return Err(malformed()) };
                let Some(definition) = state.font_definition else { return Err(malformed()) };
                if (word == "fcharset" && p > 255) || (word == "cpg" && p == 0) {
                    return Err(malformed());
                }
                let font = fonts.get_mut(&definition).expect("font");
                if word == "fcharset" {
                    font.charset = p;
                } else {
                    font.codepage = Some(p);
                }
            }
            continue;
        }
        if state.skip {
            continue;
        }
        if word == "fcharset" {
            return Err(malformed()); // Font charsets belong to font-table entries, not body text.
        }
        if word == "mac" || word == "pc" || word == "pca" {
            return Err(unsupported("Only ANSI/Windows-1252 RTF and explicit Unicode text are converted."));
        }
        if word == "ansicpg" || word == "cpg" {
            let Some(p) = parameter.filter(|p| *p >= 1) else { return Err(malformed()) };
            if p != 1252 {
                return Err(unsupported(
                    "Only Windows-1252 ANSI RTF and explicit Unicode text are converted; this code page is unsupported.",
                ));
            }
        } else if word == "deff" || word == "f" {
            let Some(p) = parameter.filter(|p| *p >= 0) else { return Err(malformed()) };
            if word == "deff" {
                default_font = p;
            }
            state.font = p;
        } else if word == "uc" {
            let Some(p) = parameter.filter(|p| *p >= 0) else { return Err(malformed()) };
            if p as usize > limits.max_input_bytes {
                return Err(budget());
            }
            state.unicode_fallback = p;
        } else if word == "u" {
            let Some(p) = parameter.filter(|p| (-32768..=32767).contains(p)) else { return Err(malformed()) };
            let unit = if p < 0 { p + 65536 } else { p } as u16;
            if unit == 0 || unit == 127 || (unit < 32 && unit != 9 && unit != 10 && unit != 12 && unit != 13) {
                return Err(malformed());
            }
            let skip = state.skip || state.hidden;
            let reset = state.unicode_fallback;
            if !skip {
                append_units!(vec![unit]);
            }
            fallback = reset;
        } else if word == "fromhtml" || word == "htmlrtf" {
            return Err(unsupported("HTML-encapsulated RTF is not converted by this body-text importer."));
        } else if (word == "deleted" || word == "revised") && parameter != Some(0) {
            return Err(unsupported("RTF tracked-change text requires an explicit revision decision and is not converted."));
        } else if word == "v" {
            state.hidden = parameter != Some(0);
            if state.hidden {
                warnings.add("Hidden RTF text was omitted.");
            }
        } else if word == "plain" {
            state.hidden = false;
            state.font = default_font;
        } else if let Some(text) = text_control(&word) {
            if matches!(word.as_str(), "cell" | "nestcell" | "row" | "nestrow") {
                warnings.add("RTF tables were flattened to tabs and newlines; verify cell ordering.");
            }
            emit_text!(text);
        } else if !KNOWN_FORMATTING.contains(&word.as_str()) {
            warnings.add("Unrecognized RTF controls were ignored; verify the converted text.");
        }
    }
    flush!();
    if !root_closed || !stack.is_empty() || !header_seen {
        return Err(malformed());
    }
    // Surrogate pairs may span separate \u controls; lone UTF-16 units are never replaced silently.
    let text = String::from_utf16(&out).map_err(|_| malformed())?;
    Ok(ImportedDocumentText { text, warnings: warnings.0 })
}
