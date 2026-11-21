//! Original Word 97 to 2003 main-story text extraction, not a DOC editor or writer.
//! Public [MS-DOC] specification provenance:
//! 2.5.1 Fib: <https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/9aeaa2e7-4a45-468e-ab13-3f6193eb9394>
//! 2.4.1 Retrieving Text: <https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/01d5d8c4-cf9c-4ef9-80fd-439e763cfe01>
//! Ported from `legacy-doc.ts`, `legacy-doc-write.ts` and `legacy-doc-worker-client.ts`.

use crate::cfb::{CfbError, CfbErrorCode, CfbLimits, CfbWriteStream, DEFAULT_CFB_LIMITS, fail, read_compound_file};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use CfbErrorCode::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacyDocLimits {
    pub cfb: CfbLimits,
    pub max_text_code_units: usize,
    pub max_pieces: usize,
    pub max_clx_bytes: usize,
    pub max_property_records: usize,
}

pub const DEFAULT_LEGACY_DOC_LIMITS: LegacyDocLimits = LegacyDocLimits {
    cfb: DEFAULT_CFB_LIMITS,
    max_text_code_units: 8 * 1024 * 1024,
    max_pieces: 100_000,
    max_clx_bytes: 4 * 1024 * 1024,
    max_property_records: 10_000,
};

impl Default for LegacyDocLimits {
    fn default() -> Self {
        DEFAULT_LEGACY_DOC_LIMITS
    }
}

pub const TEXT_EXTRACTION_WARNINGS: [&str; 2] = [
    "Text extraction only: formatting, revisions, fields, drawings, and embedded objects are not interpreted; no DOC writing is available.",
    "Only the main story is returned; headers, footnotes, comments, endnotes, and text boxes are omitted. Raw Word control characters are retained in rawText.",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyDocText {
    /// Main-story characters in CP order, with Word paragraph CR normalized to LF.
    /// Unpaired UTF-16 surrogates become U+FFFD here (a Rust string cannot hold them).
    pub text: String,
    /// Main-story UTF-16 code units, retaining Word control characters and lone surrogates.
    pub raw_text: Vec<u16>,
    pub warnings: Vec<String>,
}

impl LegacyDocText {
    pub fn raw_text_lossy(&self) -> String {
        String::from_utf16_lossy(&self.raw_text)
    }
}

// [MS-DOC] 2.9.73 FcCompressed specifies this exact mapping, not an arbitrary ANSI codepage.
fn compressed_unicode(unit: u8) -> u16 {
    match unit {
        0x82 => 0x201a,
        0x83 => 0x0192,
        0x84 => 0x201e,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02c6,
        0x89 => 0x2030,
        0x8a => 0x0160,
        0x8b => 0x2039,
        0x8c => 0x0152,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201c,
        0x94 => 0x201d,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02dc,
        0x99 => 0x2122,
        0x9a => 0x0161,
        0x9b => 0x203a,
        0x9c => 0x0153,
        0x9f => 0x0178,
        other => other as u16,
    }
}

fn pair_count(version: u16) -> Option<(usize, usize)> {
    match version {
        0xc1 => Some((0x5d, 0)),
        0xd9 => Some((0x6c, 2)),
        0x101 => Some((0x88, 2)),
        0x10c => Some((0xa4, 2)),
        _ => None,
    }
}

fn checked<'a>(bytes: &'a [u8], at: usize, length: usize, label: &str) -> Result<&'a [u8], CfbError> {
    if at > bytes.len() || length > bytes.len() - at {
        return Err(CfbError { code: Malformed, message: format!("Truncated or out-of-range {label}.") });
    }
    Ok(&bytes[at..at + length])
}
fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn i32le(b: &[u8], at: usize) -> i32 {
    u32le(b, at) as i32
}

pub fn extract_legacy_doc_text(input: &[u8], limits: LegacyDocLimits) -> Result<LegacyDocText, CfbError> {
    if [limits.max_text_code_units, limits.max_pieces, limits.max_clx_bytes, limits.max_property_records]
        .iter()
        .any(|v| *v > (1usize << 53) - 1)
    {
        return fail(LimitExceeded, "DOC limits must be nonnegative safe integers.");
    }
    let mut file = read_compound_file(input, limits.cfb)?;
    if file.root_stream_names().iter().any(|n| n == "EncryptedPackage" || n == "EncryptionInfo") {
        return fail(Encrypted, "Encrypted Office packages are not supported.");
    }
    let bytes = file.read_root_stream("WordDocument")?;
    let base = checked(&bytes, 0, 32, "FIB base")?;
    // [MS-DOC] 2.5.2 FibBase: signature, encryption bit 8, table-selection bit 9.
    if u16le(base, 0) != 0xa5ec {
        return fail(Unsupported, "The WordDocument stream is not a supported Word binary file.");
    }
    let base_version = u16le(base, 2);
    let flags = u16le(base, 10);
    if flags & 0x100 != 0 {
        return fail(Encrypted, "Encrypted or XOR-obfuscated DOC files are not supported.");
    }
    if pair_count(base_version).is_none() {
        return fail(
            Unsupported,
            "Only Word 97, 2000, 2002, and 2003 binary FIB versions are supported; Word 6/95 is not supported.",
        );
    }
    let mut cursor = 32usize;
    let mut read_counted = |width: usize, label: &str| -> Result<(usize, &[u8]), CfbError> {
        let count = u16le(checked(&bytes, cursor, 2, label)?, 0) as usize;
        cursor += 2;
        let data = checked(&bytes, cursor, count * width, label)?;
        cursor += count * width;
        Ok((count, data))
    };
    // [MS-DOC] 2.5.15: advance by the counted sections, never fixed file offsets.
    let words = read_counted(2, "FibRgW97")?;
    let longs = read_counted(4, "FibRgLw97")?;
    let pairs = read_counted(8, "FibRgFcLcb")?;
    let extension = read_counted(2, "FibRgCswNew")?;
    if words.0 != 14 || longs.0 != 22 {
        return fail(Malformed, "Invalid Word 97+ FIB section counts.");
    }
    let version = if extension.0 > 0 { u16le(extension.1, 0) } else { base_version };
    let Some((expected_pairs, expected_extension)) = pair_count(version) else {
        return fail(Unsupported, "The extended DOC FIB version is outside the supported Word 97–2003 scope.");
    };
    if pairs.0 != expected_pairs || extension.0 != expected_extension {
        return fail(Malformed, "FIB counts do not match the declared DOC version.");
    }
    // [MS-DOC] 2.5.4 FibRgLw97: cbMac at index 0, ccpText at index 3.
    let cb_mac = u32le(longs.1, 0) as usize;
    let ccp_text = i32le(longs.1, 12);
    if cb_mac < cursor || cb_mac > bytes.len() || ccp_text < 0 {
        return fail(Malformed, "Invalid WordDocument byte or character extent.");
    }
    let ccp_text = ccp_text as usize;
    if ccp_text > limits.max_text_code_units {
        return fail(LimitExceeded, "Main-story text exceeds the character budget.");
    }
    let sub_counts: Vec<i32> = [4, 5, 7, 8, 9, 10].iter().map(|i| i32le(longs.1, i * 4)).collect();
    if sub_counts.iter().any(|v| *v < 0) {
        return fail(Malformed, "Negative subdocument character count.");
    }
    let sub_count: u64 = sub_counts.iter().map(|v| *v as u64).sum();
    let final_cp = ccp_text as u64 + sub_count + u64::from(sub_count > 0);
    if final_cp > 0x7fff_ffff {
        return fail(Malformed, "Invalid combined character extent.");
    }
    // [MS-DOC] 2.5.6: fcClx/lcbClx are the 34th fc/lcb pair (zero-based 33).
    let fc_clx = u32le(pairs.1, 33 * 8) as usize;
    let lcb_clx = u32le(pairs.1, 33 * 8 + 4) as usize;
    if lcb_clx == 0 {
        return fail(Unsupported, "A CLX piece table is required by this text extractor.");
    }
    if lcb_clx > limits.max_clx_bytes {
        return fail(LimitExceeded, "CLX exceeds the byte budget.");
    }
    let table = match file.read_root_stream(if flags & 0x200 != 0 { "1Table" } else { "0Table" }) {
        Ok(table) => table,
        Err(e) if e.code == Unsupported => return fail(Malformed, "The FIB-selected Table stream is missing."),
        Err(e) => return Err(e),
    };
    let clx = checked(&table, fc_clx, lcb_clx, "CLX")?;
    let (mut at, mut property_records) = (0usize, 0usize);
    // [MS-DOC] 2.9.38/209/210: zero or more 0x01 Prc records precede 0x02 Pcdt.
    while at < clx.len() && clx[at] == 1 {
        property_records += 1;
        if property_records > limits.max_property_records {
            return fail(LimitExceeded, "CLX exceeds the property-record budget.");
        }
        if clx.len() < 3 || at > clx.len() - 3 {
            return fail(Malformed, "Truncated CLX property record.");
        }
        let length = u16le(clx, at + 1) as i16;
        if !(0..=0x3fa2).contains(&length) || length as usize > clx.len() - at - 3 {
            return fail(Malformed, "Invalid CLX property record length.");
        }
        at += 3 + length as usize;
    }
    if clx.len() < 5 || at > clx.len() - 5 || clx[at] != 2 {
        return fail(Malformed, "CLX does not contain a valid piece table.");
    }
    let plc_length = u32le(clx, at + 1) as usize;
    at += 5;
    // [MS-DOC] 2.8.35/2.9.178: n+1 four-byte CPs followed by n eight-byte Pcds.
    if plc_length < 4 || !(plc_length - 4).is_multiple_of(12) || plc_length != clx.len() - at {
        return fail(Malformed, "Invalid piece-table byte count.");
    }
    let piece_count = (plc_length - 4) / 12;
    if piece_count > limits.max_pieces {
        return fail(LimitExceeded, "Piece table exceeds the piece budget.");
    }
    let mut cps: Vec<i64> = Vec::with_capacity(piece_count + 1);
    for i in 0..=piece_count {
        let cp = i32le(clx, at + i * 4) as i64;
        if cp < 0 || (i == 0 && cp != 0) || (i > 0 && cp <= cps[i - 1]) {
            return fail(Malformed, "Piece-table character positions are invalid or not strictly increasing.");
        }
        cps.push(cp);
    }
    if cps[piece_count] as u64 != final_cp {
        return fail(Malformed, "Piece table does not cover the declared document stories.");
    }
    let pcd_start = at + (piece_count + 1) * 4;
    let mut raw: Vec<u16> = Vec::with_capacity(ccp_text);
    for i in 0..piece_count {
        // [MS-DOC] 2.9.177: FcCompressed begins two bytes into each Pcd.
        let fc = u32le(clx, pcd_start + i * 8 + 2);
        let compressed = fc & 0x4000_0000 != 0;
        let encoded_offset = (fc & 0x3fff_ffff) as i64;
        if compressed && encoded_offset % 2 != 0 {
            return fail(Malformed, "Compressed text has a fractional byte offset.");
        }
        let offset = if compressed { encoded_offset / 2 } else { encoded_offset };
        let width = if compressed { 1 } else { 2 };
        let full_length = (cps[i + 1] - cps[i]) * width;
        if offset < cursor as i64 || offset > cb_mac as i64 - full_length {
            return fail(Malformed, "Piece text falls outside the meaningful WordDocument data.");
        }
        let offset = offset as usize;
        let length = (cps[i + 1].min(ccp_text as i64) - cps[i]).max(0) as usize;
        for j in 0..length {
            raw.push(if compressed {
                compressed_unicode(bytes[offset + j])
            } else {
                bytes[offset + j * 2] as u16 + bytes[offset + j * 2 + 1] as u16 * 256
            });
        }
    }
    if raw.len() != ccp_text {
        return fail(Malformed, "Main-story character coverage mismatch.");
    }
    let text = String::from_utf16_lossy(&raw).replace('\r', "\n");
    Ok(LegacyDocText { text, raw_text: raw, warnings: TEXT_EXTRACTION_WARNINGS.iter().map(|s| s.to_string()).collect() })
}

/// The import path's input limit (the TypeScript worker passes the same value).
pub const LEGACY_DOC_MAX_INPUT: usize = 32 * 1024 * 1024;
const MAX_TEXT: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyDocImportError {
    /// The DOC itself could not be read (malformed, unsupported, encrypted, over budget).
    Doc(CfbError),
    /// The caller canceled the import (the TypeScript `AbortError`).
    Canceled,
    /// The import itself failed: too large, timed out, invalid limit or reader failure.
    Import(String),
}

impl std::fmt::Display for LegacyDocImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Doc(e) => write!(f, "{}", e.message),
            Self::Canceled => write!(f, "DOC import canceled."),
            Self::Import(m) => write!(f, "{m}"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DocImportOptions {
    /// Defaults to 5 seconds; 1 ms to 30 s is allowed.
    pub timeout: Duration,
    pub cancel: Option<Arc<AtomicBool>>,
}

impl Default for DocImportOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_millis(5000), cancel: None }
    }
}

/// Runs extraction on its own thread with the TypeScript worker's limits:
/// 32 MiB of input and a 5 second budget.
pub fn extract_legacy_doc_text_off_thread(bytes: &[u8], options: DocImportOptions) -> Result<LegacyDocText, LegacyDocImportError> {
    run_legacy_doc_reader_off_thread(bytes, options, |owned| {
        let limits = LegacyDocLimits { cfb: CfbLimits { max_input_bytes: LEGACY_DOC_MAX_INPUT, ..DEFAULT_CFB_LIMITS }, ..DEFAULT_LEGACY_DOC_LIMITS };
        extract_legacy_doc_text(&owned, limits)
    })
}

/// One disposable reader thread per import, handed an owned copy of the bytes.
///
/// A Rust thread cannot be killed the way a Web Worker is terminated. On
/// timeout or cancel the caller gets the error at once, the thread is detached
/// and its late result is dropped. Every structure the real reader walks is
/// budgeted, so it ends on its own.
pub fn run_legacy_doc_reader_off_thread<F>(bytes: &[u8], options: DocImportOptions, reader: F) -> Result<LegacyDocText, LegacyDocImportError>
where
    F: FnOnce(Vec<u8>) -> Result<LegacyDocText, CfbError> + Send + 'static,
{
    let canceled = || options.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst));
    if canceled() {
        return Err(LegacyDocImportError::Canceled);
    }
    if bytes.len() > LEGACY_DOC_MAX_INPUT {
        return Err(LegacyDocImportError::Import("Legacy DOC exceeds the 32 MiB import limit.".into()));
    }
    if options.timeout < Duration::from_millis(1) || options.timeout > Duration::from_millis(30_000) {
        return Err(LegacyDocImportError::Import("Invalid DOC import time limit.".into()));
    }
    let owned = bytes.to_vec();
    let (sender, receiver) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("markie-doc-import".into()).spawn(move || {
        let _ = sender.send(reader(owned));
    });
    if spawned.is_err() {
        return Err(LegacyDocImportError::Import(
            "A local document worker is unavailable. This DOC was not opened or uploaded.".into(),
        ));
    }
    let deadline = Instant::now() + options.timeout;
    loop {
        if canceled() {
            return Err(LegacyDocImportError::Canceled);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(LegacyDocImportError::Import(
                "DOC import exceeded its time budget. The local reader was stopped; the original is unchanged.".into(),
            ));
        }
        match receiver.recv_timeout((deadline - now).min(Duration::from_millis(10))) {
            Ok(Ok(result)) => {
                let valid = utf16_units(&result.text) <= MAX_TEXT
                    && result.raw_text.len() <= MAX_TEXT
                    && result.warnings.len() <= 100
                    && result.warnings.iter().all(|w| utf16_units(w) <= 4096);
                if !valid {
                    return Err(LegacyDocImportError::Import("The local DOC reader returned an invalid result.".into()));
                }
                return Ok(result);
            }
            Ok(Err(error)) => {
                if utf16_units(&error.message) > 4096 {
                    return Err(LegacyDocImportError::Import("The local DOC reader returned an invalid result.".into()));
                }
                return Err(LegacyDocImportError::Doc(error));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(LegacyDocImportError::Import(
                    "The local DOC reader failed. Your open document and original file are unchanged.".into(),
                ));
            }
        }
    }
}

fn utf16_units(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacyDocPlainStoryLimits {
    pub max_text_code_units: usize,
    pub max_pieces: usize,
    pub max_clx_bytes: usize,
    pub max_stream_bytes: usize,
    pub max_total_stream_bytes: usize,
}

impl Default for LegacyDocPlainStoryLimits {
    fn default() -> Self {
        let d = DEFAULT_LEGACY_DOC_LIMITS;
        Self {
            max_text_code_units: d.max_text_code_units,
            max_pieces: d.max_pieces,
            max_clx_bytes: d.max_clx_bytes,
            max_stream_bytes: d.cfb.max_stream_bytes,
            max_total_stream_bytes: d.cfb.max_total_stream_bytes,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyDocPlainStoryFoundation {
    /// Required DOC structures are missing; these are components, not a DOC file.
    pub missing_structures: [&'static str; 3],
    pub streams: Vec<CfbWriteStream>,
    pub character_count: usize,
    pub paragraph_count: usize,
    pub appended_terminal_paragraph: bool,
    pub warnings: Vec<String>,
}

const TEXT_OFFSET: usize = 1024; // 900-byte Word 97 FIB, then zero alignment padding.
const CLX_BYTES: usize = 21; // Pcdt(1 + 4), two CPs(8), one Pcd(8).

/// Serializes ONLY an unformatted main story into new WordDocument + 0Table
/// streams. This is NOT a conforming DOC exporter: the mandatory stylesheet
/// and property indexes are missing. Never overwrite an imported DOC with it.
/// Rust strings cannot hold unpaired surrogates, so that TypeScript check is
/// enforced by the type system here.
pub fn serialize_legacy_doc_plain_story_streams(text: &str, limits: LegacyDocPlainStoryLimits) -> Result<LegacyDocPlainStoryFoundation, CfbError> {
    let units_in = utf16_units(text);
    if units_in > limits.max_text_code_units {
        return fail(LimitExceeded, "Plain-story input exceeds the character budget.");
    }
    for c in text.chars() {
        let unit = c as u32;
        if (unit < 32 && ![9, 10, 11, 13].contains(&unit)) || (0x7f..=0x9f).contains(&unit) || unit == 0xfffc {
            return fail(
                Unsupported,
                "Plain-story text contains a control or object marker requiring unsupported DOC structures.",
            );
        }
    }
    let mut story = text.replace("\r\n", "\r").replace('\n', "\r");
    let appended = !story.ends_with('\r');
    if appended {
        story.push('\r');
    }
    let units: Vec<u16> = story.encode_utf16().collect();
    if units.len() > limits.max_text_code_units || units.len() > 0x7fff_ffff || limits.max_pieces < 1 || limits.max_clx_bytes < CLX_BYTES {
        return fail(LimitExceeded, "Plain story exceeds the text or piece-table budget.");
    }
    let meaningful = TEXT_OFFSET + units.len() * 2;
    if meaningful > limits.max_stream_bytes
        || CLX_BYTES > limits.max_stream_bytes
        || meaningful + CLX_BYTES > limits.max_total_stream_bytes
        || meaningful >= 0x4000_0000
    {
        return fail(LimitExceeded, "Plain story exceeds the binary byte budget.");
    }
    let mut word = vec![0u8; meaningful];
    let w16 = |b: &mut [u8], at: usize, v: u16| b[at..at + 2].copy_from_slice(&v.to_le_bytes());
    let w32 = |b: &mut [u8], at: usize, v: u32| b[at..at + 4].copy_from_slice(&v.to_le_bytes());
    // [MS-DOC] 2.5.2: no encryption, no quick saves, 0Table, fExtChar=1; nFibBack identifies Word 6/95.
    w16(&mut word, 0, 0xa5ec);
    w16(&mut word, 2, 0x00c1);
    w16(&mut word, 6, 0x0409);
    w16(&mut word, 10, 0x1000);
    w16(&mut word, 12, 0x00bf);
    w32(&mut word, 24, TEXT_OFFSET as u32);
    w32(&mut word, 28, meaningful as u32);
    w16(&mut word, 32, 14);
    w16(&mut word, 62, 22);
    w32(&mut word, 64, meaningful as u32);
    w32(&mut word, 76, units.len() as u32);
    w16(&mut word, 152, 0x5d); // Word 97 has 93 fc/lcb pairs and no extension words.
    w32(&mut word, 154 + 33 * 8, 0);
    w32(&mut word, 154 + 33 * 8 + 4, CLX_BYTES as u32);
    w16(&mut word, 898, 0);
    let mut paragraph_count = 0;
    for (i, unit) in units.iter().enumerate() {
        w16(&mut word, TEXT_OFFSET + i * 2, *unit);
        if *unit == 13 {
            paragraph_count += 1;
        }
    }
    let mut table = vec![0u8; CLX_BYTES];
    table[0] = 2; // Pcdt; no preceding Prc property records.
    w32(&mut table, 1, 16); // PlcPcd length: CP[0], CP[1], Pcd[0].
    w32(&mut table, 5, 0);
    w32(&mut table, 9, units.len() as u32);
    w32(&mut table, 15, TEXT_OFFSET as u32); // Pcd flags=0; uncompressed FcCompressed; Prm0=0.
    Ok(LegacyDocPlainStoryFoundation {
        missing_structures: ["stylesheet", "character-property-index", "paragraph-property-index"],
        streams: vec![
            CfbWriteStream { name: "WordDocument".into(), data: word },
            CfbWriteStream { name: "0Table".into(), data: table },
        ],
        character_count: units.len(),
        paragraph_count,
        appended_terminal_paragraph: appended,
        warnings: vec![
            "Serialization foundation only: required stylesheet and CHPX/PAPX property indexes are not emitted; this is not a conforming DOC exporter.".into(),
            "No formatting, sections, tables, lists, fields, drawings, revisions, metadata preservation, or additional stories are supported. Never overwrite an imported DOC with this output.".into(),
        ],
    })
}
