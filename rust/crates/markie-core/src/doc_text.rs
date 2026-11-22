//! Search text for every document type, and global search over the index.
//!
//! A port of `mcp/doc-text.cjs`, the one module Electron's Shift-Command-F
//! search and the MCP `markie_search_documents` tool share. Same formats, same
//! byte ceilings, same extraction rules, same ranking:
//!
//! - rows are searched newest first, so a time-capped search spends its budget
//!   where hits are likeliest;
//! - a row matches when every term is in its name, or every term is in its
//!   path, or every term is in its body (or name);
//! - score is name 4 + body 2 + path 1, ties broken by recency;
//! - an empty query lists the newest rows.
//!
//! Extraction is lossy and read-only. It only has to be honest about the
//! words being present; the office engine decides what a document says.
//!
//! One difference by design: excerpt marks are byte ranges into the excerpt
//! string (GPUI highlights by byte), where JavaScript's are UTF-16 offsets.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use regex::Regex;

use crate::formats::{FormatKind, classify};

pub const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_RTF_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_HTML_BYTES: u64 = 4 * 1024 * 1024;
/// One inflated part (document.xml / content.xml). Bounds a ZIP bomb.
pub const MAX_PART_BYTES: usize = 24 * 1024 * 1024;
/// Characters kept per file.
pub const MAX_TEXT_CHARS: usize = 2 * 1024 * 1024;
/// Characters kept across the whole cache.
pub const CACHE_BUDGET_CHARS: usize = 48 * 1024 * 1024;

/// Format ids in the order Electron lists them (`DOCUMENT_FORMATS`).
pub const DOCUMENT_FORMATS: [FormatKind; 12] = [
    FormatKind::Markdown,
    FormatKind::Darkmown,
    FormatKind::Text,
    FormatKind::Csv,
    FormatKind::Json,
    FormatKind::Yaml,
    FormatKind::Xml,
    FormatKind::Html,
    FormatKind::Docx,
    FormatKind::Odt,
    FormatKind::Rtf,
    FormatKind::Doc,
];

pub fn is_text_format(format: FormatKind) -> bool {
    matches!(
        format,
        FormatKind::Markdown
            | FormatKind::Darkmown
            | FormatKind::Text
            | FormatKind::Csv
            | FormatKind::Json
            | FormatKind::Yaml
            | FormatKind::Xml
    )
}

/// Bytes read from disk at most, per format. Zero means no body search (legacy
/// `.doc`, whose text is only trusted through the real reader).
pub fn byte_limit(format: FormatKind) -> u64 {
    match format {
        f if is_text_format(f) => MAX_TEXT_BYTES,
        FormatKind::Docx | FormatKind::Odt => MAX_PACKAGE_BYTES,
        FormatKind::Rtf => MAX_RTF_BYTES,
        FormatKind::Html => MAX_HTML_BYTES,
        _ => 0,
    }
}

fn truncate_chars(mut s: String, max: usize) -> String {
    if let Some((at, _)) = s.char_indices().nth(max) {
        s.truncate(at);
    }
    s
}

fn decode_entities(text: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&(#x[0-9a-f]+|#\d+|[a-z]+);").unwrap());
    RE.replace_all(text, |c: &regex::Captures| {
        let body = &c[1];
        if let Some(num) = body.strip_prefix('#') {
            let code = match num.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => num.parse::<u32>().ok(),
            };
            return match code.filter(|c| *c > 0 && *c <= 0x10ffff).and_then(char::from_u32) {
                Some(ch) => ch.to_string(),
                None => " ".into(),
            };
        }
        match body.to_ascii_lowercase().as_str() {
            "amp" => "&".into(),
            "lt" => "<".into(),
            "gt" => ">".into(),
            "quot" => "\"".into(),
            "apos" => "'".into(),
            "nbsp" => "\u{a0}".into(),
            _ => c[0].to_string(),
        }
    })
    .into_owned()
}

/// Collapse runs of blanks and blank lines, trim, cap.
pub fn tidy(text: &str) -> String {
    static BLANKS: LazyLock<Regex> = LazyLock::new(|| Regex::new("[ \t\x0c\x0b\u{a0}]+").unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(" *\n[ \n]*").unwrap());
    let a = BLANKS.replace_all(text, " ");
    let b = LINES.replace_all(&a, "\n");
    truncate_chars(b.trim().to_string(), MAX_TEXT_CHARS)
}

fn u16le(b: &[u8], at: usize) -> usize {
    u16::from_le_bytes([b[at], b[at + 1]]) as usize
}
fn u32le(b: &[u8], at: usize) -> usize {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as usize
}

/// One named part of a ZIP package, read through the central directory and
/// inflated with a hard output ceiling.
pub fn zip_part(bytes: &[u8], wanted: &str) -> Option<String> {
    if bytes.len() < 22 {
        return None;
    }
    let floor = bytes.len().saturating_sub(65_557);
    let end = (floor..=bytes.len() - 22).rev().find(|&o| u32le(bytes, o) == 0x0605_4b50)?;
    let count = u16le(bytes, end + 10);
    let mut cursor = u32le(bytes, end + 16);
    for _ in 0..count {
        if cursor + 46 > bytes.len() || u32le(bytes, cursor) != 0x0201_4b50 {
            return None;
        }
        let method = u16le(bytes, cursor + 10);
        let compressed = u32le(bytes, cursor + 20);
        let name_size = u16le(bytes, cursor + 28);
        let extra = u16le(bytes, cursor + 30);
        let comment = u16le(bytes, cursor + 32);
        let local = u32le(bytes, cursor + 42);
        let name = bytes.get(cursor + 46..cursor + 46 + name_size)?;
        cursor += 46 + name_size + extra + comment;
        if name != wanted.as_bytes() {
            continue;
        }
        if local + 30 > bytes.len() || u32le(bytes, local) != 0x0403_4b50 {
            return None;
        }
        let start = local + 30 + u16le(bytes, local + 26) + u16le(bytes, local + 28);
        let data = bytes.get(start..start.checked_add(compressed)?)?;
        return match method {
            0 if data.len() <= MAX_PART_BYTES => Some(String::from_utf8_lossy(data).into_owned()),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, MAX_PART_BYTES)
                .ok()
                .map(|v| String::from_utf8_lossy(&v).into_owned()),
            _ => None,
        };
    }
    None
}

macro_rules! re {
    ($p:expr) => {{
        static R: LazyLock<Regex> = LazyLock::new(|| Regex::new($p).unwrap());
        &*R
    }};
}

pub fn docx_text(xml: &str) -> String {
    let s = re!(r"(?s)<w:instrText\b[^>]*>.*?</w:instrText>").replace_all(xml, "");
    let s = re!(r"(?s)<w:delText\b[^>]*>.*?</w:delText>").replace_all(&s, "");
    let s = re!(r"<w:tab/>").replace_all(&s, " ");
    let s = re!(r"<w:(?:br|cr)\b[^>]*/>").replace_all(&s, "\n");
    let s = re!(r"</w:p>").replace_all(&s, "\n");
    let s = re!(r"<[^>]+>").replace_all(&s, "");
    tidy(&decode_entities(&s))
}

pub fn odt_text(xml: &str) -> String {
    let s = re!(r"(?s)<office:font-face-decls\b.*?</office:font-face-decls>").replace_all(xml, "");
    let s = re!(r"(?s)<office:automatic-styles\b.*?</office:automatic-styles>").replace_all(&s, "");
    let s = re!(r"<text:(?:tab|s)\b[^>]*/>").replace_all(&s, " ");
    let s = re!(r"<text:line-break\b[^>]*/>").replace_all(&s, "\n");
    let s = re!(r"</text:(?:p|h)>").replace_all(&s, "\n");
    let s = re!(r"<[^>]+>").replace_all(&s, "");
    tidy(&decode_entities(&s))
}

pub fn html_text(html: &str) -> String {
    let s = re!(r"(?is)<script\b.*?</script>").replace_all(html, " ");
    let s = re!(r"(?is)<style\b.*?</style>").replace_all(&s, " ");
    let s = re!(r"(?is)<template\b.*?</template>").replace_all(&s, " ");
    let s = re!(r"(?is)<noscript\b.*?</noscript>").replace_all(&s, " ");
    let s = re!(r"(?s)<!--.*?-->").replace_all(&s, " ");
    let s = re!(r"(?i)<(?:br|/p|/div|/li|/h[1-6]|/tr)\b[^>]*>").replace_all(&s, "\n");
    let s = re!(r"<[^>]+>").replace_all(&s, " ");
    tidy(&decode_entities(&s))
}

const RTF_SKIP: &[&str] = &[
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "listtable", "listoverridetable",
    "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "rsidtbl",
    "generator", "header", "footer", "headerl", "headerr", "footerl", "footerr", "object", "fldinst",
];

fn cp1252(code: u32) -> u32 {
    match code {
        0x80 => 0x20ac, 0x82 => 0x201a, 0x83 => 0x192, 0x84 => 0x201e, 0x85 => 0x2026,
        0x86 => 0x2020, 0x87 => 0x2021, 0x88 => 0x2c6, 0x89 => 0x2030, 0x8a => 0x160,
        0x8b => 0x2039, 0x8c => 0x152, 0x8e => 0x17d, 0x91 => 0x2018, 0x92 => 0x2019,
        0x93 => 0x201c, 0x94 => 0x201d, 0x95 => 0x2022, 0x96 => 0x2013, 0x97 => 0x2014,
        0x98 => 0x2dc, 0x99 => 0x2122, 0x9a => 0x161, 0x9b => 0x203a, 0x9c => 0x153,
        0x9e => 0x17e, 0x9f => 0x178, c => c,
    }
}

/// RTF body text from its bytes, read as Latin-1 like Electron does.
pub fn rtf_text(bytes: &[u8]) -> String {
    let src = bytes;
    let mut out = String::new();
    let mut stack: Vec<(bool, usize)> = Vec::new();
    let (mut skip, mut uc, mut pending, mut group_start) = (false, 1usize, 0usize, false);
    let mut i = 0;
    let push = |out: &mut String, code: u32| {
        // JS String.fromCharCode on a lone surrogate keeps it; Rust cannot.
        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
    };
    while i < src.len() {
        let ch = src[i];
        match ch {
            b'{' => {
                stack.push((skip, uc));
                group_start = true;
                i += 1;
                continue;
            }
            b'}' => {
                if let Some((s, u)) = stack.pop() {
                    skip = s;
                    uc = u;
                }
                group_start = false;
                i += 1;
                continue;
            }
            b'\\' => {
                let next = src.get(i + 1).copied();
                match next {
                    Some(b'*') => {
                        skip = true;
                        i += 2;
                        continue;
                    }
                    Some(b'\'') => {
                        let hex = src.get(i + 2..i + 4).and_then(|h| std::str::from_utf8(h).ok());
                        let code = hex.and_then(|h| u32::from_str_radix(h, 16).ok());
                        if pending > 0 {
                            pending -= 1;
                        } else if let (false, Some(c)) = (skip, code) {
                            push(&mut out, cp1252(c));
                        }
                        i += 4;
                        group_start = false;
                        continue;
                    }
                    Some(c @ (b'\\' | b'{' | b'}')) => {
                        if !skip {
                            out.push(c as char);
                        }
                        i += 2;
                        group_start = false;
                        continue;
                    }
                    Some(b'~') => {
                        if !skip {
                            out.push(' ');
                        }
                        i += 2;
                        continue;
                    }
                    Some(b'\n' | b'\r') => {
                        if !skip {
                            out.push('\n');
                        }
                        i += 2;
                        continue;
                    }
                    _ => {}
                }
                // \\word(-?digits)? followed by an optional space.
                let mut j = i + 1;
                while j < src.len() && j - (i + 1) < 32 && src[j].is_ascii_alphabetic() {
                    j += 1;
                }
                if j == i + 1 {
                    i += 2;
                    continue;
                }
                let word = std::str::from_utf8(&src[i + 1..j]).unwrap_or("");
                let mut k = j;
                if k < src.len() && src[k] == b'-' && src.get(k + 1).is_some_and(u8::is_ascii_digit) {
                    k += 1;
                }
                let digits_from = k;
                while k < src.len() && k - digits_from < 10 && src[k].is_ascii_digit() {
                    k += 1;
                }
                let arg: Option<i64> = if k > digits_from {
                    std::str::from_utf8(&src[j..k]).ok().and_then(|s| s.parse().ok())
                } else {
                    None
                };
                if k < src.len() && src[k] == b' ' {
                    k += 1;
                }
                i = k;
                if group_start && RTF_SKIP.contains(&word) {
                    skip = true;
                }
                group_start = false;
                if skip {
                    continue;
                }
                match word {
                    "par" | "line" | "row" | "sect" | "page" => out.push('\n'),
                    "tab" | "cell" => out.push(' '),
                    "uc" => uc = arg.unwrap_or(0).max(0) as usize,
                    "u" => {
                        if let Some(mut code) = arg {
                            if code < 0 {
                                code += 65_536;
                            }
                            push(&mut out, code as u32);
                        }
                        pending = uc;
                    }
                    "bin" => i += arg.unwrap_or(0).max(0) as usize,
                    _ => {}
                }
                continue;
            }
            _ => {}
        }
        group_start = false;
        if ch == b'\r' || ch == b'\n' {
            i += 1;
            continue;
        }
        if pending > 0 {
            pending -= 1;
            i += 1;
            continue;
        }
        if !skip {
            out.push(ch as char); // Latin-1: byte value is the code point
        }
        i += 1;
    }
    tidy(&out)
}

/// Text formats: UTF-16 by BOM, else UTF-8 (BOM dropped). NUL means binary.
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    let utf16 = |body: &[u8], le: bool| {
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if bytes.starts_with(&[0xff, 0xfe]) {
        return Some(utf16(&bytes[2..], true));
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return Some(utf16(&bytes[2..], false));
    }
    let text = String::from_utf8_lossy(bytes);
    if text.contains('\0') {
        return None;
    }
    Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// Readable text from document bytes, or None when the format has none.
pub fn text_from_bytes(bytes: &[u8], format: FormatKind) -> Option<String> {
    if is_text_format(format) {
        return decode_text(bytes).map(|t| truncate_chars(t, MAX_TEXT_CHARS));
    }
    match format {
        FormatKind::Docx => zip_part(bytes, "word/document.xml").map(|x| docx_text(&x)),
        FormatKind::Odt => zip_part(bytes, "content.xml").map(|x| odt_text(&x)),
        FormatKind::Rtf => Some(rtf_text(bytes)),
        FormatKind::Html => Some(html_text(&String::from_utf8_lossy(bytes))),
        _ => None,
    }
}

/// Extracted text keyed by path and (mtime, size), evicted oldest first once
/// the character budget is spent.
pub struct TextCache {
    budget: usize,
    used: usize,
    entries: HashMap<PathBuf, (String, Option<std::sync::Arc<str>>, usize)>,
    order: VecDeque<PathBuf>,
}

impl TextCache {
    pub fn new(budget: usize) -> Self {
        Self { budget, used: 0, entries: HashMap::new(), order: VecDeque::new() }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn used(&self) -> usize {
        self.used
    }

    fn touch(&mut self, key: &Path) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(pos).unwrap();
            self.order.push_back(k);
        }
    }

    pub fn get(&mut self, key: &Path, stamp: &str) -> Option<Option<std::sync::Arc<str>>> {
        let hit = self.entries.get(key)?;
        if hit.0 != stamp {
            return None;
        }
        let text = hit.1.clone();
        self.touch(key);
        Some(text)
    }

    pub fn set(&mut self, key: &Path, stamp: String, text: Option<std::sync::Arc<str>>) {
        if let Some(prior) = self.entries.remove(key) {
            self.used -= prior.2;
            self.order.retain(|k| k != key);
        }
        let size = text.as_ref().map_or(0, |t| t.chars().count());
        self.entries.insert(key.to_path_buf(), (stamp, text, size));
        self.order.push_back(key.to_path_buf());
        self.used += size;
        while self.used > self.budget {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(v) = self.entries.remove(&oldest) {
                self.used -= v.2;
            }
        }
    }
}

impl Default for TextCache {
    fn default() -> Self {
        Self::new(CACHE_BUDGET_CHARS)
    }
}

/// The process-wide cache global search uses.
pub static SHARED_CACHE: LazyLock<Mutex<TextCache>> = LazyLock::new(|| Mutex::new(TextCache::default()));

fn stat_stamp(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    format!("{mtime}:{}", meta.len())
}

/// A file's search text, extracted once per (mtime, size).
pub fn extract_search_text(path: &Path, format: FormatKind, cache: &Mutex<TextCache>) -> Option<std::sync::Arc<str>> {
    let limit = byte_limit(format);
    if limit == 0 {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    let stamp = stat_stamp(&meta);
    if let Some(hit) = cache.lock().ok()?.get(path, &stamp) {
        return hit;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    let text = std::fs::File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .ok()
        .and_then(|_| text_from_bytes(&bytes, format))
        .map(std::sync::Arc::<str>::from);
    if let Ok(mut c) = cache.lock() {
        c.set(path, stamp, text.clone());
    }
    text
}

/// Lowercased query terms, at most eight.
pub fn terms(query: &str) -> Vec<String> {
    query.to_lowercase().split_whitespace().take(8).map(str::to_string).collect()
}

/// Lowercase that keeps byte offsets valid for the original: full Unicode
/// lowercase when it keeps the length, ASCII-only otherwise.
fn lower_same_len(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.len() == text.len() { lower } else { text.to_ascii_lowercase() }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Excerpt {
    pub text: String,
    /// Byte ranges into `text`, sorted, at most twelve.
    pub marks: Vec<(usize, usize)>,
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// A window of about `radius` characters either side of the first hit.
pub fn excerpt(text: &str, needles: &[String], radius: usize) -> Option<Excerpt> {
    let lower = lower_same_len(text);
    let (at, len) = needles
        .iter()
        .filter_map(|n| lower.find(n.as_str()).map(|i| (i, n.len())))
        .min_by_key(|(i, _)| *i)?;
    let start = text[..at].char_indices().rev().nth(radius.saturating_sub(1)).map_or(0, |(i, _)| i);
    let tail = &text[at + len..];
    let end = tail.char_indices().nth(radius).map_or(text.len(), |(i, _)| at + len + i);
    let end = floor_char(text, end);
    let raw = re!(r"\s+").replace_all(&text[start..end], " ");
    let mut window = String::new();
    if start > 0 {
        window.push('…');
    }
    window.push_str(raw.trim());
    if end < text.len() {
        window.push('…');
    }
    let lw = lower_same_len(&window);
    let mut marks = Vec::new();
    for needle in needles {
        let mut from = 0;
        while marks.len() < 12 {
            let Some(i) = lw[from..].find(needle.as_str()).map(|i| i + from) else { break };
            marks.push((i, i + needle.len()));
            from = i + needle.len();
        }
    }
    marks.sort();
    Some(Excerpt { text: window, marks })
}

/// A document global search can look at.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchRow {
    pub path: PathBuf,
    pub name: String,
    pub dir: PathBuf,
    pub format: FormatKind,
    pub mtime_ms: f64,
}

impl SearchRow {
    pub fn from_path(path: &Path) -> Option<Self> {
        let name = path.file_name()?.to_string_lossy().into_owned();
        let format = classify(&name);
        if format == FormatKind::Unsupported {
            return None;
        }
        let meta = std::fs::metadata(path).ok()?;
        Some(Self {
            dir: path.parent().map(Path::to_path_buf).unwrap_or_default(),
            mtime_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0),
            path: path.to_path_buf(),
            name,
            format,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub path: PathBuf,
    pub name: String,
    pub dir: PathBuf,
    pub format: FormatKind,
    pub mtime_ms: f64,
    pub name_hit: bool,
    pub excerpt: Option<Excerpt>,
    score: u8,
}

impl SearchHit {
    /// A hit with an excerpt, for tests in other crates.
    pub fn for_test(path: &str, format: FormatKind, excerpt: &str) -> Self {
        let p = PathBuf::from(path);
        Self {
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            dir: p.parent().map(Path::to_path_buf).unwrap_or_default(),
            path: p,
            format,
            mtime_ms: 0.0,
            name_hit: false,
            excerpt: Some(Excerpt { text: excerpt.into(), marks: Vec::new() }),
            score: 0,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub scanned: usize,
    pub total: usize,
    pub partial: bool,
    pub superseded: bool,
}

#[derive(Clone, Debug)]
pub struct SearchOptions {
    /// Empty means every format.
    pub formats: Vec<FormatKind>,
    pub limit: usize,
    pub max_time: Duration,
    /// When set, a newer search (a bigger value in `GENERATION`) stops this one.
    pub supersede: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self { formats: Vec::new(), limit: 60, max_time: Duration::from_millis(1800), supersede: true }
    }
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Electron's `doc-search` input clamps: query at 200 characters, limit 1 to 200.
pub fn clamp_request(query: &str, limit: Option<usize>) -> (String, usize) {
    (query.chars().take(200).collect(), limit.map_or(60, |l| l.clamp(1, 200)))
}

/// Index rows plus recent files the walk did not reach, deduplicated by path,
/// the way Electron's `doc-search` handler builds its pool.
pub fn search_pool(index: &[crate::index::IndexedDoc], recent: &[PathBuf]) -> Vec<SearchRow> {
    let mut seen: std::collections::HashSet<&Path> = std::collections::HashSet::with_capacity(index.len());
    let mut rows: Vec<SearchRow> = Vec::with_capacity(index.len() + recent.len());
    for d in index {
        if seen.insert(d.path.as_path()) {
            rows.push(SearchRow {
                path: d.path.clone(),
                name: d.name.clone(),
                dir: d.dir.clone(),
                format: d.format,
                mtime_ms: d.mtime_ms,
            });
        }
    }
    for p in recent {
        if !seen.contains(p.as_path())
            && let Some(row) = SearchRow::from_path(p)
        {
            seen.insert(p.as_path());
            rows.push(row);
        }
    }
    rows
}

/// Search rows by name, path and extracted body text. See the module docs.
pub fn search_documents(rows: &[SearchRow], query: &str, opts: &SearchOptions, cache: &Mutex<TextCache>) -> SearchResponse {
    let mine = if opts.supersede { Some(GENERATION.fetch_add(1, Ordering::SeqCst) + 1) } else { None };
    let needles = terms(query);
    let mut pool: Vec<&SearchRow> = rows
        .iter()
        .filter(|r| opts.formats.is_empty() || opts.formats.contains(&r.format))
        .collect();
    pool.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal));
    let total = pool.len();
    let hit = |r: &SearchRow, name_hit, excerpt, score| SearchHit {
        path: r.path.clone(),
        name: r.name.clone(),
        dir: r.dir.clone(),
        format: r.format,
        mtime_ms: r.mtime_ms,
        name_hit,
        excerpt,
        score,
    };
    if needles.is_empty() {
        return SearchResponse {
            results: pool.iter().take(opts.limit).map(|r| hit(r, false, None, 0)).collect(),
            total,
            ..Default::default()
        };
    }
    let started = Instant::now();
    let mut results = Vec::new();
    let (mut scanned, mut partial) = (0, false);
    for row in pool {
        if let Some(g) = mine
            && g != GENERATION.load(Ordering::SeqCst)
        {
            return SearchResponse { superseded: true, scanned, total, partial: true, results: Vec::new() };
        }
        let name = row.name.to_lowercase();
        let path = row.path.to_string_lossy().to_lowercase();
        let name_hit = needles.iter().all(|n| name.contains(n.as_str()));
        let path_hit = needles.iter().all(|n| path.contains(n.as_str()));
        let mut body = None;
        let mut body_hit = false;
        if !partial && byte_limit(row.format) > 0 {
            if started.elapsed() > opts.max_time {
                partial = true;
            } else {
                body = extract_search_text(&row.path, row.format, cache);
                scanned += 1;
                if let Some(b) = &body {
                    let lower = b.to_lowercase();
                    body_hit = needles.iter().all(|n| lower.contains(n.as_str()) || name.contains(n.as_str()));
                }
            }
        }
        if !name_hit && !path_hit && !body_hit {
            continue;
        }
        let ex = if body_hit { body.as_deref().and_then(|b| excerpt(b, &needles, 70)) } else { None };
        let score = if name_hit { 4 } else { 0 } + if body_hit { 2 } else { 0 } + u8::from(path_hit);
        results.push(hit(row, name_hit, ex, score));
        if results.len() >= opts.limit * 3 {
            partial = true;
            break;
        }
    }
    results.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal))
    });
    results.truncate(opts.limit);
    SearchResponse { results, scanned, total, partial, superseded: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_zip(name: &str, body: &[u8]) -> Vec<u8> {
        let mut z = Vec::new();
        let n = name.as_bytes();
        z.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        z.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        z.extend_from_slice(&(body.len() as u32).to_le_bytes());
        z.extend_from_slice(&(body.len() as u32).to_le_bytes());
        z.extend_from_slice(&(n.len() as u16).to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(n);
        z.extend_from_slice(body);
        let cd = z.len();
        z.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        z.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        z.extend_from_slice(&(body.len() as u32).to_le_bytes());
        z.extend_from_slice(&(body.len() as u32).to_le_bytes());
        z.extend_from_slice(&(n.len() as u16).to_le_bytes());
        z.extend_from_slice(&[0; 12]);
        z.extend_from_slice(&0u32.to_le_bytes());
        z.extend_from_slice(n);
        let cd_size = z.len() - cd;
        z.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        z.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0]);
        z.extend_from_slice(&(cd_size as u32).to_le_bytes());
        z.extend_from_slice(&(cd as u32).to_le_bytes());
        z.extend_from_slice(&[0, 0]);
        z
    }

    #[test]
    fn docx_text_skips_fields_and_deletions() {
        let xml = r#"<w:body><w:p><w:r><w:t>Quarterly</w:t></w:r><w:r><w:tab/><w:t>report &amp; plan</w:t></w:r></w:p><w:p><w:r><w:instrText>PAGE</w:instrText><w:delText>gone</w:delText><w:t>Second</w:t><w:br/><w:t>line</w:t></w:r></w:p></w:body>"#;
        assert_eq!(docx_text(xml), "Quarterly report & plan\nSecond\nline");
        let zip = stored_zip("word/document.xml", xml.as_bytes());
        assert_eq!(text_from_bytes(&zip, FormatKind::Docx).unwrap(), "Quarterly report & plan\nSecond\nline");
    }

    #[test]
    fn deflated_zip_parts_inflate() {
        let xml = b"<office:document-content><office:automatic-styles><s>skip</s></office:automatic-styles><text:h>Title</text:h><text:p>a<text:s/>b<text:line-break/>c</text:p></office:document-content>";
        let deflated = miniz_oxide::deflate::compress_to_vec(xml, 6);
        let mut zip = stored_zip("content.xml", &deflated);
        zip[8] = 8; // local header method
        let cd = zip.windows(4).position(|w| w == 0x0201_4b50u32.to_le_bytes()).unwrap();
        zip[cd + 10] = 8;
        assert_eq!(text_from_bytes(&zip, FormatKind::Odt).unwrap(), "Title\na b\nc");
        assert!(zip_part(&zip, "missing.xml").is_none());
        assert!(zip_part(b"short", "x").is_none());
    }

    #[test]
    fn html_text_drops_script_style_and_comments() {
        let html = "<html><head><style>p{}</style><script>var x</script></head><body><h1>Hi</h1><!-- note --><p>caf&eacute; &#x41;&#66;</p></body></html>";
        assert_eq!(html_text(html), "Hi\ncaf&eacute; AB");
    }

    #[test]
    fn rtf_text_reads_body_and_skips_tables() {
        let rtf = br"{\rtf1\ansi{\fonttbl{\f0 Times;}}{\colortbl;\red0\green0\blue0;}{\*\generator Word;}\f0 Hello \b world\b0\par Caf\'e9 \u8364?  costs\tab 5\'80\par}";
        assert_eq!(rtf_text(rtf), "Hello world\nCafé € costs 5€");
    }

    #[test]
    fn decode_text_handles_boms_and_binary() {
        assert_eq!(decode_text(b"\xef\xbb\xbfhi").unwrap(), "hi");
        assert_eq!(decode_text(&[0xff, 0xfe, b'h', 0, b'i', 0]).unwrap(), "hi");
        assert_eq!(decode_text(&[0xfe, 0xff, 0, b'h', 0, b'i']).unwrap(), "hi");
        assert!(decode_text(b"a\0b").is_none());
        assert!(text_from_bytes(b"x", FormatKind::Doc).is_none());
    }

    #[test]
    fn excerpt_windows_and_marks() {
        let text = format!("{} needle here {}", "a ".repeat(60), "b ".repeat(60));
        let ex = excerpt(&text, &["needle".into()], 70).unwrap();
        assert!(ex.text.starts_with('…') && ex.text.ends_with('…'));
        let (s, e) = ex.marks[0];
        assert_eq!(&ex.text[s..e], "needle");
        let short = excerpt("The Needle", &["needle".into()], 70).unwrap();
        assert_eq!(short.text, "The Needle");
        assert_eq!(short.marks, vec![(4, 10)]);
        assert!(excerpt("none", &["x".into()], 70).is_none());
    }

    #[test]
    fn cache_evicts_oldest_over_budget() {
        let mut c = TextCache::new(10);
        c.set(Path::new("/a"), "1".into(), Some("123456".into()));
        c.set(Path::new("/b"), "1".into(), Some("123456".into()));
        assert_eq!(c.len(), 1);
        assert!(c.get(Path::new("/a"), "1").is_none());
        assert!(c.get(Path::new("/b"), "2").is_none(), "stale stamp misses");
        assert_eq!(c.get(Path::new("/b"), "1").unwrap().as_deref(), Some("123456"));
    }

    #[test]
    fn ranks_name_body_path_like_electron() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let write = |n: &str, b: &[u8]| {
            std::fs::write(d.join(n), b).unwrap();
            SearchRow::from_path(&d.join(n)).unwrap()
        };
        let mut a = write("budget.md", b"nothing");
        let mut b = write("notes.md", b"the budget for q3");
        let mut c = write("letter.docx", &stored_zip("word/document.xml", b"<w:p><w:t>budget draft</w:t></w:p>"));
        let mut r = write("memo.rtf", br"{\rtf1 The budget\par}");
        let mut x = write("other.txt", b"unrelated");
        a.mtime_ms = 1.0;
        b.mtime_ms = 5.0;
        c.mtime_ms = 3.0;
        r.mtime_ms = 4.0;
        x.mtime_ms = 9.0;
        let rows = vec![a, b, c, r, x];
        let cache = Mutex::new(TextCache::default());
        let opts = SearchOptions { supersede: false, ..Default::default() };
        let res = search_documents(&rows, "budget", &opts, &cache);
        let names: Vec<_> = res.results.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["budget.md", "notes.md", "memo.rtf", "letter.docx"]);
        assert!(res.results[0].name_hit);
        assert!(res.results[1].excerpt.as_ref().unwrap().text.contains("budget"));
        assert_eq!(res.scanned, 5);
        let only_word = SearchOptions { formats: vec![FormatKind::Docx], ..opts.clone() };
        let res = search_documents(&rows, "budget", &only_word, &cache);
        assert_eq!(res.results.len(), 1);
        assert_eq!(res.total, 1);
        let empty = search_documents(&rows, "  ", &opts, &cache);
        assert_eq!(empty.results[0].name, "other.txt", "empty query is newest first");
        assert!(cache.lock().unwrap().len() >= 5);
        // Every term must match somewhere in one field.
        let res = search_documents(&rows, "budget q3", &opts, &cache);
        assert_eq!(res.results.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), vec!["notes.md"]);
    }

    #[test]
    fn pool_merges_recents_outside_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("far.md");
        std::fs::write(&p, "x").unwrap();
        let rows = search_pool(&[], &[p.clone(), p.clone(), dir.path().join("gone.md")]);
        assert_eq!(rows.len(), 1);
        assert_eq!(clamp_request(&"q".repeat(300), Some(999)), ("q".repeat(200), 200));
    }
}
